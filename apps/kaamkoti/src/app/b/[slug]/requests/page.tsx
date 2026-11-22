import { defineRoute } from "@bodhchakra/tenancy";
import { notFound } from "next/navigation";
import {
  type CustomerJobRow,
  customerJobs,
  type JobGroup,
  jobGroup,
} from "../../../../customer-space.ts";
import { withCustomer } from "../../../../guard.ts";
import { CUSTOMER_STATUS_LABEL, formatWhen, statusTone } from "../../../../job-labels.ts";
import { publicPage } from "../../../../public-page.ts";
import { server } from "../../../../server.ts";
import { BusinessHeader } from "../../../business-header.tsx";

// The customer's home in one business (D15, architecture 7): their own requests here, by state.
// biome-ignore lint/correctness/noUnusedVariables: read by scanRoutes, which scans the source text
const route = defineRoute({ scope: "customer" });

const GROUPS: readonly [JobGroup, string][] = [
  ["active", "Active"],
  ["completed", "Completed"],
  ["cancelled", "Cancelled"],
];

const EMPTY: Record<JobGroup, string> = {
  active: "Nothing open. Send a request and the quote will appear here.",
  completed: "No finished work yet.",
  cancelled: "Nothing cancelled.",
};

export default async function CustomerHome({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const { slug } = await params;
  const group = jobGroup((await searchParams).status);
  const space = `/b/${encodeURIComponent(slug)}`;
  const here = group === "active" ? `${space}/requests` : `${space}/requests?status=${group}`;
  const { jobs, email } = await withCustomer(slug, here, async (client, customer, session) => ({
    jobs: customer ? await customerJobs(client, customer, group) : [],
    email: session.email,
  }));
  const page = await publicPage(server().db, slug);
  if (!page) notFound();

  return (
    <>
      <BusinessHeader business={page} home={{ href: space }}>
        <h1>Your requests</h1>
        <form className="signed-in muted small" method="post" action={`${space}/signout`}>
          <span className="who-email">{email}</span>
          <button type="submit" className="link">
            Sign out
          </button>
        </form>
      </BusinessHeader>
      <nav className="seg" aria-label="Requests by state">
        {GROUPS.map(([key, label]) => (
          <a
            key={key}
            href={key === "active" ? `${space}/requests` : `${space}/requests?status=${key}`}
            aria-current={key === group ? "page" : undefined}
          >
            {label}
          </a>
        ))}
      </nav>
      {jobs.length === 0 ? (
        <p className="empty">{EMPTY[group]}</p>
      ) : (
        <ul className="cards">
          {jobs.map((job) => (
            <li key={job.id}>
              <JobCard job={job} />
            </li>
          ))}
        </ul>
      )}
      <div className="dock">
        <a className="button" href={`${space}/request`}>
          New request
        </a>
      </div>
    </>
  );
}

function JobCard({ job }: { job: CustomerJobRow }) {
  const [first, ...rest] = job.tasks;
  return (
    <div className="card">
      <div className="row">
        <strong>
          {first ?? `Request #${job.number}`}
          {rest.length > 0 ? <span className="muted"> +{rest.length}</span> : null}
        </strong>
        <span className={`chip ${statusTone(job.status)}`}>
          {CUSTOMER_STATUS_LABEL[job.status]}
        </span>
      </div>
      <p className="muted small">
        #{job.number} · {formatWhen(job.createdAt)}
      </p>
    </div>
  );
}
