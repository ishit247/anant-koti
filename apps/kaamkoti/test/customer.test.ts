import { type Db, type DbClient, type TestDb, testDb } from "@bodhchakra/db";
import { createLogger } from "@bodhchakra/log";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrations, RUNTIME_ROLE, seed } from "../src/index.ts";

const SHARMA = "10000000-0000-4000-8000-000000000001";
const KAVERI = "20000000-0000-4000-8000-000000000002";

const names = async (client: DbClient) =>
  (await client.query<{ name: string }>("select name from kk.customer order by name")).rows.map(
    (r) => r.name,
  );

describe("kk.customer on the seeded database", () => {
  let database: TestDb;
  let app: Db;
  beforeAll(async () => {
    database = await testDb({
      owner: "kaamkoti_owner",
      runtimeRole: RUNTIME_ROLE,
      folders: migrations,
    });
    await seed(database.url("kaamkoti_owner"), createLogger({ service: "test" }));
    app = database.connect("kaamkoti_app");
  });
  afterAll(() => database.drop());

  it("shows the runtime role only the current business's customers", async () => {
    expect(await app.withTenant(SHARMA, names)).toEqual([
      "Anita Deshpande",
      "Meera Kulkarni",
      "Rahul Joshi",
    ]);
    expect(await app.withTenant(KAVERI, names)).toEqual([
      "Anita Deshpande",
      "Lakshmi Rao",
      "Suresh Gowda",
    ]);
  });

  it("shows no customers without a business", async () => {
    expect(await app.tx(names)).toEqual([]);
  });

  it("refuses creating a customer for another business", async () => {
    await expect(
      app.withTenant(SHARMA, (client) =>
        client.query(
          `insert into kk.customer (business_id, name, phone_e164) values ($1, 'X', '+919000009999')`,
          [KAVERI],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("refuses deleting a customer", async () => {
    await expect(
      app.withTenant(SHARMA, (client) => client.query("delete from kk.customer")),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
