// The two questions every member route asks (docs/architecture.md 4.3): may this role do it (the route's declared
// roles), and whose rows (the signed-in member's own business, never an id from the request). Customer routes
// ask only the second: the business by slug, and the signed-in customer's own row in it.
import type { CustomerSession } from "@bodhchakra/auth";
import type { DbClient } from "@bodhchakra/db";
import {
  type Membership,
  NotPermittedError,
  type RouteDeclaration,
  requireRole,
  resolveSlug,
} from "@bodhchakra/tenancy";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { customerFor, type SpaceCustomer } from "./customer-space.ts";
import { server } from "./server.ts";

type MemberRoute = Extract<RouteDeclaration, { scope: "member" }>;

/**
 * Whether a post on the bare domain came from this app's own pages (architecture 7), so another site cannot
 * make a customer's browser send it. Browsers say so in Sec-Fetch-Site whatever the page's referrer policy;
 * Origin cannot be the only test, because the app's `Referrer-Policy: no-referrer` makes a browser send
 * `Origin: null` even on a same-origin form post. Without Sec-Fetch-Site (an older browser), Origin decides.
 */
export function fromOwnPages(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  return request.headers.get("origin") === server().publicOrigin;
}

/** The signed-in identity, or a redirect to sign in that returns here. */
export async function requireSession(returnTo: string) {
  const session = await server().auth.getSession((await headers()).get("cookie"));
  if (!session) redirect(`/login?return=${encodeURIComponent(returnTo)}`);
  return session;
}

/**
 * Runs `fn` inside the business the slug names, for a route declared `scope: "customer"` (architecture 4.3, 7):
 * the customer session (or a redirect to sign in there, returning to `returnTo`), the business by slug (404 if
 * none), then this identity's customer row in it, claimed by verified email if need be. `customer` is null for a
 * person who has not asked this business for anything; `fn` must name it in every job query.
 */
export async function withCustomer<T>(
  slug: string,
  returnTo: string,
  fn: (client: DbClient, customer: SpaceCustomer | null, session: CustomerSession) => Promise<T>,
): Promise<T> {
  const { customerAuth, db, audit } = server();
  const session = await customerAuth.getSession((await headers()).get("cookie"));
  if (!session)
    redirect(`/b/${encodeURIComponent(slug)}/login?return=${encodeURIComponent(returnTo)}`);
  const businessId = await db.tx((client) => resolveSlug(client, slug));
  if (!businessId) notFound();
  return db.withTenant(businessId, async (client) =>
    fn(client, await customerFor(client, audit, session), session),
  );
}

const seeOther = (location: string) => new Response(null, { status: 303, headers: { location } });

/**
 * A customer route handler's form post (architecture 7): refused (403) unless it came from the app's own pages;
 * without a session, a 303 to sign in that returns to `returnTo` (never a 307, which would re-post the form);
 * 404 for an unknown slug. Then `fn` runs inside that business with this identity's customer row, and its
 * answer is a 303 to the location it returns, or the Response it builds.
 */
export async function customerPost(
  request: Request,
  slug: string,
  returnTo: string,
  fn: (client: DbClient, customer: SpaceCustomer | null) => Promise<string | Response>,
): Promise<Response> {
  if (!fromOwnPages(request)) return new Response(null, { status: 403 });
  const { customerAuth, db, audit } = server();
  const session = await customerAuth.getSession(request.headers.get("cookie"));
  if (!session)
    return seeOther(`/b/${encodeURIComponent(slug)}/login?return=${encodeURIComponent(returnTo)}`);
  const businessId = await db.tx((client) => resolveSlug(client, slug));
  if (!businessId) return new Response("No such business.\n", { status: 404 });
  const answer = await db.withTenant(businessId, async (client) =>
    fn(client, await customerFor(client, audit, session)),
  );
  return typeof answer === "string" ? seeOther(answer) : answer;
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
