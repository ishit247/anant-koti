"use client";
import { useActionState } from "react";
import { UNITS } from "../../trade-template.ts";
import { type CatalogueState, saveCatalogueAction } from "./actions.ts";

export interface FormRow {
  readonly id: string;
  readonly name: string;
  readonly unit: string;
  readonly price: string;
  readonly tax: string;
  readonly active: string;
}

const BLANK: FormRow = { id: "", name: "", unit: "job", price: "", tax: "18", active: "yes" };

export function CatalogueForm({ rows }: { rows: readonly FormRow[] }) {
  const [state, action, pending] = useActionState<CatalogueState, FormData>(
    saveCatalogueAction,
    {},
  );
  // A rejected save returns what was typed; otherwise show the saved list plus one blank row.
  const shown = (state.rows as FormRow[] | undefined) ?? [...rows, BLANK];
  return (
    <form action={action}>
      {shown.map((row, i) => (
        <fieldset key={row.id || `new-${i}`} className="item">
          <legend className={row.id ? undefined : "muted"}>
            {row.id ? row.name || "Item" : "Add an item"}
          </legend>
          <input type="hidden" name="id" value={row.id} />
          <label>
            Name
            <input name="name" defaultValue={row.name} maxLength={120} />
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
            Price (₹)
            <input name="price" defaultValue={row.price} inputMode="decimal" />
          </label>
          <label>
            Tax (%)
            <input name="tax" defaultValue={row.tax} inputMode="decimal" />
          </label>
          <label>
            Status
            <select name="active" defaultValue={row.active}>
              <option value="yes">Offered</option>
              <option value="no">Hidden</option>
            </select>
          </label>
        </fieldset>
      ))}
      {state.error ? (
        <p className="error" role="alert">
          {state.error}
        </p>
      ) : null}
      {state.saved ? <p role="status">Saved.</p> : null}
      <button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save prices"}
      </button>
    </form>
  );
}
