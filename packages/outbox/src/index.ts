// One way for one service to tell another (docs/architecture.md 9.1). The sender writes the message in the
// business transaction; a job delivers it as a signed POST and retries with backoff for about a day; the
// receiver records (source, key) in its inbox in the transaction that handles it. At-least-once delivery plus an
// idempotent receiver: each message takes effect exactly once, and a receiver that is down only delays it.
import type { Db, DbClient, MigrationFolder } from "@bodhchakra/db";
import { defineJob, type Jobs, type JobType, type RetryPolicy } from "@bodhchakra/jobs";
import type { Logger } from "@bodhchakra/log";
import { signRequest } from "@bodhchakra/tokens";
import { z } from "zod";

/**
 * 30 s doubling to an hourly cap: the first eight attempts take about 1.5 hours, then 23 more an hour apart, so
 * a message is dead-lettered about 24 hours after it was written.
 */
export const DELIVERY_RETRY: RetryPolicy = {
  retryLimit: 31,
  retryDelay: 30,
  retryBackoff: true,
  retryDelayMax: 3600,
};
const DELIVERY_TIMEOUT_MS = 10_000;

/** The body of every delivery. The key is inside the signed body, so it cannot be swapped in transit. */
export const delivery = z.object({
  key: z.string().min(1).max(200),
  payload: z.record(z.string(), z.unknown()),
});
export type Delivery = z.infer<typeof delivery>;

export interface DeliveryTarget {
  /** The receiver's base URL, e.g. `http://platform:3000`; messages go to `<url>/internal/v1/<topic>`. */
  url: string;
  /** This sender's client id at the receiver, and the secret they share. */
  client: string;
  secret: string;
}

export interface OutboxConfig {
  jobs: Jobs;
  log: Logger;
  /** Tests shorten it; production uses DELIVERY_RETRY. */
  retry?: RetryPolicy;
}

export interface Outbox {
  /** The job types to pass to `jobs.start`. */
  readonly jobTypes: readonly JobType<object>[];
  /**
   * Writes the message in the caller's transaction and queues its delivery there too. The same key twice is
   * one message: the second call is a no-op, so a retried request does not send twice.
   */
  enqueue(
    client: DbClient,
    topic: string,
    payload: Record<string, unknown>,
    key: string,
  ): Promise<void>;
  /** Starts delivering to `target`. `db` connects as the runtime role. Run in the worker. */
  startDelivery(db: Db, target: DeliveryTarget): Promise<void>;
}

const messageRef = z.object({ messageId: z.uuid() });

export function createOutbox(config: OutboxConfig): Outbox {
  const retry = config.retry ?? DELIVERY_RETRY;
  const dead = defineJob("outbox.dead", messageRef, { retry: { retryLimit: 0, retryDelay: 0 } });
  const deliver = defineJob("outbox.deliver", messageRef, { retry, deadLetter: dead });

  return {
    jobTypes: [dead, deliver],

    async enqueue(client, topic, payload, key) {
      const { rows } = await client.query<{ id: string }>(
        `insert into outbox.message (topic, payload, idempotency_key) values ($1, $2, $3)
         on conflict (idempotency_key) do nothing
         returning id`,
        [topic, payload, key],
      );
      const created = rows[0];
      if (created) await config.jobs.send(client, deliver, { messageId: created.id });
    },

    async startDelivery(db, target) {
      const base = new URL(target.url);
      await config.jobs.work(deliver, async ({ messageId }) => {
        const message = await db.tx(async (client) => {
          const { rows } = await client.query<{
            topic: string;
            payload: Record<string, unknown>;
            idempotency_key: string;
            delivered_at: Date | null;
          }>(
            "select topic, payload, idempotency_key, delivered_at from outbox.message where id = $1",
            [messageId],
          );
          return rows[0];
        });
        // The job is sent in the same transaction as the row, so a job without its row is a bug, not a race.
        if (!message) throw new Error(`outbox: message ${messageId} not found`);
        if (message.delivered_at) return;

        const path = `/internal/v1/${message.topic}`;
        const body = JSON.stringify({
          key: message.idempotency_key,
          payload: message.payload,
        } satisfies Delivery);
        const response = await fetch(new URL(path, base), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...signRequest({
              client: target.client,
              secret: target.secret,
              method: "POST",
              path,
              body,
            }),
          },
          body,
          signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
        });
        if (!response.ok) {
          throw new Error(`outbox: ${message.topic} refused with ${response.status}`);
        }
        // If this update is lost the message is delivered again, and the receiver's inbox makes that a no-op.
        await db.tx((client) =>
          client.query("update outbox.message set delivered_at = now() where id = $1", [messageId]),
        );
      });
      await config.jobs.work(dead, async ({ messageId }) => {
        // The alert: an operator looks at the receiver, then redrives undelivered rows from outbox.message.
        config.log.error("outbox: message undeliverable after all retries", { messageId });
      });
    },
  };
}

/**
 * Handles a delivered message at most once. Records `(source, key)` in the inbox on the caller's transaction and
 * runs `handle` only if the pair is new. Returns false for a duplicate, which the caller acknowledges as success.
 * Two concurrent deliveries of one message serialise on the inbox key: the second waits, then sees a duplicate.
 */
export async function receive(
  client: DbClient,
  source: string,
  key: string,
  handle: () => Promise<void>,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `insert into outbox.inbox (source, idempotency_key) values ($1, $2) on conflict do nothing`,
    [source, key],
  );
  if (rowCount === 0) return false;
  await handle();
  return true;
}

/** The outbox and inbox tables; an app lists this after `jobs` and before its own folder. */
export const migrations: MigrationFolder = {
  name: "outbox",
  dir: new URL("../migrations/", import.meta.url),
};
