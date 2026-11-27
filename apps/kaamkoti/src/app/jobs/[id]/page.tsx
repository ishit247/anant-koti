import { formatMoney } from "@bodhchakra/money";
import { defineRoute } from "@bodhchakra/tenancy";
import { notFound } from "next/navigation";
import { z } from "zod";
import { agreedWork, CHANGEABLE, changeOrders } from "../../../change-order.ts";
import { depositPayable, jobDeposit } from "../../../deposit.ts";
import { requireMember } from "../../../guard.ts";
import { ownerJob } from "../../../inbox.ts";
import {
  formatDay,
  formatTime,
  formatWhen,
  quoteLabel,
  quoteTone,
  SOURCE_LABEL,
  STATUS_LABEL,
  statusTone,
} from "../../../job-labels.ts";
import { ownerQuotes } from "../../../quote.ts";
import { assignableMembers, plannedVisits, workTime } from "../../../schedule.ts";
import { server } from "../../../server.ts";
import { ChangeOrders } from "../../change-orders.tsx";
import { OwnerNav } from "../../owner-nav.tsx";
import { QuoteSummary } from "../../quote-summary.tsx";
import { WorkItems } from "../../work-items.tsx";
import { startChange, startQuote } from "./actions.ts";
import { CancelJob } from "./cancel-job.tsx";
import { ConfirmForCustomer, OnTheWay, PlanVisit } from "./plan-visit.tsx";
import { StartQuote } from "./start-quote.tsx";

// "I'm on my way" is offered from half a day before the visit until it ends.
const ON_THE_WAY_WINDOW_MS = 12 * 60 * 60 * 1000;

// The id in the path is only a lookup key: the job is read inside withTenant of the signed-in owner's
// business, so another business's id is a 404 like an unknown one.
const route = defineRoute({ scope: "member", roles: ["owner"] });

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) notFound();
  const owner = await requireMember(route, `/jobs/${id.data}`);
  const { db, storage, payments } = server();
  const { job, quotes, orders, agreed, visits, work, team, deposit, linkOpen } =
    await db.withTenant(owner.businessId, async (client) => ({
      job: await ownerJob(client, id.data),
      quotes: await ownerQuotes(client, id.data),
      orders: await changeOrders(client, id.data, false),
      agreed: await agreedWork(client, id.data),
      visits: await plannedVisits(client, new Date(0), id.data),
      work: await workTime(client, id.data),
      team: await assignableMembers(client),
      deposit: await jobDeposit(client, payments, owner.businessId, id.data),
      linkOpen: (await payments.linksFor(client, id.data)).some(
        (link) => link.status === "created" || link.status === "partially_paid",
      ),
    }));
  if (!job) notFound();
  const cancellable = ["requested", "quoted", "accepted", "scheduled"].includes(job.status);
  // The same states the planner accepts: the work needs `accepted`, a site visit any open state.
  const visitable = ["requested", "quoted", "accepted", "scheduled"].includes(job.status);
  const now = Date.now();
  const draft = quotes.find((q) => q.status === "draft");
  const [current, ...earlier] = quotes.filter((q) => q.status !== "draft");
  const quotable = job.status === "requested" || job.status === "quoted";
  const changeable = CHANGEABLE.includes(job.status);
  const changeDraft = orders.find((o) => o.status === "draft");
  const unpriced = job.items.filter((item) => item.status === "requested").length;
  // Calls go to the person at the address, who may not be the customer who asked.
  const digits = job.contactPhone.replace(/\D/g, "");
  const forSomeoneElse = job.contactPhone !== job.customerPhone;
  return (
    <>
      <header className="bar">
        <h1>Request #{job.number}</h1>
        <a className="button quiet" href="/jobs">
          ← Requests
        </a>
      </header>
      <p className="muted small">
        <span className={`chip ${statusTone(job.status)}`}>{STATUS_LABEL[job.status]}</span>{" "}
        {SOURCE_LABEL[job.source]} · {formatWhen(job.createdAt)}
      </p>

      <div className="stack">
        <section className="panel" aria-label="Customer">
          <strong>{job.contactName}</strong>
          <span className="muted">{job.contactPhone}</span>
          {forSomeoneElse ? (
            <span className="muted small">
              Requested by {job.customerName} · {job.customerPhone}
            </span>
          ) : null}
          <div className="actions">
            <a className="button" href={`tel:${job.contactPhone}`}>
              Call
            </a>
            <a className="button quiet" href={`https://wa.me/${digits}`}>
              WhatsApp
            </a>
          </div>
        </section>

        <section className="panel" aria-labelledby="work-title">
          <h2 id="work-title">Work asked for</h2>
          {/* Signed after the job was found in this business: each URL opens one object for five minutes. */}
          <WorkItems
            items={job.items}
            sign={(photo) => storage.signedUrl(photo)}
            photoAlt="Sent with the request"
            accepted={agreed !== null}
          />
        </section>

        <section className="panel" aria-labelledby="quote-title">
          <h2 id="quote-title">Quote</h2>
          {current ? (
            <>
              <div className="row">
                <strong>Version {current.version}</strong>
                <span className={`chip ${quoteTone(current)}`}>{quoteLabel(current)}</span>
              </div>
              {current.sentAt && current.validUntil ? (
                <p className="muted small">
                  Sent {formatWhen(current.sentAt)} · valid until {formatDay(current.validUntil)}
                </p>
              ) : null}
              {current.decidedAt ? (
                <p role="status" className="card">
                  {current.status === "accepted"
                    ? `${job.customerName} accepted this quote`
                    : current.counter
                      ? `${job.customerName} offered ${formatMoney(current.counter.total)}`
                      : `${job.customerName} turned this quote down`}{" "}
                  on {formatWhen(current.decidedAt)}.
                  {current.counter?.note ? (
                    <span className="muted">"{current.counter.note}"</span>
                  ) : null}
                </p>
              ) : null}
              <QuoteSummary quote={current} />
              {deposit && (depositPayable(job.status) || deposit.paid.minor > 0) ? (
                <p className="row" role="status">
                  <span>
                    Deposit {formatMoney(deposit.amount)}
                    {deposit.due.minor > 0 && deposit.paid.minor > 0
                      ? ` · ${formatMoney(deposit.paid)} received`
                      : ""}
                  </span>
                  {deposit.due.minor === 0 ? (
                    <span className="chip go">Paid</span>
                  ) : (
                    <span className="chip wait">
                      {deposit.online ? "Not paid yet" : "Not paid · collect it yourself"}
                    </span>
                  )}
                </p>
              ) : null}
            </>
          ) : draft ? null : (
            <p className="empty">
              No quote yet. Price the work asked for and send it to the customer.
            </p>
          )}
          {draft && quotable ? (
            <p>
              <a className="button" href={`/jobs/${job.id}/quote`}>
                Continue the draft (version {draft.version})
              </a>
            </p>
          ) : quotable ? (
            <StartQuote
              jobId={job.id}
              label={current ? "Revise the quote" : "Write a quote"}
              start={startQuote}
            />
          ) : null}
          {earlier.length > 0 ? (
            <p className="muted small">
              Earlier:{" "}
              {earlier
                .map((q) => `version ${q.version}, ${formatMoney(q.total)} (${quoteLabel(q)})`)
                .join("; ")}
            </p>
          ) : null}
        </section>

        {changeable || orders.length > 0 ? (
          <section className="panel" aria-labelledby="extra-title">
            <h2 id="extra-title">Extra work</h2>
            {unpriced > 0 && changeable ? (
              <p className="notice" role="status">
                {unpriced === 1 ? "1 work item was" : `${unpriced} work items were`} added since the
                quote was accepted. Price {unpriced === 1 ? "it" : "them"} for the customer to
                approve.
              </p>
            ) : orders.length === 0 ? (
              <p className="empty">
                Work found on site or asked for after acceptance is priced here, and added to the
                bill only once the customer approves.
              </p>
            ) : null}
            <ChangeOrders orders={orders.filter((o) => o.status !== "draft")} agreed={agreed} />
            {changeable && changeDraft ? (
              <a className="button" href={`/jobs/${job.id}/change`}>
                Continue extra work {changeDraft.number}
              </a>
            ) : changeable ? (
              <StartQuote
                jobId={job.id}
                label="Price extra work"
                start={startChange}
                quiet={unpriced === 0}
              />
            ) : null}
          </section>
        ) : null}

        <section className="panel" aria-labelledby="visits-title">
          <h2 id="visits-title">Visits</h2>
          {visits.length > 0 ? (
            <ul className="cards">
              {visits.map((visit) => (
                <li key={visit.id} className="card">
                  <div className="row">
                    <strong>{visit.kind === "work" ? "The work" : "Site visit"}</strong>
                    <span className="muted">{visit.technicianName}</span>
                  </div>
                  <span className="muted small">
                    {formatWhen(visit.startsAt)} to {formatTime(visit.endsAt)}
                  </span>
                  {visit.status === "proposed" ? (
                    <>
                      <span className="chip wait">Waiting for the customer to confirm</span>
                      <ConfirmForCustomer jobId={job.id} appointmentId={visit.id} />
                    </>
                  ) : null}
                  {visit.status === "planned" &&
                  visit.endsAt.getTime() > now &&
                  visit.startsAt.getTime() - now < ON_THE_WAY_WINDOW_MS ? (
                    <OnTheWay jobId={job.id} appointmentId={visit.id} />
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">Nothing planned yet.</p>
          )}
          {work?.status === "declined" && job.status === "accepted" ? (
            <p className="notice" role="status">
              {job.customerName} asked for another time than {formatWhen(work.startsAt)}
              {work.note ? `: "${work.note}"` : "."} Propose a new one below.
            </p>
          ) : null}
          {["scheduled", "in_progress", "completed"].includes(job.status) ? (
            <a className="button quiet" href={`/work/${job.id}`}>
              {job.status === "scheduled" ? "Open the job sheet" : "Checklist, photos and notes"}
            </a>
          ) : null}
          {visitable ? (
            <PlanVisit jobId={job.id} workable={job.status === "accepted"} team={team} />
          ) : null}
        </section>

        <section className="panel" aria-labelledby="where-title">
          <h2 id="where-title">Where</h2>
          <span>{job.address ?? "No address given"}</span>
          {job.location ? (
            // The owner's own map app opens it; nothing is sent anywhere until they tap.
            <a
              className="button quiet"
              href={`https://www.google.com/maps/search/?api=1&query=${job.location.latitude},${job.location.longitude}`}
              rel="noreferrer"
              target="_blank"
            >
              Open in Maps
            </a>
          ) : null}
        </section>
        {cancellable ? <CancelJob jobId={job.id} linkOpen={linkOpen} /> : null}
      </div>
      <OwnerNav current="/jobs" />
    </>
  );
}
