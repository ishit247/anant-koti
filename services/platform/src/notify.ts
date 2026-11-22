// Notify's server side (docs/architecture.md 9.2). An app's `notify.send` arrives through the internal API and is
// recorded in notify.message, with its delivery job, in the transaction that records it in the inbox. The job
// renders the product's template and sends it, retrying with backoff; once the retries are spent the message is
// marked failed and an operator is alerted. WhatsApp goes first when the message has a phone, its template a
// WhatsApp version and the business quota left this month; otherwise email. Meta's status webhook then marks a
// WhatsApp message delivered, or failed. A message to a member names their identity, and its address is looked
// up here. Messages are kept 30 days, then purged.
// Personal data stays in the row: logs and audit events carry the message id and template, never the recipient,
// the variables or a provider's error text (which can quote the address).
import { timingSafeEqual } from "node:crypto";
import type { Audit } from "@bodhchakra/audit";
import type { Db, DbClient } from "@bodhchakra/db";
import { defineJob, type Jobs, type JobType, type RetryPolicy } from "@bodhchakra/jobs";
import type { Logger } from "@bodhchakra/log";
import { type NotifyMessage, notifyMessage } from "@bodhchakra/notify";
import { z } from "zod";
import type { Topic } from "./server.ts";
import { kaamkoti } from "./templates/kaamkoti.ts";
import type { Email, Template } from "./templates/template.ts";
import { type SendWhatsApp, statusWebhook, verifySignature } from "./whatsapp.ts";

/** One email to one address. Throws if the provider did not accept it. */
export type SendEmail = (email: Email & { readonly to: string }) => Promise<void>;

/** The WhatsApp channel, when platform has a Meta account configured. */
export interface WhatsAppChannel {
  send: SendWhatsApp;
  /** Verifies the status webhook's signature. */
  appSecret: string;
  /** Meta echoes it when the webhook is subscribed. */
  verifyToken: string;
  /** WhatsApp messages per business per month; over it, messages go by email. Plans carry it from 5.1. */
  monthlyQuota: number;
}

/** Until a second language joins, every template is submitted to Meta in English. */
const WHATSAPP_LANGUAGE = "en";

/**
 * 1 minute doubling to an hourly cap: ten attempts over about four hours. A message that late is stale (a
 * reminder after its visit), so it is given up on sooner than an outbox delivery.
 */
export const SEND_RETRY: RetryPolicy = {
  retryLimit: 9,
  retryDelay: 60,
  retryBackoff: true,
  retryDelayMax: 3600,
};

/** Each product's templates, by the client id it signs with. */
// biome-ignore lint/suspicious/noExplicitAny: each template's variables are checked by its own schema.
const PRODUCTS: Readonly<Record<string, Readonly<Record<string, Template<any>>>>> = { kaamkoti };

// biome-ignore lint/suspicious/noExplicitAny: as above.
function templateFor(product: string, name: string): Template<any> | undefined {
  const templates = Object.hasOwn(PRODUCTS, product) ? PRODUCTS[product] : undefined;
  return templates && Object.hasOwn(templates, name) ? templates[name] : undefined;
}

export interface NotifyDeps {
  /** Connects as platform_app. */
  db: Db;
  jobs: Jobs;
  log: Logger;
  audit: Audit;
  sendEmail: SendEmail;
  /** Absent: email is the one channel. */
  whatsapp?: WhatsAppChannel;
  /** Tests shorten it; production uses SEND_RETRY. */
  retry?: RetryPolicy;
}

export interface NotifyService {
  /** The job types to pass to `jobs.start`. */
  readonly jobTypes: readonly JobType<object>[];
  /** `notify.send`, for the internal API. */
  readonly topic: Topic<NotifyMessage>;
  /** Provider webhooks, by the name in their path `/hooks/<name>`: `whatsapp` when that channel is on. */
  readonly hooks: Readonly<Record<string, (request: Request) => Promise<Response>>>;
  /** Starts sending, and the daily purge of messages older than 30 days. Call after `jobs.start`. */
  startSending(): Promise<void>;
}

/** Daily, at a quiet hour in India (UTC). */
const PURGE_CRON = "30 21 * * *";

const messageRef = z.object({ messageId: z.uuid() });
const stored = z.object({
  id: z.uuid(),
  product: z.string(),
  business_id: z.uuid(),
  template: z.string(),
  channel: z.enum(["email", "whatsapp"]).nullable(),
  status: z.enum(["queued", "sent", "delivered", "failed", "no_channel"]),
  recipient: notifyMessage.shape.to,
  vars: z.record(z.string(), z.unknown()),
});

/**
 * A provider error reduced to what can be logged, never its text: nodemailer's code and SMTP reply code, or the
 * WhatsApp sender's code and HTTP status.
 */
function failureCode(error: unknown): string {
  if (typeof error !== "object" || error === null) return "unknown";
  const { code, responseCode } = error as { code?: unknown; responseCode?: unknown };
  const parts = [
    typeof code === "string" && /^[A-Z][A-Z0-9_]{0,39}$/.test(code) ? code : undefined,
    typeof responseCode === "number" ? String(responseCode) : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : "unknown";
}

export function createNotifyService(deps: NotifyDeps): NotifyService {
  const { db, jobs, log, audit } = deps;
  const failed = defineJob("notify.failed", messageRef, {
    retry: { retryLimit: 0, retryDelay: 0 },
  });
  const send = defineJob("notify.deliver", messageRef, {
    retry: deps.retry ?? SEND_RETRY,
    deadLetter: failed,
  });
  // A missed run is caught up by the next day's, so a failure only waits for it.
  const purge = defineJob("notify.purge", z.object({}), {
    retry: { retryLimit: 0, retryDelay: 0 },
  });

  /**
   * A member's addresses, from their identity: the email they sign in with (a phone joins in 3.3). An identity
   * that is gone leaves only the id, which is a message with no channel.
   */
  async function memberAddress(client: DbClient, identityId: string): Promise<NotifyMessage["to"]> {
    const { rows } = await client.query<{ email: string }>(
      'select email from identity."user" where id = $1',
      [identityId],
    );
    const email = rows[0]?.email;
    return { identityId, ...(email && { email }) };
  }

  /**
   * Counts one WhatsApp message against the business's quota for this month, if any is left. The upsert takes the
   * row's lock, so two messages at once cannot both take the last one.
   */
  async function takeQuota(
    client: DbClient,
    product: string,
    businessId: string,
    limit: number,
  ): Promise<boolean> {
    const { rowCount } = await client.query(
      `insert into notify.quota as q (product, business_id, month, used)
       values ($1, $2, date_trunc('month', now() at time zone 'UTC')::date, 1)
       on conflict (product, business_id, month) do update set used = q.used + 1 where q.used < $3`,
      [product, businessId, limit],
    );
    return rowCount === 1;
  }

  async function chooseChannel(
    client: DbClient,
    product: string,
    businessId: string,
    // biome-ignore lint/suspicious/noExplicitAny: the template's variables were checked by the caller.
    template: Template<any>,
    to: NotifyMessage["to"],
  ): Promise<"whatsapp" | "email" | null> {
    const whatsapp = deps.whatsapp;
    if (
      to.phone &&
      template.whatsapp &&
      whatsapp &&
      (await takeQuota(client, product, businessId, whatsapp.monthlyQuota))
    )
      return "whatsapp";
    return to.email ? "email" : null;
  }

  /** The audit row of a message's outcome, in the business's audit log. */
  async function recordOutcome(
    client: DbClient,
    message: { id: string; businessId: string; template: string },
    action: "notify.sent" | "notify.failed" | "notify.no_channel",
    attempts: number,
  ): Promise<void> {
    // audit.event's policy admits rows of the current business only.
    await client.query("select set_config('app.business_id', $1, true)", [message.businessId]);
    await audit.record(client, {
      businessId: message.businessId,
      actor: { kind: "system" },
      action,
      entity: "notify_message",
      entityId: message.id,
      data: { template: message.template, attempts },
    });
  }

  const topic: Topic<NotifyMessage> = {
    payload: notifyMessage,
    async handle(client, message, product) {
      const template = templateFor(product, message.template);
      // An app naming a template it does not have is a bug in that app: refused, so its outbox retries and
      // then alerts, instead of a message vanishing.
      if (!template) throw new Error(`notify: ${product} has no template ${message.template}`);
      const vars = template.vars.safeParse(message.vars);
      if (!vars.success) {
        // The issue paths only: the values are personal data.
        const paths = vars.error.issues.map((issue) => issue.path.join(".")).join(", ");
        throw new Error(`notify: ${product} ${message.template} has bad variables (${paths})`);
      }
      const to = message.to.identityId
        ? await memberAddress(client, message.to.identityId)
        : message.to;
      const channel = await chooseChannel(client, product, message.businessId, template, to);
      const { rows } = await client.query<{ id: string }>(
        `insert into notify.message (product, business_id, template, channel, recipient, vars, status)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning id`,
        [
          product,
          message.businessId,
          message.template,
          channel,
          to,
          message.vars,
          channel ? "queued" : "no_channel",
        ],
      );
      const id = (rows[0] as { id: string }).id;
      if (channel) {
        await jobs.send(client, send, { messageId: id });
        return;
      }
      // A customer with only a phone, when WhatsApp is off or over quota, gets nothing; the owner still shares the
      // link. Telling the owner when the quota runs out waits for 3.3c.
      log.warn("notify: no channel for message", { messageId: id, template: message.template });
      await recordOutcome(
        client,
        { id, businessId: message.businessId, template: message.template },
        "notify.no_channel",
        0,
      );
    },
  };

  async function load(messageId: string) {
    const { rows } = await db.tx((client) =>
      client.query(
        `select id, product, business_id, template, channel, status, recipient, vars
         from notify.message where id = $1`,
        [messageId],
      ),
    );
    // The job is sent in the same transaction as the row, so a job without its row is a bug, not a race.
    if (!rows[0]) throw new Error(`notify: message ${messageId} not found`);
    return stored.parse(rows[0]);
  }

  async function finish(
    message: z.infer<typeof stored>,
    status: "sent" | "failed",
    attempts: number,
    providerId?: string,
  ): Promise<void> {
    await db.tx(async (client) => {
      const updated = await client.query(
        `update notify.message set status = $2, attempts = $3, provider_id = $4, finished_at = now()
         where id = $1 and status = 'queued'`,
        [message.id, status, attempts, providerId ?? null],
      );
      if (updated.rowCount === 0) return;
      await recordOutcome(
        client,
        { id: message.id, businessId: message.business_id, template: message.template },
        status === "sent" ? "notify.sent" : "notify.failed",
        attempts,
      );
    });
  }

  /**
   * The provider call for a queued message, which resolves to the provider's id of it if the channel gives one.
   * What it throws is the provider's refusal; a message that cannot be sent at all throws here, before the call.
   */
  function delivery(message: z.infer<typeof stored>): () => Promise<string | undefined> {
    const template = templateFor(message.product, message.template);
    if (!template) throw new Error(`notify: message ${message.id} names a template that is gone`);
    const vars = template.vars.parse(message.vars);
    if (message.channel === "whatsapp") {
      const version = template.whatsapp;
      const to = message.recipient.phone;
      const channel = deps.whatsapp;
      // A message queued for WhatsApp while the channel was on, sent after it was turned off, retries and fails.
      if (!version || !to || !channel)
        throw new Error(
          `notify: message ${message.id} is queued for WhatsApp, which cannot send it`,
        );
      const params = version
        .params(vars)
        // Meta refuses a parameter with a line break, a tab or more than four spaces in a row.
        .map((param) => param.replace(/\s+/g, " ").trim());
      return async () =>
        (await channel.send({ to, name: version.name, language: WHATSAPP_LANGUAGE, params }))
          .providerId;
    }
    const to = message.recipient.email;
    if (!to) throw new Error(`notify: message ${message.id} is queued for email with no address`);
    const email = template.email(vars);
    return async () => {
      await deps.sendEmail({ to, ...email });
      return undefined;
    };
  }

  /**
   * Meta's status webhook (architecture 9.2): `delivered` and `read` mark a sent message delivered; `failed` marks
   * it failed and audits it. Each change is guarded by the status it comes from, so a replayed or reordered
   * webhook changes nothing twice. A status for an id we do not have (purged, or another app's) is ignored.
   */
  async function whatsappHook(request: Request, channel: WhatsAppChannel): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET") {
      // The subscription handshake: Meta sends the verify token we gave it and expects the challenge back.
      const challenge = url.searchParams.get("hub.challenge") ?? "";
      const token = Buffer.from(url.searchParams.get("hub.verify_token") ?? "");
      const expected = Buffer.from(channel.verifyToken);
      const ok =
        url.searchParams.get("hub.mode") === "subscribe" &&
        token.length === expected.length &&
        timingSafeEqual(token, expected) &&
        /^[A-Za-z0-9_-]{1,200}$/.test(challenge);
      return ok
        ? new Response(challenge, { headers: { "content-type": "text/plain" } })
        : Response.json({ error: "forbidden" }, { status: 403 });
    }
    if (request.method !== "POST") return Response.json({ error: "not_found" }, { status: 404 });

    const body = Buffer.from(await request.arrayBuffer());
    if (!verifySignature(channel.appSecret, body, request.headers.get("x-hub-signature-256"))) {
      log.warn("notify: webhook refused", { provider: "whatsapp", reason: "signature" });
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      parsed = undefined;
    }
    const update = statusWebhook.safeParse(parsed);
    if (!update.success) {
      log.warn("notify: webhook refused", { provider: "whatsapp", reason: "body" });
      return Response.json({ error: "invalid_body" }, { status: 400 });
    }
    const statuses = update.data.entry.flatMap((entry) =>
      entry.changes.flatMap((change) => change.value.statuses ?? []),
    );
    await db.tx(async (client) => {
      for (const status of statuses) {
        if (status.status === "delivered" || status.status === "read") {
          await client.query(
            "update notify.message set status = 'delivered' where provider_id = $1 and status = 'sent'",
            [status.id],
          );
        } else if (status.status === "failed") {
          const { rows } = await client.query<{
            id: string;
            business_id: string;
            template: string;
            attempts: number;
          }>(
            `update notify.message set status = 'failed' where provider_id = $1 and status = 'sent'
             returning id, business_id, template, attempts`,
            [status.id],
          );
          const message = rows[0];
          if (!message) continue;
          await recordOutcome(
            client,
            { id: message.id, businessId: message.business_id, template: message.template },
            "notify.failed",
            message.attempts,
          );
          // Meta's numeric code says why (e.g. 131026, not on WhatsApp); its title can quote the number.
          log.warn("notify: whatsapp not delivered", {
            messageId: message.id,
            template: message.template,
            code: status.errors?.[0]?.code ?? null,
          });
        }
      }
    });
    return Response.json({ status: "ok" });
  }

  const whatsapp = deps.whatsapp;
  return {
    jobTypes: [failed, send, purge],
    topic,
    hooks: whatsapp ? { whatsapp: (request) => whatsappHook(request, whatsapp) } : {},

    async startSending() {
      await jobs.work(purge, async () => {
        const { rows } = await db.tx((client) =>
          client.query<{ purged: string }>("select notify.purge_messages() as purged"),
        );
        log.info("notify: purged old messages", { count: Number(rows[0]?.purged ?? 0) });
      });
      await jobs.schedule(purge, PURGE_CRON, {});

      await jobs.work(send, async ({ messageId }, job) => {
        const message = await load(messageId);
        if (message.status !== "queued") return;
        const sendIt = delivery(message);
        let providerId: string | undefined;
        try {
          providerId = await sendIt();
        } catch (error) {
          const code = failureCode(error);
          log.warn("notify: send failed", {
            messageId,
            template: message.template,
            attempt: job.retryCount + 1,
            code,
          });
          // A new error without the provider's text or cause, which the jobs module logs as it retries.
          throw new Error(
            `notify: ${message.channel} for message ${messageId} not accepted (${code})`,
          );
        }
        await finish(message, "sent", job.retryCount + 1, providerId);
        log.info("notify: sent", {
          messageId,
          template: message.template,
          channel: message.channel,
        });
      });

      await jobs.work(failed, async ({ messageId }) => {
        const message = await load(messageId);
        await finish(message, "failed", (deps.retry ?? SEND_RETRY).retryLimit + 1);
        // The alert: an operator checks the provider, then requeues the message's job.
        log.error("notify: message not sent after all retries", {
          messageId,
          template: message.template,
        });
      });
    },
  };
}
