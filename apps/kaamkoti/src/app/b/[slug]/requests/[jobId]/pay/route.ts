import { defineRoute } from "@bodhchakra/tenancy";
import { requestPageUrl } from "../../../../../../customer-space.ts";
import { payDeposit } from "../../../../../../deposit.ts";
import { customerPost } from "../../../../../../guard.ts";
import { server } from "../../../../../../server.ts";

// The signed-in customer's "Pay the deposit" (4.1b): a 303 to the business's Razorpay page for what is still due.
// customerPost refuses another site's post (403) and sends a post without a session to sign-in; the job is
// looked up under the customer, so another customer's or business's id is a 404. The form carries no fields.
// biome-ignore lint/correctness/noUnusedVariables: read by scanRoutes, which scans the source text
const route = defineRoute({ scope: "customer" });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string; jobId: string }> },
) {
  const { slug, jobId } = await params;
  const page = `/b/${encodeURIComponent(slug)}/requests/${encodeURIComponent(jobId)}`;
  return customerPost(request, slug, page, async (client, customer) => {
    if (!customer) return new Response("No such request.\n", { status: 404 });
    const { payments, publicOrigin } = server();
    const paid = await payDeposit(
      client,
      payments,
      customer,
      jobId,
      `${requestPageUrl(publicOrigin, slug, jobId)}?pay=back`,
    );
    if (paid.ok) return paid.url;
    if (paid.error === "not_found") return new Response("No such request.\n", { status: 404 });
    return `${page}?pay=${paid.error}`;
  });
}
