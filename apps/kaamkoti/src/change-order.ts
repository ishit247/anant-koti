// Change orders (docs/architecture.md 5.3, 6; step 4.3; scope `member` for the owner, `customer` for the answer).
// Work added after the customer accepted the quote — a task they asked for since, or extra work found on site —
// costs nothing until the owner prices it in a change order and the customer approves it. The accepted quote
// never changes; `agreedWork` is it plus the approved change orders, and nothing else, which the invoice (4.4)
// takes. Amounts are computed here with @bodhchakra/money and restated by the database's CHECKs and triggers,
// which keep a proposed change order frozen. The job's state does not move: these run beside it.
import type { Audit } from "@bodhchakra/audit";
import type { DbClient } from "@bodhchakra/db";
import { lineTotals, type Money, money, type Totals } from "@bodhchakra/money";
import { currentBusiness } from "@bodhchakra/tenancy";
import { z } from "zod";
import type { SpaceCustomer } from "./customer-space.ts";
import {
  activeItemsByName,
  MAX_ITEM_DETAILS,
  MAX_ITEM_TITLE,
  MAX_REQUEST_ITEMS,
  sameName,
} from "./intake.ts";
import type { JobStatus } from "./job.ts";
import { linesBelong, loadLines, type QuoteLine, type QuoteLineInput } from "./quote.ts";

export const CHANGE_ORDER_STATUSES = ["draft", "proposed", "approved", "rejected"] as const;
export type ChangeOrderStatus = (typeof CHANGE_ORDER_STATUSES)[number];

/**
 * Job states in which a change order may be written, proposed and answered: from acceptance to completion, and
 * only while the job has no invoice in force (`changeOpen`, 4.4).
 */
export const CHANGEABLE: readonly JobStatus[] = [
  "accepted",
  "scheduled",
  "in_progress",
  "completed",
];

export interface ChangeOrder {
  readonly id: string;
  readonly number: number;
  readonly status: ChangeOrderStatus;
  readonly proposedAt: Date | null;
  readonly decidedAt: Date | null;
  readonly net: Money;
  readonly tax: Money;
  readonly total: Money;
  readonly lines: readonly QuoteLine[];
}

export type ChangeOrderError =
  /** No such job or change order in this business. */
  | "not_found"
  /** The job is not between acceptance and completion. */
  | "closed"
  /** The change order is no longer a draft. */
  | "proposed"
  /** Another change order is already waiting for the customer's answer. */
  | "waiting"
  /** A line names a task of another job, or a price-list item that does not exist; or too many lines. */
  | "lines"
  /** The total would be below zero. */
  | "negative"
  /** Proposing a change order with no lines. */
  | "empty";

export type ChangeOrderResult<T> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false; readonly error: ChangeOrderError };

/** Why a customer's answer was refused. */
export type ChangeAnswerError =
  /** No such change order shown on this job (another job's, or a draft). */
  | "not_found"
  /** The job is past the point of changing (cancelled…). */
  | "closed"
  /** It was answered already. */
  | "answered";

interface Owner {
  readonly businessId: string;
  readonly memberId: string;
}

type Unit = QuoteLineInput["unit"];

/** Change orders are open on a job in these states while it has no invoice in force (4.4). */
export const changeOpen = (status: JobStatus, invoiced: boolean) =>
  CHANGEABLE.includes(status) && !invoiced;

/**
 * Locks the job, so drafting, proposing, answering and issuing the invoice on one job happen one at a time.
 * `changeable` says whether a change order may be written or answered now.
 */
async function lockJob(client: DbClient, jobId: string) {
  if (!z.uuid().safeParse(jobId).success) return null;
  const { rows } = await client.query<{
    status: JobStatus;
    customer_id: string;
    invoiced: boolean;
  }>(
    `select j.status, j.customer_id,
            exists (select 1 from kk.invoice i
                    where i.business_id = j.business_id and i.job_id = j.id and i.status <> 'void') as invoiced
     from kk.job j where j.id = $1 for update of j`,
    [jobId],
  );
  const row = rows[0];
  return row ? { ...row, changeable: changeOpen(row.status, row.invoiced) } : null;
}

/**
 * The job's change order to edit: the draft already open, or a new one with a line for each task still waiting
 * for a price (`requested`), at its price-list price or at 0 for the owner to price.
 */
export async function openChangeDraft(
  client: DbClient,
  owner: Owner,
  jobId: string,
): Promise<ChangeOrderResult<{ changeOrderId: string }>> {
  const job = await lockJob(client, jobId);
  if (!job) return { ok: false, error: "not_found" };
  if (!job.changeable) return { ok: false, error: "closed" };
  const open = await client.query<{ id: string }>(
    "select id from kk.change_order where job_id = $1 and status = 'draft'",
    [jobId],
  );
  const draft = open.rows[0];
  if (draft) return { ok: true, changeOrderId: draft.id };

  const created = await client.query<{ id: string }>(
    `insert into kk.change_order (business_id, job_id, number)
     select $1, $2, coalesce(max(number), 0) + 1 from kk.change_order where job_id = $2
     returning id`,
    [owner.businessId, jobId],
  );
  const changeOrderId = created.rows[0]?.id as string;
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
     where t.job_id = $1 and t.status = 'requested'
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
  await writeLines(client, owner, { id: changeOrderId, jobId }, lines, lineTotals(lines, currency));
  return { ok: true, changeOrderId };
}

/** Replaces a draft's lines and stores the totals computed from them. */
export async function saveChangeDraft(
  client: DbClient,
  owner: Owner,
  changeOrderId: string,
  lines: readonly QuoteLineInput[],
): Promise<ChangeOrderResult<{ jobId: string; totals: Totals }>> {
  const found = await changeOrderJob(client, changeOrderId);
  if (!found) return { ok: false, error: "not_found" };
  const job = await lockJob(client, found);
  const current = await lockChangeOrder(client, changeOrderId);
  if (!job || !current) return { ok: false, error: "not_found" };
  if (current.status !== "draft") return { ok: false, error: "proposed" };
  if (!job.changeable) return { ok: false, error: "closed" };
  if (!(await linesBelong(client, found, lines))) return { ok: false, error: "lines" };
  const { currency } = await currentBusiness(client);
  const totals = lineTotals(lines, currency);
  if (totals.total.minor < 0) return { ok: false, error: "negative" };
  await writeLines(client, owner, { id: changeOrderId, jobId: found }, lines, totals);
  return { ok: true, jobId: found, totals };
}

/**
 * Puts the draft to the customer: it becomes `proposed` and frozen, and the tasks it prices that were waiting for
 * a price are `quoted`. Only one change order waits for an answer at a time. The caller queues the customer's
 * notice in the same transaction (`Notices.changeOrderProposed`).
 */
export async function proposeChangeOrder(
  client: DbClient,
  audit: Audit,
  owner: Owner,
  changeOrderId: string,
): Promise<ChangeOrderResult<{ jobId: string; number: number }>> {
  const jobId = await changeOrderJob(client, changeOrderId);
  if (!jobId) return { ok: false, error: "not_found" };
  // Job first, then change order: the same order everywhere, so two of these cannot deadlock.
  const job = await lockJob(client, jobId);
  const current = await lockChangeOrder(client, changeOrderId);
  if (!job || !current) return { ok: false, error: "not_found" };
  if (current.status !== "draft") return { ok: false, error: "proposed" };
  if (!job.changeable) return { ok: false, error: "closed" };
  const lines = await client.query(
    "select 1 from kk.change_order_line where change_order_id = $1 limit 1",
    [changeOrderId],
  );
  if (lines.rowCount === 0) return { ok: false, error: "empty" };
  const waiting = await client.query(
    "select 1 from kk.change_order where job_id = $1 and status = 'proposed'",
    [jobId],
  );
  if ((waiting.rowCount ?? 0) > 0) return { ok: false, error: "waiting" };

  await client.query(
    "update kk.change_order set status = 'proposed', proposed_at = now() where id = $1",
    [changeOrderId],
  );
  await client.query(
    `update kk.job_task set status = 'quoted'
     where job_id = $1 and status = 'requested'
       and id in (select job_task_id from kk.change_order_line where change_order_id = $2)`,
    [jobId, changeOrderId],
  );
  await audit.record(client, {
    businessId: owner.businessId,
    actor: { kind: "member", id: owner.memberId },
    action: "change_order.proposed",
    entity: "job",
    entityId: jobId,
    data: { changeOrderId, number: current.number, totalMinor: current.totalMinor },
  });
  return { ok: true, jobId, number: current.number };
}

/**
 * The signed-in customer's answer to the change order waiting on their own request (architecture 6, 7). The job
 * is looked up under the customer, so another customer's or business's is `not_found`, like a missing one.
 * Approving makes the tasks it prices `approved` (`done` if the job is already complete: the work was found and
 * done on site); rejecting drops them from the work (the change order keeps the record; the customer can ask
 * again).
 */
export async function answerChangeOrder(
  client: DbClient,
  audit: Audit,
  customer: SpaceCustomer,
  jobId: string,
  changeOrderId: string,
  approve: boolean,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: ChangeAnswerError }> {
  const job = await lockJob(client, jobId);
  if (!job || job.customer_id !== customer.id) return { ok: false, error: "not_found" };
  if (!z.uuid().safeParse(changeOrderId).success) return { ok: false, error: "not_found" };
  const { rows } = await client.query<{ status: ChangeOrderStatus; number: number }>(
    "select status, number from kk.change_order where id = $1 and job_id = $2 for update",
    [changeOrderId, jobId],
  );
  const current = rows[0];
  // A draft was never shown to the customer, so it is as unknown as another job's.
  if (!current || current.status === "draft") return { ok: false, error: "not_found" };
  if (current.status !== "proposed") return { ok: false, error: "answered" };
  if (!job.changeable) return { ok: false, error: "closed" };

  await client.query("update kk.change_order set status = $2, decided_at = now() where id = $1", [
    changeOrderId,
    approve ? "approved" : "rejected",
  ]);
  await client.query(
    `update kk.job_task set status = $3
     where job_id = $1 and status = 'quoted'
       and id in (select job_task_id from kk.change_order_line where change_order_id = $2)`,
    [
      jobId,
      changeOrderId,
      approve ? (job.status === "completed" ? "done" : "approved") : "dropped",
    ],
  );
  await audit.record(client, {
    businessId: customer.businessId,
    actor: { kind: "customer", id: customer.id },
    action: approve ? "change_order.approved" : "change_order.rejected",
    entity: "job",
    entityId: jobId,
    data: { changeOrderId, number: current.number },
  });
  return { ok: true };
}

/** Job states in which work may still be added: until the job is marked complete. */
export const OPEN_FOR_WORK: readonly JobStatus[] = ["accepted", "scheduled", "in_progress"];

export const extraWorkInput = z.object({
  title: z.string().trim().min(1).max(MAX_ITEM_TITLE),
  details: z
    .string()
    .trim()
    .max(MAX_ITEM_DETAILS)
    .transform((s) => s || null),
});
export type ExtraWork = z.infer<typeof extraWorkInput>;

/**
 * Adds a task to an accepted job: one the customer asks for since, or extra work found on site (`business`). It
 * waits for a price (`requested`) and costs nothing until a change order prices it and the customer approves. A
 * title naming one of the business's active price-list items is that item. The caller has found the job under
 * the customer, or as the member's assigned work; this locks it and checks its state.
 */
export async function addExtraWork(
  client: DbClient,
  jobId: string,
  addedBy: "customer" | "business",
  work: ExtraWork,
): Promise<"added" | "closed" | "items"> {
  const job = await lockJob(client, jobId);
  if (!job || !OPEN_FOR_WORK.includes(job.status)) return "closed";
  const count = await client.query<{ n: number }>(
    "select count(*)::int as n from kk.job_task where job_id = $1 and status <> 'dropped'",
    [jobId],
  );
  if ((count.rows[0]?.n ?? 0) >= MAX_REQUEST_ITEMS) return "items";
  const item = (await activeItemsByName(client)).get(sameName(work.title));
  await client.query(
    `insert into kk.job_task (business_id, job_id, catalogue_item_id, title, details, added_by)
     values (nullif(current_setting('app.business_id', true), '')::uuid, $1, $2, $3, $4, $5)`,
    [jobId, item?.id ?? null, work.title, work.details, addedBy],
  );
  return "added";
}

/**
 * The signed-in customer asks for more work on their own accepted request. The job is looked up under the
 * customer, so another customer's or business's is `not_found`, like a missing one.
 */
export async function askForMoreWork(
  client: DbClient,
  customer: SpaceCustomer,
  jobId: string,
  work: ExtraWork,
): Promise<"added" | "closed" | "items" | "not_found"> {
  if (!z.uuid().safeParse(jobId).success) return "not_found";
  const { rowCount } = await client.query(
    "select 1 from kk.job where business_id = $1 and customer_id = $2 and id = $3",
    [customer.businessId, customer.id, jobId],
  );
  if (rowCount === 0) return "not_found";
  return addExtraWork(client, jobId, "customer", work);
}

/** The job's change orders, newest first, with lines; the customer's view leaves out drafts. */
export async function changeOrders(
  client: DbClient,
  jobId: string,
  forCustomer: boolean,
): Promise<ChangeOrder[]> {
  const orders = await client.query<{
    id: string;
    number: number;
    status: ChangeOrderStatus;
    proposed_at: Date | null;
    decided_at: Date | null;
    net_minor: string;
    tax_minor: string;
    total_minor: string;
  }>(
    `select id, number, status, proposed_at, decided_at, net_minor, tax_minor, total_minor
     from kk.change_order
     where job_id = $1 and ($2 = false or status <> 'draft')
     order by number desc`,
    [jobId, forCustomer],
  );
  if (orders.rows.length === 0) return [];
  const { currency } = await currentBusiness(client);
  const lines = await loadLines(
    client,
    "change_order_line",
    "change_order_id",
    orders.rows.map((o) => o.id),
    currency,
  );
  const amount = (minor: string) => money(Number(minor), currency);
  return orders.rows.map((o) => ({
    id: o.id,
    number: o.number,
    status: o.status,
    proposedAt: o.proposed_at,
    decidedAt: o.decided_at,
    net: amount(o.net_minor),
    tax: amount(o.tax_minor),
    total: amount(o.total_minor),
    lines: lines.get(o.id) ?? [],
  }));
}

/** What the customer has agreed to pay for: the accepted quote's lines, then each approved change order's. */
export interface AgreedWork {
  readonly lines: readonly QuoteLine[];
  readonly net: Money;
  readonly tax: Money;
  readonly total: Money;
  /** The approved change orders' numbers, in order. */
  readonly changeOrders: readonly number[];
}

/**
 * The accepted quote plus the approved change orders, and nothing else: a proposed, rejected or draft change order
 * adds nothing. Null before a quote is accepted. The invoice (4.4) is a copy of this.
 */
export async function agreedWork(client: DbClient, jobId: string): Promise<AgreedWork | null> {
  if (!z.uuid().safeParse(jobId).success) return null;
  const { rows } = await client.query<{ accepted_quote_id: string | null }>(
    "select accepted_quote_id from kk.job where id = $1",
    [jobId],
  );
  const quoteId = rows[0]?.accepted_quote_id;
  if (!quoteId) return null;
  const approved = await client.query<{ id: string; number: number }>(
    "select id, number from kk.change_order where job_id = $1 and status = 'approved' order by number",
    [jobId],
  );
  const { currency } = await currentBusiness(client);
  const quoteLines = await loadLines(client, "quote_line", "quote_id", [quoteId], currency);
  const changeLines = await loadLines(
    client,
    "change_order_line",
    "change_order_id",
    approved.rows.map((o) => o.id),
    currency,
  );
  const lines = [
    ...(quoteLines.get(quoteId) ?? []),
    ...approved.rows.flatMap((o) => changeLines.get(o.id) ?? []),
  ];
  // The stored line amounts are the database-checked ones; the totals are their sums.
  const net = lines.reduce((sum, l) => sum + l.net.minor, 0);
  const tax = lines.reduce((sum, l) => sum + l.tax.minor, 0);
  return {
    lines,
    net: money(net, currency),
    tax: money(tax, currency),
    total: money(net + tax, currency),
    changeOrders: approved.rows.map((o) => o.number),
  };
}

async function changeOrderJob(client: DbClient, changeOrderId: string): Promise<string | null> {
  if (!z.uuid().safeParse(changeOrderId).success) return null;
  const { rows } = await client.query<{ job_id: string }>(
    "select job_id from kk.change_order where id = $1",
    [changeOrderId],
  );
  return rows[0]?.job_id ?? null;
}

async function lockChangeOrder(client: DbClient, changeOrderId: string) {
  const { rows } = await client.query<{
    status: ChangeOrderStatus;
    number: number;
    total_minor: string;
  }>("select status, number, total_minor from kk.change_order where id = $1 for update", [
    changeOrderId,
  ]);
  const row = rows[0];
  return row
    ? { status: row.status, number: row.number, totalMinor: Number(row.total_minor) }
    : null;
}

async function writeLines(
  client: DbClient,
  owner: Owner,
  order: { readonly id: string; readonly jobId: string },
  lines: readonly QuoteLineInput[],
  totals: Totals,
): Promise<void> {
  await client.query("delete from kk.change_order_line where change_order_id = $1", [order.id]);
  for (const [position, line] of lines.entries()) {
    const amounts = totals.lines[position];
    await client.query(
      `insert into kk.change_order_line (business_id, job_id, change_order_id, position, job_task_id,
                                         catalogue_item_id, description, unit, quantity_milli,
                                         unit_price_minor, tax_rate_bp, net_minor, tax_minor)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        owner.businessId,
        order.jobId,
        order.id,
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
    "update kk.change_order set net_minor = $2, tax_minor = $3, total_minor = $4 where id = $1",
    [order.id, totals.net.minor, totals.tax.minor, totals.total.minor],
  );
}
