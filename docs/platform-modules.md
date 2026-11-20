# Shared platform modules

Several apps (Trade Services, Profile Builder, Gyankoti School, POS) need the same
building blocks: auth, tenancy, subscriptions, payments, notifications, logging. This
document says how those blocks are shared so that each is written once, kept small, and
reused without coupling the apps together.

Agreed 2026-11-21: this repository is the monorepo (D10); existing apps adopt modules
gradually (D11); one login and one bill across products (D12), so identity and billing
live in the shared `platform` container from the start; platform is an OpenID Connect
provider (D14). Still open: D13 in [development-plan.md](development-plan.md). The
detailed design is in [architecture.md](architecture.md).

## Principles

1. **Libraries, not services.** A module is a TypeScript package that runs inside the
   app's process, with no network hop and nothing extra to deploy. A module becomes a
   service only when two *running* apps must share its state (see "How apps interact").
2. **Framework-agnostic.** A module uses plain TypeScript and Node/Web APIs. It never
   imports Next.js or NestJS. Each app keeps a thin adapter: a route handler, a Nest
   guard, a server action.
3. **ORM-agnostic.** Modules take a `pg` pool or client and run SQL. An app on Drizzle
   passes its underlying pool. Module rows are parsed with Zod where they enter.
4. **A module owns its tables.** Each module has its own Postgres schema (`auth.*`,
   `billing.*`, …) and ships its own SQL migrations. An app's migration runner applies
   module migrations first, then the app's own. Apps never write to a module's tables
   directly; they go through its API.
5. **Configured, not forked.** App-specific behaviour is passed in when the module is
   created, for example `createBilling({ db, plans, onStatusChange })`. The public API is
   `src/index.ts`; nothing imports a module's internals.
6. **Extract on first use, generalise on second use.** Trade Services is the first
   consumer. A module is created when its step arrives, not ahead of time. When a second
   app adopts it, the module is generalised against that real need, never against a
   guessed one.
7. **One-way dependencies,** checked by `validate`: foundation ← core ← domain, with no
   cycles.

## Modules

| Layer | Module | Owns | First built in step |
|---|---|---|---|
| Foundation | `config` | Env parsing with Zod; bad config stops start-up | 0.2 |
| Foundation | `log` | Structured logger (pino), request id, redaction of secrets and personal data | 0.2 |
| Foundation | `money` | Integer minor units (paise/cents), currency, tax rounding | 2.4 |
| Core | `db` | Pool, transactions, tenant context for RLS, name-tracked migration runner, real-Postgres test helper | 0.3 |
| Core | `audit` | Append-only audit log, savepoint writes, `REVOKE` update/delete | 0.4 |
| Core | `jobs` | pg-boss wrapper, typed job definitions, retries | 0.5 |
| Core | `storage` | S3/Garage, upload validation (content sniffing, size), private and public buckets | 2.2 |
| Domain | `auth` | App side of sign-in: OpenID Connect client, local sessions (identities and OTP live in `platform`) | 0.6 |
| Domain | `tenancy` | Organisations, members, roles, invites, scope-check helpers, route-scope test kit | 0.4 |
| Core | `tokens` | Signed service requests; scoped, expiring, revocable links (invites, magic links) | 0.5, 2.1 |
| Core | `outbox` | Transactional outbox, signed delivery, idempotent inbox | 0.5 |
| Domain | `notify` | Email, WhatsApp and SMS channels; templates; quotas; delivery webhooks | 3.2, 3.3 |
| Domain | `payments` | Customer payment links, provider adapter (Razorpay first), verified idempotent webhooks | 4.1 |
| Domain | `billing` | Plans, seats, trials, subscriptions activated only from verified webhooks, live/lapsed computed at request time, usage quotas | 5.1 |

Not a module yet: a shared UI kit. It waits for a second app that wants the same
components (principle 6).

Each module ships a README covering its purpose, the public API, the config it needs and
the tables it owns. Its tests run through the public API against real Postgres.

## How apps interact

- **Default: they don't.** Each app has its own database. A shared Postgres server is
  fine; shared tables are not.
- **When one app needs another:** an HTTP API authenticated with signed service tokens
  (from `tokens`), plus **outbox events**. The event row is written in the same
  transaction as the business change; a worker delivers it as a signed webhook; the
  receiver handles it idempotently. This is the same pattern as payment webhooks, so
  there is one way to do it.
- **One login and one bill across products (D12):** identity and the billing account
  live in `platform`; apps sign in through it (D14) and keep a local copy of billing
  status.

## Containers (agreed 2026-11-20)

```
Cloudflare → Caddy (shared)
  ├─ app1-web, app1-worker      per app; in-process modules compiled in
  ├─ app2-web, app2-worker
  └─ platform                   shared runtime modules: identity, billing, notify
Shared infra: Postgres (database + role per app), Garage (bucket per app), Loki + Grafana
```

- **Shared at runtime, in one `platform` container:** only modules worth sharing live,
  namely identity, billing and notify (D12). One container, not one
  per module, until a module's load differs.
- **Compiled into each app's image:** `config`, `log`, `db`, `tenancy`, `audit`,
  `money`, `tokens`, `storage`, `payments`. They must run inside the app's own
  transactions.
- `platform` is reachable only on the internal Docker network; apps call it with signed
  service tokens. Provider webhooks reach it through Caddy.
- **Apps keep working while `platform` is down.** An app writes the request to its own
  outbox table in the business transaction, and its worker delivers it once `platform`
  is back.
- **Each app deploys on its own.** `platform` keeps its API backward-compatible.
- **Compose:** one project for shared infra plus `platform`, and one project per app,
  joined by an internal network.
- **Logs:** the `log` module writes JSON to stdout; the collector gathers it from every
  container.

## Repository layout (D10: this folder, to be renamed later)

```
e:\bodhchakra\idea\            pnpm + turbo monorepo, one git repo
  packages\config, log, db, …  the modules, scope @bodhchakra/*
  services\platform            the shared container: identity, billing, notify
  apps\kaamkoti-web, kaamkoti-worker
  apps\…                       later apps, and existing apps if they move in
```

One repository means a change to a module and to every app using it lands in one
commit, `validate` checks all consumers together, and there are no package versions to
juggle or registry to run. Each app still builds its own Docker image (`turbo prune`).

The existing apps stay where they are. Each adopts a module only when work touches that
area and the module fits (D11).
