import { SignInUnavailable, safeReturnTo } from "@bodhchakra/auth";
import { defineRoute } from "@bodhchakra/tenancy";
import { server } from "../../server.ts";
import { unavailable } from "../../sign-in-pages.ts";

export const route = defineRoute({ scope: "none" });

export async function GET(request: Request) {
  const { origin, auth } = server();
  const url = new URL(request.url);
  // The member cookie lives on the app host only, so a sign-in started on any other host moves there first.
  if (request.headers.get("host") !== new URL(origin).host)
    return Response.redirect(`${origin}${url.pathname}${url.search}`, 302);
  const returnTo = safeReturnTo(url.searchParams.get("return"));
  try {
    const redirect = await auth.startLogin(returnTo);
    return new Response(null, {
      status: 302,
      headers: { location: redirect.location, "set-cookie": redirect.setCookie },
    });
  } catch (error) {
    if (error instanceof SignInUnavailable) return unavailable();
    throw error;
  }
}
