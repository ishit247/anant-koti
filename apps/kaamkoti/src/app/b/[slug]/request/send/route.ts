import { MAX_IMAGE_BYTES } from "@bodhchakra/storage";
import { defineRoute } from "@bodhchakra/tenancy";
import { fromOwnPages } from "../../../../../guard.ts";
import { MAX_REQUEST_PHOTOS, readIntakeForm, submitRequest } from "../../../../../intake.ts";
import { clientIp, LIMITS, overLimit } from "../../../../../limits.ts";
import { server } from "../../../../../server.ts";

// A signed-in customer (D15) creates a request in the business the slug names, and only there, under their own
// customer row (intake.ts); rate limited per IP and per business. A route handler rather than a server action,
// unlike the app's other forms: it must answer 429 and 413, and accept six photos, which a server action's body
// limit would refuse.
// biome-ignore lint/correctness/noUnusedVariables: read by scanRoutes, which scans the source text
const route = defineRoute({ scope: "customer" });

/** Six photos at the most each may weigh, and room for the text fields. */
const MAX_BODY_BYTES = MAX_REQUEST_PHOTOS * MAX_IMAGE_BYTES + 1024 * 1024;

const seeOther = (location: string) => new Response(null, { status: 303, headers: { location } });

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { db, storage, audit, notices, limiter, customerAuth } = server();
  // The cookie is SameSite=Lax already; this refuses another site's post outright, as sign-out does.
  if (!fromOwnPages(request)) return new Response(null, { status: 403 });
  const form = `/b/${encodeURIComponent(slug)}/request`;
  // The form posts with fetch and asks for JSON, so a refusal leaves everything typed and every photo chosen in
  // place; without JavaScript it posts plainly and is answered with redirects.
  const json = request.headers.get("accept") === "application/json";
  // 303, not the 307 of redirect(): the browser must not post the form again to the next page.
  const go = (location: string) => (json ? Response.json({ location }) : seeOther(location));
  const session = await customerAuth.getSession(request.headers.get("cookie"));
  if (!session)
    return go(`/b/${encodeURIComponent(slug)}/login?return=${encodeURIComponent(form)}`);

  const refused = await overLimit(limiter.limit, [
    [`intake-ip:${clientIp(request.headers)}`, LIMITS.intakePerIp],
    [`intake-business:${slug.slice(0, 80)}`, LIMITS.intakePerBusiness],
  ]);
  if (refused) return refused;
  // Checked before the body is read: browsers always send the length of a form post.
  const length = Number(request.headers.get("content-length"));
  if (!(length > 0 && length <= MAX_BODY_BYTES))
    return new Response("The request is too large.\n", { status: 413 });

  let body: FormData;
  try {
    body = await request.formData();
  } catch {
    // Documented fallback: a body that is not a form is the sender's mistake, answered as such.
    return new Response("Expected a form.\n", { status: 400 });
  }
  const input = await readIntakeForm(body);
  const result = await submitRequest(db, storage, audit, notices, slug, session, input);
  if (result.ok) return go(`/b/${encodeURIComponent(slug)}/requests`);
  if (result.error === "not_found") return new Response("No such business.\n", { status: 404 });
  return json
    ? Response.json({ error: result.error }, { status: 422 })
    : seeOther(`${form}?error=${result.error}`);
}
