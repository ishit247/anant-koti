import { defineRoute } from "@bodhchakra/tenancy";
import { point } from "../../../../../geocode.ts";
import { fromOwnPages } from "../../../../../guard.ts";
import { clientIp, LIMITS, overLimit } from "../../../../../limits.ts";
import { server } from "../../../../../server.ts";

// The address of the point a signed-in customer picked on the request form (D16). Reads and writes no business
// row: the slug only names the page asking. Customers only, so the app's one-a-second share of the geocoder is
// not open to anyone on the internet; POST, so the point stays out of URLs and access logs.
// biome-ignore lint/correctness/noUnusedVariables: read by scanRoutes, which scans the source text
const route = defineRoute({ scope: "customer" });

export async function POST(request: Request) {
  const { customerAuth, limiter, geocode } = server();
  if (!fromOwnPages(request)) return new Response(null, { status: 403 });
  if (!(await customerAuth.getSession(request.headers.get("cookie"))))
    return new Response(null, { status: 401 });
  const refused = await overLimit(limiter.limit, [
    [`place-ip:${clientIp(request.headers)}`, LIMITS.placePerIp],
    ["place-global", LIMITS.placeGlobal],
  ]);
  if (refused) return refused;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    // Documented fallback: a body that is not JSON is the sender's mistake, answered as such.
    return new Response("Expected JSON.\n", { status: 400 });
  }
  const at = point.safeParse(body);
  if (!at.success) return new Response("Expected a latitude and a longitude.\n", { status: 400 });
  return Response.json({ address: await geocode(at.data) });
}
