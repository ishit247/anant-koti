# @bodhchakra/db

Postgres access for every app and module: a pool with transactions, the tenant context that the RLS policies
read, a migration runner that tracks files by name, and throwaway databases for tests. Layer: core. Design:
[docs/architecture.md](../../docs/architecture.md) sections 2 and 4.2.

## API

| Export                                    | What it does                                                                                                    |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `createPool({ url, log, max? })`          | Returns a `Db`. Idle-connection errors are logged and the pool replaces the connection.                         |
| `db.tx(fn)`                               | Runs `fn(client)` in one transaction: commit if it resolves, rollback and rethrow if it throws.                 |
| `db.withTenant(businessId, fn)`           | Like `tx`, with `app.business_id` set for that transaction only (`set_config(…, true)`). Rejects a non-uuid id. |
| `db.end()`                                | Closes the pool.                                                                                                |
| `DbClient`                                | The client type that module functions take, so they join the caller's transaction.                              |
| `migrate(url, folders, { runtimeRole })`  | Applies every unrecorded file from `folders`, in the order given. Returns the names applied.                    |
| `MigrationFolder`                         | `{ name, dir }`. Each module exports one; the app lists the modules' folders first, then its own.               |
| `testDb({ owner, runtimeRole, folders })` | Creates and migrates a fresh database. Returns `url(role)`, `connect(role)` and `drop()`.                       |

## Rules it enforces

- **Fails closed.** Without `withTenant` the setting is empty, so policies of the form
  `business_id = nullif(current_setting('app.business_id', true), '')::uuid` match no row, and every insert fails.
- **No tenant leaks between requests.** The setting is transaction-local, so a pooled connection never carries
  it into the next transaction (tested).
- **Migrations:** files are named `NNNN_name.sql` and recorded as `<folder>/<file>` in `db.migration`. Each file
  runs in its own transaction together with its record. An advisory lock serialises concurrent runs. Tracking is
  by name only, so while there is no production data a migration is corrected in place (CLAUDE.md).
- **Grants name no role.** A module's migrations serve several databases (`kaamkoti`, `platform`), so `migrate`
  sets the session setting `db.runtime_role`, and every migration grants to it in a `do` block:

  ```sql
  do $$
  declare
    runtime text := current_setting('db.runtime_role');
  begin
    execute format('grant select, insert on audit.event to %I', runtime);
  end $$;
  ```

## Config

Nothing of its own: the app passes the connection string. The owner role's URL is used by `migrate` and seeding,
and the runtime role's URL by the app. `testDb` connects to `TEST_DATABASE_SERVER` (default `127.0.0.1:45442`,
the dev Postgres from `infra/compose.dev.yml`) using the DEV convention that every role's password is its name.

## Tables

`db.migration (name text primary key, applied_at timestamptz)`, created by `migrate` itself.

## Tests

`pnpm --filter @bodhchakra/db test` against the dev Postgres (`pnpm run up` first). Fixture migrations are in
`test/migrations/`.
