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
