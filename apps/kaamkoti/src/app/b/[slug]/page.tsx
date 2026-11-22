import { formatMoney } from "@bodhchakra/money";
import { defineRoute } from "@bodhchakra/tenancy";
import { notFound } from "next/navigation";
import { publicPage } from "../../../public-page.ts";
import { server } from "../../../server.ts";
import { BusinessHeader } from "../../business-header.tsx";
import { Icon } from "../../icons.tsx";

// No credential: the slug in the path opens one business, and only its public columns are read.
// biome-ignore lint/correctness/noUnusedVariables: read by scanRoutes, which scans the source text
const route = defineRoute({ scope: "public-slug" });

export default async function BusinessPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = await publicPage(server().db, slug);
  if (!page) notFound();
  const digits = page.phone.replace(/\D/g, "");
  const space = `/b/${encodeURIComponent(slug)}`;
  return (
    <>
      <BusinessHeader business={page} home="here">
        {page.about ? <p>{page.about}</p> : null}
      </BusinessHeader>
      <div className="actions">
        <a className="button" href={`${space}/request`}>
          <Icon name="plus" size={18} />
          New work
        </a>
        <a className="button quiet" href={`${space}/requests`}>
          Work list
        </a>
      </div>
      <div className="actions">
        <a className="button quiet" href={`tel:${page.phone}`}>
          <Icon name="phone" size={18} />
          Call
        </a>
        <a className="button quiet" href={`https://wa.me/${digits}`}>
          <Icon name="chat" size={18} />
          WhatsApp
        </a>
      </div>
      {page.services.length > 0 ? (
        <section className="panel">
          <h2>Services and prices</h2>
          <ul className="lines">
            {page.services.map((s) => (
              <li key={s.id} className="row">
                <span>{s.name}</span>
                <span className="amount muted">{formatMoney(s.price)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
