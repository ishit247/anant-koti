import { readFile } from "node:fs/promises";
import { migrations as audit } from "@bodhchakra/audit";
import { createPool, type MigrationFolder } from "@bodhchakra/db";
import { migrations as jobs } from "@bodhchakra/jobs";
import type { Logger } from "@bodhchakra/log";
import { migrations as outbox } from "@bodhchakra/outbox";
import { migrations as tenancy } from "@bodhchakra/tenancy";

/** The role web and worker connect as (docs/architecture.md, section 2); migrations grant to it. */
export const RUNTIME_ROLE = "kaamkoti_app";

/** Every migration folder the Kaam Koti database needs: modules in dependency order, then the app's own. */
export const migrations: readonly MigrationFolder[] = [
  audit,
  jobs,
  outbox,
  tenancy,
  { name: "kaamkoti", dir: new URL("../migrations/", import.meta.url) },
];

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
