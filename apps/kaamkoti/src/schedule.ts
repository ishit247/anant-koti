// Planning visits to a job (docs/architecture.md 5.3 and 6). Every function runs inside withTenant. A site visit
// is planned by the owner alone; the work's time is agreed (3.1b): the owner proposes it, and it becomes the
// planned visit, moving the job to `scheduled`, only once the customer confirms it.
import type { Audit } from "@bodhchakra/audit";
import type { DbClient } from "@bodhchakra/db";
import { z } from "zod";
import type { SpaceCustomer } from "./customer-space.ts";
import { type JobActor, type JobStatus, transitionJob } from "./job.ts";

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
/** A visit that holds the technician's time: planned, or the work proposed and not yet answered. */
export type HeldStatus = "proposed" | "planned";

export type VisitResult =
  | { readonly ok: true; readonly appointmentId: string; readonly status: HeldStatus }
  | { readonly ok: false; readonly error: VisitError };

export interface Visit {
  readonly id: string;
  readonly jobId: string;
  readonly jobNumber: number;
  readonly customerName: string;
  readonly kind: VisitKind;
  readonly status: HeldStatus;
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
 * Plans a site visit, or proposes the time of an accepted job's work (`proposed`, which replaces a proposal not
 * yet answered; the job stays `accepted` until the customer confirms). Either holds the technician's time: one
 * who already holds a visit then is refused by the database (`conflict`).
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
  const held: HeldStatus = kind === "work" ? "proposed" : "planned";

  // Inside the savepoint, so a refused new time leaves the earlier proposal standing.
  const booked = await bookable(client, async () => {
    if (held === "proposed")
      await client.query(
        "update kk.appointment set status = 'cancelled' where job_id = $1 and status = 'proposed'",
        [jobId],
      );
    const { rows } = await client.query<{ id: string }>(
      `insert into kk.appointment (business_id, job_id, kind, technician_member_id, starts_at, ends_at, status)
       select $1, $2, $3, $4, s.at, s.at + make_interval(mins => $6), $7
       from (select $5::timestamp at time zone
                    (select timezone from tenancy.business where id = $1) as at) s
       returning id`,
      [owner.businessId, jobId, kind, technicianId, start, minutes, held],
    );
    return rows[0]?.id as string;
  });
  if (booked === "conflict") return { ok: false, error: "conflict" };

  await audit.record(client, {
    businessId: owner.businessId,
    actor: { kind: "member", id: owner.memberId },
    action: `appointment.${held}`,
    entity: "appointment",
    entityId: booked,
    data: { jobId, kind, technicianId },
  });
  return { ok: true, appointmentId: booked, status: held };
}

export type VisitAnswer =
  | { readonly kind: "confirm" }
  /** Asks for another time; the note (at most 500 characters) says which suits. */
  | { readonly kind: "decline"; readonly note: string | null };

/** `answered`: the time is no longer the open proposal (answered, or replaced by a newer one). */
export type VisitAnswerError = "not_found" | "answered" | "closed";
export type VisitAnswerResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: VisitAnswerError };

export const visitNote = z
  .string()
  .trim()
  .max(500)
  .transform((s) => s || null);

/**
 * The customer's answer to the proposed time on their own request. The job is looked up under the customer
 * first, so another customer's or business's job is `not_found`, like a missing one.
 */
export async function answerVisit(
  client: DbClient,
  audit: Audit,
  customer: SpaceCustomer,
  jobId: string,
  appointmentId: string,
  answer: VisitAnswer,
): Promise<VisitAnswerResult> {
  if (!z.uuid().safeParse(jobId).success || !z.uuid().safeParse(appointmentId).success)
    return { ok: false, error: "not_found" };
  const { rows } = await client.query<{ status: JobStatus }>(
    "select status from kk.job where business_id = $1 and customer_id = $2 and id = $3 for update",
    [customer.businessId, customer.id, jobId],
  );
  const job = rows[0];
  if (!job) return { ok: false, error: "not_found" };
  return settle(client, audit, {
    businessId: customer.businessId,
    jobId,
    jobStatus: job.status,
    appointmentId,
    answer,
    actor: { role: "customer" },
    by: { kind: "customer", id: customer.id },
  });
}

/** The owner records that the customer agreed to the proposed time another way (by phone, in person). */
export async function confirmVisitFor(
  client: DbClient,
  audit: Audit,
  owner: Planner,
  appointmentId: string,
): Promise<VisitAnswerResult> {
  if (!z.uuid().safeParse(appointmentId).success) return { ok: false, error: "not_found" };
  const { rows } = await client.query<{ job_id: string }>(
    "select job_id from kk.appointment where id = $1",
    [appointmentId],
  );
  const jobId = rows[0]?.job_id;
  if (jobId === undefined) return { ok: false, error: "not_found" };
  const jobStatus = await lockJob(client, jobId);
  if (jobStatus === null) return { ok: false, error: "not_found" };
  return settle(client, audit, {
    businessId: owner.businessId,
    jobId,
    jobStatus,
    appointmentId,
    answer: { kind: "confirm" },
    actor: { role: "owner", memberId: owner.memberId },
    by: { kind: "member", id: owner.memberId },
  });
}

/** Answers the job's open proposal; the job row is locked by the caller. */
async function settle(
  client: DbClient,
  audit: Audit,
  a: {
    businessId: string;
    jobId: string;
    jobStatus: JobStatus;
    appointmentId: string;
    answer: VisitAnswer;
    actor: JobActor;
    by: { kind: "customer" | "member"; id: string };
  },
): Promise<VisitAnswerResult> {
  const { rows } = await client.query<{ status: string }>(
    "select status from kk.appointment where id = $1 and job_id = $2 and kind = 'work' for update",
    [a.appointmentId, a.jobId],
  );
  const visit = rows[0];
  if (!visit) return { ok: false, error: "not_found" };
  if (visit.status !== "proposed") return { ok: false, error: "answered" };
  if (a.jobStatus !== "accepted") return { ok: false, error: "closed" };

  const confirmed = a.answer.kind === "confirm";
  await client.query(
    `update kk.appointment set status = $2, customer_note = $3, answered_at = now() where id = $1`,
    [
      a.appointmentId,
      confirmed ? "planned" : "declined",
      a.answer.kind === "decline" ? a.answer.note : null,
    ],
  );
  if (confirmed) {
    const moved = await transitionJob(client, audit, a.jobId, {
      event: "schedule",
      actor: a.actor,
    });
    // The job is locked and `accepted`, so the table allows this; anything else is a bug.
    if (!moved.ok) throw new Error("settle: an accepted job refused to be scheduled");
  }
  await audit.record(client, {
    businessId: a.businessId,
    actor: a.by,
    action: confirmed ? "appointment.confirmed" : "appointment.declined",
    entity: "appointment",
    entityId: a.appointmentId,
    data: { jobId: a.jobId },
  });
  return { ok: true };
}

/** The work's time as it is being agreed, and after: the newest work visit that was not withdrawn. */
export interface WorkTime {
  readonly id: string;
  readonly status: "proposed" | "planned" | "declined" | "done";
  readonly startsAt: Date;
  readonly endsAt: Date;
  /** What the customer said when asking for another time. */
  readonly note: string | null;
}

export async function workTime(client: DbClient, jobId: string): Promise<WorkTime | null> {
  const { rows } = await client.query<{
    id: string;
    status: WorkTime["status"];
    starts_at: Date;
    ends_at: Date;
    customer_note: string | null;
  }>(
    `select id, status, starts_at, ends_at, customer_note from kk.appointment
     where job_id = $1 and kind = 'work' and status <> 'cancelled'
     order by created_at desc, id limit 1`,
    [jobId],
  );
  const row = rows[0];
  return row
    ? {
        id: row.id,
        status: row.status,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        note: row.customer_note,
      }
    : null;
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
  return { ok: true, appointmentId: id.data, status: "planned" };
}

/** Whether the appointment is a planned visit of this job: the check before a route acts on a posted pair of ids. */
export async function isPlannedVisitOf(
  client: DbClient,
  jobId: string,
  appointmentId: string,
): Promise<boolean> {
  const { rowCount } = await client.query(
    "select 1 from kk.appointment where id = $1 and job_id = $2 and status = 'planned'",
    [appointmentId, jobId],
  );
  return rowCount === 1;
}

/**
 * The visits holding time from `from` on (planned, and the work proposed), soonest first; one job's, or the
 * whole business's when no job is given.
 */
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
    status: HeldStatus;
    technician_member_id: string;
    technician_name: string;
    starts_at: Date;
    ends_at: Date;
  }>(
    `select a.id, a.job_id, j.number, c.name as customer_name, a.kind, a.status, a.technician_member_id,
            m.display_name as technician_name, a.starts_at, a.ends_at
     from kk.appointment a
     join kk.job j on j.business_id = a.business_id and j.id = a.job_id
     join kk.customer c on c.business_id = j.business_id and c.id = j.customer_id
     join tenancy.member m on m.business_id = a.business_id and m.id = a.technician_member_id
     where a.status in ('proposed', 'planned') and a.ends_at > $1 and ($2::uuid is null or a.job_id = $2)
     order by a.starts_at, a.id`,
    [from, jobId ?? null],
  );
  return rows.map((r) => ({
    id: r.id,
    jobId: r.job_id,
    jobNumber: r.number,
    customerName: r.customer_name,
    kind: r.kind,
    status: r.status,
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
