// A business's own profile and price list (docs/architecture.md 5.3). Every function runs inside withTenant, so row-level
// security supplies the business; business_id is passed only where an insert has to name it.
import type { DbClient } from "@bodhchakra/db";
import { parseDecimal } from "@bodhchakra/money";
import { z } from "zod";
import { checklistItem, latestTradeTemplate, UNITS } from "./trade-template.ts";

const profileRow = z.strictObject({
  trade_key: z.string(),
  about: z.string(),
  service_area: z.string(),
  checklist: z.array(checklistItem),
  terms: z.string(),
});

export interface BusinessProfile {
  readonly tradeKey: string;
  readonly about: string;
  readonly serviceArea: string;
  readonly checklist: z.infer<typeof profileRow>["checklist"];
  readonly terms: string;
}

/** The current business's profile, or null before onboarding. Stored JSON is parsed again on read. */
export async function businessProfile(client: DbClient): Promise<BusinessProfile | null> {
  const { rows } = await client.query(
    "select trade_key, about, service_area, checklist, terms from kk.business_profile",
  );
  if (!rows[0]) return null;
  const row = profileRow.parse(rows[0]);
  return {
    tradeKey: row.trade_key,
    about: row.about,
    serviceArea: row.service_area,
    checklist: row.checklist,
    terms: row.terms,
  };
}

/** Copies the newest version of a template into the business's profile and price list. Fails if it already has one. */
export async function startFromTemplate(
  client: DbClient,
  businessId: string,
  templateKey: string,
): Promise<void> {
  const template = await latestTradeTemplate(client, templateKey);
  if (!template) throw new Error(`No trade template "${templateKey}"`);
  const { body } = template;
  await client.query(
    `insert into kk.business_profile (business_id, trade_key, checklist, terms)
     values ($1, $2, $3, $4)`,
    [businessId, template.key, JSON.stringify(body.checklist), body.terms],
  );
  for (const [position, item] of body.catalogue.entries()) {
    await client.query(
      `insert into kk.catalogue_item (business_id, name, unit, unit_price_minor, tax_rate_bp, position)
       values ($1, $2, $3, $4, $5, $6)`,
      [businessId, item.name, item.unit, item.unitPriceMinor, item.taxRateBp, position],
    );
  }
}

export interface CatalogueItem {
  readonly id: string;
  readonly name: string;
  readonly unit: (typeof UNITS)[number];
  readonly unitPriceMinor: number;
  readonly taxRateBp: number;
  readonly active: boolean;
}

export async function listCatalogue(client: DbClient): Promise<CatalogueItem[]> {
  const { rows } = await client.query<{
    id: string;
    name: string;
    unit: CatalogueItem["unit"];
    unit_price_minor: string;
    tax_rate_bp: number;
    active: boolean;
  }>(
    `select id, name, unit, unit_price_minor, tax_rate_bp, active
       from kk.catalogue_item order by position, created_at`,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    unit: r.unit,
    unitPriceMinor: Number(r.unit_price_minor),
    taxRateBp: r.tax_rate_bp,
    active: r.active,
  }));
}

/** Text with at most two decimals, as whole hundredths: "1250.5" is 125050. Never goes through floating point. */
function hundredths(max: number) {
  return z
    .string()
    .transform((text, ctx) => {
      const value = parseDecimal(text, 2);
      if (value === null) {
        ctx.addIssue({ code: "custom", message: "not a number with at most two decimals" });
        return z.NEVER;
      }
      return value;
    })
    .pipe(z.int().max(max));
}

/** What the price-list form sends for one row; an empty `id` is a new item. */
export const catalogueRowInput = z.strictObject({
  id: z.union([z.literal(""), z.uuid()]),
  name: z.string().trim().min(1).max(120),
  unit: z.enum(UNITS),
  // Rupees and percent as typed; stored as paise and basis points (both are hundredths).
  price: hundredths(100_000_000),
  tax: hundredths(10_000),
  active: z.enum(["yes", "no"]).transform((v) => v === "yes"),
});
export type CatalogueRowInput = z.infer<typeof catalogueRowInput>;

/** Updates the rows that have an id and appends the ones that do not. An id from another business matches nothing. */
export async function saveCatalogue(
  client: DbClient,
  businessId: string,
  rows: readonly CatalogueRowInput[],
): Promise<void> {
  for (const row of rows) {
    if (row.id) {
      const { rowCount } = await client.query(
        `update kk.catalogue_item
            set name = $2, unit = $3, unit_price_minor = $4, tax_rate_bp = $5, active = $6
          where id = $1`,
        [row.id, row.name, row.unit, row.price, row.tax, row.active],
      );
      if (rowCount !== 1) throw new Error("Price list item not found");
    } else {
      await client.query(
        `insert into kk.catalogue_item (business_id, name, unit, unit_price_minor, tax_rate_bp, active, position)
         values ($1, $2, $3, $4, $5, $6,
                 (select coalesce(max(position) + 1, 0) from kk.catalogue_item))`,
        [businessId, row.name, row.unit, row.price, row.tax, row.active],
      );
    }
  }
}
