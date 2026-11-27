// The invoice (docs/architecture.md 5.3, 6, 8; step 4.4): the bill for a completed job, a copy of what was agreed
// (`agreedWork`: the accepted quote plus the approved change orders, nothing else). It is issued when the work is
// marked complete, or, if a change order was still waiting for the customer then, once they answer it. What is
// due is the total less everything received for the job, the deposit included; the invoice becomes paid in the
// transaction that records the payment that covers it, whether by Razorpay's verified webhook or the owner's
// cash entry. The database keeps an invoice frozen once written (0011_invoice.sql); only the owner's void undoes
// one, after which they may issue a new one, for instance with extra work approved since.
import type { Audit } from "@bodhchakra/audit";
import type { DbClient } from "@bodhchakra/db";
import { type Money, money } from "@bodhchakra/money";
import type { Payments } from "@bodhchakra/payments";
import { currentBusiness } from "@bodhchakra/tenancy";
import { z } from "zod";
import { agreedWork } from "./change-order.ts";
import type { SpaceCustomer } from "./customer-space.ts";
import type { JobStatus } from "./job.ts";
import type { Notices } from "./notices.ts";
import type { QuoteLine } from "./quote.ts";

/** The link's purpose in `payments`; the subject is the job, as for the deposit. */
export const INVOICE = "invoice";

/** States in which money is taken for a job: from acceptance (the deposit) to completion (the bill). */
const PAYABLE: readonly JobStatus[] = ["accepted", "scheduled", "in_progress", "completed"];

// Razorpay's floor for a payment link is ₹1; less than that is settled directly.
const MIN_ONLINE_MINOR = 100;

export type InvoiceStatus = "issued" | "paid" | "void";

export interface Invoice {
  readonly id: string;
  readonly number: number;
  readonly status: InvoiceStatus;
  readonly issuedAt: Date;
  readonly paidAt: Date | null;
  readonly lines: readonly QuoteLine[];
  readonly net: Money;
  readonly tax: Money;
  readonly total: Money;
  /** Received for the job, online and cash, the deposit included. */
  readonly paid: Money;
  /** Still to pay; zero once paid. */
  readonly due: Money;
  /** The business has connected Razorpay, so the customer can pay online. */
  readonly online: boolean;
}

interface Owner {
  readonly businessId: string;
  readonly memberId: string;
}

interface LiveRow {
  id: string;
  number: number;
  status: "issued" | "paid";
  total_minor: string;
}

/** The job's invoice in force (not void), locked if asked. Inside `withTenant`. */
async function liveInvoice(client: DbClient, jobId: string, lock: boolean) {
  const { rows } = await client.query<LiveRow>(
    `select id, number, status, total_minor from kk.invoice
     where job_id = $1 and status <> 'void' ${lock ? "for update" : ""}`,
    [jobId],
  );
  return rows[0] ?? null;
}

/** Locks the job, so issuing, paying, voiding and change orders on one job happen one at a time. */
async function lockJob(client: DbClient, jobId: string) {
  if (!z.uuid().safeParse(jobId).success) return null;
  const { rows } = await client.query<{ business_id: string; status: JobStatus }>(
    "select business_id, status from kk.job where id = $1 for update",
    [jobId],
  );
  return rows[0] ?? null;
}

export type IssueResult =
  | { readonly ok: true; readonly invoiceId: string; readonly due: Money }
  | {
      readonly ok: false;
      /**
       * `closed`: the job is not completed; `issued`: it has an invoice in force; `waiting`: a change order is
       * waiting for the customer's answer, and the bill follows it.
       */
      readonly error: "not_found" | "closed" | "issued" | "waiting";
    };

/**
 * Inside `withTenant`. Issues the completed job's invoice: a copy of the agreed work, under the business's next
 * number. Paid at once if what was received already covers it (a deposit of the whole price, or a zero bill).
 * The caller has found the job in its scope, and tells the customer (`notices.invoiceIssued`) when it succeeds.
 */
export async function issueInvoice(
  client: DbClient,
  audit: Audit,
  payments: Payments,
  jobId: string,
): Promise<IssueResult> {
  const job = await lockJob(client, jobId);
  if (!job) return { ok: false, error: "not_found" };
  if (job.status !== "completed") return { ok: false, error: "closed" };
  if (await liveInvoice(client, jobId, false)) return { ok: false, error: "issued" };
  const { rowCount } = await client.query(
    "select 1 from kk.change_order where job_id = $1 and status = 'proposed'",
    [jobId],
  );
  if (rowCount) return { ok: false, error: "waiting" };
  const agreed = await agreedWork(client, jobId);
  // A completed job always had an accepted quote (job.accepted_quote_id's check).
  if (!agreed) throw new Error(`invoice: completed job ${jobId} has no agreed work`);

  const counted = await client.query<{ last_number: number }>(
    `insert into kk.invoice_counter (business_id, last_number) values ($1, 1)
     on conflict (business_id) do update set last_number = kk.invoice_counter.last_number + 1
     returning last_number`,
    [job.business_id],
  );
  const number = counted.rows[0]?.last_number as number;
  const inserted = await client.query<{ id: string }>(
    `insert into kk.invoice (business_id, job_id, number, net_minor, tax_minor, total_minor, line_count)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [
      job.business_id,
      jobId,
      number,
      agreed.net.minor,
      agreed.tax.minor,
      agreed.total.minor,
      agreed.lines.length,
    ],
  );
  const invoiceId = inserted.rows[0]?.id as string;
  for (const [position, line] of agreed.lines.entries()) {
    await client.query(
      `insert into kk.invoice_line (business_id, job_id, invoice_id, position, job_task_id, description,
                                    unit, quantity_milli, unit_price_minor, tax_rate_bp, net_minor, tax_minor)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        job.business_id,
        jobId,
        invoiceId,
        position,
        line.jobTaskId,
        line.description,
        line.unit,
        line.quantityMilli,
        line.unitPriceMinor,
        line.taxRateBp,
        line.net.minor,
        line.tax.minor,
      ],
    );
  }
  await audit.record(client, {
    businessId: job.business_id,
    actor: { kind: "system" },
    action: "invoice.issued",
    entity: "invoice",
    entityId: invoiceId,
    data: {
      jobId,
      number,
      totalMinor: agreed.total.minor,
      changeOrders: agreed.changeOrders.join(","),
    },
  });
  await settleInvoice(client, audit, payments, jobId);
  const { currency } = await currentBusiness(client);
  const received = (await payments.paidFor(client, jobId, currency)).minor;
  return {
    ok: true,
    invoiceId,
    due: money(Math.max(agreed.total.minor - received, 0), currency),
  };
}

/**
 * `issueInvoice`, then the customer's notice if it issued. Called where a job may have become ready to bill: the
 * work marked complete, a change order answered on a completed job, and the owner's own "Issue the invoice".
 */
export async function bill(
  client: DbClient,
  deps: { readonly audit: Audit; readonly payments: Payments; readonly notices: Notices },
  jobId: string,
): Promise<IssueResult> {
  const issued = await issueInvoice(client, deps.audit, deps.payments, jobId);
  if (issued.ok) await deps.notices.invoiceIssued(client, issued.invoiceId, issued.due);
  return issued;
}

/**
 * Inside `withTenant`, in the transaction that recorded a payment for the job: marks its issued invoice paid if
 * everything received now covers the total. True if it did. Audited strictly: a paid invoice that cannot be
 * audited is not marked.
 */
export async function settleInvoice(
  client: DbClient,
  audit: Audit,
  payments: Payments,
  jobId: string,
): Promise<boolean> {
  const invoice = await liveInvoice(client, jobId, true);
  if (invoice?.status !== "issued") return false;
  const { currency } = await currentBusiness(client);
  const received = await payments.paidFor(client, jobId, currency);
  if (received.minor < Number(invoice.total_minor)) return false;
  const { rows } = await client.query<{ business_id: string }>(
    "update kk.invoice set status = 'paid', paid_at = now() where id = $1 returning business_id",
    [invoice.id],
  );
  await audit.recordStrict(client, {
    businessId: rows[0]?.business_id as string,
    actor: { kind: "system" },
    action: "invoice.paid",
    entity: "invoice",
    entityId: invoice.id,
    data: { jobId, number: invoice.number, totalMinor: Number(invoice.total_minor) },
  });
  return true;
}

/**
 * The job's invoice in force, with its lines and what is still due, or null if it has none. Inside `withTenant`;
 * the caller has already found the job in its scope (the owner's business, or the customer).
 */
export async function jobInvoice(
  client: DbClient,
  payments: Payments,
  businessId: string,
  jobId: string,
): Promise<Invoice | null> {
  const { rows } = await client.query<{
    id: string;
    number: number;
    status: "issued" | "paid";
    issued_at: Date;
    paid_at: Date | null;
    net_minor: string;
    tax_minor: string;
    total_minor: string;
  }>(
    `select id, number, status, issued_at, paid_at, net_minor, tax_minor, total_minor
     from kk.invoice where job_id = $1 and status <> 'void'`,
    [jobId],
  );
  const row = rows[0];
  if (!row) return null;
  const { currency } = await currentBusiness(client);
  const lines = await client.query<{
    job_task_id: string | null;
    task_title: string | null;
    description: string;
    unit: QuoteLine["unit"];
    quantity_milli: string;
    unit_price_minor: string;
    tax_rate_bp: number;
    net_minor: string;
    tax_minor: string;
  }>(
    `select l.job_task_id, t.title as task_title, l.description, l.unit, l.quantity_milli,
            l.unit_price_minor, l.tax_rate_bp, l.net_minor, l.tax_minor
     from kk.invoice_line l
     left join kk.job_task t on t.business_id = l.business_id and t.id = l.job_task_id
     where l.invoice_id = $1 order by l.position`,
    [row.id],
  );
  const total = Number(row.total_minor);
  const paid = (await payments.paidFor(client, jobId, currency)).minor;
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    issuedAt: row.issued_at,
    paidAt: row.paid_at,
    lines: lines.rows.map((l) => ({
      jobTaskId: l.job_task_id,
      // Not copied: the invoice names what was done, not the price-list entry it came from.
      catalogueItemId: null,
      taskTitle: l.task_title,
      description: l.description,
      unit: l.unit,
      quantityMilli: Number(l.quantity_milli),
      unitPriceMinor: Number(l.unit_price_minor),
      taxRateBp: l.tax_rate_bp,
      net: money(Number(l.net_minor), currency),
      tax: money(Number(l.tax_minor), currency),
    })),
    net: money(Number(row.net_minor), currency),
    tax: money(Number(row.tax_minor), currency),
    total: money(total, currency),
    paid: money(paid, currency),
    due: money(Math.max(total - paid, 0), currency),
    online: (await payments.connectedAccount(client, businessId)) !== null,
  };
}

/** Cancels the job's open links, at Razorpay first; if Razorpay refuses, this throws and the caller rolls back. */
async function cancelOpenLinks(
  client: DbClient,
  payments: Payments,
  businessId: string,
  jobId: string,
  keep: (link: { purpose: string; amount: Money }) => boolean = () => false,
): Promise<string | null> {
  let kept: string | null = null;
  for (const link of await payments.linksFor(client, jobId)) {
    if (link.status !== "created" && link.status !== "partially_paid") continue;
    if (kept === null && keep(link)) kept = link.url;
    else await payments.cancelLink(client, { businessId, linkId: link.id });
  }
  return kept;
}

export type CashResult =
  | { readonly ok: true; readonly paid: boolean }
  | {
      readonly ok: false;
      /** `closed`: no money is taken in this state, or the bill is paid; `too_much`: beyond what is owed. */
      readonly error: "not_found" | "closed" | "too_much";
    };

/**
 * Inside `withTenant` of the owner's business: cash the owner took for the job, recorded and audited strictly
 * (`payments.recordManual`). At most what is still owed: the invoice's due, or before it the agreed work's total
 * less what was received. Open payment links are cancelled, since their amounts no longer match what is due;
 * the customer's next Pay makes a new one. The invoice becomes paid if this covers it.
 */
export async function recordCash(
  client: DbClient,
  audit: Audit,
  payments: Payments,
  owner: Owner,
  jobId: string,
  amountMinor: number,
): Promise<CashResult> {
  const job = await lockJob(client, jobId);
  if (!job) return { ok: false, error: "not_found" };
  if (!PAYABLE.includes(job.status)) return { ok: false, error: "closed" };
  const invoice = await liveInvoice(client, jobId, true);
  if (invoice?.status === "paid") return { ok: false, error: "closed" };
  const { currency } = await currentBusiness(client);
  const owed = invoice
    ? Number(invoice.total_minor)
    : ((await agreedWork(client, jobId))?.total.minor ?? 0);
  const received = (await payments.paidFor(client, jobId, currency)).minor;
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 1 || amountMinor > owed - received)
    return { ok: false, error: "too_much" };

  await payments.recordManual(client, {
    businessId: owner.businessId,
    subjectId: jobId,
    amount: money(amountMinor, currency),
    by: owner.memberId,
  });
  await cancelOpenLinks(client, payments, owner.businessId, jobId);
  return { ok: true, paid: await settleInvoice(client, audit, payments, jobId) };
}

/**
 * Inside `withTenant` of the owner's business: voids the job's invoice in force, paid or not (a mistake on it,
 * or extra work to add). Audited strictly. Money received stays recorded and counts towards the next invoice.
 * Open bill links are cancelled.
 */
export async function voidInvoice(
  client: DbClient,
  audit: Audit,
  payments: Payments,
  owner: Owner,
  jobId: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: "not_found" | "none" }> {
  const job = await lockJob(client, jobId);
  if (!job) return { ok: false, error: "not_found" };
  const invoice = await liveInvoice(client, jobId, true);
  if (!invoice) return { ok: false, error: "none" };
  await client.query("update kk.invoice set status = 'void', voided_at = now() where id = $1", [
    invoice.id,
  ]);
  await audit.recordStrict(client, {
    businessId: owner.businessId,
    actor: { kind: "member", id: owner.memberId },
    action: "invoice.void",
    entity: "invoice",
    entityId: invoice.id,
    data: { jobId, number: invoice.number, was: invoice.status },
  });
  for (const link of await payments.linksFor(client, jobId)) {
    if (link.purpose === INVOICE && (link.status === "created" || link.status === "partially_paid"))
      await payments.cancelLink(client, { businessId: owner.businessId, linkId: link.id });
  }
  return { ok: true };
}

export type PayInvoiceResult =
  | { readonly ok: true; readonly url: string }
  | {
      readonly ok: false;
      /** `small`: less than Razorpay's ₹1 floor is left, so it is paid directly. */
      readonly error: "not_found" | "closed" | "nothing_due" | "offline" | "small";
    };

/**
 * The signed-in customer's "Pay the bill" (scope `customer`): the job is looked up under this customer, so
 * another's is not found. Returns the Razorpay page for what is still due: the open bill link if it is for that
 * amount, else a new one, after cancelling any other open link (a stale deposit link, or a bill link for an
 * amount since part-paid in cash), so the customer cannot pay twice. `returnUrl` is their request page.
 */
export async function payInvoice(
  client: DbClient,
  payments: Payments,
  customer: SpaceCustomer,
  jobId: string,
  returnUrl: string,
): Promise<PayInvoiceResult> {
  if (!z.uuid().safeParse(jobId).success) return { ok: false, error: "not_found" };
  const { rows } = await client.query<{
    number: number;
    business_name: string;
    name: string;
    email: string | null;
    phone_e164: string;
  }>(
    `select j.number, b.name as business_name, c.name, c.email, c.phone_e164
     from kk.job j
     join kk.customer c on c.business_id = j.business_id and c.id = j.customer_id
     join tenancy.business b on b.id = j.business_id
     where j.business_id = $1 and j.customer_id = $2 and j.id = $3
     for update of j`,
    [customer.businessId, customer.id, jobId],
  );
  const job = rows[0];
  if (!job) return { ok: false, error: "not_found" };
  const invoice = await jobInvoice(client, payments, customer.businessId, jobId);
  if (!invoice) return { ok: false, error: "closed" };
  if (invoice.due.minor === 0) return { ok: false, error: "nothing_due" };
  if (!invoice.online) return { ok: false, error: "offline" };
  if (invoice.due.minor < MIN_ONLINE_MINOR) return { ok: false, error: "small" };

  const open = await cancelOpenLinks(
    client,
    payments,
    customer.businessId,
    jobId,
    (link) => link.purpose === INVOICE && link.amount.minor === invoice.due.minor,
  );
  if (open) return { ok: true, url: open };
  const link = await payments.createPaymentLink(client, {
    businessId: customer.businessId,
    subjectId: jobId,
    purpose: INVOICE,
    amount: invoice.due,
    acceptPartial: false,
    description: `Invoice ${invoice.number} for request #${job.number} with ${job.business_name}`,
    customer: { name: job.name, phone: job.phone_e164, ...(job.email ? { email: job.email } : {}) },
    returnUrl,
  });
  return { ok: true, url: link.url };
}
