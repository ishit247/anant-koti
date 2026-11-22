import { createAudit } from "@bodhchakra/audit";
import { type Db, type DbClient, type TestDb, testDb } from "@bodhchakra/db";
import { createLogger } from "@bodhchakra/log";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  issueJobLink,
  logPhoneEnquiry,
  migrations,
  openDraft,
  openJobLink,
  ownerQuotes,
  type QuoteLineInput,
  RUNTIME_ROLE,
  saveDraft,
  seed,
  sendQuote,
} from "../src/index.ts";

const SHARMA = "10000000-0000-4000-8000-000000000001";
const KAVERI = "20000000-0000-4000-8000-000000000002";
const SHARMA_OWNER = "10000000-0000-4000-8000-0000000a0001";
const SHARMA_GAS_REFILL = "10000000-0000-4000-8000-0000000b0002";
const SHARMA_SERVICE = "10000000-0000-4000-8000-0000000b0003";
const KAVERI_FAN = "20000000-0000-4000-8000-0000000b0001";
const SHARMA_JOB_2 = "10000000-0000-4000-8000-0000000e0002";
const SHARMA_JOB_2_TASK = "10000000-0000-4000-8000-0000000f0003";
const SHARMA_SENT_QUOTE = "10000000-0000-4000-8000-000000100001";
const KAVERI_JOB_2 = "20000000-0000-4000-8000-0000000e0002";
const KAVERI_DRAFT = "20000000-0000-4000-8000-000000100001";

const log = createLogger({ service: "test" });
const audit = createAudit(log);
const sharmaOwner = { businessId: SHARMA, memberId: SHARMA_OWNER };

const visitFee: QuoteLineInput = {
  jobTaskId: null,
  catalogueItemId: null,
  description: "Visit fee",
  unit: "visit",
  quantityMilli: 1000,
  unitPriceMinor: 20_000,
  taxRateBp: 1800,
};

describe("quotes on the seeded database", () => {
  let database: TestDb;
  let app: Db;
  let owner: Db;
  const sharma = <T>(fn: (c: DbClient) => Promise<T>) => app.withTenant(SHARMA, fn);

  /** A fresh request with a gas refill and a custom task, so each test starts from its own job. */
  async function newJob(): Promise<string> {
    const result = await sharma((c) =>
      logPhoneEnquiry(c, audit, sharmaOwner, {
        name: "Meera Kulkarni",
        phone: "98220 11122",
        address: "9 Park Street, Pune",
        tasks: [SHARMA_GAS_REFILL],
        customTask: "Remote battery change",
      }),
    );
    if (!result.ok) throw new Error(result.error);
    return result.jobId;
  }

  async function draftFor(jobId: string): Promise<string> {
    const draft = await sharma((c) => openDraft(c, sharmaOwner, jobId));
    if (!draft.ok) throw new Error(draft.error);
    return draft.quoteId;
  }

  async function sentQuoteFor(jobId: string): Promise<string> {
    const quoteId = await draftFor(jobId);
    const sent = await sharma((c) => sendQuote(c, audit, sharmaOwner, quoteId, 7));
    if (!sent.ok) throw new Error(sent.error);
    return quoteId;
  }

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

  it("reads the seeded quote with task-level and request-level lines and line-rounded GST", async () => {
    const [quote] = await sharma((c) => ownerQuotes(c, SHARMA_JOB_2));
    expect(quote).toMatchObject({ version: 1, status: "sent", expired: false });
    expect(quote?.lines.map((l) => [l.taskTitle, l.net.minor, l.tax.minor])).toEqual([
      ["Inspection visit", 30_000, 5400],
      [null, -5000, -900],
    ]);
    expect([quote?.net.minor, quote?.tax.minor, quote?.total.minor]).toEqual([
      25_000, 4500, 29_500,
    ]);
  });

  describe("a first draft", () => {
    it("has one line per task, at the price list's price, and a custom task at 0 to be priced", async () => {
      const jobId = await newJob();
      await draftFor(jobId);
      const [draft] = await sharma((c) => ownerQuotes(c, jobId));
      expect(draft?.status).toBe("draft");
      expect(
        draft?.lines.map((l) => [l.description, l.catalogueItemId, l.unitPriceMinor, l.taxRateBp]),
      ).toEqual([
        ["AC gas refill", SHARMA_GAS_REFILL, 250_000, 1800],
        ["Remote battery change", null, 0, 0],
      ]);
      expect(draft?.lines.every((l) => l.jobTaskId !== null)).toBe(true);
      expect(draft?.total.minor).toBe(295_000);
    });

    it("is the same draft when opened again", async () => {
      const jobId = await newJob();
      expect(await draftFor(jobId)).toBe(await draftFor(jobId));
    });

    it("is refused once the job is past quoting", async () => {
      const jobId = await newJob();
      await owner.tx((c) =>
        c.query("update kk.job set status = 'declined' where id = $1", [jobId]),
      );
      expect(await sharma((c) => openDraft(c, sharmaOwner, jobId))).toEqual({
        ok: false,
        error: "closed",
      });
    });
  });

  describe("saving a draft", () => {
    it("stores the lines and totals computed from them, mixing task and request-level lines", async () => {
      const jobId = await newJob();
      const quoteId = await draftFor(jobId);
      const [draft] = await sharma((c) => ownerQuotes(c, jobId));
      const task = draft?.lines[0]?.jobTaskId ?? null;
      const saved = await sharma((c) =>
        saveDraft(c, sharmaOwner, quoteId, {
          lines: [
            {
              ...visitFee,
              jobTaskId: task,
              description: "Gas refill, 1.5 kg",
              quantityMilli: 1500,
            },
            visitFee,
          ],
          depositMinor: 10_000,
        }),
      );
      expect(saved.ok).toBe(true);
      const [after] = await sharma((c) => ownerQuotes(c, jobId));
      // 1.5 × ₹200 = ₹300 + 18 % = ₹354; visit ₹200 + ₹36.
      expect(after?.lines.map((l) => [l.jobTaskId, l.net.minor, l.tax.minor])).toEqual([
        [task, 30_000, 5400],
        [null, 20_000, 3600],
      ]);
      expect([after?.total.minor, after?.deposit.minor]).toEqual([59_000, 10_000]);
    });

    it("refuses a total below zero", async () => {
      const quoteId = await draftFor(await newJob());
      const discount = { ...visitFee, description: "Discount", unitPriceMinor: -30_000 };
      expect(
        await sharma((c) =>
          saveDraft(c, sharmaOwner, quoteId, { lines: [visitFee, discount], depositMinor: 0 }),
        ),
      ).toEqual({ ok: false, error: "negative" });
    });

    it("refuses a deposit above the total", async () => {
      const quoteId = await draftFor(await newJob());
      expect(
        await sharma((c) =>
          saveDraft(c, sharmaOwner, quoteId, { lines: [visitFee], depositMinor: 23_601 }),
        ),
      ).toEqual({ ok: false, error: "deposit" });
    });

    it("refuses a line pricing a task of another job", async () => {
      const quoteId = await draftFor(await newJob());
      const elsewhere = { ...visitFee, jobTaskId: SHARMA_JOB_2_TASK };
      expect(
        await sharma((c) =>
          saveDraft(c, sharmaOwner, quoteId, { lines: [elsewhere], depositMinor: 0 }),
        ),
      ).toEqual({ ok: false, error: "lines" });
    });

    it("refuses a price-list item of another business", async () => {
      const quoteId = await draftFor(await newJob());
      const foreign = { ...visitFee, catalogueItemId: KAVERI_FAN };
      expect(
        await sharma((c) =>
          saveDraft(c, sharmaOwner, quoteId, { lines: [foreign], depositMinor: 0 }),
        ),
      ).toEqual({ ok: false, error: "lines" });
    });
  });

  describe("sending", () => {
    it("sends the draft for the chosen days, marks the job and its tasks quoted, and is audited", async () => {
      const jobId = await newJob();
      const quoteId = await sentQuoteFor(jobId);
      const [quote] = await sharma((c) => ownerQuotes(c, jobId));
      expect(quote?.status).toBe("sent");
      const days =
        ((quote?.validUntil?.getTime() ?? 0) - (quote?.sentAt?.getTime() ?? 0)) / 86_400_000;
      expect(days).toBe(7);
      const { rows } = await owner.tx((c) =>
        c.query(
          `select j.status, array(select distinct t.status from kk.job_task t where t.job_id = j.id) as tasks,
                  (select data from audit.event where entity_id = $2 and action = 'quote.sent') as audit
           from kk.job j where j.id = $1`,
          [jobId, quoteId],
        ),
      );
      expect(rows[0]).toEqual({
        status: "quoted",
        tasks: ["quoted"],
        audit: { version: 1, totalMinor: 295_000, superseded: null },
      });
    });

    it("refuses a quote with no lines", async () => {
      const quoteId = await draftFor(await newJob());
      await sharma((c) => saveDraft(c, sharmaOwner, quoteId, { lines: [], depositMinor: 0 }));
      expect(await sharma((c) => sendQuote(c, audit, sharmaOwner, quoteId, 7))).toEqual({
        ok: false,
        error: "empty",
      });
    });

    it("refuses to send the same quote twice", async () => {
      const quoteId = await sentQuoteFor(await newJob());
      expect(await sharma((c) => sendQuote(c, audit, sharmaOwner, quoteId, 7))).toEqual({
        ok: false,
        error: "sent",
      });
    });
  });

  describe("versions", () => {
    it("starts a new version from the sent one, and sending it supersedes the old", async () => {
      const jobId = await newJob();
      const first = await sentQuoteFor(jobId);
      const second = await draftFor(jobId);
      expect(second).not.toBe(first);
      const [draft] = await sharma((c) => ownerQuotes(c, jobId));
      expect([draft?.version, draft?.lines.length, draft?.total.minor]).toEqual([2, 2, 295_000]);

      const sent = await sharma((c) => sendQuote(c, audit, sharmaOwner, second, 15));
      expect(sent).toEqual({ ok: true, jobId, version: 2 });
      const versions = await sharma((c) => ownerQuotes(c, jobId));
      expect(versions.map((q) => [q.version, q.status])).toEqual([
        [2, "sent"],
        [1, "superseded"],
      ]);
    });

    it("shows the customer the sent version only: never a draft, never a superseded one", async () => {
      const jobId = await newJob();
      const { secret } = await sharma((c) => issueJobLink(c, jobId));
      expect((await openJobLink(app, secret))?.quote).toBeNull();

      await draftFor(jobId);
      expect((await openJobLink(app, secret))?.quote).toBeNull();

      const first = await sharma(async (c) => {
        const [draft] = await ownerQuotes(c, jobId);
        return draft?.id as string;
      });
      await sharma((c) => sendQuote(c, audit, sharmaOwner, first, 7));
      const revision = await draftFor(jobId);
      await sharma((c) =>
        saveDraft(c, sharmaOwner, revision, { lines: [visitFee], depositMinor: 0 }),
      );
      expect((await openJobLink(app, secret))?.quote).toMatchObject({
        version: 1,
        total: { minor: 295_000 },
      });

      await sharma((c) => sendQuote(c, audit, sharmaOwner, revision, 7));
      expect((await openJobLink(app, secret))?.quote).toMatchObject({
        version: 2,
        total: { minor: 23_600 },
      });
    });
  });

  describe("a sent quote is frozen in the database", () => {
    const asApp = (sql: string, params: unknown[]) =>
      app.withTenant(SHARMA, (c) => c.query(sql, params));

    it("refuses changing, adding or removing its lines", async () => {
      await expect(
        asApp("update kk.quote_line set unit_price_minor = 1 where quote_id = $1", [
          SHARMA_SENT_QUOTE,
        ]),
      ).rejects.toThrow(/sent quote/);
      await expect(
        asApp("delete from kk.quote_line where quote_id = $1", [SHARMA_SENT_QUOTE]),
      ).rejects.toThrow(/sent quote/);
      await expect(
        asApp(
          `insert into kk.quote_line (business_id, job_id, quote_id, position, description, unit, quantity_milli,
                                      unit_price_minor, tax_rate_bp, net_minor, tax_minor)
           values ($1, $2, $3, 9, 'Extra', 'job', 1000, 100, 0, 100, 0)`,
          [SHARMA, SHARMA_JOB_2, SHARMA_SENT_QUOTE],
        ),
      ).rejects.toThrow(/sent quote/);
    });

    it("refuses changing anything but its status, and going back to draft", async () => {
      await expect(
        asApp("update kk.quote set deposit_minor = 100 where id = $1", [SHARMA_SENT_QUOTE]),
      ).rejects.toThrow(/sent quote cannot change/);
      await expect(
        asApp("update kk.quote set status = 'draft', sent_at = null where id = $1", [
          SHARMA_SENT_QUOTE,
        ]),
      ).rejects.toThrow(/sent quote cannot change/);
    });

    it("refuses saving it as a draft", async () => {
      expect(
        await sharma((c) =>
          saveDraft(c, sharmaOwner, SHARMA_SENT_QUOTE, { lines: [visitFee], depositMinor: 0 }),
        ),
      ).toEqual({ ok: false, error: "sent" });
    });

    it("cannot be deleted by the app's role", async () => {
      await expect(
        asApp("delete from kk.quote where id = $1", [SHARMA_SENT_QUOTE]),
      ).rejects.toMatchObject({
        code: "42501",
      });
    });
  });

  describe("the database restates the money rules", () => {
    it("refuses a line whose amounts do not follow the rounding rule", async () => {
      const quoteId = await draftFor(await newJob());
      await expect(
        sharma((c) =>
          c.query(
            `insert into kk.quote_line (business_id, job_id, quote_id, position, description, unit,
                                        quantity_milli, unit_price_minor, tax_rate_bp, net_minor, tax_minor)
             select business_id, job_id, id, 9, 'Half', 'job', 500, 1, 5000, 0, 0 from kk.quote where id = $1`,
            [quoteId],
          ),
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });

    it("refuses sending a quote whose stored totals are not the sum of its lines", async () => {
      const quoteId = await draftFor(await newJob());
      await sharma((c) =>
        c.query(
          "update kk.quote set net_minor = net_minor + 1, total_minor = total_minor + 1 where id = $1",
          [quoteId],
        ),
      );
      await expect(sharma((c) => sendQuote(c, audit, sharmaOwner, quoteId, 7))).rejects.toThrow(
        /totals do not match/,
      );
    });

    it("refuses a quote that starts out sent, which would skip the check of its lines", async () => {
      await expect(
        sharma((c) =>
          c.query(
            `insert into kk.quote (business_id, job_id, version, status, sent_at, valid_until)
             values ($1, $2, 9, 'sent', now(), now() + interval '1 day')`,
            [SHARMA, SHARMA_JOB_2],
          ),
        ),
      ).rejects.toThrow(/starts as a draft/);
    });
  });

  it("treats a sent quote past its validity as expired, computed when it is read", async () => {
    const later = new Date(Date.now() + 8 * 86_400_000);
    const [quote] = await sharma((c) => ownerQuotes(c, SHARMA_JOB_2, later));
    expect(quote?.expired).toBe(true);
  });

  describe("another business's quotes", () => {
    it("cannot be opened, saved or sent, even by id", async () => {
      expect(await sharma((c) => openDraft(c, sharmaOwner, KAVERI_JOB_2))).toEqual({
        ok: false,
        error: "not_found",
      });
      expect(
        await sharma((c) =>
          saveDraft(c, sharmaOwner, KAVERI_DRAFT, { lines: [visitFee], depositMinor: 0 }),
        ),
      ).toEqual({ ok: false, error: "not_found" });
      expect(await sharma((c) => sendQuote(c, audit, sharmaOwner, KAVERI_DRAFT, 7))).toEqual({
        ok: false,
        error: "not_found",
      });
      expect(await sharma((c) => ownerQuotes(c, KAVERI_JOB_2))).toEqual([]);
      const [kaveri] = await app.withTenant(KAVERI, (c) => ownerQuotes(c, KAVERI_JOB_2));
      expect(kaveri?.status).toBe("draft");
    });
  });

  it("prices a request with two catalogue tasks from the price list", async () => {
    const result = await sharma((c) =>
      logPhoneEnquiry(c, audit, sharmaOwner, {
        name: "Meera Kulkarni",
        phone: "98220 11122",
        address: "9 Park Street, Pune",
        tasks: [SHARMA_GAS_REFILL, SHARMA_SERVICE],
        customTask: "",
      }),
    );
    if (!result.ok) throw new Error(result.error);
    await draftFor(result.jobId);
    const [draft] = await sharma((c) => ownerQuotes(c, result.jobId));
    // ₹2,500 + ₹800 net, 18 % each: ₹450 + ₹144.
    expect([draft?.net.minor, draft?.tax.minor, draft?.total.minor]).toEqual([
      330_000, 59_400, 389_400,
    ]);
  });
});
