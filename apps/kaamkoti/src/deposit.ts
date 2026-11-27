// The deposit on an accepted quote (docs/architecture.md 6, 8; step 4.1b). The customer pays it from their space
// through a Razorpay link on the business's own account. The link is made when the customer first presses Pay,
// not inside the acceptance, so Razorpay being slow or down never stops a quote being accepted. What has been
// paid comes only from recorded payments (the verified webhook, or cash), never from the link or a redirect.
import type { DbClient } from "@bodhchakra/db";
import { type Money, money } from "@bodhchakra/money";
import type { Payments } from "@bodhchakra/payments";
import { z } from "zod";
import type { SpaceCustomer } from "./customer-space.ts";
import type { JobStatus } from "./job.ts";

/** The link's purpose in `payments`; the subject is the job. */
export const DEPOSIT = "deposit";

/** While the work is ahead or under way; a completed job's money is the invoice's (4.3). */
const PAYABLE: readonly JobStatus[] = ["accepted", "scheduled", "in_progress"];
export const depositPayable = (status: JobStatus) => PAYABLE.includes(status);

export interface Deposit {
  /** What the accepted quote asks for up front. */
  readonly amount: Money;
  /** Received towards it, online or cash, at most the amount. */
  readonly paid: Money;
  /** Still to pay; zero once paid. */
  readonly due: Money;
  /** The business has connected Razorpay, so the customer can pay online. */
  readonly online: boolean;
}

/**
 * The deposit the job's accepted quote asks for, or null if it asks for none (or there is no accepted quote).
 * Inside `withTenant`; the caller has already found the job in its scope (the owner's business, or the customer).
 */
export async function jobDeposit(
  client: DbClient,
  payments: Payments,
  businessId: string,
  jobId: string,
): Promise<Deposit | null> {
  const { rows } = await client.query<{ deposit_minor: string; currency: string }>(
    `select q.deposit_minor, b.currency from kk.job j
     join kk.quote q on q.business_id = j.business_id and q.id = j.accepted_quote_id
     join tenancy.business b on b.id = j.business_id
     where j.id = $1`,
    [jobId],
  );
  const row = rows[0];
  if (!row || Number(row.deposit_minor) === 0) return null;
  const amount = Number(row.deposit_minor);
  const received = (await payments.paidFor(client, jobId, row.currency)).minor;
  const paid = Math.min(received, amount);
  return {
    amount: money(amount, row.currency),
    paid: money(paid, row.currency),
    due: money(amount - paid, row.currency),
    online: (await payments.connectedAccount(client, businessId)) !== null,
  };
}

export type PayDepositResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly error: "not_found" | "closed" | "nothing_due" | "offline" };

/**
 * The signed-in customer's Pay button (scope `customer`): the job is looked up under this customer, so another's
 * is not found. Returns the Razorpay page to send them to: the open deposit link if there is one, else a new one
 * for what is still due. `returnUrl` is their request page, where they land afterwards.
 */
export async function payDeposit(
  client: DbClient,
  payments: Payments,
  customer: SpaceCustomer,
  jobId: string,
  returnUrl: string,
): Promise<PayDepositResult> {
  if (!z.uuid().safeParse(jobId).success) return { ok: false, error: "not_found" };
  const { rows } = await client.query<{
    status: JobStatus;
    number: number;
    business_name: string;
    name: string;
    email: string | null;
    phone_e164: string;
  }>(
    `select j.status, j.number, b.name as business_name, c.name, c.email, c.phone_e164
     from kk.job j
     join kk.customer c on c.business_id = j.business_id and c.id = j.customer_id
     join tenancy.business b on b.id = j.business_id
     where j.business_id = $1 and j.customer_id = $2 and j.id = $3`,
    [customer.businessId, customer.id, jobId],
  );
  const job = rows[0];
  if (!job) return { ok: false, error: "not_found" };
  if (!depositPayable(job.status)) return { ok: false, error: "closed" };
  const deposit = await jobDeposit(client, payments, customer.businessId, jobId);
  if (!deposit || deposit.due.minor === 0) return { ok: false, error: "nothing_due" };
  if (!deposit.online) return { ok: false, error: "offline" };

  const link = await payments.createPaymentLink(client, {
    businessId: customer.businessId,
    subjectId: jobId,
    purpose: DEPOSIT,
    amount: deposit.due,
    acceptPartial: false,
    description: `Deposit for request #${job.number} with ${job.business_name}`,
    customer: { name: job.name, phone: job.phone_e164, ...(job.email ? { email: job.email } : {}) },
    returnUrl,
  });
  return { ok: true, url: link.url };
}
