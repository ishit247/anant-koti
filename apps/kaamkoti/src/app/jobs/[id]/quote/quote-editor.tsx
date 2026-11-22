"use client";
import { useActionState, useState } from "react";
import { UNITS } from "../../../../trade-template.ts";
import { ShareLink } from "../../../share-link.tsx";
import { type QuoteEditorState, saveQuoteAction } from "./actions.ts";

/** One line as form text: rupees and percent as the owner types them. */
export interface LineRow {
  readonly task: string;
  readonly item: string;
  readonly description: string;
  readonly unit: string;
  readonly quantity: string;
  readonly price: string;
  readonly tax: string;
}

export interface PriceListItem {
  readonly id: string;
  readonly name: string;
  readonly unit: string;
  readonly price: string;
  readonly tax: string;
}

export interface Draft {
  readonly id: string;
  readonly version: number;
  readonly rows: readonly LineRow[];
  readonly deposit: string;
  readonly totals: { readonly net: string; readonly tax: string; readonly total: string };
}

type Keyed = LineRow & { readonly key: string };

// Inputs are uncontrolled, so a removed line must take its own inputs with it: each row has a key of its own.
const keyed = (rows: readonly LineRow[]): Keyed[] =>
  rows.map((row) => ({ ...row, key: crypto.randomUUID() }));

/** A blank line. It takes the first line's tax rate, so a discount lowers the tax of what it discounts. */
const custom = (rows: readonly LineRow[]): LineRow => ({
  task: "",
  item: "",
  description: "",
  unit: "job",
  quantity: "1",
  price: "",
  tax: rows[0]?.tax ?? "0",
});

export function QuoteEditor({
  jobId,
  jobNumber,
  businessName,
  draft,
  tasks,
  items,
  validDays,
}: {
  /** The validity choices, in days (QUOTE_VALID_DAYS; passed in so this file imports no server module). */
  validDays: readonly number[];
  jobId: string;
  jobNumber: number;
  businessName: string;
  /** Null once sent: the editor stays mounted to show the link. */
  draft: Draft | null;
  tasks: readonly { readonly id: string; readonly title: string }[];
  items: readonly PriceListItem[];
}) {
  const [state, action, pending] = useActionState<QuoteEditorState, FormData>(saveQuoteAction, {});
  const [rows, setRows] = useState(() => keyed(draft?.rows ?? []));
  const [pick, setPick] = useState("");
  // React resets a form after its action; each answer brings back what was typed, under fresh keys.
  const [answered, setAnswered] = useState(state);
  const [round, setRound] = useState(0);
  if (state !== answered) {
    setAnswered(state);
    if (state.typed) setRows(keyed(state.typed.rows));
    setRound(round + 1);
  }

  if (state.sent) {
    return (
      <>
        <p role="status">
          Version {state.sent.version} is sent. The customer sees it on their request page:
        </p>
        <ShareLink
          link={state.sent.link}
          label="Customer link"
          message={`${businessName}: your quote for request #${jobNumber}:`}
        />
        <p>
          <a href={`/jobs/${jobId}`}>← Back to the request</a>
        </p>
      </>
    );
  }
  if (!draft) {
    return (
      <p className="empty">
        No draft is open. <a href={`/jobs/${jobId}`}>Go back to the request</a> to write or revise
        the quote.
      </p>
    );
  }

  const addFromPriceList = () => {
    const item = items.find((i) => i.id === pick);
    if (!item) return;
    setRows([
      ...rows,
      ...keyed([
        {
          task: "",
          item: item.id,
          description: item.name,
          unit: item.unit,
          quantity: "1",
          price: item.price,
          tax: item.tax,
        },
      ]),
    ]);
    setPick("");
  };
  const totals = state.totals ?? draft.totals;
  const typed = state.typed;

  return (
    <form action={action} key={round}>
      <input type="hidden" name="jobId" value={jobId} />
      <input type="hidden" name="quoteId" value={draft.id} />
      {rows.length === 0 ? (
        <p className="empty">No lines yet. Add one from your prices or a custom line below.</p>
      ) : null}
      {rows.map((row) => (
        <fieldset key={row.key} className="item">
          <legend>{row.description || "New line"}</legend>
          <input type="hidden" name="item" value={row.item} />
          <label>
            For
            <select name="task" defaultValue={row.task}>
              <option value="">The whole request</option>
              {tasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            Description
            <input name="description" defaultValue={row.description} maxLength={120} required />
          </label>
          <label>
            Quantity
            <input name="quantity" defaultValue={row.quantity} inputMode="decimal" required />
          </label>
          <label>
            Per
            <select name="unit" defaultValue={row.unit}>
              {UNITS.map((u) => (
                <option key={u} value={u}>
                  {u.replace("_", " ")}
                </option>
              ))}
            </select>
          </label>
          <label>
            Price (₹), minus for a discount
            <input name="price" defaultValue={row.price} required />
          </label>
          <label>
            Tax (%)
            <input name="tax" defaultValue={row.tax} inputMode="decimal" required />
          </label>
          <button
            type="button"
            className="quiet"
            onClick={() => setRows(rows.filter((r) => r.key !== row.key))}
          >
            Remove this line
          </button>
        </fieldset>
      ))}

      <fieldset className="item">
        <legend>Add a line</legend>
        <label>
          From your prices
          <select value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">Pick a service…</option>
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
        </label>
        <div className="actions">
          <button type="button" className="quiet" onClick={addFromPriceList} disabled={!pick}>
            Add it
          </button>
          <button
            type="button"
            className="quiet"
            onClick={() => setRows([...rows, ...keyed([custom(rows)])])}
          >
            Custom line
          </button>
        </div>
      </fieldset>

      <label>
        Deposit to book (₹), optional
        <input name="deposit" defaultValue={typed?.deposit ?? draft.deposit} inputMode="decimal" />
      </label>
      <label>
        Valid for
        <select name="valid" defaultValue={typed?.valid || "7"}>
          {validDays.map((days) => (
            <option key={days} value={days}>
              {days} days
            </option>
          ))}
        </select>
      </label>

      <dl className="facts card">
        <div>
          <dt>Saved total</dt>
          <dd>
            <strong>{totals.total}</strong>{" "}
            <span className="muted small">
              ({totals.net} + {totals.tax} tax)
            </span>
          </dd>
        </div>
      </dl>
      <p className="muted small">
        Save to update the total. The customer sees nothing until you send.
      </p>

      {state.error ? (
        <p className="error" role="alert">
          {state.error}
        </p>
      ) : null}
      {state.totals && !state.error ? <p role="status">Saved.</p> : null}
      <div className="actions">
        <button type="submit" name="intent" value="save" className="quiet" disabled={pending}>
          {pending ? "Saving…" : "Save draft"}
        </button>
        <button type="submit" name="intent" value="send" disabled={pending}>
          {pending ? "Sending…" : "Send quote"}
        </button>
      </div>
    </form>
  );
}
