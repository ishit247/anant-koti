# platform

The shared container: identity (0.6), billing (5.x) and notify (3.2). Design:
[docs/architecture.md](../../docs/architecture.md) sections 1, 2, 3 and 9.1.

## Routes

| Route                                   | Who calls it                 | What it does                                                                                                                                                        |
| --------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                           | Docker health check          | 200 while the database answers, otherwise 503.                                                                                                                      |
| `POST /internal/v1/<topic>`             | Apps' outbox workers, signed | Verifies the signature (401), finds the topic (404), parses `{ key, payload }` (400), then handles it once through `outbox.receive` (200 `handled` or `duplicate`). |
| `GET /.well-known/openid-configuration` | Apps                         | OpenID Connect discovery; `issuer` is `IDENTITY_ORIGIN`.                                                                                                            |
| `GET /sign-in`                          | Browsers, sent by authorize  | The sign-in page: email, then a 6-digit code.                                                                                                                       |
| `/api/auth/*`                           | Browsers and apps            | better-auth, limited to the `ROUTES` list in `src/identity.ts`: authorize, token, end-session, jwks, send code, sign in with code, error. Anything else is 404.     |

Topics: `notify.send` (below). Bodies over 64 KB are refused (413).

## Notify

- `src/notify.ts`: `notify.send` records the message in `notify.message` and queues its `notify.deliver` job in
  the inbox's transaction. The job renders the product's template (`src/templates/<product>.ts`, the product
  being the signed client id) and sends it by email; WhatsApp joins in 3.3. Ten attempts over about four hours,
  then `failed` and an error log. A message with no email is `no_channel`.
- Each outcome is an `audit.event` (`notify.sent`, `notify.failed`, `notify.no_channel`). Logs carry the message
  id, template and nodemailer's error code; never the recipient, the variables or the provider's text.
- Sign-in codes do not go through it: they are mailed directly (`src/mail.ts`), because a code waiting for a
  retry is useless.

## Identity

- better-auth with `@better-auth/oauth-provider` and `jwt`, in `src/identity.ts` only. Its tables live in the
  `identity` schema. `migrations/identity/0001_identity.sql` is **generated** from the options in that file
  (`node scripts/identity-sql.ts`); a test fails if it drifts. Until the first real tenant, a better-auth upgrade
  regenerates it.
- Sign-in clients come from `SIGN_IN_CLIENTS` and are written to `identity."oauthClient"` at start-up: first
  party (no consent), confidential (`client_secret_basic`), PKCE required. A client dropped from config is
  disabled, not deleted.
- The ID token carries `name` and the verified addresses only: `email` and `email_verified`, `phone_number`
  and `phone_number_verified` (scope `phone`), so an app needs no userinfo call. It lives 5 minutes, and a code
  lives 60 seconds.
- Codes: 6 digits, 10 minutes, 5 attempts, stored as an HMAC under `IDENTITY_SECRET`. At most 5 codes an hour
  to one address, plus per-IP limits, counted in Redis. The client IP comes from `x-client-ip`, which the proxy
  sets.
- Sign-in by mobile (Indian numbers) needs the WhatsApp channel below; without it `/api/auth/phone-code/send`
  answers 503 and the page asks for an email. Its codes are in `identity.phone_code`, not better-auth's
  verification table. A mobile's identity gets the placeholder email `<digits>@phone.invalid`.
- Redirect URIs must be HTTPS, except loopback ones while platform itself runs on plain HTTP on loopback
  (development).

## Config

| Variable            | Meaning                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`      | `platform` database as `platform_app`.                                                                     |
| `PORT`              | Default 3000.                                                                                              |
| `SERVICE_CLIENTS`   | JSON object of client id to shared secret, e.g. `{"kaamkoti":"…"}`. Each secret is at least 43 characters. |
| `IDENTITY_ORIGIN`   | Public origin of the sign-in host, `https://id.<platform-tld>`; the ID tokens' `iss`.                      |
| `IDENTITY_SECRET`   | better-auth's secret: cookies, sealed signing keys, code HMAC. At least 43 characters.                     |
| `SIGN_IN_CLIENTS`   | JSON object of client id to `{ secret, redirectUris, postLogoutRedirectUris }`.                            |
| `REDIS_URL`         | Rate-limit counters.                                                                                       |
| `SMTP_URL`          | Sign-in codes and notify's email. Mailpit in development (inbox `http://127.0.0.1:45446`).                 |
| `EMAIL_FROM`        | The codes' sender.                                                                                         |
| `NOTIFY_EMAIL_FROM` | The sender of notify's emails.                                                                             |

WhatsApp (Meta Cloud API, D7) is off unless all of these are given; some but not all stops start-up:

| Variable                        | Meaning                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------- |
| `WHATSAPP_PHONE_NUMBER_ID`      | The sending number's id in WhatsApp Manager.                                                |
| `WHATSAPP_ACCESS_TOKEN`         | A system user's permanent token with `whatsapp_business_messaging`.                         |
| `WHATSAPP_APP_SECRET`           | The Meta app's secret; verifies the status webhook at `https://hooks.<tld>/hooks/whatsapp`. |
| `WHATSAPP_VERIFY_TOKEN`         | A random string, entered in Meta's webhook settings when subscribing (field `messages`).    |
| `NOTIFY_WHATSAPP_MONTHLY_QUOTA` | WhatsApp messages per business per month, until plans carry it (5.1).                       |
| `WHATSAPP_API_URL`              | Optional; default `https://graph.facebook.com/v23.0`.                                       |

Each template's WhatsApp version (`src/templates/kaamkoti.ts`) must be approved in Meta under its `name`, in
English (`en`), with its `body` as written there. Sign-in codes need one more: an **Authentication** template
named `sign_in_code` in `en`, with a copy-code button (Meta writes its body, "{{1}} is your verification
code.").

Bad config stops start-up.

## Running

- Migrations run as `platform_owner`: `pnpm run up` in development, the deploy on the server. The container
  never migrates.
- Container: `docker compose -f infra/compose.dev.yml --profile platform up -d --build platform`. It listens
  on `127.0.0.1:45443` in development, and has no host port in production.
- `pnpm run up:fresh` seeds the four identities behind Kaam Koti's seeded members (`seed.sql`): sign in as
  `prakash@example.com` and read the code in Mailpit.
- The package exports the identity pieces (`createIdentity`, `registerClients`, `createHandler`, `listen`,
  `redisLimiter`) so an app's test can sign in against a real platform in process.
- Tests: `pnpm --filter platform test` (needs `pnpm run up`: Postgres, Redis). They include an app's outbox
  delivering after platform comes back, a full sign-in over HTTP, and notify's send, retry and give-up.
