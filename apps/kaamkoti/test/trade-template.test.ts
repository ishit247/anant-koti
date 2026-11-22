import { type Db, type TestDb, testDb } from "@bodhchakra/db";
import { createLogger } from "@bodhchakra/log";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  latestTradeTemplate,
  migrations,
  RUNTIME_ROLE,
  saveTradeTemplate,
  seed,
} from "../src/index.ts";
import { seedTemplates } from "../src/seed-templates.ts";

describe("trade templates", () => {
  let database: TestDb;
  let owner: Db;
  let app: Db;
  beforeAll(async () => {
    database = await testDb({
      owner: "kaamkoti_owner",
      runtimeRole: RUNTIME_ROLE,
      folders: migrations,
    });
    await seed(database.url("kaamkoti_owner"), createLogger({ service: "test" }));
    owner = database.connect("kaamkoti_owner");
    app = database.connect("kaamkoti_app");
  });
  afterAll(() => database.drop());

  const valid = () => structuredClone(seedTemplates[0]!);
  const count = () =>
    owner.tx(async (c) =>
      Number((await c.query("select count(*) from kk.trade_template")).rows[0].count),
    );

  it("seeds a template the app can read back, parsed", async () => {
    const template = await app.tx((c) => latestTradeTemplate(c, "ac_repair"));
    expect(template?.body.title).toBe("AC and appliance repair");
    expect(template?.body.catalogue.length).toBeGreaterThan(0);
  });

  it("rejects invalid template JSON before it is written", async () => {
    const before = await count();
    const noPrice = valid();
    delete (noPrice.body.catalogue[0] as Partial<(typeof noPrice.body.catalogue)[0]>)
      .unitPriceMinor;
    const badUnit = { ...valid(), key: "bad_unit" } as any;
    badUnit.body.catalogue[0].unit = "parsec";
    const dupKeys = { ...valid(), key: "dup_keys" };
    dupKeys.body.checklist = [dupKeys.body.checklist[0]!, dupKeys.body.checklist[0]!];
    const extraField = { ...valid(), key: "extra" } as any;
    extraField.body.surprise = true;
    const oldIntake = { ...valid(), key: "old_intake" } as any;
    oldIntake.body.intake = [];

    for (const input of [noPrice, badUnit, dupKeys, extraField, oldIntake]) {
      await expect(owner.tx((c) => saveTradeTemplate(c, input))).rejects.toThrow();
    }
    expect(await count()).toBe(before);
  });

  it("returns the newest version", async () => {
    const v2 = valid();
    v2.version = 2;
    v2.body.title = "AC repair v2";
    await owner.tx((c) => saveTradeTemplate(c, v2));
    expect((await app.tx((c) => latestTradeTemplate(c, "ac_repair")))?.version).toBe(2);
  });

  it("lets the runtime role read templates but not change them", async () => {
    await expect(
      app.tx((c) => c.query("update kk.trade_template set version = version")),
    ).rejects.toThrow(/permission denied/);
    await expect(app.tx((c) => saveTradeTemplate(c, { ...valid(), key: "mine" }))).rejects.toThrow(
      /permission denied/,
    );
  });
});
