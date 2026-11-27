"use client";
import { useActionState, useRef, useState } from "react";
import { UNITS } from "../../../../trade-template.ts";
import { Icon } from "../../../icons.tsx";
import { ShareLink } from "../../../share-link.tsx";
import type { QuoteEditorState } from "./actions.ts";

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

// Every line's fields stay in the form while its sheet is hidden, so one post carries the whole quote; each
// row has a key of its own so a removed line takes its inputs with it.
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

/**
 * The lines editor of a quote draft, or of a change order's (4.3), which has only lines: no deposit and no
 * validity. `save` is the server action that saves, and sends if asked.
 */
export function QuoteEditor({
  kind,
  save,
  jobId,
  jobNumber,
  businessName,
  draft,
  tasks,
  items,
  validDays,
}: {
  kind: "quote" | "change";
  save: (previous: QuoteEditorState, form: FormData) => Promise<QuoteEditorState>;
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
  const [state, action, pending] = useActionState<QuoteEditorState, FormData>(save, {});
  const quote = kind === "quote";
  const [rows, setRows] = useState(() => keyed(draft?.rows ?? []));
  const [pick, setPick] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  /** Opens a line's sheet, or goes back to the list; each screen starts at its top. */
  const show = (key: string | null) => {
    setEditing(key);
    window.scrollTo({ top: 0 });
  };
  /** The line as it was when its sheet opened, so Back can undo; null for a new line. */
  const before = useRef<Keyed | null>(null);
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
          {quote ? `Version ${state.sent.version}` : `Extra work ${state.sent.version}`} is sent.
          The customer sees it on their request page:
        </p>
        <ShareLink
          link={state.sent.link}
          label="Customer link"
          message={
            quote
              ? `${businessName}: your quote for request #${jobNumber}:`
              : `${businessName}: extra work on request #${jobNumber}, for your approval:`
          }
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
        No draft is open. <a href={`/jobs/${jobId}`}>Go back to the request</a> to{" "}
        {quote ? "write or revise the quote" : "price extra work"}.
      </p>
    );
  }

  const change = (key: string, update: Partial<LineRow>) =>
    setRows((list) => list.map((row) => (row.key === key ? { ...row, ...update } : row)));
  const addFromPriceList = (id: string) => {
    const item = items.find((i) => i.id === id);
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
  const addCustom = () => {
    const [line] = keyed([custom(rows)]);
    if (!line) return;
    setRows([...rows, line]);
    before.current = null;
    show(line.key);
  };
  const open = (row: Keyed) => {
    before.current = row;
    show(row.key);
  };
  const discard = () => {
    const undo = before.current;
    setRows((list) =>
      undo
        ? list.map((row) => (row.key === undo.key ? undo : row))
        : list.filter((row) => row.key !== editing),
    );
    show(null);
  };
  const totals = state.totals ?? draft.totals;
  const typed = state.typed;
  const taskTitle = (id: string) => tasks.find((t) => t.id === id)?.title ?? "The whole request";

  return (
    <form action={action} key={round}>
      <input type="hidden" name="jobId" value={jobId} />
      <input type="hidden" name={quote ? "quoteId" : "changeOrderId"} value={draft.id} />
      <div className="stack" hidden={editing !== null}>
        <section className="panel" aria-labelledby="lines-title">
          <h2 id="lines-title">
            Lines
            {rows.length > 0 ? <span className="count">{rows.length}</span> : null}
          </h2>
          {rows.length === 0 ? (
            <p className="empty">No lines yet. Add one from your prices or a custom line.</p>
          ) : null}
          {rows.map((row) => (
            <button key={row.key} type="button" className="tile wrap" onClick={() => open(row)}>
              <span className="thumb">
                <Icon name="wrench" />
              </span>
              <span className="text">
                <strong>{row.description || "New line"}</strong>
                <span className="meta">
                  <span className="price">
                    {row.quantity} × ₹{row.price || "0"}
                  </span>
                  <span className="muted small">{taskTitle(row.task)}</span>
                </span>
              </span>
              <Icon name="chevron" size={18} />
            </button>
          ))}
          {items.length > 0 ? (
            <label>
              From your prices
              <select value={pick} onChange={(e) => addFromPriceList(e.target.value)}>
                <option value="">Pick a service…</option>
                {items.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <button type="button" className="add" onClick={addCustom}>
            <Icon name="plus" size={18} />
            Custom line
          </button>
        </section>

        <section className="panel" aria-labelledby="terms-title">
          <h2 id="terms-title">{quote ? "Terms" : "Total"}</h2>
          {quote ? (
            <>
              <label>
                Deposit to book (₹), optional
                <input
                  name="deposit"
                  defaultValue={typed?.deposit ?? draft.deposit}
                  inputMode="decimal"
                />
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
            </>
          ) : null}
          <dl className="facts">
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
          <p className="hint">
            Save to update the total. The customer sees nothing until you send
            {quote ? "." : ", and pays for it only if they approve."}
          </p>
        </section>

        {state.error ? (
          <p className="error" role="alert">
            {state.error}
          </p>
        ) : null}
        {state.totals && !state.error ? <p role="status">Saved.</p> : null}
        <div className="dock row">
          <button type="submit" name="intent" value="save" className="quiet" disabled={pending}>
            {pending ? "Saving…" : "Save draft"}
          </button>
          <button type="submit" name="intent" value="send" disabled={pending}>
            {pending ? "Sending…" : quote ? "Send quote" : "Send for approval"}
          </button>
        </div>
      </div>

      {rows.map((row) => (
        <fieldset key={row.key} className="sheet" hidden={editing !== row.key}>
          <legend className="visually-hidden">Quote line</legend>
          <input type="hidden" name="item" value={row.item} />
          <div className="sheet-head">
            <button type="button" className="icon" aria-label="Back" onClick={discard}>
              <Icon name="back" size={22} />
            </button>
            <h2>{row.description || "New line"}</h2>
          </div>
          <div className="panel">
            <label>
              For
              <select
                name="task"
                value={row.task}
                onChange={(e) => change(row.key, { task: e.target.value })}
              >
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
              <input
                name="description"
                value={row.description}
                maxLength={120}
                required
                onChange={(e) => change(row.key, { description: e.target.value })}
              />
            </label>
            <label>
              Quantity
              <input
                name="quantity"
                value={row.quantity}
                inputMode="decimal"
                required
                onChange={(e) => change(row.key, { quantity: e.target.value })}
              />
            </label>
            <label>
              Per
              <select
                name="unit"
                value={row.unit}
                onChange={(e) => change(row.key, { unit: e.target.value })}
              >
                {UNITS.map((u) => (
                  <option key={u} value={u}>
                    {u.replace("_", " ")}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Price (₹), minus for a discount
              <input
                name="price"
                value={row.price}
                required
                onChange={(e) => change(row.key, { price: e.target.value })}
              />
            </label>
            <label>
              Tax (%)
              <input
                name="tax"
                value={row.tax}
                inputMode="decimal"
                required
                onChange={(e) => change(row.key, { tax: e.target.value })}
              />
            </label>
          </div>
          <div className="dock stacked row">
            <button
              type="button"
              className="danger"
              onClick={() => {
                before.current = null;
                setRows((list) => list.filter((r) => r.key !== row.key));
                show(null);
              }}
            >
              Remove
            </button>
            <button type="button" onClick={() => show(null)}>
              Done
            </button>
          </div>
        </fieldset>
      ))}
    </form>
  );
}
