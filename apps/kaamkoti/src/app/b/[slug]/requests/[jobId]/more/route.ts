import { defineRoute } from "@bodhchakra/tenancy";
import { askForMoreWork, extraWorkInput } from "../../../../../../change-order.ts";
import { customerPost } from "../../../../../../guard.ts";
import { server } from "../../../../../../server.ts";

// The signed-in customer asks for more work on their own request after accepting its quote (architecture 6; 4.3):
// a work item that waits for the business to price it in a change order. customerPost refuses another site's
// post (403) and sends a post without a session to sign-in; the job is looked up under the customer, so another
// customer's or business's id is a 404.
// biome-ignore lint/correctness/noUnusedVariables: read by scanRoutes, which scans the source text
const route = defineRoute({ scope: "customer" });

/** A title and details of at most 1000 characters. */
const MAX_BODY_BYTES = 16 * 1024;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string; jobId: string }> },
) {
  const { slug, jobId } = await params;
  const page = `/b/${encodeURIComponent(slug)}/requests/${encodeURIComponent(jobId)}`;
  const length = Number(request.headers.get("content-length"));
  if (!(length > 0 && length <= MAX_BODY_BYTES))
    return new Response("The request is too large.\n", { status: 413 });
  const form = await request.formData().catch(() => null);
  // Documented fallback: a body that is not a form is the sender's mistake, answered as such.
  if (!form) return new Response("Expected a form.\n", { status: 400 });

  return customerPost(request, slug, page, async (client, customer) => {
    if (!customer) return new Response("No such request.\n", { status: 404 });
    const read = extraWorkInput.safeParse({
      title: String(form.get("title") ?? ""),
      details: String(form.get("details") ?? ""),
    });
    if (!read.success) return `${page}?more=form`;
    const added = await askForMoreWork(client, customer, jobId, read.data);
    if (added === "not_found") return new Response("No such request.\n", { status: 404 });
    if (added !== "added") return `${page}?more=${added}`;
    await server().notices.requestEdited(client, jobId);
    return `${page}?more=added`;
  });
}
