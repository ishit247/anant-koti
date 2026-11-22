import { defineRoute } from "@bodhchakra/tenancy";
import { redirect } from "next/navigation";
import { businessProfile } from "../../business-profile.ts";
import { requireMember } from "../../guard.ts";
import { listInbox } from "../../inbox.ts";
import { formatWhen, SOURCE_LABEL, STATUS_LABEL, statusTone } from "../../job-labels.ts";
import { server } from "../../server.ts";
import { OwnerNav } from "../owner-nav.tsx";

// The owner's own business only: the list is read inside withTenant of the signed-in member's business.
const route = defineRoute({ scope: "member", roles: ["owner"] });

export default async function InboxPage() {
  const owner = await requireMember(route, "/jobs");
  const { profile, jobs } = await server().db.withTenant(owner.businessId, async (client) => ({
    profile: await businessProfile(client),
    jobs: await listInbox(client),
  }));
  if (!profile) redirect("/onboarding");
  return (
    <>
      <header className="bar">
        <h1>Requests</h1>
        <a className="button" href="/jobs/new">
          + Phone enquiry
        </a>
      </header>
      {jobs.length === 0 ? (
        <p className="empty">
          No requests yet. Share your page, or log a call with “Phone enquiry”.
        </p>
      ) : (
        <ul className="cards">
          {jobs.map((job) => (
            <li key={job.id}>
              <a className="card" href={`/jobs/${job.id}`}>
                <span className="row">
                  <strong>{job.customerName}</strong>
                  <span className={`chip ${statusTone(job.status)}`}>
                    {STATUS_LABEL[job.status]}
                  </span>
                </span>
                <span>{job.tasks.join(", ") || "No tasks listed"}</span>
                <span className="muted small">
                  #{job.number} · {SOURCE_LABEL[job.source]} · {formatWhen(job.createdAt)}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
      <OwnerNav current="/jobs" />
    </>
  );
}
