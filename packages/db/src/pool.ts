import type { Logger } from "@bodhchakra/log";
import pg from "pg";

/** The connection a transaction runs on. Modules take this, never a pool, so they join the caller's transaction. */
export type DbClient = pg.ClientBase;

export interface DbConfig {
  url: string;
  log: Logger;
  max?: number;
}

export interface Db {
  /** Runs `fn` in one transaction: committed if it resolves, rolled back if it throws. */
  tx<T>(fn: (client: DbClient) => Promise<T>): Promise<T>;
  /**
   * Like `tx`, with `app.business_id` set for the transaction only, which the RLS policies read
   * (docs/architecture.md, 4.2). The setting dies with the transaction, so a pooled connection never carries a
   * tenant into the next one.
   */
  withTenant<T>(businessId: string, fn: (client: DbClient) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createPool(config: DbConfig): Db {
  const pool = new pg.Pool({ connectionString: config.url, max: config.max ?? 10 });
  // An idle connection that dies (Postgres restarted) emits here; without a listener the process would crash.
  // The pool drops that connection and opens a new one on demand.
  pool.on("error", (error) => config.log.error("postgres idle connection failed", { error }));

  async function tx<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    let broken: Error | undefined;
    try {
      await client.query("begin");
      const result = await fn(client);
      await client.query("commit");
      return result;
    } catch (error) {
      // A failed rollback means the connection is unusable: destroy it instead of returning it to the pool.
      // The caller's error is the one that matters, so it is the one rethrown.
      await client.query("rollback").catch((rollbackError: Error) => {
        broken = rollbackError;
      });
      throw error;
    } finally {
      client.release(broken);
    }
  }

  return {
    tx,
    async withTenant(businessId, fn) {
      // An empty or malformed id would only ever see zero rows, but a caller passing one has a bug worth hearing.
      if (!UUID.test(businessId)) throw new Error("withTenant: business id is not a uuid");
      return tx(async (client) => {
        await client.query("select set_config('app.business_id', $1, true)", [businessId]);
        return fn(client);
      });
    },
    end: () => pool.end(),
  };
}
