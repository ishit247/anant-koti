// A job's states and the one way they change (docs/architecture.md 6).
import type { Audit } from "@bodhchakra/audit";
import type { DbClient } from "@bodhchakra/db";

// The CHECK on kk.job.status lists the same values.
export const JOB_STATUSES = [
  "requested",
  "quoted",
  "accepted",
  "scheduled",
  "in_progress",
  "completed",
  "declined",
  "lost",
  "cancelled",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_EVENTS = [
  "quote_sent",
  "decline",
  "accept",
  "reject",
  "counter",
  "revise",
  "edit",
  "close_lost",
  "schedule",
  "check_in",
  "complete",
  "cancel",
] as const;
export type JobEvent = (typeof JOB_EVENTS)[number];

/** Who acts on a job: a member by role, or the customer through their link. */
export type JobRole = "owner" | "technician" | "customer";

interface Transition {
  readonly from: readonly JobStatus[];
  readonly event: JobEvent;
  readonly to: JobStatus;
  readonly by: readonly JobRole[];
}

/**
 * Section 6's table, row for row. A pair not listed is refused. Side effects belong to the caller, which runs
 * them in the same transaction (a quote's status, a visit's times); a technician's assignment is the caller's
 * check too.
 */
const TRANSITIONS: readonly Transition[] = [
  { from: ["requested"], event: "quote_sent", to: "quoted", by: ["owner"] },
  { from: ["requested"], event: "decline", to: "declined", by: ["owner"] },
  { from: ["quoted"], event: "accept", to: "accepted", by: ["customer"] },
  { from: ["quoted"], event: "reject", to: "quoted", by: ["customer"] },
  { from: ["quoted"], event: "counter", to: "quoted", by: ["customer"] },
  { from: ["quoted"], event: "revise", to: "quoted", by: ["owner"] },
  { from: ["quoted"], event: "edit", to: "requested", by: ["customer"] },
  { from: ["quoted"], event: "close_lost", to: "lost", by: ["owner"] },
  // The customer confirms the proposed time; the owner does it for one who agreed by phone (3.1b).
  { from: ["accepted"], event: "schedule", to: "scheduled", by: ["owner", "customer"] },
  { from: ["scheduled"], event: "check_in", to: "in_progress", by: ["technician", "owner"] },
  { from: ["in_progress"], event: "complete", to: "completed", by: ["technician", "owner"] },
  {
    from: ["requested", "quoted", "accepted", "scheduled"],
    event: "cancel",
    to: "cancelled",
    by: ["owner", "customer"],
  },
];

/** The state an event moves a job to, or null if that role may not do it from there. */
export function jobTransition(from: JobStatus, event: JobEvent, by: JobRole): JobStatus | null {
  const row = TRANSITIONS.find(
    (t) => t.event === event && t.from.includes(from) && t.by.includes(by),
  );
  return row?.to ?? null;
}

export type JobActor =
  | { readonly role: "owner" | "technician"; readonly memberId: string }
  /** Acting through the job's link; the audit names the job's customer. */
  | { readonly role: "customer" };

export interface JobChange {
  readonly event: JobEvent;
  readonly actor: JobActor;
  /** Only with `accept`: the quote accepted, stored as `job.accepted_quote_id` in the same write. */
  readonly acceptedQuoteId?: string;
  /** Recorded with the audit event; no personal data. */
  readonly data?: Readonly<Record<string, string | number | boolean | null>>;
}

export type JobTransitionResult =
  | { readonly ok: true; readonly from: JobStatus; readonly to: JobStatus }
  | { readonly ok: false; readonly error: "not_found" | "refused" };

/**
 * Moves a job by one event of the table, and audits it as `job.<event>`, on the caller's transaction (inside
 * `withTenant`, so a job of another business is not found). Refused pairs change nothing; the caller runs its
 * side effects only after a success, so a refusal leaves no half-done work.
 */
export async function transitionJob(
  client: DbClient,
  audit: Audit,
  jobId: string,
  change: JobChange,
): Promise<JobTransitionResult> {
  if ((change.event === "accept") !== (change.acceptedQuoteId !== undefined))
    throw new Error("transitionJob: acceptedQuoteId goes with accept, and only with accept");
  const { rows } = await client.query<{
    business_id: string;
    customer_id: string;
    status: JobStatus;
  }>("select business_id, customer_id, status from kk.job where id = $1 for update", [jobId]);
  const job = rows[0];
  if (!job) return { ok: false, error: "not_found" };
  const to = jobTransition(job.status, change.event, change.actor.role);
  if (to === null) return { ok: false, error: "refused" };

  await client.query(
    "update kk.job set status = $2, accepted_quote_id = coalesce($3, accepted_quote_id) where id = $1",
    [jobId, to, change.acceptedQuoteId ?? null],
  );
  await audit.record(client, {
    businessId: job.business_id,
    actor:
      change.actor.role === "customer"
        ? { kind: "customer", id: job.customer_id }
        : { kind: "member", id: change.actor.memberId },
    action: `job.${change.event}`,
    entity: "job",
    entityId: jobId,
    data: { ...change.data, from: job.status, to },
  });
  return { ok: true, from: job.status, to };
}

/** The job's tasks still asked for, in the order they were added. Runs inside withTenant. */
export async function jobTasks(
  client: DbClient,
  jobId: string,
): Promise<{ readonly id: string; readonly title: string }[]> {
  const { rows } = await client.query<{ id: string; title: string }>(
    "select id, title from kk.job_task where job_id = $1 and status <> 'dropped' order by added_at, id",
    [jobId],
  );
  return rows;
}

/** A work item as the customer described it, with the photos they sent for it. */
export interface WorkItem {
  readonly id: string;
  readonly title: string;
  readonly details: string | null;
  /** From the price list, so priced at its price; otherwise the business proposes one. */
  readonly listed: boolean;
  /** Storage keys; the page signs a URL for each. */
  readonly photos: readonly { readonly key: string }[];
}

/** The job's work items still asked for, in the order they were added, each with its photos. */
export async function workItems(client: DbClient, jobId: string): Promise<WorkItem[]> {
  const tasks = await client.query<{
    id: string;
    title: string;
    details: string | null;
    listed: boolean;
  }>(
    `select id, title, details, catalogue_item_id is not null as listed from kk.job_task
     where job_id = $1 and status <> 'dropped' order by added_at, id`,
    [jobId],
  );
  const photos = await client.query<{ job_task_id: string; key: string }>(
    `select p.job_task_id, o.key from kk.job_photo p
     join storage.object o on o.business_id = p.business_id and o.id = p.object_id
     where p.job_id = $1 and p.kind = 'request'
     order by p.created_at, p.id`,
    [jobId],
  );
  return tasks.rows.map((task) => ({
    ...task,
    photos: photos.rows.filter((p) => p.job_task_id === task.id).map(({ key }) => ({ key })),
  }));
}
