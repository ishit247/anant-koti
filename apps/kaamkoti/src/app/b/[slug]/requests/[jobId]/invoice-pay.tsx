import { formatMoney } from "@bodhchakra/money";
import type { Invoice } from "../../../../../invoice.ts";
import { formatDay } from "../../../../../job-labels.ts";
import { QuoteSummary } from "../../../../quote-summary.tsx";

const SAID: Record<string, (business: string) => string> = {
  back: () =>
    "If you have just paid, it shows here once Razorpay confirms it, usually within a minute. Refresh to check.",
  closed: () => "There is no bill to pay on this request now.",
  nothing_due: () => "Nothing is due: the bill is paid.",
  offline: (business) => `${business} does not take online payments. Please pay them directly.`,
  small: (business) => `What is left is less than ₹1. Please settle it with ${business} directly.`,
};

/**
 * The bill for the completed work (4.4): its lines, what was paid (the deposit included) and a Pay button for
 * the rest (a plain form posting to `action`, which sends the customer to the business's Razorpay page).
 * `said` is what ./bill sent back.
 */
export function InvoicePay({
  invoice,
  businessName,
  action,
  said,
}: {
  invoice: Invoice;
  businessName: string;
  action: string;
  said: string | undefined;
}) {
  const paid = invoice.due.minor === 0;
  const message = said ? SAID[said] : undefined;
  return (
    <section className="panel" aria-labelledby="bill-title">
      <h2 id="bill-title">Your bill</h2>
      <div className="row">
        <strong>Bill {invoice.number}</strong>
        {paid ? <span className="chip go">Paid</span> : <span className="chip wait">To pay</span>}
      </div>
      {message && !(said === "back" && paid) ? (
        <p role="status" className="notice">
          {message(businessName)}
        </p>
      ) : null}
      <p className="muted small">
        {invoice.paidAt
          ? `Paid on ${formatDay(invoice.paidAt)}`
          : `Sent on ${formatDay(invoice.issuedAt)}`}
      </p>
      <QuoteSummary quote={invoice} />
      {invoice.paid.minor > 0 && !paid ? (
        <div className="row">
          <span>Paid so far</span>
          <span className="amount">{formatMoney(invoice.paid)}</span>
        </div>
      ) : null}
      {!paid ? (
        <div className="row total">
          <span>To pay</span>
          <span className="amount">{formatMoney(invoice.due)}</span>
        </div>
      ) : null}
      {!paid && invoice.online ? (
        <form method="post" action={action}>
          <button type="submit">Pay {formatMoney(invoice.due)}</button>
        </form>
      ) : !paid ? (
        <p className="muted small">Pay {businessName} directly.</p>
      ) : null}
    </section>
  );
}
