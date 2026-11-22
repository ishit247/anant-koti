import { currentBusiness, defineRoute } from "@bodhchakra/tenancy";
import { resolveJobLink } from "../../../../job-link.ts";
import { answerQuote } from "../../../../quote.ts";
import { readAnswerForm } from "../../../../quote-form.ts";
import { server } from "../../../../server.ts";

// The customer's accept, reject or counter. The path secret is the credential, as on the page: it resolves to
// one job, and the answer is written inside withTenant of that job's business, to a quote of that job only. No
// cookie is read or set, so a form post carries no ambient authority (architecture.md 7). The proxy limits
// /j/ per IP, this handler included. A route handler rather than a server action, so the page stays plain HTML.
// biome-ignore lint/correctness/noUnusedVariables: read by scanRoutes, which scans the source text
const route = defineRoute({ scope: "customer-token" });

/** The answer form is a few fields and a note of at most 500 characters. */
const MAX_BODY_BYTES = 16 * 1024;

export async function POST(request: Request, { params }: { params: Promise<{ secret: string }> }) {
  const { secret } = await params;
  const length = Number(request.headers.get("content-length"));
  if (!(length > 0 && length <= MAX_BODY_BYTES))
    return new Response("The request is too large.\n", { status: 413 });
  const { db, audit } = server();
  const link = await resolveJobLink(db, secret);
  // The page says the link is no longer valid; sending the customer there explains it.
  const page = `/j/${encodeURIComponent(secret)}`;
  if (!link) return seeOther(page);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    // Documented fallback: a body that is not a form is the sender's mistake, answered as such.
    return new Response("Expected a form.\n", { status: 400 });
  }
  const outcome = await db.withTenant(link.businessId, async (client) => {
    const read = readAnswerForm(form, (await currentBusiness(client)).currency);
    if (!read.ok) return read.error;
    const answered = await answerQuote(client, audit, link.jobId, read.quoteId, read.answer);
    return answered.ok ? read.answer.kind : answered.error;
  });
  return seeOther(`${page}?answer=${outcome}`);
}

const seeOther = (location: string) => new Response(null, { status: 303, headers: { location } });
