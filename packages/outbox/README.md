# @bodhchakra/outbox

The one way a service tells another: a transactional outbox, signed delivery and an idempotent inbox. Layer: core.
Design: [docs/architecture.md](../../docs/architecture.md) section 9.1.

## API

| Export                                        | What it does                                                                                                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createOutbox({ jobs, log, retry? })`         | Returns `{ jobTypes, enqueue, startDelivery }`. `retry` defaults to `DELIVERY_RETRY`; tests shorten it.                                                       |
| `outbox.jobTypes`                             | Pass these to `jobs.start`.                                                                                                                                   |
| `outbox.enqueue(client, topic, payload, key)` | Writes `outbox.message` and its delivery job on the caller's transaction. A repeated key is a no-op.                                                          |
| `outbox.startDelivery(db, target)`            | In the worker: POSTs each message, signed, to `<target.url>/internal/v1/<topic>`, and marks it delivered on a 2xx.                                            |
| `receive(client, source, key, handle)`        | Receiver side: records `(source, key)` in `outbox.inbox` and runs `handle` on the same transaction, only if the pair is new. Returns `false` for a duplicate. |
| `delivery`                                    | Zod schema of the body, `{ key, payload }`; the receiver parses with it.                                                                                      |
| `DELIVERY_RETRY`                              | 30 s doubling to an hourly cap, 31 retries: dead-lettered about 24 hours after the message was written.                                                       |
| `migrations`                                  | List after `jobs`.                                                                                                                                            |

## Rules it enforces

- **Written with the business change, or not at all.** The message and its job commit or roll back with the
  caller's transaction.
- **Exactly-once effect.** Delivery is at least once: a failed POST or a lost `delivered_at` update means
  another attempt. The receiver's inbox key makes the repeat a no-op. If the handler throws, the inbox row
  rolls back with it, so a redelivery is handled.
- **The key is signed.** It travels inside the body, which the signature covers.
- **Receiver down means delay, not loss.** Attempts back off for about a day. After that the `outbox.dead` job
  logs `outbox: message undeliverable after all retries` with the message id: that log line is the alert. The
  row stays in `outbox.message` with `delivered_at` null, to be redriven.
- Logs carry message ids and topics, never payloads.

## Tables

`outbox.message`: `id`, `topic`, `idempotency_key` (unique), `payload` (jsonb object), `created_at`,
`delivered_at`. Partial index on undelivered rows. The runtime role may select, insert and update; delete and
truncate are revoked.

`outbox.inbox`: primary key (`source`, `idempotency_key`), `received_at`. The runtime role may select and insert.

Neither table has RLS: they belong to the process, not to a tenant. A payload carries the business id it
concerns.

## Tests

`pnpm --filter @bodhchakra/outbox test`. End-to-end delivery against a real receiver that goes down and comes
back is tested in `services/platform`.
