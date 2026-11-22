// The customer's space in one business (docs/architecture.md 7, D15): which customer row a signed-in identity is
// here, and that customer's own jobs. Everything runs inside withTenant for the business named by the slug, and
// every job query names the customer, so neither another business's nor another customer's job is reachable.
import type { Audit } from "@bodhchakra/audit";
import type { CustomerSession } from "@bodhchakra/auth";
import type { DbClient } from "@bodhchakra/db";
import { z } from "zod";
import type { JobStatus } from "./job.ts";
import { localPhone, phone } from "./phone.ts";

/** The customer's list, by state (architecture 6): Active is the default. */
export const JOB_GROUPS = {
  active: ["requested", "quoted", "accepted", "scheduled", "in_progress"],
  completed: ["completed"],
  cancelled: ["cancelled", "declined", "lost"],
} as const satisfies Record<string, readonly JobStatus[]>;
export type JobGroup = keyof typeof JOB_GROUPS;

export const jobGroup = (value: string | undefined): JobGroup =>
  value === "completed" || value === "cancelled" ? value : "active";

/** This business's customer row for the signed-in identity: its id and the business it belongs to. */
export interface SpaceCustomer {
  readonly id: string;
  readonly businessId: string;
}

/**
 * The current business's customer row for this identity. With none yet, an owner-entered row (no identity) with
 * the session's verified email is claimed for it, the oldest if several. Null: this person has not asked the
 * business for anything, so their list is empty.
 */
export async function customerFor(
  client: DbClient,
  audit: Audit,
  session: CustomerSession,
): Promise<SpaceCustomer | null> {
  const linked = await client.query<{ id: string; business_id: string }>(
    "select id, business_id from kk.customer where identity_id = $1",
    [session.identityId],
  );
  if (linked.rows[0]) return { id: linked.rows[0].id, businessId: linked.rows[0].business_id };

  // A savepoint, because the same person signing in twice at once can claim a second row; the unique
  // (business_id, identity_id) refuses it, and the row the other request linked is the answer.
  await client.query("savepoint claim");
  let claimed: { id: string; business_id: string } | undefined;
  try {
    ({
      rows: [claimed],
    } = await client.query<{ id: string; business_id: string }>(
      `update kk.customer set identity_id = $1
       where identity_id is null
         and id = (select id from kk.customer
                   where identity_id is null and lower(email) = lower($2)
                   order by created_at, id limit 1)
       returning id, business_id`,
      [session.identityId, session.email],
    ));
    await client.query("release savepoint claim");
  } catch (error) {
    await client.query("rollback to savepoint claim");
    if ((error as { code?: string }).code !== "23505") throw error;
    return customerFor(client, audit, session);
  }
  if (!claimed) return null;
  await audit.record(client, {
    businessId: claimed.business_id,
    actor: { kind: "customer", id: claimed.id },
    action: "customer.claimed",
    entity: "customer",
    entityId: claimed.id,
  });
  return { id: claimed.id, businessId: claimed.business_id };
}

/** The account holder's own name and mobile in this business; where work is done is in the address book. */
export interface CustomerContact {
  readonly name: string;
  /** As typed in India (localPhone). */
  readonly phone: string;
}

export async function customerContact(
  client: DbClient,
  customer: SpaceCustomer,
): Promise<CustomerContact> {
  const { rows } = await client.query<{ name: string; phone_e164: string }>(
    "select name, phone_e164 from kk.customer where business_id = $1 and id = $2",
    [customer.businessId, customer.id],
  );
  const row = rows[0];
  if (!row) throw new Error(`customerContact: no customer ${customer.id} in this business`);
  return { name: row.name, phone: localPhone(row.phone_e164) };
}

const ownDetails = z.object({ name: z.string().trim().min(1).max(120), phone });

/**
 * The customer's own name and mobile, edited on Profile. A mobile on another customer's row is refused
 * (`phone_taken`): phones are unverified until 3.3, so typing someone's number must not take it over.
 */
export async function updateOwnDetails(
  client: DbClient,
  customer: SpaceCustomer,
  input: { readonly name: string; readonly phone: string },
): Promise<"saved" | "contact" | "phone_taken"> {
  const details = ownDetails.safeParse(input);
  if (!details.success) return "contact";
  const { rowCount } = await client.query(
    `update kk.customer set name = $3, phone_e164 = $4
     where business_id = $1 and id = $2
       and not exists (select 1 from kk.customer where phone_e164 = $4 and id <> $2)`,
    [customer.businessId, customer.id, details.data.name, details.data.phone],
  );
  return (rowCount ?? 0) > 0 ? "saved" : "phone_taken";
}

export interface CustomerJobRow {
  readonly id: string;
  readonly number: number;
  readonly status: JobStatus;
  readonly createdAt: Date;
  /** Titles of the work items, in the order they were added. */
  readonly tasks: readonly string[];
}

/** The customer's own jobs in one group, newest first. */
export async function customerJobs(
  client: DbClient,
  customer: SpaceCustomer,
  group: JobGroup,
): Promise<CustomerJobRow[]> {
  const { rows } = await client.query<{
    id: string;
    number: number;
    status: JobStatus;
    created_at: Date;
    tasks: string[];
  }>(
    `select j.id, j.number, j.status, j.created_at,
            array(select t.title from kk.job_task t
                  where t.business_id = j.business_id and t.job_id = j.id and t.status <> 'dropped'
                  order by t.added_at, t.id) as tasks
     from kk.job j
     where j.business_id = $1 and j.customer_id = $2 and j.status = any($3)
     order by j.created_at desc, j.number desc`,
    [customer.businessId, customer.id, JOB_GROUPS[group]],
  );
  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    status: r.status,
    createdAt: r.created_at,
    tasks: r.tasks,
  }));
}
