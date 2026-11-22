# @bodhchakra/notify

The app's side of notify (docs/architecture.md 9.2). A message is written to the outbox in the business
transaction and delivered to platform's `notify.send` topic, where the channel is chosen, the template rendered
and the send retried. The server side lives in `services/platform/src/notify.ts`.

| Export                 | What it does                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------- |
| `createNotify(outbox)` | Returns `{ send(client, message, key) }`. Queues one message on the caller's transaction, once per key. |
| `notifyMessage`        | The Zod schema of a message; platform parses every delivery with it.                                    |
| `NOTIFY_TOPIC`         | `notify.send`.                                                                                          |

A message is `{ businessId, template, to: { email?, phone? }, vars }`. The product is the signed client id, so an
app reaches only its own templates. `vars` are display strings the app has formatted; templates only place them.

## Tables

None of its own: `outbox.message` on the app's side, `notify.message` on platform's.
