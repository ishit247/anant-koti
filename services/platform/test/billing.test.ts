import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAudit } from "@bodhchakra/audit";
import { CHECKOUT_CALL, REGISTER_TOPIC, type StatusChanged } from "@bodhchakra/billing";
import { type Db, type TestDb, testDb } from "@bodhchakra/db";
import { createJobs, type Jobs } from "@bodhchakra/jobs";
import { createLogger } from "@bodhchakra/log";
import { createOutbox } from "@bodhchakra/outbox";
import { signRequest } from "@bodhchakra/tokens";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createBillingService, whatsappQuota } from "../src/billing.ts";
import { migrations, RUNTIME_ROLE } from "../src/index.ts";
import { sign } from "../src/razorpay.ts";
import { createHandler } from "../src/server.ts";

const SECRET = "kaamkoti-test-secret-".padEnd(48, "x");
const WEBHOOK_SECRET = "billing-webhook-secret-for-tests";
const PLANS = { solo: "plan_Solo000001", team: "plan_Team000001" } as const;
const DAY = 86_400_000;

const read = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request as AsyncIterable<Buffer>) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

describe("billing", () => {
  let database: TestDb;
  let platform: Db;
  let owner: Db;
  let jobs: Jobs;
  let stub: Server;
  let handler: (request: Request) => Promise<Response>;
  let asked: { path: string; body: Record<string, unknown> }[] = [];
  let subscriptionNumber = 0;
  let clock = new Date("2026-12-01T10:00:00Z");
  const log = createLogger({ service: "test", write: () => {} });

  const signed = (path: string, body: string, client = "kaamkoti") =>
    handler(
      new Request(`http://platform${path}`, {
        method: "POST",
        headers: signRequest({ client, secret: SECRET, method: "POST", path, body }),
        body,
      }),
    );
  const register = (tenantId: string, identityId: string, trialEndsAt: Date, client = "kaamkoti") =>
    signed(
      `/internal/v1/${REGISTER_TOPIC}`,
      JSON.stringify({
        key: `register:${randomUUID()}`,
        payload: { tenantId, identityId, trialEndsAt: trialEndsAt.toISOString() },
      }),
      client,
    );
  const checkout = (tenantId: string, identityId: string, plan = "team", seats = 3) =>
    signed(`/internal/v1/${CHECKOUT_CALL}`, JSON.stringify({ tenantId, identityId, plan, seats }));

  /** Razorpay's webhook about `subscriptionId`, made at `at`, signed with `secret`. */
  const hookBody = (
    event: string,
    subscriptionId: string,
    at: Date,
    entity: Record<string, unknown> = {},
  ) =>
    JSON.stringify({
      entity: "event",
      account_id: "acc_Platform0001",
      event,
      contains: ["subscription"],
      payload: {
        subscription: {
          entity: { id: subscriptionId, plan_id: PLANS.team, quantity: 3, status: "x", ...entity },
        },
      },
      created_at: Math.floor(at.getTime() / 1000),
    });
  const hook = (body: string, signature = sign(body, WEBHOOK_SECRET)) =>
    handler(
      new Request("http://hooks/hooks/razorpay", {
        method: "POST",
        headers: { "content-type": "application/json", "x-razorpay-signature": signature },
        body,
      }),
    );

  const subscription = async (tenantId: string) =>
    (
      await owner.tx((client) =>
        client.query<{
          account_id: string;
          plan: string;
          seats: number;
          status: string;
          trial_ends_at: Date;
          paid_through: Date | null;
          provider_subscription_id: string | null;
          checkout_url: string | null;
          version: number;
        }>(
          `select account_id, plan, seats, status, trial_ends_at, paid_through, provider_subscription_id,
                  checkout_url, version
           from billing.subscription where tenant_id = $1`,
          [tenantId],
        ),
      )
    ).rows[0];
  const events = async (tenantId: string) =>
    (
      await owner.tx((client) =>
        client.query<{ topic: string; payload: StatusChanged }>(
          "select topic, payload from outbox.message where payload->>'tenantId' = $1 order by created_at",
          [tenantId],
        ),
      )
    ).rows;
  const audited = async (tenantId: string) =>
    (
      await owner.tx((client) =>
        client.query<{ action: string; data: Record<string, unknown> }>(
          "select action, data from audit.event where business_id = $1 order by at",
          [tenantId],
        ),
      )
    ).rows;

  /** An identity, as sign-in makes one, and a business of theirs registered with a 14-day trial. */
  async function business(trialDays = 14) {
    const identityId = randomUUID();
    await owner.tx((client) =>
      client.query(
        `insert into identity."user" (id, name, email, "emailVerified") values ($1, 'Owner', $2, true)`,
        [identityId, `${identityId}@example.com`],
      ),
    );
    const tenantId = randomUUID();
    const trialEndsAt = new Date(clock.getTime() + trialDays * DAY);
    expect((await register(tenantId, identityId, trialEndsAt)).status).toBe(200);
    return { identityId, tenantId, trialEndsAt };
  }

  /** A business whose owner has checked out; returns the Razorpay subscription id. */
  async function checkedOut() {
    const made = await business();
    const answer = (await (await checkout(made.tenantId, made.identityId)).json()) as {
      url: string;
    };
    const providerId = answer.url.split("/").pop() as string;
    return { ...made, providerId };
  }

  beforeAll(async () => {
    database = await testDb({
      owner: "platform_owner",
      runtimeRole: RUNTIME_ROLE,
      folders: migrations,
    });
    platform = database.connect(RUNTIME_ROLE);
    owner = database.connect("platform_owner");

    stub = createServer(async (request, response) => {
      const body = JSON.parse((await read(request)) || "{}") as Record<string, unknown>;
      asked.push({ path: request.url ?? "", body });
      if (request.url === "/v1/subscriptions") {
        subscriptionNumber += 1;
        const id = `sub_Test${String(subscriptionNumber).padStart(6, "0")}`;
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ id, short_url: `https://rzp.io/rzp/${id}`, status: "created" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    await new Promise<void>((done) => stub.listen(0, "127.0.0.1", done));

    jobs = createJobs({ url: database.url(RUNTIME_ROLE), log, pollingIntervalSeconds: 0.5 });
    const outbox = createOutbox({ jobs, log });
    // Delivery is the outbox's own test; here the queued messages are read from outbox.message.
    await jobs.start(outbox.jobTypes);
    const billing = createBillingService({
      db: platform,
      log,
      audit: createAudit(log),
      outbox,
      razorpay: {
        api: `http://127.0.0.1:${(stub.address() as AddressInfo).port}`,
        keyId: "rzp_test_Platform01",
        keySecret: "key-secret-for-tests",
        webhookSecret: WEBHOOK_SECRET,
        plans: PLANS,
      },
      product: "kaamkoti",
      now: () => clock,
    });
    handler = createHandler({
      db: platform,
      log,
      clients: { kaamkoti: SECRET, pos: SECRET },
      topics: { [REGISTER_TOPIC]: billing.topic },
      calls: billing.calls,
      identity: { handle: () => null },
      hooks: billing.hooks,
    });
  });
  afterAll(async () => {
    stub.closeAllConnections();
    stub.close();
    await jobs.stop();
    await database.drop();
  });
  beforeEach(() => {
    asked = [];
    clock = new Date("2026-12-01T10:00:00Z");
  });

  describe("registering a business", () => {
    it("opens a Team trial on the owner's account, with the app's trial end and no event", async () => {
      const { tenantId, trialEndsAt } = await business();
      expect(await subscription(tenantId)).toMatchObject({
        plan: "team",
        seats: 1,
        status: "trialing",
        trial_ends_at: trialEndsAt,
        paid_through: null,
        version: 1,
      });
      expect(await events(tenantId)).toEqual([]);
    });

    it("gives one owner's businesses one account, and a second registration changes nothing", async () => {
      const first = await business();
      const second = randomUUID();
      await register(second, first.identityId, new Date(clock.getTime() + 3 * DAY));
      await register(first.tenantId, first.identityId, new Date(clock.getTime() + 99 * DAY));
      expect((await subscription(second))?.account_id).toBe(
        (await subscription(first.tenantId))?.account_id,
      );
      expect((await subscription(first.tenantId))?.trial_ends_at).toEqual(first.trialEndsAt);
    });

    it("refuses a product whose app gets no status events, so its outbox retries and alerts", async () => {
      const { identityId } = await business();
      const tenantId = randomUUID();
      const response = await register(tenantId, identityId, clock, "pos");
      expect(response.status).toBe(500);
      expect(await subscription(tenantId)).toBeUndefined();
    });
  });

  describe("checkout", () => {
    it("makes a Razorpay subscription for the plan and seats, first charged at the trial's end", async () => {
      const { tenantId, identityId, trialEndsAt } = await business();
      const response = await checkout(tenantId, identityId, "team", 3);
      expect(response.status).toBe(200);
      const { url } = (await response.json()) as { url: string };
      expect(asked).toEqual([
        {
          path: "/v1/subscriptions",
          body: {
            plan_id: PLANS.team,
            quantity: 3,
            total_count: 120,
            customer_notify: 1,
            start_at: Math.floor(trialEndsAt.getTime() / 1000),
            notes: { product: "kaamkoti", tenant_id: tenantId },
          },
        },
      ]);
      // Making it pays for nothing: the status is still the trial's.
      expect(await subscription(tenantId)).toMatchObject({
        status: "trialing",
        plan: "team",
        seats: 1,
        checkout_url: url,
        version: 1,
      });
    });

    it("charges at once when the trial is over", async () => {
      const { tenantId, identityId } = await business(-1);
      await checkout(tenantId, identityId, "solo", 1);
      expect(asked[0]?.body).not.toHaveProperty("start_at");
      expect(asked[0]?.body).toMatchObject({ plan_id: PLANS.solo, quantity: 1 });
    });

    it("cancels an earlier checkout never authorised, so only the newest can be paid", async () => {
      const { tenantId, identityId, providerId } = await checkedOut();
      asked = [];
      await checkout(tenantId, identityId, "solo", 1);
      expect(asked.map((call) => call.path)).toEqual([
        `/v1/subscriptions/${providerId}/cancel`,
        "/v1/subscriptions",
      ]);
      expect((await subscription(tenantId))?.provider_subscription_id).not.toBe(providerId);
    });

    it("answers only the account's owner, and nothing for a business it does not know", async () => {
      const { tenantId } = await business();
      const other = await checkout(tenantId, randomUUID());
      expect(other.status).toBe(403);
      expect(await other.json()).toEqual({ error: { code: "not_payer" } });
      const unknown = await checkout(randomUUID(), randomUUID());
      expect(unknown.status).toBe(404);
      expect(asked).toEqual([]);
    });

    it("refuses Solo with more than one seat", async () => {
      const { tenantId, identityId } = await business();
      expect((await checkout(tenantId, identityId, "solo", 2)).status).toBe(400);
    });

    it("refuses a business already subscribed, until it is cancelled", async () => {
      const { tenantId, identityId, providerId } = await checkedOut();
      await hook(hookBody("subscription.authenticated", providerId, clock));
      const again = await checkout(tenantId, identityId);
      expect(again.status).toBe(409);
      expect(await again.json()).toEqual({ error: { code: "subscribed" } });

      await hook(hookBody("subscription.cancelled", providerId, new Date(clock.getTime() + 1000)));
      expect((await checkout(tenantId, identityId)).status).toBe(200);
    });
  });

  describe("the webhook", () => {
    it("moves trial → paid → past due → cancelled, each change one event and one audit row", async () => {
      const { tenantId, providerId, trialEndsAt } = await checkedOut();
      const at = (minutes: number) => new Date(clock.getTime() + minutes * 60_000);
      const periodEnd = new Date(trialEndsAt.getTime() + 30 * DAY);

      // Authorising is not paying: nothing the app sees changes.
      expect(
        await (await hook(hookBody("subscription.authenticated", providerId, at(1)))).json(),
      ).toEqual({ status: "unchanged" });
      expect(await subscription(tenantId)).toMatchObject({
        status: "trialing",
        checkout_url: null,
        version: 1,
      });

      await hook(
        hookBody("subscription.charged", providerId, at(2), {
          current_end: Math.floor(periodEnd.getTime() / 1000),
        }),
      );
      expect(await subscription(tenantId)).toMatchObject({
        status: "active",
        plan: "team",
        seats: 3,
        paid_through: periodEnd,
        version: 2,
      });

      await hook(hookBody("subscription.pending", providerId, at(3)));
      await hook(hookBody("subscription.cancelled", providerId, at(4)));

      expect((await events(tenantId)).map((event) => [event.topic, event.payload])).toEqual([
        [
          "billing.status_changed",
          {
            tenantId,
            plan: "team",
            seats: 3,
            status: "active",
            trialEndsAt: trialEndsAt.toISOString(),
            paidThrough: periodEnd.toISOString(),
            version: 2,
          },
        ],
        ["billing.status_changed", expect.objectContaining({ status: "past_due", version: 3 })],
        ["billing.status_changed", expect.objectContaining({ status: "cancelled", version: 4 })],
      ]);
      // Paid time is kept after cancelling: they paid through it.
      expect((await subscription(tenantId))?.paid_through).toEqual(periodEnd);
      expect(await audited(tenantId)).toEqual([
        {
          action: "billing.status_changed",
          data: { plan: "team", seats: 3, status: "active", version: 2 },
        },
        expect.objectContaining({ data: expect.objectContaining({ status: "past_due" }) }),
        expect.objectContaining({ data: expect.objectContaining({ status: "cancelled" }) }),
      ]);
    });

    it("never moves paid time back", async () => {
      const { tenantId, providerId } = await checkedOut();
      const later = new Date(clock.getTime() + 60 * DAY);
      const earlier = new Date(clock.getTime() + 30 * DAY);
      await hook(
        hookBody("subscription.charged", providerId, new Date(clock.getTime() + 1000), {
          current_end: Math.floor(later.getTime() / 1000),
        }),
      );
      await hook(
        hookBody("subscription.activated", providerId, new Date(clock.getTime() + 2000), {
          current_end: Math.floor(earlier.getTime() / 1000),
        }),
      );
      expect((await subscription(tenantId))?.paid_through).toEqual(later);
    });

    it("ignores an event older than the last one applied, whenever it arrives", async () => {
      const { tenantId, providerId } = await checkedOut();
      await hook(
        hookBody("subscription.charged", providerId, new Date(clock.getTime() + 2000), {
          current_end: Math.floor((clock.getTime() + 30 * DAY) / 1000),
        }),
      );
      const late = await hook(
        hookBody("subscription.halted", providerId, new Date(clock.getTime() + 1000)),
      );
      expect(await late.json()).toEqual({ status: "stale" });
      expect((await subscription(tenantId))?.status).toBe("active");
    });

    it("acknowledges a replay and changes nothing", async () => {
      const { tenantId, providerId } = await checkedOut();
      const body = hookBody("subscription.pending", providerId, new Date(clock.getTime() + 1000));
      await hook(body);
      const replay = await hook(body);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({ status: "duplicate" });
      expect(await events(tenantId)).toHaveLength(1);
    });

    it("refuses a forged or missing signature with 401 and changes nothing", async () => {
      const { tenantId, providerId } = await checkedOut();
      const body = hookBody("subscription.charged", providerId, new Date(clock.getTime() + 1000), {
        current_end: Math.floor((clock.getTime() + 30 * DAY) / 1000),
      });
      expect((await hook(body, sign(body, "someone-elses-secret-0000"))).status).toBe(401);
      expect((await hook(body, "")).status).toBe(401);
      expect(await subscription(tenantId)).toMatchObject({ status: "trialing", version: 1 });
      // The forged copies took no inbox key, so the genuine event still applies.
      expect(await (await hook(body)).json()).toEqual({ status: "changed" });
    });

    it("ignores a replaced checkout's subscription and other events", async () => {
      const { tenantId, identityId, providerId } = await checkedOut();
      await checkout(tenantId, identityId);
      const old = await hook(
        hookBody("subscription.charged", providerId, new Date(clock.getTime() + 1000), {
          current_end: Math.floor((clock.getTime() + 30 * DAY) / 1000),
        }),
      );
      expect(await old.json()).toEqual({ status: "unknown" });
      const other = await hook(JSON.stringify({ event: "payment.captured", payload: {} }));
      expect(await other.json()).toEqual({ status: "ignored" });
      expect(await subscription(tenantId)).toMatchObject({ status: "trialing", version: 1 });
    });

    it("fails a payment on a plan it did not make and records nothing, so Razorpay retries", async () => {
      const { tenantId, providerId } = await checkedOut();
      const body = hookBody("subscription.charged", providerId, new Date(clock.getTime() + 1000), {
        plan_id: "plan_NotOurs00001",
        current_end: Math.floor((clock.getTime() + 30 * DAY) / 1000),
      });
      expect((await hook(body)).status).toBe(500);
      expect(await subscription(tenantId)).toMatchObject({ status: "trialing", version: 1 });
      const key = createHash("sha256").update(body, "utf8").digest("hex");
      const inbox = await owner.tx((client) =>
        client.query("select 1 from outbox.inbox where idempotency_key = $1", [key]),
      );
      expect(inbox.rowCount).toBe(0);
    });
  });

  describe("the WhatsApp quota", () => {
    const quota = (tenantId: string) =>
      platform.tx((client) => whatsappQuota(client, "kaamkoti", tenantId));

    it("is the trial's for a business not yet registered and for one in its trial", async () => {
      expect(await quota(randomUUID())).toBe(600);
      expect(await quota((await business()).tenantId)).toBe(600);
    });

    it("follows the plan and seats a verified webhook moves the subscription to", async () => {
      const { tenantId, providerId } = await checkedOut();
      const charged = (planId: string, quantity: number, minutes: number) =>
        hook(
          hookBody(
            "subscription.charged",
            providerId,
            new Date(clock.getTime() + minutes * 60_000),
            {
              plan_id: planId,
              quantity,
              current_end: Math.floor((clock.getTime() + 30 * DAY) / 1000),
            },
          ),
        );
      await charged(PLANS.team, 3, 1);
      expect(await quota(tenantId)).toBe(800);
      await charged(PLANS.solo, 1, 2);
      expect(await quota(tenantId)).toBe(200);
    });
  });

  it("lets the runtime role neither delete a subscription nor change an account's owner", async () => {
    const { tenantId } = await business();
    await expect(
      platform.tx((client) =>
        client.query("delete from billing.subscription where tenant_id = $1", [tenantId]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      platform.tx((client) => client.query("update billing.account set identity_id = identity_id")),
    ).rejects.toThrow(/permission denied/);
  });
});
