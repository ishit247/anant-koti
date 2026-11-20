// The two questions every member route asks (docs/architecture.md 4.3): may this role do it (the route's declared
// roles), and whose rows (the signed-in member's own business, never an id from the request).
import {
  type Membership,
  NotPermittedError,
  type RouteDeclaration,
  requireRole,
} from "@bodhchakra/tenancy";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { server } from "./server.ts";

type MemberRoute = Extract<RouteDeclaration, { scope: "member" }>;

/** The signed-in identity, or a redirect to sign in that returns here. */
export async function requireSession(returnTo: string) {
  const session = await server().auth.getSession((await headers()).get("cookie"));
  if (!session) redirect(`/login?return=${encodeURIComponent(returnTo)}`);
  return session;
}

/**
 * The signed-in member for a route declared `scope: "member"`. A person with no business yet goes to
 * signup; a role the route does not allow gets a 404, so a technician learns nothing about owner pages.
 * A person in several businesses uses the oldest until a switcher exists.
 */
export async function requireMember(route: MemberRoute, returnTo = "/"): Promise<Membership> {
  const session = await requireSession(returnTo);
  const membership = session.memberships[0];
  if (!membership) redirect("/signup");
  try {
    requireRole(membership, ...route.roles);
  } catch (error) {
    if (error instanceof NotPermittedError) notFound();
    throw error;
  }
  return membership;
}
