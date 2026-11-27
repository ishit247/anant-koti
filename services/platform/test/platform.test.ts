import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type Db, type TestDb, testDb } from "@bodhchakra/db";
import { createJobs, type Jobs, migrations as jobsMigrations } from "@bodhchakra/jobs";
import { createLogger } from "@bodhchakra/log";
import { createOutbox, migrations as outboxMigrations } from "@bodhchakra/outbox";
import { signRequest } from "@bodhchakra/tokens";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { migrations, RUNTIME_ROLE } from "../src/index.ts";
import { createHandler, listen } from "../src/server.ts";

const SECRET = "kaamkoti-test-secret-".padEnd(48, "x");
const PATH = "/internal/v1/test.ping";

const until = async (check: () => boolean | Promise<boolean>, what: string, ms = 20_000) => {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

describe("platform", () => {
  let platformDb: TestDb;
  let platform: Db;
  let platformOwner: Db;
  let handler: (request: Request) => Promise<Response>;
  const lines: string[] = [];
  const log = createLogger({ service: "test", write: (line) => lines.push(line) });

  const received = () =>
    platformOwner.tx(
      async (client) =>
        (
          await client.query<{ key: string; n: number }>(
            "select key, n from fx.received order by key",
          )
        ).rows,
    );

  const call = (body: string, options: { secret?: string; now?: number; path?: string } = {}) => {
    const path = options.path ?? PATH;
    return handler(
      new Request(`http://platform${path}`, {
        method: "POST",
        headers: signRequest({
          client: "kaamkoti",
          secret: options.secret ?? SECRET,
          method: "POST",
          path,
          body,
          now: options.now,
        }),
        body,
      }),
    );
  };
  const ping = (key: string, n: number) => JSON.stringify({ key, payload: { ref: key, n } });

  beforeAll(async () => {
    platformDb = await testDb({
      owner: "platform_owner",
      runtimeRole: RUNTIME_ROLE,
      folders: migrations,
    });
    platformOwner = platformDb.connect("platform_owner");
    await platformOwner.tx((client) =>
      client.query(`create schema fx;
        create table fx.received (key text primary key, n int not null);
        grant usage on schema fx to platform_app;
        grant select, insert on fx.received to platform_app`),
    );
    platform = platformDb.connect(RUNTIME_ROLE);
    handler = createHandler({
      db: platform,
      log,
      clients: { kaamkoti: SECRET },
      // Sign-in has its own test (identity.test.ts); here no path belongs to it.
      identity: { handle: () => null },
      hooks: {},
      calls: {},
      topics: {
        "test.ping": {
          payload: z.object({ ref: z.string(), n: z.number().int() }),
          async handle(client, payload: { ref: string; n: number }) {
            await client.query("insert into fx.received (key, n) values ($1, $2)", [
              payload.ref,
              payload.n,
            ]);
          },
        },
      },
    });
  });
  afterAll(() => platformDb.drop());

  it("reports healthy while its database answers", async () => {
    const response = await handler(new Request("http://platform/health"));
    expect(response.status).toBe(200);
  });

  describe("internal API", () => {
    it("handles a signed call from a known app", async () => {
      const response = await call(ping("first", 1));
      expect([response.status, await response.json()]).toEqual([200, { status: "handled" }]);
      expect(await received()).toContainEqual({ key: "first", n: 1 });
    });

    it("handles a repeated delivery once and acknowledges it", async () => {
      await call(ping("repeat", 2));
      const again = await call(ping("repeat", 2));
      expect([again.status, await again.json()]).toEqual([200, { status: "duplicate" }]);
      expect((await received()).filter((row) => row.key === "repeat")).toHaveLength(1);
    });

    it("refuses an unsigned call", async () => {
      const response = await handler(
        new Request(`http://platform${PATH}`, { method: "POST", body: ping("u", 0) }),
      );
      expect(response.status).toBe(401);
    });

    it("refuses a call signed with the wrong secret", async () => {
      const response = await call(ping("wrong-secret", 0), {
        secret: "not-the-kaamkoti-secret".padEnd(48, "y"),
      });
      expect(response.status).toBe(401);
      expect((await received()).map((row) => row.key)).not.toContain("wrong-secret");
    });

    it("refuses an expired call, even one validly signed", async () => {
      const response = await call(ping("expired", 0), { now: Date.now() - 6 * 60 * 1000 });
      expect(response.status).toBe(401);
      expect((await received()).map((row) => row.key)).not.toContain("expired");
    });

    it("refuses a call signed for another topic", async () => {
      const body = ping("moved", 0);
      const headers = signRequest({
        client: "kaamkoti",
        secret: SECRET,
        method: "POST",
        path: "/internal/v1/test.other",
        body,
      });
      const response = await handler(
        new Request(`http://platform${PATH}`, { method: "POST", headers, body }),
      );
      expect(response.status).toBe(401);
    });

    it("answers an unknown topic only after the signature checks out", async () => {
      expect((await call(ping("x", 0), { path: "/internal/v1/test.unknown" })).status).toBe(404);
    });

    it("refuses a payload its topic does not accept", async () => {
      expect(
        (await call(JSON.stringify({ key: "bad", payload: { ref: "bad", n: "one" } }))).status,
      ).toBe(400);
      expect((await call("not json")).status).toBe(400);
    });
  });

  describe("delivery from an app's outbox", () => {
    let sender: TestDb;
    let jobs: Jobs;
    let server: Server | undefined;

    beforeAll(async () => {
      sender = await testDb({
        owner: "kaamkoti_owner",
        runtimeRole: "kaamkoti_app",
        folders: [jobsMigrations, outboxMigrations],
      });
    });
    afterAll(async () => {
      await jobs?.stop();
      server?.close();
      await sender.drop();
    });

    it("waits while platform is down, then delivers once it is back", async () => {
      // Find a free port, then leave it closed: platform is down.
      const probe = await listen(handler, log, 0, "127.0.0.1");
      const { port } = probe.address() as AddressInfo;
      await new Promise((resolve) => probe.close(resolve));

      const app = sender.connect("kaamkoti_app");
      jobs = createJobs({ url: sender.url("kaamkoti_app"), log, pollingIntervalSeconds: 0.5 });
      const outbox = createOutbox({ jobs, log, retry: { retryLimit: 30, retryDelay: 1 } });
      await jobs.start(outbox.jobTypes);
      await outbox.startDelivery(app, {
        url: `http://127.0.0.1:${port}`,
        client: "kaamkoti",
        secret: SECRET,
      });

      await app.tx((client) =>
        outbox.enqueue(client, "test.ping", { ref: "after-restart", n: 7 }, "after-restart"),
      );
      const failures = () => lines.filter((line) => line.includes('"job attempt failed"')).length;
      await until(() => failures() >= 2, "two failed attempts while platform is down");
      expect(await received()).not.toContainEqual({ key: "after-restart", n: 7 });

      server = await listen(handler, log, port, "127.0.0.1");
      const delivered = async () =>
        (
          await app.tx((client) =>
            client.query(
              "select 1 from outbox.message where idempotency_key = 'after-restart' and delivered_at is not null",
            ),
          )
        ).rowCount === 1;
      await until(delivered, "delivery after platform restarts");

      expect((await received()).filter((row) => row.key === "after-restart")).toEqual([
        { key: "after-restart", n: 7 },
      ]);
    });
  });
});
