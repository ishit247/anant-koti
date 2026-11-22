// Planning visits to a job (docs/architecture.md 5.3 and 6). Every function runs inside withTenant.
import type { Audit } from "@bodhchakra/audit";
import type { DbClient } from "@bodhchakra/db";
import { z } from "zod";
import { type JobStatus, transitionJob } from "./job.ts";

export const VISIT_KINDS = ["site_visit", "work"] as const;
export type VisitKind = (typeof VISIT_KINDS)[number];

/** A site visit may be planned while the job is open; the work only once the quote is accepted. */
const SITE_VISIT_STATES: readonly JobStatus[] = ["requested", "quoted", "accepted", "scheduled"];

/** Times are typed in the business's own time zone, as a `datetime-local` field sends them. */
export const visitInput = z.object({
  jobId: z.uuid(),
  kind: z.enum(VISIT_KINDS),
  technicianId: z.uuid(),
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
  minutes: z.coerce.number().int().min(15).max(720),
});
export type VisitInput = z.input<typeof visitInput>;

export type VisitError = "input" | "not_found" | "closed" | "technician" | "conflict";
export type VisitResult =
  | { readonly ok: true; readonly appointmentId: string }
  | { readonly ok: false; readonly error: VisitError };

export interface Visit {
  readonly id: string;
  readonly jobId: string;
  readonly jobNumber: number;
  readonly customerName: string;
  readonly kind: VisitKind;
  readonly technicianId: string;
  readonly technicianName: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
}

export interface Planner {
  readonly businessId: string;
  readonly memberId: string;
}

const EXCLUSION_VIOLATION = "23P01";

/** Runs the write in a savepoint, so a double booking leaves the caller's transaction usable. */
async function bookable<T>(client: DbClient, write: () => Promise<T>): Promise<T | "conflict"> {
  await client.query("savepoint booking");
  try {
    const result = await write();
    await client.query("release savepoint booking");
    return result;
  } catch (error) {
    await client.query("rollback to savepoint booking");
    if ((error as { code?: string }).code === EXCLUSION_VIOLATION) return "conflict";
    throw error;
  }
}

async function activeMember(client: DbClient, memberId: string): Promise<boolean> {
  const { rows } = await client.query(
    "select 1 from tenancy.member where id = $1 and removed_at is null",
    [memberId],
  );
  return rows.length > 0;
}

async function lockJob(client: DbClient, jobId: string): Promise<JobStatus | null> {
  const { rows } = await client.query<{ status: JobStatus }>(
    "select status from kk.job where id = $1 for update",
    [jobId],
  );
  return rows[0]?.status ?? null;
}

/**
 * Plans a visit. Planning the work of an accepted job moves it to `scheduled`, in the same transaction.
 * A technician who already holds a planned visit at that time is refused by the database (`conflict`).
 */
export async function planVisit(
  client: DbClient,
  audit: Audit,
  owner: Planner,
  raw: VisitInput,
): Promise<VisitResult> {
  const input = visitInput.safeParse(raw);
  if (!input.success) return { ok: false, error: "input" };
  const { jobId, kind, technicianId, start, minutes } = input.data;
  const status = await lockJob(client, jobId);
  if (status === null) return { ok: false, error: "not_found" };
  if (kind === "work" ? status !== "accepted" : !SITE_VISIT_STATES.includes(status))
    return { ok: false, error: "closed" };
  if (!(await activeMember(client, technicianId))) return { ok: false, error: "technician" };

  const booked = await bookable(client, async () => {
    const { rows } = await client.query<{ id: string }>(
      `insert into kk.appointment (business_id, job_id, kind, technician_member_id, starts_at, ends_at)
       select $1, $2, $3, $4, s.at, s.at + make_interval(mins => $6)
       from (select $5::timestamp at time zone
                    (select timezone from tenancy.business where id = $1) as at) s
       returning id`,
      [owner.businessId, jobId, kind, technicianId, start, minutes],
    );
    return rows[0]?.id as string;
  });
  if (booked === "conflict") return { ok: false, error: "conflict" };

  if (kind === "work") {
    const moved = await transitionJob(client, audit, jobId, {
      event: "schedule",
      actor: { role: "owner", memberId: owner.memberId },
    });
    // The job is locked and was `accepted` above, so the table allows this; anything else is a bug.
    if (!moved.ok) throw new Error("planVisit: an accepted job refused to be scheduled");
  }
  await audit.record(client, {
    businessId: owner.businessId,
    actor: { kind: "member", id: owner.memberId },
    action: "appointment.planned",
    entity: "appointment",
    entityId: booked,
    data: { jobId, kind, technicianId },
  });
  return { ok: true, appointmentId: booked };
}

/** Moves a planned visit to another time or technician; the same conflict rule applies. */
export async function moveVisit(
  client: DbClient,
  audit: Audit,
  owner: Planner,
  appointmentId: string,
  raw: Pick<VisitInput, "technicianId" | "start" | "minutes">,
): Promise<VisitResult> {
  const id = z.uuid().safeParse(appointmentId);
  const input = visitInput.pick({ technicianId: true, start: true, minutes: true }).safeParse(raw);
  if (!id.success || !input.success) return { ok: false, error: "input" };
  const { technicianId, start, minutes } = input.data;
  const found = await client.query<{ job_id: string }>(
    "select job_id from kk.appointment where id = $1 and status = 'planned'",
    [id.data],
  );
  const jobId = found.rows[0]?.job_id;
  if (jobId === undefined) return { ok: false, error: "not_found" };
  await lockJob(client, jobId);
  if (!(await activeMember(client, technicianId))) return { ok: false, error: "technician" };

  const moved = await bookable(client, async () => {
    await client.query(
      `update kk.appointment a
       set technician_member_id = $2, starts_at = s.at, ends_at = s.at + make_interval(mins => $4)
       from (select $3::timestamp at time zone
                    (select timezone from tenancy.business where id = $5) as at) s
       where a.id = $1`,
      [id.data, technicianId, start, minutes, owner.businessId],
    );
  });
  if (moved === "conflict") return { ok: false, error: "conflict" };
  await audit.record(client, {
    businessId: owner.businessId,
    actor: { kind: "member", id: owner.memberId },
    action: "appointment.moved",
    entity: "appointment",
    entityId: id.data,
    data: { jobId, technicianId },
  });
  return { ok: true, appointmentId: id.data };
}

/** Planned visits from `from` on, soonest first; one job's, or the whole business's when no job is given. */
export async function plannedVisits(
  client: DbClient,
  from: Date,
  jobId?: string,
): Promise<Visit[]> {
  const { rows } = await client.query<{
    id: string;
    job_id: string;
    number: number;
    customer_name: string;
    kind: VisitKind;
    technician_member_id: string;
    technician_name: string;
    starts_at: Date;
    ends_at: Date;
  }>(
    `select a.id, a.job_id, j.number, c.name as customer_name, a.kind, a.technician_member_id,
            m.display_name as technician_name, a.starts_at, a.ends_at
     from kk.appointment a
     join kk.job j on j.business_id = a.business_id and j.id = a.job_id
     join kk.customer c on c.business_id = j.business_id and c.id = j.customer_id
     join tenancy.member m on m.business_id = a.business_id and m.id = a.technician_member_id
     where a.status = 'planned' and a.ends_at > $1 and ($2::uuid is null or a.job_id = $2)
     order by a.starts_at, a.id`,
    [from, jobId ?? null],
  );
  return rows.map((r) => ({
    id: r.id,
    jobId: r.job_id,
    jobNumber: r.number,
    customerName: r.customer_name,
    kind: r.kind,
    technicianId: r.technician_member_id,
    technicianName: r.technician_name,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
  }));
}

/** The members a visit can be given to: everyone who has not left, the owner first. */
export async function assignableMembers(
  client: DbClient,
): Promise<{ readonly id: string; readonly name: string }[]> {
  const { rows } = await client.query<{ id: string; name: string }>(
    `select id, display_name as name from tenancy.member
     where removed_at is null order by (role = 'owner') desc, display_name`,
  );
  return rows;
}
