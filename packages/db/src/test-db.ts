// Throwaway databases for tests against real Postgres: one per test file, created on the dev server, owned by the
// app's owner role, migrated, and dropped afterwards. Uses the DEV convention from infra/postgres/init: every
// role's password, the postgres superuser's included, is its own name. Point the tests at another
// server with TEST_DATABASE_SERVER=host:port.
import { randomBytes } from "node:crypto";
import { createLogger } from "@bodhchakra/log";
import pg from "pg";
import { type MigrationFolder, migrate } from "./migrate.ts";
import { createPool, type Db } from "./pool.ts";

const ROLE = /^[a-z_][a-z0-9_]*$/;

export interface TestDbOptions {
  /** The role that owns the database and runs the migrations, e.g. `kaamkoti_owner`. */
  owner: string;
  folders: readonly MigrationFolder[];
}

export interface TestDb {
  readonly name: string;
  /** A connection string for `role` on this database. */
  url(role: string): string;
  /** A pool connected as `role`; closed by `drop()`. */
  connect(role: string): Db;
  drop(): Promise<void>;
}

export async function testDb(options: TestDbOptions): Promise<TestDb> {
  if (!ROLE.test(options.owner)) throw new Error(`testDb: "${options.owner}" is not a role name`);
  const server = process.env.TEST_DATABASE_SERVER ?? "127.0.0.1:45442";
  const url = (role: string, database: string) => {
    if (!ROLE.test(role)) throw new Error(`testDb: "${role}" is not a role name`);
    return `postgres://${role}:${role}@${server}/${database}`;
  };
  const asSuperuser = async (sql: string) => {
    const client = new pg.Client({ connectionString: url("postgres", "postgres") });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  };

  const name = `test_${randomBytes(6).toString("hex")}`;
  await asSuperuser(`create database ${name} owner ${options.owner}`);
  await migrate(url(options.owner, name), options.folders);

  const log = createLogger({ service: "test-db" });
  const pools: Db[] = [];
  return {
    name,
    url: (role) => url(role, name),
    connect(role) {
      const db = createPool({ url: url(role, name), log, max: 2 });
      pools.push(db);
      return db;
    },
    async drop() {
      await Promise.all(pools.map((db) => db.end()));
      await asSuperuser(`drop database ${name} with (force)`);
    },
  };
}
