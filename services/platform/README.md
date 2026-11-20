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

There are no topics yet: the first, `notify.send`, comes in step 3.2. Bodies over 64 KB are refused (413).

## Identity

- better-auth with `@better-auth/oauth-provider` and `jwt`, in `src/identity.ts` only. Its tables live in the
  `identity` schema. `migrations/identity/0001_identity.sql` is **generated** from the options in that file
  (`node scripts/identity-sql.ts`); a test fails if it drifts. Until the first real tenant, a better-auth upgrade
  regenerates it.
- Sign-in clients come from `SIGN_IN_CLIENTS` and are written to `identity."oauthClient"` at start-up: first
  party (no consent), confidential (`client_secret_basic`), PKCE required. A client dropped from config is
  disabled, not deleted.
- The ID token carries `email`, `email_verified` and `name`, so an app needs no userinfo call. It lives 5
  minutes, and a code lives 60 seconds.
- Codes: 6 digits, 10 minutes, 5 attempts, stored as an HMAC under `IDENTITY_SECRET`. At most 5 codes an hour
  to one address, plus per-IP limits, counted in Redis. The client IP comes from `x-client-ip`, which the proxy
  sets.
- Redirect URIs must be HTTPS, except loopback ones while platform itself runs on plain HTTP on loopback
  (development).
- Sign-in by phone arrives with WhatsApp delivery (3.3).

## Config

| Variable          | Meaning                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`    | `platform` database as `platform_app`.                                                                                         |
| `PORT`            | Default 3000.                                                                                                                  |
| `SERVICE_CLIENTS` | JSON object of client id to shared secret, e.g. `{"kaamkoti":"…"}`. Each secret is at least 43 characters.                     |
| `IDENTITY_ORIGIN` | Public origin of the sign-in host, `https://id.<platform-tld>`; the ID tokens' `iss`.                                          |
| `IDENTITY_SECRET` | better-auth's secret: cookies, sealed signing keys, code HMAC. At least 43 characters.                                         |
| `SIGN_IN_CLIENTS` | JSON object of client id to `{ secret, redirectUris, postLogoutRedirectUris }`.                                                |
| `REDIS_URL`       | Rate-limit counters.                                                                                                           |
| `SMTP_URL`        | Where sign-in codes are mailed from until notify (3.2) delivers them. Mailpit in development (inbox `http://127.0.0.1:45446`). |
| `EMAIL_FROM`      | The codes' sender.                                                                                                             |

Bad config stops start-up.

## Running

- Migrations run as `platform_owner`: `pnpm run up` in development, the deploy on the server. The container
  never migrates.
- Container: `docker compose -f infra/compose.dev.yml --profile platform up -d --build platform`. It listens
  on `127.0.0.1:45443` in development, and has no host port in production.
- Tests: `pnpm --filter platform test` (needs `pnpm run up`: Postgres, Redis). They include an app's outbox
  delivering after platform comes back, and a full sign-in over HTTP.
