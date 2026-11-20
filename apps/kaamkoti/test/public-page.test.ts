import { type Db, type TestDb, testDb } from "@bodhchakra/db";
import { createLogger } from "@bodhchakra/log";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrations, publicPage, RUNTIME_ROLE, saveCatalogue, seed } from "../src/index.ts";

const KAVERI = "20000000-0000-4000-8000-000000000002";
const KAVERI_ITEM = "20000000-0000-4000-8000-0000000b0001";

describe("the public business page on the seeded database", () => {
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

  it("shows a business's own name, contact and offered services, found by slug without a session", async () => {
    const page = await publicPage(app, "kaveri-electricals");
    expect(page?.name).toBe("Kaveri Electricals");
    expect(page?.phone).toMatch(/^\+\d+$/);
    expect(page?.services.map((s) => s.name)).toEqual(["Fan installation", "House rewiring"]);
  });

  it("does not show an item the owner has hidden", async () => {
    await app.withTenant(KAVERI, (c) =>
      saveCatalogue(c, KAVERI, [
        {
          id: KAVERI_ITEM,
          name: "Fan installation",
          unit: "unit",
          price: 45000,
          tax: 1800,
          active: false,
        },
      ]),
    );
    const names = (await publicPage(app, "kaveri-electricals"))?.services.map((s) => s.name);
    expect(names).toEqual(["House rewiring"]);
  });

  it("has no page for an unknown slug, or for a business that has not finished onboarding", async () => {
    expect(await publicPage(app, "no-such-business")).toBeNull();
    await owner.tx((c) =>
      c.query(
        "insert into tenancy.business (id, slug, name, phone, city) values ('30000000-0000-4000-8000-000000000003', 'new-co', 'New Co', '+919000000303', 'Delhi')",
      ),
    );
    expect(await publicPage(app, "new-co")).toBeNull();
  });
});
