import { formatMoney } from "@bodhchakra/money";
import type { JobStatus } from "../../../../../job.ts";
import { formatDay } from "../../../../../job-labels.ts";
import type { Quote } from "../../../../../quote.ts";
import { QuoteSummary } from "../../../../quote-summary.tsx";

/** What ./answer reports back, by `?answer=`; success is a status, anything else an alert. */
const ANSWERED: Record<string, (business: string) => string> = {
  accept: (b) => `Thank you. ${b} has your acceptance and will propose a time for the work here.`,
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

/**
 * The quote on the customer's request page: where it stands, its lines, and while it is open the answer
 * forms, which post to `action`. `said` is the outcome ./answer sent back.
 */
export function QuoteAnswer({
  quote,
  status,
  businessName,
  action,
  said,
}: {
  quote: Quote;
  status: JobStatus;
  businessName: string;
  action: string;
  said: string | undefined;
}) {
  const open = status === "quoted" && quote.status === "sent" && !quote.expired;
  return (
    <section className="panel">
      <h2>Your quote</h2>
      {said && ANSWERED[said] ? (
        <p role="status" className="notice">
          {ANSWERED[said](businessName)}
        </p>
      ) : said ? (
        <p role="alert" className="error">
          {(REFUSED[said] ?? TRY_AGAIN)(businessName)}
        </p>
      ) : null}
      <QuoteState quote={quote} businessName={businessName} />
      <QuoteSummary quote={quote} />
      {open ? <AnswerForms quote={quote} action={action} /> : null}
    </section>
  );
}

/** One line on where the quote stands: valid until, expired, or the customer's own answer. */
function QuoteState({ quote, businessName }: { quote: Quote; businessName: string }) {
  const on = quote.decidedAt ? ` on ${formatDay(quote.decidedAt)}` : "";
  if (quote.status === "accepted")
    return <p className="muted small">You accepted this quote{on}.</p>;
  if (quote.status === "rejected")
    return (
      <p className="muted small">
        You turned down this quote{on}. Waiting for {businessName} to reply.
      </p>
    );
  if (quote.status === "countered" && quote.counter) {
    return (
      <p className="muted small">
        You offered {formatMoney(quote.counter.total)}
        {on}
        {quote.counter.note ? `: "${quote.counter.note}"` : "."} Waiting for {businessName} to
        reply.
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
 * happens by accident; plain forms, so they need no JavaScript.
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
