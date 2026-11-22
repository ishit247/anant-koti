import { currentBusiness, defineRoute } from "@bodhchakra/tenancy";
import { customerPost } from "../../../../../../guard.ts";
import { readAnswerForm } from "../../../../../../quote-form.ts";
import { answerRequestQuote } from "../../../../../../request-edit.ts";
import { server } from "../../../../../../server.ts";

// The signed-in customer's accept, reject or counter on their own request (architecture 7). customerPost refuses
// another site's post (403) and sends a post without a session to sign-in; the job is looked up under the
// customer, so another customer's or business's id is a 404. A route handler rather than a server action, so
// the page's answer forms stay plain HTML.
// biome-ignore lint/correctness/noUnusedVariables: read by scanRoutes, which scans the source text
const route = defineRoute({ scope: "customer" });

/** The answer form is a few fields and a note of at most 500 characters. */
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
    const read = readAnswerForm(form, (await currentBusiness(client)).currency);
    if (!read.ok) return `${page}?answer=${read.error}`;
    const answered = await answerRequestQuote(
      client,
      server().audit,
      customer,
      jobId,
      read.quoteId,
      read.answer,
    );
    if (answered.ok) return `${page}?answer=${read.answer.kind}`;
    if (answered.error === "not_found") return new Response("No such request.\n", { status: 404 });
    return `${page}?answer=${answered.error}`;
  });
}
