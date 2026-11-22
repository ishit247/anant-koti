import { MAX_IMAGE_BYTES } from "@bodhchakra/storage";
import { defineRoute } from "@bodhchakra/tenancy";
import { MAX_ADDRESSES } from "../../../../../../address-book.ts";
import { customerPost } from "../../../../../../guard.ts";
import { checkItemPhotos, MAX_REQUEST_PHOTOS, readIntakeForm } from "../../../../../../intake.ts";
import { clientIp, LIMITS, overLimit } from "../../../../../../limits.ts";
import { editRequest } from "../../../../../../request-edit.ts";
import { server } from "../../../../../../server.ts";

// The signed-in customer changes the place and the work items of their own request, until they accept a quote. The customer
// comes from the session and the job is looked up under it, so another customer's id is a 404. Like ./send, it
// takes one multipart post and answers JSON to the form's fetch, so a refusal leaves everything typed in place.
// biome-ignore lint/correctness/noUnusedVariables: read by scanRoutes, which scans the source text
const route = defineRoute({ scope: "customer" });

const MAX_BODY_BYTES = MAX_REQUEST_PHOTOS * MAX_IMAGE_BYTES + 1024 * 1024;

const REFUSED = {
  locked: "A quote has been accepted, so the work items can no longer be changed here.",
  contact: "Please check the name, a 10-digit mobile number, the address and what to save it as.",
  location: "Your location could not be read. Please try again, or leave it out.",
  address: "That address is no longer in your address book. Please choose again.",
  addresses_full: `Your address book is full (${MAX_ADDRESSES}). Untick "Save for next time", or delete one on your profile.`,
  items: "Please keep at least one work item, each with a title.",
  too_many_photos: `Please keep at most ${MAX_REQUEST_PHOTOS} photos in all.`,
  photo_too_large: "A photo is larger than 10 MB. Please send a smaller one.",
  photo_not_an_image: "Photos must be JPEG, PNG or WebP images.",
} as const;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string; jobId: string }> },
) {
  const { slug, jobId } = await params;
  const page = `/b/${encodeURIComponent(slug)}/requests/${encodeURIComponent(jobId)}`;
  const json = request.headers.get("accept") === "application/json";
  const refusal = (error: keyof typeof REFUSED) =>
    json ? Response.json({ error }, { status: 422 }) : `${page}?error=${error}`;

  const { db, storage, audit, limiter } = server();
  const refused = await overLimit(limiter.limit, [
    [`intake-ip:${clientIp(request.headers)}`, LIMITS.intakePerIp],
  ]);
  if (refused) return refused;
  const length = Number(request.headers.get("content-length"));
  if (!(length > 0 && length <= MAX_BODY_BYTES))
    return new Response("The request is too large.\n", { status: 413 });
  const form = await request.formData().catch(() => null);
  // Documented fallback: a body that is not a form is the sender's mistake, answered as such.
  if (!form) return new Response("Expected a form.\n", { status: 400 });
  const input = await readIntakeForm(form);
  const checked = await checkItemPhotos(input.items);

  return customerPost(request, slug, page, async (client, customer) => {
    if (!customer) return new Response("No such request.\n", { status: 404 });
    if (!checked.ok) return refusal(checked.error);
    const outcome = await editRequest(
      client,
      storage,
      audit,
      customer,
      jobId,
      input,
      checked.photos,
    );
    if (outcome === "not_found") return new Response("No such request.\n", { status: 404 });
    if (outcome in REFUSED) return refusal(outcome as keyof typeof REFUSED);
    const location = `${page}?result=${outcome}`;
    return json ? Response.json({ location }) : location;
  });
}
