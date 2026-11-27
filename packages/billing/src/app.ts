// The app's side of billing (docs/architecture.md 13, 9.1). The app keeps a copy of each business's subscription,
// written with the trial at signup and moved only by platform's signed `billing.status_changed` events, newest
// version first. Whether a business is live is computed from that copy at request time, so nothing stored goes
// stale and a platform outage changes nothing. The owner's checkout is an answered call to platform.
import type { Db, DbClient } from "@bodhchakra/db";
import type { Logger } from "@bodhchakra/log";
import { delivery, type Outbox, receive } from "@bodhchakra/outbox";
import { signRequest, verifyRequest } from "@bodhchakra/tokens";
import {
  CHECKOUT_CALL,
  type CheckoutAnswer,
  type CheckoutRequest,
  checkoutAnswer,
  type Plan,
  REGISTER_TOPIC,
  type Registration,
  STATUS_CHANGED_TOPIC,
  type Status,
  type StatusChanged,
  statusChanged,
} from "./contract.ts";

/** A new business's Team trial (D9). */
export const TRIAL_DAYS = 14;
/** Paid time runs on this long after its end, so a card retried a day late does not take a business offline. */
export const GRACE_DAYS = 3;
const DAY_MS = 86_400_000;
const CALL_TIMEOUT_MS = 10_000;
/** The client id platform signs its events as. */
const PLATFORM_CLIENT = "platform";
/** Where platform's outbox delivers status events (`/internal/v1/<topic>`). */
export const STATUS_EVENTS_PATH = `/internal/v1/${STATUS_CHANGED_TOPIC}`;

/** A business's subscription as the app last heard it. */
export interface Subscription {
  readonly plan: Plan;
  readonly seats: number;
  readonly status: Status;
  readonly trialEndsAt: Date;
  /** The end of the last period paid for; null until the first payment. */
  readonly paidThrough: Date | null;
  readonly version: number;
}

/**
 * Whether the business is open to customers now: inside its trial, or inside paid time plus the grace. The trial
 * counts whatever the status, because subscribing during it starts the charge at its end, and paid time counts
 * whatever the status, because a cancellation or a failed charge does not take back a period already paid for.
 */
export function isLive(subscription: Subscription, now: Date): boolean {
  if (now < subscription.trialEndsAt) return true;
  const paid = subscription.paidThrough;
  return paid !== null && now.getTime() < paid.getTime() + GRACE_DAYS * DAY_MS;
}

interface Row {
  plan: Plan;
  seats: number;
  status: Status;
  trial_ends_at: Date;
  paid_through: Date | null;
  version: number;
}
const fromRow = (row: Row): Subscription => ({
  plan: row.plan,
  seats: row.seats,
  status: row.status,
  trialEndsAt: row.trial_ends_at,
  paidThrough: row.paid_through,
  version: row.version,
});

/** The open business's subscription (inside `withTenant`). Every business has one from signup. */
export async function subscriptionOf(client: DbClient): Promise<Subscription> {
  const { rows } = await client.query<Row>(
    "select plan, seats, status, trial_ends_at, paid_through, version from billing.status",
  );
  if (rows.length !== 1) throw new Error("billing: not inside withTenant of one business");
  return fromRow(rows[0] as Row);
}

/** Platform as this app reaches it, and the secret they share (`SERVICE_SECRET`, platform's SERVICE_CLIENTS). */
export interface BillingClientConfig {
  db: Db;
  log: Logger;
  outbox: Pick<Outbox, "enqueue">;
  /** Platform's internal base URL, e.g. `http://platform:3000`. */
  platformUrl: string;
  /** This app's client id at platform, e.g. `kaamkoti`. */
  client: string;
  secret: string;
  now?: () => Date;
}

/** The checkout's answer, or `unavailable` when platform could not be reached: the owner tries again. */
export type CheckoutResult = CheckoutAnswer | { error: { code: "unavailable" } };

export interface BillingClient {
  /**
   * Opens the new business's Team trial: writes the copy and queues `billing.register`, both in the caller's
   * transaction (inside `withTenant` of the business), so a business never exists without either.
   */
  startTrial(
    client: DbClient,
    business: { businessId: string; identityId: string },
  ): Promise<Subscription>;
  /** The provider's page where the owner authorises the subscription. Nothing is paid until its webhook. */
  checkout(request: CheckoutRequest): Promise<CheckoutResult>;
  /**
   * The receiver for platform's status events at `STATUS_EVENTS_PATH`: refuses (401) anything not signed by
   * platform, takes each event once (the inbox), and applies it only if its version is newer than the copy.
   */
  receiveStatus(request: Request): Promise<Response>;
}

const json = (status: number, body: Record<string, string>) => Response.json(body, { status });

export function createBillingClient(config: BillingClientConfig): BillingClient {
  const { db, log } = config;
  const now = config.now ?? (() => new Date());
  const base = new URL(config.platformUrl);

  /** Moves the copy to `event` if it is newer; an older or equal version changes nothing. */
  async function apply(client: DbClient, event: StatusChanged): Promise<boolean> {
    const { rowCount } = await client.query(
      `update billing.status
       set plan = $2, seats = $3, status = $4, trial_ends_at = $5, paid_through = $6, version = $7,
           updated_at = now()
       where business_id = $1 and version < $7`,
      [
        event.tenantId,
        event.plan,
        event.seats,
        event.status,
        event.trialEndsAt,
        event.paidThrough,
        event.version,
      ],
    );
    return rowCount === 1;
  }

  return {
    async startTrial(client, { businessId, identityId }) {
      const trialEndsAt = new Date(now().getTime() + TRIAL_DAYS * DAY_MS);
      // Version 1 is platform's opening row for the same trial, so its first change (version 2) applies here.
      const { rows } = await client.query<Row>(
        `insert into billing.status (business_id, plan, seats, status, trial_ends_at, version)
         values ($1, 'team', 1, 'trialing', $2, 1)
         returning plan, seats, status, trial_ends_at, paid_through, version`,
        [businessId, trialEndsAt],
      );
      const message: Registration = {
        tenantId: businessId,
        identityId,
        trialEndsAt: trialEndsAt.toISOString(),
      };
      await config.outbox.enqueue(
        client,
        REGISTER_TOPIC,
        message,
        `billing.register:${businessId}`,
      );
      return fromRow(rows[0] as Row);
    },

    async checkout(request) {
      const path = `/internal/v1/${CHECKOUT_CALL}`;
      const body = JSON.stringify(request);
      let response: Response;
      try {
        response = await fetch(new URL(path, base), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...signRequest({
              client: config.client,
              secret: config.secret,
              method: "POST",
              path,
              body,
            }),
          },
          body,
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        });
      } catch (error) {
        // The documented fallback: the owner is told platform is unreachable and tries again.
        log.warn("billing: checkout unreachable", { error });
        return { error: { code: "unavailable" } };
      }
      const answer = checkoutAnswer.safeParse(await response.json().catch(() => null));
      if (!answer.success) {
        log.warn("billing: checkout failed", { status: response.status });
        return { error: { code: "unavailable" } };
      }
      return answer.data;
    },

    async receiveStatus(request) {
      const url = new URL(request.url);
      const body = await request.text();
      const verified = verifyRequest({
        method: request.method,
        path: url.pathname + url.search,
        headers: request.headers,
        body,
        secretFor: (client) => (client === PLATFORM_CLIENT ? config.secret : undefined),
      });
      if (!verified.ok) {
        log.warn("billing: status event refused", { reason: verified.reason });
        return json(401, { error: "unauthorized" });
      }
      if (url.pathname !== STATUS_EVENTS_PATH) return json(404, { error: "unknown_topic" });
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return json(400, { error: "invalid_body" });
      }
      const message = delivery.safeParse(parsed);
      const event = message.success ? statusChanged.safeParse(message.data.payload) : undefined;
      if (!message.success || !event?.success) return json(400, { error: "invalid_body" });

      let applied = false;
      const handled = await db.withTenant(event.data.tenantId, (client) =>
        receive(client, verified.client, message.data.key, async () => {
          applied = await apply(client, event.data);
        }),
      );
      log.info("billing: status event", {
        businessId: event.data.tenantId,
        status: event.data.status,
        version: event.data.version,
        outcome: !handled ? "duplicate" : applied ? "applied" : "stale",
      });
      return json(200, { status: handled ? "handled" : "duplicate" });
    },
  };
}
