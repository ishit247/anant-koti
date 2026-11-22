// Background jobs on pg-boss (docs/architecture.md 12). The schema is installed by this module's migrations, so
// pg-boss runs as the runtime role with its own migration, schema creation and REINDEX turned off: that role
// owns nothing and may not run DDL. Jobs are sent on the caller's transaction, so a job exists only if the
// business write that asked for it committed.
import { pathToFileURL } from "node:url";
import type { DbClient, MigrationFolder } from "@bodhchakra/db";
import type { Logger } from "@bodhchakra/log";
import { PgBoss } from "pg-boss";
import type { z } from "zod";

const SCHEMA = "pgboss";

export interface RetryPolicy {
  /** Attempts after the first. */
  readonly retryLimit: number;
  /** Seconds before the first retry; doubled each time (with jitter) when `retryBackoff` is set. */
  readonly retryDelay: number;
  readonly retryBackoff?: boolean;
  /** Upper bound for one backed-off delay, in seconds. */
  readonly retryDelayMax?: number;
}

export interface JobType<P extends object> {
  readonly name: string;
  readonly payload: z.ZodType<P>;
  readonly retry: RetryPolicy;
  /** The job a payload is copied to once its retries are spent. */
  readonly deadLetter?: JobType<P>;
}

const NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export function defineJob<P extends object>(
  name: string,
  payload: z.ZodType<P>,
  options: { retry: RetryPolicy; deadLetter?: JobType<P> },
): JobType<P> {
  if (!NAME.test(name)) throw new Error(`defineJob: "${name}" must be dotted lower-case`);
  return { name, payload, retry: options.retry, deadLetter: options.deadLetter };
}

export interface SendOptions {
  /** Not run before this moment (a notice at a quote's expiry). */
  readonly startAfter?: Date;
}

export interface JobContext {
  readonly id: string;
  /** 0 on the first attempt. */
  readonly retryCount: number;
}

export interface Jobs {
  /**
   * Starts pg-boss and creates or updates the queues for `types`. Call once. `send` waits for it, so a process
   * may start in the background and send at once; `work` must come after it resolves.
   */
  start(types: readonly JobType<object>[]): Promise<void>;
  /**
   * Queues a job in the caller's transaction: it is created only if that transaction commits. Fails if `start`
   * was never called, or failed.
   */
  send<P extends object>(
    client: DbClient,
    type: JobType<P>,
    payload: P,
    options?: SendOptions,
  ): Promise<void>;
  /**
   * Runs a job of `type` with `payload` on a cron expression (UTC), from whichever worker process is up; calling
   * it again replaces the schedule, so a process may call it on every start. Needs a process that is not
   * `sendOnly`, after `start`.
   */
  schedule<P extends object>(type: JobType<P>, cron: string, payload: P): Promise<void>;
  /**
   * Runs `handler` for each job of `type`, one at a time. A handler that throws fails the attempt and the job is
   * retried by its policy. The stored payload is parsed with the type's schema before the handler sees it.
   */
  work<P extends object>(
    type: JobType<P>,
    handler: (payload: P, job: JobContext) => Promise<void>,
  ): Promise<void>;
  /** Stops workers after their current job, then closes the pool. */
  stop(): Promise<void>;
}

export interface JobsConfig {
  /** Connects as the runtime role. */
  url: string;
  log: Logger;
  /** How often an idle worker looks for jobs; pg-boss's floor is 0.5. */
  pollingIntervalSeconds?: number;
  /**
   * A process that only queues jobs (the web process) leaves maintenance to the worker: no supervision and no
   * cron scheduling, so it holds no timers of its own.
   */
  sendOnly?: boolean;
}

export function createJobs(config: JobsConfig): Jobs {
  const boss = new PgBoss({
    connectionString: config.url,
    schema: SCHEMA,
    application_name: "jobs",
    max: 4,
    migrate: false,
    createSchema: false,
    reindex: false,
    supervise: !config.sendOnly,
    schedule: !config.sendOnly,
  });
  let started: Promise<void> | undefined;
  // pg-boss reports its own background failures as events; an unheard `error` event would crash the process.
  boss.on("error", (error) => config.log.error("jobs: pg-boss error", { error }));
  boss.on("warning", (warning) => config.log.warn("jobs: pg-boss warning", { warning }));

  return {
    start(types) {
      if (started) throw new Error("jobs: start called twice");
      started = (async () => {
        await boss.start();
        // A dead-letter queue must exist before a queue that names it.
        const ordered = [...types].sort(
          (a, b) => Number(Boolean(a.deadLetter)) - Number(Boolean(b.deadLetter)),
        );
        for (const type of ordered) {
          const options = type.deadLetter
            ? { ...type.retry, deadLetter: type.deadLetter.name }
            : type.retry;
          // createQueue leaves an existing queue alone, so the policy in code is applied with updateQueue.
          await boss.createQueue(type.name, options);
          await boss.updateQueue(type.name, options);
        }
      })();
      return started;
    },
    async send(client, type, payload, options) {
      if (!started) throw new Error(`jobs: ${type.name} sent before start`);
      await started;
      await boss.send(type.name, payload, {
        db: { executeSql: (text, values) => client.query(text, values) },
        ...(options?.startAfter && { startAfter: options.startAfter }),
      });
    },
    async schedule(type, cron, payload) {
      if (config.sendOnly) throw new Error(`jobs: ${type.name} scheduled from a send-only process`);
      if (!started) throw new Error(`jobs: ${type.name} scheduled before start`);
      await started;
      await boss.schedule(type.name, cron, payload, { tz: "UTC" });
    },
    async work(type, handler) {
      await boss.work<unknown>(
        type.name,
        { batchSize: 1, pollingIntervalSeconds: config.pollingIntervalSeconds ?? 2 },
        async ([job]) => {
          if (!job) return;
          try {
            await handler(type.payload.parse(job.data), { id: job.id, retryCount: job.retryCount });
          } catch (error) {
            config.log.warn("job attempt failed", {
              job: type.name,
              jobId: job.id,
              retryCount: job.retryCount,
              error,
            });
            throw error;
          }
        },
      );
    },
    stop: () => boss.stop({ graceful: true, close: true }),
  };
}

/** The pg-boss schema and the runtime role's rights on it; an app lists this before its own folder. */
export const migrations: MigrationFolder = {
  name: "jobs",
  // Built from a path, as storage and audit do: the web bundler tries to resolve `new URL(…, import.meta.url)`
  // as a module and fails on a folder.
  dir: pathToFileURL(`${import.meta.dirname}/../migrations/`),
};
