// The price-list form sends parallel fields (id, name, unit, price, tax, active), one value per row. This is the
// edge: it turns them into validated rows, or one plain message for the owner.
import { type CatalogueRowInput, catalogueRowInput } from "./business-profile.ts";

const FIELDS = ["id", "name", "unit", "price", "tax", "active"] as const;

export type CatalogueFormResult =
  | { readonly ok: true; readonly rows: CatalogueRowInput[] }
  | { readonly ok: false; readonly error: string; readonly typed: Record<string, string>[] };

export function parseCatalogueForm(form: FormData): CatalogueFormResult {
  const columns = FIELDS.map((field) => form.getAll(field).map(String));
  const typed = (columns[0] ?? []).map((_, i) =>
    Object.fromEntries(FIELDS.map((field, c) => [field, columns[c]?.[i] ?? ""])),
  );
  // The last row is the blank "add an item" row; leaving its name empty means nothing was added.
  const entered = typed.filter((row) => row.id || row.name?.trim());
  const rows: CatalogueRowInput[] = [];
  for (const row of entered) {
    const result = catalogueRowInput.safeParse(row);
    if (!result.success) {
      const label = row.name?.trim() || "a new item";
      return {
        ok: false,
        error: `Please check the name, price and tax of "${label}". Prices are numbers like 450 or 450.50.`,
        typed,
      };
    }
    rows.push(result.data);
  }
  return { ok: true, rows };
}
