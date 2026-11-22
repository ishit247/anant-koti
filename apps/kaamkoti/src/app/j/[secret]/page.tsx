import { defineRoute } from "@bodhchakra/tenancy";
import type { JobStatus } from "../../../job.ts";
import { formatDay } from "../../../job-labels.ts";
import { openJobLink } from "../../../job-link.ts";
import { server } from "../../../server.ts";
import { QuoteSummary } from "../../quote-summary.tsx";

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
  const { db, storage } = server();
  const job = await openJobLink(db, secret);
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
      {job.tasks.length > 0 ? (
        <ul>
          {job.tasks.map((task, i) => (
            // Titles may repeat (two custom tasks of the same name); their order is fixed.
            // biome-ignore lint/suspicious/noArrayIndexKey: the list is static for this render
            <li key={i}>{task}</li>
          ))}
        </ul>
      ) : null}
      {job.quote ? (
        <>
          <h2>Your quote</h2>
          {job.quote.expired ? (
            <p role="alert">This quote has expired. Ask {job.businessName} for a new one.</p>
          ) : job.quote.validUntil ? (
            <p className="muted small">Valid until {formatDay(job.quote.validUntil)}.</p>
          ) : null}
          <QuoteSummary quote={job.quote} />
        </>
      ) : null}
      {job.photos.map((photo) => (
        // Signed after the link resolved to this job: each URL opens one object for five minutes.
        // biome-ignore lint/performance/noImgElement: a presigned URL, not an asset Next can optimise
        <img
          key={photo.key}
          src={storage.signedUrl(photo)}
          alt="Sent with your request"
          width={160}
        />
      ))}
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
