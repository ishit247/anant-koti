// Billing's server side (docs/architecture.md 13; D6, D9, D12). An app registers each new business, which opens
// its trial; the owner's checkout makes a Razorpay subscription on the platform's account, charged from the
// trial's end; Razorpay's verified webhook is the only thing that moves the status. Every change goes to the app
// as `billing.status_changed` through platform's outbox, with a version the app uses to keep the newest.
// Logs and audit events carry ids, plans and statuses only.
import { createHash } from "node:crypto";
import type { Audit } from "@bodhchakra/audit";
import {
  CHECKOUT_CALL,
  type CheckoutAnswer,
  type CheckoutRequest,
  checkoutRequest,
  limitsOf,
  PLANS,
  type Plan,
  type Registration,
  registration,
  STATUS_CHANGED_TOPIC,
  type Status,
  type StatusChanged,
} from "@bodhchakra/billing";
import type { Db, DbClient } from "@bodhchakra/db";
import type { Logger } from "@bodhchakra/log";
import { type Outbox, receive } from "@bodhchakra/outbox";
import * as razorpay from "./razorpay.ts";
import type { Call, Topic } from "./server.ts";

/** The trial is the Team plan (D9); a business picks its plan at checkout. */
const TRIAL_PLAN: Plan = "team";
/** A start this close is no start: Razorpay refuses a start_at in the past, so charge on authorising. */
const START_MARGIN_MS = 5 * 60_000;

export interface BillingDeps {
  /** Connects as platform_app. */
  db: Db;
  log: Logger;
  audit: Audit;
  outbox: Pick<Outbox, "enqueue">;
  razorpay: razorpay.RazorpayAccount & {
    /** Each plan's Razorpay plan id; the price lives there (D9). */
    plans: Readonly<Record<Plan, string>>;
  };
  /** The product whose app receives the status events; platform's outbox delivers to that one app. */
  product: string;
  now?: () => Date;
}

export interface BillingService {
  /** `billing.register`, for the internal API. */
  readonly topic: Topic<Registration>;
  /** `billing.checkout`, answered at once. */
  readonly calls: Readonly<Record<string, Call<CheckoutRequest>>>;
  /** `/hooks/razorpay`. */
  readonly hooks: Readonly<Record<string, (request: Request) => Promise<Response>>>;
}

interface Row {
  id: string;
  product: string;
  tenant_id: string;
  plan: Plan;
  seats: number;
  status: Status;
  trial_ends_at: Date;
  paid_through: Date | null;
  provider_subscription_id: string | null;
  checkout_url: string | null;
  provider_event_at: Date | null;
  version: number;
}
const COLUMNS =
  "s.id, s.product, s.tenant_id, s.plan, s.seats, s.status, s.trial_ends_at, s.paid_through, " +
  "s.provider_subscription_id, s.checkout_url, s.provider_event_at, s.version";

/**
 * The WhatsApp messages a business may send this month (D18), from its plan and seats, for notify. A business whose
 * registration has not arrived yet (it travels through the app's outbox, in no set order with its messages) has the
 * trial's, which is what registration opens.
 */
export async function whatsappQuota(
  client: DbClient,
  product: string,
  tenantId: string,
): Promise<number> {
  const { rows } = await client.query<Pick<Row, "plan" | "seats" | "status">>(
    "select plan, seats, status from billing.subscription where product = $1 and tenant_id = $2",
    [product, tenantId],
  );
  return limitsOf(rows[0] ?? { plan: TRIAL_PLAN, seats: 1, status: "trialing" }).whatsapp;
}

export function createBillingService(deps: BillingDeps): BillingService {
  const { db, log, audit } = deps;
  const now = deps.now ?? (() => new Date());
  const planOf = new Map(PLANS.map((plan) => [deps.razorpay.plans[plan], plan]));

  /** The new state goes to the app, and into the business's audit log, in the transaction that changed it. */
  async function announce(client: DbClient, row: Row): Promise<void> {
    const event: StatusChanged = {
      tenantId: row.tenant_id,
      plan: row.plan,
      seats: row.seats,
      status: row.status,
      trialEndsAt: row.trial_ends_at.toISOString(),
      paidThrough: row.paid_through?.toISOString() ?? null,
      version: row.version,
    };
    await deps.outbox.enqueue(
      client,
      STATUS_CHANGED_TOPIC,
      event,
      `billing.status:${row.id}:${row.version}`,
    );
    // audit.event's policy admits rows of the current business only. Strict: a change that cannot be audited
    // is not made, and Razorpay retries the webhook.
    await client.query("select set_config('app.business_id', $1, true)", [row.tenant_id]);
    await audit.recordStrict(client, {
      businessId: row.tenant_id,
      actor: { kind: "system" },
      action: "billing.status_changed",
      entity: "subscription",
      entityId: row.id,
      data: { plan: row.plan, seats: row.seats, status: row.status, version: row.version },
    });
  }

  const topic: Topic<Registration> = {
    payload: registration,
    async handle(client, message, product) {
      // Platform's outbox reaches one app; a business of another product would never hear of its status.
      if (product !== deps.product) throw new Error(`billing: no status events for ${product}`);
      await client.query(
        "insert into billing.account (identity_id) values ($1) on conflict (identity_id) do nothing",
        [message.identityId],
      );
      // The app wrote its own copy of this trial at version 1, this row's, so the opening row needs no event.
      await client.query(
        `insert into billing.subscription (account_id, product, tenant_id, plan, seats, status, trial_ends_at)
         select id, $2, $3, $4, 1, 'trialing', $5 from billing.account where identity_id = $1
         on conflict (product, tenant_id) do nothing`,
        [message.identityId, product, message.tenantId, TRIAL_PLAN, message.trialEndsAt],
      );
    },
  };

  const answer = (status: number, body: CheckoutAnswer) => Response.json(body, { status });

  const checkout: Call<CheckoutRequest> = {
    payload: checkoutRequest,
    handle: (request, product) =>
      db.tx(async (client) => {
        const { rows } = await client.query<Row & { identity_id: string }>(
          `select ${COLUMNS}, a.identity_id from billing.subscription s
           join billing.account a on a.id = s.account_id
           where s.product = $1 and s.tenant_id = $2
           for update of s`,
          [product, request.tenantId],
        );
        const row = rows[0];
        if (!row) return answer(404, { error: { code: "unknown_tenant" } });
        if (row.identity_id !== request.identityId)
          return answer(403, { error: { code: "not_payer" } });
        const authorised = row.provider_subscription_id !== null && row.checkout_url === null;
        if (authorised && row.status !== "cancelled")
          return answer(409, { error: { code: "subscribed" } });

        // An earlier checkout never authorised is replaced, so only one can ever be paid.
        if (row.provider_subscription_id && row.checkout_url)
          await razorpay.cancelSubscription(deps.razorpay, row.provider_subscription_id);
        const trialLeft = row.trial_ends_at.getTime() - now().getTime() > START_MARGIN_MS;
        const created = await razorpay.createSubscription(deps.razorpay, {
          planId: deps.razorpay.plans[request.plan],
          seats: request.seats,
          ...(trialLeft && { startAt: Math.floor(row.trial_ends_at.getTime() / 1000) }),
          notes: { product, tenant_id: row.tenant_id },
        });
        await client.query(
          `update billing.subscription set provider_subscription_id = $2, checkout_url = $3, updated_at = now()
           where id = $1`,
          [row.id, created.providerId, created.url],
        );
        log.info("billing: checkout made", { subscriptionId: row.id, plan: request.plan });
        return answer(200, { url: created.url });
      }),
  };

  /** What the event makes of the subscription. Paid time only ever grows. */
  function next(row: Row, event: razorpay.SubscriptionEvent): Row {
    const entity = event.payload.subscription.entity;
    const effect = razorpay.EVENTS[event.event];
    if (effect === "authorised") return { ...row, checkout_url: null };
    if (effect === "past_due") return { ...row, status: "past_due" };
    if (effect === "cancelled") return { ...row, status: "cancelled", checkout_url: null };
    const plan = planOf.get(entity.plan_id);
    // A plan we did not make is configuration gone wrong: fail, so Razorpay retries once it is fixed.
    if (!plan) throw new Error(`billing: unknown razorpay plan ${entity.plan_id}`);
    const end = entity.current_end === null ? null : new Date(entity.current_end * 1000);
    const paidThrough =
      end && (!row.paid_through || end > row.paid_through) ? end : row.paid_through;
    return {
      ...row,
      plan,
      seats: entity.quantity,
      status: "active",
      paid_through: paidThrough,
      checkout_url: null,
    };
  }

  const seen = (row: Row) =>
    [row.plan, row.seats, row.status, row.paid_through?.getTime() ?? null].join("|");

  async function apply(client: DbClient, event: razorpay.SubscriptionEvent): Promise<string> {
    const providerId = event.payload.subscription.entity.id;
    const { rows } = await client.query<Row>(
      `select ${COLUMNS} from billing.subscription s where s.provider_subscription_id = $1 for update`,
      [providerId],
    );
    const row = rows[0];
    // A checkout replaced since, or a subscription made outside billing: nothing of ours to move.
    if (!row) return "unknown";
    const at = new Date(event.created_at * 1000);
    if (row.provider_event_at && at < row.provider_event_at) return "stale";

    const after = next(row, event);
    const changed = seen(after) !== seen(row);
    const version = changed ? row.version + 1 : row.version;
    await client.query(
      `update billing.subscription
       set plan = $2, seats = $3, status = $4, paid_through = $5, checkout_url = $6, provider_event_at = $7,
           version = $8, updated_at = now()
       where id = $1`,
      [
        row.id,
        after.plan,
        after.seats,
        after.status,
        after.paid_through,
        after.checkout_url,
        at,
        version,
      ],
    );
    if (changed) await announce(client, { ...after, version });
    return changed ? "changed" : "unchanged";
  }

  async function razorpayHook(request: Request): Promise<Response> {
    if (request.method !== "POST") return Response.json({ error: "not_found" }, { status: 404 });
    const rawBody = await request.text();
    const signature = request.headers.get("x-razorpay-signature");
    if (!razorpay.signatureValid(rawBody, signature, deps.razorpay.webhookSecret)) {
      log.warn("billing: webhook refused", { provider: "razorpay", reason: "signature" });
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    // Signed from here on, so a body that does not parse is Razorpay's bug or ours: fail loudly and let it retry.
    const raw: unknown = JSON.parse(rawBody);
    const name = razorpay.eventName.parse(raw).event;
    if (!Object.hasOwn(razorpay.EVENTS, name)) return Response.json({ status: "ignored" });
    const event = razorpay.subscriptionEvent.parse(raw);

    // The signature has no timestamp and the event-id header is unsigned, so the signed body is the key.
    const key = createHash("sha256").update(rawBody, "utf8").digest("hex");
    let outcome = "duplicate";
    await db.tx((client) =>
      receive(client, "razorpay", key, async () => {
        outcome = await apply(client, event);
      }),
    );
    log.info("billing: webhook", { event: name, outcome });
    return Response.json({ status: outcome });
  }

  return {
    topic,
    calls: { [CHECKOUT_CALL]: checkout },
    hooks: { razorpay: razorpayHook },
  };
}
