"use client";
import { useActionState } from "react";
import { type ConnectState, connectRazorpay } from "./actions.ts";

/** The three values from the owner's Razorpay dashboard. Secrets are never shown back. */
export function ConnectForm({ connected }: { connected: boolean }) {
  const [state, action, pending] = useActionState<ConnectState, FormData>(connectRazorpay, {});
  return (
    <form action={action}>
      <label>
        Key id
        <input
          name="keyId"
          required
          autoComplete="off"
          spellCheck={false}
          placeholder="rzp_live_…"
        />
      </label>
      <label>
        Key secret
        <input name="keySecret" type="password" required autoComplete="off" />
      </label>
      <label>
        Webhook secret
        <input name="webhookSecret" type="password" required autoComplete="off" />
      </label>
      {state.error ? (
        <p className="error" role="alert">
          {state.error}
        </p>
      ) : null}
      <button type="submit" disabled={pending}>
        {pending ? "Saving…" : connected ? "Replace the keys" : "Connect Razorpay"}
      </button>
    </form>
  );
}
