import { type Db, type DbClient, type TestDb, testDb } from "@bodhchakra/db";
import { createJobs, type Jobs, migrations as jobsMigrations } from "@bodhchakra/jobs";
import { createLogger } from "@bodhchakra/log";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOutbox, migrations, type Outbox, receive } from "../src/index.ts";

// Delivery itself, with a real receiver going down and coming back, is tested in services/platform.
describe("outbox", () => {
  let database: TestDb;
  let app: Db;
  let owner: Db;
  let jobs: Jobs;
  let outbox: Outbox;

  const count = (sql: string) =>
    owner.tx(async (client) => Number((await client.query<{ n: string }>(sql)).rows[0]?.n));

  beforeAll(async () => {
    database = await testDb({
      owner: "kaamkoti_owner",
      runtimeRole: "kaamkoti_app",
      folders: [jobsMigrations, migrations],
    });
    app = database.connect("kaamkoti_app");
    owner = database.connect("kaamkoti_owner");
    const log = createLogger({ service: "test", write: () => {} });
    jobs = createJobs({ url: database.url("kaamkoti_app"), log });
    outbox = createOutbox({ jobs, log });
    await jobs.start(outbox.jobTypes);
  });
  afterAll(async () => {
    await jobs.stop();
    await database.drop();
  });

  it("writes the message and its delivery job in the caller's transaction", async () => {
    await app.tx((client) => outbox.enqueue(client, "notify.send", { template: "a" }, "enqueue-1"));

    expect(
      await count("select count(*) as n from outbox.message where idempotency_key = 'enqueue-1'"),
    ).toBe(1);
    expect(await count("select count(*) as n from pgboss.job where name = 'outbox.deliver'")).toBe(
      1,
    );
  });

  it("writes neither when the business transaction rolls back", async () => {
    await expect(
      app.tx(async (client) => {
        await outbox.enqueue(client, "notify.send", { template: "b" }, "rolled-back");
        throw new Error("business write failed");
      }),
    ).rejects.toThrow("business write failed");

    expect(
      await count("select count(*) as n from outbox.message where idempotency_key = 'rolled-back'"),
    ).toBe(0);
  });

  it("treats a second enqueue with the same key as the same message", async () => {
    for (let i = 0; i < 2; i++) {
      await app.tx((client) => outbox.enqueue(client, "notify.send", { template: "c" }, "twice"));
    }

    expect(
      await count("select count(*) as n from outbox.message where idempotency_key = 'twice'"),
    ).toBe(1);
    const jobsForTwice = await count(
      `select count(*) as n from pgboss.job j join outbox.message m on m.id::text = j.data->>'messageId'
       where m.idempotency_key = 'twice'`,
    );
    expect(jobsForTwice).toBe(1);
  });

  it("handles a received message once, however often it arrives", async () => {
    let handled = 0;
    const handle = () => {
      handled += 1;
      return Promise.resolve();
    };

    const first = await app.tx((client) => receive(client, "kaamkoti", "msg-1", handle));
    const again = await app.tx((client) => receive(client, "kaamkoti", "msg-1", handle));

    expect([first, again, handled]).toEqual([true, false, 1]);
  });

  it("keeps the key unclaimed when handling fails, so a redelivery is handled", async () => {
    const failing = (client: DbClient) =>
      receive(client, "kaamkoti", "msg-2", () => Promise.reject(new Error("handler failed")));
    await expect(app.tx(failing)).rejects.toThrow("handler failed");

    expect(
      await app.tx((client) => receive(client, "kaamkoti", "msg-2", () => Promise.resolve())),
    ).toBe(true);
  });

  it("scopes keys to their source", async () => {
    await app.tx((client) => receive(client, "kaamkoti", "shared", () => Promise.resolve()));

    expect(
      await app.tx((client) => receive(client, "pos", "shared", () => Promise.resolve())),
    ).toBe(true);
  });

  it("refuses the runtime role deleting messages or rewriting the inbox", async () => {
    for (const sql of [
      "delete from outbox.message",
      "truncate outbox.message",
      "update outbox.inbox set idempotency_key = 'x'",
      "delete from outbox.inbox",
    ]) {
      await expect(app.tx((client) => client.query(sql))).rejects.toMatchObject({ code: "42501" });
    }
  });
});
