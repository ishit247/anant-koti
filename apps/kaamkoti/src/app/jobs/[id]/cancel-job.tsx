"use client";
import { useActionState } from "react";
import { type CancelJobState, cancelJobAction } from "./actions.ts";

/** Behind a tap, so a request is never cancelled by accident. */
export function CancelJob({ jobId, linkOpen }: { jobId: string; linkOpen: boolean }) {
  const [state, action, pending] = useActionState<CancelJobState, FormData>(cancelJobAction, {});
  return (
    <details className="card">
      <summary>Cancel this request</summary>
      <form action={action}>
        <input type="hidden" name="jobId" value={jobId} />
        <p className="muted small">
          Its visits are cancelled
          {linkOpen ? ", and the customer's payment link stops working" : ""}. This cannot be
          undone.
        </p>
        <button type="submit" className="danger" disabled={pending}>
          {pending ? "Cancelling…" : "Yes, cancel it"}
        </button>
        {state.error ? (
          <p className="error" role="alert">
            {state.error}
          </p>
        ) : null}
      </form>
    </details>
  );
}
