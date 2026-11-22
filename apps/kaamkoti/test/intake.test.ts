// The public request form against the seeded database and the development Garage (infra/compose.dev.yml).
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
} from "../src/index.ts";

const SHARMA = "10000000-0000-4000-8000-000000000001";
const GAS_REFILL = "10000000-0000-4000-8000-0000000b0002";
const GENERAL_SERVICE = "10000000-0000-4000-8000-0000000b0003";
const INSPECTION = "10000000-0000-4000-8000-0000000b0001";
const KAVERI_FAN = "20000000-0000-4000-8000-0000000b0001";
/** Seeded Sharma customer. */
const ANITA_PHONE = "+919000001001";

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

/** A valid request to Sharma; each test changes what it is about. */
const request = (change: Partial<IntakeInput> = {}): IntakeInput => ({
  tasks: [GAS_REFILL],
  name: "Vikram Patil",
  phone: "98765 43210",
  address: "7 Hill Road, Aundh, Pune",
  preferredWindow: "Saturday morning",
  answers: { appliance: "Split AC", symptom: "Water leaking", age_years: "6" },
  photos: [],
  ...change,
});

describe("the public request form", () => {
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

  const submit = (input: IntakeInput, slug = "sharma-cooling") =>
    submitRequest(app, storage, slug, input);
  const sharmaJobs = async () =>
    Number(
      (
        await owner.tx((c) =>
          c.query("select count(*) from kk.job where business_id = $1", [SHARMA]),
        )
      ).rows[0].count,
    );

  it("creates the customer, the job with its tasks and answers, and a link that opens it", async () => {
    const result = await submit(request({ tasks: [GENERAL_SERVICE, GAS_REFILL] }));
    if (!result.ok) throw new Error(result.error);
    expect(result.number).toBe(3);
    const { rows } = await owner.tx((c) =>
      c.query(
        `select j.source, j.status, j.answers, j.address, j.preferred_window, c.name, c.phone_e164
         from kk.job j join kk.customer c on c.id = j.customer_id where j.id = $1`,
        [result.jobId],
      ),
    );
    expect(rows[0]).toEqual({
      source: "public_form",
      status: "requested",
      answers: { appliance: "Split AC", symptom: "Water leaking", age_years: 6 },
      address: "7 Hill Road, Aundh, Pune",
      preferred_window: "Saturday morning",
      name: "Vikram Patil",
      phone_e164: "+919876543210",
    });
    expect(await openJobLink(app, result.secret)).toMatchObject({
      businessName: "Sharma Cooling Services",
      number: 3,
      customerName: "Vikram Patil",
      // In the business's display order.
      tasks: ["AC gas refill", "AC general service"],
      photos: [],
    });
  });

  it("stores the photos privately, and the customer's link shows them by signed URL", async () => {
    const result = await submit(
      request({
        photos: [
          { question: "photo", bytes: await jpeg() },
          { question: "photo", bytes: await jpeg() },
        ],
      }),
    );
    if (!result.ok) throw new Error(result.error);
    const view = await openJobLink(app, result.secret);
    expect(view?.photos).toHaveLength(2);
    const [first] = view?.photos ?? [];
    if (!first) throw new Error("no photo");
    expect((await fetch(storage.signedUrl(first))).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:45447/${PRIVATE_BUCKET}/${first.key}`)).status).toBe(403);
  });

  it("files a request from a known phone under that customer, without renaming them", async () => {
    const result = await submit(request({ name: "Someone Else", phone: ANITA_PHONE }));
    if (!result.ok) throw new Error(result.error);
    expect(await openJobLink(app, result.secret)).toMatchObject({
      customerName: "Anita Deshpande",
    });
  });

  it("gives concurrent requests to one business different numbers", async () => {
    const results = await Promise.all([1, 2, 3].map(() => submit(request())));
    const numbers = results.map((r) => (r.ok ? r.number : r.error));
    expect(new Set(numbers).size).toBe(3);
  });

  it.each([
    ["no task", { tasks: [] }],
    ["another business's item", { tasks: [KAVERI_FAN] }],
    ["another business's item beside one of its own", { tasks: [GAS_REFILL, KAVERI_FAN] }],
    ["an item that is not an id", { tasks: ["1 or 1=1"] }],
  ])("refuses %s as a task, and writes nothing", async (_, change) => {
    const before = await sharmaJobs();
    expect(await submit(request(change))).toEqual({ ok: false, error: "tasks" });
    expect(await sharmaJobs()).toBe(before);
  });

  it("refuses an item the business has hidden", async () => {
    await owner.tx((c) =>
      c.query("update kk.catalogue_item set active = false where id = $1", [INSPECTION]),
    );
    expect(await submit(request({ tasks: [INSPECTION] }))).toEqual({ ok: false, error: "tasks" });
  });

  it.each([
    ["a missing required answer", { answers: { appliance: "Split AC" } }],
    [
      "a choice the question does not offer",
      { answers: { appliance: "Jet engine", symptom: "Not cooling" } },
    ],
    [
      "a number that is not one",
      { answers: { appliance: "Split AC", symptom: "Not cooling", age_years: "old" } },
    ],
  ])("refuses %s", async (_, change) => {
    expect(await submit(request(change))).toEqual({ ok: false, error: "answers" });
  });

  it("refuses a photo for a business that asks for none", async () => {
    const result = await submit(
      {
        ...request({ tasks: [KAVERI_FAN], answers: {} }),
        photos: [{ question: "photo", bytes: await jpeg() }],
      },
      "kaveri-electricals",
    );
    expect(result).toEqual({ ok: false, error: "answers" });
  });

  it("accepts a request to a business that asks no questions", async () => {
    const result = await submit(
      request({ tasks: [KAVERI_FAN], answers: {} }),
      "kaveri-electricals",
    );
    // Kaveri's seed has requests #1 to #3.
    expect(result).toMatchObject({ ok: true, number: 4 });
  });

  it("refuses a file that is not an image, and more than six photos", async () => {
    const text = { question: "photo", bytes: Buffer.from("not a photo") };
    expect(await submit(request({ photos: [text] }))).toEqual({
      ok: false,
      error: "photo_not_an_image",
    });
    const seven = Array.from({ length: 7 }, () => ({ question: "photo", bytes: Buffer.alloc(1) }));
    expect(await submit(request({ photos: seven }))).toEqual({
      ok: false,
      error: "too_many_photos",
    });
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
  it("reads the page's field names and skips an empty file input", async () => {
    const form = new FormData();
    form.append("task", GAS_REFILL);
    form.append("task", GENERAL_SERVICE);
    form.append("name", "Vikram");
    form.append("phone", "9876543210");
    form.append("address", "Aundh");
    form.append("q.symptom", "Not cooling");
    form.append("photo.photo", new File([await jpeg()], "ac.jpg"));
    form.append("photo.photo", new File([], ""));
    const input = await readIntakeForm(form);
    expect(input).toMatchObject({
      tasks: [GAS_REFILL, GENERAL_SERVICE],
      name: "Vikram",
      preferredWindow: "",
      answers: { symptom: "Not cooling" },
    });
    expect(input.photos.map((p) => p.question)).toEqual(["photo"]);
  });
});
