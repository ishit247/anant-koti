"use server";
import { LimitReached } from "@bodhchakra/billing";
import { acceptInvite, defineRoute, InviteRefused } from "@bodhchakra/tenancy";
import { redirect } from "next/navigation";
import { requireSession } from "../../../guard.ts";
import { server } from "../../../server.ts";
import { assertSeatFree } from "../../../subscription.ts";

// Scope is the invite the secret names; the identity comes from the session, never from the form.
// biome-ignore lint/correctness/noUnusedVariables: read by scanRoutes, which scans the source text
const route = defineRoute({ scope: "invite-token" });

export async function acceptInviteAction(form: FormData): Promise<void> {
  const secret = String(form.get("secret") ?? "");
  const displayName = String(form.get("yourName") ?? "")
    .trim()
    .slice(0, 120);
  const session = await requireSession(`/invite/${secret}`);
  if (!displayName) redirect(`/invite/${secret}`);
  try {
    await acceptInvite(
      server().db,
      secret,
      { identityId: session.identityId, displayName },
      assertSeatFree,
    );
  } catch (error) {
    // A full team keeps the link: it works once the owner has a free seat.
    if (error instanceof LimitReached) redirect(`/invite/${secret}?full=1`);
    if (!(error instanceof InviteRefused)) throw error;
    redirect(`/invite/${secret}`);
  }
  redirect("/");
}
