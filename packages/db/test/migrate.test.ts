import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MigrationFolder, migrate, type TestDb, testDb } from "../src/index.ts";

const folder = (name: string): MigrationFolder => ({
  name,
  dir: new URL(`./migrations/${name}/`, import.meta.url),
});

describe("migrate", () => {
  let database: TestDb;
  beforeEach(async () => {
    database = await testDb({ owner: "kaamkoti_owner", runtimeRole: "kaamkoti_app", folders: [] });
  });
  afterEach(() => database.drop());

  const run = (...names: string[]) =>
    migrate(database.url("kaamkoti_owner"), names.map(folder), { runtimeRole: "kaamkoti_app" });

  const recorded = (db = database.connect("kaamkoti_owner")) =>
    db.tx(async (client) =>
      (await client.query("select name from db.migration order by name")).rows.map((r) => r.name),
    );

  it("applies folders in the order given, recording each file as folder/file", async () => {
    const applied = await run("items", "later");

    expect(applied).toEqual([
      "items/0001_item.sql",
      "items/0002_item_note.sql",
      "later/0001_tag.sql",
    ]);
    expect(await recorded()).toEqual(applied);
  });

  it("applies nothing on a second run", async () => {
    await run("items");

    expect(await run("items", "later")).toEqual(["later/0001_tag.sql"]);
  });

  it("leaves nothing of a failing migration and names it in the error", async () => {
    await expect(run("broken")).rejects.toThrow("migration broken/0002_fails.sql failed");

    expect(await recorded()).toEqual(["broken/0001_ok.sql"]);
    const tables = await database
      .connect("kaamkoti_owner")
      .tx(
        async (client) =>
          (await client.query("select to_regclass('broken_partial') as t")).rows[0].t,
      );
    expect(tables).toBeNull();
  });

  it("refuses a misnamed file before applying anything", async () => {
    await expect(run("items", "misnamed")).rejects.toThrow(
      "misnamed: migration files must be named NNNN_name.sql: 1_bad.sql",
    );

    const exists = await database
      .connect("kaamkoti_owner")
      .tx(async (client) => (await client.query("select to_regclass('fx.item') as t")).rows[0].t);
    expect(exists).toBeNull();
  });

  it("gives migrations the runtime role as db.runtime_role", async () => {
    await run("runtime-role");

    const granted = await database
      .connect("kaamkoti_app")
      .tx(
        async (client) =>
          (await client.query("select has_table_privilege('fx.flag', 'select') as ok")).rows[0].ok,
      );
    expect(granted).toBe(true);
  });

  it("refuses a runtime role that is not a role name", async () => {
    await expect(
      migrate(database.url("kaamkoti_owner"), [], { runtimeRole: "app; drop" }),
    ).rejects.toThrow('"app; drop" is not a role name');
  });
});
