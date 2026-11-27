import { formatMoney } from "@bodhchakra/money";
import type { AgreedWork, ChangeOrder } from "../../../../../change-order.ts";
import { MAX_ITEM_DETAILS, MAX_ITEM_TITLE } from "../../../../../intake.ts";
import { ChangeOrders } from "../../../../change-orders.tsx";

/** What ./change and ./more report back, by `?change=` and `?more=`; success is a status, the rest an alert. */
const DONE: Record<string, (business: string) => string> = {
  approve: (b) => `Approved. ${b} will add this work to your bill.`,
  reject: (b) => `You turned this down. ${b} will not charge for it.`,
  added: (b) => `Added. ${b} will price it and ask for your approval before charging for it.`,
};
const REFUSED: Record<string, (business: string) => string> = {
  answered: () => "Your answer to this extra work is already in.",
  closed: () => "This request no longer takes changes.",
  items: () => "This request has as many work items as it can take.",
  form: () => "Please give the work a title.",
};
const TRY_AGAIN = () => "That did not work. Please try again.";

/**
 * Extra work on the customer's accepted request (4.3): the change orders the business sent, with Approve and
 * Turn down on the one waiting, the total agreed, and while the work is still to finish a form to ask for more.
 * Plain forms posting to `changeAction` and `moreAction`, so they need no JavaScript.
 */
export function ChangeAnswer({
  orders,
  agreed,
  answerable,
  askable,
  businessName,
  changeAction,
  moreAction,
  said,
}: {
  orders: readonly ChangeOrder[];
  agreed: AgreedWork | null;
  /** The job takes answers to change orders (from acceptance to completion). */
  answerable: boolean;
  /** The job takes new work items (until it is marked complete). */
  askable: boolean;
  businessName: string;
  changeAction: string;
  moreAction: string;
  said: string | undefined;
}) {
  return (
    <section className="panel" aria-labelledby="extra-title">
      <h2 id="extra-title">Extra work</h2>
      {said && DONE[said] ? (
        <p role="status" className="notice">
          {DONE[said](businessName)}
        </p>
      ) : said ? (
        <p role="alert" className="error">
          {(REFUSED[said] ?? TRY_AGAIN)(businessName)}
        </p>
      ) : null}
      {orders.length === 0 ? (
        <p className="muted small">
          Anything more you want done is priced by {businessName} and added to your bill only if you
          approve it.
        </p>
      ) : null}
      <ChangeOrders
        orders={orders}
        agreed={agreed}
        answer={(order) =>
          answerable ? (
            <>
              <form method="post" action={changeAction}>
                <input type="hidden" name="changeOrder" value={order.id} />
                <button type="submit" name="answer" value="approve">
                  Approve · {formatMoney(order.total)}
                </button>
              </form>
              <details className="card">
                <summary>Turn this down</summary>
                <form method="post" action={changeAction}>
                  <input type="hidden" name="changeOrder" value={order.id} />
                  <button type="submit" name="answer" value="reject" className="quiet">
                    Yes, turn it down
                  </button>
                </form>
              </details>
            </>
          ) : null
        }
      />
      {askable ? (
        <details className="card">
          <summary>Ask for more work</summary>
          <form method="post" action={moreAction}>
            <label>
              What needs doing
              <input name="title" required maxLength={MAX_ITEM_TITLE} autoComplete="off" />
            </label>
            <label>
              Details (optional)
              <textarea name="details" maxLength={MAX_ITEM_DETAILS} rows={3} />
            </label>
            <button type="submit">Send to {businessName}</button>
          </form>
        </details>
      ) : null}
    </section>
  );
}
