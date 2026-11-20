"use client";
import { useActionState } from "react";
import { type InviteState, inviteTechnician } from "./actions.ts";

export function InviteForm({ businessName }: { businessName: string }) {
  const [state, action, pending] = useActionState<InviteState>(inviteTechnician, {});
  const link = state.secret ? `${window.location.origin}/invite/${state.secret}` : null;
  const message = `Join ${businessName} on Kaam Koti: ${link}`;
  return (
    <>
      <form action={action}>
        <button type="submit" disabled={pending}>
          {pending ? "Making link…" : "Invite a technician"}
        </button>
      </form>
      {link ? (
        <div>
          <p className="muted">
            Share this link with your technician. It works once and expires in 7 days.
          </p>
          <div className="share">
            <input
              readOnly
              value={link}
              aria-label="Invite link"
              onFocus={(e) => e.currentTarget.select()}
            />
            <button
              type="button"
              className="quiet"
              onClick={() => navigator.clipboard.writeText(link)}
            >
              Copy
            </button>
            <a className="button" href={`https://wa.me/?text=${encodeURIComponent(message)}`}>
              WhatsApp
            </a>
          </div>
        </div>
      ) : null}
    </>
  );
}
