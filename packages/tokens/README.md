# @bodhchakra/tokens

Signed service requests between an app and `platform` (section 9.1), and scoped, expiring, revocable links
(section 7; `tokens.token`). Layer: core. Design: [docs/architecture.md](../../docs/architecture.md). Used for
technician invites (tenancy). Customers sign in instead of holding a link (D15).

## API

| Export                    | What it does                                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signRequest(input)`      | `{ client, secret, method, path, body, now? }` → the three headers that authenticate the request.                                                                               |
| `verifyRequest(input)`    | `{ method, path, headers, body, secretFor, now? }` → `{ ok: true, client }` or `{ ok: false, reason }`.                                                                         |
| `issue(client, link)`     | Inside `withTenant`: stores a link (`purpose`, `businessId`, `subjectId`, `expiresAt`) and returns `{ id, secret }`. The secret is 32 random bytes; only its SHA-256 is stored. |
| `resolve(client, secret)` | No tenant needed: the live link (not revoked, not expired) or `null`. Malformed secrets are `null` without a query.                                                             |
| `revoke(client, id)`      | Inside `withTenant`: ends the link now.                                                                                                                                         |
| `migrations`              | The `tokens` schema; an app lists it before tenancy.                                                                                                                            |
| `CLIENT_HEADER`, …        | Header names `x-bc-client`, `x-bc-timestamp`, `x-bc-signature`.                                                                                                                 |
| `MAX_SKEW_SECONDS`        | 300: how far the timestamp may be from the receiver's clock, either way.                                                                                                        |
| `MIN_SECRET_LENGTH`       | 43 characters (32 random bytes as base64url). Shorter secrets are refused when signing and in platform's config.                                                                |

`reason` (`malformed`, `unknown_client`, `expired`, `bad_signature`) is for logs. Callers answer every failure
with the same 401.

## Rules it enforces

- The signature is HMAC-SHA256 over `client`, method, path with query, timestamp and the body's SHA-256. Changing
  any of them, or reusing a signature for another path, fails verification.
- A request more than five minutes old, or more than five minutes ahead, is refused.
- Signatures are compared in constant time.
- A link opens only while it is neither revoked nor past `expires_at`; a malformed secret is refused without a query.
- A secret cannot be recovered from its hash. What a link permits is the caller's decision from the subject's
  state.
- A request can be replayed inside the five-minute window. Outbox deliveries are idempotent at the receiver
  (`outbox.receive`), so a replay takes effect only once. Any future synchronous call that changes state must be
  idempotent too.

## Config

None of its own. The caller holds the secret: the app's worker for its outbox target, and platform's
`SERVICE_CLIENTS` for the receiving side.

## Tests

`pnpm --filter @bodhchakra/tokens test`. Request signing needs no database; `test/link.test.ts` runs against real
Postgres (issue, resolve, expiry, revoke, tenant isolation). Invites are tested in tenancy.
