import { formatMoney } from "@bodhchakra/money";
import type { Deposit } from "../../../../../deposit.ts";

const SAID: Record<string, (business: string) => string> = {
  back: () =>
    "If you have just paid, it shows here once Razorpay confirms it, usually within a minute. Refresh to check.",
  closed: () => "This request can no longer take a deposit.",
  nothing_due: () => "Nothing is due: the deposit is already paid.",
  offline: (business) => `${business} does not take online payments. Please pay them directly.`,
};

/**
 * The deposit the accepted quote asks for: paid, or a Pay button (a plain form posting to `action`, which sends
 * the customer to the business's Razorpay page) while the work is ahead. `said` is what ./pay sent back.
 */
export function DepositPay({
  deposit,
  payable,
  businessName,
  action,
  said,
}: {
  deposit: Deposit;
  payable: boolean;
  businessName: string;
  action: string;
  said: string | undefined;
}) {
  const paid = deposit.due.minor === 0;
  const message = said ? SAID[said] : undefined;
  return (
    <section className="panel" aria-labelledby="deposit-title">
      <h2 id="deposit-title">Deposit</h2>
      {message && !(said === "back" && paid) ? (
        <p role="status" className="notice">
          {message(businessName)}
        </p>
      ) : null}
      <div className="row">
        <span>{formatMoney(deposit.amount)}</span>
        {paid ? <span className="chip go">Paid</span> : <span className="chip wait">To pay</span>}
      </div>
      {!paid && deposit.paid.minor > 0 ? (
        <p className="muted small">
          {formatMoney(deposit.paid)} received, {formatMoney(deposit.due)} to go.
        </p>
      ) : null}
      {!paid && payable && deposit.online ? (
        <form method="post" action={action}>
          <button type="submit">Pay {formatMoney(deposit.due)}</button>
        </form>
      ) : !paid && payable ? (
        <p className="muted small">Pay the deposit to {businessName} directly.</p>
      ) : null}
    </section>
  );
}
