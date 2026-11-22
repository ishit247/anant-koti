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
import { CustomerNav } from "../../../customer-nav.tsx";

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
  const jobs = await withCustomer(slug, here, async (client, customer) =>
    customer ? customerJobs(client, customer, group) : [],
  );
  const page = await publicPage(server().db, slug);
  if (!page) notFound();

  return (
    <>
      <BusinessHeader business={page} home={{ href: space }}>
        <h1>Your requests</h1>
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
              <JobCard job={job} href={`${space}/requests/${job.id}`} />
            </li>
          ))}
        </ul>
      )}
      <div className="dock">
        <a className="button" href={`${space}/request`}>
          New request
        </a>
      </div>
      <CustomerNav space={space} current="requests" />
    </>
  );
}

function JobCard({ job, href }: { job: CustomerJobRow; href: string }) {
  const [first, ...rest] = job.tasks;
  return (
    <a className="card" href={href}>
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
    </a>
  );
}
