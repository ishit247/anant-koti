// The owner's side of a request (docs/architecture.md 4.3, scope `member`): the list of requests from every
// source, one request in full, a phone enquiry logged by hand, and a fresh customer link. All of it runs inside
// withTenant of the owner's business, so another business's jobs are not there to find.
import type { Audit } from "@bodhchakra/audit";
import type { DbClient } from "@bodhchakra/db";
import { z } from "zod";
import { activeItems, contact, createJob, findOrCreateCustomer, type Location } from "./intake.ts";
import { type JobStatus, type WorkItem, workItems } from "./job.ts";
import { issueJobLink, revokeJobLinks } from "./job-link.ts";

export type JobSource = "public_form" | "whatsapp_link" | "qr" | "phone";

const INBOX_LIMIT = 100;

export interface InboxRow {
  readonly id: string;
  readonly number: number;
  readonly status: JobStatus;
  readonly source: JobSource;
  readonly customerName: string;
  readonly createdAt: Date;
  /** Titles of the tasks, in the order they were added. */
  readonly tasks: readonly string[];
}

/** The newest requests first, whichever way they came in. */
export async function listInbox(client: DbClient): Promise<InboxRow[]> {
  const { rows } = await client.query<{
    id: string;
    number: number;
    status: JobStatus;
    source: JobSource;
    customer_name: string;
    created_at: Date;
    tasks: string[];
  }>(
    `select j.id, j.number, j.status, j.source, c.name as customer_name, j.created_at,
            array(select t.title from kk.job_task t
                  where t.business_id = j.business_id and t.job_id = j.id and t.status <> 'dropped'
                  order by t.added_at, t.id) as tasks
     from kk.job j
     join kk.customer c on c.business_id = j.business_id and c.id = j.customer_id
     order by j.created_at desc, j.number desc
     limit $1`,
    [INBOX_LIMIT],
  );
  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    status: r.status,
    source: r.source,
    customerName: r.customer_name,
    createdAt: r.created_at,
    tasks: r.tasks,
  }));
}

/** How many requests wait for a first answer (a quote). */
export async function countNewRequests(client: DbClient): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    "select count(*)::int as n from kk.job where status = 'requested'",
  );
  return rows[0]?.n ?? 0;
}

export interface OwnerJobView extends Omit<InboxRow, "tasks"> {
  readonly customerPhone: string;
  readonly address: string | null;
  /** Where the customer said they are, if they picked their location. */
  readonly location: Location | null;
  readonly items: readonly WorkItem[];
}

/** One request in full, or null if this business has no such job. */
export async function ownerJob(client: DbClient, jobId: string): Promise<OwnerJobView | null> {
  const { rows } = await client.query<{
    id: string;
    number: number;
    status: JobStatus;
    source: JobSource;
    customer_name: string;
    phone_e164: string;
    created_at: Date;
    address: string | null;
    latitude: number | null;
    longitude: number | null;
  }>(
    `select j.id, j.number, j.status, j.source, c.name as customer_name, c.phone_e164, j.created_at,
            j.address, j.latitude, j.longitude
     from kk.job j
     join kk.customer c on c.business_id = j.business_id and c.id = j.customer_id
     where j.id = $1`,
    [jobId],
  );
  const job = rows[0];
  if (!job) return null;
  return {
    id: job.id,
    number: job.number,
    status: job.status,
    source: job.source,
    customerName: job.customer_name,
    createdAt: job.created_at,
    customerPhone: job.phone_e164,
    address: job.address,
    // The table's check keeps the two together.
    location:
      job.latitude !== null && job.longitude !== null
        ? { latitude: job.latitude, longitude: job.longitude }
        : null,
    items: await workItems(client, jobId),
  };
}

export type PhoneEnquiryError = "contact" | "tasks";

export type PhoneEnquiryResult =
  | { readonly ok: true; readonly jobId: string }
  | { readonly ok: false; readonly error: PhoneEnquiryError };

const MAX_CUSTOM_TASK = 120;

/** A call or message the owner turns into a request: catalogue items and/or one custom task. */
export interface PhoneEnquiryInput {
  readonly name: string;
  readonly phone: string;
  readonly address: string;
  /** Catalogue item ids. */
  readonly tasks: readonly string[];
  readonly customTask: string;
}

const itemIds = z.array(z.uuid()).max(20);

/** Logs an enquiry that came by phone as a request, with the same customer and job rules as the public form. */
export async function logPhoneEnquiry(
  client: DbClient,
  audit: Audit,
  owner: { readonly businessId: string; readonly memberId: string },
  input: PhoneEnquiryInput,
): Promise<PhoneEnquiryResult> {
  const person = contact.safeParse(input);
  if (!person.success) return { ok: false, error: "contact" };
  const ids = itemIds.safeParse([...new Set(input.tasks)]);
  const custom = input.customTask.trim();
  if (!ids.success || custom.length > MAX_CUSTOM_TASK) return { ok: false, error: "tasks" };
  const items = await activeItems(client, ids.data);
  if (items.length !== ids.data.length || items.length + (custom ? 1 : 0) === 0)
    return { ok: false, error: "tasks" };

  const customerId = await findOrCreateCustomer(client, owner.businessId, person.data);
  const job = await createJob(client, owner.businessId, customerId, person.data, null, "phone");
  for (const item of items) {
    await client.query(
      `insert into kk.job_task (business_id, job_id, catalogue_item_id, title, added_by)
       values ($1, $2, $3, $4, 'business')`,
      [owner.businessId, job.id, item.id, item.name],
    );
  }
  if (custom) {
    await client.query(
      "insert into kk.job_task (business_id, job_id, title, added_by) values ($1, $2, $3, 'business')",
      [owner.businessId, job.id, custom],
    );
  }
  await audit.record(client, {
    businessId: owner.businessId,
    actor: { kind: "member", id: owner.memberId },
    action: "job.logged",
    entity: "job",
    entityId: job.id,
    data: { number: job.number, source: "phone" },
  });
  return { ok: true, jobId: job.id };
}

/**
 * Ends every live link to the job and issues a new one, for a link that went to a wrong number or was lost.
 * Returns the secret for the owner to send; null if this business has no such job.
 */
export async function reissueJobLink(
  client: DbClient,
  audit: Audit,
  owner: { readonly businessId: string; readonly memberId: string },
  jobId: string,
): Promise<{ secret: string; revoked: number } | null> {
  const { rows } = await client.query("select 1 from kk.job where id = $1", [jobId]);
  if (rows.length === 0) return null;
  const revoked = await revokeJobLinks(client, jobId);
  const { secret } = await issueJobLink(client, jobId);
  await audit.record(client, {
    businessId: owner.businessId,
    actor: { kind: "member", id: owner.memberId },
    action: "job.link_reissued",
    entity: "job",
    entityId: jobId,
    data: { revoked },
  });
  return { secret, revoked };
}
