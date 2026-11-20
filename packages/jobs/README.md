# @bodhchakra/jobs

Background jobs on [pg-boss](https://github.com/timgit/pg-boss) 12. Layer: core. Design:
[docs/architecture.md](../../docs/architecture.md) section 12.

## API

| Export                                              | What it does                                                                                                                                                               |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defineJob(name, schema, { retry, deadLetter? })`   | A job type: dotted lower-case name, Zod payload schema, retry policy, optional dead-letter job type.                                                                       |
| `createJobs({ url, log, pollingIntervalSeconds? })` | A `Jobs` instance on its own small pool, connected as the runtime role.                                                                                                    |
| `jobs.start(types)`                                 | Starts pg-boss and creates the queues, then applies each type's policy (`updateQueue`). Call once.                                                                         |
| `jobs.send(client, type, payload)`                  | Queues a job **on the caller's transaction**: it exists only if that transaction commits.                                                                                  |
| `jobs.work(type, handler)`                          | Runs `handler(payload, { id, retryCount })` one job at a time. The stored payload is parsed with the schema first. A throw fails the attempt, which is logged and retried. |
| `jobs.stop()`                                       | Lets running jobs finish, then closes the pool.                                                                                                                            |
| `migrations`                                        | The pg-boss schema and the runtime role's rights.                                                                                                                          |

`sendAt` (a job that starts later) joins with its first use, appointment reminders in phase 3.

## Rules it enforces

- **The runtime role runs no DDL.** The schema is installed by `migrations/0001_pgboss.sql`, run as the owner.
  pg-boss starts with `migrate: false`, `createSchema: false` and `reindex: false`, and refuses to start if the
  installed schema version is not the one it expects. Queues are never partitioned, so creating a queue is an
  `INSERT`. A test proves the runtime role cannot create, drop or truncate in `pgboss`.
- **`0001_pgboss.sql` is generated:** pg-boss's `getConstructionPlans('pgboss')`, without its own `BEGIN` and
  `COMMIT` so that the migrator's transaction covers it. A test fails if it drifts from the installed pg-boss.
  To upgrade pg-boss: until the first real tenant, regenerate the file; after that, add pg-boss's
  `getMigrationPlans` as a new file, followed by the grants from `0002_grant.sql` again.
- A dead-letter type must be passed to `start` too. It is created before the types that name it.

## Tables

The `pgboss` schema (pg-boss's own). The runtime role has select, insert, update and delete on its tables, and no
truncate.

## Tests

`pnpm --filter @bodhchakra/jobs test` against the dev Postgres. The tests take about 4 s, because they wait for
real retries.
