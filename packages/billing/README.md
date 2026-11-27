# @bodhchakra/billing

What a business pays the platform, by subscription (docs/architecture.md 13; D6, D9, D12). Layer: domain. The
server side lives in `services/platform/src/billing.ts`: the billing account (one per identity, so one bill
across products), one subscription per product tenant, a Razorpay Subscriptions checkout on the platform's own
account, and the verified webhook, which is the only thing that moves the status. The app keeps a local copy,
sent to it as signed events. 5.1b adds the app's side here: that copy, `live` computed at request time, and
the checkout call.

## The contract

| Export                                                        | What it is                                                                                                                                                                                          |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PLANS`, `Plan`, `MAX_SEATS`                                  | `solo` (one seat) and `team` (per seat). Prices live in the Razorpay plans (D9).                                                                                                                    |
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
