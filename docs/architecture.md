# Kaam Koti and the shared platform: architecture

Step 0.1, written 2026-11-21. Product: [product-brief.md](product-brief.md). Module rules:
[platform-modules.md](platform-modules.md). Decisions referred to as Dn are in the table in
[development-plan.md](development-plan.md).

Read only what your step needs. Each step's sections:

| Step       | Read                                  |
| ---------- | ------------------------------------- |
| 0.2        | 1, 12                                 |
| 0.3        | 1, 2, 4.1, 5                          |
| 0.4        | 4, 5.2, 11                            |
| 0.5        | 1, 9, 12 (`tokens`, `outbox`, `jobs`) |
| 0.6, 0.7   | 3, 4.3                                |
| 1.x        | 5.3, 6                                |
| 2.1–2.3    | 5.3, 7, 10                            |
| 2.4, 2.5   | 5.3, 6, 8                             |
| 3.2e, 3.2f | 1, 3, 4.3, 5.3, 6, 7, 10              |
| 3.x        | 5.3, 6, 9                             |
| 4.x        | 5.3, 6, 8, 12 (`payments`)            |
| 5.x        | 4, 13                                 |
| 6.x        | 5.3, 9, 13                            |

## 1. Containers, hosts and cookies

```
Cloudflare → Caddy (shared infra project)
  ├─ kaamkoti.<tld>          → kaamkoti-web   public pages and the customer space (section 7); customer session cookie
  ├─ app.kaamkoti.<tld>      → kaamkoti-web   owner and technician app; session cookie
  ├─ id.<platform-tld>       → platform       sign-in pages, OpenID Connect provider (D14)
  └─ hooks.<platform-tld>    → platform       provider webhooks for notify and billing
Internal network only: kaamkoti-worker, platform internal API, Postgres, Garage, Redis
```

- The domains are still open (D1 is needed by 6.3). Code reads every host from config; nothing hard-codes one.
- **One web image serves both Kaam Koti hosts.** Next.js middleware routes by `Host`. Each host has its own
  session cookie: `__Host-kk_session` (members) on `app.`, and `__Host-kk_customer` (customers, D15) on the
  bare domain. Both are host-only, `Secure`, `HttpOnly`, `SameSite=Lax` and have no `Domain`, so the browser never
  sends one to the other host. Cookie isolation therefore comes from the browser; the session's `kind` (section 3)
  is the second check, so a member session is never accepted as a customer one, or the reverse.
- `kaamkoti-worker` is the same codebase with a different entry point. It runs pg-boss handlers and has no
  host port.
- `platform` is one container: identity, billing and notify. Apps reach its internal API at
  `http://platform:3000/internal/v1/…` on the Docker network. Only `id.` and `hooks.` are routed to it
  through Caddy.
- Redis is not shared (infra rule). Its one job is rate-limit counters (sign-in OTP, the request form). It runs in the platform project, and Kaam Koti runs its own for the public form. Nothing that must
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
  screen. Sign-in is by OTP to email, or to an Indian mobile by WhatsApp (3.3c). Rate limits are per identifier
  and per IP, in Redis; the IP comes from `x-client-ip`, set by the proxy. The ID token carries `name` and only
  verified addresses: `email` with `email_verified`, `phone_number` with `phone_number_verified` (scope `phone`),
  at least one of them, so the callback needs no userinfo call.
- **Phone codes (3.3c).** better-auth's phone plugin stores codes in plain text, so only its verify route is
  listed, with `verifyOTP` checking our own table `identity.phone_code` (one live code per number, an HMAC of
  number and code, five guesses, 10 minutes, used once). Sending is ours too: `POST /api/auth/phone-code/send`
  (same-origin only, the same per-IP and per-number limits as email) stores the code and sends it straight to
  WhatsApp's authentication template `sign_in_code` (body and copy-code button). While the WhatsApp channel is
  off it answers 503 and the page asks for an email. A mobile's first sign-in creates an identity with a
  placeholder email `<digits>@phone.invalid`, never verified, never in a token, never sent a code. An email
  identity and a phone identity are two people to platform until accounts can be linked (not in MVP).
- **Platform internals (D13, decided 2026-11-21):** better-auth with its OIDC provider plugin, wrapped so only
  `services/platform` imports it. Its tables live in the `identity` schema.
  `identity.user.id` is a UUID and is the `sub` claim.
- **App side, `auth` module** (in the app, no better-auth):
  1. `GET /login`: create a row in `auth.login_attempt` (state, nonce, PKCE verifier, return path, expires
     in 10 min), set `__Host-kk_login` to the state, then redirect to `id.`.
  2. `GET /auth/callback`: look up the attempt by `state` and delete it in the same statement (single use).
     The login cookie must carry the same state, so a response started in another browser is refused (login
     CSRF). Exchange the code over the internal network. Verify the ID token's signature against the cached
     JWKS (EdDSA only), plus `iss`, `aud`, `exp`, `iat` (at most 5 minutes old), `nonce`, and a verified email
     or mobile. Any failure is refused with no session. A replayed response finds no attempt row.
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
- **Customers sign in the same way (D15, 3.2e).** The same Kaam Koti client has a second redirect URI on the
  bare domain, `/customer/callback`, one for every business: redirect URIs are registered exactly, so the slug
  cannot be in it and travels in the return path instead. `/b/<slug>/login` starts steps 1–3 (returning to a
  path under `/b/<slug>/`, by default the home), with `__Host-kk_login` and `__Host-kk_customer` set on that
  host; started on another host, it moves to the bare domain first (and `/login` to `app.`). `auth.session` and
  `auth.login_attempt` carry `kind` (`member`, `customer`); each `createAuth` serves one kind, so a host accepts
  only its own sessions and finishes only its own attempts. Step 4 differs: a customer session belongs to an
  identity, not to a business. The customer space resolves the slug's business, then the `customer` row for
  (business, identity); with none, an owner-entered row with the session's verified email or verified mobile
  is claimed (audit `customer.claimed`); a new row takes the verified mobile as the customer's own; still none means the customer has not asked this business for anything, and their list
  is empty. Sign-out is a post to `/b/<slug>/signout` (from the app's own pages only: `fromOwnPages`, section 7), through platform's
  end-session, back to `/customer/signed-out?state=<slug>`, which goes to `/b/<slug>`. One sign-in page serves
  members and customers: "Email or mobile" and "Get code", then the code and "Sign in" (3.3c).
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
  `outbox.inbox` (also the payment webhooks' dedup), `pgboss.*` and `auth.*`. They are reached only through their module's
  API, which uses them as entry points: they turn a hash, a webhook or a session into a `business_id`, which then
  opens `withTenant`.
- Slug lookup for public pages uses `tenancy.resolve_slug(slug) returns uuid`, a `SECURITY DEFINER` function
  owned by `kaamkoti_owner` that returns only the id.

### 4.3 Permissions and scope

A permission answers _what_ the role may do. Scope answers _whose_ row it is. Both are checked.

| Action                                                              | Owner | Technician                                     |
| ------------------------------------------------------------------- | ----- | ---------------------------------------------- |
| Business settings, catalogue, members, billing                      | yes   | no                                             |
| Requests, quotes, change-order pricing, invoices, cash payments     | yes   | no                                             |
| Schedule and assign                                                 | yes   | no                                             |
| View a job                                                          | all   | only jobs with an appointment assigned to them |
| Check in, checklist, photos, record extra work found, mark complete | yes   | assigned jobs only                             |

- RLS gives business scope. The technician rule ("assigned to me") is an explicit check in the job query helper,
  and it is tested.
- **Every route declares its scope** in an exported constant. A test (0.4) enumerates every route file, server
  action and webhook handler, and fails on any without a declaration.

| Scope              | Credential                               | Resolves to                                                                                                 |
| ------------------ | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `member`           | session cookie (`app.` only)             | business, member, role; then `withTenant`                                                                   |
| `customer`         | customer session cookie (bare domain)    | business by slug, then the customer row for this identity; then `withTenant`, and only that customer's jobs |
| `invite-token`     | token in the path (section 7)            | business and role; then `withTenant` to accept                                                              |
| `public-slug`      | none                                     | business by slug; read-only public columns                                                                  |
| `service`          | signed request from platform (section 9) | the business in the payload; then `withTenant`                                                              |
| `provider-webhook` | provider signature                       | the business in the URL, verified against its secret                                                        |
| `none`             | none                                     | health checks and static pages only                                                                         |

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

| Table               | Purpose and key columns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trade_template`    | Global, read-only, from seeds: `key`, `version`, `body` (catalogue, checklist, terms)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `business_profile`  | 1:1 with business: `trade_key`, `about`, `service_area`, `logo_object_id`, `checklist`, `terms`; copied from the template at onboarding, then the business's own                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `catalogue_item`    | `name`, `unit` (`job`, `hour`, `unit`, `sq_ft`, …), `unit_price_minor`, `tax_rate_bp`, `active`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `customer`          | The business's record of one customer, the account holder who asks and signs in: `identity_id` (nullable: a customer the owner entered by phone has none until they sign in), `name`, `phone_e164`, `email`; unique (`business_id`, `identity_id`) and (`business_id`, `phone_e164`). Created on the signed-in customer's first request, with the email from the session and the name and mobile they typed for that first place; after that, name and mobile change only on Profile (3.2g), never from a request. A mobile already on another customer's row is refused there (`phone_taken`), never filed under that row nor moved: phones are unverified until 3.3. An owner-entered row with no `identity_id` is claimed when a customer signs in with that verified email (3.2e) or verified phone (3.3) |
| `customer_address`  | The customer's address book (3.2g): `customer_id` (composite key to `customer (business_id, id)`), `label` (Home, Parents, Shop), `contact_name`, `contact_phone_e164` (anyone's mobile, not unique), `address`, `latitude`/`longitude` (both or neither), `last_used_at`. At most 10 per customer, counted under a lock on the customer row; saving a place already there (same address, name and mobile) only marks it used. Every query names the customer as well as the id, so another customer's address reads as missing. Deletable: nothing refers to it. The owner's phone enquiry saves its address here too                                                                                                                                                                                        |
| `job`               | The request and everything after: `customer_id`, `number` (per business), `source` (`public_form`, `whatsapp_link`, `qr`, `phone`), `contact_name`, `contact_phone_e164`, `address`, `latitude`/`longitude` (both or neither: the picked location), `status` (section 6), `accepted_quote_id`, `cancel_reason`. Contact and address are copied at send from the chosen saved address or the typed place, so editing or deleting an address never changes a job; the owner calls the job's contact and sees "Requested by" the customer when it is someone else                                                                                                                                                                                                                                                |
| `job_task`          | One piece of work in a request (a "work item" on the form): `job_id`, `catalogue_item_id` (nullable: custom task), `title`, `details`, `status` (`requested`, `quoted`, `approved`, `done`, `dropped`), `added_by` (`customer`, `business`), `added_at`. A request has one or more                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `quote`             | `job_id`, `version` (unique per job), `status` (`draft`, `sent`, `accepted`, `rejected`, `countered`, `superseded`), `valid_until`, `sent_at`, totals (`net_minor`, `tax_minor`, `total_minor`), `deposit_minor` (2.4); `counter_note`, `counter_total_minor`, `decided_at` (2.5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `quote_line`        | `job_id`, `quote_id`, `position`, `job_task_id` (nullable: null = request-level charge), `catalogue_item_id` (nullable), `description`, `unit`, `quantity_milli`, `unit_price_minor`, `tax_rate_bp`, `net_minor`, `tax_minor`. Composite keys carry `job_id`, so a line prices only a task of its own quote's job                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `appointment`       | `job_id`, `kind` (`site_visit`, `work`), `technician_member_id`, `starts_at`, `ends_at`, `status` (`proposed`, `planned`, `declined`, `done`, `cancelled`), `customer_note`, `answered_at`, `on_the_way_at`. A site visit is `planned` at once; the work's time is `proposed` by the owner and `planned` once the customer confirms it, or `declined` with their note (3.1b). A proposed time holds the technician's slot like a planned one; a newer proposal cancels an unanswered one                                                                                                                                                                                                                                                                                                                      |
| `job_visit`         | The work on site (4.2), one per job: `job_id`, `appointment_id` (the planned work visit), `checked_in_at`, `checklist` (the business's items copied at check-in, each with `done`), `completed_at`, `note`. Who checked in and completed is in the audit. Found through `work.ts`, whose one query also applies the technician's "assigned to me" rule (4.3). Ticks and photos only while the job is `in_progress`; at most 12 before and after photos per job                                                                                                                                                                                                                                                                                                                                                |
| `change_order`      | Work priced after acceptance (4.3, `src/change-order.ts`): `job_id`, `number` (1, 2, … per job), `status` (`draft`, `proposed`, `approved`, `rejected`), totals (`net_minor`, `tax_minor`, `total_minor`, at least 0), `proposed_at`, `decided_at`. At most one `draft` and one `proposed` per job. Never deleted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `change_order_line` | Same shape and `CHECK`s as `quote_line`, with `change_order_id`; composite keys carry `job_id`, so a line prices only a task of its own job                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `invoice`           | The bill for a completed job (4.4, `0011_invoice.sql`, `src/invoice.ts`): `job_id` (one not `void` per job), `number` (per business, from the `invoice_counter` row, which the next number locks: no gaps, no repeats; a voided invoice keeps its number), `status` (`issued`, `paid`, `void`), totals and `line_count`, `issued_at`, `paid_at`, `voided_at`. Never deleted                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `invoice_line`      | A copy of `agreedWork`'s lines (the accepted quote's, then each approved change order's): `job_task_id`, `description`, `unit`, quantity, price, tax rate and amounts, with `quote_line`'s `CHECK`s; no price-list reference. Insert only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `job_photo`         | `job_id`, `object_id` → `storage.object`, `kind` (`request`, `before`, `after`), `job_task_id` (the work item it shows; required for `request`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `review`            | `job_id` (unique), `rating` 1–5, `text`, `status` (`held`, `published`), `owner_response`, `publish_after`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

Rules the database enforces, not just the code:

- **Sent quotes are immutable** (`kk.quote_guard`, `kk.quote_line_guard`, 2.4). A quote is born a `draft`. Lines
  may be inserted, changed or deleted only while their quote is a draft (the line trigger locks the quote `FOR
SHARE`, so a line write and a send wait for each other). Leaving `draft` needs at least one line, and stored
  totals equal to the sums of the lines. After that only `status` moves, forward (2.5): `sent → accepted |
rejected | countered` is the customer's answer, the only write of `decided_at` and the counter columns, and
  is refused once `valid_until` has passed; `sent | rejected | countered → superseded` is the owner's next
  version, status only. **An accepted quote is locked**: nothing on it or its lines changes again. A counter
  names a total (`counter_total_minor`); its note is optional. The runtime role cannot delete a quote. Partial
  unique indexes allow at most one `draft` and one `sent` quote per job.
- **Proposed change orders are immutable** (`kk.change_order_guard`, `kk.change_order_line_guard`, 4.3), as sent
  quotes are: born a `draft`, lines only while a draft, proposing needs lines whose sums are the stored totals,
  then only `proposed → approved | rejected` (status and `decided_at`). The runtime role cannot delete one.
- **The accepted quote belongs to its job.** `job.accepted_quote_id` (added in `0007`) has a composite key to
  `quote (business_id, job_id, id)`; a job from `accepted` to `completed` has one, a job before acceptance none.
- **Line amounts are restated.** `CHECK`s on `quote_line` recompute net and tax with `round(numeric)`, the same
  rule as `lineTotals` (section 8), so a line with wrong arithmetic cannot be stored.
- **No double booking.** `EXCLUDE USING gist (technician_member_id WITH =, tstzrange(starts_at, ends_at) WITH &&)
WHERE (status = 'planned')` (extension `btree_gist`).
- **Invoices are immutable** (`kk.invoice_guard`, 4.4), paid or not. An invoice is born `issued`; after that only
  its status moves: `issued → paid` (with `paid_at`), refused unless the job's recorded payments cover the total,
  and `issued | paid → void` (with `voided_at`), the owner's, audited strictly. At commit a deferred constraint
  trigger (`kk.invoice_lines_match`) checks that the invoice has exactly `line_count` lines whose sums are its
  totals, so a line added later, in any transaction, is refused. The runtime role may only insert and select
  lines (`UPDATE` and `DELETE` revoked) and cannot delete an invoice.
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

| From                    | Event              | To            | Who                                   | Side effects                                                                                       |
| ----------------------- | ------------------ | ------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| —                       | request created    | `requested`   | customer (signed in) or owner (phone) | customer found or created; notify owner and customer (a customer's request only; 9.2)              |
| `requested`             | quote sent         | `quoted`      | owner                                 | quote `draft → sent`; expiry job at `valid_until`; notify customer                                 |
| `requested`             | decline            | `declined`    | owner                                 | notify customer                                                                                    |
| `quoted`                | accept             | `accepted`    | customer                              | quote → `accepted`, `job.accepted_quote_id` set; notify owner (the deposit link is made on Pay, 8) |
| `quoted`                | reject or counter  | `quoted`      | customer                              | quote → `rejected` or `countered`; notify owner                                                    |
| `quoted`                | revise             | `quoted`      | owner                                 | new version `sent`, previous → `superseded`                                                        |
| `quoted`                | close as lost      | `lost`        | owner                                 | —                                                                                                  |
| `quoted`                | edit work items    | `requested`   | customer                              | open quote → `superseded` (an unchanged save does nothing); notify owner                           |
| `accepted`              | work time proposed | `accepted`    | owner                                 | appointment `proposed`; notify customer (`appointment.proposed`)                                   |
| `accepted`              | ask for another    | `accepted`    | customer                              | appointment `declined` with the note; notify owner                                                 |
| `accepted`              | time confirmed     | `scheduled`   | customer, or owner for them (phone)   | appointment `planned`; notify customer and (if the customer confirmed) owner; reminder jobs        |
| `scheduled`             | check in           | `in_progress` | assigned technician or owner          | `job_visit` created with the checklist (`checkIn`, `src/work.ts`)                                  |
| `in_progress`           | complete           | `completed`   | assigned technician or owner          | visit closed, appointment and approved tasks `done`; invoice issued and `invoice.issued` (`bill`)  |
| `requested`…`scheduled` | cancel             | `cancelled`   | owner, or the customer                | appointments cancelled; open payment links cancelled (`cancelJob`, `src/cancel.ts`)                |

- **Quote expiry is computed at request time.** A `sent` quote with `valid_until < now()` is treated as
  expired: accepting it is refused and the customer sees "ask for a new quote". The pg-boss job at
  `valid_until` only notifies the owner. No stored status can be stale.
- Site visits are appointments of kind `site_visit` and do not move the job's state.
- **Agreeing the work's time** (3.1b, `src/schedule.ts`). `planVisit` of kind `work` proposes; the customer
  answers on their request page (`…/visit`, scope `customer`, `answerVisit`: the job is looked up under the
  customer, so another's is 404) by confirming or asking for another time with a note; an owner whose customer
  agreed by phone confirms for them (`confirmVisitFor`). Only a confirmation moves the job to `scheduled`
  (event `schedule`, roles `owner` and `customer`).
- **Tasks and charges.** The customer adds work items on the request form (3.2a), each with a title, details
  and photos; each becomes a `job_task`. A title that names one of the business's active catalogue items (case
  and spacing ignored; the title autocompletes from the price list) is that item, with a known price; any other
  title is a custom task, which the first quote draft lists at 0 for the business to price. A charge is task-level when its line has a `job_task_id`, and request-level (visit fee, discount,
  one lump price) when it is null; one quote can mix both. A task the customer adds before the quote is accepted
  makes a new quote version. After acceptance, the customer's added task is only a request: it is
  `requested` and costs nothing until the business prices it in a change order and the customer approves.
  Invoice lines copy `job_task_id` from the lines they snapshot.
- **The customer's list (D15)** groups jobs by state: **Active** is `requested`, `quoted`, `accepted`,
  `scheduled` and `in_progress`, and `completed` until its invoice is paid (4.4); **Completed** is `completed`
  with a paid invoice; **Cancelled** is `cancelled`, `declined` and `lost`. Active is the default.
- **Change orders (4.3, `src/change-order.ts`).** Work added after acceptance comes two ways: the customer asks
  for more on their job page (`…/more`, scope `customer`, until the job is complete; the owner is told as for an
  edit), or the technician or owner records extra work found on site on the job sheet (while `in_progress`).
  Either is a `job_task` waiting for a price (`requested`; the sheet marks it "do not start"). Only the owner
  prices: `openChangeDraft` starts a draft with a line per waiting task, edited in the quote's editor
  (`/jobs/<id>/change`, no deposit or validity), and sending it makes it `proposed` (its tasks `quoted`) and
  notifies the customer (`change_order.proposed`). The customer approves or turns it down on their job page
  (`…/change`, scope `customer`, `answerChangeOrder`: the job is looked up under the customer, so another's is
  404). Approving makes its tasks `approved` (`done` if the job is already complete); turning it down drops them.
  Change orders are written, sent and answered from `accepted` to `completed`, one waiting at a time, and do not
  move the job's state; and only while the job has no invoice in force (`changeOpen`, 4.4). **What is agreed** (`agreedWork`) is
  the accepted quote's lines plus the approved change orders' lines, and nothing else; the invoice copies it.
- **The bill (4.4, `src/invoice.ts`).** `bill` issues the invoice and tells the customer (`invoice.issued`) where
  a job may have become ready: on completion, on the customer's answer to a change order on a completed job, and
  from the owner's "Issue the invoice". It issues only for a `completed` job with no invoice in force and no change
  order waiting for the customer (then the bill follows their answer). The invoice is a copy of `agreedWork`.
  The owner may void it (a mistake, or extra work to add: change orders open again) and issue a new one; money
  received stays recorded and counts towards it.
- A paid invoice is derived, not a job state. It drives the review request (6.1).
- Each transition is one function, `transitionJob(tx, audit, jobId, { event, actor, acceptedQuoteId?, data? })`
  in `src/job.ts`, backed by the table above (`jobTransition(from, event, role)`; roles `owner`, `technician`,
  `customer`). It locks the job, writes the change and an audit event `job.<event>` (the customer is named by
  the job's `customer_id`), on the caller's transaction; the caller runs its side effects only after it
  succeeds. Outbox messages join it with notify (3.2). 2.5 tests every row of the table and asserts that every
  other state, event and role is refused.
- **Answering a quote** (`answerQuote`, 2.5). The customer answers the version on their page: the form names
  it, and a version replaced or answered since is refused, as is an expired one. Accepting approves the tasks
  the quote prices. A draft the owner left open when the customer accepted stays as it was and can be neither
  saved nor sent.

## 7. Customer access (D15)

Customers have their own account (section 3), but always use it inside one business's space,
`https://kaamkoti.<tld>/b/<slug>/…`, and see only their own jobs with that business, never a list of
businesses. (Until 3.2f customers opened a job by a token link, `/j/<token>`, with no account; 3.2f removed
that path, the `job` token purpose and the owner's "send a new link".)

- **The tradesperson shares the link** `/b/<slug>` (the public page, scope `public-slug`). It opens with the
  app bar (`BusinessHeader`: avatar, business, place; every customer page has it, with a back arrow), then two
  actions above Call and WhatsApp: "New work" (the request form) and "Work list" (the customer's home). Both
  need the customer's sign-in; a customer who is not signed in is sent to sign in first and comes back.
- **Routes** (scope `customer`): `/b/<slug>/requests` is the home, a list of the customer's jobs filtered
  Active, Completed or Cancelled (`?status=`, Active by default; section 6), with "New request";
  `/b/<slug>/request` is the request form (section 10); `/b/<slug>/requests/<jobId>` is the job page. What
  the customer may do there (view, respond to the quote, agree the time, approve a change order, cancel, pay,
  review) follows from the job's state at request time. `/b/<slug>/profile` shows the customer's own name and
  mobile (edited there only, posted to `…/profile/details`) and their address book (`…/profile/address`: add,
  change, delete), and is the one place to sign out.
- **Where and who (3.2g).** The request form's first panel lists the saved addresses (label · name · mobile ·
  address), the last used preselected, and "Somewhere else": name, mobile, address and location, with "Save
  for next time" on by default. A first-time customer sees only those fields, and their entry also becomes the
  customer's own name and mobile. A saved address id that is not this customer's is refused (`address`) on
  send, and answered 404 on Profile.
- **Scope.** Every customer route resolves the business by slug, then the `customer` row for the session's
  identity, inside `withTenant`, and the job query helper adds `customer_id = <that row>`. A job id from
  another customer or another business is answered with 404, the same as a missing one. Tested, with a mutant.
- **The job page** shows the quote first while there is one (`QuoteAnswer`: where it stands, its lines, and
  while it is open Accept, "Offer a different price" and "Turn down", plain forms posting to
  `…/requests/<jobId>/answer`, which runs `answerRequestQuote`: the job under this customer, then
  `answerQuote`). Below it, the request form over the items until a quote is accepted; after that, the items
  with their details and photos (signed URLs).
- **Messages link to the job page** in the space, never to a secret (`requestPageUrl`, on `PUBLIC_ORIGIN`):
  `quote.sent` carries it, and the owner gets the same link to pass on after sending a quote. A wrong number
  or a forwarded message therefore grants nothing: opening the link still needs that customer's sign-in.
- **Forms post with the customer cookie**, so they need CSRF protection: the cookie is `SameSite=Lax`, and
  every customer route handler also refuses (403) a post that `fromOwnPages` (guard.ts) does not accept:
  `Sec-Fetch-Site` must be `same-origin`, and only a browser that sends no `Sec-Fetch-Site` is judged by
  `Origin` (the bare domain). `Origin` alone cannot do it: under the app's `Referrer-Policy: no-referrer` a
  browser sends `Origin: null` even on a same-origin form post. A post without a session gets a 303 to
  sign-in (never a 307, which would re-post the form there). Answers are a 303 back to the page with
  `?answer=<outcome>`, as before. The browser check proves the refusals for send, sign-out and the quote answer, with mutants.
- **Lapsed business** (section 13): the space still opens after sign-in, but shows a contact card and allows no
  actions.
- **`tokens` keeps one purpose, `invite`.** The token is 32 random bytes in base64url; only its SHA-256 is
  stored, in `tokens.token`: `hash`, `purpose`, `business_id`, `subject_id`, `expires_at`, `revoked_at`. It
  sits in the path; Caddy writes no access logs, and pages set `Referrer-Policy: no-referrer`.

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
- **Wiring in Kaam Koti (4.1b).** The owner connects Razorpay at `/settings/payments` (key id, key secret,
  webhook secret; only the key id is shown back) and is given the webhook address,
  `PUBLIC_ORIGIN/hooks/razorpay/<businessId>` (scope `provider-webhook`: 401 unless the body's signature verifies
  under that business's secret). `PAYMENTS_SEALING_KEY` seals the secrets; `RAZORPAY_API` points development at
  a local stand-in. The **deposit** (`src/deposit.ts`) is the accepted quote's `deposit_minor`, less what was
  received for the job. The customer's job page shows it while the job is `accepted`, `scheduled` or
  `in_progress`; "Pay" posts to `…/requests/<jobId>/pay` (scope `customer`, the job under that customer), which
  makes the link then, or reuses the open one, and answers a 303 to Razorpay. Razorpay returns the customer to
  the page with `?pay=back`, which proves nothing. The link is made on Pay, not inside the acceptance, so a
  Razorpay outage never blocks accepting a quote. A business without Razorpay gets no link; its customer pays
  directly. The webhook queues `payment.received` to the owner in the recording transaction. Cancelling a job
  cancels its open links at Razorpay first; if Razorpay refuses, the cancellation rolls back.
- **Paying the bill (4.4, `src/invoice.ts`).** Due = the invoice's total − everything received for the job,
  deposit included, never below 0. `settleInvoice` marks it `paid` in the transaction that records a payment
  covering it: the webhook route calls it after recording, `recordCash` after the owner's entry, `issueInvoice`
  at once if the deposit already covered the bill. The customer's job page shows the bill (`InvoicePay`) in place
  of the deposit; "Pay" posts to `…/requests/<jobId>/bill` (scope `customer`, the job under that customer,
  `payInvoice`), which reuses an open bill link for exactly what is due, else cancels every open link (a stale
  deposit link, a bill link since part-paid in cash) and makes one, so the customer cannot pay twice. Under ₹1
  left is settled directly. **Cash** (`recordCash`, the owner's job page, from acceptance to completion) is at
  most what is owed: the invoice's due, or before it the agreed total less what was received. It cancels the
  job's open links, whose amounts no longer match. Voiding cancels open bill links.

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

One exception is needed, and only for a person waiting on a page: an **answered call** (`billing.checkout`,
5.1a) is signed the same way on the same path, `/internal/v1/<name>`, but not queued. Platform answers it at once
(a checkout page to send the owner to); if platform is down the app says so and the person tries again. Each
call is safe to repeat. Platform → app messages go through platform's own outbox to the one product app it is
configured for (`EVENTS_CLIENT`, `EVENTS_URL`), signed as client `platform` with that app's shared secret, at
`/internal/v1/<topic>`.

### 9.2 Notify (platform)

- The app sends `notify.send` with `{ businessId, template, to: { identityId?, phone?, email? }, vars }`
  (`@bodhchakra/notify`). A customer is given the addresses on their row; an owner is named by `identityId`
  (the `sub`), and platform uses that identity's verified email and phone, so members' addresses never leave
  platform (3.2b, 3.3d). A customer's message also names the owner (`owner`), whom platform tells when the
  quota leaves that customer with nothing (below). The product is the signed client id, not a field, so an app reaches only its own
  templates. `vars` are display strings the app formatted (money, dates in the business's time zone). A locale
  joins when a second language does. Platform picks the channel: WhatsApp if there is a phone and quota left,
  otherwise email. SMS comes later. No address on any channel there is records the message as `no_channel`.
- Templates live in `services/platform/src/templates/<product>.ts`, each with its variables' schema and one
  version per channel. WhatsApp templates mirror the ones Meta has approved (D7, 3.3). An unknown template or
  bad variables are refused (500), so the app's outbox retries and then alerts.
- `notify.message` keeps the recipient for retries and status (`queued`, `sent`, `failed`, `no_channel`) and is
  purged after 30 days: the daily job `notify.purge` (a `jobs` schedule) calls `notify.purge_messages()`, a
  definer function, since the runtime role has no DELETE on the table. It has no RLS: only notify's code reaches it, by id. The send job retries ten
  times over about four hours, then marks the message `failed` and logs an alert. Each outcome is an
  `audit.event` (`notify.sent`, `notify.failed`, `notify.no_channel`) in the business's log. Logs and audit
  carry the message id and template, never the recipient, the text or a provider's error text (it can quote
  the address); a failed send logs nodemailer's code only.
- Kaam Koti's worker (`src/worker.ts`) delivers the outbox; the web only queues (`sendOnly` jobs). The app's
  messages are queued by `Notices` (`src/notices.ts`), each in the transaction of its change; a sent quote also
  queues `kaamkoti.quote_expiry` at its `valid_until`, which the worker runs (section 6).
- WhatsApp is Meta's Cloud API (D7, 3.3a). Only templates with a WhatsApp version go there (every Kaam Koti
  template has one since 3.3d; the owner's end "replies here are not read"); each version holds the body submitted to Meta, with
  `{{n}}` placeholders, and is sent by name with its parameters. The channel is off until all its settings are
  given (no Meta account in development).
- The WhatsApp quota (`notify.quota`) counts per (product, business, UTC calendar month) when a message is queued
  for WhatsApp, with top-ups (5.2); until plans carry it (5.1) it is platform config. Over quota falls back to
  email. If there is no email, the message is `no_channel` and the owner is told by `notify.quota_used`, once per
  business and month (`notify.quota.owner_told`, set under the row's lock), on any channel and not counted
  against the quota. A member's email and phone are used only if verified: an identity made by phone has a
  placeholder email (section 3).
- Meta's status webhook reaches `hooks.` at `/hooks/whatsapp`, verified by `X-Hub-Signature-256` (HMAC of the
  raw body with the app secret); a bad signature is 401. `delivered`/`read` mark a sent message `delivered`;
  `failed` marks it `failed`, audited, with Meta's numeric code logged. Each change is guarded by the status it
  comes from, so a replay changes nothing. The message stores Meta's id (`provider_id`) to be found by it.

| Template                                                                  | To                                              | When                                                |
| ------------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------- |
| `request.received`, `request.acknowledged`                                | owner; customer (linking to their request page) | a customer sends a request (not a phone entry)      |
| `request.edited`                                                          | owner                                           | the customer saves a change to the request          |
| `quote.sent`                                                              | customer                                        | quote sent or revised                               |
| `quote.response`                                                          | owner                                           | accepted, rejected, countered                       |
| `quote.expired`                                                           | owner                                           | a sent quote is still unanswered at its expiry      |
| `appointment.proposed`                                                    | customer                                        | the owner proposes the work's time (3.1b)           |
| `appointment.response`                                                    | owner                                           | the customer confirms it or asks for another        |
| `appointment.confirmed`, `appointment.reminder`, `appointment.on_the_way` | customer                                        | planned; 24 h before (3.3b); tapped by the owner    |
| `change_order.proposed`                                                   | customer                                        | owner sends a change order for approval             |
| `invoice.issued`, `payment.received`                                      | customer; owner                                 | invoice issued (4.4); a payment recorded by webhook |
| `review.request`, `review.held`                                           | customer; owner                                 | invoice paid; low rating                            |

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
  `/b/[slug]/request/send` (scope `customer` since 3.2f; `public-intake` before), not a server action like the app's other forms. It has to
  answer 429 and 413 and take six photos, and a server action can do neither. The proxy cannot limit it, because
  it buffers bodies only to 10 MB. Limits: 10 per IP per hour, then 200 per business per day, counted in that
  order. Since 3.2a the form is the same for every trade: name, mobile, address (since 3.2f the form needs the
  customer's sign-in; the email comes from the session, and name, mobile and address are prefilled from the
  customer's own row in that business, empty on a first request; the row is created or kept current on send,
  and a mobile on another customer's row is refused, see `customer` in 5.3) (with an optional "Use my
  location", the browser's own geolocation; nothing is sent to a map service), and one or more work items
  (fields `item.<n>.title`, `item.<n>.details`, `item.<n>.photo`). Up to 20 items and 6 photos in all; each
  photo belongs to its item. A client component switches between the request and one item's editor; every
  item's fields stay in the one multipart post. On success the customer is sent to their work list
  `/b/<slug>/requests` (since 3.2f; a fresh `/j/<secret>` before), whose cards open the job page
  `/b/<slug>/requests/<jobId>` (section 7). The owner's job
  page opens a picked location in Maps by a plain link. The trade template has no intake questions (removed in
  3.2c); the work's time is agreed after acceptance on the request page (3.1b,
  section 6).

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

| Module             | Public API                                                                                                                                                 | Tables                                                                           | Step |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---- |
| `config`           | `defineConfig(zodSchema)` → frozen typed config; throws on start-up                                                                                        | —                                                                                | 0.2  |
| `log`              | `createLogger({ service })`, `withRequestId`; redacts keys such as `phone`, `email`, `token`, `authorization`, `secret`                                    | —                                                                                | 0.2  |
| `db`               | `createPool(cfg)`, `tx(fn)`, `withTenant(id, fn)`, `migrate([...folders])`, `testDb()` (fresh database per test file)                                      | `db.migration`                                                                   | 0.3  |
| `tenancy`          | `createBusiness`, `addMember`, `createInvite`, `acceptInvite`, `memberFor(identityId)`, `requireRole`, `defineRoute({ scope, … })`, route-scope test kit   | `tenancy.*`                                                                      | 0.4  |
| `audit`            | `record(tx, event)`, `recordStrict(tx, event)`                                                                                                             | `audit.event`                                                                    | 0.4  |
| `tokens`           | `signRequest`, `verifyRequest` (0.5); `issue`, `resolve`, `revoke` for invite links (0.7; job links 2.1–3.2f)                                              | `tokens.token`                                                                   | 0.5  |
| `jobs`             | `createJobs(pool)`, `defineJob(name, zodPayload, handler)`, `send(tx, …, { startAfter })`, `schedule(type, cron, payload)` (3.2b)                          | `pgboss.*`                                                                       | 0.5  |
| `outbox`           | `enqueue(tx, topic, payload, key)`, `startDelivery`, `receive(source, key, tx, fn)`                                                                        | `outbox.message`, `outbox.inbox`                                                 | 0.5  |
| `auth` (app side)  | `createAuth(options)` → `startLogin`, `handleCallback`, `getSession`, `signOut`; `SignInRefused`, `SignInUnavailable`                                      | `auth.login_attempt`, `auth.session`                                             | 0.6  |
| `storage`          | `checkImage(bytes)`, `createStorage(cfg)` → `putImage(tx, image, by)`, `signedUrl(object)`; `remove` comes with its first use                              | `storage.object`                                                                 | 2.2  |
| `rate-limit`       | `redisLimiter(url, log)` → `limit(key, rule)`, `close()`                                                                                                   | — (Redis)                                                                        | 2.2  |
| `money`            | `money(minor, cur)`, `lineTotals(lines, cur)`, `formatMoney`, `minorDigits`, `parseDecimal`, `formatDecimal`                                               | —                                                                                | 2.4  |
| `notify` (client)  | `send(tx, message, key)`, through the outbox; a member is addressed `to: { identityId }` (3.2b)                                                            | — (server tables in platform)                                                    | 3.2  |
| `payments`         | `connectAccount`, `connectedAccount`, `createPaymentLink`, `cancelLink`, `linksFor`, `paidFor`, `recordManual`, `handleWebhook(db, req, onEvent)` (README) | `payments.account`, `payments.link`, `payments.payment`; dedup in `outbox.inbox` | 4.1  |
| `billing` (client) | `status(businessId)` → `{ plan, live, limits }`, `assertWithin(limit)`, event handler for status updates                                                   | `billing.status`                                                                 | 5.1  |

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
- **Trial and checkout (5.1a):** the app registers a new business (`billing.register`, outbox), which opens a
  Team trial (D9) on the owner's account. The owner's checkout (`billing.checkout`, an answered call) makes a
  Razorpay subscription on the platform's account for the plan and seats, first charged at the trial's end, and
  returns its authorisation page; a new checkout cancels one never authorised. Razorpay's webhook at
  `hooks.…/hooks/razorpay` maps `activated`/`charged` → `active` (plan and seats from the event, `paid_through`
  from its period end, never moved back), `pending`/`halted` → `past_due`, `cancelled`/`completed` →
  `cancelled`. Events older than the last applied are ignored. The rules are in `packages/billing/README.md`.
- **In the app:** `billing.status` is a local copy, updated by signed `billing.status_changed` events. It is
  applied only if its `version` is newer, so an old event can never undo a new one.
- **Live is computed at request time:** `live = (trialing and now < trial_ends_at) or now < paid_through + 3
days grace`. Nothing is stored that can go stale, and a platform outage changes nothing.
- **Lapsed:** the public page and the customer space show a contact card (name, phone, WhatsApp link) and accept
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
