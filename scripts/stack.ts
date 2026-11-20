// Development stack: `pnpm run up | down | up:fresh` (never bare `pnpm up`, which updates dependencies).
//   up        start the services (data kept), apply pending migrations
//   down      stop the services (data kept)
//   up:fresh  destroy the volumes, then `up` and seed: every migration from 0001 on an empty database
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { migrate } from "@bodhchakra/db";
import { createLogger } from "@bodhchakra/log";
import { migrations, RUNTIME_ROLE, seed } from "kaamkoti";

const COMPOSE_FILE = fileURLToPath(new URL("../infra/compose.dev.yml", import.meta.url));
/** DEV credentials from infra/postgres/init, public in the repository. */
const KAAMKOTI_OWNER_URL = "postgres://kaamkoti_owner:kaamkoti_owner@127.0.0.1:45442/kaamkoti";

const log = createLogger({ service: "stack" });
const compose = (...args: string[]) =>
  execFileSync("docker", ["compose", "-f", COMPOSE_FILE, ...args], {
    stdio: ["ignore", "ignore", "inherit"],
  });

async function up() {
  compose("up", "-d", "--wait");
  const applied = await migrate(KAAMKOTI_OWNER_URL, migrations, { runtimeRole: RUNTIME_ROLE });
  log.info("migrations applied", { database: "kaamkoti", count: applied.length, applied });
}

const command = process.argv[2];
const started = Date.now();
switch (command) {
  case "up":
    await up();
    break;
  case "down":
    compose("down");
    break;
  case "fresh":
    compose("down", "-v");
    await up();
    await seed(KAAMKOTI_OWNER_URL, log);
    log.info("seeded", { database: "kaamkoti", businesses: 2, members: 4, customers: 6 });
    break;
  default:
    console.error("usage: node scripts/stack.ts up|down|fresh");
    process.exit(2);
}
log.info(`stack ${command} done`, { seconds: Number(((Date.now() - started) / 1000).toFixed(1)) });
