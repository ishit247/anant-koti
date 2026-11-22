# Trade Services: development plan and tracker

What we are building: [product-brief.md](product-brief.md). Shared modules:
[platform-modules.md](platform-modules.md). The design is in [architecture.md](architecture.md);
its first table says which sections each step reads.

**Current position:** Step 3.2a done (2026-11-22). Next: step 3.2b (STANDARD: the remaining notify messages and
the 30-day purge), best in a fresh session; 3.1b, 3.2c and 3.2d wait in the table. UI refresh (2026-11-22, asked:
"looks like a school project"): new tokens and building blocks (hero, panel, tile, sheet, dock, photo drop,
inline SVG `Icon`) recorded in docs/ui-guidelines.md, with the request form as the reference screen; the owner
screens and `/j/` move to the new layout in 3.2d. Step 3.2a (asked by the user, from a
sketch): the public request form is generic. Name, mobile, address with "Use my location" (browser geolocation;
`job.latitude`/`longitude`, both or neither; the owner's page opens it in Maps by a link), and work items, each
with a title autocompleting from the price list (`datalist`), details and photos. A title naming an active
catalogue item (case and spacing ignored) is that item at its price; any other is a custom task that the first
quote draft lists at 0 for the owner to price. Migrations edited in place: `0004` drops `answers` and
`preferred_window`, `0005` adds `job_task.details`, `0006` adds `job_photo.job_task_id` (composite key to a task
of the same job; required for `request` photos). `src/intake.ts` reads `item.<n>.title|details|photo`;
`workItems` in `src/job.ts` feeds `/j/` and `/jobs/[id]` through the shared `WorkItems` component; the form is
the client component `request-form.tsx` (two views toggled with `hidden`; new `.stack` class and a global
`[hidden]` rule). The trade questions are no longer asked (3.2c) and the preferred time moves to 3.1b. Also
fixed: `jobs` and `outbox` built their migrations URL the way the web bundler cannot resolve (as `audit` once
did), so every page answered 500 since 3.2; and a dev server started before 3.2 kept a cached `server()` without
`notify` (restart the dev server after such a change). Verified: `validate standard`, `up:fresh` (31 s), 3
mutants killed (photo-needs-item check removed; hidden items matched; photo limit per item instead of per
request), `check:browser` with the new form flow (no item refused, price shown, custom item, Back discards,
details and photo on `/j/`) and the step-3.2 quote send now clicked through, at 375 px and 1280 px, screenshots
viewed. "Use my location" was not exercised (headless browser has no position). Step 3.2 (split: 3.2b added): `@bodhchakra/notify` (client:
`createNotify(outbox).send(client, message, key)`, schema `notifyMessage`; the product is the signed client id).
Platform: `src/notify.ts` (topic `notify.send` → `notify.message` + `notify.deliver` job in the inbox's
transaction; email by SMTP, 10 attempts over ~4 h, then `failed` and an error log; `no_channel` without an email;
audit `notify.sent|failed|no_channel`; logs carry id, template and nodemailer's code only), templates in
`src/templates/kaamkoti.ts` (`quote.sent`), migration folder `notify`, platform now also migrates `audit` and
`jobs`; config `NOTIFY_EMAIL_FROM`. `jobs`: `sendOnly` and `send` waits for `start`. Kaam Koti: `src/worker.ts`
(`pnpm --filter kaamkoti dev:worker`, needs `SERVICE_SECRET`) delivers the outbox; the web queues only;
`noticeQuoteSent` in `src/notices.ts` is called by the send-quote action. Verified: `validate quick`, tests of
jobs/outbox/notify/platform/kaamkoti on real Postgres (187), one mutant (rethrowing the provider's error, which
quotes the address) killed by the log test; end to end after `up:fresh`: a queued `quote.sent` went app outbox →
worker → platform → Mailpit. The quote editor was NOT clicked through in a browser. Earlier, step 3.1: migration `0008_appointment.sql` (`kk.appointment`; `EXCLUDE USING gist`
on technician and time range for planned visits, so a double booking is refused by the database; no delete for the
app role) and `unique (business_id, id)` added to `tenancy.member` in place. `src/schedule.ts`: `planVisit` (a
`work` visit needs an `accepted` job and moves it to `scheduled` through `transitionJob`; a `site_visit` is allowed
while the job is open and moves nothing; conflict caught in a savepoint, audited `appointment.planned`), `moveVisit`
(`appointment.moved`), `plannedVisits`, `assignableMembers`; times are typed in the business's time zone. Owner's
`/jobs/[id]` has a "Visits" list and a plan form. Seed: one site visit for Sharma #1; Kaveri #3 stays unplanned.
Verified: `validate quick` and 9 tests on real Postgres, one mutant (overlap operator `&&` → `=`) killed by 3
tests; the form was NOT checked in a browser and there is no cross-business `/schedule` day view yet, and no
cancel-appointment or reschedule-the-job's-work screen (a visit can be moved). Earlier, phase 2 done (`validate full` green, tag `phase-2-done`). Negotiation: the job state machine in `src/job.ts`
(`jobTransition` is section 6's table; `transitionJob` locks the job, moves it and audits `job.<event>`, naming
the customer when they act by link; `sendQuote` now moves the job through it, `quote_sent` or `revise`, so the
old `quote.sent` audit is `job.quote_sent`). `answerQuote` in `src/quote.ts`: the customer answers the version
on their page; replaced, already answered, expired and draft versions are refused; accept sets
`job.accepted_quote_id` and approves the priced tasks; `saveDraft` refuses once the job is past quoting.
Migration `0007` (edited in place): `decided_at`, `counter_total_minor` (required for a counter),
`counter_note`; `quote_guard` allows only `sent → accepted|rejected|countered` (answer columns only, refused
past `valid_until`) and `sent|rejected|countered → superseded`; **an accepted quote is locked**;
`job.accepted_quote_id` with a composite key to a quote of the same job and `CHECK`s tying it to the job's
state. Customer side: route handler `/j/[secret]/answer` (scope `customer-token`, 16 KB body, 303 back with
`?answer=`), `resolveJobLink`, `readAnswerForm` in `src/quote-form.ts`; `/j/` shows Accept, and "Offer a
different price" / "Turn down this quote" as `details` disclosures (no JavaScript; new building block in
ui-guidelines.md). Owner's `/jobs/[id]` shows the answer and counter, `quoteTone` colours the quote chip.
Seeds: Kaveri #3 negotiated v1 countered → v2 accepted. Handed on: deposit link on accept (4.x), owner's
notice of an answer (3.2), decline / close as lost / cancel buttons (they are in the table, no screen yet).
Verified: `validate standard` (kaamkoti 130 tests), `up:fresh` (6.7 s), 8 mutants killed (accepted quote
supersedable; guard without expiry; answer may change other columns; accepted-quote key not composite; accepted
job without quote; answer to a non-sent quote; quote of another job; transition ignoring the role),
`check:browser` extended with counter → owner sees it → revise → customer accepts → no revision offered, at
375 px and 1280 px, screenshots viewed. Note: after `up:fresh` restart the platform container, or sign-in fails
with "client not found" (its client is registered at boot). Step 2.4 before it: `@bodhchakra/money` (foundation): `lineTotals` in `BigInt` with line-level rounding, halves
away from zero; `formatMoney`, `minorDigits`, `parseDecimal`/`formatDecimal` (the catalogue form now uses them);
`currentBusiness` returns `currency`. Quotes: migration `0007_quote.sql` (`kk.quote`, `kk.quote_line`; `job_task`
gained `unique (business_id, job_id, id)` in place), triggers `quote_guard` (born a draft; leaving draft needs
lines whose sums are the stored totals; after that only `status` changes) and `quote_line_guard` (lines change
only on a draft, `FOR SHARE` on the quote); `CHECK`s restate line rounding; no delete on `quote` for the app role.
`src/quote.ts`: `openDraft` (first draft prefilled from the tasks at price-list prices, a revision copies the
latest version), `saveDraft`, `sendQuote` (supersedes the version out, job and tasks → `quoted`, audited
`quote.sent`), `ownerQuotes`, `customerQuote` (newest sent only; expiry computed at read). Edge `src/quote-form.ts`.
Pages: quote section on `/jobs/[id]` ("Write a quote" / "Revise the quote"), editor `/jobs/[id]/quote` (save or
send in one transaction; send issues a fresh customer link shown with `ShareLink`), `/j/` shows the sent quote
(`QuoteSummary`, `.lines` in globals.css). Seeds: Sharma #2 has a sent quote with a discount line (job `quoted`),
Kaveri #2 a draft; task ids fixed. Handed on to 2.5: accept/reject/counter, `transitionJob`, `decided_at` and
counter columns (add them to `0007` and to the guard's allowed columns), `job.accepted_quote_id`; the owner's
expiry notice waits for notify (3.2). Verified: `validate standard` (286 tests; money 36, kaamkoti 101),
`up:fresh` (6.4 s), 6 mutants killed (line trigger off; sent quote columns editable; totals-vs-lines check off;
task of another job with both the app check and the composite key removed, and the key alone shown to refuse;
customer view showing drafts; rounding half toward zero), `check:browser` extended with write → refused deposit
→ send → customer reads the quote → revise offered, at 375 px and 1280 px, screenshots viewed. Step 2.3 before
it: owner inbox: `src/inbox.ts` (`listInbox`, `ownerJob`, `logPhoneEnquiry`,
`reissueJobLink`, `countNewRequests`), pages `/jobs`, `/jobs/[id]`, `/jobs/new` (scope `member`, owner only; the
id in the path is read inside `withTenant`, so another business's id is a 404). Phone enquiries reuse the
intake's customer and job rules (`source = 'phone'`, tasks `added_by = 'business'`); a new link revokes the old
ones and is audited (`job.logged`, `job.link_reissued`; `server().audit` is new). Mobile-first UI refresh: design
tokens and cards in `globals.css`, a fixed bottom tab bar (`OwnerNav`: Home, Requests, Prices), `ShareLink`
(copy and WhatsApp) shared by the invite, the public page and the re-sent link; home shows the new-request
count and the public-page link. `@bodhchakra/audit` now builds its migrations path like storage does, so the web
bundler accepts it. Verified: `validate standard` (77 kaamkoti tests), 2 mutants killed (no revoke on re-send;
cross-business catalogue item accepted), `check:browser` extended with the inbox flow, at 375 px and 1280 px,
screenshots viewed. Step 2.2 before it: request intake: `@bodhchakra/storage` (`checkImage` by magic bytes, re-encode strips EXIF, 2048 px;
`putImage`, `signedUrl`; `storage.object`), `@bodhchakra/rate-limit` (moved out of platform), Garage in the dev
stack (`kaamkoti-private`, web key read+write only, set up by `pnpm run up`). Public form `/b/[slug]/request`
posts to the route handler `…/request/send` (scope `public-intake`; a route handler, not a server action, to
answer 429/413 and take 6 photos; see architecture.md 10); success redirects to a fresh `/j/<secret>`, which now
lists the tasks and shows the photos by signed URL. `/j/` is limited in `src/proxy.ts`. Migrations: `job`
gained `answers`, `address`, `preferred_window` (edited in place), new `0005_job_task.sql` (brought forward from
2.4), `0006_job_photo.sql`. Seeds: Sharma asks the template's questions, Kaveri none; every job has tasks.
Handed on to 2.3: the owner's view of requests and photos (`signedUrl` for the owner), `S3_PUBLIC_ENDPOINT` for
production. Verified: `validate standard`, 7 mutants killed, `up:fresh` (7 s), browser check (form, refused
submit, photo request, 429 on intake and `/j/`) at 375 px and 1280 px. Step 2.1 before it: customer job links: `kk.job` (migration
`0004_job.sql`; a composite foreign key keeps a job on its own business's customer), `src/job-link.ts`
(`issueJobLink`, `revokeJobLinks`, `openJobLink`) and the page `/j/[secret]` (scope `customer-token`, no cookies). Design
change, recorded in architecture.md 7: **a new link per message**, live 30 days, because a hashed secret cannot be
resent; `tokens.extend` and the unused `actions` column are gone, `tokens.revokeFor` is new. Seeds: two jobs per
business and one fixed dev link each (`dev-job-link-sharma-request-1-…`). Handed on: the per-IP rate limit to 2.2, the
owner's revoke-and-resend button to 2.3. Verified: `validate standard` (175 tests), 5 mutants killed, `up:fresh`,
browser check. Phase 1 done before it (tag `phase-1-done`): `pnpm run check:browser` (`scripts/browser-check.ts`,
Playwright) covers sign-in → signup → onboarding → price edit → public page → job link, at 375 px and 1280 px.
Step 1.4 before it: the `ac_repair` template in `src/seed-templates.ts` has 12 catalogue items, 7 intake questions, a
7-item checklist and fuller terms. Step 1.3 before it: public page `/b/[slug]` (scope `public-slug`, no cookies) built by
`src/public-page.ts` from the slug, the business row, its profile and its active price-list items; unknown slug or a
business not yet onboarded gives 404. It shows Call and WhatsApp; the "request a job" button and the reviews slot wait for
steps 2.2 and the reviews step, as their routes do not exist yet. Checked by 3 database tests and `quick` (typecheck,
routes test). Step 1.2 before it:
`kk.business_profile`, `kk.catalogue_item`, owner pages `/onboarding` and `/catalogue`. Phase 0 is closed (tag
`phase-0-done`). Design change (2026-11-21, docs only): a request has
tasks (`job_task`), and charges sit at task or request level; see architecture.md 5.3 and 6.

Steps marked with a `[module]` build or extend a shared module in `packages/`. Those steps
also write the module's README, and their tests run through the module's public API.

## How to work this plan across sessions

1. Start each session by reading `CLAUDE.md`, this file's "Current position", and the
   current phase's steps. Read code only where the step needs it.
2. Check the step's **Model** against the model the session is running on. If a HIGH step
   is about to start on a STANDARD model, stop and say so before any work.
3. Mark the step `doing`, build it, validate it, then mark it `done` and update
   "Current position" **in the same commit**.
4. After two substantial steps in one session, commit and start a fresh session.
5. Ask the user only about a Decisions entry, and only when the step that needs it is
   reached. Record the answer in the table.

**Status:** `todo` · `doing` · `done` · `blocked (reason)`
**Size:** S = under half a session · M = about one session · L = two or more sessions (split it before starting)
**Model:** **HIGH** = Opus or Fable: money, tenant isolation, auth, webhooks, tokens, uploads. STANDARD = Sonnet: screens, templates, routes that follow an existing pattern, docs.

## Decisions

| #   | Question                                                   | Recommendation                                                                                                                      | Needed by | Answer                                                                                                  |
| --- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------- |
| D1  | Product name and domain                                    | —                                                                                                                                   | 0.1       | **Kaam Koti** (2026-11-21); domain still to choose, needed by 6.3                                       |
| D2  | First launch market                                        | India first (UPI, WhatsApp, ₹ plans); global follows on the same codebase                                                           | 0.1       | India first (2026-11-20)                                                                                |
| D3  | Stack                                                      | Same as Profile Builder: Next.js (TypeScript), PostgreSQL 17, pg-boss, Docker Compose on own VPS, Cloudflare                        | 0.1       | As recommended (2026-11-20)                                                                             |
| D4  | How code is reused across apps                             | Shared modules per [platform-modules.md](platform-modules.md)                                                                       | 0.1       | Shared modules (2026-11-20), replacing "copy code"                                                      |
| D5  | Payment provider: customer payments                        | Razorpay (India) with UPI; Stripe when global                                                                                       | 4.1       |                                                                                                         |
| D6  | Payment provider: subscriptions                            | Same provider as D5, to keep one webhook path                                                                                       | 5.1       |                                                                                                         |
| D7  | WhatsApp provider                                          | Meta Cloud API directly; a BSP only if onboarding blocks                                                                            | 3.3       |                                                                                                         |
| D8  | Technician app form                                        | PWA (installable, offline cache); native app only if the PWA falls short                                                            | 7.3       |                                                                                                         |
| D9  | Trial length, and plan prices for launch                   | 14-day Team trial; Solo ₹399, Team ₹1,199/seat                                                                                      | 5.1       |                                                                                                         |
| D10 | Repo layout                                                | New `e:\bodhchakra\platform` monorepo                                                                                               | 0.2       | This folder (`e:\bodhchakra\idea`) is the monorepo; rename it later (2026-11-21)                        |
| D11 | Do existing apps (Profile, School, POS) adopt the modules? | Yes, one module at a time when work touches that area; no big-bang migration; moving into the monorepo is decided per app           | 0.1       | Gradual; the platform owns `@bodhchakra/*` (2026-11-21)                                                 |
| D12 | One login and one bill across products                     | Not now                                                                                                                             | 0.1       | **Yes, plan for it** (2026-11-21): identity and billing account in `platform`, from phase 0 and phase 5 |
| D14 | Single sign-on mechanism across product domains            | Platform is an OpenID Connect provider (authorization code + PKCE); each app keeps its own session cookie on its own domain         | 0.1       | As recommended (2026-11-21)                                                                             |
| D13 | Auth core                                                  | Wrap `better-auth` (already used in Profile) inside `@bodhchakra/auth`, so apps never import it directly; less security code to own | 0.5       | As recommended (2026-11-21)                                                                             |

## Phase 0: Foundations

| Id   | Step                                                                                                                                                                                                                                             | Size | Model    | Status | Done when                                                                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | -------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.1  | Architecture doc: domains, data model, tenancy, job state machine, money model, notification model, each module's API and tables                                                                                                                 | M    | HIGH     | done   | `docs/architecture.md` covers every MVP stage and module boundary; D1, D10–D12 answered                                                            |
| 0.2  | Monorepo skeleton (pnpm, turbo); lint, typecheck, `pnpm run validate quick\|standard\|full`; dependency-direction and public-API-only checks; `[module]` `config`, `log`                                                                         | M    | STANDARD | done   | `validate quick` green; an import of a module's internals fails the check                                                                          |
| 0.3  | Compose on the shared [../infra](../../infra) pattern; `[module]` `db` (migration runner applying module migrations then app migrations, tenant context, test helper); `up:fresh`; seeds with 2 businesses and customers                         | M    | HIGH     | done   | `up:fresh` rebuilds everything in under a minute                                                                                                   |
| 0.4  | `[module]` `tenancy` and `audit`: business, members, roles (owner, technician), RLS, route scope declarations and a test that enumerates them                                                                                                    | M    | HIGH     | done   | Cross-business read and write tests fail closed; mutant proves the test                                                                            |
| 0.5  | `platform` container skeleton: service tokens, internal network, health check, its own database; `[module]` `tokens` (request signing), `jobs` (pg-boss) and `outbox` for app ↔ platform calls                                                   | M    | HIGH     | done   | App call with a bad or expired service token is refused; outbox delivers once after `platform` restarts                                            |
| 0.6a | Identity in `platform` (D13, D14): better-auth with `@better-auth/oauth-provider` and `jwt` in the `identity` schema; email OTP (phone moved to 3.3); Redis rate limits; sign-in page; Kaam Koti registered as a first-party confidential client | M    | HIGH     | done   | A test runs authorization code + PKCE over HTTP and verifies the ID token against JWKS; a wrong verifier, redirect URI or client secret is refused |
| 0.6b | `[module]` `auth` client in the app: `auth.login_attempt`, `auth.session`, `startLogin`, `handleCallback` (`jose`), `getSession`, `signOut`; links the identity to a local member                                                                | M    | HIGH     | done   | One identity signs in to Kaam Koti; a forged or replayed sign-in response is refused; mutant proves it                                             |
| 0.7  | App flow: owner signup creates the business; invite a technician (`tenancy.invite` on `tokens`); the app's route test runs `scanRoutes` over its routes                                                                                          | S    | STANDARD | done   | Signup, login and invite work in the browser at 375 px and desktop width                                                                           |

## Phase 1: Trade templates and the public page

| Id  | Step                                                                                             | Size | Model    | Status | Done when                                                      |
| --- | ------------------------------------------------------------------------------------------------ | ---- | -------- | ------ | -------------------------------------------------------------- |
| 1.1 | Trade template model: catalogue, units, intake questions, checklist, terms (typed JSON with Zod) | M    | STANDARD | done   | One template seeds; invalid template JSON is rejected at write |
| 1.2 | Onboarding: pick a trade, edit catalogue and prices                                              | M    | STANDARD | done   | New owner reaches a usable catalogue in under 5 minutes        |
| 1.3 | Public business page (profile, services, reviews slot, "request a job")                          | M    | STANDARD | done   | Page renders without cookies on the public domain              |
| 1.4 | First ready-made template (AC/appliance repair)                                                  | S    | STANDARD | done   | Template is selectable at onboarding                           |

## Phase 2: Requests and quotes

| Id  | Step                                                                                                                                                                                                                         | Size | Model    | Status | Done when                                                                                                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | -------- | ------ | ------------------------------------------------------------------------------------------------------------------ |
| 2.1 | `[module]` `tokens` links; customer magic links: scoped to one job, expiring, revocable                                                                                                                                      | M    | HIGH     | done   | A token cannot read another job; expired token is refused; mutant proves both                                      |
| 2.2 | `[module]` `storage`; request intake: public form (pick one or more catalogue tasks), trade questions, photo upload (type and size checks, private storage); the app's per-IP rate limiter, for intake and for `/j/` lookups | M    | HIGH     | done   | Upload rejects wrong types and sizes; photos are not publicly listable; intake and `/j/` answer 429 past the limit |
| 2.3 | Owner inbox: new requests, log a phone enquiry; a link to the owner's public page from home; on a job, "revoke links and send a new one" (`revokeJobLinks` + `issueJobLink`, audited)                                        | S    | STANDARD | done   | Both request sources appear in one list                                                                            |
| 2.4 | `[module]` `money`; quotes (`job_task` came in 2.2): lines from the catalogue at task or request level, versions, expiry                                                                                                     | M    | HIGH     | done   | Totals and tax are tested; old versions are immutable                                                              |
| 2.5 | Negotiation: customer accepts, rejects or counters; owner revises; accepted quote locked                                                                                                                                     | M    | HIGH     | done   | State machine test covers every transition; a locked quote cannot be edited                                        |

## Phase 3: Scheduling and notifications

| Id   | Step                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Size | Model    | Status | Done when                                                                                                                                  |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | -------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 3.1  | Scheduling: slots, technician assignment, conflict check                                                                                                                                                                                                                                                                                                                                                                                                                                | M    | STANDARD | done   | Double-booking a technician is refused                                                                                                     |
| 3.2  | `[module]` `notify`, served from the shared `platform` container through the outbox: templates, email channel, retries, audit log                                                                                                                                                                                                                                                                                                                                                       | M    | STANDARD | done   | A failed send retries and is logged without personal data                                                                                  |
| 3.2a | Generic request form (asked 2026-11-22): name, mobile, address with an optional "Use my location" (browser geolocation, stored as `job.latitude`/`longitude`, opened by the owner in Maps), and work items: a title that autocompletes from the price list (a matching title is that item at its price, any other is priced by the business in the quote), details and photos per item (`job_task.details`, `job_photo.job_task_id`). Trade questions and preferred time leave the form | M    | HIGH     | done   | A request carries several work items, each with its own details and photos; a price-list title is priced, any other is quoted by the owner |
| 3.1b | Agreeing the time: after acceptance the owner proposes a date and time, the customer confirms or asks for another by their link (replaces the form's old "preferred time")                                                                                                                                                                                                                                                                                                              | M    | STANDARD | todo   | A proposed time becomes the planned work visit only once the customer confirms it                                                          |
| 3.2c | Decide the trade template's intake questions (no longer asked on the request form since 3.2a): remove them from templates and `business_profile.intake`, or bring them back per catalogue item                                                                                                                                                                                                                                                                                          | S    | STANDARD | todo   | No question data is kept that nothing reads                                                                                                |
| 3.2d | Owner screens and the customer job page in the refreshed layout (docs/ui-guidelines.md, "Reference screens"): price list as tiles opening an edit sheet, quote editor and phone enquiry as panels with a docked main action, job page and `/j/` as panels                                                                                                                                                                                                                               | M    | STANDARD | todo   | Every screen in `check:browser` passes the guidelines' "Checking a screen" step 4 at 375 px and 1280 px                                    |
| 3.2b | `[module]` notify's remaining Kaam Koti messages: `request.received` (owner and customer), `quote.response` (owner), `appointment.confirmed` (customer), the quote expiry notice; owner recipients resolved in platform from the identity `sub`; the 30-day purge of `notify.message` (needs a scheduled job in `jobs`)                                                                                                                                                                 | M    | STANDARD | todo   | Each message in architecture 9.2's table up to scheduling is queued by its change; a message older than 30 days is gone                    |
| 3.3  | `[module]` `notify` WhatsApp channel (D7): confirmations, reminders, "on the way"; per-business monthly quota; sign-in by phone code (moved from 0.6a: needs this channel, and better-auth's phone plugin stores codes in plain text, so its codes need our own hashed store)                                                                                                                                                                                                           | M    | HIGH     | todo   | Quota is enforced; delivery webhook is signature-verified; a phone sign-in issues the same `sub` flow as email                             |

## Phase 4: Jobs, invoices and payments

| Id  | Step                                                                                                                       | Size | Model    | Status | Done when                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ---- | -------- | ------ | --------------------------------------------------------------------------------- |
| 4.1 | `[module]` `payments` (D5): payment link, verified webhook, idempotent recording, deposits, part-payments                  | L    | HIGH     | todo   | Replayed and forged webhooks are rejected; paid state comes only from the webhook |
| 4.2 | Job execution (basic): check-in, checklist, photos, mark complete                                                          | M    | STANDARD | todo   | Technician completes a job at 375 px                                              |
| 4.3 | Change orders: extra work found on site or tasks the customer adds after acceptance; business prices, customer re-approves | M    | HIGH     | todo   | Invoice includes only approved change orders                                      |
| 4.4 | Invoice from accepted quote plus change orders; cash payment recorded by the owner                                         | M    | HIGH     | todo   | Invoice totals match the tests; a paid invoice is immutable                       |

## Phase 5: Subscription for tradespeople

| Id  | Step                                                                                                                                                                                                                                 | Size | Model    | Status | Done when                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | -------- | ------ | ------------------------------------------------------------ |
| 5.1 | Billing account in `platform` (one bill across products), with a local status copy in each app updated by signed events; `[module]` `billing` client: plans, seats, trial (D6, D9); subscription active only from a verified webhook | L    | HIGH     | todo   | Trial → paid → lapsed lifecycle tested against real Postgres |
| 5.2 | `[module]` `billing` usage limits: seats, jobs on the free tier, WhatsApp quota, top-ups                                                                                                                                             | M    | HIGH     | todo   | Each limit is refused at the edge with one error shape       |
| 5.3 | Lapsed business: public page and customer links degrade gracefully, never break                                                                                                                                                      | S    | STANDARD | todo   | Lapsed page shows a contact card                             |

## Phase 6: Reviews and MVP launch

| Id  | Step                                                                                              | Size | Model    | Status | Done when                                                   |
| --- | ------------------------------------------------------------------------------------------------- | ---- | -------- | ------ | ----------------------------------------------------------- |
| 6.1 | Review request after payment; low ratings go to the owner privately first                         | M    | STANDARD | todo   | Only published reviews appear on the public page            |
| 6.2 | "Powered by" footer and tradesperson-referral free month                                          | S    | STANDARD | todo   | Referral credit applies once per new paying business        |
| 6.3 | Launch hardening: backups, restore drill, rate limits, error monitoring, legal pages, DPDP basics | M    | HIGH     | todo   | Restore drill passes; `validate full` green; tag `mvp-done` |

**MVP is done** when an owner can sign up, set up a trade, receive a request, negotiate a
quote, schedule, complete the job, get paid online and collect a review, all in the browser
at phone and desktop width.

## Phase 7: After MVP (order to be confirmed after launch feedback)

| Id  | Step                                                                                  | Size | Model    | Status | Done when                                                  |
| --- | ------------------------------------------------------------------------------------- | ---- | -------- | ------ | ---------------------------------------------------------- |
| 7.1 | Customer referral points: share link, credit to both sides, redeem on the next job    | M    | HIGH     | todo   | Points cannot be redeemed twice or across businesses       |
| 7.2 | Recurring contracts (AMC): auto-scheduled visits, renewal reminders, contract billing | L    | HIGH     | todo   | Visits generate on schedule; renewal billing is idempotent |
| 7.3 | Technician PWA (D8): today's jobs, navigation link, works offline, syncs later        | L    | STANDARD | todo   | Job completed offline syncs without duplicates             |
| 7.4 | Follow-up after 7 days; warranty claims linked to the original job                    | S    | STANDARD | todo   | Claim opens a job referencing the original                 |
| 7.5 | Owner dashboard: quotes won, revenue, money owed, rating, lead sources                | M    | STANDARD | todo   | Every figure matches a seeded fixture                      |
| 7.6 | More templates: plumbing/electrical, pest control, cleaning, painting, salon-at-home  | M    | STANDARD | todo   | Each selectable at onboarding                              |
| 7.7 | GST invoices; multiple branches (Business plan)                                       | L    | HIGH     | todo   | GST invoice fields validated; branch data isolated         |
