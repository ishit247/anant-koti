import { defineRoute } from "@bodhchakra/tenancy";
import { redirect } from "next/navigation";
import { businessProfile, listCatalogue } from "../../business-profile.ts";
import { requireMember } from "../../guard.ts";
import { server } from "../../server.ts";
import { CatalogueForm, type FormRow } from "./catalogue-form.tsx";

const route = defineRoute({ scope: "member", roles: ["owner"] });

/** Hundredths as the owner types them: 45000 is "450", 45050 is "450.50". */
const hundredths = (n: number) => (n % 100 === 0 ? String(n / 100) : (n / 100).toFixed(2));

export default async function CataloguePage() {
  const owner = await requireMember(route, "/catalogue");
  const { profile, items } = await server().db.withTenant(owner.businessId, async (client) => ({
    profile: await businessProfile(client),
    items: await listCatalogue(client),
  }));
  if (!profile) redirect("/onboarding");
  const rows: FormRow[] = items.map((item) => ({
    id: item.id,
    name: item.name,
    unit: item.unit,
    price: hundredths(item.unitPriceMinor),
    tax: hundredths(item.taxRateBp),
    active: item.active ? "yes" : "no",
  }));
  return (
    <>
      <p>
        <a href="/">← Home</a>
      </p>
      <h1>Your prices</h1>
      <p className="muted">
        Prices in rupees, tax in percent. Hide an item to stop offering it; old quotes keep their
        price.
      </p>
      <CatalogueForm rows={rows} />
    </>
  );
}
