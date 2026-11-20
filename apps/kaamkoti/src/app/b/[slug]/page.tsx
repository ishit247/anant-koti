import { defineRoute } from "@bodhchakra/tenancy";
import { notFound } from "next/navigation";
import { publicPage } from "../../../public-page.ts";
import { server } from "../../../server.ts";

// No credential: the slug in the path opens one business, and only its public columns are read.
// biome-ignore lint/correctness/noUnusedVariables: read by scanRoutes, which scans the source text
const route = defineRoute({ scope: "public-slug" });

const PER: Record<string, string> = {
  job: "per job",
  hour: "per hour",
  unit: "each",
  sq_ft: "per sq ft",
  metre: "per metre",
  visit: "per visit",
};

const rupees = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" });

export default async function BusinessPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = await publicPage(server().db, slug);
  if (!page) notFound();
  const digits = page.phone.replace(/\D/g, "");
  return (
    <>
      <h1>{page.name}</h1>
      <p className="muted">
        {page.city}
        {page.serviceArea ? ` · ${page.serviceArea}` : ""}
      </p>
      {page.about ? <p>{page.about}</p> : null}
      <p>
        <a className="button" href={`tel:${page.phone}`}>
          Call
        </a>{" "}
        <a className="button" href={`https://wa.me/${digits}`}>
          WhatsApp
        </a>
      </p>
      <h2>Services and prices</h2>
      <ul>
        {page.services.map((s) => (
          <li key={s.name}>
            {s.name} — {rupees.format(s.unitPriceMinor / 100)} {PER[s.unit]}
          </li>
        ))}
      </ul>
    </>
  );
}
