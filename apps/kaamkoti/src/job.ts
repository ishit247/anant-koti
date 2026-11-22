import type { DbClient } from "@bodhchakra/db";

// A job's states (docs/architecture.md 6); the CHECK on kk.job.status lists the same values.
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
