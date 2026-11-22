// Limits customer-link lookups per IP before the page renders: a page cannot answer 429 itself. Only /j/ runs
// through here; the request form limits itself in its route handler, because the proxy would buffer (and cut
// at 10 MB) a body carrying photos.
import { type NextRequest, NextResponse } from "next/server";
import { clientIp, LIMITS, overLimit } from "./limits.ts";
import { server } from "./server.ts";

export async function proxy(request: NextRequest) {
  const refused = await overLimit(server().limiter.limit, [
    [`job-link-ip:${clientIp(request.headers)}`, LIMITS.jobLinkPerIp],
  ]);
  return refused ?? NextResponse.next();
}

export const config = { matcher: "/j/:path*" };
