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
  type IntakeInput,
  migrations,
  openJobLink,
  PRIVATE_BUCKET,
  RUNTIME_ROLE,
  readIntakeForm,
  seed,
  submitRequest,
  toE164,
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

/** A valid request to Sharma; each test changes what it is about. */
const request = (change: Partial<IntakeInput> = {}): IntakeInput => ({
  name: "Vikram Patil",
  phone: "98765 43210",
  address: "7 Hill Road, Aundh, Pune",
  latitude: "",
  longitude: "",
  items: [item("AC gas refill")],
  ...change,
});

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

  const submit = (input: IntakeInput, slug = "sharma-cooling", session = VIKRAM) =>
    submitRequest(app, storage, audit, slug, session, input);
  /** A customer row as the owner sees it. */
  const customerRow = async (id: string) =>
    (
      await owner.tx((c) =>
        c.query(
          "select identity_id, name, phone_e164, email, address from kk.customer where id = $1",
          [id],
        ),
      )
    ).rows[0];
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

  it("creates the signed-in person's customer row, the job with its address and a link that opens it", async () => {
    const result = await submit(request({ latitude: "18.5590", longitude: "73.8070" }));
    if (!result.ok) throw new Error(result.error);
    expect(result.number).toBe(3);
    const { rows } = await owner.tx((c) =>
      c.query(
        `select j.source, j.status, j.address, j.latitude, j.longitude, c.identity_id, c.name, c.phone_e164,
                c.email
         from kk.job j join kk.customer c on c.id = j.customer_id where j.id = $1`,
        [result.jobId],
      ),
    );
    expect(rows[0]).toEqual({
      source: "public_form",
      status: "requested",
      address: "7 Hill Road, Aundh, Pune",
      latitude: 18.559,
      longitude: 73.807,
      identity_id: VIKRAM.identityId,
      name: "Vikram Patil",
      phone_e164: "+919876543210",
      email: "vikram@example.test",
    });
    expect(await openJobLink(app, result.secret)).toMatchObject({
      businessName: "Sharma Cooling Services",
      number: 3,
      customerName: "Vikram Patil",
    });
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
    const view = await openJobLink(app, result.secret);
    expect(view?.items.map((i) => [i.title, i.listed])).toEqual([["AC general service", false]]);
    await owner.tx((c) =>
      c.query("update kk.catalogue_item set active = true where id = $1", [GENERAL_SERVICE]),
    );
  });

  it("does not match another business's price-list item", async () => {
    // Kaveri's item, sent to Sharma: only the customer's words.
    const result = await submit(request({ items: [item("Fan installation")] }));
    if (!result.ok) throw new Error(result.error);
    expect((await openJobLink(app, result.secret))?.items[0]?.listed).toBe(false);
  });

  it("keeps each photo with its work item, privately, shown on the customer's link by signed URL", async () => {
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
    const view = await openJobLink(app, result.secret);
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

  it("files a returning customer's request under their own row, kept current with what they typed", async () => {
    const result = await submit(
      request({ name: "Anita D.", phone: "90000 09999", address: "New flat, Baner" }),
      "sharma-cooling",
      ANITA,
    );
    if (!result.ok) throw new Error(result.error);
    expect(await customerOf(result.jobId)).toBe(ANITA_AT_SHARMA);
    expect(await customerRow(ANITA_AT_SHARMA)).toMatchObject({
      name: "Anita D.",
      phone_e164: "+919000009999",
      address: "New flat, Baner",
    });
  });

  it("refuses a mobile on another customer's row, and neither files under it nor changes it", async () => {
    const rahul = await customerRow(RAHUL_AT_SHARMA);
    const before = await sharmaJobs();
    // A newcomer typing Rahul's number, and a known customer changing hers to it.
    for (const session of [newcomer(), ANITA])
      expect(
        await submit(
          request({ name: "Someone Else", phone: RAHUL_PHONE }),
          "sharma-cooling",
          session,
        ),
      ).toEqual({ ok: false, error: "phone_taken" });
    expect(await sharmaJobs()).toBe(before);
    expect(await customerRow(RAHUL_AT_SHARMA)).toEqual(rahul);
    expect((await customerRow(ANITA_AT_SHARMA))?.phone_e164).not.toBe(RAHUL_PHONE);
  });

  it("claims the owner-entered row with the session's verified email instead of making a second", async () => {
    const meera = newcomer("Meera@Example.com");
    const result = await submit(
      request({ name: "Meera K", phone: "90000 08888" }),
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
      [1, 2, 3].map(() => submit(request({ phone: "90000 07777" }), "sharma-cooling", first)),
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

  it("refuses a phone number it cannot read, and an unknown business", async () => {
    expect(await submit(request({ phone: "12345" }))).toEqual({ ok: false, error: "contact" });
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
    form.append("name", "Vikram");
    form.append("phone", "9876543210");
    form.append("address", "Aundh");
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
      name: "Vikram",
      latitude: "18.5",
      longitude: "73.8",
    });
    expect(input.items.map((i) => [i.title, i.details, i.photos.length])).toEqual([
      ["AC service", "Every summer", 0],
      ["Broken wire", "", 1],
    ]);
  });
});
