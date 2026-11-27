// Customer payments (docs/architecture.md 8, 12; D5). Each business connects its own Razorpay account; we create
// payment links on it and learn of money only from its signed webhook, so no screen, redirect or API reply can
// mark anything paid. Cash is recorded by a member and audited. Every recorded payment is audited strictly: a
// payment that cannot be audited is not written.
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { Audit } from "@bodhchakra/audit";
import type { Db, DbClient, MigrationFolder } from "@bodhchakra/db";
import type { Logger } from "@bodhchakra/log";
import { type Money, money } from "@bodhchakra/money";
import { receive } from "@bodhchakra/outbox";
import { z } from "zod";
import * as razorpay from "./razorpay.ts";
import { open, seal, sealingKey } from "./seal.ts";

export { sign as signRazorpayWebhook } from "./razorpay.ts";

export type LinkStatus = "created" | "partially_paid" | "paid" | "cancelled" | "expired";

export interface PaymentLink {
  id: string;
  subjectId: string;
  purpose: string;
  url: string;
  amount: Money;
  paid: Money;
  status: LinkStatus;
}

export interface Payment {
  id: string;
  subjectId: string;
  method: "online" | "cash";
  linkId: string | null;
  amount: Money;
  receivedAt: Date;
}

/** What a verified webhook did, handed to the app inside the transaction that recorded it. */
export type PaymentEvent =
  | { kind: "payment.received"; payment: Payment; link: PaymentLink }
  | { kind: "link.closed"; link: PaymentLink };

export type WebhookOutcome = "applied" | "duplicate" | "ignored";

/** A webhook whose signature does not verify, or for a business with no account: answer 401, do nothing. */
export class WebhookRefused extends Error {}

export interface PaymentsConfig {
  /** 32 bytes, base64, from the app's config. */
  sealingKey: string;
  audit: Audit;
  log: Logger;
  /** Tests point this at a local stand-in. */
  razorpayApi?: string;
}

export interface Payments {
  /** Inside `withTenant`. Stores the business's Razorpay keys and webhook secret, sealed; replaces earlier ones. */
  connectAccount(
    client: DbClient,
    input: {
      businessId: string;
      keyId: string;
      keySecret: string;
      webhookSecret: string;
      by: string;
    },
  ): Promise<void>;
  /**
   * Inside `withTenant`. Creates a link on the business's account, or returns the open one already made for the
   * same subject and purpose. The provider call runs inside the caller's transaction: if that later rolls back,
   * the link is left at Razorpay unseen, since its URL was only in the rolled-back row and Razorpay sends nothing
   * itself, so nobody can pay it.
   */
  createPaymentLink(
    client: DbClient,
    input: {
      businessId: string;
      subjectId: string;
      purpose: string;
      amount: Money;
      acceptPartial: boolean;
      description: string;
      customer?: { name: string; email?: string; phone?: string };
      expiresAt?: Date;
    },
  ): Promise<PaymentLink>;
  /** Inside `withTenant`. Cancels an open link at Razorpay, then here. A link already closed is left alone. */
  cancelLink(client: DbClient, input: { businessId: string; linkId: string }): Promise<void>;
  /** Inside `withTenant`. A subject's links, newest first. */
  linksFor(client: DbClient, subjectId: string): Promise<PaymentLink[]>;
  /** Inside `withTenant`. The total received for a subject, online and cash, in `currency`. */
  paidFor(client: DbClient, subjectId: string, currency: string): Promise<Money>;
  /** Inside `withTenant`. A cash payment a member took, audited strictly. */
  recordManual(
    client: DbClient,
    input: { businessId: string; subjectId: string; amount: Money; by: string },
  ): Promise<Payment>;
  /**
   * The webhook route's whole job. `businessId` comes from the URL; the body must be the raw bytes as received.
   * Verifies the signature against that business's secret, then records the event once: the inbox key is the
   * SHA-256 of the signed body (Razorpay's event-id header is not signed), and a payment is unique by its
   * provider id, so a replay changes nothing. `onEvent` runs in the same transaction.
   */
  handleWebhook(
    db: Db,
    request: { businessId: string; signature: string | null; rawBody: string },
    onEvent: (client: DbClient, event: PaymentEvent) => Promise<void>,
  ): Promise<WebhookOutcome>;
}

const PURPOSE = /^[a-z][a-z_]{0,39}$/;
// Razorpay's floor for a payment link is ₹1.
const MIN_LINK_MINOR = 100;

interface LinkRow {
  id: string;
  subject_id: string;
  purpose: string;
  url: string;
  amount_minor: string;
  amount_paid_minor: string;
  currency: string;
  status: LinkStatus;
  provider_link_id: string;
}
const LINK_COLUMNS =
  "id, subject_id, purpose, url, amount_minor, amount_paid_minor, currency, status, provider_link_id";

function toLink(row: LinkRow): PaymentLink {
  return {
    id: row.id,
    subjectId: row.subject_id,
    purpose: row.purpose,
    url: row.url,
    amount: money(Number(row.amount_minor), row.currency),
    paid: money(Number(row.amount_paid_minor), row.currency),
    status: row.status,
  };
}

interface PaymentRow {
  id: string;
  subject_id: string;
  method: "online" | "cash";
  link_id: string | null;
  amount_minor: string;
  currency: string;
  received_at: Date;
}
const PAYMENT_COLUMNS = "id, subject_id, method, link_id, amount_minor, currency, received_at";

function toPayment(row: PaymentRow): Payment {
  return {
    id: row.id,
    subjectId: row.subject_id,
    method: row.method,
    linkId: row.link_id,
    amount: money(Number(row.amount_minor), row.currency),
    receivedAt: row.received_at,
  };
}

const eventName = z.object({ event: z.string() });
const HANDLED = new Set([
  "payment_link.paid",
  "payment_link.partially_paid",
  "payment_link.cancelled",
  "payment_link.expired",
]);

export function createPayments(config: PaymentsConfig): Payments {
  const key = sealingKey(config.sealingKey);
  const api = config.razorpayApi ?? razorpay.RAZORPAY_API;
  const { audit, log } = config;

  async function account(client: DbClient, businessId: string) {
    const { rows } = await client.query<{
      key_id: string;
      key_secret: Buffer;
      webhook_secret: Buffer;
    }>("select key_id, key_secret, webhook_secret from payments.account where business_id = $1", [
      businessId,
    ]);
    const row = rows[0];
    if (!row) return null;
    return {
      keyId: row.key_id,
      keySecret: () => open(key, row.key_secret, `${businessId}:key_secret`),
      webhookSecret: () => open(key, row.webhook_secret, `${businessId}:webhook_secret`),
    };
  }

  async function recordOnline(
    client: DbClient,
    businessId: string,
    body: Extract<razorpay.WebhookBody, { kind: "paid" }>,
  ): Promise<PaymentEvent | null> {
    const providerPayment = body.payload.payment.entity;
    const { rows: linkRows } = await client.query<LinkRow>(
      // Locked, so two part-payments arriving together add up instead of overwriting each other's sum.
      `select ${LINK_COLUMNS} from payments.link where provider = 'razorpay' and provider_link_id = $1
       for update`,
      [body.payload.payment_link.entity.id],
    );
    const link = linkRows[0];
    if (!link) {
      // The business also takes Razorpay payments we did not ask for; they are theirs, not ours to record.
      log.warn("payments: webhook for a link we did not create", { businessId, event: body.event });
      return null;
    }
    if (providerPayment.status !== "captured") {
      log.warn("payments: webhook payment not captured", { businessId, linkId: link.id });
      return null;
    }
    if (providerPayment.currency !== link.currency) {
      throw new Error(`payments: link ${link.id} paid in ${providerPayment.currency}`);
    }
    const { rows: inserted } = await client.query<PaymentRow>(
      `insert into payments.payment
         (business_id, subject_id, method, link_id, provider_payment_id, provider_method, amount_minor, currency)
       values ($1, $2, 'online', $3, $4, $5, $6, $7)
       on conflict (business_id, provider_payment_id) do nothing
       returning ${PAYMENT_COLUMNS}`,
      [
        businessId,
        link.subject_id,
        link.id,
        providerPayment.id,
        providerPayment.method,
        providerPayment.amount,
        providerPayment.currency,
      ],
    );
    const paymentRow = inserted[0];
    if (!paymentRow) return null;

    const paid = BigInt(link.amount_paid_minor) + BigInt(providerPayment.amount);
    const amount = BigInt(link.amount_minor);
    if (paid > amount) throw new Error(`payments: link ${link.id} paid beyond its amount`);
    // The status follows from what was recorded, not from what the event says the link is. Money taken on a
    // link we had cancelled (a race at the provider) is still recorded; the link stays cancelled.
    const { rows: updated } = await client.query<LinkRow>(
      `update payments.link set amount_paid_minor = $2,
         status = case when status in ('created', 'partially_paid')
                       then (case when $2 = amount_minor then 'paid' else 'partially_paid' end)
                       else status end,
         updated_at = now()
       where id = $1 returning ${LINK_COLUMNS}`,
      [link.id, paid.toString()],
    );
    const payment = toPayment(paymentRow);
    await audit.recordStrict(client, {
      businessId,
      actor: { kind: "system" },
      action: "payment.recorded",
      entity: "payment",
      entityId: payment.id,
      data: {
        method: "online",
        linkId: link.id,
        subjectId: link.subject_id,
        amountMinor: payment.amount.minor,
        currency: payment.amount.currency,
      },
    });
    return { kind: "payment.received", payment, link: toLink(updated[0] as LinkRow) };
  }

  async function closeLink(
    client: DbClient,
    businessId: string,
    body: Extract<razorpay.WebhookBody, { kind: "closed" }>,
  ): Promise<PaymentEvent | null> {
    const status = body.event === "payment_link.cancelled" ? "cancelled" : "expired";
    const { rows } = await client.query<LinkRow>(
      `update payments.link set status = $2, updated_at = now()
       where provider = 'razorpay' and provider_link_id = $1 and status in ('created', 'partially_paid')
       returning ${LINK_COLUMNS}`,
      [body.payload.payment_link.entity.id, status],
    );
    const row = rows[0];
    if (!row) {
      log.info("payments: close event for no open link", { businessId, event: body.event });
      return null;
    }
    return { kind: "link.closed", link: toLink(row) };
  }

  return {
    async connectAccount(client, input) {
      await client.query(
        `insert into payments.account (business_id, provider, key_id, key_secret, webhook_secret)
         values ($1, 'razorpay', $2, $3, $4)
         on conflict (business_id) do update set key_id = excluded.key_id,
           key_secret = excluded.key_secret, webhook_secret = excluded.webhook_secret, updated_at = now()`,
        [
          input.businessId,
          input.keyId,
          seal(key, input.keySecret, `${input.businessId}:key_secret`),
          seal(key, input.webhookSecret, `${input.businessId}:webhook_secret`),
        ],
      );
      await audit.record(client, {
        businessId: input.businessId,
        actor: { kind: "member", id: input.by },
        action: "payment_account.connected",
        entity: "payment_account",
        entityId: input.businessId,
        data: { mode: input.keyId.startsWith("rzp_live_") ? "live" : "test" },
      });
    },

    async createPaymentLink(client, input) {
      if (!PURPOSE.test(input.purpose))
        throw new RangeError(`payments: bad purpose "${input.purpose}"`);
      if (input.amount.minor < MIN_LINK_MINOR)
        throw new RangeError("payments: a link must be for at least 100 minor units");

      const { rows: open } = await client.query<LinkRow>(
        `select ${LINK_COLUMNS} from payments.link
         where subject_id = $1 and purpose = $2 and status in ('created', 'partially_paid')`,
        [input.subjectId, input.purpose],
      );
      const existing = open[0];
      if (existing) {
        if (BigInt(existing.amount_minor) !== BigInt(input.amount.minor)) {
          throw new Error(`payments: an open ${input.purpose} link has a different amount`);
        }
        return toLink(existing);
      }

      const credentials = await account(client, input.businessId);
      if (!credentials) throw new Error("payments: the business has no payment account");
      const id = crypto.randomUUID();
      const created = await razorpay.createLink(
        api,
        { keyId: credentials.keyId, keySecret: credentials.keySecret() },
        {
          referenceId: id,
          amountMinor: input.amount.minor,
          currency: input.amount.currency,
          acceptPartial: input.acceptPartial,
          description: input.description,
          ...(input.customer ? { customer: input.customer } : {}),
          ...(input.expiresAt ? { expireBy: Math.floor(input.expiresAt.getTime() / 1000) } : {}),
          notes: { subject_id: input.subjectId, purpose: input.purpose },
        },
      );
      const { rows } = await client.query<LinkRow>(
        `insert into payments.link (id, business_id, subject_id, purpose, provider, provider_link_id, url,
           amount_minor, currency, accept_partial)
         values ($1, $2, $3, $4, 'razorpay', $5, $6, $7, $8, $9)
         returning ${LINK_COLUMNS}`,
        [
          id,
          input.businessId,
          input.subjectId,
          input.purpose,
          created.providerLinkId,
          created.url,
          input.amount.minor,
          input.amount.currency,
          input.acceptPartial,
        ],
      );
      return toLink(rows[0] as LinkRow);
    },

    async cancelLink(client, { businessId, linkId }) {
      const { rows } = await client.query<LinkRow>(
        `select ${LINK_COLUMNS} from payments.link
         where id = $1 and status in ('created', 'partially_paid') for update`,
        [linkId],
      );
      const link = rows[0];
      if (!link) return;
      const credentials = await account(client, businessId);
      if (!credentials) throw new Error("payments: the business has no payment account");
      await razorpay.cancelLink(
        api,
        { keyId: credentials.keyId, keySecret: credentials.keySecret() },
        link.provider_link_id,
      );
      await client.query(
        "update payments.link set status = 'cancelled', updated_at = now() where id = $1",
        [linkId],
      );
    },

    async linksFor(client, subjectId) {
      const { rows } = await client.query<LinkRow>(
        `select ${LINK_COLUMNS} from payments.link where subject_id = $1 order by created_at desc, id`,
        [subjectId],
      );
      return rows.map(toLink);
    },

    async paidFor(client, subjectId, currency) {
      const { rows } = await client.query<{ total: string; other: boolean }>(
        `select coalesce(sum(amount_minor) filter (where currency = $2), 0) as total,
                coalesce(bool_or(currency <> $2), false) as other
         from payments.payment where subject_id = $1`,
        [subjectId, currency],
      );
      const row = rows[0];
      if (row?.other)
        throw new Error(`payments: subject ${subjectId} has payments in another currency`);
      return money(Number(row?.total ?? 0), currency);
    },

    async recordManual(client, input) {
      const { rows } = await client.query<PaymentRow>(
        `insert into payments.payment (business_id, subject_id, method, recorded_by, amount_minor, currency)
         values ($1, $2, 'cash', $3, $4, $5)
         returning ${PAYMENT_COLUMNS}`,
        [input.businessId, input.subjectId, input.by, input.amount.minor, input.amount.currency],
      );
      const payment = toPayment(rows[0] as PaymentRow);
      await audit.recordStrict(client, {
        businessId: input.businessId,
        actor: { kind: "member", id: input.by },
        action: "payment.recorded",
        entity: "payment",
        entityId: payment.id,
        data: {
          method: "cash",
          subjectId: input.subjectId,
          amountMinor: payment.amount.minor,
          currency: payment.amount.currency,
        },
      });
      return payment;
    },

    async handleWebhook(db, request, onEvent) {
      return db.withTenant(request.businessId, async (client) => {
        const credentials = await account(client, request.businessId);
        if (
          !credentials ||
          request.signature === null ||
          !razorpay.signatureValid(request.rawBody, request.signature, credentials.webhookSecret())
        ) {
          throw new WebhookRefused("payments: webhook signature does not verify");
        }
        // Signed from here on, so a body that does not parse is Razorpay's bug or ours: fail loudly and let it retry.
        const raw: unknown = JSON.parse(request.rawBody);
        if (!HANDLED.has(eventName.parse(raw).event)) return "ignored";
        const body = razorpay.webhookBody.parse(raw);

        const inboxKey = createHash("sha256").update(request.rawBody, "utf8").digest("hex");
        let event: PaymentEvent | null = null;
        const fresh = await receive(client, "razorpay", inboxKey, async () => {
          const done =
            body.kind === "paid"
              ? await recordOnline(client, request.businessId, body)
              : await closeLink(client, request.businessId, body);
          if (done) await onEvent(client, done);
          event = done;
        });
        if (!fresh) return "duplicate";
        return event ? "applied" : "ignored";
      });
    },
  };
}

/** `payments/0001_payments.sql`; an app lists it after `outbox` and `audit`, before its own folder. */
export const migrations: MigrationFolder = {
  name: "payments",
  dir: pathToFileURL(`${import.meta.dirname}/../migrations/`),
};
