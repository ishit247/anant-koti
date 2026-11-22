# Kaam Koti and the shared platform: architecture

Step 0.1, written 2026-11-21. Product: [product-brief.md](product-brief.md). Module rules:
[platform-modules.md](platform-modules.md). Decisions referred to as Dn are in the table in
[development-plan.md](development-plan.md).

Read only what your step needs. Each step's sections:

| Step     | Read                                  |
| -------- | ------------------------------------- |
| 0.2      | 1, 12                                 |
| 0.3      | 1, 2, 4.1, 5                          |
| 0.4      | 4, 5.2, 11                            |
| 0.5      | 1, 9, 12 (`tokens`, `outbox`, `jobs`) |
| 0.6, 0.7 | 3, 4.3                                |
| 1.x      | 5.3, 6                                |
| 2.1–2.3  | 5.3, 7, 10                            |
| 2.4, 2.5 | 5.3, 6, 8                             |
| 3.x      | 5.3, 6, 9                             |
| 4.x      | 5.3, 6, 8, 12 (`payments`)            |
| 5.x      | 4, 13                                 |
| 6.x      | 5.3, 9, 13                            |

## 1. Containers, hosts and cookies

```
Cloudflare → Caddy (shared infra project)
  ├─ kaamkoti.<tld>          → kaamkoti-web   public pages, request form, customer links; no cookies
  ├─ app.kaamkoti.<tld>      → kaamkoti-web   owner and technician app; session cookie
  ├─ id.<platform-tld>       → platform       sign-in pages, OpenID Connect provider (D14)
  └─ hooks.<platform-tld>    → platform       provider webhooks for notify and billing
Internal network only: kaamkoti-worker, platform internal API, Postgres, Garage, Redis
```

- The domains are still open (D1 is needed by 6.3). Code reads every host from config; nothing hard-codes one.
- **One web image serves both Kaam Koti hosts.** Next.js middleware routes by `Host`. Public routes on the
  bare domain never set or read a cookie. Because the session cookie is `__Host-kk_session` (host-only, `Secure`,
  `HttpOnly`, `SameSite=Lax`, no `Domain`), the browser never sends it to `kaamkoti.<tld>`. Cookie isolation
  therefore comes from the browser, not from our code.
- `kaamkoti-worker` is the same codebase with a different entry point. It runs pg-boss handlers and has no
  host port.
- `platform` is one container: identity, billing and notify. Apps reach its internal API at
  `http://platform:3000/internal/v1/…` on the Docker network. Only `id.` and `hooks.` are routed to it
  through Caddy.
- Redis is not shared (infra rule). Its one job is rate-limit counters (sign-in OTP, public request form, token
  lookups). It runs in the platform project, and Kaam Koti runs its own for the public form. Nothing that must
  survive a restart lives in Redis.
- Logs are JSON to stdout via `log`, collected into Loki.

## 2. Databases, roles and buckets

Postgres roles are cluster-wide, and POS already owns `app_platform`, so every role carries its project prefix.

| Database   | Owner role (migrations) | Runtime role                    | Schemas                                                                                                |
| ---------- | ----------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `kaamkoti` | `kaamkoti_owner`        | `kaamkoti_app` (web and worker) | `tenancy`, `audit`, `tokens`, `outbox`, `storage`, `payments`, `billing`, `auth`, `pgboss`, `kk` (app) |
| `platform` | `platform_owner`        | `platform_app`                  | `identity`, `billing`, `notify`, `tokens`, `outbox`, `audit`, `pgboss`                                 |

- The runtime role owns nothing, is `NOBYPASSRLS`, and gets its rights from each migration's explicit `GRANT`s,
  with `REVOKE` where a right must be withheld (for example `audit.event`: insert and select only).
- The migration runner (`db`) tracks files by name only. It applies each module's `migrations/` folder in
  dependency order, then the app's own. Module migration names are prefixed with the module name
  (`tenancy/0001_business.sql`), so names never collide.
- Buckets: `kaamkoti-private` (request and job photos, signed URLs only) and `kaamkoti-public` (logo, cover
  photo). There is one Garage key per process, with only the rights it needs.
- `up:fresh` (0.3) destroys the volumes, runs every migration and seeds. Seeds: two businesses, each with an
  owner, a technician, three customers and jobs across the states in section 6. Seeds also include one public
  request that nobody has handled yet, so isolation tests have rows on both sides.

## 3. Identity and sign-in (D12, D13, D14)

There is one identity per person, and it lives in `platform`. Each app keeps its own members and roles.

- **Platform is the OpenID Connect provider** (D14): authorization code flow with PKCE. Each app is a
  registered confidential client (client id and secret from config). First-party clients skip the consent
  screen. Sign-in is by OTP to email (phone joins with WhatsApp delivery in 3.3). Rate limits are per identifier
  and per IP, in Redis; the IP comes from `x-client-ip`, set by the proxy. The ID token carries `email`, `name`
  and `email_verified`, so the callback needs no userinfo call.
- **Platform internals (D13, decided 2026-11-21):** better-auth with its OIDC provider plugin, wrapped so only
  `services/platform` imports it. Its tables live in the `identity` schema.
  `identity.user.id` is a UUID and is the `sub` claim.
- **App side, `auth` module** (in the app, no better-auth):
  1. `GET /login`: create a row in `auth.login_attempt` (state, nonce, PKCE verifier, return path, expires
     in 10 min), set `__Host-kk_login` to the state, then redirect to `id.`.
  2. `GET /auth/callback`: look up the attempt by `state` and delete it in the same statement (single use).
     The login cookie must carry the same state, so a response started in another browser is refused (login
     CSRF). Exchange the code over the internal network. Verify the ID token's signature against the cached
     JWKS (EdDSA only), plus `iss`, `aud`, `exp`, `iat` (at most 5 minutes old), `nonce` and
     `email_verified`. Any failure is refused with no session. A replayed response finds no attempt row.
  3. Create `auth.session` (random 32-byte id, only its SHA-256 stored; 30 days absolute, 7 days idle) and set
     `__Host-kk_session`. Expired attempts are purged when a sign-in starts, expired sessions when one
     finishes, so no job is needed.
  4. Resolve the member: a `tenancy.member` with this `identity_id` goes to the app. A pending invite goes to
     acceptance (0.7). Neither goes to onboarding (create a business). `getSession` returns the identity and
     its memberships.
- One runtime dependency, `jose`, is used for JWKS and JWT verification. Hand-rolled JWT checks are the
  classic source of auth bugs.
- **While platform is down:** existing sessions keep working, because they are local rows. New sign-ins show
  "Sign-in is briefly unavailable". Nothing else in the app calls identity synchronously.
- Sign-out deletes the local session and redirects to the platform's end-session URL, which ends the platform
  session too, so the next person on a shared phone is asked for a code. Platform redirects back only with an
  `id_token_hint`, so the session row keeps the ID token until it is deleted. Global sign-out (an event
  telling every app to drop that identity's sessions) is out of MVP.
- Identity holds name, email and phone. A member row holds only `identity_id` and a display name copied at
  sign-in, so personal data has one home. (The ID token kept for sign-out also carries email and name; it
  lives no longer than the session.)

## 4. Tenancy

### 4.1 Model

`tenancy.business` is the tenant. Every tenant-owned row carries `business_id uuid not null`.

| Table              | Columns (beyond `id uuid`, `created_at`)                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `tenancy.business` | `slug` (unique, public URL), `name`, `phone`, `city`, `timezone` (default `Asia/Kolkata`), `currency` (default `INR`)             |
| `tenancy.member`   | `business_id`, `identity_id`, `display_name`, `role` (`owner`, `technician`), `removed_at`; unique (`business_id`, `identity_id`) |
| `tenancy.invite`   | `business_id`, `role`, `invited_by`, `token_id` → `tokens.token`, `accepted_member_id`, `expires_at`                              |

There is one owner per business in the MVP. More roles (manager, branch) arrive with the Business plan (7.7).

### 4.2 Row-level security

- Every table that has a `business_id` gets `ENABLE ROW LEVEL SECURITY` and one policy for all commands:
  `business_id = nullif(current_setting('app.business_id', true), '')::uuid`, with the same `WITH CHECK`.
- `db.withTenant(businessId, fn)` opens a transaction, runs `SET LOCAL app.business_id`, and passes `fn` the
  client. With no context, the setting is null, every query sees zero rows, and every insert fails. **It fails
  closed.**
- `SET LOCAL` dies with the transaction, so a pooled connection never carries a tenant into the next request.
- Request handlers never run tenant queries outside `withTenant`. Cross-tenant work is not needed. Background
  jobs carry `business_id` in their payload and run inside `withTenant` too, so the app role never reads two
  businesses in one transaction.
- Some module infrastructure tables have no `business_id` policy: `tokens.token`, `outbox.message`,
  `outbox.inbox`, `payments.webhook_event`, `pgboss.*` and `auth.*`. They are reached only through their module's
  API, which uses them as entry points: they turn a hash, a webhook or a session into a `business_id`, which then
  opens `withTenant`.
- Slug lookup for public pages uses `tenancy.resolve_slug(slug) returns uuid`, a `SECURITY DEFINER` function
  owned by `kaamkoti_owner` that returns only the id.

### 4.3 Permissions and scope

A permission answers _what_ the role may do. Scope answers _whose_ row it is. Both are checked.

| Action                                                           | Owner | Technician                                     |
| ---------------------------------------------------------------- | ----- | ---------------------------------------------- |
| Business settings, catalogue, members, billing                   | yes   | no                                             |
| Requests, quotes, change-order pricing, invoices, cash payments  | yes   | no                                             |
| Schedule and assign                                              | yes   | no                                             |
| View a job                                                       | all   | only jobs with an appointment assigned to them |
| Check in, checklist, photos, propose change order, mark complete | yes   | assigned jobs only                             |

- RLS gives business scope. The technician rule ("assigned to me") is an explicit check in the job query helper,
  and it is tested.
- **Every route declares its scope** in an exported constant. A test (0.4) enumerates every route file, server
  action and webhook handler, and fails on any without a declaration.

| Scope              | Credential                               | Resolves to                                          |
| ------------------ | ---------------------------------------- | ---------------------------------------------------- |
| `member`           | session cookie (`app.` only)             | business, member, role; then `withTenant`            |
| `customer-token`   | token in the path (section 7)            | business, job and allowed actions; then `withTenant` |
| `invite-token`     | token in the path (section 7)            | business and role; then `withTenant` to accept       |
| `public-slug`      | none                                     | business by slug; read-only public columns           |
| `public-intake`    | none, rate limited                       | business by slug; may only create a request          |
| `service`          | signed request from platform (section 9) | the business in the payload; then `withTenant`       |
| `provider-webhook` | provider signature                       | the business in the URL, verified against its secret |
| `none`             | none                                     | health checks and static pages only                  |

## 5. Data model

### 5.1 Conventions

- Ids are `uuid` (`gen_random_uuid()`). Timestamps are `timestamptz`, shown in the business's timezone. Money
  is `bigint` minor units plus the business's `currency` (section 8).
- Status columns are `text` with a `CHECK` listing the values. The allowed transitions are code (section 6),
  and each `UPDATE … WHERE status = $expected` makes concurrent transitions fail instead of overwriting each
  other.
- Typed JSON (template, answers, checklist) is parsed with Zod on write and again on read.
- Each foreign key and each list query gets an index. Tenant tables lead their indexes with `business_id`.

### 5.2 Module tables

Each module's own section in 12 lists its tables. Section 4.1 covers tenancy.

### 5.3 App tables (schema `kk`)

| Table               | Purpose and key columns                                                                                                                                                                                                                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trade_template`    | Global, read-only, from seeds: `key`, `version`, `body` (catalogue, intake questions, checklist, terms)                                                                                                                                                                                                           |
| `business_profile`  | 1:1 with business: `trade_key`, `about`, `service_area`, `logo_object_id`, `intake` (questions), `checklist`, `terms`; copied from the template at onboarding, then the business's own                                                                                                                            |
| `catalogue_item`    | `name`, `unit` (`job`, `hour`, `unit`, `sq_ft`, …), `unit_price_minor`, `tax_rate_bp`, `active`                                                                                                                                                                                                                   |
| `customer`          | `name`, `phone_e164`, `email`, `address`; unique (`business_id`, `phone_e164`); found or created on request                                                                                                                                                                                                       |
| `job`               | The request and everything after: `customer_id`, `number` (per business), `source` (`public_form`, `whatsapp_link`, `qr`, `phone`), `answers`, `address`, `preferred_window`, `status` (section 6), `accepted_quote_id`, `cancel_reason`                                                                          |
| `job_task`          | One piece of work in a request: `job_id`, `catalogue_item_id` (nullable: custom task), `title`, `status` (`requested`, `quoted`, `approved`, `done`, `dropped`), `added_by` (`customer`, `business`), `added_at`. A request has one or more                                                                       |
| `quote`             | `job_id`, `version` (unique per job), `status` (`draft`, `sent`, `accepted`, `rejected`, `countered`, `superseded`), `valid_until`, `sent_at`, totals (`net_minor`, `tax_minor`, `total_minor`), `deposit_minor` (2.4); `counter_note`, `counter_total_minor`, `decided_at` (2.5)                                 |
| `quote_line`        | `job_id`, `quote_id`, `position`, `job_task_id` (nullable: null = request-level charge), `catalogue_item_id` (nullable), `description`, `unit`, `quantity_milli`, `unit_price_minor`, `tax_rate_bp`, `net_minor`, `tax_minor`. Composite keys carry `job_id`, so a line prices only a task of its own quote's job |
| `appointment`       | `job_id`, `kind` (`site_visit`, `work`), `technician_member_id`, `starts_at`, `ends_at`, `status` (`planned`, `done`, `cancelled`), `on_the_way_at`                                                                                                                                                               |
| `job_visit`         | `appointment_id`, `checked_in_at`, `checklist` (results), `completed_at`, `note`                                                                                                                                                                                                                                  |
| `change_order`      | `job_id`, `number`, `status` (`proposed`, `approved`, `rejected`), totals, `decided_at`                                                                                                                                                                                                                           |
| `change_order_line` | Same shape as `quote_line`                                                                                                                                                                                                                                                                                        |
| `invoice`           | `job_id` (unique while not void), `number` (per business, gap-free sequence row), `status` (`issued`, `paid`, `void`), totals, `issued_at`, `paid_at`                                                                                                                                                             |
| `invoice_line`      | Snapshot of the accepted quote's lines plus approved change-order lines                                                                                                                                                                                                                                           |
| `job_photo`         | `job_id`, `object_id` → `storage.object`, `kind` (`request`, `before`, `after`)                                                                                                                                                                                                                                   |
| `review`            | `job_id` (unique), `rating` 1–5, `text`, `status` (`held`, `published`), `owner_response`, `publish_after`                                                                                                                                                                                                        |

Rules the database enforces, not just the code:

- **Sent quotes are immutable** (`kk.quote_guard`, `kk.quote_line_guard`, 2.4). A quote is born a `draft`. Lines
  may be inserted, changed or deleted only while their quote is a draft (the line trigger locks the quote `FOR
  SHARE`, so a line write and a send wait for each other). Leaving `draft` needs at least one line, and stored
  totals equal to the sums of the lines. After that only `status` may change, never back to `draft`; 2.5 adds
  `decided_at` and the counter columns by name. The runtime role cannot delete a quote. Partial unique indexes
  allow at most one `draft` and one `sent` quote per job.
- **Line amounts are restated.** `CHECK`s on `quote_line` recompute net and tax with `round(numeric)`, the same
  rule as `lineTotals` (section 8), so a line with wrong arithmetic cannot be stored.
- **No double booking.** `EXCLUDE USING gist (technician_member_id WITH =, tstzrange(starts_at, ends_at) WITH &&)
  WHERE (status = 'planned')` (extension `btree_gist`).
- **Paid invoices are immutable.** A trigger refuses changes to an invoice and its lines once `status = 'paid'`,
  except `void` by the owner, which writes an audit event.
- Invoice lines are copied, not referenced, because an invoice is a document that must not change if anything
  upstream does.

Phase 7 tables (referral points, AMC contracts, branches) are left out on purpose. They attach to `customer`,
`job` and `business` without changing these tables.

## 6. Job state machine

The job carries the work's state. Money lives on quote and invoice. The review is its own row.

```
requested ──send quote──▶ quoted ──customer accepts──▶ accepted ──schedule──▶ scheduled
    │                       │  ▲                                                │
    │ owner declines        │  └─ owner revises (new version; old superseded)   │ technician checks in
    ▼                       │     after a counter, rejection or expiry          ▼
 declined                   └─ owner closes as lost ──▶ lost               in_progress
                                                                                │ mark complete
 cancelled ◀── owner or customer, from any state before in_progress            ▼
                                                                             completed
```

| From                    | Event               | To            | Who                                         | Side effects                                                                                       |
| ----------------------- | ------------------- | ------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| —                       | request created     | `requested`   | customer (`public-intake`) or owner (phone) | customer found or created; notify owner and customer; token issued                                 |
| `requested`             | quote sent          | `quoted`      | owner                                       | quote `draft → sent`; expiry job at `valid_until`; notify customer                                 |
| `requested`             | decline             | `declined`    | owner                                       | notify customer                                                                                    |
| `quoted`                | accept              | `accepted`    | customer                                    | quote → `accepted`, `job.accepted_quote_id` set; deposit link if `deposit_minor > 0`; notify owner |
| `quoted`                | reject or counter   | `quoted`      | customer                                    | quote → `rejected` or `countered`; notify owner                                                    |
| `quoted`                | revise              | `quoted`      | owner                                       | new version `sent`, previous → `superseded`                                                        |
| `quoted`                | close as lost       | `lost`        | owner                                       | —                                                                                                  |
| `accepted`              | appointment planned | `scheduled`   | owner                                       | notify customer; reminder jobs                                                                     |
| `scheduled`             | check in            | `in_progress` | assigned technician or owner                | `job_visit.checked_in_at`                                                                          |
| `in_progress`           | complete            | `completed`   | assigned technician or owner                | invoice issued with pay link; notify customer                                                      |
| `requested`…`scheduled` | cancel              | `cancelled`   | owner, or customer by token                 | appointments cancelled; open payment links cancelled                                               |

- **Quote expiry is computed at request time.** A `sent` quote with `valid_until < now()` is treated as
  expired: accepting it is refused and the customer sees "ask for a new quote". The pg-boss job at
  `valid_until` only notifies the owner. No stored status can be stale.
- Site visits are appointments of kind `site_visit` and do not move the job's state.
- **Tasks and charges.** The customer picks catalogue items on the request form; each becomes a `job_task` with
  a known price. A charge is task-level when its line has a `job_task_id`, and request-level (visit fee, discount,
  one lump price) when it is null; one quote can mix both. A task the customer adds before the quote is accepted
  makes a new quote version. After acceptance, the customer's added task is only a request: it is
  `requested` and costs nothing until the business prices it in a change order and the customer approves.
  Invoice lines copy `job_task_id` from the lines they snapshot.
- A proposed change order needs the customer's approval by token. It can be approved only while the job is
  `in_progress` or `completed` and the invoice is not yet issued. The invoice includes only `approved` change
  orders (4.3).
- A paid invoice is derived, not a job state. It drives the review request (6.1).
- Each transition is one function, `transitionJob(tx, job, event, actor)`, backed by the table above. It writes
  the change and an audit event, and enqueues outbox messages, in one transaction. 2.5 tests every row of the
  table and asserts that every pair not in the table is refused.

## 7. Customer access by link (`tokens`)

Customers never have accounts. They open their job by a link: `https://kaamkoti.<tld>/j/<token>`.

- The token is 32 random bytes in base64url. Only its SHA-256 is stored, in `tokens.token`: `hash`, `purpose`
  (`job`, `invite`), `business_id`, `subject_id`, `expires_at`, `revoked_at`.
- Scope is one job. Lookup returns the job id. The page then runs inside `withTenant` and loads only that job.
  What the customer may do there (view, respond to quote, approve change order, pay, review) follows from the
  job's state at request time; nothing about actions is stored on the token.
- **A new link per message.** The secret cannot be recovered from its hash, so a later message cannot resend an
  earlier link. Each message carries a fresh link (`issueJobLink`), live for 30 days after that message; a job
  can have several live links. The owner can revoke all of a job's links (`revokeJobLinks`) and send a new one,
  for example after a wrong number. (Changed in 2.1 from "one link per job, extended on each send", which
  needed the secret stored.)
- The token sits in the path. Caddy writes no access logs, and pages set `Referrer-Policy: no-referrer` and load
  no third-party resources, so it does not leak. Lookups are rate limited per IP (60 per 10 minutes) in the
  app's proxy (`src/proxy.ts`, matcher `/j/:path*`), which answers 429; the address is `x-client-ip`, which
  Caddy sets.
- Customer actions are form posts carrying the token. With no cookies there is no ambient authority, and so
  no CSRF.
- **Lapsed business** (section 13): the link still opens, but shows a contact card and allows no actions.

## 8. Money

- `money` (2.4): an amount is an integer in minor units (paise) together with an ISO currency. A business has
  one currency in the MVP (INR). Mixing currencies throws.
- Quantity is an integer in thousandths (`quantity_milli`), so 1.5 hours is 1500.
- Line net = `round(quantity_milli × unit_price_minor / 1000)`. Line tax = `round(net × tax_rate_bp / 10000)`.
  Halves round away from zero (Postgres `round(numeric)`), so a discount line mirrors the charge it offsets.
  Totals are sums of rounded lines (line-level rounding, as GST invoices do). Prices are tax-exclusive. Most
  sole traders are not GST-registered, so the default tax rate is 0. The arithmetic runs in `BigInt` and throws
  rather than lose a paisa.
- A discount is a line with a negative unit price, which is how a counter-offer usually ends. A quote or
  invoice total below zero is refused.
- Amount due on an invoice = total − captured payments for the job, which include any deposit. When it
  reaches 0, the invoice becomes `paid` in the same transaction that records the payment.
- **Online payment is recorded only from a verified provider webhook** (`payments`, 4.1). A cash payment is
  recorded explicitly by the owner, with method `cash`, and audited.
- Money goes straight to the business, never through us (no commission). So each business connects its own
  payment-provider account. Its API keys and webhook secret are stored encrypted (AES-256-GCM, key from config)
  in `payments.account`, and its webhook URL carries the business id. This is part of D5 (4.1).

## 9. Notifications and app ↔ platform calls

### 9.1 One pattern: outbox, signed delivery, idempotent receiver

1. A business change and its message are written in **one transaction**: `outbox.enqueue(tx, topic, payload,
   idempotencyKey)` inserts into `outbox.message` and sends a pg-boss job in the same transaction.
2. The worker posts the message to the receiver. App → platform goes to `/internal/v1/<topic>`. Platform → app
   goes to the app's internal `/internal/v1/events`.
3. Each request is signed (`tokens.signRequest`): HMAC-SHA256 over method, path, timestamp and the body's
   SHA-256, with a per-app secret shared with platform. The receiver refuses a bad signature and refuses a
   timestamp outside ±5 minutes.
4. The receiver inserts `(source, idempotency_key)` into `outbox.inbox` in the same transaction as handling it.
   A duplicate is acknowledged without being handled again.
5. Retries back off exponentially for up to 24 hours, then dead-letter and alert. At-least-once delivery plus
   an idempotent receiver means each message takes effect exactly once.

If platform is down, messages wait in the outbox and the app carries on (0.5's "Done when"). The same
receiver code handles provider webhooks, with the provider's signature in place of ours.

### 9.2 Notify (platform)

- The app sends `notify.send` with `{ product, businessId, template, to: { phone?, email? }, vars, locale }`.
  Platform picks the channel: WhatsApp if there is a phone and quota left, otherwise email. SMS comes later.
- Templates live in `services/platform/notify/templates/<product>/` with one version per channel. WhatsApp
  templates mirror the ones Meta has approved (D7, 3.3).
- `notify.message` keeps the recipient for retries and status, and is purged after 30 days. Logs carry the
  message id and template, never the recipient or the text.
- The WhatsApp quota counts per (product, business, month), with top-ups (5.2). Over quota falls back to email.
  If there is no email, the owner is told.
- Delivery-status webhooks from providers reach `hooks.` and are signature-verified (3.3).

| Template                                                                 | To                                                      | When                                           |
| ------------------------------------------------------------------------ | ------------------------------------------------------- | ---------------------------------------------- |
| `request.received`                                                       | owner; customer gets an acknowledgement with their link | job created                                    |
| `quote.sent`                                                             | customer                                                | quote sent or revised                          |
| `quote.response`                                                         | owner                                                   | accepted, rejected, countered                  |
| `appointment.confirmed`, `appointment.reminder`, `technician.on_the_way` | customer                                                | planned; 24 h before; tapped by the technician |
| `change_order.proposed`                                                  | customer                                                | technician or owner proposes                   |
| `invoice.issued`, `payment.received`                                     | customer; owner                                         | complete; payment recorded                     |
| `review.request`, `review.held`                                          | customer; owner                                         | invoice paid; low rating                       |

Sign-in OTPs go straight from identity to its own channel, inside platform, not through the outbox. Technician
invites in 0.7 are shared by the owner: copy the link, or a `wa.me` share. Sending them by notify waits for 3.2.

## 10. Uploads (`storage`)

- Uploads go through the app server, which streams them to Garage. There are no direct browser-to-bucket
  uploads, so every check runs on our side.
- Accepted: JPEG, PNG and WebP up to 10 MB, judged by magic bytes, not by the extension or the declared type.
  Images are re-encoded, which strips EXIF data such as GPS location from customers' homes, and resized to at
  most 2048 px. This needs the `sharp` dependency, justified in 2.2's commit.
- Private objects are served by a 5-minute presigned GET, issued only after the route's scope check.
- `storage.object`: `business_id`, `bucket`, `key` (random, never the file name), `content_type`, `bytes`,
  `sha256`, `created_by`. Up to 6 photos per request on the public form. Limits are per IP, and per business
  per day.
- **The public request form** (2.2) is a plain multipart post to a route handler,
  `/b/[slug]/request/send` (scope `public-intake`), not a server action like the app's other forms. It has to
  answer 429 and 413 and take six photos, and a server action can do neither. The proxy cannot limit it, because
  it buffers bodies only to 10 MB. Limits: 10 per IP per hour, then 200 per business per day, counted in that
  order. Photos answer the business's `photo` questions (field `photo.<key>`); a business with no photo question
  takes none. On success the customer is sent to a fresh job link (`/j/<secret>`), which shows their tasks and
  photos (by `signedUrl`). `job_task` arrived with this step, not 2.4, because the form picks the tasks.

## 11. Audit

`audit.event`: `business_id`, `actor_kind` (`member`, `customer`, `system`, `platform`), `actor_id`, `action`,
`entity`, `entity_id`, `data` (ids and amounts, never names, phones or free text), `at`.

- The runtime role may insert and select, with `UPDATE` and `DELETE` revoked, and a test proves it.
- `audit.record(tx, event)` runs inside a `SAVEPOINT`. An audit failure rolls back to the savepoint, logs an
  error and leaves the business write intact. Exception: money events (payment recorded, invoice paid or void)
  are audited without the savepoint, so a failed audit fails the payment write deliberately.

## 12. Module APIs

Each module exports only from `src/index.ts`. Signatures are indicative; the step that builds a module fixes
them in its README.

| Module             | Public API                                                                                                                                               | Tables                                                                            | Step |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---- |
| `config`           | `defineConfig(zodSchema)` → frozen typed config; throws on start-up                                                                                      | —                                                                                 | 0.2  |
| `log`              | `createLogger({ service })`, `withRequestId`; redacts keys such as `phone`, `email`, `token`, `authorization`, `secret`                                  | —                                                                                 | 0.2  |
| `db`               | `createPool(cfg)`, `tx(fn)`, `withTenant(id, fn)`, `migrate([...folders])`, `testDb()` (fresh database per test file)                                    | `db.migration`                                                                    | 0.3  |
| `tenancy`          | `createBusiness`, `addMember`, `createInvite`, `acceptInvite`, `memberFor(identityId)`, `requireRole`, `defineRoute({ scope, … })`, route-scope test kit | `tenancy.*`                                                                       | 0.4  |
| `audit`            | `record(tx, event)`, `recordStrict(tx, event)`                                                                                                           | `audit.event`                                                                     | 0.4  |
| `tokens`           | `signRequest`, `verifyRequest` (0.5); `issue`, `resolve`, `revoke`, `revokeFor` for links (invites 0.7, jobs 2.1)                                        | `tokens.token`                                                                    | 0.5  |
| `jobs`             | `createJobs(pool)`, `defineJob(name, zodPayload, handler)`, `send(tx, …)`, `sendAt`                                                                      | `pgboss.*`                                                                        | 0.5  |
| `outbox`           | `enqueue(tx, topic, payload, key)`, `startDelivery`, `receive(source, key, tx, fn)`                                                                      | `outbox.message`, `outbox.inbox`                                                  | 0.5  |
| `auth` (app side)  | `createAuth(options)` → `startLogin`, `handleCallback`, `getSession`, `signOut`; `SignInRefused`, `SignInUnavailable`                                    | `auth.login_attempt`, `auth.session`                                              | 0.6  |
| `storage`          | `checkImage(bytes)`, `createStorage(cfg)` → `putImage(tx, image, by)`, `signedUrl(object)`; `remove` comes with its first use                            | `storage.object`                                                                  | 2.2  |
| `rate-limit`       | `redisLimiter(url, log)` → `limit(key, rule)`, `close()`                                                                                                 | — (Redis)                                                                         | 2.2  |
| `money`            | `money(minor, cur)`, `lineTotals(lines, cur)`, `formatMoney`, `minorDigits`, `parseDecimal`, `formatDecimal`; `add` with payments (4.1)                  | —                                                                                 | 2.4  |
| `notify` (client)  | `send(tx, message)`, through the outbox                                                                                                                  | — (server tables in platform)                                                     | 3.2  |
| `payments`         | `connectAccount`, `createPaymentLink(tx, …)`, `handleWebhook(req)` → typed events, `recordManual(tx, …)`                                                 | `payments.account`, `payments.link`, `payments.payment`, `payments.webhook_event` | 4.1  |
| `billing` (client) | `status(businessId)` → `{ plan, live, limits }`, `assertWithin(limit)`, event handler for status updates                                                 | `billing.status`                                                                  | 5.1  |

Platform-side tables: `identity.*` (from better-auth), `notify.message`, `notify.quota`, `billing.account`,
`billing.subscription`, `billing.referral`, and the same `tokens`, `outbox` and `audit` modules.

Dependency direction (checked in 0.2): foundation (`config`, `log`, `money`) ← core (`db`, `audit`, `jobs`,
`storage`, `tokens`, `outbox`) ← domain (`tenancy`, `auth`, `notify`, `payments`, `billing`) ← apps and
`platform`.

## 13. Subscription and lapse (`billing`)

- **In platform:** a `billing.account` belongs to an identity (the payer). That gives one bill across products
  (D12). An account has one `billing.subscription` per product tenant: `product`, `tenant_id` (the business),
  `plan`, `seats`, `status` (`trialing`, `active`, `past_due`, `cancelled`), `trial_ends_at`,
  `paid_through`. Status changes only from a verified provider webhook (D6, 5.1).
- **In the app:** `billing.status` is a local copy, updated by signed `billing.status_changed` events. It is
  applied only if its `version` is newer, so an old event can never undo a new one.
- **Live is computed at request time:** `live = (trialing and now < trial_ends_at) or now < paid_through + 3
  days grace`. Nothing is stored that can go stale, and a platform outage changes nothing.
- **Lapsed:** the public page and customer links show a contact card (name, phone, WhatsApp link) and accept
  no new requests or payments. The owner app goes read-only, apart from billing and export. Data is never
  deleted on lapse.
- Limits are plan config: seats (owner plus technicians), and the WhatsApp quota (counted in platform). They are
  checked with `assertWithin` at the edge and refused with one error shape: `{ error: { code: 'limit',
  limit, plan } }`.
- **Reviews (6.1):** ratings of 4 and 5 publish at once. Ratings of 1 to 3 are `held` for the owner, who can
  respond. They then publish, with any response, after 7 days. The owner can delay a low rating but not bury
  it. A review page that hides bad ratings would mislead the customers who read it.
- **Referral free month (6.2):** `billing.referral` in platform credits one month once the referred business
  first pays.

## 14. Cross-cutting choices

- **Errors:** route handlers and server actions return `{ error: { code, message, fields? } }`. One mapper turns
  Zod and domain errors into this shape. Unexpected errors are logged with the request id and shown as a generic
  page.
- **UI:** server components and server actions. Client JavaScript is used only for the photo picker, the quote
  line editor and the schedule view. Copy is English at launch, with every string in one file per app so that
  Hindi needs no code change.
- **Phones:** stored as E.164. At launch, input is Indian mobile numbers only (`+91` and 10 digits starting
  6–9), checked by one Zod schema. A library is added only when the product goes global.
- **Time:** stored in UTC, shown in the business's timezone. Reminder times are computed in that timezone.
