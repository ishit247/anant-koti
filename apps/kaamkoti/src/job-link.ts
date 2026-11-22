// The customer's link to their job (docs/architecture.md 7, scope `customer-token`). A link opens exactly the
// job it was issued for, inside withTenant of that job's business. Each message to the customer carries a new
// link, live for JOB_LINK_DAYS after that message: the secret cannot be recovered to send again.
import type { Db, DbClient } from "@bodhchakra/db";
import { currentBusiness } from "@bodhchakra/tenancy";
import { issue, resolve, revokeFor } from "@bodhchakra/tokens";
import { type JobStatus, type WorkItem, workItems } from "./job.ts";
import { customerQuote, type Quote } from "./quote.ts";

export const JOB_LINK_DAYS = 30;

/**
 * Issues a new link to a job of the current business and returns the secret for the message that carries it.
 * Runs inside `withTenant`; a job of another business is not found.
 */
export async function issueJobLink(
  client: DbClient,
  jobId: string,
): Promise<{ secret: string; expiresAt: Date }> {
  const { rows } = await client.query<{ business_id: string }>(
    "select business_id from kk.job where id = $1",
    [jobId],
  );
  const job = rows[0];
  if (!job) throw new Error(`issueJobLink: no job ${jobId} in this business`);
  const expiresAt = new Date(Date.now() + JOB_LINK_DAYS * 86_400_000);
  const { secret } = await issue(client, {
    purpose: "job",
    businessId: job.business_id,
    subjectId: jobId,
    expiresAt,
  });
  return { secret, expiresAt };
}

/** Ends every live link to a job, for example after one went to a wrong number. Runs inside `withTenant`. */
export function revokeJobLinks(client: DbClient, jobId: string): Promise<number> {
  return revokeFor(client, "job", jobId);
}

export interface CustomerJobView {
  readonly businessName: string;
  /** E.164. */
  readonly businessPhone: string;
  readonly number: number;
  readonly status: JobStatus;
  readonly customerName: string;
  readonly requestedAt: Date;
  /** The work items the request names, in the order they were added, with the customer's photos. */
  readonly items: readonly WorkItem[];
  /** The quote the business sent, newest version only; never a draft. */
  readonly quote: Quote | null;
}

interface JobRow {
  number: number;
  status: JobStatus;
  created_at: Date;
  customer_name: string;
}

/** The one job a live job link opens, and its business; null for anything else. */
export async function resolveJobLink(
  db: Db,
  secret: string,
): Promise<{ readonly businessId: string; readonly jobId: string } | null> {
  const link = await db.tx((client) => resolve(client, secret));
  return link?.purpose === "job" ? { businessId: link.businessId, jobId: link.subjectId } : null;
}

/** What the customer sees for a link, or null if the link is not a live job link. */
export async function openJobLink(db: Db, secret: string): Promise<CustomerJobView | null> {
  const link = await resolveJobLink(db, secret);
  if (!link) return null;
  return db.withTenant(link.businessId, async (client) => {
    const { rows } = await client.query<JobRow>(
      `select j.number, j.status, j.created_at, c.name as customer_name
       from kk.job j
       join kk.customer c on c.business_id = j.business_id and c.id = j.customer_id
       where j.id = $1`,
      [link.jobId],
    );
    const job = rows[0];
    if (!job) return null;
    const business = await currentBusiness(client);
    return {
      items: await workItems(client, link.jobId),
      quote: await customerQuote(client, link.jobId),
      businessName: business.name,
      businessPhone: business.phone,
      number: job.number,
      status: job.status,
      customerName: job.customer_name,
      requestedAt: job.created_at,
    };
  });
}
