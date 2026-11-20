import { SignInRefused, SignInUnavailable } from "@bodhchakra/auth";
import { defineRoute } from "@bodhchakra/tenancy";
import { server } from "../../../server.ts";
import { refused, unavailable } from "../../../sign-in-pages.ts";

export const route = defineRoute({ scope: "none" });

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  try {
    const signedIn = await server().auth.handleCallback(
      searchParams,
      request.headers.get("cookie"),
    );
    const headers = new Headers({ location: signedIn.returnTo });
    for (const cookie of signedIn.setCookies) headers.append("set-cookie", cookie);
    return new Response(null, { status: 302, headers });
  } catch (error) {
    if (error instanceof SignInRefused) return refused();
    if (error instanceof SignInUnavailable) return unavailable();
    throw error;
  }
}
