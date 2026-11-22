# Trade Services: product brief

A subscription tool for tradespeople and small service businesses in any trade. It takes
a customer's work request through to quote, negotiation, acceptance, scheduling, the job
itself, payment, review and referral. It is sold to the business (B2B SaaS), not run as a
marketplace: each business brings its own customers.

Agreed 2026-11-20. Open questions live in the Decisions table of
[development-plan.md](development-plan.md).

## Who it is for

- **Owner:** runs the business, quotes, schedules, gets paid.
- **Technician:** does the job on site, works on a phone.
- **Customer:** requests, approves and pays through links and never needs an account.

## Core flow (the same for every trade)

| Stage               | What happens                                                                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Request             | Customer submits what, where, when and photos, from the business's public page, a WhatsApp link or a QR code; or the owner logs a phone enquiry |
| Quote and negotiate | Quote with line items and versions; customer accepts, rejects or counters; quotes expire; optional site visit first                             |
| Accept              | Accepted quote is locked as the agreed scope; optional deposit                                                                                  |
| Schedule            | Slot and technician; confirmation, reminder and "on the way" messages                                                                           |
| Job                 | Check-in, trade checklist, before/after photos; change orders for extra work, which the customer re-approves                                    |
| Pay                 | Invoice from the accepted quote plus change orders; UPI, card, cash on site, part-payments                                                      |
| Review              | Requested automatically after payment; low ratings go privately to the owner first                                                              |
| Referral            | Customer share link; points or credit for both sides, redeemable on the next job                                                                |

## Generic through trade templates

A trade is configuration, not code: a service catalogue (prices and units), intake
questions, a job checklist, and default terms (warranty, cancellation). Ready-made
templates: AC/appliance repair, plumbing/electrical, pest control, cleaning, painting,
salon-at-home. Any other trade starts from a blank template.

## Beyond the core

Recurring maintenance contracts (AMC) with automatically scheduled visits; WhatsApp as the main channel, with SMS and email as fallbacks; an
offline-capable technician view; customer accounts (D15): the tradesperson sends a link,
the customer signs in by OTP to email or mobile inside that tradesperson's space and sees their
requests with that business (Active, Completed, Cancelled), and creates new ones; a follow-up 7 days after the job and warranty claims
linked to the original job; lead-source tracking; an owner dashboard. Later: parts and
stock, route planning, GST invoices, multiple branches.

## Plans

| Plan     | For                                    | India / Global (indicative) |
| -------- | -------------------------------------- | --------------------------- |
| Trial    | 14–30 days of Team                     | free                        |
| Solo     | One tradesperson                       | ₹299–499/mo · $15–19/mo     |
| Team     | 2–10 technicians, priced per seat      | ₹999–1,499/mo · $39–49/mo   |
| Business | Branches, roles, reports, tax invoices | ₹2,999+/mo · $99+/mo        |

- No commission on jobs; payment-gateway fees are passed through at cost.
- Annual billing gets 2 months free.
- Each plan includes a monthly WhatsApp message quota, with paid top-ups.
- Growth: a "Powered by" footer on every customer link, and a free month for each
  tradesperson referred.

## MVP

Request → quote with counter-offers → accept → schedule → invoice and online payment →
review. One trade template, a public business page, WhatsApp/email notifications, and
the subscription with a trial. Phase two adds referrals, AMC contracts, the full
technician view, more templates and the dashboard.
