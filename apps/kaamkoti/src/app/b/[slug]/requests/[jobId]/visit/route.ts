import { defineRoute } from "@bodhchakra/tenancy";
import { customerPost } from "../../../../../../guard.ts";
import { answerVisit, type VisitAnswer, visitNote } from "../../../../../../schedule.ts";
import { server } from "../../../../../../server.ts";

// The signed-in customer's answer to the work's proposed time on their own request (3.1b): confirm it, or ask
// for another with a note. customerPost refuses another site's post (403) and sends a post without a session to
// sign-in; the job is looked up under the customer, so another customer's or business's id is a 404.
// biome-ignore lint/correctness/noUnusedVariables: read by scanRoutes, which scans the source text
const route = defineRoute({ scope: "customer" });

/** The form is two ids, the answer and a note of at most 500 characters. */
const MAX_BODY_BYTES = 8 * 1024;

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
    let answer: VisitAnswer;
    if (form.get("answer") === "confirm") answer = { kind: "confirm" };
    else {
      const note = visitNote.safeParse(form.get("note") ?? "");
      if (form.get("answer") !== "decline" || !note.success) return `${page}?visit=input`;
      answer = { kind: "decline", note: note.data };
    }
    const appointmentId = String(form.get("appointment"));
    const { audit, notices } = server();
    const answered = await answerVisit(client, audit, customer, jobId, appointmentId, answer);
    if (answered.ok) {
      await notices.visitAnswered(client, appointmentId);
      if (answer.kind === "confirm") await notices.visitPlanned(client, appointmentId);
      return `${page}?visit=${answer.kind}`;
    }
    if (answered.error === "not_found") return new Response("No such request.\n", { status: 404 });
    return `${page}?visit=${answered.error}`;
  });
}
