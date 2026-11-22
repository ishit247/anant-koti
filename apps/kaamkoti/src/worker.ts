// The worker process (docs/architecture.md 1): the same code as web with no HTTP surface. It runs the jobs and
// delivers the outbox to platform, so a message the web wrote leaves even while no page is being served, and
// waits, retrying, while platform is down. Start: `pnpm --filter kaamkoti worker`.
import { defineConfig } from "@bodhchakra/config";
import { createPool } from "@bodhchakra/db";
import { createJobs } from "@bodhchakra/jobs";
import { createLogger } from "@bodhchakra/log";
import { createNotify } from "@bodhchakra/notify";
import { createOutbox } from "@bodhchakra/outbox";
import { workerConfig } from "./config.ts";
import { createNotices } from "./notices.ts";

const config = defineConfig(workerConfig);
const log = createLogger({ service: "kaamkoti-worker" });
const db = createPool({ url: config.DATABASE_URL, log });
const jobs = createJobs({ url: config.DATABASE_URL, log });
const outbox = createOutbox({ jobs, log });
const notices = createNotices({
  notify: createNotify(outbox),
  jobs,
  appOrigin: config.APP_ORIGIN,
  publicOrigin: config.PUBLIC_ORIGIN,
});

await jobs.start([...outbox.jobTypes, ...notices.jobTypes]);
await notices.startWorking(db);
await outbox.startDelivery(db, {
  url: config.PLATFORM_INTERNAL_URL,
  client: "kaamkoti",
  secret: config.SERVICE_SECRET,
});
log.info("worker started", { platform: config.PLATFORM_INTERNAL_URL });

const shutdown = () => {
  log.info("worker stopping");
  // Jobs first: a delivery in progress finishes on the pool before it closes.
  jobs
    .stop()
    .then(() => db.end())
    .then(
      () => process.exit(0),
      (error: unknown) => {
        log.error("worker shutdown failed", { error });
        process.exit(1);
      },
    );
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
