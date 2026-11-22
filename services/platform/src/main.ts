// The platform container's entry point. Migrations are run by the deploy (and by `pnpm run up` in development),
// as platform_owner; this process connects only as platform_app.
import { defineConfig } from "@bodhchakra/config";
import { createPool } from "@bodhchakra/db";
import { createLogger } from "@bodhchakra/log";
import { redisLimiter } from "@bodhchakra/rate-limit";
import pg from "pg";
import { platformConfig } from "./config.ts";
import { createIdentity, registerClients } from "./identity.ts";
import { codeMailer } from "./mail.ts";
import { createHandler, listen } from "./server.ts";

const config = defineConfig(platformConfig);
const log = createLogger({ service: "platform" });
const db = createPool({ url: config.DATABASE_URL, log });
// better-auth takes a pg pool of its own; same role and database.
const identityPool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 5 });
identityPool.on("error", (error) => log.error("postgres idle connection failed", { error }));
const limiter = redisLimiter(config.REDIS_URL, log);

const sendCode = codeMailer(config.SMTP_URL, config.EMAIL_FROM);

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

// No topics yet: the first, notify.send, arrives with step 3.2. Until then every internal call is answered 404
// after its signature is checked.
const server = await listen(
  createHandler({ db, log, clients: config.SERVICE_CLIENTS, topics: {}, identity }),
  log,
  config.PORT,
);
log.info("platform listening", { port: config.PORT, clients: Object.keys(config.SERVICE_CLIENTS) });

const shutdown = () => {
  log.info("platform stopping");
  server.close(() => {
    Promise.all([db.end(), identityPool.end(), limiter.close()]).then(
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
