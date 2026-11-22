import { createAudit } from "@bodhchakra/audit";
import { type Db, type TestDb, testDb } from "@bodhchakra/db";
import { createLogger } from "@bodhchakra/log";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  countNewRequests,
  listInbox,
  logPhoneEnquiry,
  migrations,
  ownerJob,
  RUNTIME_ROLE,
  seed,
} from "../src/index.ts";

const SHARMA = "10000000-0000-4000-8000-000000000001";
const KAVERI = "20000000-0000-4000-8000-000000000002";
const SHARMA_OWNER = "10000000-0000-4000-8000-0000000a0001";
const SHARMA_JOB_1 = "10000000-0000-4000-8000-0000000e0001";
const KAVERI_JOB_1 = "20000000-0000-4000-8000-0000000e0001";
const SHARMA_GAS_REFILL = "10000000-0000-4000-8000-0000000b0002";
const KAVERI_FAN = "20000000-0000-4000-8000-0000000b0001";

const log = createLogger({ service: "test" });
const audit = createAudit(log);
const sharmaOwner = { businessId: SHARMA, memberId: SHARMA_OWNER };

describe("the owner's inbox on the seeded database", () => {
  let database: TestDb;
  let app: Db;
  let owner: Db;
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

  it("lists only this business's requests, from every source, newest first", async () => {
    const rows = await app.withTenant(SHARMA, listInbox);
    expect(rows.map((r) => [r.number, r.source, r.customerName])).toEqual([
      [2, "phone", expect.any(String)],
      [1, "public_form", "Anita Deshpande"],
    ]);
    expect(rows[1]?.tasks).toEqual(["AC gas refill", "AC general service", "Broken wire"]);
    expect(await app.withTenant(KAVERI, listInbox)).toHaveLength(3);
  });

  it("counts requests that still wait for a quote", async () => {
    // Request #2 has a quote (seed.sql).
    expect(await app.withTenant(SHARMA, countNewRequests)).toBe(1);
  });

  it("shows a request in full: the address, the picked location and each work item", async () => {
    const job = await app.withTenant(SHARMA, (c) => ownerJob(c, SHARMA_JOB_1));
    expect(job).toMatchObject({
      number: 1,
      customerPhone: expect.stringMatching(/^\+/),
      address: "Flat 4, Shanti Apartments, Kothrud, Pune",
      location: { latitude: 18.5074, longitude: 73.8077 },
    });
    expect(job?.items.map((i) => [i.title, i.listed, i.details !== null])).toEqual([
      ["AC gas refill", true, true],
      ["AC general service", true, false],
      ["Broken wire", false, true],
    ]);
  });

  it("does not find another business's request, even by its id", async () => {
    expect(await app.withTenant(SHARMA, (c) => ownerJob(c, KAVERI_JOB_1))).toBeNull();
  });

  describe("logging a phone enquiry", () => {
    const enquiry = {
      name: "Meera Kulkarni",
      phone: "98220 11122",
      address: "9 Park Street, Pune",
      tasks: [SHARMA_GAS_REFILL],
      customTask: "Remote battery change",
    };

    it("creates the customer, a phone-sourced request with business-added tasks, and an audit row", async () => {
      const result = await app.withTenant(SHARMA, (c) =>
        logPhoneEnquiry(c, audit, sharmaOwner, enquiry),
      );
      if (!result.ok) throw new Error(result.error);
      const job = await app.withTenant(SHARMA, (c) => ownerJob(c, result.jobId));
      expect(job).toMatchObject({
        source: "phone",
        status: "requested",
        customerName: "Meera Kulkarni",
        customerPhone: "+919822011122",
        location: null,
      });
      expect(job?.items.map((i) => [i.title, i.listed])).toEqual([
        ["AC gas refill", true],
        ["Remote battery change", false],
      ]);
      const { rows } = await owner.tx((c) =>
        c.query("select action, actor_id from audit.event where entity_id = $1", [result.jobId]),
      );
      expect(rows).toEqual([{ action: "job.logged", actor_id: SHARMA_OWNER }]);
      const added = await owner.tx((c) =>
        c.query("select distinct added_by from kk.job_task where job_id = $1", [result.jobId]),
      );
      expect(added.rows).toEqual([{ added_by: "business" }]);
    });

    it("needs a valid contact and at least one task", async () => {
      const log = (change: Partial<typeof enquiry>) =>
        app.withTenant(SHARMA, (c) =>
          logPhoneEnquiry(c, audit, sharmaOwner, { ...enquiry, ...change }),
        );
      expect(await log({ phone: "12345" })).toEqual({ ok: false, error: "contact" });
      expect(await log({ name: "  " })).toEqual({ ok: false, error: "contact" });
      expect(await log({ tasks: [], customTask: " " })).toEqual({ ok: false, error: "tasks" });
    });

    it("refuses a catalogue item of another business", async () => {
      const result = await app.withTenant(SHARMA, (c) =>
        logPhoneEnquiry(c, audit, sharmaOwner, { ...enquiry, tasks: [KAVERI_FAN] }),
      );
      expect(result).toEqual({ ok: false, error: "tasks" });
    });
  });
});
