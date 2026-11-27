import { defineRoute } from "@bodhchakra/tenancy";
import { z } from "zod";
import { settleInvoice } from "../../../../invoice.ts";
import { server } from "../../../../server.ts";

// Razorpay's webhook for one business (architecture 8, 4.3). The URL names the business; the raw body's
// signature must verify under that business's own webhook secret, so the id grants nothing by itself. Money is
// recorded here and nowhere else; the owner's notice is queued, and the bill marked paid if this covers it, in
// the same transaction. Answers: 200 for an event applied, repeated or ignored; 401 for a bad signature or an
// unknown business; anything else is a 500, which Razorpay retries.
// biome-ignore lint/correctness/noUnusedVariables: read by scanRoutes, which scans the source text
const route = defineRoute({ scope: "provider-webhook" });

/** Razorpay's payment-link events are a few kilobytes. */
const MAX_BODY_BYTES = 64 * 1024;

const refused = () => new Response(null, { status: 401 });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ businessId: string }> },
) {
  const businessId = z.uuid().safeParse((await params).businessId);
  if (!businessId.success) return refused();
  const length = Number(request.headers.get("content-length"));
  if (!(length > 0 && length <= MAX_BODY_BYTES)) return new Response(null, { status: 413 });

  const { db, audit, payments, notices, log } = server();
  const outcome = await payments.handleWebhook(
    db,
    {
      businessId: businessId.data,
      signature: request.headers.get("x-razorpay-signature"),
      rawBody: await request.text(),
    },
    async (client, event) => {
      if (event.kind !== "payment.received") return;
      await notices.paymentReceived(client, event.payment, event.link);
      // Every link's subject is a job; the bill is paid in this transaction if this covers it.
      await settleInvoice(client, audit, payments, event.link.subjectId);
    },
  );
  if (outcome === "refused") {
    log.warn("razorpay webhook refused", { businessId: businessId.data });
    return refused();
  }
  return Response.json({ outcome });
}
