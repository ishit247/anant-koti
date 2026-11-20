// A trade template: the starting catalogue, intake questions, visit checklist and terms a business copies at
// onboarding (docs/architecture.md 5.3). Global and read-only for the app; written only by seeds, always through
// saveTradeTemplate so invalid JSON never reaches the table.
import type { DbClient } from "@bodhchakra/db";
import { z } from "zod";

const key = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/);
const text = (max: number) => z.string().trim().min(1).max(max);

export const UNITS = ["job", "hour", "unit", "sq_ft", "metre", "visit"] as const;

const catalogueItem = z.strictObject({
  key,
  name: text(120),
  unit: z.enum(UNITS),
  // Minor units (paise). A starting price the owner edits at onboarding; 0 means "owner sets it".
  unitPriceMinor: z.int().min(0).max(100_000_000),
  taxRateBp: z.int().min(0).max(10_000),
});

const intakeQuestion = z.discriminatedUnion("type", [
  z.strictObject({ key, label: text(200), type: z.literal("text"), required: z.boolean() }),
  z.strictObject({ key, label: text(200), type: z.literal("number"), required: z.boolean() }),
  z.strictObject({
    key,
    label: text(200),
    type: z.literal("choice"),
    required: z.boolean(),
    options: z.array(text(80)).min(2).max(12),
  }),
  z.strictObject({ key, label: text(200), type: z.literal("photo"), required: z.boolean() }),
]);

const checklistItem = z.strictObject({ key, label: text(200) });

/** Keys are unique within each list: answers and results are stored under them. */
const unique = (items: readonly { key: string }[]) =>
  new Set(items.map((i) => i.key)).size === items.length;

export const tradeTemplateBody = z.strictObject({
  title: text(80),
  catalogue: z.array(catalogueItem).min(1).max(100).refine(unique, "catalogue keys must be unique"),
  intake: z.array(intakeQuestion).max(20).refine(unique, "intake keys must be unique"),
  checklist: z.array(checklistItem).max(30).refine(unique, "checklist keys must be unique"),
  terms: text(4000),
});
export type TradeTemplateBody = z.infer<typeof tradeTemplateBody>;

export const tradeTemplate = z.strictObject({
  key,
  version: z.int().min(1),
  body: tradeTemplateBody,
});
export type TradeTemplate = z.infer<typeof tradeTemplate>;

/** Inserts or replaces one template version. Throws a ZodError before touching the database if it is invalid. */
export async function saveTradeTemplate(client: DbClient, input: unknown): Promise<TradeTemplate> {
  const template = tradeTemplate.parse(input);
  await client.query(
    `insert into kk.trade_template (key, version, body) values ($1, $2, $3)
     on conflict (key, version) do update set body = excluded.body`,
    [template.key, template.version, JSON.stringify(template.body)],
  );
  return template;
}

/** The newest version of a template, parsed again on read because stored JSON is an edge too. */
export async function latestTradeTemplate(
  client: DbClient,
  templateKey: string,
): Promise<TradeTemplate | null> {
  const { rows } = await client.query<{ key: string; version: number; body: unknown }>(
    "select key, version, body from kk.trade_template where key = $1 order by version desc limit 1",
    [templateKey],
  );
  return rows[0] ? tradeTemplate.parse(rows[0]) : null;
}
