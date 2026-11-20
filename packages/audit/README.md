# @bodhchakra/audit

The append-only audit log. Layer: core. Design: [docs/architecture.md](../../docs/architecture.md) section 11.
It has no foreign key to `tenancy`, so the platform database can use it too.

## API

| Export                        | What it does                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `createAudit(log)`            | Returns `{ record, recordStrict }`.                                                                                |
| `record(client, event)`       | Inserts inside a savepoint. On failure it rolls back to the savepoint, logs an error, and the caller's work stays. |
| `recordStrict(client, event)` | Inserts with no savepoint: a failure aborts the caller's transaction. For money events only.                       |
| `AuditEvent`, `Actor`         | `{ businessId, actor, action, entity, entityId, data? }`; `actor` is `{ kind: "system" }` or a kind with an `id`.  |
| `migrations`                  | The module's `MigrationFolder`.                                                                                    |

Call both inside `withTenant` of the event's business: RLS refuses an event for any other.

## Rules it enforces

- **Append-only.** The runtime role has insert and select; update, delete and truncate are revoked (tested).
- **No personal data.** `data` holds ids and amounts only. Names, phones and free text never go in.
- `action` is dotted lower-case (`payment.recorded`); a system actor has no id, every other actor has one.

## Tables

`audit.event`: `id`, `business_id`, `actor_kind` (`member`, `customer`, `system`, `platform`), `actor_id`,
`action`, `entity`, `entity_id`, `data` (jsonb object), `at`. Index (`business_id`, `at`).

## Tests

`pnpm --filter @bodhchakra/audit test` against the dev Postgres.
