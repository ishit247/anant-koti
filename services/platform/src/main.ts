// The platform container's entry point. Migrations are run by the deploy (and by `pnpm run up` in development),
// as platform_owner; this process connects only as platform_app.
import { defineConfig } from "@bodhchakra/config";
import { createPool } from "@bodhchakra/db";
import { createLogger } from "@bodhchakra/log";
import { platformConfig } from "./config.ts";
import { createHandler, listen } from "./server.ts";

const config = defineConfig(platformConfig);
const log = createLogger({ service: "platform" });
const db = createPool({ url: config.DATABASE_URL, log });

// No topics yet: the first, notify.send, arrives with step 3.2. Until then every internal call is answered 404
// after its signature is checked.
const server = await listen(
  createHandler({ db, log, clients: config.SERVICE_CLIENTS, topics: {} }),
  log,
  config.PORT,
);
log.info("platform listening", { port: config.PORT, clients: Object.keys(config.SERVICE_CLIENTS) });

const shutdown = () => {
  log.info("platform stopping");
  server.close(() => {
    db.end().then(
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
