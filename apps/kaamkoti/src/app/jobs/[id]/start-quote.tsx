"use client";
import { useActionState } from "react";
import type { StartQuoteState } from "./actions.ts";

/** Opens a draft through `start` (startQuote or startChange), which goes to its editor. */
export function StartQuote({
  jobId,
  label,
  start,
  quiet = false,
}: {
  jobId: string;
  label: string;
  start: (previous: StartQuoteState, form: FormData) => Promise<StartQuoteState>;
  quiet?: boolean;
}) {
  const [state, action, pending] = useActionState<StartQuoteState, FormData>(start, {});
  return (
    <form action={action}>
      <input type="hidden" name="jobId" value={jobId} />
      <button type="submit" className={quiet ? "quiet" : undefined} disabled={pending}>
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
