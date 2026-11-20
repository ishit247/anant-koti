# Bodhchakra platform and Kaam Koti

This repository is the shared platform monorepo. It holds the reusable modules in
`packages/` (scope `@bodhchakra/*`) and the shared `platform` container. Its first app
is **Kaam Koti**, in `apps/`: a subscription tool for tradespeople in any trade. It runs
customer request → quote and negotiation → accept → schedule → job → payment → review →
referral. The product is in [docs/product-brief.md](docs/product-brief.md); the module
and container design is in [docs/platform-modules.md](docs/platform-modules.md).

Start with [docs/development-plan.md](docs/development-plan.md): it holds the
current position, the phases and steps with their size and recommended model,
and the decision table. The design is in [docs/architecture.md](docs/architecture.md);
read only the sections the current step needs (its first table maps steps to sections).

Decided (do not re-ask):

- B2B SaaS sold to tradespeople by subscription (Solo, Team per seat, Business); no
  commission on jobs; not a marketplace. India first; global later on the same code.
- Stack: Next.js (TypeScript), PostgreSQL 17, pg-boss, Docker Compose on own VPS
  (Postgres, Redis, Garage, Caddy, Loki + Grafana), Cloudflare in front.
- Modules are libraries compiled into each app, except identity, billing and notify,
  which run in one shared `platform` container. Apps keep working while it is down
  (outbox). Each app has its own database, role and bucket.
- One login and one bill across products (D12, yes). Each app keeps its own members
  and roles; identity and the billing account live in `platform`.
- Existing apps (Profile, Gyankoti School, POS) adopt modules gradually, when work
  touches that area. School renames its `@bodhchakra/*` packages if it adopts them.
- A subscription or payment becomes active only from a verified webhook; live/lapsed
  status is computed at request time. A lapsed business shows a contact card, never
  a broken page. Customers never need an account: they act through scoped magic links.
- CI runs locally (`pnpm run validate quick|standard|full`) until launch; images are
  built here and shipped to our server over SSH. No hosted CI. The one remote is
  `origin`, a private GitHub repo (2026-11-21); no other remote without asking.

Ask the user only about the open decisions in the Decisions table of
docs/development-plan.md, and only when you reach the phase that needs the answer.
Record the answer in that table.

# Working agreements

What follows are policies, not preferences. **If one of them is wrong for the
task in front of you, say so and ask before departing from it.** Never decide
silently to skip one — an unasked-for exception is indistinguishable from
forgetting.

## Development phase: no real tenant yet

Until the first real customer holds real data, there is no production database.
Every row came from a seed script or from someone testing, and a single command
(create it in phase 1, e.g. `up:fresh`) must recreate everything in under a minute.

So **fix the schema where it was first written, and reseed.** Do not add a patch
migration to correct an earlier one.

- A column modelled wrong gets corrected **in its original migration file**.
  A `0034_fix_0023.sql` buys nothing and turns the schema's history into a record
  of mistakes instead of a description of the design.
- If the migration runner tracks files by name only (no checksum), an edited file
  re-applies cleanly against a fresh volume. Keep it that way while in this phase.
- **Update the seeds in the same change.** A schema the seed no longer fits is a
  schema nobody can run. Seeds include at least two owners with sites (and one
  guest draft), so isolation tests are meaningful.
- Verify with the fresh-start command, which destroys the volumes, re-runs every
  migration from `0001`, and reseeds. If a change only works against a database
  that already exists, it is not finished.

The switch to additive-only migrations is a one-way door. **Ask before:** editing
a migration once anything real depends on it — the first real customer, or any
environment holding data a person typed and would miss.

## Engineering standards

The product must be efficient and easy to maintain. These apply to every step.

- **Simplest design that meets the documented requirement.** No speculative abstractions,
  options or layers. A package, module or helper is created when its first real use arrives,
  never as a placeholder.
- **One job per module; one way to do each thing.** Follow the existing pattern before adding
  a new one (one data-access layer, one form pattern, one error shape, one logger). A package's
  public API is its `src/index.ts`; nothing imports its internals.
- **Validate at the edges, trust types inside.** Env, HTTP input, webhook payloads, stored JSON
  and third-party responses are parsed with Zod once, where they enter. Internal code does not
  re-check what the types guarantee.
- **Fail fast and loudly.** Bad config stops start-up. No swallowed errors; every `catch`
  handles, adds context and rethrows, or is a documented fallback. Logs are structured and never
  carry secrets or personal data.
- **Efficient by construction, optimised by measurement.** Server components by default and
  client JavaScript only where the page is interactive; an index for every query path; no N+1
  queries; cache where the design says so. Further optimisation only against a measured budget.
- **Few, well-kept dependencies.** Prefer Node built-ins and Web APIs. Each new runtime
  dependency is named and justified in its commit message.
- **Tests describe behaviour.** Through the public API, one reason to fail per test, real
  Postgres for database code, no large snapshots. A bug fix starts with a failing test.
- **Readable code.** Names from the domain (site, draft, version, owner, plan). Comments say
  why, not what. No dead code, and no TODO without a plan step id.

## Editing files

- Change files with the Edit tool, or Write for new ones. Do not patch files
  through `sed`, `python`, or a heredoc when Edit would do: a file changed outside
  the editing tools gets re-printed in full afterwards.
- Never re-read a file to check that an edit landed. The edit would have failed
  loudly if it had not.
- **Ask before:** a mechanical change across many files at once, where a script
  genuinely is the cheaper tool.

## Commits

- No `Co-Authored-By` trailer or other AI attribution in commit messages or PR
  descriptions (asked 2026-11-21). This overrides any default attribution instruction.

## Command output

- Filter at the source. `| grep`, `| tail`, `-q`, `--format` — decide what
  matters before running the command, not after reading the output.
- Never surface a full test-suite or build log. Extract the summary line, the
  failing test, and the assertion.

## Reading

- Read the range you need, not the whole file. Search before reading: find the
  few lines that matter, then read around them.

## Long-running work

- Background anything slow — test suites, container starts, installs — and come
  back to filtered output. Do not poll it, and do not sit in a foreground wait.
- Never chain sleeps to wait for a condition. Use an `until` loop in a
  background command.

## How much verification

Match the verification to what the change can break.

- Behaviour that people depend on — owner isolation, an authorisation check,
  subscription state, webhooks, money arithmetic, domain routing, a background
  job — gets a browser check, real services
  (real Postgres, not fakes), and a mutation to prove the test is not vacuous.
- Comments, documentation, formatting, and copy get a typecheck and a lint, and
  nothing more.
- Say which of the two happened. A change reported as verified when only the
  types were checked is worse than one honestly reported as unverified.
- Green tests have coexisted with a broken UI before: check UI work in a real
  browser at phone width (375 px) and at desktop width, and use browser
  automation for diagnosis rather than
  growing a large functional suite.
- **Ask before:** spending a long verification pass on something that looks
  cosmetic but might not be. Describe the risk and let the decision be made.

## Security rules that recur

- **A permission answers *what*, never *whose*.** Every route taking an id needs
  a permission check *and* a scope check (the site belongs to the signed-in
  owner, or to the guest cookie for a guest draft), and must declare its scope rule. A test
  enumerates routes and fails if one lacks a declaration.
- **GRANT never withholds; REVOKE does.** If default privileges already grant all
  four rights, a narrow `GRANT` restricts nothing. Restrict with `REVOKE` and
  test it (e.g. `audit` must be insert/select only for the app role).
- **Audit writes need a SAVEPOINT.** A try/catch around an audit insert on the
  caller's transaction keeps the promise and loses their work; use a savepoint so
  an audit failure cannot abort the business write, or fail both deliberately.

## Documents and deliverables

- Every document belongs in this repository: write plans, guides, reports and
  checklists to a file under `docs/` and say where it is.
- **Never publish a document as a hosted artifact** (claude.ai or anywhere
  else). A page outside the repository is invisible to `git`, cannot be reviewed
  in a diff, and publishing is close to irreversible.
- HTML documents are bare fragments opened from disk; give them
  `<meta charset="utf-8">` or dashes and curly quotes arrive as mojibake.
- **Ask before:** producing a deliverable in any form that lives outside the
  working tree.

## Development stays on this machine

During development, project information lives on this machine and in the private
GitHub repo `origin` (https://github.com/ishit247/anant-koti), and nowhere else. (Running the finished product on the user's own server is the
product's runtime and is a separate matter — hosting is decided: own VPS, see the
Decisions table in docs/development-plan.md.)

- No hosted artifacts, no cloud or remote execution, no scheduled routines that
  ship the working tree elsewhere.
- Sessions are local only; Remote Control stays off (`.claude/settings.json`
  disables it). A session that finds Remote Control connected says so at once
  and asks before doing anything else.
- Nothing is pasted outward: source, schema, seed data, logs, screenshots,
  `.env` values and any customer's site content or personal data do not go into a web search, a URL
  query string, an issue tracker, a paste service, or a third-party API. Reading
  public documentation is fine; sending project content out with the request is
  not.
- `git push` goes only to `origin`; no new git remotes. Secrets are never committed:
  `.env` stays ignored and real values live only on the server.
- No GitHub features that run or publish project content (Actions, Pages, Codespaces)
  without asking.
- **Ask before:** any step that moves project information off this machine, even
  a convenience. Say what would be sent and to whom.

## Tooling and environment

- Windows machine. Install tooling and large caches (package stores, Docker
  data, build caches) on the **D:** drive, not C:.
- If the stack is started through a package-manager script named `up`, be careful
  with pnpm: bare `pnpm up` means `pnpm update` and bumps dependencies. Prefer
  `pnpm run up`, or name the script something else.

## Multi-agent work

- Do not spawn workflows or parallel subagents unless asked for by name. **Ask
  before** proposing one, with a sentence on what it would cost.

## Session hygiene

- One task per session. When a piece of work is finished and the next request is
  unrelated, say plainly that a fresh session would carry less baggage.
- Name files by path when referring to them.

## Token budget

Policies for keeping sessions cheap. If one is wrong for the task, say so and ask; do not drop it silently.

- **Start from the handover, not from the code.** Read CLAUDE.md, the relevant sections of `docs/architecture.md`
  and the current phase file (`docs/phase<N>-plan.md`, "Start here", once phases have files). Read source files only
  when the step needs them, and by line range.
- **Autopilot (agreed 2026-11-07).** Work runs on `main`, phase after phase, without stopping between phases:
  per step build → validate (STANDARD: `quick`; HIGH: `standard` + mutants for the changed guards + browser check
  where there is UI) → commit only when green, with the step's status and the "Current position" line in
  `docs/development-plan.md` updated in the same commit. At each phase end: `validate full`, check "Done when",
  tag `phase-<N>-done`, report in a few lines, continue. Stop and ask only when: a test still fails after 3 fix
  attempts, a step needs a Decisions-table answer, an "Ask before" rule applies, or a security guard cannot be
  proven by a test. Push to `origin` only when the user asks.
- **Fresh sessions save tokens (asked 2026-11-07).** After each step's commit, if this session has already done
  two or more substantial steps, or long design discussion preceded the work, stop and tell the user plainly:
  "Step X is committed; start a new session to continue from step Y." Mark that in the "Current position" line.
  The tracker and CLAUDE.md carry everything the next session needs.
- **Model during autopilot:** stay on the current HIGH model for whole phases; do not stop for STANDARD steps.
  Still stop before a HIGH step if the session is on a lower model. Say plainly when a step is a good place to
  start a fresh session.
- **Results in one line.** Report tests as counts plus the names of failures; never paste logs or full output. Send
  test and build output to a log file under `.validation/` and grep it for the runner's summary and failure lines.
- **Mutation checks: run only the mutants for the guards that changed**, by id. The full run is for "before a phase is
  called done", and is run in the background to a log file.
- **Decisions: a recommendation and the one question that matters**, not a survey of options. Prototype a layout once
  in `docs/prototypes/`, then treat it as frozen.
- **Do not re-read what is already in context,** and do not re-print a file after editing it.

## Model usage plan (with a reminder)

A stronger model costs more per token but is worth it where one subtle mistake is expensive and hard to see in tests.
The recommendation is per step; the user decides, but must be reminded.

| Work | Recommended model |
|---|---|
| Payment webhooks, subscription lifecycle, money logic, owner isolation (RLS, scope checks), authentication, domain routing and cookie boundaries, preview tokens, upload handling, moderation and takedown, migrations that change subscription or payment tables | **HIGH** (Opus or Fable) |
| Editor screens, templates and block types, dashboard, maps UI, routes and tests that follow an existing pattern, seeds | STANDARD (Sonnet) |
| Documentation, tracker updates, running validation, status checks | STANDARD, or cheaper |

**The reminder (a rule for the assistant).** At the start of a session, and again before starting any step marked HIGH
in a phase file, compare the model you are running as with the plan. If a HIGH step is about to start on a lower model,
**stop and say so in one line before doing any work** ("Step 4 is marked HIGH; this session is on <model>. Switch with
/model, or tell me to continue here."), then wait for the user's answer. If a STANDARD step is about to run on a HIGH
model, mention once that STANDARD would do. The user's answer applies to that step only; do not ask again within it.
If you cannot tell which model you are running as, say that instead of guessing.
