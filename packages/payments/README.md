# @bodhchakra/payments

Customer payments to a business (docs/architecture.md 8; D5). Layer: domain. Razorpay first; Stripe, when the
product goes global, is a second adapter beside `src/razorpay.ts`. Money goes straight to the business's own
Razorpay account, never through us.

## API

| Export                                       | What it does                                                                                                                                                                                                           |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createPayments({ sealingKey, audit, log })` | The module. `sealingKey` is 32 bytes, base64, from config; a wrong one stops start-up.                                                                                                                                 |
| `connectAccount(client, …)`                  | Inside `withTenant`: stores the business's key id, key secret and webhook secret (secrets sealed); replaces earlier ones.                                                                                              |
| `createPaymentLink(client, …)`               | Inside `withTenant`: a link for `(subjectId, purpose)` (e.g. a job's `deposit`), or the open one already made. At least 100 minor units. Part-payments if `acceptPartial`; `returnUrl` is where the payer lands after. |
| `connectedAccount(client, businessId)`       | The connected key id, or null; never a secret.                                                                                                                                                                         |
| `cancelLink(client, { businessId, linkId })` | Cancels an open link at Razorpay, then here.                                                                                                                                                                           |
| `linksFor(client, subjectId)`                | A subject's links, newest first.                                                                                                                                                                                       |
| `paidFor(client, subjectId, currency)`       | Everything received for a subject, online and cash.                                                                                                                                                                    |
| `recordManual(client, …)`                    | A cash payment a member took.                                                                                                                                                                                          |
| `handleWebhook(db, request, onEvent)`        | The webhook route's whole job → `"applied" \| "duplicate" \| "ignored"`, or `"refused"` (answer 401; an outcome, not an exception). `onEvent` runs in the recording transaction.                                       |
| `signRazorpayWebhook(body, secret)`          | What Razorpay does; for tests and the seed.                                                                                                                                                                            |
| `migrations`                                 | `payments/0001_payments.sql`; list it after `audit` and `outbox`.                                                                                                                                                      |

## Rules it enforces

- **Paid comes only from a verified webhook.** Creating a link records nothing; no redirect or API reply is read
  as payment. The webhook URL carries the business id; the raw body's HMAC-SHA256 (`X-Razorpay-Signature`) must
  verify under that business's webhook secret, compared in constant time.
- **Each event takes effect once.** Razorpay's signature has no timestamp, and its event-id header is not signed,
  so the inbox key (`outbox.inbox`, source `razorpay`) is the SHA-256 of the signed body, and a payment is unique
  per business by its Razorpay id. A replay, with any headers, is acknowledged and changes nothing.
- **A business reaches only its own rows.** The link is looked up under RLS of the URL's business, so a verified
  event naming another business's link is ignored.
- **The link's status follows from recorded payments**, summed under a row lock, never from the event's claim. A
  payment beyond the link's amount, or in another currency, is refused and rolls back.
- **Recorded payments never change**: the runtime role may only insert and select them (revoked, tested). Every
  payment is audited with `recordStrict`, so a payment that cannot be audited is not written.
- **Secrets are sealed** with AES-256-GCM; the associated data is the business id and field, so a sealed value
  copied to another row does not open.
- The provider call that creates a link runs inside the caller's transaction. If that rolls back, the link stays
  at Razorpay, unseen: its URL was only in the rolled-back row and Razorpay sends no messages for it
  (`notify` off; ours go through `notify`).
