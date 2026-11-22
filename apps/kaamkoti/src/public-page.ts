// What the public business page shows (docs/architecture.md 4.3, scope `public-slug`): a slug opens one business, and
// only columns meant for the public are selected. Nothing here reads a cookie or a session.
import type { Db } from "@bodhchakra/db";
import { type Money, money } from "@bodhchakra/money";
import { currentBusiness, resolveSlug } from "@bodhchakra/tenancy";
import { businessProfile, listCatalogue } from "./business-profile.ts";

export interface PublicPage {
  readonly name: string;
  readonly city: string;
  /** E.164. */
  readonly phone: string;
  readonly about: string;
  readonly serviceArea: string;
  readonly services: readonly { id: string; name: string; unit: string; price: Money }[];
}

/** The page for a slug, or null if no business has it or it has not finished onboarding (nothing to show yet). */
export async function publicPage(db: Db, slug: string): Promise<PublicPage | null> {
  const businessId = await db.tx((client) => resolveSlug(client, slug));
  if (!businessId) return null;
  return db.withTenant(businessId, async (client) => {
    const profile = await businessProfile(client);
    if (!profile) return null;
    const business = await currentBusiness(client);
    const items = await listCatalogue(client);
    return {
      name: business.name,
      city: business.city,
      phone: business.phone,
      about: profile.about,
      serviceArea: profile.serviceArea,
      // Hidden items are not offered; their price is the owner's business until they are shown again.
      services: items
        .filter((item) => item.active)
        .map(({ id, name, unit, unitPriceMinor }) => ({
          id,
          name,
          unit,
          price: money(unitPriceMinor, business.currency),
        })),
    };
  });
}
