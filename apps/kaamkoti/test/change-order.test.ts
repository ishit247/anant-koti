// Change orders (4.3) against the seeded database: Sharma's request #3 (Rahul's AC service, ₹944 accepted) is
// scheduled for today with the technician Imran. Work added after acceptance costs nothing until a change order
// prices it and the customer approves; what is agreed is the accepted quote plus the approved ones only.
import { createAudit } from "@bodhchakra/audit";
import { type Db, type DbClient, type TestDb, testDb } from "@bodhchakra/db";
import { createLogger } from "@bodhchakra/log";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addFoundWork,
  agreedWork,
  answerChangeOrder,
  askForMoreWork,
  changeOrders,
  checkIn,
  completeWork,
  migrations,
  openChangeDraft,
  proposeChangeOrder,
  type QuoteLineInput,
  RUNTIME_ROLE,
  type SpaceCustomer,
  saveChangeDraft,
  seed,
  type Worker,
} from "../src/index.ts";

const SHARMA = "10000000-0000-4000-8000-000000000001";
const KAVERI = "20000000-0000-4000-8000-000000000002";
const JOB = "10000000-0000-4000-8000-0000000e0003";
const QUOTED_JOB = "10000000-0000-4000-8000-0000000e0002";
const KAVERI_ACCEPTED = "20000000-0000-4000-8000-0000000e0003";
const RAHUL: SpaceCustomer = { id: "10000000-0000-4000-8000-0000000c0002", businessId: SHARMA };
const ANITA: SpaceCustomer = { id: "10000000-0000-4000-8000-0000000c0001", businessId: SHARMA };
const PRAKASH = { businessId: SHARMA, memberId: "10000000-0000-4000-8000-0000000a0001" };
const IMRAN: Worker = { memberId: "10000000-0000-4000-8000-0000000a0002", role: "technician" };
const KAVYA = { businessId: KAVERI, memberId: "20000000-0000-4000-8000-0000000a0001" };
/** A second Sharma technician, added here, to whom the job was not given. */
const DEEPAK: Worker = { memberId: "10000000-0000-4000-8000-0000000a0003", role: "technician" };
const QUOTE_TOTAL = 94400;

const line = (over: Partial<QuoteLineInput>): QuoteLineInput => ({
  jobTaskId: null,
  catalogueItemId: null,
  description: "Extra",
  unit: "job",
  quantityMilli: 1000,
  unitPriceMinor: 10000,
  taxRateBp: 0,
  ...over,
});

describe("change orders", () => {
  const log = createLogger({ service: "test" });
  const audit = createAudit(log);
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
    await owner.tx((c) =>
      c.query(
        `insert into tenancy.member (id, business_id, identity_id, display_name, role)
         values ($1, $2, gen_random_uuid(), 'Deepak More', 'technician')`,
        [DEEPAK.memberId, SHARMA],
      ),
    );
  });
  afterAll(() => database.drop());

  const atSharma = <T>(fn: (client: DbClient) => Promise<T>) => app.withTenant(SHARMA, fn);
  const taskStatus = async (title: string) => {
    const { rows } = await owner.tx((c) =>
      c.query<{ status: string; added_by: string }>(
        "select status, added_by from kk.job_task where job_id = $1 and title = $2",
        [JOB, title],
      ),
    );
    return rows[0];
  };
  /** Opens a draft, sets its lines, and proposes it; returns its id. */
  const propose = async (lines: readonly QuoteLineInput[]) =>
    atSharma(async (c) => {
      const draft = await openChangeDraft(c, PRAKASH, JOB);
      if (!draft.ok) throw new Error(`draft: ${draft.error}`);
      const saved = await saveChangeDraft(c, PRAKASH, draft.changeOrderId, lines);
      if (!saved.ok) throw new Error(`save: ${saved.error}`);
      const sent = await proposeChangeOrder(c, audit, PRAKASH, draft.changeOrderId);
      if (!sent.ok) throw new Error(`propose: ${sent.error}`);
      return draft.changeOrderId;
    });

  it("refuses a change order before a quote is accepted", async () => {
    expect(await atSharma((c) => openChangeDraft(c, PRAKASH, QUOTED_JOB))).toEqual({
      ok: false,
      error: "closed",
    });
  });

  it("takes the customer's added work as waiting for a price, and drafts it at the price-list price", async () => {
    expect(
      await atSharma((c) =>
        askForMoreWork(c, RAHUL, JOB, { title: "ac gas  refill", details: null }),
      ),
    ).toBe("added");
    expect(await taskStatus("ac gas  refill")).toEqual({
      status: "requested",
      added_by: "customer",
    });
    const lines = await atSharma(async (c) => {
      const draft = await openChangeDraft(c, PRAKASH, JOB);
      if (!draft.ok) throw new Error(draft.error);
      return (await changeOrders(c, JOB, false)).find((o) => o.id === draft.changeOrderId)?.lines;
    });
    expect(lines?.map((l) => [l.description, l.unitPriceMinor, l.taxRateBp])).toEqual([
      ["ac gas  refill", 250000, 1800],
    ]);
  });

  it("answers another customer's or business's request as not found", async () => {
    expect(
      await atSharma((c) => askForMoreWork(c, ANITA, JOB, { title: "Anything", details: null })),
    ).toBe("not_found");
    expect(
      await app.withTenant(KAVERI, (c) =>
        askForMoreWork(c, { id: RAHUL.id, businessId: KAVERI }, JOB, { title: "x", details: null }),
      ),
    ).toBe("not_found");
  });

  it("shows the customer no draft, and refuses an answer to one", async () => {
    const draftId = await atSharma(async (c) => {
      const draft = await openChangeDraft(c, PRAKASH, JOB);
      if (!draft.ok) throw new Error(draft.error);
      return draft.changeOrderId;
    });
    expect(await atSharma((c) => changeOrders(c, JOB, true))).toEqual([]);
    expect(await atSharma((c) => answerChangeOrder(c, audit, RAHUL, JOB, draftId, true))).toEqual({
      ok: false,
      error: "not_found",
    });
  });

  it("freezes a proposed change order in the database, lines and totals", async () => {
    const id = await atSharma(async (c) => {
      const draft = await openChangeDraft(c, PRAKASH, JOB);
      if (!draft.ok) throw new Error(draft.error);
      return draft.changeOrderId;
    });
    const sent = await atSharma((c) => proposeChangeOrder(c, audit, PRAKASH, id));
    expect(sent).toMatchObject({ ok: true, number: 1 });
    expect(await taskStatus("ac gas  refill")).toMatchObject({ status: "quoted" });
    await expect(
      atSharma((c) =>
        c.query("update kk.change_order_line set unit_price_minor = 1 where change_order_id = $1", [
          id,
        ]),
      ),
    ).rejects.toThrow(/cannot change/);
    await expect(
      atSharma((c) =>
        c.query("update kk.change_order set total_minor = 1, net_minor = 1 where id = $1", [id]),
      ),
    ).rejects.toThrow(/cannot change/);
    await expect(
      atSharma((c) => c.query("delete from kk.change_order where id = $1", [id])),
    ).rejects.toThrow(/permission denied/);
  });

  it("keeps one change order waiting for the customer at a time", async () => {
    await expect(propose([line({ description: "Second" })])).rejects.toThrow("propose: waiting");
  });

  it("refuses another customer's answer, and takes the customer's own once", async () => {
    const [waiting] = await atSharma((c) => changeOrders(c, JOB, true));
    if (!waiting) throw new Error("no change order");
    expect(
      await atSharma((c) => answerChangeOrder(c, audit, ANITA, JOB, waiting.id, true)),
    ).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(
      await atSharma((c) => answerChangeOrder(c, audit, RAHUL, JOB, waiting.id, true)),
    ).toEqual({
      ok: true,
    });
    expect(
      await atSharma((c) => answerChangeOrder(c, audit, RAHUL, JOB, waiting.id, false)),
    ).toEqual({
      ok: false,
      error: "answered",
    });
    expect(await taskStatus("ac gas  refill")).toMatchObject({ status: "approved" });
  });

  it("drops the work a rejected change order priced", async () => {
    await atSharma((c) =>
      askForMoreWork(c, RAHUL, JOB, { title: "Paint the wall", details: null }),
    );
    const id = await propose([line({ description: "Paint the wall", unitPriceMinor: 120000 })]);
    // A request-level line prices no task; the added task is priced by a line naming it.
    const task = await owner.tx((c) =>
      c.query<{ id: string }>(
        "select id from kk.job_task where job_id = $1 and title = 'Paint the wall'",
        [JOB],
      ),
    );
    expect(task.rows).toHaveLength(1);
    expect(await atSharma((c) => answerChangeOrder(c, audit, RAHUL, JOB, id, false))).toEqual({
      ok: true,
    });
    // The line named no task, so the task still waits for a price.
    expect(await taskStatus("Paint the wall")).toMatchObject({ status: "requested" });

    const priced = await atSharma(async (c) => {
      const draft = await openChangeDraft(c, PRAKASH, JOB);
      if (!draft.ok) throw new Error(draft.error);
      const lines = (await changeOrders(c, JOB, false)).find(
        (o) => o.id === draft.changeOrderId,
      )?.lines;
      return { id: draft.changeOrderId, lines };
    });
    expect(priced.lines?.map((l) => l.jobTaskId)).toEqual([task.rows[0]?.id]);
    await atSharma((c) =>
      saveChangeDraft(c, PRAKASH, priced.id, [
        line({
          jobTaskId: task.rows[0]?.id ?? null,
          description: "Paint the wall",
          unitPriceMinor: 150000,
        }),
      ]),
    );
    await atSharma((c) => proposeChangeOrder(c, audit, PRAKASH, priced.id));
    expect(
      await atSharma((c) => answerChangeOrder(c, audit, RAHUL, JOB, priced.id, false)),
    ).toEqual({
      ok: true,
    });
    expect(await taskStatus("Paint the wall")).toMatchObject({ status: "dropped" });
  });

  it("agrees the accepted quote plus the approved change orders only", async () => {
    // Waiting for an answer: it must add nothing.
    await propose([line({ description: "Waiting", unitPriceMinor: 99900 })]);
    const agreed = await atSharma((c) => agreedWork(c, JOB));
    const orders = await atSharma((c) => changeOrders(c, JOB, false));
    expect(orders.map((o) => [o.number, o.status])).toEqual([
      [4, "proposed"],
      [3, "rejected"],
      [2, "rejected"],
      [1, "approved"],
    ]);
    // ₹944 quote + ₹2,950 gas refill (2,500 + 18%).
    expect(agreed?.total.minor).toBe(QUOTE_TOTAL + 295000);
    expect(agreed?.changeOrders).toEqual([1]);
    expect(agreed?.lines.map((l) => l.description)).toEqual([
      "AC general service",
      "ac gas  refill",
    ]);
    expect(await atSharma((c) => agreedWork(c, QUOTED_JOB))).toBeNull();
  });

  it("lets the assigned technician add found work only while the work is under way", async () => {
    const found = { title: "Replace the drain pipe", details: "Cracked near the wall" };
    expect(await atSharma((c) => addFoundWork(c, IMRAN, JOB, found))).toEqual({
      ok: false,
      error: "refused",
    });
    await atSharma((c) => checkIn(c, audit, IMRAN, JOB));
    expect(await atSharma((c) => addFoundWork(c, DEEPAK, JOB, found))).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(await atSharma((c) => addFoundWork(c, IMRAN, JOB, found))).toEqual({ ok: true });
    expect(await taskStatus("Replace the drain pipe")).toEqual({
      status: "requested",
      added_by: "business",
    });
  });

  it("takes an approval after completion as work already done, and then no more work", async () => {
    const [waiting] = await atSharma((c) => changeOrders(c, JOB, true));
    await atSharma((c) => completeWork(c, audit, IMRAN, JOB, ""));
    expect(
      await atSharma((c) => askForMoreWork(c, RAHUL, JOB, { title: "One more", details: null })),
    ).toBe("closed");
    const pipe = await owner.tx((c) =>
      c.query<{ id: string }>(
        "select id from kk.job_task where job_id = $1 and title = 'Replace the drain pipe'",
        [JOB],
      ),
    );
    expect(waiting?.status).toBe("proposed");
    expect(
      await atSharma((c) => answerChangeOrder(c, audit, RAHUL, JOB, waiting?.id ?? "", true)),
    ).toEqual({
      ok: true,
    });
    const id = await propose([
      line({ jobTaskId: pipe.rows[0]?.id ?? null, description: "Drain pipe" }),
    ]);
    expect(await atSharma((c) => answerChangeOrder(c, audit, RAHUL, JOB, id, true))).toEqual({
      ok: true,
    });
    expect(await taskStatus("Replace the drain pipe")).toMatchObject({ status: "done" });
  });

  it("refuses a change order whose line prices another job's task", async () => {
    const other = await owner.tx((c) =>
      c.query<{ id: string }>("select id from kk.job_task where job_id = $1 limit 1", [QUOTED_JOB]),
    );
    const result = await atSharma(async (c) => {
      const draft = await openChangeDraft(c, PRAKASH, JOB);
      if (!draft.ok) throw new Error(draft.error);
      return saveChangeDraft(c, PRAKASH, draft.changeOrderId, [
        line({ jobTaskId: other.rows[0]?.id ?? null }),
      ]);
    });
    expect(result).toEqual({ ok: false, error: "lines" });
  });

  it("does not let another business open a change order on the job", async () => {
    expect(await app.withTenant(KAVERI, (c) => openChangeDraft(c, KAVYA, JOB))).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(
      await app.withTenant(KAVERI, (c) => openChangeDraft(c, KAVYA, KAVERI_ACCEPTED)),
    ).toMatchObject({
      ok: true,
    });
  });
});
