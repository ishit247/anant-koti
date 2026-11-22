import { defineRoute } from "@bodhchakra/tenancy";
import { fromOwnPages } from "../../../../guard.ts";
import { server } from "../../../../server.ts";

// Ends the customer's session, here and on platform, and comes back to this business's page. Touches no business
// row; it deletes only the session the cookie names.
export const route = defineRoute({ scope: "none" });

/** POST only, and from the app's own pages only (architecture 7), so another site cannot sign a customer out. */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { customerAuth } = server();
  if (!fromOwnPages(request)) return new Response(null, { status: 403 });
  const redirect = await customerAuth.signOut(request.headers.get("cookie"), (await params).slug);
  return new Response(null, {
    status: 303,
    headers: { location: redirect.location, "set-cookie": redirect.setCookie },
  });
}
