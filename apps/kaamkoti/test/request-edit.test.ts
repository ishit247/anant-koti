// A customer changes the work items of their own request until they accept a quote (request-edit.ts), on the
// seeded database: a change withdraws a sent quote, a save with nothing changed keeps it, and nobody reaches
// another customer's request.
import { createAudit } from "@bodhchakra/audit";
import { type Db, type TestDb, testDb } from "@bodhchakra/db";
import { createLogger } from "@bodhchakra/log";
import type { Storage } from "@bodhchakra/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addressBook,
  answerRequestQuote,
  customerFor,
  customerRequest,
  editRequest,
  migrations,
  openDraft,
  RUNTIME_ROLE,
  type SpaceCustomer,
  seed,
  sendQuote,
  type WorkItemInput,
} from "../src/index.ts";

const SHARMA = "10000000-0000-4000-8000-000000000001";
const sharmaOwner = { businessId: SHARMA, memberId: "10000000-0000-4000-8000-0000000a0001" };
const ANITA = {
  identityId: "00000000-0000-4000-8000-00000000d005",
  email: "anita@example.com",
  phone: null,
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
  /** A place typed as the form sends it. */
  const typed = (where: { contactName: string; contactPhone: string; address: string }) => ({
    addressId: "",
    saveAddress: false,
    label: "",
    latitude: "",
    longitude: "",
    ...where,
  });
  /** Edits the items; the place is sent back as the request has it, unless one is given. */
  const edit = (jobId: string, items: readonly WorkItemInput[], place?: ReturnType<typeof typed>) =>
    asAnita(async (c, me) => {
      const now = (await customerRequest(c, me, jobId))?.place;
      const where = place ?? typed(now ?? { contactName: "x", contactPhone: "x", address: "x" });
      return editRequest(c, noStorage, audit, me, jobId, { ...where, items }, none(items));
    });

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
    (await asAnita((c, me) => customerRequest(c, me, jobId)))?.items.map((t) => t.title);
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
    expect(after?.items.map((t) => [t.title, t.details])).toEqual([
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

  it("changes the place, and withdraws a sent quote like an item change does", async () => {
    const { jobId, taskId } = await freshRequest();
    const fixTap = [item(taskId, "Fix tap")];
    const parents = typed({ contactName: "Meera", contactPhone: "9000001002", address: "Baner" });
    expect(await edit(jobId, fixTap, parents)).toBe("saved");
    expect((await asAnita((c, me) => customerRequest(c, me, jobId)))?.place).toMatchObject({
      contactName: "Meera",
      contactPhone: "+919000001002",
      address: "Baner",
    });
    expect(await edit(jobId, fixTap, parents)).toBe("unchanged");

    // QUOTED belongs to Anita since the test above; only its place changes.
    expect(await edit(QUOTED, [item(INSPECTION, "Inspection visit")], parents)).toBe("saved");
    expect(await stateOf(QUOTED)).toEqual({ job: "requested", quote: "superseded" });
  });

  it("sends the request to one of the customer's saved addresses, and refuses another's", async () => {
    const { jobId, taskId } = await freshRequest();
    const fixTap = [item(taskId, "Fix tap")];
    const place = typed({ contactName: "Asha", contactPhone: "9000001003", address: "Kothrud" });
    expect(await edit(jobId, fixTap, { ...place, saveAddress: true, label: "Office" })).toBe(
      "saved",
    );
    const saved = (await asAnita((c, me) => addressBook(c, me))).find((a) => a.label === "Office");
    expect(saved?.address).toBe("Kothrud");
    const home = typed({ contactName: "Someone", contactPhone: "9000001001", address: "Pune" });
    expect(await edit(jobId, fixTap, home)).toBe("saved");
    expect(await edit(jobId, fixTap, { ...home, addressId: saved?.id ?? "" })).toBe("saved");
    expect((await asAnita((c, me) => customerRequest(c, me, jobId)))?.place.address).toBe(
      "Kothrud",
    );
    const rahul = await owner.tx((c) =>
      c.query<{ id: string }>(
        `insert into kk.customer_address (business_id, customer_id, label, contact_name, contact_phone_e164, address)
         values ($1, $2, 'Home', 'Rahul', '+919000001004', 'Aundh') returning id`,
        [SHARMA, RAHUL_ROW],
      ),
    );
    expect(await edit(jobId, fixTap, { ...home, addressId: rahul.rows[0]?.id ?? "" })).toBe(
      "address",
    );
    expect(await edit(jobId, fixTap, typed({ ...home, address: "  " }))).toBe("contact");
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

  describe("answering the quote on the request page", () => {
    /** A fresh request of the customer's with version 1 sent by the owner, as it stands. */
    async function quotedRequest(customer = ANITA_ROW) {
      const { jobId } = await freshRequest(customer);
      const quoteId = await app.withTenant(SHARMA, async (c) => {
        const draft = await openDraft(c, sharmaOwner, jobId);
        if (!draft.ok) throw new Error(draft.error);
        const sent = await sendQuote(c, audit, sharmaOwner, draft.quoteId, 7);
        if (!sent.ok) throw new Error(sent.error);
        return draft.quoteId;
      });
      return { jobId, quoteId };
    }
    const answer = (jobId: string, quoteId: string) =>
      asAnita((c, me) => answerRequestQuote(c, audit, me, jobId, quoteId, { kind: "accept" }));
    const quoteStatus = async (quoteId: string) =>
      (
        await owner.tx((c) =>
          c.query<{ status: string }>("select status from kk.quote where id = $1", [quoteId]),
        )
      ).rows[0]?.status;

    it("shows her the sent quote, takes her acceptance, and then locks the items", async () => {
      const { jobId, quoteId } = await quotedRequest();
      const before = await asAnita((c, me) => customerRequest(c, me, jobId));
      expect(before).toMatchObject({ status: "quoted", editable: true });
      expect(before?.quote).toMatchObject({ id: quoteId, status: "sent" });
      expect(await answer(jobId, quoteId)).toEqual({ ok: true });
      const after = await asAnita((c, me) => customerRequest(c, me, jobId));
      expect(after).toMatchObject({ status: "accepted", editable: false });
      expect(after?.quote?.status).toBe("accepted");
    });

    it("answers another customer's request as not found, and leaves its quote alone", async () => {
      const theirs = await quotedRequest(RAHUL_ROW);
      expect(await answer(theirs.jobId, theirs.quoteId)).toEqual({ ok: false, error: "not_found" });
      expect(await quoteStatus(theirs.quoteId)).toBe("sent");
      expect(await answer("not-an-id", theirs.quoteId)).toEqual({ ok: false, error: "not_found" });
    });

    it("answers another business's request as not found", async () => {
      const KAVERI_JOB_1 = "20000000-0000-4000-8000-0000000e0001";
      const mine = await quotedRequest();
      expect(await answer(KAVERI_JOB_1, mine.quoteId)).toEqual({ ok: false, error: "not_found" });
      expect(await quoteStatus(mine.quoteId)).toBe("sent");
    });
  });
});
