import { defineRoute } from "@bodhchakra/tenancy";
import type { JobStatus } from "../../../job.ts";
import { openJobLink } from "../../../job-link.ts";
import { server } from "../../../server.ts";

// The path secret is the credential: it resolves to one job, read inside withTenant of that job's business.
// No cookie is read or set; the app-wide Referrer-Policy keeps the secret out of Referer headers.
// biome-ignore lint/correctness/noUnusedVariables: read by scanRoutes, which scans the source text
const route = defineRoute({ scope: "customer-token" });

const STATUS: Record<JobStatus, string> = {
  requested: "Request received. The business will send you a quote.",
  quoted: "A quote is ready for you.",
  accepted: "Quote accepted. The business will schedule a visit.",
  scheduled: "A visit is scheduled.",
  in_progress: "Work is in progress.",
  completed: "Work is complete.",
  declined: "The business cannot take this job.",
  lost: "This request is closed.",
  cancelled: "This request was cancelled.",
};

export default async function JobPage({ params }: { params: Promise<{ secret: string }> }) {
  const { secret } = await params;
  const job = await openJobLink(server().db, secret);
  if (!job) {
    return (
      <>
        <h1>This link is no longer valid</h1>
        <p className="muted">It may have expired. Ask the business to send you a new link.</p>
      </>
    );
  }
  const digits = job.businessPhone.replace(/\D/g, "");
  return (
    <>
      <p className="muted">{job.businessName}</p>
      <h1>Request #{job.number}</h1>
      <p>Hello {job.customerName}.</p>
      <p role="status">{STATUS[job.status]}</p>
      <p>
        <a className="button" href={`tel:${job.businessPhone}`}>
          Call
        </a>{" "}
        <a className="button" href={`https://wa.me/${digits}`}>
          WhatsApp
        </a>
      </p>
    </>
  );
}
