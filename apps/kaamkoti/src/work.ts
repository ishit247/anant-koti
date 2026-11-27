// Doing the work on site (docs/architecture.md 4.3, 6; step 4.2). On the job's planned work visit, its technician
// or the owner checks in (the job goes `in_progress`), ticks the business's checklist, adds before and after
// photos, and marks the job complete. Every function runs inside withTenant, which gives the business; the
// technician rule of 4.3, "assigned jobs only", is `assignedVisit`, the one place each of them finds the job.
import type { Audit } from "@bodhchakra/audit";
import type { DbClient } from "@bodhchakra/db";
import type { CheckedImage, Storage } from "@bodhchakra/storage";
import { z } from "zod";
import { businessProfile } from "./business-profile.ts";
import { addExtraWork, type ExtraWork } from "./change-order.ts";
import { type JobStatus, transitionJob, type WorkItem, workItems } from "./job.ts";

/** The member doing the work: the owner, or a technician, who may act only on their own visits. */
export interface Worker {
  readonly memberId: string;
  readonly role: "owner" | "technician";
}

/** A visit's checklist: the business's items as they stood at check-in, each ticked or not. */
const checklistResult = z.array(
  z.strictObject({ key: z.string(), label: z.string(), done: z.boolean() }),
);
export type ChecklistResult = z.infer<typeof checklistResult>;

export const WORK_PHOTO_KINDS = ["before", "after"] as const;
export type WorkPhotoKind = (typeof WORK_PHOTO_KINDS)[number];
/** Before and after photos together, per job. */
export const MAX_WORK_PHOTOS = 12;
const MAX_NOTE = 1000;

export type WorkError = "not_found" | "refused";

/**
 * The job's work visit if this member may work on it: planned, or done once the job is complete; the owner may
 * work on any, a technician only on one given to them. Null means the job reads as missing to them.
 */
async function assignedVisit(
  client: DbClient,
  worker: Worker,
  jobId: string,
): Promise<{ readonly appointmentId: string; readonly status: JobStatus } | null> {
  const { rows } = await client.query<{ appointment_id: string; status: JobStatus }>(
    `select a.id as appointment_id, j.status from kk.job j
     join kk.appointment a on a.business_id = j.business_id and a.job_id = j.id
     where j.id = $1 and a.kind = 'work' and a.status in ('planned', 'done')
       and ($2 or a.technician_member_id = $3)`,
    [jobId, worker.role === "owner", worker.memberId],
  );
  const row = rows[0];
  return row ? { appointmentId: row.appointment_id, status: row.status } : null;
}

/** Locks the job, so a check-in, a photo count or a completion cannot race another, then finds the visit. */
async function lockAssigned(client: DbClient, worker: Worker, jobId: string) {
  if (!z.uuid().safeParse(jobId).success) return null;
  await client.query("select 1 from kk.job where id = $1 for update", [jobId]);
  return assignedVisit(client, worker, jobId);
}

export interface WorkSheet {
  readonly jobId: string;
  readonly number: number;
  readonly status: JobStatus;
  readonly contactName: string;
  readonly contactPhone: string;
  readonly address: string | null;
  readonly location: { readonly latitude: number; readonly longitude: number } | null;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly technicianName: string;
  readonly items: readonly WorkItem[];
  /** The visit's ticks once checked in; before that, the business's checklist with nothing ticked. */
  readonly checklist: ChecklistResult;
  readonly checkedInAt: Date | null;
  readonly completedAt: Date | null;
  readonly note: string | null;
  /** Storage keys, oldest first; the page signs a URL for each. */
  readonly photos: readonly { readonly key: string; readonly kind: WorkPhotoKind }[];
}

/** The job as the person doing it sees it, or null if it is not theirs to work on. */
export async function workSheet(
  client: DbClient,
  worker: Worker,
  jobId: string,
): Promise<WorkSheet | null> {
  if (!z.uuid().safeParse(jobId).success) return null;
  const visit = await assignedVisit(client, worker, jobId);
  if (!visit) return null;
  const { rows } = await client.query<{
    number: number;
    status: JobStatus;
    contact_name: string;
    contact_phone_e164: string;
    address: string | null;
    latitude: number | null;
    longitude: number | null;
    starts_at: Date;
    ends_at: Date;
    technician_name: string;
    checklist: unknown;
    checked_in_at: Date | null;
    completed_at: Date | null;
    note: string | null;
  }>(
    `select j.number, j.status, j.contact_name, j.contact_phone_e164, j.address, j.latitude, j.longitude,
            a.starts_at, a.ends_at, m.display_name as technician_name,
            v.checklist, v.checked_in_at, v.completed_at, v.note
     from kk.job j
     join kk.appointment a on a.business_id = j.business_id and a.id = $2
     join tenancy.member m on m.business_id = a.business_id and m.id = a.technician_member_id
     left join kk.job_visit v on v.business_id = j.business_id and v.job_id = j.id
     where j.id = $1`,
    [jobId, visit.appointmentId],
  );
  const row = rows[0];
  if (!row) throw new Error("work: the assigned job was not found again");
  const photos = await client.query<{ key: string; kind: WorkPhotoKind }>(
    `select o.key, p.kind from kk.job_photo p
     join storage.object o on o.business_id = p.business_id and o.id = p.object_id
     where p.job_id = $1 and p.kind in ('before', 'after')
     order by p.created_at, p.id`,
    [jobId],
  );
  return {
    jobId,
    number: row.number,
    status: row.status,
    contactName: row.contact_name,
    contactPhone: row.contact_phone_e164,
    address: row.address,
    // The table's check keeps the two together.
    location:
      row.latitude !== null && row.longitude !== null
        ? { latitude: row.latitude, longitude: row.longitude }
        : null,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    technicianName: row.technician_name,
    items: await workItems(client, jobId),
    checklist:
      row.checked_in_at === null
        ? await freshChecklist(client)
        : checklistResult.parse(row.checklist),
    checkedInAt: row.checked_in_at,
    completedAt: row.completed_at,
    note: row.note,
    photos: photos.rows,
  };
}

async function freshChecklist(client: DbClient): Promise<ChecklistResult> {
  const profile = await businessProfile(client);
  return (profile?.checklist ?? []).map(({ key, label }) => ({ key, label, done: false }));
}

export type WorkResult = { readonly ok: true } | { readonly ok: false; readonly error: WorkError };

/** Arrives on site: the job goes `scheduled → in_progress`, and the visit starts with the business's checklist. */
export async function checkIn(
  client: DbClient,
  audit: Audit,
  worker: Worker,
  jobId: string,
): Promise<WorkResult> {
  const visit = await lockAssigned(client, worker, jobId);
  if (!visit) return { ok: false, error: "not_found" };
  const moved = await transitionJob(client, audit, jobId, {
    event: "check_in",
    actor: worker,
    data: { appointmentId: visit.appointmentId },
  });
  if (!moved.ok) return moved;
  await client.query(
    `insert into kk.job_visit (business_id, job_id, appointment_id, checklist)
     values (nullif(current_setting('app.business_id', true), '')::uuid, $1, $2, $3)`,
    [jobId, visit.appointmentId, JSON.stringify(await freshChecklist(client))],
  );
  return { ok: true };
}

/** Sets which checklist items are done (all the ticked keys at once); only while the work is under way. */
export async function tickChecklist(
  client: DbClient,
  worker: Worker,
  jobId: string,
  doneKeys: readonly string[],
): Promise<WorkResult> {
  const visit = await lockAssigned(client, worker, jobId);
  if (!visit) return { ok: false, error: "not_found" };
  if (visit.status !== "in_progress") return { ok: false, error: "refused" };
  const { rows } = await client.query<{ checklist: unknown }>(
    "select checklist from kk.job_visit where job_id = $1",
    [jobId],
  );
  const ticked = new Set(doneKeys);
  const checklist = checklistResult
    .parse(rows[0]?.checklist)
    .map((item) => ({ ...item, done: ticked.has(item.key) }));
  await client.query("update kk.job_visit set checklist = $2 where job_id = $1", [
    jobId,
    JSON.stringify(checklist),
  ]);
  return { ok: true };
}

/**
 * Extra work found on site, while the work is under way: a task that waits for the owner to price it in a change
 * order and the customer to approve it (4.3). A technician proposes it; only the owner prices.
 */
export async function addFoundWork(
  client: DbClient,
  worker: Worker,
  jobId: string,
  work: ExtraWork,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: WorkError | "items" }> {
  const visit = await lockAssigned(client, worker, jobId);
  if (!visit) return { ok: false, error: "not_found" };
  if (visit.status !== "in_progress") return { ok: false, error: "refused" };
  const added = await addExtraWork(client, jobId, "business", work);
  if (added === "added") return { ok: true };
  return { ok: false, error: added === "items" ? "items" : "refused" };
}

export type WorkPhotoResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: WorkError | "too_many_photos" };

/** Adds checked photos of the work, before or after it; only while it is under way, at most MAX_WORK_PHOTOS. */
export async function addWorkPhotos(
  client: DbClient,
  storage: Storage,
  worker: Worker,
  jobId: string,
  kind: WorkPhotoKind,
  images: readonly CheckedImage[],
): Promise<WorkPhotoResult> {
  const visit = await lockAssigned(client, worker, jobId);
  if (!visit) return { ok: false, error: "not_found" };
  if (visit.status !== "in_progress") return { ok: false, error: "refused" };
  const { rows } = await client.query<{ n: number }>(
    "select count(*)::int as n from kk.job_photo where job_id = $1 and kind in ('before', 'after')",
    [jobId],
  );
  if ((rows[0]?.n ?? 0) + images.length > MAX_WORK_PHOTOS)
    return { ok: false, error: "too_many_photos" };
  for (const image of images) {
    const object = await storage.putImage(client, image, null);
    await client.query(
      `insert into kk.job_photo (business_id, job_id, object_id, kind)
       values (nullif(current_setting('app.business_id', true), '')::uuid, $1, $2, $3)`,
      [jobId, object.id, kind],
    );
  }
  return { ok: true };
}

/**
 * Marks the work done: the job goes `in_progress → completed`, the visit closes with the technician's note, the
 * appointment is `done` and the approved work items `done`. The checklist need not be fully ticked: an item may
 * not apply to this job.
 */
export async function completeWork(
  client: DbClient,
  audit: Audit,
  worker: Worker,
  jobId: string,
  rawNote: string,
): Promise<WorkResult> {
  const visit = await lockAssigned(client, worker, jobId);
  if (!visit) return { ok: false, error: "not_found" };
  const note = rawNote.trim().slice(0, MAX_NOTE);
  const moved = await transitionJob(client, audit, jobId, {
    event: "complete",
    actor: worker,
    data: { appointmentId: visit.appointmentId },
  });
  if (!moved.ok) return moved;
  await client.query(
    "update kk.job_visit set completed_at = now(), note = nullif($2, '') where job_id = $1",
    [jobId, note],
  );
  await client.query("update kk.appointment set status = 'done' where id = $1", [
    visit.appointmentId,
  ]);
  await client.query(
    "update kk.job_task set status = 'done' where job_id = $1 and status = 'approved'",
    [jobId],
  );
  return { ok: true };
}

export interface MyWorkRow {
  readonly jobId: string;
  readonly number: number;
  readonly status: JobStatus;
  readonly contactName: string;
  readonly address: string | null;
  readonly startsAt: Date;
}

/** The work given to this member that is still to do or under way, soonest first. */
export async function myWork(client: DbClient, memberId: string): Promise<MyWorkRow[]> {
  const { rows } = await client.query<{
    job_id: string;
    number: number;
    status: JobStatus;
    contact_name: string;
    address: string | null;
    starts_at: Date;
  }>(
    `select j.id as job_id, j.number, j.status, j.contact_name, j.address, a.starts_at
     from kk.appointment a
     join kk.job j on j.business_id = a.business_id and j.id = a.job_id
     where a.technician_member_id = $1 and a.kind = 'work' and a.status = 'planned'
       and j.status in ('scheduled', 'in_progress')
     order by a.starts_at, a.id`,
    [memberId],
  );
  return rows.map((r) => ({
    jobId: r.job_id,
    number: r.number,
    status: r.status,
    contactName: r.contact_name,
    address: r.address,
    startsAt: r.starts_at,
  }));
}
