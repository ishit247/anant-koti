// A quote's lines and totals, the same for the owner and the customer. Server-rendered: no client JavaScript.
import { formatDecimal, formatMoney, money } from "@bodhchakra/money";
import { formatPrice } from "../price.ts";
import type { Quote } from "../quote.ts";

export function QuoteSummary({ quote }: { quote: Quote }) {
  const { currency } = quote.total;
  return (
    <div className="card">
      <ul className="lines">
        {quote.lines.map((line, i) => (
          // Lines have no id of their own in the view; their order is fixed by position.
          // biome-ignore lint/suspicious/noArrayIndexKey: the list is static for this render
          <li key={i}>
            <div className="row">
              <strong>{line.description}</strong>
              <span className="amount">{formatMoney(line.net)}</span>
            </div>
            <span className="muted small">
              {formatDecimal(line.quantityMilli, 3)} ×{" "}
              {formatPrice(money(line.unitPriceMinor, currency), line.unit)}
              {line.taskTitle && line.taskTitle !== line.description
                ? ` · for ${line.taskTitle}`
                : ""}
            </span>
          </li>
        ))}
      </ul>
      {quote.tax.minor !== 0 ? (
        <>
          <div className="row total">
            <span>Before tax</span>
            <span className="amount">{formatMoney(quote.net)}</span>
          </div>
          <div className="row">
            <span>Tax (GST)</span>
            <span className="amount">{formatMoney(quote.tax)}</span>
          </div>
        </>
      ) : null}
      <div className="row total">
        <span>Total</span>
        <span className="amount">{formatMoney(quote.total)}</span>
      </div>
      {quote.deposit.minor > 0 ? (
        <div className="row">
          <span>Deposit to book</span>
          <span className="amount">{formatMoney(quote.deposit)}</span>
        </div>
      ) : null}
    </div>
  );
}
