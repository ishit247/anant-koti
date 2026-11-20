import { defineRoute, inviteSummary } from "@bodhchakra/tenancy";
import { headers } from "next/headers";
import { server } from "../../../server.ts";
import { acceptInviteAction } from "./actions.ts";

// The path token is the credential: it resolves to one invite, which names the business.
// biome-ignore lint/correctness/noUnusedVariables: read by scanRoutes, which scans the source text
const route = defineRoute({ scope: "invite-token" });

export default async function InvitePage({ params }: { params: Promise<{ secret: string }> }) {
  const { secret } = await params;
  const summary = await inviteSummary(server().db, secret);
  if (!summary) {
    return (
      <>
        <h1>This invite is no longer valid</h1>
        <p className="muted">It may have been used or expired. Ask for a new link.</p>
      </>
    );
  }
  const session = await server().auth.getSession((await headers()).get("cookie"));
  return (
    <>
      <h1>Join {summary.businessName}</h1>
      <p className="muted">{summary.invitedByName} invited you as a technician.</p>
      {session ? (
        <form action={acceptInviteAction}>
          <input type="hidden" name="secret" value={secret} />
          <label>
            Your name
            <input name="yourName" autoComplete="name" required maxLength={120} />
          </label>
          <button type="submit">Join</button>
        </form>
      ) : (
        <a className="button" href={`/login?return=${encodeURIComponent(`/invite/${secret}`)}`}>
          Sign in to join
        </a>
      )}
    </>
  );
}
