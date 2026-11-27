// Cancelling a job (docs/architecture.md 6, the `cancel` row): the job moves to `cancelled`, its visits are
// cancelled, and so is every payment link still open on it, at Razorpay first, so nobody can pay for work that
// will not happen. Money already received stays recorded; returning it is the business's own matter.
import type { Audit } from "@bodhchakra/audit";
import type { DbClient } from "@bodhchakra/db";
import type { Payments } from "@bodhchakra/payments";
import { type JobActor, type JobTransitionResult, transitionJob } from "./job.ts";

/**
 * Inside `withTenant` of `businessId`. The caller has found the job in its scope. If Razorpay refuses to cancel a
 * link, this throws and the whole cancellation rolls back, so the job is never cancelled with a link left open.
 */
export async function cancelJob(
  client: DbClient,
  audit: Audit,
  payments: Payments,
  businessId: string,
  jobId: string,
  actor: JobActor,
): Promise<JobTransitionResult> {
  const moved = await transitionJob(client, audit, jobId, { event: "cancel", actor });
  if (!moved.ok) return moved;
  await client.query(
    "update kk.appointment set status = 'cancelled' where job_id = $1 and status in ('proposed', 'planned')",
    [jobId],
  );
  for (const link of await payments.linksFor(client, jobId)) {
    if (link.status === "created" || link.status === "partially_paid")
      await payments.cancelLink(client, { businessId, linkId: link.id });
  }
  return moved;
}
