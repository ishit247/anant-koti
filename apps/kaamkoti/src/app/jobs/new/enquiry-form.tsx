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
    <form action={action} key={state.error ? "retry" : "new"}>
      {state.error ? (
        <p className="error" role="alert">
          {state.error}
        </p>
      ) : null}
      <label>
        Customer name
        <input name="name" autoComplete="off" required maxLength={120} defaultValue={typed.name} />
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
      {items.length > 0 ? (
        <fieldset className="item">
          <legend>Services</legend>
          {items.map((item) => (
            <label key={item.id} className="choice">
              <input type="checkbox" name="task" value={item.id} />
              <span>{item.name}</span>
            </label>
          ))}
        </fieldset>
      ) : null}
      <label>
        Other work (optional)
        <input name="customTask" maxLength={120} defaultValue={typed.customTask} />
      </label>
      <button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save request"}
      </button>
    </form>
  );
}
