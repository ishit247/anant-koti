# @bodhchakra/billing

What a business pays the platform, by subscription (docs/architecture.md 13; D6, D9, D12). Layer: domain. The
server side lives in `services/platform/src/billing.ts`: the billing account (one per identity, so one bill
across products), one subscription per product tenant, a Razorpay Subscriptions checkout on the platform's own
account, and the verified webhook, which is the only thing that moves the status. The app keeps a local copy,
sent to it as signed events; that side lives here (`src/app.ts`, `migrations/0001_status.sql`), and
`src/contract.ts` is what both sides parse.

## The app's side

| Export                                                                  | What it is                                                                                                                                                                  |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `migrations`                                                            | `billing.status`, one row per business, RLS by business, never deleted by the runtime role. List it after `outbox`.                                                         |
| `createBillingClient`                                                   | `{ db, log, outbox, platformUrl, client, secret }`. The secret is the app's entry in platform's `SERVICE_CLIENTS`: it signs the checkout call and checks platform's events. |
| `.startTrial(client, ids)`                                              | In the signup transaction (inside `withTenant`): writes the copy (Team, one seat, `TRIAL_DAYS` = 14, version 1) and queues `billing.register` with the same trial end.      |
| `.checkout(request)`                                                    | The answered call: `{ url }`, platform's `{ error }`, or `{ error: { code: "unavailable" } }` when platform is down or answers anything else.                               |
| `.receiveStatus(request)`                                               | Mount at `STATUS_EVENTS_PATH`. 401 unless signed as client `platform`; each delivery key once; applied only if its version is newer.                                        |
| `subscriptionOf(client, { lock? })`, `Subscription`                     | The open business's copy. Throws if there is none: every business has one from signup. `lock` holds the row to the transaction's end, so takers against a limit queue.      |
| `isLive(subscription, now)`, `GRACE_DAYS`                               | `now < trialEndsAt or now < paidThrough + 3 days`, whatever the status (architecture 13).                                                                                   |
| `assertWithin(subscription, limit, used)`, `LimitReached`, `LimitError` | Throws `LimitReached` unless one more fits; its `error` is the one edge shape `{ code: "limit", limit, plan }`. Count `used` after taking the lock.                         |

## The contract

| Export                                                        | What it is                                                                                                                                                                                          |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PLANS`, `Plan`, `MAX_SEATS`                                  | `solo` (one seat) and `team` (per seat). Prices live in the Razorpay plans (D9).                                                                                                                    |
| `limitsOf(subscription)`, `Limits`, `TRIAL_SEATS`             | `{ seats, whatsapp }`: seats are `TRIAL_SEATS` (10) while `trialing`, else the plan's (D20); WhatsApp a month is Solo 200, Team 500 + 100 per seat (D18). Both sides compute it, nothing is stored. |
| `REGISTER_TOPIC`, `registration`                              | App → platform through the outbox: `{ tenantId, identityId, trialEndsAt }`. Opens a Team trial; the app has already written its own copy with the same date, so no event comes back.                |
| `CHECKOUT_CALL`, `checkoutRequest`, `checkoutAnswer`          | App → platform, a signed call answered at once: `{ tenantId, identityId, plan, seats }` → `{ url }`, or `{ error: { code } }` with `unknown_tenant` (404), `not_payer` (403) or `subscribed` (409). |
| `STATUS_CHANGED_TOPIC`, `statusChanged`, `STATUSES`, `Status` | Platform → app through platform's outbox: `{ tenantId, plan, seats, status, trialEndsAt, paidThrough, version }`. Apply it only if `version` is newer than the copy.                                |

## Rules the platform side enforces

- **Status moves only from Razorpay's verified webhook** (`/hooks/razorpay`, `X-Razorpay-Signature` under the
  platform account's webhook secret). Making a checkout changes nothing the app sees.
- **Each event takes effect once, in Razorpay's order.** The inbox key is the SHA-256 of the signed body (the
  signature has no timestamp); an event made before the last one applied is ignored, so a late `pending` cannot
  undo a newer `charged`. Paid time only moves forward.
- **Only the newest checkout can be paid.** A new checkout cancels an earlier one never authorised; webhooks
  about any subscription but the current one are ignored. An authorised, uncancelled subscription refuses a new
  checkout.
- **Only the payer checks out**: the account's identity, checked by platform as well as the app.
- **Every change is one outbox event and one strict audit row**, in the transaction that made it.
- The runtime role may not delete subscriptions or change an account's identity (revoked, tested).
