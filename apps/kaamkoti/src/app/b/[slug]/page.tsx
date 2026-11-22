import { defineRoute } from "@bodhchakra/tenancy";
import { notFound } from "next/navigation";
import { formatPrice } from "../../../price.ts";
import { publicPage } from "../../../public-page.ts";
import { server } from "../../../server.ts";

// No credential: the slug in the path opens one business, and only its public columns are read.
// biome-ignore lint/correctness/noUnusedVariables: read by scanRoutes, which scans the source text
const route = defineRoute({ scope: "public-slug" });

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
        <a className="button" href={`/b/${encodeURIComponent(slug)}/request`}>
          Request a visit
        </a>
      </p>
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
          <li key={s.id}>
            {s.name} — {formatPrice(s.price, s.unit)}
          </li>
        ))}
      </ul>
    </>
  );
}
