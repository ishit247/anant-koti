import { formatDecimal, formatMoney, minorDigits } from "@bodhchakra/money";
import { currentBusiness, defineRoute } from "@bodhchakra/tenancy";
import { notFound } from "next/navigation";
import { z } from "zod";
import { listCatalogue } from "../../../../business-profile.ts";
import { requireMember } from "../../../../guard.ts";
import { jobTasks } from "../../../../job.ts";
import { ownerQuotes, QUOTE_VALID_DAYS } from "../../../../quote.ts";
import { server } from "../../../../server.ts";
import { OwnerNav } from "../../../owner-nav.tsx";
import { type Draft, QuoteEditor } from "./quote-editor.tsx";

// The id in the path is only a lookup key: the job, its draft and the price list are read inside withTenant of
// the signed-in owner's business, so another business's id is a 404 like an unknown one.
const route = defineRoute({ scope: "member", roles: ["owner"] });

export default async function QuotePage({ params }: { params: Promise<{ id: string }> }) {
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) notFound();
  const owner = await requireMember(route, `/jobs/${id.data}/quote`);
  const data = await server().db.withTenant(owner.businessId, async (client) => {
    const job = await client.query<{ number: number }>("select number from kk.job where id = $1", [
      id.data,
    ]);
    const number = job.rows[0]?.number;
    if (number === undefined) return null;
    return {
      number,
      business: await currentBusiness(client),
      quotes: await ownerQuotes(client, id.data),
      tasks: await jobTasks(client, id.data),
      items: (await listCatalogue(client)).filter((item) => item.active),
    };
  });
  if (!data) notFound();
  const places = minorDigits(data.business.currency);
  const quote = data.quotes.find((q) => q.status === "draft");
  const draft: Draft | null = quote
    ? {
        id: quote.id,
        version: quote.version,
        deposit: quote.deposit.minor > 0 ? formatDecimal(quote.deposit.minor, places) : "",
        totals: {
          net: formatMoney(quote.net),
          tax: formatMoney(quote.tax),
          total: formatMoney(quote.total),
        },
        rows: quote.lines.map((line) => ({
          task: line.jobTaskId ?? "",
          item: line.catalogueItemId ?? "",
          description: line.description,
          unit: line.unit,
          quantity: formatDecimal(line.quantityMilli, 3),
          price: formatDecimal(line.unitPriceMinor, places),
          tax: formatDecimal(line.taxRateBp, 2),
        })),
      }
    : null;
  return (
    <>
      <header className="bar">
        <h1>{draft ? `Quote, version ${draft.version}` : "Quote"}</h1>
        <a className="button quiet" href={`/jobs/${id.data}`}>
          ← Request #{data.number}
        </a>
      </header>
      <p className="muted small">
        Prices are before tax. Lines for the whole request are charges or discounts.
      </p>
      <QuoteEditor
        jobId={id.data}
        jobNumber={data.number}
        businessName={data.business.name}
        draft={draft}
        tasks={data.tasks}
        items={data.items.map((item) => ({
          id: item.id,
          name: item.name,
          unit: item.unit,
          price: formatDecimal(item.unitPriceMinor, places),
          tax: formatDecimal(item.taxRateBp, 2),
        }))}
        validDays={QUOTE_VALID_DAYS}
      />
      <OwnerNav current="/jobs" />
    </>
  );
}
