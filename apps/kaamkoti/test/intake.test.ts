// The request form (a signed-in customer, D15) against the seeded database and the development Garage
// (infra/compose.dev.yml).
import { randomUUID } from "node:crypto";
import { createAudit } from "@bodhchakra/audit";
import type { CustomerSession } from "@bodhchakra/auth";
import { type Db, type TestDb, testDb } from "@bodhchakra/db";
import { createLogger } from "@bodhchakra/log";
import { createStorage } from "@bodhchakra/storage";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addAddress,
  addressBook,
  customerFor,
  customerRequest,
  deleteAddress,
  type IntakeInput,
  migrations,
  type Place,
  PRIVATE_BUCKET,
  RUNTIME_ROLE,
  readIntakeForm,
  type SpaceCustomer,
  seed,
  submitRequest,
  toE164,
  updateAddress,
  type WorkItemInput,
} from "../src/index.ts";

const SHARMA = "10000000-0000-4000-8000-000000000001";
const GAS_REFILL = "10000000-0000-4000-8000-0000000b0002";
const GENERAL_SERVICE = "10000000-0000-4000-8000-0000000b0003";
/** Seeded Sharma customers: Anita signs in (services/platform/seed.sql); Rahul and Meera were entered by the owner. */
const ANITA: CustomerSession = {
  identityId: "00000000-0000-4000-8000-00000000d005",
  email: "anita@example.com",
};
const ANITA_AT_SHARMA = "10000000-0000-4000-8000-0000000c0001";
const RAHUL_AT_SHARMA = "10000000-0000-4000-8000-0000000c0002";
const RAHUL_PHONE = "+919000001002";
const MEERA_AT_SHARMA = "10000000-0000-4000-8000-0000000c0003";

/** Someone signing in for the first time: an identity no customer row names yet. */
const newcomer = (email = `${randomUUID()}@example.test`): CustomerSession => ({
  identityId: randomUUID(),
  email,
});
/** The person most tests send as. */
const VIKRAM = newcomer("vikram@example.test");

const storage = createStorage({
  endpoint: "http://127.0.0.1:45447",
  publicEndpoint: "http://127.0.0.1:45447",
  region: "garage",
  // DEV key from apps/kaamkoti/.env.development, public in the repository.
  accessKeyId: "GK6b61616d6b6f74692d776562",
  secretAccessKey: "6b61616d6b6f74692d7765622d6465762d6f6e6c792d6e6f742d736563726574",
  bucket: PRIVATE_BUCKET,
});

const jpeg = () =>
  sharp({ create: { width: 40, height: 30, channels: 3, background: "#1d6fa5" } })
    .jpeg()
    .toBuffer();

const item = (title: string, change: Partial<WorkItemInput> = {}): WorkItemInput => ({
  title,
  details: "",
  photos: [],
  ...change,
});

/** A valid request to Sharma, at a typed place not saved; each test changes what it is about. */
const request = (change: Partial<IntakeInput> = {}): IntakeInput => ({
  addressId: "",
  contactName: "Vikram Patil",
  contactPhone: "98765 43210",
  address: "7 Hill Road, Aundh, Pune",
  latitude: "",
  longitude: "",
  saveAddress: false,
  label: "",
  items: [item("AC gas refill")],
  ...change,
});

/** Seeded address books (seed.sql): Anita's Home and her parents' house, Rahul's Home; Suresh's at Kaveri. */
const ANITA_PARENTS = "10000000-0000-4000-8000-000000110002";
const RAHUL_HOME = "10000000-0000-4000-8000-000000110003";
const SURESH_HOME_AT_KAVERI = "20000000-0000-4000-8000-000000110001";

describe("the request form", () => {
  let database: TestDb;
  let app: Db;
  let owner: Db;
  const log = createLogger({ service: "test", write: () => undefined });
  const audit = createAudit(log);
  beforeAll(async () => {
    database = await testDb({
      owner: "kaamkoti_owner",
      runtimeRole: RUNTIME_ROLE,
      folders: migrations,
    });
    await seed(database.url("kaamkoti_owner"), log);
    app = database.connect("kaamkoti_app");
    owner = database.connect("kaamkoti_owner");
  });
  afterAll(() => database.drop());

  // The notices a request queues are tested in notices.test.ts.
  const notices = { requestReceived: async () => {} };
  const submit = (input: IntakeInput, slug = "sharma-cooling", session = VIKRAM) =>
    submitRequest(app, storage, audit, notices, slug, session, input);
  /** A request as its sender sees it on their own request page at Sharma. */
  const ownRequest = (jobId: string, session = VIKRAM) =>
    app.withTenant(SHARMA, async (c) => {
      const me = await customerFor(c, audit, session);
      if (!me) throw new Error("the sender has no customer row");
      return customerRequest(c, me, jobId);
    });
  /** A customer row as the owner sees it. */
  const customerRow = async (id: string) =>
    (
      await owner.tx((c) =>
        c.query("select identity_id, name, phone_e164, email from kk.customer where id = $1", [id]),
      )
    ).rows[0];
  /** The contact and place a job was sent with. */
  const jobPlace = async (jobId: string) =>
    (
      await owner.tx((c) =>
        c.query(
          `select contact_name, contact_phone_e164, address, latitude, longitude
           from kk.job where id = $1`,
          [jobId],
        ),
      )
    ).rows[0];
  const bookOf = async (customerId: string) =>
    (
      await owner.tx((c) =>
        c.query(
          `select label, contact_name, contact_phone_e164, address from kk.customer_address
           where customer_id = $1 order by last_used_at desc`,
          [customerId],
        ),
      )
    ).rows;
  const customerOf = async (jobId: string) =>
    (
      await owner.tx((c) =>
        c.query<{ customer_id: string }>("select customer_id from kk.job where id = $1", [jobId]),
      )
    ).rows[0]?.customer_id;
  const sharmaJobs = async () =>
    Number(
      (
        await owner.tx((c) =>
          c.query("select count(*) from kk.job where business_id = $1", [SHARMA]),
        )
      ).rows[0].count,
    );

  it("creates the signed-in person's customer row from their first place, and the job with its own copy, on their page", async () => {
    const result = await submit(request({ latitude: "18.5590", longitude: "73.8070" }));
    if (!result.ok) throw new Error(result.error);
    expect(result.number).toBe(3);
    const { rows } = await owner.tx((c) =>
      c.query(
        `select j.source, j.status, j.contact_name, j.contact_phone_e164, j.address, j.latitude, j.longitude,
                c.identity_id, c.name, c.phone_e164, c.email
         from kk.job j join kk.customer c on c.id = j.customer_id where j.id = $1`,
        [result.jobId],
      ),
    );
    expect(rows[0]).toEqual({
      source: "public_form",
      status: "requested",
      contact_name: "Vikram Patil",
      contact_phone_e164: "+919876543210",
      address: "7 Hill Road, Aundh, Pune",
      latitude: 18.559,
      longitude: 73.807,
      identity_id: VIKRAM.identityId,
      name: "Vikram Patil",
      phone_e164: "+919876543210",
      email: "vikram@example.test",
    });
    expect(await ownRequest(result.jobId)).toMatchObject({ number: 3, status: "requested" });
  });

  it("makes each work item a task in the order sent; a price-list name is that item, any other the customer's own", async () => {
    const result = await submit(
      request({
        items: [
          item("Broken wire", { details: "  Cut near the window.  " }),
          // Case and spacing do not hide a price-list item.
          item("  ac   GENERAL service "),
          item("AC gas refill"),
        ],
      }),
    );
    if (!result.ok) throw new Error(result.error);
    const { rows } = await owner.tx((c) =>
      c.query(
        `select catalogue_item_id, title, details, added_by from kk.job_task
         where job_id = $1 order by added_at, id`,
        [result.jobId],
      ),
    );
    expect(rows).toEqual([
      {
        catalogue_item_id: null,
        title: "Broken wire",
        details: "Cut near the window.",
        added_by: "customer",
      },
      {
        catalogue_item_id: GENERAL_SERVICE,
        title: "AC general service",
        details: null,
        added_by: "customer",
      },
      {
        catalogue_item_id: GAS_REFILL,
        title: "AC gas refill",
        details: null,
        added_by: "customer",
      },
    ]);
  });

  it("takes a hidden item's name as the customer's own words, priced by the business", async () => {
    await owner.tx((c) =>
      c.query("update kk.catalogue_item set active = false where id = $1", [GENERAL_SERVICE]),
    );
    const result = await submit(request({ items: [item("AC general service")] }));
    if (!result.ok) throw new Error(result.error);
    const view = await ownRequest(result.jobId);
    expect(view?.items.map((i) => [i.title, i.listed])).toEqual([["AC general service", false]]);
    await owner.tx((c) =>
      c.query("update kk.catalogue_item set active = true where id = $1", [GENERAL_SERVICE]),
    );
  });

  it("does not match another business's price-list item", async () => {
    // Kaveri's item, sent to Sharma: only the customer's words.
    const result = await submit(request({ items: [item("Fan installation")] }));
    if (!result.ok) throw new Error(result.error);
    expect((await ownRequest(result.jobId))?.items[0]?.listed).toBe(false);
  });

  it("keeps each photo with its work item, privately, shown on the customer's page by signed URL", async () => {
    const result = await submit(
      request({
        items: [
          item("AC gas refill", { photos: [await jpeg()] }),
          item("Broken wire"),
          item("Water leak", { photos: [await jpeg(), await jpeg()] }),
        ],
      }),
    );
    if (!result.ok) throw new Error(result.error);
    const view = await ownRequest(result.jobId);
    expect(view?.items.map((i) => i.photos.length)).toEqual([1, 0, 2]);
    const first = view?.items[0]?.photos[0];
    if (!first) throw new Error("no photo");
    expect((await fetch(storage.signedUrl(first))).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:45447/${PRIVATE_BUCKET}/${first.key}`)).status).toBe(403);
  });

  it("refuses a customer's photo without a work item, in the database", async () => {
    await expect(
      owner.tx((c) =>
        c.query(
          `insert into kk.job_photo (business_id, job_id, object_id, kind)
           select business_id, job_id, object_id, 'request' from kk.job_photo limit 1`,
        ),
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it("saves a first place as the customer's first address when asked", async () => {
    const first = newcomer();
    const result = await submit(
      request({
        contactName: "Asha P",
        contactPhone: "90000 06666",
        saveAddress: true,
        label: " Home ",
      }),
      "sharma-cooling",
      first,
    );
    if (!result.ok) throw new Error(result.error);
    const customer = await customerOf(result.jobId);
    if (!customer) throw new Error("no customer");
    expect(await bookOf(customer)).toEqual([
      {
        label: "Home",
        contact_name: "Asha P",
        contact_phone_e164: "+919000006666",
        address: "7 Hill Road, Aundh, Pune",
      },
    ]);
  });

  it("sends a returning customer's request to a saved address, copying its contact, and leaves their own details", async () => {
    const anita = await customerRow(ANITA_AT_SHARMA);
    const result = await submit(
      // The typed fields are ignored when a saved address is chosen.
      request({ addressId: ANITA_PARENTS, contactName: "Ignored", contactPhone: "12" }),
      "sharma-cooling",
      ANITA,
    );
    if (!result.ok) throw new Error(result.error);
    expect(await customerOf(result.jobId)).toBe(ANITA_AT_SHARMA);
    expect(await jobPlace(result.jobId)).toEqual({
      contact_name: "Vasant Deshpande",
      contact_phone_e164: "+919000001011",
      address: "22 Prabhat Road, Erandwane, Pune",
      latitude: null,
      longitude: null,
    });
    expect(await customerRow(ANITA_AT_SHARMA)).toEqual(anita);
    // Last used now, so the form preselects it next time.
    expect((await bookOf(ANITA_AT_SHARMA))[0]?.contact_name).toBe("Vasant Deshpande");
  });

  it("accepts a job for anyone's mobile, even one on another customer's row, and changes no customer", async () => {
    const [anita, rahul] = [await customerRow(ANITA_AT_SHARMA), await customerRow(RAHUL_AT_SHARMA)];
    const result = await submit(
      request({ contactName: "Rahul at the shop", contactPhone: RAHUL_PHONE }),
      "sharma-cooling",
      ANITA,
    );
    if (!result.ok) throw new Error(result.error);
    expect(await customerOf(result.jobId)).toBe(ANITA_AT_SHARMA);
    expect((await jobPlace(result.jobId))?.contact_phone_e164).toBe(RAHUL_PHONE);
    expect(await customerRow(ANITA_AT_SHARMA)).toEqual(anita);
    expect(await customerRow(RAHUL_AT_SHARMA)).toEqual(rahul);
  });

  it.each([
    ["another customer's address", ANITA, RAHUL_HOME],
    ["another business's address", ANITA, SURESH_HOME_AT_KAVERI],
    ["an id that is not one", ANITA, "home"],
    ["any address from someone with no customer row yet", newcomer(), ANITA_PARENTS],
  ])("refuses %s, and writes nothing", async (_, session, addressId) => {
    const before = await sharmaJobs();
    const rahulBook = await bookOf(RAHUL_AT_SHARMA);
    expect(await submit(request({ addressId }), "sharma-cooling", session)).toEqual({
      ok: false,
      error: "address",
    });
    expect(await sharmaJobs()).toBe(before);
    expect(await bookOf(RAHUL_AT_SHARMA)).toEqual(rahulBook);
  });

  it("keeps a sent job's contact and address after the saved address is edited, then deleted", async () => {
    const customer: SpaceCustomer = { id: ANITA_AT_SHARMA, businessId: SHARMA };
    const shop: Place = {
      contactName: "Ravi",
      contactPhone: "+919000001099",
      address: "Shop 3, Laxmi Road, Pune",
      location: null,
    };
    await app.withTenant(SHARMA, (c) => addAddress(c, customer, "Shop", shop));
    const [saved] = await app.withTenant(SHARMA, (c) => addressBook(c, customer));
    if (saved?.label !== "Shop") throw new Error("the shop was not saved first");
    const result = await submit(request({ addressId: saved.id }), "sharma-cooling", ANITA);
    if (!result.ok) throw new Error(result.error);
    const sent = await jobPlace(result.jobId);

    await app.withTenant(SHARMA, (c) =>
      updateAddress(c, customer, saved.id, "Shop", { ...shop, contactName: "Someone new" }),
    );
    expect(await jobPlace(result.jobId)).toEqual(sent);
    expect(await app.withTenant(SHARMA, (c) => deleteAddress(c, customer, saved.id))).toBe(true);
    expect(await jobPlace(result.jobId)).toEqual(sent);
  });

  it("refuses a first request with a mobile on another customer's row, and neither files under it nor changes it", async () => {
    const rahul = await customerRow(RAHUL_AT_SHARMA);
    const before = await sharmaJobs();
    expect(
      await submit(
        request({ contactName: "Someone Else", contactPhone: RAHUL_PHONE }),
        "sharma-cooling",
        newcomer(),
      ),
    ).toEqual({ ok: false, error: "phone_taken" });
    expect(await sharmaJobs()).toBe(before);
    expect(await customerRow(RAHUL_AT_SHARMA)).toEqual(rahul);
  });

  it("claims the owner-entered row with the session's verified email instead of making a second", async () => {
    const meera = newcomer("Meera@Example.com");
    const result = await submit(
      request({ contactName: "Meera K", contactPhone: "90000 08888" }),
      "sharma-cooling",
      meera,
    );
    if (!result.ok) throw new Error(result.error);
    expect(await customerOf(result.jobId)).toBe(MEERA_AT_SHARMA);
    expect((await customerRow(MEERA_AT_SHARMA))?.identity_id).toBe(meera.identityId);
  });

  it("keeps one customer row per person when their first requests arrive together, numbered apart", async () => {
    const first = newcomer();
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        submit(request({ contactPhone: "90000 07777" }), "sharma-cooling", first),
      ),
    );
    const numbers = results.map((r) => (r.ok ? r.number : r.error));
    expect(new Set(numbers).size).toBe(3);
    const ids = await Promise.all(results.map((r) => (r.ok ? customerOf(r.jobId) : r.error)));
    expect(new Set(ids).size).toBe(1);
  });

  it.each([
    ["no work item", { items: [] }],
    ["a work item without a title", { items: [item("AC gas refill"), item("   ")] }],
    ["a title over 120 characters", { items: [item("x".repeat(121))] }],
    ["details over 1000 characters", { items: [item("Leak", { details: "x".repeat(1001) })] }],
    ["more than 20 work items", { items: Array.from({ length: 21 }, () => item("Leak")) }],
  ])("refuses %s, and writes nothing", async (_, change) => {
    const before = await sharmaJobs();
    expect(await submit(request(change))).toEqual({ ok: false, error: "items" });
    expect(await sharmaJobs()).toBe(before);
  });

  it.each([
    ["only a latitude", { latitude: "18.5", longitude: "" }],
    ["a latitude past the pole", { latitude: "91", longitude: "73.8" }],
    ["a longitude that is not a number", { latitude: "18.5", longitude: "east" }],
  ])("refuses %s as the location", async (_, change) => {
    expect(await submit(request(change))).toEqual({ ok: false, error: "location" });
  });

  it("refuses a file that is not an image, and more than six photos across the work items", async () => {
    expect(
      await submit(request({ items: [item("Leak", { photos: [Buffer.from("not a photo")] })] })),
    ).toEqual({ ok: false, error: "photo_not_an_image" });
    const four = Array.from({ length: 4 }, () => Buffer.alloc(1));
    expect(
      await submit(
        request({ items: [item("Leak", { photos: four }), item("Wire", { photos: four })] }),
      ),
    ).toEqual({ ok: false, error: "too_many_photos" });
  });

  it("refuses a phone number it cannot read, a place to save without a label, and an unknown business", async () => {
    expect(await submit(request({ contactPhone: "12345" }))).toEqual({
      ok: false,
      error: "contact",
    });
    expect(await submit(request({ saveAddress: true, label: "  " }))).toEqual({
      ok: false,
      error: "contact",
    });
    expect(await submit(request(), "no-such-business")).toEqual({ ok: false, error: "not_found" });
  });
});

describe("toE164", () => {
  it.each([
    ["98765 43210", "+919876543210"],
    ["098765-43210", "+919876543210"],
    ["+91 98765 43210", "+919876543210"],
    ["919876543210", "+919876543210"],
    ["+44 7700 900123", "+447700900123"],
  ])("reads %s as %s", (typed, e164) => {
    expect(toE164(typed)).toBe(e164);
  });
});

describe("readIntakeForm", () => {
  it("reads the page's field names, items in the order of their number, skipping empty files and items", async () => {
    const form = new FormData();
    form.append("addressId", "");
    form.append("contactName", "Vikram");
    form.append("contactPhone", "9876543210");
    form.append("address", "Aundh");
    form.append("saveAddress", "on");
    form.append("label", "Home");
    form.append("latitude", "18.5");
    form.append("longitude", "73.8");
    form.append("item.10.title", "Broken wire");
    form.append("item.10.photo", new File([await jpeg()], "wire.jpg"));
    form.append("item.10.photo", new File([], ""));
    form.append("item.2.title", "AC service");
    form.append("item.2.details", "Every summer");
    form.append("item.3.title", "");
    form.append("item.3.photo", new File([], ""));
    form.append("item.x.title", "ignored");
    const input = await readIntakeForm(form);
    expect(input).toMatchObject({
      addressId: "",
      contactName: "Vikram",
      saveAddress: true,
      label: "Home",
      latitude: "18.5",
      longitude: "73.8",
    });
    expect(input.items.map((i) => [i.title, i.details, i.photos.length])).toEqual([
      ["AC service", "Every summer", 0],
      ["Broken wire", "", 1],
    ]);
  });
});
