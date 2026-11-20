# Trade Services: development plan and tracker

What we are building: [product-brief.md](product-brief.md). Shared modules:
[platform-modules.md](platform-modules.md). The design is in [architecture.md](architecture.md);
its first table says which sections each step reads.

**Current position:** Step 0.4 done (2026-11-21): `tenancy` (business, member, RLS, `resolve_slug`,
`memberships_of`, `requireRole`, `defineRoute` + `scanRoutes` kit) and `audit` (append-only, savepoint writes).
`migrate` now takes `{ runtimeRole }`, which migrations read as `db.runtime_role`. Seed: 2 businesses, 4 members,
6 customers. Tests need the stack up (`pnpm run up`). Next: step 0.5 (HIGH; needs Opus or Fable).

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
| D13 | Auth core                                                  | Wrap `better-auth` (already used in Profile) inside `@bodhchakra/auth`, so apps never import it directly; less security code to own | 0.5       |                                                                                                         |

## Phase 0: Foundations

| Id  | Step                                                                                                                                                                                                                     | Size | Model    | Status | Done when                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | -------- | ------ | ------------------------------------------------------------------------------------------------------- |
| 0.1 | Architecture doc: domains, data model, tenancy, job state machine, money model, notification model, each module's API and tables                                                                                         | M    | HIGH     | done   | `docs/architecture.md` covers every MVP stage and module boundary; D1, D10–D12 answered                 |
| 0.2 | Monorepo skeleton (pnpm, turbo); lint, typecheck, `pnpm run validate quick\|standard\|full`; dependency-direction and public-API-only checks; `[module]` `config`, `log`                                                 | M    | STANDARD | done   | `validate quick` green; an import of a module's internals fails the check                               |
| 0.3 | Compose on the shared [../infra](../../infra) pattern; `[module]` `db` (migration runner applying module migrations then app migrations, tenant context, test helper); `up:fresh`; seeds with 2 businesses and customers | M    | HIGH     | done   | `up:fresh` rebuilds everything in under a minute                                                        |
| 0.4 | `[module]` `tenancy` and `audit`: business, members, roles (owner, technician), RLS, route scope declarations and a test that enumerates them                                                                            | M    | HIGH     | done   | Cross-business read and write tests fail closed; mutant proves the test                                 |
| 0.5 | `platform` container skeleton: service tokens, internal network, health check, its own database; `[module]` `tokens` (request signing), `jobs` (pg-boss) and `outbox` for app ↔ platform calls                           | M    | HIGH     | todo   | App call with a bad or expired service token is refused; outbox delivers once after `platform` restarts |
| 0.6 | Identity in `platform` (D13, D14): email/phone OTP, single sign-on provider; `[module]` `auth` client in the app (login redirect, local session, links identity to local member)                                         | L    | HIGH     | todo   | One identity signs in to Kaam Koti; a forged or replayed sign-in response is refused; mutant proves it  |
| 0.7 | App flow: owner signup creates the business; invite a technician (`tenancy.invite` on `tokens`); the app's route test runs `scanRoutes` over its routes                                                                  | S    | STANDARD | todo   | Signup, login and invite work in the browser at 375 px and desktop width                                |

## Phase 1: Trade templates and the public page

| Id  | Step                                                                                             | Size | Model    | Status | Done when                                                      |
| --- | ------------------------------------------------------------------------------------------------ | ---- | -------- | ------ | -------------------------------------------------------------- |
| 1.1 | Trade template model: catalogue, units, intake questions, checklist, terms (typed JSON with Zod) | M    | STANDARD | todo   | One template seeds; invalid template JSON is rejected at write |
| 1.2 | Onboarding: pick a trade, edit catalogue and prices                                              | M    | STANDARD | todo   | New owner reaches a usable catalogue in under 5 minutes        |
| 1.3 | Public business page (profile, services, reviews slot, "request a job")                          | M    | STANDARD | todo   | Page renders without cookies on the public domain              |
| 1.4 | First ready-made template (AC/appliance repair)                                                  | S    | STANDARD | todo   | Template is selectable at onboarding                           |

## Phase 2: Requests and quotes

| Id  | Step                                                                                                                     | Size | Model    | Status | Done when                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------ | ---- | -------- | ------ | ----------------------------------------------------------------------------- |
| 2.1 | `[module]` `tokens` links; customer magic links: scoped to one job, expiring, revocable                                  | M    | HIGH     | todo   | A token cannot read another job; expired token is refused; mutant proves both |
| 2.2 | `[module]` `storage`; request intake: public form, trade questions, photo upload (type and size checks, private storage) | M    | HIGH     | todo   | Upload rejects wrong types and sizes; photos are not publicly listable        |
| 2.3 | Owner inbox: new requests, log a phone enquiry                                                                           | S    | STANDARD | todo   | Both request sources appear in one list                                       |
| 2.4 | `[module]` `money`; quotes: line items from the catalogue, versions, expiry                                              | M    | HIGH     | todo   | Totals and tax are tested; old versions are immutable                         |
| 2.5 | Negotiation: customer accepts, rejects or counters; owner revises; accepted quote locked                                 | M    | HIGH     | todo   | State machine test covers every transition; a locked quote cannot be edited   |

## Phase 3: Scheduling and notifications

| Id  | Step                                                                                                                              | Size | Model    | Status | Done when                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | ---- | -------- | ------ | --------------------------------------------------------- |
| 3.1 | Scheduling: slots, technician assignment, conflict check                                                                          | M    | STANDARD | todo   | Double-booking a technician is refused                    |
| 3.2 | `[module]` `notify`, served from the shared `platform` container through the outbox: templates, email channel, retries, audit log | M    | STANDARD | todo   | A failed send retries and is logged without personal data |
| 3.3 | `[module]` `notify` WhatsApp channel (D7): confirmations, reminders, "on the way"; per-business monthly quota                     | M    | HIGH     | todo   | Quota is enforced; delivery webhook is signature-verified |

## Phase 4: Jobs, invoices and payments

| Id  | Step                                                                                                      | Size | Model    | Status | Done when                                                                         |
| --- | --------------------------------------------------------------------------------------------------------- | ---- | -------- | ------ | --------------------------------------------------------------------------------- |
| 4.1 | `[module]` `payments` (D5): payment link, verified webhook, idempotent recording, deposits, part-payments | L    | HIGH     | todo   | Replayed and forged webhooks are rejected; paid state comes only from the webhook |
| 4.2 | Job execution (basic): check-in, checklist, photos, mark complete                                         | M    | STANDARD | todo   | Technician completes a job at 375 px                                              |
| 4.3 | Change orders: extra work found on site, customer re-approval                                             | M    | HIGH     | todo   | Invoice includes only approved change orders                                      |
| 4.4 | Invoice from accepted quote plus change orders; cash payment recorded by the owner                        | M    | HIGH     | todo   | Invoice totals match the tests; a paid invoice is immutable                       |

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
