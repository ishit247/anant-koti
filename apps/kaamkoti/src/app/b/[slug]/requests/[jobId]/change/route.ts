import { defineRoute } from "@bodhchakra/tenancy";
import { z } from "zod";
import { answerChangeOrder } from "../../../../../../change-order.ts";
import { customerPost } from "../../../../../../guard.ts";
import { bill } from "../../../../../../invoice.ts";
import { server } from "../../../../../../server.ts";

// The signed-in customer's approval or refusal of a change order on their own request (architecture 6, 7; 4.3).
// customerPost refuses another site's post (403) and sends a post without a session to sign-in; the job is looked
// up under the customer, so another customer's or business's id is a 404.
// biome-ignore lint/correctness/noUnusedVariables: read by scanRoutes, which scans the source text
const route = defineRoute({ scope: "customer" });

/** Two fields. */
const MAX_BODY_BYTES = 4 * 1024;

const answerForm = z.object({ changeOrder: z.uuid(), answer: z.enum(["approve", "reject"]) });

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
    const read = answerForm.safeParse({
      changeOrder: form.get("changeOrder"),
      answer: form.get("answer"),
    });
    if (!read.success) return `${page}?change=form`;
    const deps = server();
    const answered = await answerChangeOrder(
      client,
      deps.audit,
      customer,
      jobId,
      read.data.changeOrder,
      read.data.answer === "approve",
    );
    if (answered.ok) {
      // On a completed job the bill was waiting for this answer; before completion this issues nothing.
      await bill(client, deps, jobId);
      return `${page}?change=${read.data.answer}`;
    }
    if (answered.error === "not_found") return new Response("No such request.\n", { status: 404 });
    return `${page}?change=${answered.error}`;
  });
}
