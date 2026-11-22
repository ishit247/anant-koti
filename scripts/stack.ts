// Development stack: `pnpm run up | down | up:fresh` (never bare `pnpm up`, which updates dependencies).
//   up        start the services (data kept), set up Garage, apply pending migrations
//   down      stop the services (data kept)
//   up:fresh  destroy the volumes, then `up` and seed: every migration from 0001 on an empty database
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { migrate } from "@bodhchakra/db";
import { createLogger } from "@bodhchakra/log";
import * as kaamkoti from "kaamkoti";
import * as platform from "platform";

const COMPOSE_FILE = fileURLToPath(new URL("../infra/compose.dev.yml", import.meta.url));
/** DEV credentials from infra/postgres/init, public in the repository. */
const KAAMKOTI_OWNER_URL = "postgres://kaamkoti_owner:kaamkoti_owner@127.0.0.1:45442/kaamkoti";
const PLATFORM_OWNER_URL = "postgres://platform_owner:platform_owner@127.0.0.1:45442/platform";

const log = createLogger({ service: "stack" });
const compose = (...args: string[]) =>
  execFileSync("docker", ["compose", "-f", COMPOSE_FILE, ...args], {
    stdio: ["ignore", "ignore", "inherit"],
  });

/**
 * Runs the Garage CLI inside its container (one static binary, no shell). Its stderr is connection chatter;
 * it is captured, and a failing command throws with it.
 */
const garage = (...args: string[]) =>
  execFileSync(
    "docker",
    ["compose", "-f", COMPOSE_FILE, "exec", "-T", "garage", "/garage", ...args],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

/**
 * Gives the single node a layout, creates the private bucket and imports the app's web key from its
 * .env.development, with read and write on that bucket only (docs/architecture.md 2). Safe to run repeatedly.
 */
function initGarage() {
  const nodeId = /^([0-9a-f]{16})\s/m.exec(garage("status"))?.[1];
  if (!nodeId) throw new Error("garage: could not read the node id from `garage status`");
  if (!garage("layout", "show").includes(nodeId)) {
    garage("layout", "assign", "-z", "dc1", "-c", "1G", nodeId);
    garage("layout", "apply", "--version", "1");
  }
  if (!garage("bucket", "list").includes(kaamkoti.PRIVATE_BUCKET))
    garage("bucket", "create", kaamkoti.PRIVATE_BUCKET);
  const env = parseEnv(
    readFileSync(new URL("../apps/kaamkoti/.env.development", import.meta.url), "utf8"),
  );
  const keyId = env.S3_ACCESS_KEY_ID;
  const secret = env.S3_SECRET_ACCESS_KEY;
  if (!keyId || !secret)
    throw new Error("garage: S3 key missing from apps/kaamkoti/.env.development");
  if (!garage("key", "list").includes(keyId))
    garage("key", "import", "--yes", "-n", "kaamkoti-web", keyId, secret);
  // `allow` only adds rights; the key never had more than these.
  garage("bucket", "allow", "--read", "--write", kaamkoti.PRIVATE_BUCKET, "--key", keyId);
  log.info("garage ready", { node: nodeId, bucket: kaamkoti.PRIVATE_BUCKET });
}

async function up() {
  compose("up", "-d", "--wait");
  initGarage();
  for (const [database, url, app] of [
    ["kaamkoti", KAAMKOTI_OWNER_URL, kaamkoti],
    ["platform", PLATFORM_OWNER_URL, platform],
  ] as const) {
    const applied = await migrate(url, app.migrations, { runtimeRole: app.RUNTIME_ROLE });
    log.info("migrations applied", { database, count: applied.length, applied });
  }
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
    await kaamkoti.seed(KAAMKOTI_OWNER_URL, log);
    log.info("seeded", { database: "kaamkoti", businesses: 2, members: 4, customers: 6, jobs: 5 });
    await platform.seed(PLATFORM_OWNER_URL, log);
    log.info("seeded", { database: "platform", identities: 4 });
    break;
  default:
    console.error("usage: node scripts/stack.ts up|down|fresh");
    process.exit(2);
}
log.info(`stack ${command} done`, { seconds: Number(((Date.now() - started) / 1000).toFixed(1)) });
