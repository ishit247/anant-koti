// A customer changes the work items of their own request until they accept a quote (request-edit.ts), on the
// seeded database: a change withdraws a sent quote, a save with nothing changed keeps it, and nobody reaches
// another customer's request.
import { createAudit } from "@bodhchakra/audit";
import { type Db, type TestDb, testDb } from "@bodhchakra/db";
import { createLogger } from "@bodhchakra/log";
import type { Storage } from "@bodhchakra/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  customerFor,
  customerRequest,
  editRequest,
  migrations,
  RUNTIME_ROLE,
  type SpaceCustomer,
  seed,
  type WorkItemInput,
} from "../src/index.ts";

const SHARMA = "10000000-0000-4000-8000-000000000001";
const ANITA = {
  identityId: "00000000-0000-4000-8000-00000000d005",
  email: "anita@example.com",
};
const ANITA_ROW = "10000000-0000-4000-8000-0000000c0001";
const RAHUL_ROW = "10000000-0000-4000-8000-0000000c0002";
/** Sharma's #2: an "Inspection visit" task and a sent quote on it; given to Anita for the quoted tests. */
const QUOTED = "10000000-0000-4000-8000-0000000e0002";
const QUOTE = "10000000-0000-4000-8000-000000100001";
const INSPECTION = "10000000-0000-4000-8000-0000000f0003";

const item = (id: string, title: string, details = ""): WorkItemInput => ({
  id,
  title,
  details,
  photos: [],
});
/** No item here has a photo, so nothing is stored. */
const noStorage = {} as Storage;
const none = (items: readonly WorkItemInput[]) => items.map(() => []);

describe("a customer editing their request", () => {
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

  const asAnita = <T>(
    fn: (client: Parameters<Parameters<Db["withTenant"]>[1]>[0], me: SpaceCustomer) => Promise<T>,
  ) =>
    app.withTenant(SHARMA, async (client) => {
      const me = await customerFor(client, audit, ANITA);
      if (!me) throw new Error("Anita has no row");
      return fn(client, me);
    });
  const edit = (jobId: string, items: readonly WorkItemInput[]) =>
    asAnita((c, me) => editRequest(c, noStorage, audit, me, jobId, items, none(items)));

  /** A request of the customer's that nobody has quoted, with one item "Fix tap". */
  async function freshRequest(customer = ANITA_ROW) {
    return owner.tx(async (c) => {
      const job = await c.query<{ id: string }>(
        `insert into kk.job (business_id, customer_id, number, source, contact_name, contact_phone_e164, address)
         select $1, $2, max(number) + 1, 'public_form', 'Someone', '+919000001001', 'Pune'
         from kk.job where business_id = $1 returning id`,
        [SHARMA, customer],
      );
      const jobId = job.rows[0]?.id ?? "";
      const task = await c.query<{ id: string }>(
        `insert into kk.job_task (business_id, job_id, title, added_by) values ($1, $2, 'Fix tap', 'customer')
         returning id`,
        [SHARMA, jobId],
      );
      return { jobId, taskId: task.rows[0]?.id ?? "" };
    });
  }
  const titles = async (jobId: string) =>
    (await asAnita((c, me) => customerRequest(c, me, jobId)))?.tasks.map((t) => t.title);
  const stateOf = async (jobId: string) =>
    (
      await owner.tx((c) =>
        c.query<{ job: string; quote: string }>(
          `select j.status as job, (select status from kk.quote where id = $2) as quote
           from kk.job j where j.id = $1`,
          [jobId, QUOTE],
        ),
      )
    ).rows[0];

  it("changes, drops and adds items while the request waits for a quote", async () => {
    const { jobId, taskId } = await freshRequest();
    expect(
      await edit(jobId, [item(taskId, "Fix kitchen tap", "Drips"), item("", "AC general service")]),
    ).toBe("saved");
    const after = await asAnita((c, me) => customerRequest(c, me, jobId));
    expect(after?.tasks.map((t) => [t.title, t.details])).toEqual([
      ["Fix kitchen tap", "Drips"],
      ["AC general service", null],
    ]);
    // An item the form no longer sends is dropped.
    expect(await edit(jobId, [item(taskId, "Fix kitchen tap", "Drips")])).toBe("saved");
    expect(await titles(jobId)).toEqual(["Fix kitchen tap"]);
  });

  it("links a title that names a price-list item to that item", async () => {
    const { jobId, taskId } = await freshRequest();
    await edit(jobId, [item(taskId, "  ac   gas REFILL ")]);
    const { rows } = await owner.tx((c) =>
      c.query("select title, catalogue_item_id from kk.job_task where id = $1", [taskId]),
    );
    expect(rows[0]).toEqual({
      title: "AC gas refill",
      catalogue_item_id: "10000000-0000-4000-8000-0000000b0002",
    });
  });

  it("keeps a sent quote when nothing changed", async () => {
    await owner.tx((c) =>
      c.query("update kk.job set customer_id = $2 where id = $1", [QUOTED, ANITA_ROW]),
    );
    expect(await stateOf(QUOTED)).toEqual({ job: "quoted", quote: "sent" });
    // The form sends the same item back, with the spacing of the name it matched.
    expect(await edit(QUOTED, [item(INSPECTION, "inspection visit  ")])).toBe("unchanged");
    expect(await stateOf(QUOTED)).toEqual({ job: "quoted", quote: "sent" });
    expect(await titles(QUOTED)).toEqual(["Inspection visit"]);
  });

  it("withdraws a sent quote when an item changes, and asks for a new one", async () => {
    expect(await edit(QUOTED, [item(INSPECTION, "Inspection visit", "Also the balcony")])).toBe(
      "saved",
    );
    expect(await stateOf(QUOTED)).toEqual({ job: "requested", quote: "superseded" });
    const { rows } = await owner.tx((c) =>
      c.query<{ status: string }>("select status from kk.job_task where id = $1", [INSPECTION]),
    );
    expect(rows[0]?.status).toBe("requested");
    const audited = await owner.tx((c) =>
      c.query("select 1 from audit.event where action = 'job.edit' and entity_id = $1", [QUOTED]),
    );
    expect(audited.rowCount).toBe(1);
  });

  it("refuses an edit once a quote is accepted, and leaves the items alone", async () => {
    const { jobId, taskId } = await freshRequest();
    await owner.tx((c) => c.query("update kk.job set status = 'cancelled' where id = $1", [jobId]));
    expect(await edit(jobId, [item(taskId, "Changed")])).toBe("locked");
    const { rows } = await owner.tx((c) =>
      c.query<{ title: string }>("select title from kk.job_task where id = $1", [taskId]),
    );
    expect(rows[0]?.title).toBe("Fix tap");
  });

  it("keeps at least one item, each with a title", async () => {
    const { jobId } = await freshRequest();
    expect(await edit(jobId, [])).toBe("items");
    expect(await edit(jobId, [item("", "   ")])).toBe("items");
  });

  it("does not find another customer's request, or honour an item id that is not in the request", async () => {
    const theirs = await freshRequest(RAHUL_ROW);
    expect(await asAnita((c, me) => customerRequest(c, me, theirs.jobId))).toBeNull();
    expect(await edit(theirs.jobId, [item(theirs.taskId, "Hijacked")])).toBe("not_found");
    expect(await asAnita((c, me) => customerRequest(c, me, "not-an-id"))).toBeNull();
    // The other customer's task id sent inside one's own request is refused and changes nothing.
    const mine = await freshRequest();
    expect(await edit(mine.jobId, [item(theirs.taskId, "Hijacked")])).toBe("items");
    const { rows } = await owner.tx((c) =>
      c.query<{ title: string }>("select title from kk.job_task where id = $1", [theirs.taskId]),
    );
    expect(rows[0]?.title).toBe("Fix tap");
  });
});
