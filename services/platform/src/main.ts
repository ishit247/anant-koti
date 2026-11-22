// The platform container's entry point. Migrations are run by the deploy (and by `pnpm run up` in development),
// as platform_owner; this process connects only as platform_app.
import { createAudit } from "@bodhchakra/audit";
import { defineConfig } from "@bodhchakra/config";
import { createPool } from "@bodhchakra/db";
import { createJobs } from "@bodhchakra/jobs";
import { createLogger } from "@bodhchakra/log";
import { NOTIFY_TOPIC } from "@bodhchakra/notify";
import { redisLimiter } from "@bodhchakra/rate-limit";
import pg from "pg";
import { platformConfig } from "./config.ts";
import { createIdentity, registerClients } from "./identity.ts";
import { codeMailer, emailSender } from "./mail.ts";
import { createNotifyService } from "./notify.ts";
import { createHandler, listen } from "./server.ts";
import { whatsappSender } from "./whatsapp.ts";

const config = defineConfig(platformConfig);
const log = createLogger({ service: "platform" });
const db = createPool({ url: config.DATABASE_URL, log });
// better-auth takes a pg pool of its own; same role and database.
const identityPool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 5 });
identityPool.on("error", (error) => log.error("postgres idle connection failed", { error }));
const limiter = redisLimiter(config.REDIS_URL, log);

const sendCode = codeMailer(emailSender(config.SMTP_URL, config.EMAIL_FROM));
const jobs = createJobs({ url: config.DATABASE_URL, log });
const notify = createNotifyService({
  db,
  jobs,
  log,
  audit: createAudit(log),
  sendEmail: emailSender(config.SMTP_URL, config.NOTIFY_EMAIL_FROM),
  ...(config.whatsapp && {
    whatsapp: {
      send: whatsappSender(config.whatsapp),
      appSecret: config.whatsapp.appSecret,
      verifyToken: config.whatsapp.verifyToken,
      monthlyQuota: config.whatsapp.monthlyQuota,
    },
  }),
});
// Development has no Meta account (D7): the channel is off until its settings are given.
log.info("notify channels", { whatsapp: config.whatsapp !== undefined });
await jobs.start(notify.jobTypes);
await notify.startSending();

await registerClients(identityPool, config.SIGN_IN_CLIENTS);
const identity = createIdentity(
  {
    pool: identityPool,
    origin: config.IDENTITY_ORIGIN,
    secret: config.IDENTITY_SECRET,
    limit: limiter.limit,
    sendCode,
  },
  log,
);

const server = await listen(
  createHandler({
    db,
    log,
    clients: config.SERVICE_CLIENTS,
    topics: { [NOTIFY_TOPIC]: notify.topic },
    identity,
    hooks: notify.hooks,
  }),
  log,
  config.PORT,
);
log.info("platform listening", { port: config.PORT, clients: Object.keys(config.SERVICE_CLIENTS) });

const shutdown = () => {
  log.info("platform stopping");
  server.close(() => {
    // Jobs first: a send in progress finishes on the pool before it closes.
    jobs
      .stop()
      .then(() => Promise.all([db.end(), identityPool.end(), limiter.close()]))
      .then(
        () => process.exit(0),
        (error: unknown) => {
          log.error("closing the database pool failed", { error });
          process.exit(1);
        },
      );
  });
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
