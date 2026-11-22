# Test accounts (development seed)

Created by `pnpm run up:fresh` from [apps/kaamkoti/seed.sql](../apps/kaamkoti/seed.sql) and
[services/platform/seed.sql](../services/platform/seed.sql). Development only: nothing here is real, and
every email is on example.com.

## Signing in

There are no passwords. Sign-in is an email and a 6-digit code.

1. Run the stack and the platform container (see "Running" below), then open http://127.0.0.1:45450 and click **Start free**.
2. Enter one of the emails below.
3. Read the code in Mailpit at http://127.0.0.1:45446 and enter it. Codes last 10 minutes and allow 5 attempts.

## Members

| Email                 | Name           | Role       | Business                |
| --------------------- | -------------- | ---------- | ----------------------- |
| prakash@example.com   | Prakash Sharma | owner      | Sharma Cooling Services |
| imran@example.com     | Imran Shaikh   | technician | Sharma Cooling Services |
| kavya@example.com     | Kavya Reddy    | owner      | Kaveri Electricals      |
| manjunath@example.com | Manjunath B    | technician | Kaveri Electricals      |

Two businesses so owner isolation can be checked from both sides: sign in as Prakash and as Kavya, and neither
should see the other's customers, requests or quotes.

| Business                | Slug               | City      | Trade       | Intake form                   |
| ----------------------- | ------------------ | --------- | ----------- | ----------------------------- |
| Sharma Cooling Services | sharma-cooling     | Pune      | ac_repair   | 7 questions from the template |
| Kaveri Electricals      | kaveri-electricals | Bengaluru | electrician | none (no-questions path)      |

## Seeded work

| Business | Request | State    | What it is for                                                                                        |
| -------- | ------- | -------- | ----------------------------------------------------------------------------------------------------- |
| Sharma   | #1      | new      | Unquoted, so you can write a quote. Has a planned site visit tomorrow 10:00 with Imran.               |
| Sharma   | #2      | quoted   | One sent quote, ₹295 (inspection visit and a discount, 18 % GST).                                     |
| Kaveri   | #1      | new      | Unquoted, with no scheduled visit.                                                                    |
| Kaveri   | #2      | new      | A draft quote (₹350) pricing a custom task.                                                           |
| Kaveri   | #3      | accepted | A negotiation: ₹472 countered at ₹400, version 2 accepted at ₹400. Unplanned, so you can schedule it. |

Customers (fictional +91 90000 numbers): Sharma has Anita Deshpande, Rahul Joshi and Meera Kulkarni. Kaveri has
Suresh Gowda, Lakshmi Rao and an Anita Deshpande with the same phone as Sharma's, to show one person can be a
customer of two businesses.

## Customers (signed in)

Customers sign in on the bare domain, which in development is **localhost** (members use 127.0.0.1), so the
two cookies never meet. Open a business page, tap **Work list** (or **New work**, the request form), and sign
in with an email code as above. The form is filled in from the customer's own record; a mobile that is on
another customer's record (Rahul's +91 90000 01002 at Sharma, say) is refused.

| Email              | Business | Customer row                    | What they see                                                       |
| ------------------ | -------- | ------------------------------- | ------------------------------------------------------------------- |
| anita@example.com  | Sharma   | linked (signed-in customer)     | Sharma #1 only, at http://localhost:45450/b/sharma-cooling/requests |
| anita@example.com  | Kaveri   | owner-entered, claimed by email | Kaveri #2 after her first visit to kaveri-electricals               |
| suresh@example.com | Kaveri   | linked (signed-in customer)     | Kaveri #1 only                                                      |
| meera@example.com  | Sharma   | owner-entered, claimed by email | An empty list (Meera has no request yet)                            |

Any other email signs in too, and sees an empty list: they have not asked that business for anything. Their
first request creates their customer row, with a mobile not already on another customer's record.

## Customer links (no account)

Customers act through scoped links. The seed gives each business a link to its request #1, valid 30 days from
the seed run:

- Sharma: http://127.0.0.1:45450/j/dev-job-link-sharma-request-1-xxxxxxxxxxxxx
- Kaveri: http://127.0.0.1:45450/j/dev-job-link-kaveri-request-1-xxxxxxxxxxxxx

The public request form is at `/b/<slug>/request`, for example http://127.0.0.1:45450/b/sharma-cooling/request.

## Running

```powershell
pnpm run up:fresh        # wipes everything; database, Garage, Redis, Mailpit, migrations, seed, platform
pnpm --filter kaamkoti dev
```

`up:fresh` also rebuilds and starts the `platform` container, last, because it registers the app's sign-in
client at start-up. Plain `pnpm run up` does not start it.

## Sign-in problems

Always start from the app (http://127.0.0.1:45450, **Start free** or `/login`), never from the platform's own
address. The sign-in URL should then carry a long query (`/sign-in?response_type=code&...&sig=...`).

| Symptom                                                          | Cause                                                                                                                                                                    | Fix                                                                                                                |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `invalid_client`, "client not found"                             | The platform container registers the app's client when it starts, and the database was wiped after that.                                                                 | `pnpm run up:fresh` (it restarts platform last).                                                                   |
| "That code did not work", response `invalid_signature`           | The signed link in the address bar expired. It lasts `codeExpiresIn` seconds (180, in `services/platform/src/identity.ts`). A reload or an old tab reuses the same link. | Close the tab, start again from the app. Finish within 3 minutes.                                                  |
| "That code did not work", response `{token, user}` with no `url` | The sign-in page was opened without the query, so the platform signed you in but had nowhere to send you back.                                                           | Start from the app, not from `127.0.0.1:45443/sign-in`.                                                            |
| "That code did not work", response 400/401                       | Wrong, used or replaced code. Every **Continue** on the email step sends a new code and cancels the previous one; codes last 10 minutes, 5 attempts.                     | Click **Continue** once and use the newest message in Mailpit.                                                     |
| `{"message":"Too many requests. Please try again later."}`       | Rate limit: 10 codes an hour per email, 5 an hour per address, plus per-IP limits. Counters are kept in Redis only.                                                      | `docker exec bodhchakra-dev-redis-1 redis-cli flushall` (Redis holds nothing else in dev), or `pnpm run up:fresh`. |

After editing anything in `services/platform/`, rebuild the container; `up:fresh` does it, or run
`docker compose -f infra/compose.dev.yml --profile platform up -d --build platform`.

Checking a failing request: in the browser's Network tab, open `sign-in/email-otp` and read its **Response**.
The page shows the same message for every failure, so the status and body are the only way to tell them apart.

## Ports

| Service              | Address                |
| -------------------- | ---------------------- |
| Kaam Koti            | http://127.0.0.1:45450 |
| platform (sign-in)   | http://127.0.0.1:45443 |
| Mailpit (read codes) | http://127.0.0.1:45446 |
| Postgres             | 127.0.0.1:45442        |
