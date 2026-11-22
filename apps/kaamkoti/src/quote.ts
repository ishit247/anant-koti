// Quotes (docs/architecture.md 5.3, 6, 8; scope `member` for the owner, `customer-token` for the read view). A job
// has numbered versions. The owner edits one draft at a time, which starts from the request's tasks or from the
// version before; sending it supersedes that version and moves the job to `quoted`. Amounts are computed here
// with @bodhchakra/money and restated by the database's CHECKs and triggers, which also keep a sent quote frozen.
// Customer answers (accept, reject, counter) are step 2.5.
import type { Audit } from "@bodhchakra/audit";
import type { DbClient } from "@bodhchakra/db";
import { lineTotals, type Money, money, type Totals } from "@bodhchakra/money";
import { currentBusiness } from "@bodhchakra/tenancy";
import { jobTasks } from "./job.ts";
import type { UNITS } from "./trade-template.ts";

export const QUOTE_STATUSES = [
  "draft",
  "sent",
  "accepted",
  "rejected",
  "countered",
  "superseded",
] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

/** How long a sent quote may be accepted, as the owner picks it. */
export const QUOTE_VALID_DAYS = [3, 7, 15, 30] as const;
export const MAX_QUOTE_LINES = 40;

type Unit = (typeof UNITS)[number];

/** One line as the owner sets it; the amounts are computed, never taken from input. */
export interface QuoteLineInput {
  /** The task it prices; null for a request-level charge (visit fee, discount, one lump price). */
  readonly jobTaskId: string | null;
  /** The price-list item it came from, if any. */
  readonly catalogueItemId: string | null;
  readonly description: string;
  readonly unit: Unit;
  readonly quantityMilli: number;
  /** Tax-exclusive; negative for a discount. */
  readonly unitPriceMinor: number;
  readonly taxRateBp: number;
}

export interface QuoteLine extends QuoteLineInput {
  /** The priced task's title; null for a request-level line. */
  readonly taskTitle: string | null;
  readonly net: Money;
  readonly tax: Money;
}

export interface Quote {
  readonly id: string;
  readonly version: number;
  readonly status: QuoteStatus;
  readonly sentAt: Date | null;
  readonly validUntil: Date | null;
  /** A sent quote past valid_until, computed at request time: it can no longer be accepted. */
  readonly expired: boolean;
  readonly net: Money;
  readonly tax: Money;
  readonly total: Money;
  readonly deposit: Money;
  readonly lines: readonly QuoteLine[];
}

export type QuoteError =
  /** No such job or quote in this business. */
  | "not_found"
  /** The job has moved past quoting (accepted, declined, cancelled…). */
  | "closed"
  /** The quote is no longer a draft. */
  | "sent"
  /** A line names a task of another job, or a price-list item that does not exist; or too many lines. */
  | "lines"
  /** The total would be below zero. */
  | "negative"
  /** The deposit is more than the total. */
  | "deposit"
  /** Sending a quote with no lines. */
  | "empty";

export type QuoteResult<T> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false; readonly error: QuoteError };

interface Owner {
  readonly businessId: string;
  readonly memberId: string;
}

/** Job states in which the owner may write or revise a quote (section 6). */
const QUOTABLE = ["requested", "quoted"];

/**
 * The job's draft to edit: the one already open, or a new version. A new version copies the latest quote's
 * lines, or, for a first quote, has one line per task at its price-list price (a custom task at 0, to be priced).
 */
export async function openDraft(
  client: DbClient,
  owner: Owner,
  jobId: string,
): Promise<QuoteResult<{ quoteId: string }>> {
  // Locking the job serialises two owners opening a draft at once, and a send of this job.
  const job = await client.query<{ status: string }>(
    "select status from kk.job where id = $1 for update",
    [jobId],
  );
  const status = job.rows[0]?.status;
  if (status === undefined) return { ok: false, error: "not_found" };
  if (!QUOTABLE.includes(status)) return { ok: false, error: "closed" };

  const quotes = await client.query<{ id: string; version: number; status: QuoteStatus }>(
    "select id, version, status from kk.quote where job_id = $1 order by version desc",
    [jobId],
  );
  const draft = quotes.rows.find((q) => q.status === "draft");
  if (draft) return { ok: true, quoteId: draft.id };
  const latest = quotes.rows[0];

  const created = await client.query<{ id: string }>(
    `insert into kk.quote (business_id, job_id, version, net_minor, tax_minor, total_minor, deposit_minor)
     select $1, $2, $3, coalesce(p.net_minor, 0), coalesce(p.tax_minor, 0), coalesce(p.total_minor, 0),
            coalesce(p.deposit_minor, 0)
     from (select 1) one left join kk.quote p on p.id = $4
     returning id`,
    [owner.businessId, jobId, (latest?.version ?? 0) + 1, latest?.id ?? null],
  );
  const quoteId = created.rows[0]?.id as string;
  if (latest) {
    await client.query(
      `insert into kk.quote_line (business_id, job_id, quote_id, position, job_task_id, catalogue_item_id,
                                  description, unit, quantity_milli, unit_price_minor, tax_rate_bp, net_minor,
                                  tax_minor)
       select business_id, job_id, $2, position, job_task_id, catalogue_item_id, description, unit,
              quantity_milli, unit_price_minor, tax_rate_bp, net_minor, tax_minor
       from kk.quote_line where quote_id = $1`,
      [latest.id, quoteId],
    );
    return { ok: true, quoteId };
  }

  const tasks = await client.query<{
    id: string;
    title: string;
    catalogue_item_id: string | null;
    unit: Unit | null;
    unit_price_minor: string | null;
    tax_rate_bp: number | null;
  }>(
    `select t.id, t.title, t.catalogue_item_id, c.unit, c.unit_price_minor, c.tax_rate_bp
     from kk.job_task t
     left join kk.catalogue_item c on c.business_id = t.business_id and c.id = t.catalogue_item_id
     where t.job_id = $1 and t.status <> 'dropped'
     order by t.added_at, t.id`,
    [jobId],
  );
  const lines: QuoteLineInput[] = tasks.rows.map((t) => ({
    jobTaskId: t.id,
    catalogueItemId: t.catalogue_item_id,
    description: t.title,
    unit: t.unit ?? "job",
    quantityMilli: 1000,
    unitPriceMinor: Number(t.unit_price_minor ?? 0),
    taxRateBp: t.tax_rate_bp ?? 0,
  }));
  const { currency } = await currentBusiness(client);
  await writeLines(client, owner, { id: quoteId, jobId }, lines, lineTotals(lines, currency), 0);
  return { ok: true, quoteId };
}

/**
 * Replaces a draft's lines and deposit, and stores the totals computed from them. Refuses a quote that is no
 * longer a draft, a line naming a task of another job, a total below zero and a deposit above the total.
 */
export async function saveDraft(
  client: DbClient,
  owner: Owner,
  quoteId: string,
  input: { readonly lines: readonly QuoteLineInput[]; readonly depositMinor: number },
): Promise<QuoteResult<{ totals: Totals }>> {
  const quote = await lockQuote(client, quoteId);
  if (!quote) return { ok: false, error: "not_found" };
  if (quote.status !== "draft") return { ok: false, error: "sent" };
  if (input.lines.length > MAX_QUOTE_LINES) return { ok: false, error: "lines" };

  // The foreign keys refuse these too; checking first turns a forged id into a plain answer, not a crash.
  const taskIds = new Set((await jobTasks(client, quote.jobId)).map((t) => t.id));
  const itemIds = [...new Set(input.lines.flatMap((l) => l.catalogueItemId ?? []))];
  const items = await client.query("select 1 from kk.catalogue_item where id = any($1::uuid[])", [
    itemIds,
  ]);
  if (items.rowCount !== itemIds.length) return { ok: false, error: "lines" };
  if (input.lines.some((l) => l.jobTaskId !== null && !taskIds.has(l.jobTaskId)))
    return { ok: false, error: "lines" };

  const { currency } = await currentBusiness(client);
  const totals = lineTotals(input.lines, currency);
  if (totals.total.minor < 0) return { ok: false, error: "negative" };
  if (input.depositMinor < 0 || input.depositMinor > totals.total.minor)
    return { ok: false, error: "deposit" };
  await writeLines(
    client,
    owner,
    { id: quoteId, jobId: quote.jobId },
    input.lines,
    totals,
    input.depositMinor,
  );
  return { ok: true, totals };
}

/**
 * Sends the draft: the version out with the customer before it becomes `superseded`, this one `sent` and
 * valid for `validDays`, its tasks `quoted`, the job `quoted`. The caller issues a fresh customer link in the
 * same transaction for the message that carries the quote (a link cannot be sent twice; architecture.md 7).
 */
export async function sendQuote(
  client: DbClient,
  audit: Audit,
  owner: Owner,
  quoteId: string,
  validDays: number,
): Promise<QuoteResult<{ jobId: string; version: number }>> {
  if (!Number.isInteger(validDays) || validDays < 1 || validDays > 90)
    throw new RangeError(`sendQuote: ${validDays} days is not a validity`);
  // Job first, then quote: the same order as openDraft, so the two cannot deadlock.
  const job = await client.query<{ id: string; status: string }>(
    `select j.id, j.status from kk.job j
     where j.id = (select job_id from kk.quote where id = $1)
     for update`,
    [quoteId],
  );
  const jobRow = job.rows[0];
  const quote = await lockQuote(client, quoteId);
  if (!jobRow || !quote) return { ok: false, error: "not_found" };
  if (quote.status !== "draft") return { ok: false, error: "sent" };
  if (!QUOTABLE.includes(jobRow.status)) return { ok: false, error: "closed" };
  const lines = await client.query("select 1 from kk.quote_line where quote_id = $1 limit 1", [
    quoteId,
  ]);
  if (lines.rowCount === 0) return { ok: false, error: "empty" };

  const superseded = await client.query<{ version: number }>(
    `update kk.quote set status = 'superseded'
     where job_id = $1 and status in ('sent', 'rejected', 'countered')
     returning version`,
    [jobRow.id],
  );
  await client.query(
    `update kk.quote set status = 'sent', sent_at = now(), valid_until = now() + make_interval(days => $2)
     where id = $1`,
    [quoteId, validDays],
  );
  await client.query(
    `update kk.job_task set status = 'quoted'
     where job_id = $1 and status = 'requested'
       and id in (select job_task_id from kk.quote_line where quote_id = $2)`,
    [jobRow.id, quoteId],
  );
  await client.query("update kk.job set status = 'quoted' where id = $1", [jobRow.id]);
  await audit.record(client, {
    businessId: owner.businessId,
    actor: { kind: "member", id: owner.memberId },
    action: "quote.sent",
    entity: "quote",
    entityId: quoteId,
    data: {
      version: quote.version,
      totalMinor: quote.totalMinor,
      superseded: superseded.rows[0]?.version ?? null,
    },
  });
  return { ok: true, jobId: jobRow.id, version: quote.version };
}

/** Every version of the job's quote, newest first, with lines; empty if the job has none (or is not here). */
export function ownerQuotes(client: DbClient, jobId: string, now = new Date()): Promise<Quote[]> {
  return loadQuotes(client, jobId, false, now);
}

/**
 * What the customer's link shows: the newest quote the business has sent, unless it was replaced. Never a
 * draft, never an older version.
 */
export async function customerQuote(
  client: DbClient,
  jobId: string,
  now = new Date(),
): Promise<Quote | null> {
  return (await loadQuotes(client, jobId, true, now))[0] ?? null;
}

async function lockQuote(
  client: DbClient,
  quoteId: string,
): Promise<{ jobId: string; status: QuoteStatus; version: number; totalMinor: number } | null> {
  const { rows } = await client.query<{
    job_id: string;
    status: QuoteStatus;
    version: number;
    total_minor: string;
  }>("select job_id, status, version, total_minor from kk.quote where id = $1 for update", [
    quoteId,
  ]);
  const row = rows[0];
  return row
    ? {
        jobId: row.job_id,
        status: row.status,
        version: row.version,
        totalMinor: Number(row.total_minor),
      }
    : null;
}

async function writeLines(
  client: DbClient,
  owner: Owner,
  quote: { readonly id: string; readonly jobId: string },
  lines: readonly QuoteLineInput[],
  totals: Totals,
  depositMinor: number,
): Promise<void> {
  await client.query("delete from kk.quote_line where quote_id = $1", [quote.id]);
  for (const [position, line] of lines.entries()) {
    const amounts = totals.lines[position];
    await client.query(
      `insert into kk.quote_line (business_id, job_id, quote_id, position, job_task_id, catalogue_item_id,
                                  description, unit, quantity_milli, unit_price_minor, tax_rate_bp, net_minor,
                                  tax_minor)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        owner.businessId,
        quote.jobId,
        quote.id,
        position,
        line.jobTaskId,
        line.catalogueItemId,
        line.description,
        line.unit,
        line.quantityMilli,
        line.unitPriceMinor,
        line.taxRateBp,
        amounts?.net.minor,
        amounts?.tax.minor,
      ],
    );
  }
  await client.query(
    `update kk.quote set net_minor = $2, tax_minor = $3, total_minor = $4, deposit_minor = $5
     where id = $1`,
    [quote.id, totals.net.minor, totals.tax.minor, totals.total.minor, depositMinor],
  );
}

async function loadQuotes(
  client: DbClient,
  jobId: string,
  forCustomer: boolean,
  now: Date,
): Promise<Quote[]> {
  const quotes = await client.query<{
    id: string;
    version: number;
    status: QuoteStatus;
    sent_at: Date | null;
    valid_until: Date | null;
    net_minor: string;
    tax_minor: string;
    total_minor: string;
    deposit_minor: string;
  }>(
    `select id, version, status, sent_at, valid_until, net_minor, tax_minor, total_minor, deposit_minor
     from kk.quote
     where job_id = $1 and ($2 = false or status not in ('draft', 'superseded'))
     order by version desc
     limit case when $2 then 1 end`,
    [jobId, forCustomer],
  );
  if (quotes.rows.length === 0) return [];
  const { currency } = await currentBusiness(client);
  const lines = await client.query<{
    quote_id: string;
    job_task_id: string | null;
    catalogue_item_id: string | null;
    task_title: string | null;
    description: string;
    unit: Unit;
    quantity_milli: string;
    unit_price_minor: string;
    tax_rate_bp: number;
    net_minor: string;
    tax_minor: string;
  }>(
    `select l.quote_id, l.job_task_id, l.catalogue_item_id, t.title as task_title, l.description, l.unit,
            l.quantity_milli, l.unit_price_minor, l.tax_rate_bp, l.net_minor, l.tax_minor
     from kk.quote_line l
     left join kk.job_task t on t.business_id = l.business_id and t.id = l.job_task_id
     where l.quote_id = any($1::uuid[])
     order by l.position`,
    [quotes.rows.map((q) => q.id)],
  );
  const amount = (minor: string) => money(Number(minor), currency);
  return quotes.rows.map((q) => ({
    id: q.id,
    version: q.version,
    status: q.status,
    sentAt: q.sent_at,
    validUntil: q.valid_until,
    expired: q.status === "sent" && q.valid_until !== null && q.valid_until <= now,
    net: amount(q.net_minor),
    tax: amount(q.tax_minor),
    total: amount(q.total_minor),
    deposit: amount(q.deposit_minor),
    lines: lines.rows
      .filter((l) => l.quote_id === q.id)
      .map((l) => ({
        jobTaskId: l.job_task_id,
        catalogueItemId: l.catalogue_item_id,
        taskTitle: l.task_title,
        description: l.description,
        unit: l.unit,
        quantityMilli: Number(l.quantity_milli),
        unitPriceMinor: Number(l.unit_price_minor),
        taxRateBp: l.tax_rate_bp,
        net: amount(l.net_minor),
        tax: amount(l.tax_minor),
      })),
  }));
}
