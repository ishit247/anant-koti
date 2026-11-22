import { readFile } from "node:fs/promises";
import { migrations as audit } from "@bodhchakra/audit";
import { createPool, type MigrationFolder } from "@bodhchakra/db";
import { migrations as jobs } from "@bodhchakra/jobs";
import type { Logger } from "@bodhchakra/log";
import { migrations as outbox } from "@bodhchakra/outbox";

// For apps' tests that sign in against a real platform in process (apps/kaamkoti/test/sign-in.test.ts).
export { CLIENT_IP_HEADER, createIdentity, registerClients } from "./identity.ts";
export { createHandler, listen } from "./server.ts";

/** The role the platform container connects as (docs/architecture.md, section 2); migrations grant to it. */
export const RUNTIME_ROLE = "platform_app";

/** better-auth's tables (src/identity.ts); platform's own, so the folder lives here and not in a module. */
const identity: MigrationFolder = {
  name: "identity",
  dir: new URL("../migrations/identity/", import.meta.url),
};

/** notify.message (src/notify.ts); platform's own, like identity. */
const notify: MigrationFolder = {
  name: "notify",
  dir: new URL("../migrations/notify/", import.meta.url),
};

/** Every migration folder the platform database needs, in dependency order. */
export const migrations: readonly MigrationFolder[] = [audit, jobs, outbox, identity, notify];

/** Loads the development seed. `url` connects as the database's owner role. */
export async function seed(url: string, log: Logger): Promise<void> {
  const sql = await readFile(new URL("../seed.sql", import.meta.url), "utf8");
  const db = createPool({ url, log, max: 1 });
  try {
    await db.tx((client) => client.query(sql));
  } finally {
    await db.end();
  }
}
