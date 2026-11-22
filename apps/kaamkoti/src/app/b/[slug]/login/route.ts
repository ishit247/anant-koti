import { SignInUnavailable, safeReturnTo } from "@bodhchakra/auth";
import { defineRoute } from "@bodhchakra/tenancy";
import { server } from "../../../../server.ts";
import { unavailable } from "../../../../sign-in-pages.ts";

// Starts a customer's sign-in (D15). Reads no business: the slug only shapes where the customer comes back to.
export const route = defineRoute({ scope: "none" });

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { publicOrigin, customerAuth } = server();
  const url = new URL(request.url);
  // The customer cookie lives on the bare domain only, so a sign-in started on any other host moves there first.
  if (request.headers.get("host") !== new URL(publicOrigin).host)
    return Response.redirect(`${publicOrigin}${url.pathname}${url.search}`, 302);

  const space = `/b/${encodeURIComponent((await params).slug)}/`;
  const asked = safeReturnTo(url.searchParams.get("return"));
  const returnTo = asked.startsWith(space) ? asked : `${space}requests`;
  try {
    const redirect = await customerAuth.startLogin(returnTo);
    return new Response(null, {
      status: 302,
      headers: { location: redirect.location, "set-cookie": redirect.setCookie },
    });
  } catch (error) {
    if (error instanceof SignInUnavailable) return unavailable(`${url.pathname}${url.search}`);
    throw error;
  }
}
