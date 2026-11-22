"use client";
import { useActionState } from "react";
import { ShareLink } from "../../share-link.tsx";
import { type ResendState, resendJobLink } from "./actions.ts";

export function ResendLink({ jobId, businessName }: { jobId: string; businessName: string }) {
  const [state, action, pending] = useActionState<ResendState, FormData>(resendJobLink, {});
  return (
    <>
      <form action={action}>
        <input type="hidden" name="jobId" value={jobId} />
        <button type="submit" className="quiet" disabled={pending}>
          {pending ? "Making link…" : "Revoke old links, send a new one"}
        </button>
      </form>
      {state.error ? (
        <p className="error" role="alert">
          {state.error}
        </p>
      ) : null}
      {state.secret ? (
        <>
          <p className="muted small">
            Older links to this request no longer work. This one is live for 30 days.
          </p>
          <ShareLink
            link={`${window.location.origin}/j/${state.secret}`}
            label="Customer link"
            message={`${businessName}: follow your request here:`}
          />
        </>
      ) : null}
    </>
  );
}
