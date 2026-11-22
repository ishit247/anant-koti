// The customer's address book and own details (Profile, D15) against the seeded database: only the customer's
// own rows are read or written, at most 10 addresses, and the mobile on their own row stays theirs alone.
import { type Db, type TestDb, testDb } from "@bodhchakra/db";
import { createLogger } from "@bodhchakra/log";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addAddress,
  addressBook,
  deleteAddress,
  MAX_ADDRESSES,
  migrations,
  type Place,
  RUNTIME_ROLE,
  type SpaceCustomer,
  seed,
  updateAddress,
  updateOwnDetails,
} from "../src/index.ts";

const SHARMA = "10000000-0000-4000-8000-000000000001";
const KAVERI = "20000000-0000-4000-8000-000000000002";
const ANITA: SpaceCustomer = { id: "10000000-0000-4000-8000-0000000c0001", businessId: SHARMA };
const RAHUL: SpaceCustomer = { id: "10000000-0000-4000-8000-0000000c0002", businessId: SHARMA };
const MEERA: SpaceCustomer = { id: "10000000-0000-4000-8000-0000000c0003", businessId: SHARMA };
const SURESH_AT_KAVERI: SpaceCustomer = {
  id: "20000000-0000-4000-8000-0000000c0001",
  businessId: KAVERI,
};
const RAHUL_HOME = "10000000-0000-4000-8000-000000110003";
const SURESH_HOME_AT_KAVERI = "20000000-0000-4000-8000-000000110001";

const place = (address: string): Place => ({
  contactName: "Someone",
  contactPhone: "+919000001234",
  address,
  location: null,
});

describe("the address book", () => {
  let database: TestDb;
  let app: Db;
  let owner: Db;
  const log = createLogger({ service: "test", write: () => undefined });
  beforeAll(async () => {
    database = await testDb({
      owner: "kaamkoti_owner",
      runtimeRole: RUNTIME_ROLE,
      folders: migrations,
    });
    await seed(database.url("kaamkoti_owner"), log);
    app = database.connect(RUNTIME_ROLE);
    owner = database.connect("kaamkoti_owner");
  });
  afterAll(() => database.drop());

  const addressRow = async (id: string) =>
    (
      await owner.tx((c) =>
        c.query("select label, contact_name, address from kk.customer_address where id = $1", [id]),
      )
    ).rows[0];

  it("lists only the customer's own addresses, the most recently used first", async () => {
    const book = await app.withTenant(SHARMA, (c) => addressBook(c, ANITA));
    expect(book.map((a) => [a.label, a.contactName])).toEqual([
      ["Home", "Anita Deshpande"],
      ["Parents", "Vasant Deshpande"],
    ]);
    expect(book[0]?.location).toEqual({ latitude: 18.5074, longitude: 73.8077 });
  });

  it("changes and deletes nothing of another customer's or another business's, by id", async () => {
    const [rahul, suresh] = [await addressRow(RAHUL_HOME), await addressRow(SURESH_HOME_AT_KAVERI)];
    for (const id of [RAHUL_HOME, SURESH_HOME_AT_KAVERI, "not-an-id"]) {
      expect(
        await app.withTenant(SHARMA, (c) => updateAddress(c, ANITA, id, "Mine", place("Taken"))),
      ).toBe(false);
      expect(await app.withTenant(SHARMA, (c) => deleteAddress(c, ANITA, id))).toBe(false);
    }
    // Even naming the right customer, Sharma's transaction cannot reach Kaveri's rows (RLS).
    expect(
      await app.withTenant(SHARMA, (c) =>
        deleteAddress(c, SURESH_AT_KAVERI, SURESH_HOME_AT_KAVERI),
      ),
    ).toBe(false);
    expect(await addressRow(RAHUL_HOME)).toEqual(rahul);
    expect(await addressRow(SURESH_HOME_AT_KAVERI)).toEqual(suresh);
  });

  it("changes and deletes the customer's own address", async () => {
    const id = RAHUL_HOME;
    expect(
      await app.withTenant(SHARMA, (c) => updateAddress(c, RAHUL, id, "Flat", place("New flat"))),
    ).toBe(true);
    expect(await addressRow(id)).toEqual({
      label: "Flat",
      contact_name: "Someone",
      address: "New flat",
    });
    expect(await app.withTenant(SHARMA, (c) => deleteAddress(c, RAHUL, id))).toBe(true);
    expect(await addressRow(id)).toBeUndefined();
  });

  it(`holds at most ${MAX_ADDRESSES}, and saving a place already there only marks it used`, async () => {
    const save = (address: string) =>
      app.withTenant(SHARMA, (c) => addAddress(c, MEERA, "Place", place(address)));
    for (let n = 1; n <= MAX_ADDRESSES; n++) expect(await save(`Place ${n}`)).toBe("saved");
    expect(await save("One too many")).toBe("full");
    expect(await save("Place 1")).toBe("saved");
    const book = await app.withTenant(SHARMA, (c) => addressBook(c, MEERA));
    expect(book).toHaveLength(MAX_ADDRESSES);
    expect(book[0]?.address).toBe("Place 1");
  });

  it("lets no two saves at once take the last place", async () => {
    const save = (address: string) =>
      app.withTenant(KAVERI, (c) => addAddress(c, SURESH_AT_KAVERI, "Place", place(address)));
    // Suresh has one (seed.sql); one place is left after these.
    for (let n = 2; n < MAX_ADDRESSES; n++) await save(`Place ${n}`);
    // The first save takes the last place and keeps its transaction open while a second save runs: the second
    // must wait for it, then find the book full.
    let second: Promise<"saved" | "full"> | undefined;
    const first = await app.withTenant(KAVERI, async (c) => {
      const taken = await addAddress(c, SURESH_AT_KAVERI, "Place", place("Last A"));
      second = save("Last B");
      await new Promise((resolve) => setTimeout(resolve, 300));
      return taken;
    });
    expect([first, await second]).toEqual(["saved", "full"]);
    expect(await app.withTenant(KAVERI, (c) => addressBook(c, SURESH_AT_KAVERI))).toHaveLength(
      MAX_ADDRESSES,
    );
  });
});

describe("the customer's own details", () => {
  let database: TestDb;
  let app: Db;
  const log = createLogger({ service: "test", write: () => undefined });
  beforeAll(async () => {
    database = await testDb({
      owner: "kaamkoti_owner",
      runtimeRole: RUNTIME_ROLE,
      folders: migrations,
    });
    await seed(database.url("kaamkoti_owner"), log);
    app = database.connect(RUNTIME_ROLE);
  });
  afterAll(() => database.drop());

  const update = (name: string, phone: string) =>
    app.withTenant(SHARMA, (c) => updateOwnDetails(c, ANITA, { name, phone }));

  it("saves the customer's own name and mobile", async () => {
    expect(await update("Anita D.", "90000 09999")).toBe("saved");
  });

  it("refuses a mobile on another customer's row, and a name left empty", async () => {
    expect(await update("Anita", "+919000001002")).toBe("phone_taken");
    expect(await update("  ", "90000 09999")).toBe("contact");
  });
});
