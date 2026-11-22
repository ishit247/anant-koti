// Notify's server side (docs/architecture.md 9.2). An app's `notify.send` arrives through the internal API and is
// recorded in notify.message, with its delivery job, in the transaction that records it in the inbox. The job
// renders the product's template and sends it, retrying with backoff; once the retries are spent the message is
// marked failed and an operator is alerted. Email is the one channel until WhatsApp (3.3). A message to a member
// names their identity, and its address is looked up here. Messages are kept 30 days, then purged.
// Personal data stays in the row: logs and audit events carry the message id and template, never the recipient,
// the variables or a provider's error text (which can quote the address).
import type { Audit } from "@bodhchakra/audit";
import type { Db, DbClient } from "@bodhchakra/db";
import { defineJob, type Jobs, type JobType, type RetryPolicy } from "@bodhchakra/jobs";
import type { Logger } from "@bodhchakra/log";
import { type NotifyMessage, notifyMessage } from "@bodhchakra/notify";
import { z } from "zod";
import type { Topic } from "./server.ts";
import { kaamkoti } from "./templates/kaamkoti.ts";
import type { Email, Template } from "./templates/template.ts";

/** One email to one address. Throws if the provider did not accept it. */
export type SendEmail = (email: Email & { readonly to: string }) => Promise<void>;

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
  /** Tests shorten it; production uses SEND_RETRY. */
  retry?: RetryPolicy;
}

export interface NotifyService {
  /** The job types to pass to `jobs.start`. */
  readonly jobTypes: readonly JobType<object>[];
  /** `notify.send`, for the internal API. */
  readonly topic: Topic<NotifyMessage>;
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
  status: z.enum(["queued", "sent", "failed", "no_channel"]),
  recipient: notifyMessage.shape.to,
  vars: z.record(z.string(), z.unknown()),
});

/** A provider error reduced to what can be logged: nodemailer's code and SMTP reply code, never its text. */
function failureCode(error: unknown): string {
  if (typeof error !== "object" || error === null) return "unknown";
  const { code, responseCode } = error as { code?: unknown; responseCode?: unknown };
  const parts = [
    typeof code === "string" && /^[A-Z_]{1,40}$/.test(code) ? code : undefined,
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
      const channel = to.email ? "email" : null;
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
      // Until WhatsApp (3.3) a customer with only a phone gets nothing; the owner still shares the link.      log.warn("notify: no channel for message", { messageId: id, template: message.template });
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
        `select id, product, business_id, template, status, recipient, vars
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
  ): Promise<void> {
    await db.tx(async (client) => {
      const updated = await client.query(
        `update notify.message set status = $2, attempts = $3, finished_at = now()
         where id = $1 and status = 'queued'`,
        [message.id, status, attempts],
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

  return {
    jobTypes: [failed, send, purge],
    topic,

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
        const template = templateFor(message.product, message.template);
        if (!template)
          throw new Error(`notify: message ${messageId} names a template that is gone`);
        const email = template.email(template.vars.parse(message.vars));
        const to = message.recipient.email;
        if (!to)
          throw new Error(`notify: message ${messageId} is queued for email with no address`);
        try {
          await deps.sendEmail({ to, ...email });
        } catch (error) {
          const code = failureCode(error);
          log.warn("notify: send failed", {
            messageId,
            template: message.template,
            attempt: job.retryCount + 1,
            code,
          });
          // A new error without the provider's text or cause, which the jobs module logs as it retries.
          throw new Error(`notify: email for message ${messageId} not accepted (${code})`);
        }
        await finish(message, "sent", job.retryCount + 1);
        log.info("notify: sent", { messageId, template: message.template, channel: "email" });
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
