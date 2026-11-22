"use client";
import { useActionState } from "react";
import { ShareLink } from "../share-link.tsx";
import { type InviteState, inviteTechnician } from "./actions.ts";

export function InviteForm({ businessName }: { businessName: string }) {
  const [state, action, pending] = useActionState<InviteState>(inviteTechnician, {});
  const link = state.secret ? `${window.location.origin}/invite/${state.secret}` : null;
  return (
    <>
      <form action={action}>
        <button type="submit" className="quiet" disabled={pending}>
          {pending ? "Making link…" : "Invite a technician"}
        </button>
      </form>
      {link ? (
        <div>
          <p className="muted small">
            Share this link with your technician. It works once and expires in 7 days.
          </p>
          <ShareLink
            link={link}
            label="Invite link"
            message={`Join ${businessName} on Kaam Koti:`}
          />
        </div>
      ) : null}
    </>
  );
}
