import { MAX_IMAGE_BYTES } from "@bodhchakra/storage";
import { defineRoute } from "@bodhchakra/tenancy";
import { MAX_REQUEST_PHOTOS, readIntakeForm, submitRequest } from "../../../../../intake.ts";
import { clientIp, LIMITS, overLimit } from "../../../../../limits.ts";
import { server } from "../../../../../server.ts";

// No credential and no cookie: the slug opens one business, and this handler may only create a request in it,
// rate limited per IP and per business. A route handler rather than a server action, unlike the app's other
// forms: it must answer 429 and 413, and accept six photos, which a server action's body limit would refuse.
// biome-ignore lint/correctness/noUnusedVariables: read by scanRoutes, which scans the source text
const route = defineRoute({ scope: "public-intake" });

/** Six photos at the most each may weigh, and room for the text fields. */
const MAX_BODY_BYTES = MAX_REQUEST_PHOTOS * MAX_IMAGE_BYTES + 1024 * 1024;

const seeOther = (location: string) => new Response(null, { status: 303, headers: { location } });

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { db, storage, limiter } = server();
  const refused = await overLimit(limiter.limit, [
    [`intake-ip:${clientIp(request.headers)}`, LIMITS.intakePerIp],
    [`intake-business:${slug.slice(0, 80)}`, LIMITS.intakePerBusiness],
  ]);
  if (refused) return refused;
  // Checked before the body is read: browsers always send the length of a form post.
  const length = Number(request.headers.get("content-length"));
  if (!(length > 0 && length <= MAX_BODY_BYTES))
    return new Response("The request is too large.\n", { status: 413 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    // Documented fallback: a body that is not a form is the sender's mistake, answered as such.
    return new Response("Expected a form.\n", { status: 400 });
  }
  const result = await submitRequest(db, storage, slug, await readIntakeForm(form));
  if (result.ok) return seeOther(`/j/${result.secret}`);
  if (result.error === "not_found") return new Response("No such business.\n", { status: 404 });
  return seeOther(`/b/${encodeURIComponent(slug)}/request?error=${result.error}`);
}
