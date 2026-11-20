# platform

The shared container: identity (0.6), billing (5.x) and notify (3.2). Design:
[docs/architecture.md](../../docs/architecture.md) sections 1, 2 and 9.1.

## Routes

| Route                       | Who calls it                 | What it does                                                                                                                                                        |
| --------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`               | Docker health check          | 200 while the database answers, otherwise 503.                                                                                                                      |
| `POST /internal/v1/<topic>` | Apps' outbox workers, signed | Verifies the signature (401), finds the topic (404), parses `{ key, payload }` (400), then handles it once through `outbox.receive` (200 `handled` or `duplicate`). |

There are no topics yet: the first, `notify.send`, comes in step 3.2. Bodies over 64 KB are refused (413).

## Config

| Variable          | Meaning                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`    | `platform` database as `platform_app`.                                                                     |
| `PORT`            | Default 3000.                                                                                              |
| `SERVICE_CLIENTS` | JSON object of client id to shared secret, e.g. `{"kaamkoti":"…"}`. Each secret is at least 43 characters. |

Bad config stops start-up.

## Running

- Migrations run as `platform_owner`: `pnpm run up` in development, the deploy on the server. The container
  never migrates.
- Container: `docker compose -f infra/compose.dev.yml --profile platform up -d --build platform`. It listens
  on `127.0.0.1:45443` in development, and has no host port in production.
- Tests: `pnpm --filter platform test`, which includes an app's outbox delivering after platform comes back.
