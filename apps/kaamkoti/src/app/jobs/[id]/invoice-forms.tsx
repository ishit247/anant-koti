"use client";
import { useActionState } from "react";
import {
  type InvoiceState,
  issueInvoiceAction,
  recordCashAction,
  voidInvoiceAction,
} from "./actions.ts";

function Failed({ state }: { state: InvoiceState }) {
  return state.error ? (
    <p className="error" role="alert">
      {state.error}
    </p>
  ) : null;
}

/** Cash the owner took, in rupees; `owed` is the most it may be, prefilled. */
export function RecordCash({ jobId, owed }: { jobId: string; owed: string }) {
  const [state, action, pending] = useActionState<InvoiceState, FormData>(recordCashAction, {});
  return (
    <details className="card">
      <summary>Record cash received</summary>
      <form action={action} className="stack">
        <input type="hidden" name="jobId" value={jobId} />
        <label>
          Amount (₹)
          <input name="amount" inputMode="decimal" defaultValue={owed} required />
        </label>
        <button type="submit" disabled={pending}>
          {pending ? "Recording…" : "Record cash"}
        </button>
        <Failed state={state} />
      </form>
    </details>
  );
}

/** Behind a tap: a voided invoice stays on record and cannot be brought back. */
export function VoidInvoice({ jobId }: { jobId: string }) {
  const [state, action, pending] = useActionState<InvoiceState, FormData>(voidInvoiceAction, {});
  return (
    <details className="card">
      <summary>Void this invoice</summary>
      <form action={action}>
        <input type="hidden" name="jobId" value={jobId} />
        <p className="muted small">
          For a mistake, or to add extra work. Money received stays recorded and counts towards the
          next invoice, which you issue after.
        </p>
        <button type="submit" className="danger" disabled={pending}>
          {pending ? "Voiding…" : "Yes, void it"}
        </button>
        <Failed state={state} />
      </form>
    </details>
  );
}

export function IssueInvoice({ jobId }: { jobId: string }) {
  const [state, action, pending] = useActionState<InvoiceState, FormData>(issueInvoiceAction, {});
  return (
    <form action={action}>
      <input type="hidden" name="jobId" value={jobId} />
      <button type="submit" disabled={pending}>
        {pending ? "Issuing…" : "Issue the invoice"}
      </button>
      <Failed state={state} />
    </form>
  );
}
