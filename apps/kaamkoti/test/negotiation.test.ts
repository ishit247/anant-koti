import { createAudit } from "@bodhchakra/audit";
import { type Db, type DbClient, type TestDb, testDb } from "@bodhchakra/db";
import { createLogger } from "@bodhchakra/log";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  answerQuote,
  issueJobLink,
  logPhoneEnquiry,
  migrations,
  openDraft,
  openJobLink,
  ownerQuotes,
  type QuoteAnswer,
  RUNTIME_ROLE,
  readAnswerForm,
  saveDraft,
  seed,
  sendQuote,
  transitionJob,
} from "../src/index.ts";

const SHARMA = "10000000-0000-4000-8000-000000000001";
const SHARMA_OWNER = "10000000-0000-4000-8000-0000000a0001";
const SHARMA_GAS_REFILL = "10000000-0000-4000-8000-0000000b0002";
const KAVERI = "20000000-0000-4000-8000-000000000002";
const KAVERI_JOB_3 = "20000000-0000-4000-8000-0000000e0003";
const KAVERI_ACCEPTED_QUOTE = "20000000-0000-4000-8000-000000100003";

const log = createLogger({ service: "test" });
const audit = createAudit(log);
const sharmaOwner = { businessId: SHARMA, memberId: SHARMA_OWNER };
const accept: QuoteAnswer = { kind: "accept" };
const reject: QuoteAnswer = { kind: "reject" };

describe("negotiating a quote on the seeded database", () => {
  let database: TestDb;
  let app: Db;
  let owner: Db;
  const sharma = <T>(fn: (c: DbClient) => Promise<T>) => app.withTenant(SHARMA, fn);
  const answer = (jobId: string, quoteId: string, a: QuoteAnswer) =>
    sharma((c) => answerQuote(c, audit, jobId, quoteId, a));
  const asApp = (sql: string, params: unknown[]) => sharma((c) => c.query(sql, params));

  /** A fresh phone request (a gas refill and a custom task) with version 1 sent, valid 7 days. */
  async function quotedJob(): Promise<{ jobId: string; quoteId: string }> {
    const job = await sharma((c) =>
      logPhoneEnquiry(c, audit, sharmaOwner, {
        name: "Meera Kulkarni",
        phone: "98220 11122",
        address: "9 Park Street, Pune",
        tasks: [SHARMA_GAS_REFILL],
        customTask: "Remote battery change",
      }),
    );
    if (!job.ok) throw new Error(job.error);
    const quoteId = await revise(job.jobId);
    return { jobId: job.jobId, quoteId };
  }

  /** Opens the job's next version and sends it as it stands. */
  async function revise(jobId: string): Promise<string> {
    const draft = await sharma((c) => openDraft(c, sharmaOwner, jobId));
    if (!draft.ok) throw new Error(draft.error);
    const sent = await sharma((c) => sendQuote(c, audit, sharmaOwner, draft.quoteId, 7));
    if (!sent.ok) throw new Error(sent.error);
    return draft.quoteId;
  }

  const jobRow = async (jobId: string) =>
    (
      await owner.tx((c) =>
        c.query<{ status: string; accepted_quote_id: string | null; tasks: string[] }>(
          `select status, accepted_quote_id,
                  array(select t.status from kk.job_task t where t.job_id = j.id order by t.added_at, t.id) as tasks
           from kk.job j where id = $1`,
          [jobId],
        ),
      )
    ).rows[0];

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

  it("reads the seeded negotiation: version 1 countered at ₹400, version 2 accepted", async () => {
    const quotes = await app.withTenant(KAVERI, (c) => ownerQuotes(c, KAVERI_JOB_3));
    expect(quotes.map((q) => [q.version, q.status, q.total.minor, q.counter?.total.minor])).toEqual(
      [
        [2, "accepted", 40_000, undefined],
        [1, "superseded", 47_200, 40_000],
      ],
    );
  });

  describe("accepting", () => {
    it("locks the quote, makes it the job's accepted quote, approves the tasks it prices, and is audited", async () => {
      const { jobId, quoteId } = await quotedJob();
      expect(await answer(jobId, quoteId, accept)).toEqual({ ok: true });

      const [quote] = await sharma((c) => ownerQuotes(c, jobId));
      expect(quote?.status).toBe("accepted");
      expect(quote?.decidedAt).toBeInstanceOf(Date);
      expect(await jobRow(jobId)).toEqual({
        status: "accepted",
        accepted_quote_id: quoteId,
        tasks: ["approved", "approved"],
      });
      const { rows } = await owner.tx((c) =>
        c.query(
          "select actor_kind, data from audit.event where entity_id = $1 and action = 'job.accept'",
          [jobId],
        ),
      );
      expect(rows).toEqual([
        {
          actor_kind: "customer",
          data: { quoteId, version: 1, counterTotalMinor: null, from: "quoted", to: "accepted" },
        },
      ]);
    });

    it("leaves the accepted quote unchangeable in the database: status, columns and lines", async () => {
      const { jobId, quoteId } = await quotedJob();
      await answer(jobId, quoteId, accept);
      await expect(
        asApp("update kk.quote set status = 'superseded' where id = $1", [quoteId]),
      ).rejects.toThrow(/accepted quote is locked/);
      await expect(
        asApp("update kk.quote set deposit_minor = 0 where id = $1", [quoteId]),
      ).rejects.toThrow(/accepted quote is locked/);
      await expect(
        asApp("update kk.quote_line set unit_price_minor = 1 where quote_id = $1", [quoteId]),
      ).rejects.toThrow(/sent quote/);
      // The seeded accepted quote of the other business is as locked, by its own owner.
      await expect(
        app.withTenant(KAVERI, (c) =>
          c.query("update kk.quote set status = 'rejected' where id = $1", [KAVERI_ACCEPTED_QUOTE]),
        ),
      ).rejects.toThrow(/accepted quote is locked/);
    });

    it("ends quoting: no new version opens, and a draft left open can be neither saved nor sent", async () => {
      const { jobId, quoteId } = await quotedJob();
      const leftover = await sharma((c) => openDraft(c, sharmaOwner, jobId));
      if (!leftover.ok) throw new Error(leftover.error);
      await answer(jobId, quoteId, accept);

      const closed = { ok: false, error: "closed" };
      expect(await sharma((c) => openDraft(c, sharmaOwner, jobId))).toEqual(closed);
      expect(
        await sharma((c) =>
          saveDraft(c, sharmaOwner, leftover.quoteId, { lines: [], depositMinor: 0 }),
        ),
      ).toEqual(closed);
      expect(await sharma((c) => sendQuote(c, audit, sharmaOwner, leftover.quoteId, 7))).toEqual(
        closed,
      );
      expect((await jobRow(jobId))?.status).toBe("accepted");
    });
  });

  describe("rejecting and countering", () => {
    it("records a rejection and keeps the job quoted; the owner's revision supersedes it", async () => {
      const { jobId, quoteId } = await quotedJob();
      expect(await answer(jobId, quoteId, reject)).toEqual({ ok: true });
      expect((await jobRow(jobId))?.status).toBe("quoted");

      const second = await revise(jobId);
      const versions = await sharma((c) => ownerQuotes(c, jobId));
      expect(versions.map((q) => [q.id, q.status])).toEqual([
        [second, "sent"],
        [quoteId, "superseded"],
      ]);
      expect(versions[1]?.decidedAt).toBeInstanceOf(Date);
      const { rows } = await owner.tx((c) =>
        c.query("select data from audit.event where entity_id = $1 and action = 'job.revise'", [
          jobId,
        ]),
      );
      expect(rows[0]?.data).toMatchObject({
        version: 2,
        superseded: 1,
        from: "quoted",
        to: "quoted",
      });
    });

    it("stores a counter's price and note, shows it to both sides, and audits the price only", async () => {
      const { jobId, quoteId } = await quotedJob();
      const { secret } = await sharma((c) => issueJobLink(c, jobId));
      const counter: QuoteAnswer = { kind: "counter", totalMinor: 250_000, note: "₹2,500 all in?" };
      expect(await answer(jobId, quoteId, counter)).toEqual({ ok: true });

      const [quote] = await sharma((c) => ownerQuotes(c, jobId));
      expect(quote?.status).toBe("countered");
      expect(quote?.counter).toEqual({
        total: { minor: 250_000, currency: "INR" },
        note: "₹2,500 all in?",
      });
      expect((await openJobLink(app, secret))?.quote?.counter?.note).toBe("₹2,500 all in?");
      const { rows } = await owner.tx((c) =>
        c.query("select data from audit.event where entity_id = $1 and action = 'job.counter'", [
          jobId,
        ]),
      );
      expect(rows[0]?.data).toEqual({
        quoteId,
        version: 1,
        counterTotalMinor: 250_000,
        from: "quoted",
        to: "quoted",
      });
    });
  });

  describe("an answer is refused", () => {
    it("the second time for the same version", async () => {
      const { jobId, quoteId } = await quotedJob();
      await answer(jobId, quoteId, reject);
      expect(await answer(jobId, quoteId, accept)).toEqual({ ok: false, error: "answered" });
    });

    it("for a version the business has since replaced", async () => {
      const { jobId, quoteId } = await quotedJob();
      await revise(jobId);
      expect(await answer(jobId, quoteId, accept)).toEqual({ ok: false, error: "replaced" });
      expect((await jobRow(jobId))?.status).toBe("quoted");
    });

    it("for a draft, a quote of another job, and a job of another business", async () => {
      const { jobId } = await quotedJob();
      const draft = await sharma((c) => openDraft(c, sharmaOwner, jobId));
      if (!draft.ok) throw new Error(draft.error);
      const other = await quotedJob();
      const notFound = { ok: false, error: "not_found" };
      expect(await answer(jobId, draft.quoteId, accept)).toEqual(notFound);
      expect(await answer(jobId, other.quoteId, accept)).toEqual(notFound);
      expect(await answer(KAVERI_JOB_3, KAVERI_ACCEPTED_QUOTE, reject)).toEqual(notFound);
      expect((await jobRow(other.jobId))?.status).toBe("quoted");
    });

    it("once the quote has expired, in the code and in the database", async () => {
      const { jobId, quoteId } = await quotedJob();
      // Only the owner role can move a sent quote's dates, and only with its guard off: the test's time machine.
      await owner.tx(async (c) => {
        await c.query("alter table kk.quote disable trigger quote_guard");
        await c.query(
          `update kk.quote set sent_at = now() - interval '8 days', valid_until = now() - interval '1 day'
           where id = $1`,
          [quoteId],
        );
        await c.query("alter table kk.quote enable trigger quote_guard");
      });
      expect(await answer(jobId, quoteId, accept)).toEqual({ ok: false, error: "expired" });
      await expect(
        asApp("update kk.quote set status = 'accepted', decided_at = now() where id = $1", [
          quoteId,
        ]),
      ).rejects.toThrow(/expired quote cannot be answered/);
    });

    it("once the job is cancelled, though its quote is still out", async () => {
      const { jobId, quoteId } = await quotedJob();
      await sharma((c) =>
        transitionJob(c, audit, jobId, {
          event: "cancel",
          actor: { role: "owner", memberId: SHARMA_OWNER },
        }),
      );
      expect(await answer(jobId, quoteId, accept)).toEqual({ ok: false, error: "closed" });
      const [quote] = await sharma((c) => ownerQuotes(c, jobId));
      expect(quote?.status).toBe("sent");
    });
  });

  describe("the database keeps the answer's columns to the answer", () => {
    it("refuses writing a counter onto a quote that stays sent", async () => {
      const { quoteId } = await quotedJob();
      await expect(
        asApp("update kk.quote set counter_total_minor = 100 where id = $1", [quoteId]),
      ).rejects.toThrow(/sent quote cannot change/);
    });

    it("refuses an answer that changes anything else on the way, such as the validity", async () => {
      const { quoteId } = await quotedJob();
      await expect(
        asApp(
          `update kk.quote set status = 'accepted', decided_at = now(),
                               valid_until = valid_until + interval '30 days'
           where id = $1`,
          [quoteId],
        ),
      ).rejects.toThrow(/sent quote cannot change/);
    });

    it("refuses a counter without a price, and an answer without a time", async () => {
      const { quoteId } = await quotedJob();
      await expect(
        asApp(
          "update kk.quote set status = 'countered', decided_at = now(), counter_note = 'less?' where id = $1",
          [quoteId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        asApp("update kk.quote set status = 'rejected' where id = $1", [quoteId]),
      ).rejects.toMatchObject({ code: "23514" });
    });
  });
});

describe("the customer's answer form", () => {
  const QUOTE = "10000000-0000-4000-8000-000000100001";
  const form = (fields: Record<string, string>) => {
    const data = new FormData();
    for (const [name, value] of Object.entries(fields)) data.set(name, value);
    return data;
  };

  it("reads an acceptance of the version shown", () => {
    expect(readAnswerForm(form({ quote: QUOTE, answer: "accept" }), "INR")).toEqual({
      ok: true,
      quoteId: QUOTE,
      answer: { kind: "accept" },
    });
  });

  it("reads a counter typed in rupees, with an empty note as none", () => {
    expect(
      readAnswerForm(
        form({ quote: QUOTE, answer: "counter", total: " 2500.5 ", note: "  " }),
        "INR",
      ),
    ).toEqual({
      ok: true,
      quoteId: QUOTE,
      answer: { kind: "counter", totalMinor: 250_050, note: null },
    });
  });

  it("refuses a counter without a usable price", () => {
    for (const total of ["", "-5", "abc", "1.234"])
      expect(readAnswerForm(form({ quote: QUOTE, answer: "counter", total }), "INR")).toEqual({
        ok: false,
        error: "counter",
      });
  });

  it("refuses a note over 500 characters", () => {
    expect(
      readAnswerForm(
        form({ quote: QUOTE, answer: "counter", total: "100", note: "x".repeat(501) }),
        "INR",
      ),
    ).toEqual({ ok: false, error: "counter" });
  });

  it("refuses an unknown answer or a quote that is not an id", () => {
    expect(readAnswerForm(form({ quote: QUOTE, answer: "maybe" }), "INR")).toMatchObject({
      ok: false,
    });
    expect(readAnswerForm(form({ quote: "1", answer: "accept" }), "INR")).toMatchObject({
      ok: false,
    });
  });
});
