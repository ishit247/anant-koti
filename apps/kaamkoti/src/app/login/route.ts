import { SignInUnavailable, safeReturnTo } from "@bodhchakra/auth";
import { defineRoute } from "@bodhchakra/tenancy";
import { server } from "../../server.ts";
import { unavailable } from "../../sign-in-pages.ts";

export const route = defineRoute({ scope: "none" });

export async function GET(request: Request) {
  const returnTo = safeReturnTo(new URL(request.url).searchParams.get("return"));
  try {
    const redirect = await server().auth.startLogin(returnTo);
    return new Response(null, {
      status: 302,
      headers: { location: redirect.location, "set-cookie": redirect.setCookie },
    });
  } catch (error) {
    if (error instanceof SignInUnavailable) return unavailable();
    throw error;
  }
}
