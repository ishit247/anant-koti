// Schema migrations: plain SQL files, applied folder by folder in the order given (modules in dependency order,
// then the app), each folder's files in name order. Tracked by name only, as `<folder>/<file>`, in db.migration.
// Name-only tracking is deliberate while there is no production data: a migration corrected in place re-applies
// cleanly on a fresh database (CLAUDE.md, "Development phase").
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";

/** One module's (or the app's) migrations directory. `name` prefixes every recorded file name. */
export interface MigrationFolder {
  readonly name: string;
  readonly dir: URL;
}

interface Migration {
  readonly name: string;
  readonly sql: string;
}

const FILE_NAME = /^\d{4}_[a-z0-9_]+\.sql$/;
const FOLDER_NAME = /^[a-z][a-z0-9-]*$/;
/** Serialises concurrent runs (two deploys, or a deploy and a test) on the same database. */
const ADVISORY_LOCK_KEY = 7_302_118;

async function load(folders: readonly MigrationFolder[]): Promise<Migration[]> {
  const seen = new Set<string>();
  const migrations: Migration[] = [];
  for (const folder of folders) {
    if (!FOLDER_NAME.test(folder.name))
      throw new Error(`migration folder name "${folder.name}" is invalid`);
    if (seen.has(folder.name)) throw new Error(`migration folder "${folder.name}" is listed twice`);
    seen.add(folder.name);
    const files = (await readdir(folder.dir)).filter((file) => file.endsWith(".sql")).sort();
    const misnamed = files.filter((file) => !FILE_NAME.test(file));
    if (misnamed.length > 0) {
      throw new Error(
        `${folder.name}: migration files must be named NNNN_name.sql: ${misnamed.join(", ")}`,
      );
    }
    for (const file of files) {
      migrations.push({
        name: `${folder.name}/${file}`,
        sql: await readFile(new URL(file, folder.dir), "utf8"),
      });
    }
  }
  return migrations;
}

export interface MigrateOptions {
  /**
   * The database's runtime role (e.g. `kaamkoti_app`). Module migrations serve more than one database, so they
   * cannot name it; they read it from the session setting `db.runtime_role` and grant to it in a `do` block.
   */
  runtimeRole: string;
}

const ROLE = /^[a-z_][a-z0-9_]*$/;

/**
 * Applies every migration not yet recorded. Each runs in its own transaction together with its record, so a
 * failure leaves the earlier ones applied and nothing at all of the failing one. Returns the names applied.
 * `url` must connect as the database's owner role.
 */
export async function migrate(
  url: string,
  folders: readonly MigrationFolder[],
  options: MigrateOptions,
): Promise<string[]> {
  if (!ROLE.test(options.runtimeRole))
    throw new Error(`migrate: "${options.runtimeRole}" is not a role name`);
  const migrations = await load(folders);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);
    await client.query("select set_config('db.runtime_role', $1, false)", [options.runtimeRole]);
    await client.query(
      `create schema if not exists db;
       create table if not exists db.migration (name text primary key, applied_at timestamptz not null default now())`,
    );
    const { rows } = await client.query<{ name: string }>("select name from db.migration");
    const recorded = new Set(rows.map((row) => row.name));
    const applied: string[] = [];
    for (const migration of migrations) {
      if (recorded.has(migration.name)) continue;
      await client.query("begin");
      try {
        await client.query(migration.sql);
        await client.query("insert into db.migration (name) values ($1)", [migration.name]);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw new Error(`migration ${migration.name} failed: ${(error as Error).message}`, {
          cause: error,
        });
      }
      applied.push(migration.name);
    }
    return applied;
  } finally {
    // Ending the session releases the advisory lock.
    await client.end();
  }
}
