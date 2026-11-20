import { defineRoute } from "@bodhchakra/tenancy";
import { server } from "../../server.ts";

export const route = defineRoute({ scope: "none" });

/** POST only, so a link or an image on another site cannot sign someone out. */
export async function POST(request: Request) {
  const redirect = await server().auth.signOut(request.headers.get("cookie"));
  return new Response(null, {
    status: 303,
    headers: { location: redirect.location, "set-cookie": redirect.setCookie },
  });
}
