import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Db, type DbClient, type TestDb, testDb } from "../src/index.ts";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";

const labels = async (client: DbClient) =>
  (await client.query<{ label: string }>("select label from fx.item order by label")).rows.map(
    (r) => r.label,
  );

describe("withTenant", () => {
  let database: TestDb;
  let app: Db;
  beforeAll(async () => {
    database = await testDb({
      owner: "kaamkoti_owner",
      folders: [{ name: "items", dir: new URL("./migrations/items/", import.meta.url) }],
    });
    await database
      .connect("kaamkoti_owner")
      .tx((client) =>
        client.query(
          `insert into fx.item (business_id, label) values ($1, 'a1'), ($1, 'a2'), ($2, 'b1')`,
          [A, B],
        ),
      );
    app = database.connect("kaamkoti_app");
  });
  afterAll(() => database.drop());

  it("sees only the business's own rows", async () => {
    expect(await app.withTenant(A, labels)).toEqual(["a1", "a2"]);
    expect(await app.withTenant(B, labels)).toEqual(["b1"]);
  });

  it("sees no rows without a tenant", async () => {
    expect(await app.tx(labels)).toEqual([]);
  });

  it("refuses an insert for another business", async () => {
    await expect(
      app.withTenant(A, (client) =>
        client.query(`insert into fx.item (business_id, label) values ($1, 'x')`, [B]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("refuses an insert without a tenant", async () => {
    await expect(
      app.tx((client) =>
        client.query(`insert into fx.item (business_id, label) values ($1, 'x')`, [A]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("refuses moving a row to another business", async () => {
    await expect(
      app.withTenant(A, (client) =>
        client.query(`update fx.item set business_id = $1 where label = 'a1'`, [B]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("does not carry the tenant into the connection's next transaction", async () => {
    const single = database.connect("kaamkoti_app");
    await single.withTenant(A, labels);
    const setting = await single.tx(
      async (client) =>
        (await client.query("select current_setting('app.business_id', true) as v")).rows[0].v,
    );
    expect(setting ?? "").toBe("");
  });

  it("rejects a business id that is not a uuid", async () => {
    await expect(app.withTenant("", labels)).rejects.toThrow("business id is not a uuid");
  });
});

describe("tx", () => {
  let database: TestDb;
  beforeAll(async () => {
    database = await testDb({ owner: "kaamkoti_owner", folders: [] });
  });
  afterAll(() => database.drop());

  it("rolls back when the work throws, and rethrows the error", async () => {
    const owner = database.connect("kaamkoti_owner");
    await owner.tx((client) => client.query("create table counter (n int)"));

    await expect(
      owner.tx(async (client) => {
        await client.query("insert into counter values (1)");
        throw new Error("work failed");
      }),
    ).rejects.toThrow("work failed");

    expect(
      await owner.tx(
        async (client) => (await client.query("select count(*)::int as n from counter")).rows[0].n,
      ),
    ).toBe(0);
  });
});
