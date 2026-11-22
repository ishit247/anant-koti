"use client";
import { useActionState, useEffect, useRef, useState } from "react";
import { PER } from "../../price.ts";
import { UNITS } from "../../trade-template.ts";
import { Icon } from "../icons.tsx";
import { type CatalogueState, saveCatalogueAction } from "./actions.ts";

export interface FormRow {
  readonly id: string;
  readonly name: string;
  readonly unit: string;
  readonly price: string;
  readonly tax: string;
  readonly active: string;
}

interface Row extends FormRow {
  /** Stable while editing; a saved row's id is not known for a new one. */
  readonly key: number;
}

const BLANK: FormRow = { id: "", name: "", unit: "job", price: "", tax: "18", active: "yes" };

const withKeys = (rows: readonly FormRow[]): Row[] => rows.map((row, key) => ({ ...row, key }));

// Every row's fields stay in the form while its sheet is hidden, so one post carries the whole list.
export function CatalogueForm({ rows }: { rows: readonly FormRow[] }) {
  const [state, action, pending] = useActionState<CatalogueState, FormData>(
    saveCatalogueAction,
    {},
  );
  // A rejected save returns what was typed, so the form is keyed by it and starts again from there.
  const typed = state.rows as FormRow[] | undefined;
  return (
    <Rows key={typed ? "typed" : "saved"} start={typed ?? rows} {...{ state, action, pending }} />
  );
}

function Rows({
  start,
  state,
  action,
  pending,
}: {
  start: readonly FormRow[];
  state: CatalogueState;
  action: (form: FormData) => void;
  pending: boolean;
}) {
  const [list, setList] = useState(() => withKeys(start));
  const [editing, setEditing] = useState<number | null>(null);
  const nextKey = useRef(start.length);
  /** The row as it was when its sheet opened, so Back can undo; null for a new row. */
  const before = useRef<Row | null>(null);
  const names = useRef(new Map<number, HTMLInputElement>());

  // Each screen starts at its top; a new row's sheet puts the cursor in the name.
  useEffect(() => {
    window.scrollTo({ top: 0 });
    if (editing !== null && !before.current) names.current.get(editing)?.focus();
  }, [editing]);

  const change = (key: number, update: Partial<FormRow>) =>
    setList((rows) => rows.map((row) => (row.key === key ? { ...row, ...update } : row)));
  const add = () => {
    const key = nextKey.current++;
    setList((rows) => [...rows, { ...BLANK, key }]);
    before.current = null;
    setEditing(key);
  };
  const open = (row: Row) => {
    before.current = row;
    setEditing(row.key);
  };
  const discard = () => {
    const undo = before.current;
    setList((rows) =>
      undo
        ? rows.map((row) => (row.key === undo.key ? undo : row))
        : rows.filter((row) => row.key !== editing),
    );
    setEditing(null);
  };

  return (
    <form action={action}>
      <div className="stack" hidden={editing !== null}>
        <section className="panel" aria-labelledby="prices-title">
          <h2 id="prices-title">
            Items you offer
            {list.length > 0 ? <span className="count">{list.length}</span> : null}
          </h2>
          {list.length === 0 ? (
            <p className="empty">Add the work you do, with a price for each.</p>
          ) : null}
          {list.map((row) => (
            <button key={row.key} type="button" className="tile wrap" onClick={() => open(row)}>
              <span className="thumb">
                <Icon name="wrench" />
              </span>
              <span className="text">
                <strong>{row.name.trim() || "New item"}</strong>
                <span className="meta">
                  <span className="price">
                    {row.price ? `₹${row.price} ${PER[row.unit] ?? ""}` : "No price"}
                  </span>
                  {row.active === "no" ? <span className="chip wait">Hidden</span> : null}
                </span>
              </span>
              <Icon name="chevron" size={18} />
            </button>
          ))}
          <button type="button" className="add" onClick={add}>
            <Icon name="plus" size={18} />
            Add item
          </button>
        </section>
        {state.error ? (
          <p className="error" role="alert">
            {state.error}
          </p>
        ) : null}
        {state.saved ? <p role="status">Saved.</p> : null}
        <div className="dock stacked">
          <button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save prices"}
          </button>
        </div>
      </div>

      {list.map((row) => (
        <fieldset key={row.key} className="sheet" hidden={editing !== row.key}>
          <legend className="visually-hidden">Price list item</legend>
          <input type="hidden" name="id" value={row.id} />
          <div className="sheet-head">
            <button type="button" className="icon" aria-label="Back" onClick={discard}>
              <Icon name="back" size={22} />
            </button>
            <h2>{row.id ? "Edit item" : "Add item"}</h2>
          </div>
          <div className="panel">
            <label>
              Name
              <input
                ref={(el) => {
                  if (el) names.current.set(row.key, el);
                  else names.current.delete(row.key);
                }}
                name="name"
                value={row.name}
                maxLength={120}
                onChange={(e) => change(row.key, { name: e.target.value })}
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
              Price (₹)
              <input
                name="price"
                value={row.price}
                inputMode="decimal"
                onChange={(e) => change(row.key, { price: e.target.value })}
              />
            </label>
            <label>
              Tax (%)
              <input
                name="tax"
                value={row.tax}
                inputMode="decimal"
                onChange={(e) => change(row.key, { tax: e.target.value })}
              />
            </label>
            <label>
              Status
              <select
                name="active"
                value={row.active}
                onChange={(e) => change(row.key, { active: e.target.value })}
              >
                <option value="yes">Offered</option>
                <option value="no">Hidden</option>
              </select>
            </label>
          </div>
          <div className="dock stacked row">
            {row.id ? null : (
              <button type="button" className="danger" onClick={discard}>
                Remove
              </button>
            )}
            <button type="button" onClick={() => setEditing(null)}>
              Done
            </button>
          </div>
        </fieldset>
      ))}
    </form>
  );
}
