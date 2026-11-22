import { type Db, type TestDb, testDb } from "@bodhchakra/db";
import { createLogger } from "@bodhchakra/log";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseCatalogueForm } from "../src/catalogue-form.ts";
import {
  businessProfile,
  catalogueRowInput,
  listCatalogue,
  migrations,
  RUNTIME_ROLE,
  saveCatalogue,
  seed,
  startFromTemplate,
} from "../src/index.ts";

const SHARMA = "10000000-0000-4000-8000-000000000001";
const KAVERI = "20000000-0000-4000-8000-000000000002";
const KAVERI_ITEM = "20000000-0000-4000-8000-0000000b0001";

const row = (over: Record<string, string> = {}) => ({
  id: "",
  name: "Fan repair",
  unit: "unit",
  price: "450.5",
  tax: "18",
  active: "yes",
  ...over,
});
const formOf = (rows: Record<string, string>[]) => {
  const form = new FormData();
  for (const r of rows) for (const [k, v] of Object.entries(r)) form.append(k, v);
  return form;
};

describe("the price list form", () => {
  it("turns rupees and percent into paise and basis points without floating point", () => {
    const parsed = catalogueRowInput.parse(row({ price: "1250.5", tax: "12.5" }));
    expect(parsed.price).toBe(125050);
    expect(parsed.tax).toBe(1250);
  });

  it("ignores a blank add-an-item row and rejects a bad price with a message", () => {
    expect(parseCatalogueForm(formOf([row({ name: "" })]))).toMatchObject({ ok: true, rows: [] });
    const bad = parseCatalogueForm(formOf([row({ price: "12.345" })]));
    expect(bad.ok).toBe(false);
  });
});

describe("business profile and catalogue on the seeded database", () => {
  let database: TestDb;
  let app: Db;
  let owner: Db;
  beforeAll(async () => {
    database = await testDb({
      owner: "kaamkoti_owner",
      runtimeRole: RUNTIME_ROLE,
      folders: migrations,
    });
    await seed(database.url("kaamkoti_owner"), createLogger({ service: "test" }));
    app = database.connect("kaamkoti_app");
    owner = database.connect("kaamkoti_owner");
  });
  afterAll(() => database.drop());

  it("starts a new business from a template: profile and price list copied", async () => {
    const fresh = "30000000-0000-4000-8000-000000000003";
    await owner.tx((c) =>
      c.query(
        "insert into tenancy.business (id, slug, name, phone, city) values ($1, 'fresh-co', 'Fresh Co', '+919000000303', 'Delhi')",
        [fresh],
      ),
    );
    expect(await app.withTenant(fresh, businessProfile)).toBeNull();

    await app.withTenant(fresh, (c) => startFromTemplate(c, fresh, "ac_repair"));

    const profile = await app.withTenant(fresh, businessProfile);
    expect(profile?.tradeKey).toBe("ac_repair");
    expect(profile?.checklist.length).toBeGreaterThan(0);
    const items = await app.withTenant(fresh, listCatalogue);
    expect(items.map((i) => i.name)).toContain("AC gas refill");
    await expect(
      app.withTenant(fresh, (c) => startFromTemplate(c, fresh, "ac_repair")),
    ).rejects.toThrow();
  });

  it("keeps each business's profile and prices to itself", async () => {
    expect((await app.withTenant(SHARMA, businessProfile))?.tradeKey).toBe("ac_repair");
    expect((await app.withTenant(KAVERI, businessProfile))?.tradeKey).toBe("electrician");
    const names = (await app.withTenant(KAVERI, listCatalogue)).map((i) => i.name);
    expect(names).toEqual(["Fan installation", "House rewiring"]);
    expect(await app.tx(listCatalogue)).toEqual([]);
  });

  it("updates an item and appends a new one at the end", async () => {
    await app.withTenant(KAVERI, (c) =>
      saveCatalogue(c, KAVERI, [
        catalogueRowInput.parse(
          row({ id: KAVERI_ITEM, name: "Fan installation", price: "500", active: "no" }),
        ),
        catalogueRowInput.parse(row({ name: "Switch repair" })),
      ]),
    );
    const items = await app.withTenant(KAVERI, listCatalogue);
    expect(items.map((i) => i.name)).toEqual([
      "Fan installation",
      "House rewiring",
      "Switch repair",
    ]);
    expect(items[0]).toMatchObject({ unitPriceMinor: 50000, active: false });
    expect(items[2]).toMatchObject({ unitPriceMinor: 45050, taxRateBp: 1800 });
  });

  it("cannot edit another business's item by id", async () => {
    await expect(
      app.withTenant(SHARMA, (c) =>
        saveCatalogue(c, SHARMA, [catalogueRowInput.parse(row({ id: KAVERI_ITEM, price: "1" }))]),
      ),
    ).rejects.toThrow("not found");
    const [item] = await app.withTenant(KAVERI, listCatalogue);
    expect(item?.unitPriceMinor).not.toBe(100);
  });

  it("cannot delete a price list item", async () => {
    await expect(
      app.withTenant(KAVERI, (c) => c.query("delete from kk.catalogue_item")),
    ).rejects.toThrow(/permission denied/);
  });
});
