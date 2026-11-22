// The customer's link to their job (docs/architecture.md 7, scope `customer-token`). A link opens exactly the
// job it was issued for, inside withTenant of that job's business. Each message to the customer carries a new
// link, live for JOB_LINK_DAYS after that message: the secret cannot be recovered to send again.
import type { Db, DbClient } from "@bodhchakra/db";
import { currentBusiness } from "@bodhchakra/tenancy";
import { issue, resolve, revokeFor } from "@bodhchakra/tokens";
import type { JobStatus } from "./job.ts";

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
  /** Titles of the tasks the request names, in the order they were added. */
  readonly tasks: readonly string[];
  /** The customer's own request photos; the page signs a URL for each (storage keys). */
  readonly photos: readonly { readonly key: string }[];
}

interface JobRow {
  number: number;
  status: JobStatus;
  created_at: Date;
  customer_name: string;
}

/** What the customer sees for a link, or null if the link is not a live job link. */
export async function openJobLink(db: Db, secret: string): Promise<CustomerJobView | null> {
  const link = await db.tx((client) => resolve(client, secret));
  if (link?.purpose !== "job") return null;
  return db.withTenant(link.businessId, async (client) => {
    const { rows } = await client.query<JobRow>(
      `select j.number, j.status, j.created_at, c.name as customer_name
       from kk.job j
       join kk.customer c on c.business_id = j.business_id and c.id = j.customer_id
       where j.id = $1`,
      [link.subjectId],
    );
    const job = rows[0];
    if (!job) return null;
    const business = await currentBusiness(client);
    const tasks = await client.query<{ title: string }>(
      "select title from kk.job_task where job_id = $1 and status <> 'dropped' order by added_at, id",
      [link.subjectId],
    );
    const photos = await client.query<{ key: string }>(
      `select o.key from kk.job_photo p
       join storage.object o on o.business_id = p.business_id and o.id = p.object_id
       where p.job_id = $1 and p.kind = 'request'
       order by p.created_at, p.id`,
      [link.subjectId],
    );
    return {
      tasks: tasks.rows.map((t) => t.title),
      photos: photos.rows,
      businessName: business.name,
      businessPhone: business.phone,
      number: job.number,
      status: job.status,
      customerName: job.customer_name,
      requestedAt: job.created_at,
    };
  });
}
