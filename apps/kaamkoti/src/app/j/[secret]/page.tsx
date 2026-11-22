import { formatMoney } from "@bodhchakra/money";
import { defineRoute } from "@bodhchakra/tenancy";
import type { JobStatus } from "../../../job.ts";
import { formatDay } from "../../../job-labels.ts";
import { openJobLink } from "../../../job-link.ts";
import type { Quote } from "../../../quote.ts";
import { server } from "../../../server.ts";
import { QuoteSummary } from "../../quote-summary.tsx";

// The path secret is the credential: it resolves to one job, read inside withTenant of that job's business.
// No cookie is read or set; the app-wide Referrer-Policy keeps the secret out of Referer headers. The answer
// forms post to ./answer, which checks everything again: what this page offers is only a convenience.
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

/** What the answer handler reports back, by `?answer=`; success is a status, anything else an alert. */
const ANSWERED: Record<string, (business: string) => string> = {
  accept: (b) => `Thank you. ${b} has your acceptance and will be in touch to schedule the work.`,
  reject: (b) => `You turned down the quote. ${b} may send you a new one.`,
  counter: (b) => `Your price is sent. ${b} will reply with a new quote or a call.`,
};
const REFUSED: Record<string, (business: string) => string> = {
  counter: () => "Enter the total you would pay, like 2500. A note can be up to 500 characters.",
  replaced: (b) => `${b} has sent a newer quote. Please look at it below.`,
  answered: () => "Your answer to this quote is already in.",
  expired: (b) => `This quote has expired. Ask ${b} for a new one.`,
  closed: () => "This request no longer takes answers to its quote.",
};
const TRY_AGAIN = () => "That did not work. Please try again.";

export default async function JobPage({
  params,
  searchParams,
}: {
  params: Promise<{ secret: string }>;
  searchParams: Promise<{ answer?: string | string[] }>;
}) {
  const { secret } = await params;
  const { answer } = await searchParams;
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
  const quote = job.quote;
  const open = job.status === "quoted" && quote?.status === "sent" && !quote.expired;
  const waiting =
    job.status === "quoted" && (quote?.status === "rejected" || quote?.status === "countered");
  const said = typeof answer === "string" ? answer : undefined;
  return (
    <>
      <p className="muted">{job.businessName}</p>
      <h1>Request #{job.number}</h1>
      <p>Hello {job.customerName}.</p>
      {said && ANSWERED[said] ? (
        <p role="status" className="card">
          {ANSWERED[said](job.businessName)}
        </p>
      ) : said ? (
        <p role="alert" className="error">
          {(REFUSED[said] ?? TRY_AGAIN)(job.businessName)}
        </p>
      ) : null}
      <p role="status">
        {waiting ? `Waiting for ${job.businessName} to reply to your answer.` : STATUS[job.status]}
      </p>
      {job.tasks.length > 0 ? (
        <ul>
          {job.tasks.map((task, i) => (
            // Titles may repeat (two custom tasks of the same name); their order is fixed.
            // biome-ignore lint/suspicious/noArrayIndexKey: the list is static for this render
            <li key={i}>{task}</li>
          ))}
        </ul>
      ) : null}
      {quote ? (
        <>
          <h2>Your quote</h2>
          <QuoteState quote={quote} businessName={job.businessName} />
          <div className="cards">
            <QuoteSummary quote={quote} />
            {open ? <AnswerForms quote={quote} action={`/j/${secret}/answer`} /> : null}
          </div>
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

/** One line on where the quote stands: valid until, expired, or the customer's own answer. */
function QuoteState({ quote, businessName }: { quote: Quote; businessName: string }) {
  const on = quote.decidedAt ? ` on ${formatDay(quote.decidedAt)}` : "";
  if (quote.status === "accepted")
    return <p className="muted small">You accepted this quote{on}.</p>;
  if (quote.status === "rejected")
    return <p className="muted small">You turned down this quote{on}.</p>;
  if (quote.status === "countered" && quote.counter) {
    return (
      <p className="muted small">
        You offered {formatMoney(quote.counter.total)}
        {on}
        {quote.counter.note ? `: "${quote.counter.note}"` : "."}
      </p>
    );
  }
  if (quote.expired)
    return <p role="alert">This quote has expired. Ask {businessName} for a new one.</p>;
  return quote.validUntil ? (
    <p className="muted small">Valid until {formatDay(quote.validUntil)}.</p>
  ) : null;
}

/**
 * Accept is the main action. Offering a price and turning the quote down are behind a tap each, so neither
 * happens by accident; plain forms, so the page needs no JavaScript.
 */
function AnswerForms({ quote, action }: { quote: Quote; action: string }) {
  return (
    <>
      <form method="post" action={action}>
        <input type="hidden" name="quote" value={quote.id} />
        <button type="submit" name="answer" value="accept">
          Accept quote · {formatMoney(quote.total)}
        </button>
      </form>
      <details className="card">
        <summary>Offer a different price</summary>
        <form method="post" action={action}>
          <input type="hidden" name="quote" value={quote.id} />
          <input type="hidden" name="answer" value="counter" />
          <label>
            Total you would pay (₹)
            <input
              name="total"
              required
              inputMode="decimal"
              pattern="[0-9]+([.][0-9]{1,2})?"
              maxLength={14}
              autoComplete="off"
            />
          </label>
          <label>
            Note (optional)
            <textarea name="note" maxLength={500} rows={3} />
          </label>
          <button type="submit">Send my price</button>
        </form>
      </details>
      <details className="card">
        <summary>Turn down this quote</summary>
        <form method="post" action={action}>
          <input type="hidden" name="quote" value={quote.id} />
          <button type="submit" name="answer" value="reject" className="quiet">
            Yes, turn it down
          </button>
        </form>
      </details>
    </>
  );
}
