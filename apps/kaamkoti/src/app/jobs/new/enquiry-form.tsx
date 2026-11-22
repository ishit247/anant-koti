"use client";
import { useActionState } from "react";
import { type EnquiryState, logEnquiryAction } from "./actions.ts";

export interface EnquiryItem {
  readonly id: string;
  readonly name: string;
}

export function EnquiryForm({ items }: { items: readonly EnquiryItem[] }) {
  const [state, action, pending] = useActionState<EnquiryState, FormData>(logEnquiryAction, {});
  const typed = state.typed ?? {};
  return (
    // A fresh key after a refusal re-applies the typed values as defaults.
    <form action={action} key={state.error ? "retry" : "new"} className="stack">
      {state.error ? (
        <p className="error" role="alert">
          {state.error}
        </p>
      ) : null}
      <section className="panel" aria-labelledby="who-title">
        <h2 id="who-title">Who called</h2>
        <label>
          Customer name
          <input
            name="name"
            autoComplete="off"
            required
            maxLength={120}
            defaultValue={typed.name}
          />
        </label>
        <label>
          Mobile number
          <input
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="off"
            required
            defaultValue={typed.phone}
          />
        </label>
        <label>
          Address
          <textarea name="address" required maxLength={500} rows={3} defaultValue={typed.address} />
        </label>
      </section>
      <section className="panel" aria-labelledby="work-title">
        <h2 id="work-title">Work needed</h2>
        {items.length > 0 ? (
          <div className="choices">
            {items.map((item) => (
              <label key={item.id} className="choice place">
                <input type="checkbox" name="task" value={item.id} />
                <span className="text">
                  <strong>{item.name}</strong>
                </span>
              </label>
            ))}
          </div>
        ) : null}
        <label>
          Other work (optional)
          <input name="customTask" maxLength={120} defaultValue={typed.customTask} />
        </label>
      </section>
      <div className="dock stacked">
        <button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save request"}
        </button>
      </div>
    </form>
  );
}
