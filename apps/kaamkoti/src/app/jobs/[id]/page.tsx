import { formatMoney } from "@bodhchakra/money";
import { currentBusiness, defineRoute } from "@bodhchakra/tenancy";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireMember } from "../../../guard.ts";
import { ownerJob } from "../../../inbox.ts";
import {
  formatDay,
  formatWhen,
  quoteLabel,
  SOURCE_LABEL,
  STATUS_LABEL,
  statusTone,
} from "../../../job-labels.ts";
import { ownerQuotes } from "../../../quote.ts";
import { server } from "../../../server.ts";
import { OwnerNav } from "../../owner-nav.tsx";
import { QuoteSummary } from "../../quote-summary.tsx";
import { ResendLink } from "./resend-link.tsx";
import { StartQuote } from "./start-quote.tsx";

// The id in the path is only a lookup key: the job is read inside withTenant of the signed-in owner's
// business, so another business's id is a 404 like an unknown one.
const route = defineRoute({ scope: "member", roles: ["owner"] });

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) notFound();
  const owner = await requireMember(route, `/jobs/${id.data}`);
  const { db, storage } = server();
  const { job, business, quotes } = await db.withTenant(owner.businessId, async (client) => ({
    job: await ownerJob(client, id.data),
    business: await currentBusiness(client),
    quotes: await ownerQuotes(client, id.data),
  }));
  if (!job) notFound();
  const draft = quotes.find((q) => q.status === "draft");
  const [current, ...earlier] = quotes.filter((q) => q.status !== "draft");
  const quotable = job.status === "requested" || job.status === "quoted";
  const digits = job.customerPhone.replace(/\D/g, "");
  return (
    <>
      <p>
        <a href="/jobs">← Requests</a>
      </p>
      <header className="bar">
        <h1>Request #{job.number}</h1>
        <span className={`chip ${statusTone(job.status)}`}>{STATUS_LABEL[job.status]}</span>
      </header>
      <p className="muted small">
        {SOURCE_LABEL[job.source]} · {formatWhen(job.createdAt)}
      </p>

      <div className="card">
        <strong>{job.customerName}</strong>
        <span className="muted">{job.customerPhone}</span>
        <div className="actions">
          <a className="button" href={`tel:${job.customerPhone}`}>
            Call
          </a>
          <a className="button quiet" href={`https://wa.me/${digits}`}>
            WhatsApp
          </a>
        </div>
      </div>

      <h2>Work asked for</h2>
      <ul className="cards">
        {job.tasks.map((task, i) => (
          // Titles may repeat (two custom tasks of one name); their order is fixed.
          // biome-ignore lint/suspicious/noArrayIndexKey: the list is static for this render
          <li key={i} className="card">
            {task}
          </li>
        ))}
      </ul>

      <h2>Quote</h2>
      {current ? (
        <>
          <div className="row">
            <strong>Version {current.version}</strong>
            <span className={`chip ${current.expired ? "" : "wait"}`}>{quoteLabel(current)}</span>
          </div>
          {current.sentAt && current.validUntil ? (
            <p className="muted small">
              Sent {formatWhen(current.sentAt)} · valid until {formatDay(current.validUntil)}
            </p>
          ) : null}
          <QuoteSummary quote={current} />
        </>
      ) : draft ? null : (
        <p className="empty">No quote yet. Price the work asked for and send it to the customer.</p>
      )}
      {draft ? (
        <p>
          <a className="button" href={`/jobs/${job.id}/quote`}>
            Continue the draft (version {draft.version})
          </a>
        </p>
      ) : quotable ? (
        <StartQuote jobId={job.id} label={current ? "Revise the quote" : "Write a quote"} />
      ) : null}
      {earlier.length > 0 ? (
        <p className="muted small">
          Earlier:{" "}
          {earlier
            .map((q) => `version ${q.version}, ${formatMoney(q.total)} (${quoteLabel(q)})`)
            .join("; ")}
        </p>
      ) : null}

      <h2>Where and when</h2>
      <dl className="facts card">
        <div>
          <dt>Address</dt>
          <dd>{job.address ?? "Not given"}</dd>
        </div>
        {job.preferredWindow ? (
          <div>
            <dt>Preferred time</dt>
            <dd>{job.preferredWindow}</dd>
          </div>
        ) : null}
      </dl>

      {job.answers.length > 0 ? (
        <>
          <h2>Details</h2>
          <dl className="facts card">
            {job.answers.map((a) => (
              <div key={a.question}>
                <dt>{a.question}</dt>
                <dd>{a.answer}</dd>
              </div>
            ))}
          </dl>
        </>
      ) : null}

      {job.photos.length > 0 ? (
        <>
          <h2>Photos</h2>
          <div className="photos">
            {job.photos.map((photo) => (
              // Signed after the job was found in this business: each URL opens one object for five minutes.
              // biome-ignore lint/performance/noImgElement: a presigned URL, not an asset Next can optimise
              <img
                key={photo.key}
                src={storage.signedUrl(photo)}
                alt="Sent with the request"
                loading="lazy"
              />
            ))}
          </div>
        </>
      ) : null}

      <h2>Customer link</h2>
      <p className="muted small">
        The customer follows this request through a private link. If it went to the wrong number or
        was lost, end the old links and send a new one.
      </p>
      <ResendLink jobId={job.id} businessName={business.name} />
      <OwnerNav current="/jobs" />
    </>
  );
}
