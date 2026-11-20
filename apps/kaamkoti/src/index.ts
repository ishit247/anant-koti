import { readFile } from "node:fs/promises";
import { createPool, type MigrationFolder } from "@bodhchakra/db";
import type { Logger } from "@bodhchakra/log";
import { migrations as tenancy } from "@bodhchakra/tenancy";

/** Every migration folder the Kaam Koti database needs: modules in dependency order, then the app's own. */
export const migrations: readonly MigrationFolder[] = [
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
