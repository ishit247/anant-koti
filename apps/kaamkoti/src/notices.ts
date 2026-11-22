// The messages Kaam Koti sends through notify (docs/architecture.md 9.2's table). Each is queued in the transaction
// of the change it reports, so it goes out only if that change commits; platform picks the channel. Variables
// are formatted here, in the business's currency and time zone; platform's templates only place them.
import type { DbClient } from "@bodhchakra/db";
import { formatMoney, money } from "@bodhchakra/money";
import type { Notify } from "@bodhchakra/notify";
import { requestPageUrl } from "./customer-space.ts";
import { formatDay } from "./job-labels.ts";

/**
 * `quote.sent` to the customer, linking to their page for the job on the bare domain (`publicOrigin`). Runs
 * inside `withTenant`, after `sendQuote`; a quote that is not `sent` is a caller bug.
 */
export async function noticeQuoteSent(
  client: DbClient,
  notify: Notify,
  input: { readonly quoteId: string; readonly publicOrigin: string },
): Promise<void> {
  const { rows } = await client.query<{
    business_id: string;
    slug: string;
    job_id: string;
    business_name: string;
    currency: string;
    customer_name: string;
    email: string | null;
    phone_e164: string;
    total_minor: string;
    valid_until: Date;
  }>(
    `select q.business_id, b.slug, q.job_id, b.name as business_name, b.currency, c.name as customer_name, c.email,
            c.phone_e164, q.total_minor, q.valid_until
     from kk.quote q
     join kk.job j on j.business_id = q.business_id and j.id = q.job_id
     join kk.customer c on c.business_id = j.business_id and c.id = j.customer_id
     join tenancy.business b on b.id = q.business_id
     where q.id = $1 and q.status = 'sent'`,
    [input.quoteId],
  );
  const quote = rows[0];
  if (!quote) throw new Error(`noticeQuoteSent: quote ${input.quoteId} is not a sent quote here`);
  await notify.send(
    client,
    {
      businessId: quote.business_id,
      template: "quote.sent",
      to: { ...(quote.email && { email: quote.email }), phone: quote.phone_e164 },
      vars: {
        customerName: quote.customer_name,
        businessName: quote.business_name,
        total: formatMoney(money(Number(quote.total_minor), quote.currency)),
        validUntil: formatDay(quote.valid_until),
        link: requestPageUrl(input.publicOrigin, quote.slug, quote.job_id),
      },
    },
    `quote.sent:${input.quoteId}`,
  );
}
