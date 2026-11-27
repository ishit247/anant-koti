import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type Db, type TestDb, testDb } from "@bodhchakra/db";
import { createJobs, type Jobs, migrations as jobsMigrations } from "@bodhchakra/jobs";
import { createLogger } from "@bodhchakra/log";
import { createOutbox, migrations as outboxMigrations } from "@bodhchakra/outbox";
import { signRequest, verifyRequest } from "@bodhchakra/tokens";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertWithin,
  type BillingClient,
  createBillingClient,
  isLive,
  LimitReached,
  limitsOf,
  migrations,
  REGISTER_TOPIC,
  STATUS_EVENTS_PATH,
  type StatusChanged,
  type Subscription,
  subscriptionOf,
  TRIAL_SEATS,
} from "../src/index.ts";

const SECRET = "test-kaamkoti-service-secret-0123456789abcdefghij";
const DAY = 86_400_000;
const NOW = new Date("2026-11-28T06:00:00.000Z");

/** What platform's outbox posts: a delivery signed as client `platform` (or whoever `as` says). */
function statusEvent(
  event: StatusChanged,
  { key = randomUUID(), as = "platform", secret = SECRET, path = STATUS_EVENTS_PATH } = {},
): Request {
  const body = JSON.stringify({ key, payload: event });
  return new Request(`http://kaamkoti${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...signRequest({ client: as, secret, method: "POST", path, body }),
    },
    body,
  });
}

describe("billing, app side", () => {
  let database: TestDb;
  let app: Db;
  let owner: Db;
  let jobs: Jobs;
  let billing: BillingClient;
  let platform: Server;
  /** What the stub platform answers the next checkout with, and what it was asked. */
  let reply: { status: number; body: unknown } = { status: 200, body: {} };
  const asked: { client: string; body: unknown }[] = [];

  const businessA = randomUUID();
  const businessB = randomUUID();
  const identityA = randomUUID();

  const copyOf = (businessId: string) => app.withTenant(businessId, subscriptionOf);
  const event = (patch: Partial<StatusChanged>): StatusChanged => ({
    tenantId: businessA,
    plan: "team",
    seats: 3,
    status: "active",
    trialEndsAt: new Date(NOW.getTime() + 14 * DAY).toISOString(),
    paidThrough: new Date(NOW.getTime() + 44 * DAY).toISOString(),
    version: 2,
    ...patch,
  });

  beforeAll(async () => {
    database = await testDb({
      owner: "kaamkoti_owner",
      runtimeRole: "kaamkoti_app",
      folders: [jobsMigrations, outboxMigrations, migrations],
    });
    app = database.connect("kaamkoti_app");
    owner = database.connect("kaamkoti_owner");
    const log = createLogger({ service: "test", write: () => {} });
    jobs = createJobs({ url: database.url("kaamkoti_app"), log, sendOnly: true });
    const outbox = createOutbox({ jobs, log });
    await jobs.start(outbox.jobTypes);

    platform = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const headers = new Headers(request.headers as Record<string, string>);
      const verified = verifyRequest({
        method: request.method ?? "",
        path: request.url ?? "",
        headers,
        body,
        secretFor: (client) => (client === "kaamkoti" ? SECRET : undefined),
      });
      if (!verified.ok) return response.writeHead(401).end("{}");
      asked.push({ client: verified.client, body: JSON.parse(body) });
      response
        .writeHead(reply.status, { "content-type": "application/json" })
        .end(JSON.stringify(reply.body));
    });
    await new Promise<void>((done) => platform.listen(0, "127.0.0.1", done));
    const { port } = platform.address() as AddressInfo;

    billing = createBillingClient({
      db: app,
      log,
      outbox,
      platformUrl: `http://127.0.0.1:${port}`,
      client: "kaamkoti",
      secret: SECRET,
      now: () => NOW,
    });
    for (const [businessId, identityId] of [
      [businessA, identityA],
      [businessB, randomUUID()],
    ] as const) {
      await app.withTenant(businessId, (client) =>
        billing.startTrial(client, { businessId, identityId }),
      );
    }
  });
  afterAll(async () => {
    platform.close();
    await jobs.stop();
    await database.drop();
  });

  describe("the trial at signup", () => {
    it("writes a 14-day Team trial at platform's opening version", async () => {
      expect(await copyOf(businessB)).toEqual({
        plan: "team",
        seats: 1,
        status: "trialing",
        trialEndsAt: new Date(NOW.getTime() + 14 * DAY),
        paidThrough: null,
        version: 1,
      });
    });

    it("queues billing.register for platform with the same trial end", async () => {
      const { rows } = await owner.tx((client) =>
        client.query<{ topic: string; payload: unknown }>(
          "select topic, payload from outbox.message where idempotency_key = $1",
          [`billing.register:${businessA}`],
        ),
      );
      expect(rows).toEqual([
        {
          topic: REGISTER_TOPIC,
          payload: {
            tenantId: businessA,
            identityId: identityA,
            trialEndsAt: new Date(NOW.getTime() + 14 * DAY).toISOString(),
          },
        },
      ]);
    });

    it("is written in the caller's transaction, so a failed signup leaves neither", async () => {
      const businessId = randomUUID();
      await expect(
        app.withTenant(businessId, async (client) => {
          await billing.startTrial(client, { businessId, identityId: randomUUID() });
          throw new Error("signup failed after");
        }),
      ).rejects.toThrow("signup failed after");
      const count = await owner.tx(async (client) => {
        const { rows } = await client.query<{ n: string }>(
          `select (select count(*) from billing.status where business_id = $1)
                + (select count(*) from outbox.message where idempotency_key = $2) as n`,
          [businessId, `billing.register:${businessId}`],
        );
        return Number(rows[0]?.n);
      });
      expect(count).toBe(0);
    });
  });

  describe("status events from platform", () => {
    it("applies a newer version", async () => {
      const response = await billing.receiveStatus(statusEvent(event({ version: 2 })));
      expect(response.status).toBe(200);
      expect(await copyOf(businessA)).toMatchObject({ status: "active", seats: 3, version: 2 });
    });

    it("ignores an older or equal version arriving late", async () => {
      await billing.receiveStatus(statusEvent(event({ version: 4, status: "past_due" })));
      for (const version of [3, 4]) {
        const late = await billing.receiveStatus(
          statusEvent(event({ version, status: "cancelled" })),
        );
        expect(late.status).toBe(200);
      }
      expect(await copyOf(businessA)).toMatchObject({ status: "past_due", version: 4 });
    });

    it("takes a redelivered event once", async () => {
      const key = randomUUID();
      const first = event({ version: 5, status: "active" });
      expect(await (await billing.receiveStatus(statusEvent(first, { key }))).json()).toEqual({
        status: "handled",
      });
      // The same key again, even carrying another body, is a duplicate and changes nothing.
      const again = statusEvent(event({ version: 6, status: "cancelled" }), { key });
      expect(await (await billing.receiveStatus(again)).json()).toEqual({ status: "duplicate" });
      expect(await copyOf(businessA)).toMatchObject({ status: "active", version: 5 });
    });

    it("refuses an event not signed with the shared secret", async () => {
      const forged = statusEvent(event({ version: 50, status: "cancelled" }), {
        secret: "not-the-secret-0123456789abcdefghijklmnopqrstuvwxyz",
      });
      expect((await billing.receiveStatus(forged)).status).toBe(401);
      expect((await copyOf(businessA)).version).toBe(5);
    });

    it("refuses an event signed by another client", async () => {
      // The app signs its own outbox deliveries with the same secret; only platform may move billing.
      const fromApp = statusEvent(event({ version: 50, status: "cancelled" }), { as: "kaamkoti" });
      expect((await billing.receiveStatus(fromApp)).status).toBe(401);
      expect((await copyOf(businessA)).version).toBe(5);
    });

    it("refuses a body changed after signing", async () => {
      const signed = statusEvent(event({ version: 50, status: "cancelled" }));
      const tampered = new Request(signed.url, {
        method: "POST",
        headers: signed.headers,
        body: (await signed.text()).replace('"cancelled"', '"active"'),
      });
      expect((await billing.receiveStatus(tampered)).status).toBe(401);
      expect((await copyOf(businessA)).version).toBe(5);
    });

    it("moves only the business the event names", async () => {
      const before = await copyOf(businessB);
      await billing.receiveStatus(statusEvent(event({ version: 7, status: "cancelled" })));
      expect(await copyOf(businessB)).toEqual(before);
    });

    it("refuses a malformed event", async () => {
      const bad = statusEvent({ ...event({ version: 60 }), status: "free" as "active" });
      expect((await billing.receiveStatus(bad)).status).toBe(400);
    });
  });

  describe("live, computed at request time", () => {
    const trialEnd = new Date(NOW.getTime() + 14 * DAY);
    const sub = (patch: Partial<Subscription>): Subscription => ({
      plan: "team",
      seats: 1,
      status: "trialing",
      trialEndsAt: trialEnd,
      paidThrough: null,
      version: 1,
      ...patch,
    });
    const at = (days: number) => new Date(NOW.getTime() + days * DAY);

    it("is live during the trial", () => {
      expect(isLive(sub({}), at(13))).toBe(true);
    });

    it("lapses when the trial ends unpaid", () => {
      expect(isLive(sub({}), at(14))).toBe(false);
    });

    it("stays live through the trial after subscribing, before the first charge", () => {
      expect(isLive(sub({ status: "active" }), at(10))).toBe(true);
    });

    it("is live through paid time and the grace after it", () => {
      const paid = sub({ status: "past_due", paidThrough: at(44) });
      expect(isLive(paid, at(46.9))).toBe(true);
      expect(isLive(paid, at(47))).toBe(false);
    });

    it("keeps paid time after a cancellation, then lapses", () => {
      const cancelled = sub({ status: "cancelled", paidThrough: at(30) });
      expect(isLive(cancelled, at(32))).toBe(true);
      expect(isLive(cancelled, at(34))).toBe(false);
    });
  });

  describe("checkout", () => {
    const request = { tenantId: businessA, identityId: identityA, plan: "team", seats: 2 } as const;

    it("asks platform with a signed call and returns its page", async () => {
      reply = { status: 200, body: { url: "https://rzp.io/i/sub_Test0001" } };
      expect(await billing.checkout(request)).toEqual({ url: "https://rzp.io/i/sub_Test0001" });
      expect(asked.at(-1)).toEqual({ client: "kaamkoti", body: request });
    });

    it("passes on platform's refusal", async () => {
      reply = { status: 403, body: { error: { code: "not_payer" } } };
      expect(await billing.checkout(request)).toEqual({ error: { code: "not_payer" } });
    });

    it("answers unavailable when platform fails", async () => {
      reply = { status: 500, body: { error: "internal" } };
      expect(await billing.checkout(request)).toEqual({ error: { code: "unavailable" } });
    });

    it("answers unavailable when platform cannot be reached", async () => {
      const down = createBillingClient({
        db: app,
        log: createLogger({ service: "test", write: () => {} }),
        outbox: { enqueue: async () => {} },
        platformUrl: "http://127.0.0.1:9",
        client: "kaamkoti",
        secret: SECRET,
      });
      expect(await down.checkout(request)).toEqual({ error: { code: "unavailable" } });
    });
  });

  describe("limits", () => {
    const sub = (patch: Partial<Subscription>): Subscription => ({
      plan: "team",
      seats: 1,
      status: "trialing",
      trialEndsAt: new Date(NOW.getTime() + 14 * DAY),
      paidThrough: null,
      version: 1,
      ...patch,
    });
    const refusal = (subscription: Subscription, used: number) => {
      try {
        assertWithin(subscription, "seats", used);
        return null;
      } catch (error) {
        if (error instanceof LimitReached) return error.error;
        throw error;
      }
    };

    it("lets the trial seat up to ten people, whatever its row's seats", () => {
      expect(refusal(sub({}), TRIAL_SEATS - 1)).toBeNull();
      expect(refusal(sub({}), TRIAL_SEATS)).toEqual({
        code: "limit",
        limit: "seats",
        plan: "team",
      });
    });

    it("seats a paid Team plan its own seats", () => {
      const paid = sub({ status: "active", seats: 3 });
      expect(refusal(paid, 2)).toBeNull();
      expect(refusal(paid, 3)).toEqual({ code: "limit", limit: "seats", plan: "team" });
    });

    it("seats Solo one person", () => {
      expect(refusal(sub({ plan: "solo", status: "active" }), 1)).toEqual({
        code: "limit",
        limit: "seats",
        plan: "solo",
      });
    });

    it("gives Solo 200 WhatsApp messages and Team 500 plus 100 a seat", () => {
      expect(limitsOf(sub({ plan: "solo", status: "active" })).whatsapp).toBe(200);
      expect(limitsOf(sub({ status: "active", seats: 3 })).whatsapp).toBe(800);
    });

    it("holds the copy locked when asked, so a second taker waits", async () => {
      await app.withTenant(businessB, async (client) => {
        await subscriptionOf(client, { lock: true });
        await expect(
          app.withTenant(businessB, async (other) => {
            await other.query("set local lock_timeout = '200ms'");
            return subscriptionOf(other, { lock: true });
          }),
        ).rejects.toThrow(/lock timeout/);
      });
    });
  });

  describe("the copy's table", () => {
    it("shows each business only its own row", async () => {
      const { rows } = await app.withTenant(businessB, (client) =>
        client.query<{ business_id: string }>("select business_id from billing.status"),
      );
      expect(rows).toEqual([{ business_id: businessB }]);
    });

    it("may not be deleted by the runtime role", async () => {
      await expect(
        app.withTenant(businessB, (client) => client.query("delete from billing.status")),
      ).rejects.toThrow(/permission denied/);
    });
  });
});
