import { SignInRefused, SignInUnavailable } from "@bodhchakra/auth";
import { defineRoute } from "@bodhchakra/tenancy";
import { server } from "../../../server.ts";
import { refused, unavailable } from "../../../sign-in-pages.ts";

// The customers' sign-in callback (D15), one path for every business: redirect URIs are registered exactly, so
// the business is in the return path the attempt recorded, not in this URL.
export const route = defineRoute({ scope: "none" });

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  try {
    const signedIn = await server().customerAuth.handleCallback(
      searchParams,
      request.headers.get("cookie"),
    );
    const headers = new Headers({ location: signedIn.returnTo });
    for (const cookie of signedIn.setCookies) headers.append("set-cookie", cookie);
    return new Response(null, { status: 302, headers });
  } catch (error) {
    if (error instanceof SignInRefused) return refused(null);
    if (error instanceof SignInUnavailable) return unavailable(null);
    throw error;
  }
}
