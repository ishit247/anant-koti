"use client";
import { useActionState } from "react";
import { type StartQuoteState, startQuote } from "./actions.ts";

export function StartQuote({ jobId, label }: { jobId: string; label: string }) {
  const [state, action, pending] = useActionState<StartQuoteState, FormData>(startQuote, {});
  return (
    <form action={action}>
      <input type="hidden" name="jobId" value={jobId} />
      <button type="submit" disabled={pending}>
        {pending ? "Opening…" : label}
      </button>
      {state.error ? (
        <p className="error" role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
