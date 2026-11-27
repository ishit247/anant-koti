// A job's change orders and what is agreed in all (4.3), the same for the owner and the customer; the answer
// forms are the customer page's. Server-rendered: no client JavaScript.
import { formatMoney } from "@bodhchakra/money";
import type { ReactNode } from "react";
import type { AgreedWork, ChangeOrder } from "../change-order.ts";
import { CHANGE_LABEL, formatWhen } from "../job-labels.ts";
import { QuoteSummary } from "./quote-summary.tsx";

export function ChangeOrders({
  orders,
  agreed,
  answer,
}: {
  orders: readonly ChangeOrder[];
  agreed: AgreedWork | null;
  /** Rendered under the change order waiting for an answer: the customer's Approve and Turn down. */
  answer?: (order: ChangeOrder) => ReactNode;
}) {
  return (
    <>
      {orders.length > 0 ? (
        <ul className="cards">
          {orders.map((order) => (
            <li key={order.id} className="card">
              <div className="row">
                <strong>Extra work {order.number}</strong>
                <span className={`chip ${CHANGE_LABEL[order.status].tone}`}>
                  {CHANGE_LABEL[order.status].label}
                </span>
              </div>
              {order.proposedAt ? (
                <span className="muted small">
                  Sent {formatWhen(order.proposedAt)}
                  {order.decidedAt ? ` · answered ${formatWhen(order.decidedAt)}` : ""}
                </span>
              ) : null}
              <QuoteSummary quote={order} />
              {order.status === "proposed" && answer ? answer(order) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {agreed && agreed.changeOrders.length > 0 ? (
        <p className="row total" role="status">
          <span>
            Agreed in all
            <span className="muted small">
              {" "}
              (quote and extra work {agreed.changeOrders.join(", ")})
            </span>
          </span>
          <span className="amount">{formatMoney(agreed.total)}</span>
        </p>
      ) : null}
    </>
  );
}
