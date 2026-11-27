// The invoice (4.4) against real Postgres and a local stand-in for Razorpay: each test makes its own job, quoted,
// accepted, scheduled, checked in and completed through the app's own functions.
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAudit } from "@bodhchakra/audit";
import { type Db, type DbClient, type TestDb, testDb } from "@bodhchakra/db";
import { createJobs, type Jobs } from "@bodhchakra/jobs";
import { createLogger } from "@bodhchakra/log";
import { createNotify } from "@bodhchakra/notify";
import { createOutbox } from "@bodhchakra/outbox";
import { createPayments, type Payments, signRazorpayWebhook } from "@bodhchakra/payments";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  answerChangeOrder,
  answerQuote,
  bill,
  checkIn,
  completeWork,
  confirmVisitFor,
  createNotices,
  customerJobs,
  jobInvoice,
  logPhoneEnquiry,
  migrations,
  type Notices,
  openChangeDraft,
  openDraft,
  payDeposit,
  payInvoice,
  planVisit,
  proposeChangeOrder,
  type QuoteLineInput,
  RUNTIME_ROLE,
  recordCash,
  saveChangeDraft,
  saveDraft,
  seed,
  sendQuote,
  settleInvoice,
  voidInvoice,
} from "../src/index.ts";

const SHARMA = "10000000-0000-4000-8000-000000000001";
const SHARMA_OWNER = "10000000-0000-4000-8000-0000000a0001";
const KAVERI = "20000000-0000-4000-8000-000000000002";
const WEBHOOK_SECRET = "whsec-sharma-0123456789";
const RETURN = "http://localhost:45450/b/sharma/requests/x?pay=back";

const log = createLogger({ service: "test", write: () => {} });
const audit = createAudit(log);
const sharmaOwner = { businessId: SHARMA, memberId: SHARMA_OWNER };
const worker = { memberId: SHARMA_OWNER, role: "owner" as const };
const line = (description: string, unitPriceMinor: number, taxRateBp = 0): QuoteLineInput => ({
  jobTaskId: null,
  catalogueItemId: null,
  description,
  unit: "job",
  quantityMilli: 1000,
  unitPriceMinor,
  taxRateBp,
});
// ₹200 plus 18% tax: ₹236.
const VISIT_FEE = line("Visit fee", 20_000, 1800);
const QUOTE_TOTAL = 23_600;

const read = async (request: IncomingMessage) => {
  let text = "";
  for await (const chunk of request) text += chunk;
  return text;
};

type Customer = { id: string; businessId: string };

describe("the invoice", () => {
  let database: TestDb;
  let app: Db;
  let owner: Db;
  let jobs: Jobs;
  let notices: Notices;
  let payments: Payments;
  let stub: Server;
  let asked: string[];
  let linkNumber = 0;
  let phoneNumber = 0;
  let visitDay = 0;

  const sharma = <T>(fn: (c: DbClient) => Promise<T>) => app.withTenant(SHARMA, fn);
  const deps = () => ({ audit, payments, notices });

  /** A phone request from a new customer, quoted at ₹236 with this deposit, accepted by them. */
  async function acceptedJob(depositMinor = 0) {
    phoneNumber += 1;
    const job = await sharma((c) =>
      logPhoneEnquiry(c, audit, sharmaOwner, {
        name: "Meera Kulkarni",
        phone: `98220 ${String(10_000 + phoneNumber)}`,
        address: "9 Park Street, Pune",
        tasks: [],
        customTask: "Geyser not heating",
      }),
    );
    if (!job.ok) throw new Error(job.error);
    const jobId = job.jobId;
    await sharma(async (c) => {
      const draft = await openDraft(c, sharmaOwner, jobId);
      if (!draft.ok) throw new Error(draft.error);
      const saved = await saveDraft(c, sharmaOwner, draft.quoteId, {
        lines: [VISIT_FEE],
        depositMinor,
      });
      if (!saved.ok) throw new Error(saved.error);
      const sent = await sendQuote(c, audit, sharmaOwner, draft.quoteId, 7);
      if (!sent.ok) throw new Error(sent.error);
      const accepted = await answerQuote(c, audit, jobId, draft.quoteId, { kind: "accept" });
      if (!accepted.ok) throw new Error(accepted.error);
    });
    const { rows } = await owner.tx((c) =>
      c.query<{ customer_id: string }>("select customer_id from kk.job where id = $1", [jobId]),
    );
    const customer: Customer = { id: rows[0]?.customer_id as string, businessId: SHARMA };
    return { jobId, customer };
  }

  /** The work's time agreed, the owner checked in: the job is under way. */
  async function underWay(jobId: string) {
    visitDay += 1;
    await sharma(async (c) => {
      const visit = await planVisit(c, audit, sharmaOwner, {
        jobId,
        kind: "work",
        technicianId: SHARMA_OWNER,
        start: `2031-06-${String(visitDay).padStart(2, "0")}T10:00`,
        minutes: 60,
      });
      if (!visit.ok) throw new Error(visit.error);
      const confirmed = await confirmVisitFor(c, audit, sharmaOwner, visit.appointmentId);
      if (!confirmed.ok) throw new Error(confirmed.error);
      const inside = await checkIn(c, audit, worker, jobId);
      if (!inside.ok) throw new Error(inside.error);
    });
  }

  /** Marks the work complete and bills it, as the job sheet's Complete does. */
  const complete = (jobId: string) =>
    sharma(async (c) => {
      const done = await completeWork(c, audit, worker, jobId, "");
      if (!done.ok) throw new Error(done.error);
      return bill(c, deps(), jobId);
    });

  const completedJob = async (depositMinor = 0) => {
    const job = await acceptedJob(depositMinor);
    await underWay(job.jobId);
    const billed = await complete(job.jobId);
    if (!billed.ok) throw new Error(billed.error);
    return { ...job, invoiceId: billed.invoiceId };
  };

  /** A change order with these lines, proposed to the customer; returns its id. */
  const proposeChange = (jobId: string, lines: readonly QuoteLineInput[]) =>
    sharma(async (c) => {
      const draft = await openChangeDraft(c, sharmaOwner, jobId);
      if (!draft.ok) throw new Error(`draft: ${draft.error}`);
      const saved = await saveChangeDraft(c, sharmaOwner, draft.changeOrderId, lines);
      if (!saved.ok) throw new Error(`save: ${saved.error}`);
      const sent = await proposeChangeOrder(c, audit, sharmaOwner, draft.changeOrderId);
      if (!sent.ok) throw new Error(`propose: ${sent.error}`);
      return draft.changeOrderId;
    });
  const answer = (customer: Customer, jobId: string, changeOrderId: string, approve: boolean) =>
    sharma(async (c) => {
      const answered = await answerChangeOrder(c, audit, customer, jobId, changeOrderId, approve);
      if (!answered.ok) throw new Error(answered.error);
    });

  const invoice = (jobId: string) => sharma((c) => jobInvoice(c, payments, SHARMA, jobId));
  const cash = (jobId: string, minor: number) =>
    sharma((c) => recordCash(c, audit, payments, sharmaOwner, jobId, minor));
  const payBill = (jobId: string, customer: Customer) =>
    sharma((c) => payInvoice(c, payments, customer, jobId, RETURN));

  /** What Razorpay sends when the job's open link is paid in full; the route's own handling. */
  async function razorpayPays(jobId: string, minor: number, paymentId: string) {
    const { rows } = await owner.tx((c) =>
      c.query<{ provider_link_id: string }>(
        "select provider_link_id from payments.link where subject_id = $1 and status = 'created'",
        [jobId],
      ),
    );
    const body = JSON.stringify({
      event: "payment_link.paid",
      payload: {
        payment_link: { entity: { id: rows[0]?.provider_link_id, currency: "INR" } },
        payment: {
          entity: {
            id: paymentId,
            amount: minor,
            currency: "INR",
            status: "captured",
            method: "upi",
          },
        },
      },
    });
    return payments.handleWebhook(
      app,
      { businessId: SHARMA, signature: signRazorpayWebhook(body, WEBHOOK_SECRET), rawBody: body },
      async (client, event) => {
        if (event.kind !== "payment.received") return;
        await notices.paymentReceived(client, event.payment, event.link);
        await settleInvoice(client, audit, payments, event.link.subjectId);
      },
    );
  }

  const linkStatuses = async (jobId: string) =>
    (
      await owner.tx((c) =>
        c.query<{ purpose: string; status: string }>(
          "select purpose, status from payments.link where subject_id = $1 order by created_at",
          [jobId],
        ),
      )
    ).rows.map((r) => `${r.purpose} ${r.status}`);

  beforeAll(async () => {
    database = await testDb({
      owner: "kaamkoti_owner",
      runtimeRole: RUNTIME_ROLE,
      folders: migrations,
    });
    await seed(database.url("kaamkoti_owner"), log);
    app = database.connect(RUNTIME_ROLE);
    owner = database.connect("kaamkoti_owner");

    stub = createServer(async (request, response) => {
      await read(request);
      const path = request.url ?? "";
      asked.push(path);
      if (path === "/v1/payment_links") {
        linkNumber += 1;
        const id = `plink_Inv${String(linkNumber).padStart(6, "0")}`;
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ id, short_url: `https://rzp.io/i/${id}` }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    await new Promise<void>((done) => stub.listen(0, "127.0.0.1", done));
    payments = createPayments({
      sealingKey: randomBytes(32).toString("base64"),
      audit,
      log,
      razorpayApi: `http://127.0.0.1:${(stub.address() as AddressInfo).port}`,
    });
    jobs = createJobs({ url: database.url(RUNTIME_ROLE), log, sendOnly: true });
    const outbox = createOutbox({ jobs, log });
    notices = createNotices({
      notify: createNotify(outbox),
      jobs,
      appOrigin: "http://127.0.0.1:45450",
      publicOrigin: "http://localhost:45450",
    });
    await jobs.start([...outbox.jobTypes, ...notices.jobTypes]);
    await sharma((c) =>
      payments.connectAccount(c, {
        businessId: SHARMA,
        keyId: "rzp_test_SharmaKey1234",
        keySecret: "sharma-key-secret-0123",
        webhookSecret: WEBHOOK_SECRET,
        by: SHARMA_OWNER,
      }),
    );
  });
  afterAll(async () => {
    await jobs.stop();
    stub.closeAllConnections();
    stub.close();
    await database.drop();
  });
  beforeEach(() => {
    asked = [];
  });

  describe("issuing", () => {
    it("bills the accepted quote plus the approved change orders only", async () => {
      const { jobId, customer } = await acceptedJob();
      await answer(customer, jobId, await proposeChange(jobId, [line("Gas refill", 10_000)]), true);
      await answer(customer, jobId, await proposeChange(jobId, [line("New tank", 500_000)]), false);
      await underWay(jobId);

      expect(await complete(jobId)).toMatchObject({
        ok: true,
        due: { minor: QUOTE_TOTAL + 10_000 },
      });
      const issued = await invoice(jobId);
      expect(issued).toMatchObject({
        status: "issued",
        net: { minor: 30_000 },
        tax: { minor: 3_600 },
        total: { minor: QUOTE_TOTAL + 10_000 },
        due: { minor: QUOTE_TOTAL + 10_000 },
      });
      expect(issued?.lines.map((l) => [l.description, l.net.minor])).toEqual([
        ["Visit fee", 20_000],
        ["Gas refill", 10_000],
      ]);
    });

    it("numbers invoices one after another per business", async () => {
      const first = await completedJob();
      const second = await completedJob();

      const numbers = [(await invoice(first.jobId))?.number, (await invoice(second.jobId))?.number];
      expect(numbers[1]).toBe((numbers[0] as number) + 1);
    });

    it("sends the customer the bill with what is left to pay", async () => {
      const { invoiceId } = await completedJob(10_000);
      const { rows } = await owner.tx((c) =>
        c.query<{ payload: { template: string; vars: Record<string, string> } }>(
          "select payload from outbox.message where idempotency_key = $1",
          [`notify:invoice.issued:${invoiceId}`],
        ),
      );
      // The deposit was asked for but not paid, so all of it is still due.
      expect(rows[0]?.payload).toMatchObject({
        template: "invoice.issued",
        vars: { total: "₹236.00", due: "₹236.00" },
      });
    });

    it("waits for a change order the customer has not answered, then bills on their answer", async () => {
      const { jobId, customer } = await acceptedJob();
      await underWay(jobId);
      const waiting = await proposeChange(jobId, [line("Found leak", 5_000)]);

      expect(await complete(jobId)).toEqual({ ok: false, error: "waiting" });
      expect(await invoice(jobId)).toBeNull();
      await answer(customer, jobId, waiting, true);
      expect(await sharma((c) => bill(c, deps(), jobId))).toMatchObject({ ok: true });
      expect((await invoice(jobId))?.total.minor).toBe(QUOTE_TOTAL + 5_000);
    });

    it("bills only a completed job, once", async () => {
      const { jobId } = await acceptedJob();
      expect(await sharma((c) => bill(c, deps(), jobId))).toEqual({ ok: false, error: "closed" });
      await underWay(jobId);
      await complete(jobId);
      expect(await sharma((c) => bill(c, deps(), jobId))).toEqual({ ok: false, error: "issued" });
    });

    it("closes change orders while an invoice is in force", async () => {
      const { jobId } = await completedJob();
      expect(await sharma((c) => openChangeDraft(c, sharmaOwner, jobId))).toEqual({
        ok: false,
        error: "closed",
      });
    });
  });

  describe("paying", () => {
    it("counts the deposit, and is paid once Razorpay's webhook covers the rest", async () => {
      const { jobId, customer } = await acceptedJob(10_000);
      await sharma((c) => payDeposit(c, payments, customer, jobId, RETURN));
      await razorpayPays(jobId, 10_000, "pay_Deposit00001");
      await underWay(jobId);
      await complete(jobId);
      expect(await invoice(jobId)).toMatchObject({
        status: "issued",
        paid: { minor: 10_000 },
        due: { minor: QUOTE_TOTAL - 10_000 },
      });

      expect(await payBill(jobId, customer)).toEqual({
        ok: true,
        url: expect.stringMatching(/^https:\/\/rzp\.io\/i\//),
      });
      expect(await razorpayPays(jobId, QUOTE_TOTAL - 10_000, "pay_Bill00000001")).toBe("applied");

      expect(await invoice(jobId)).toMatchObject({ status: "paid", due: { minor: 0 } });
      expect(await payBill(jobId, customer)).toEqual({ ok: false, error: "nothing_due" });
    });

    it("is paid at once when the deposit already covered the whole bill", async () => {
      const { jobId, customer } = await acceptedJob(QUOTE_TOTAL);
      await sharma((c) => payDeposit(c, payments, customer, jobId, RETURN));
      await razorpayPays(jobId, QUOTE_TOTAL, "pay_Deposit00002");
      await underWay(jobId);

      expect(await complete(jobId)).toMatchObject({ ok: true, due: { minor: 0 } });
      expect((await invoice(jobId))?.status).toBe("paid");
    });

    it("cancels a stale deposit link when the customer pays the bill, and reuses the bill's link", async () => {
      const { jobId, customer } = await acceptedJob(10_000);
      // The deposit link was made while the work was ahead, then left unpaid.
      await sharma((c) => payDeposit(c, payments, customer, jobId, RETURN));
      await underWay(jobId);
      await complete(jobId);
      asked = [];

      const first = await payBill(jobId, customer);
      const again = await payBill(jobId, customer);

      expect(again).toEqual(first);
      expect(asked).toEqual([
        expect.stringMatching(/^\/v1\/payment_links\/plink_Inv\d+\/cancel$/),
        "/v1/payment_links",
      ]);
      expect(await linkStatuses(jobId)).toEqual(["deposit cancelled", "invoice created"]);
    });

    it("does not let another customer pay the bill, or find the job", async () => {
      const { jobId } = await completedJob();
      const other = await acceptedJob();

      expect(await payBill(jobId, other.customer)).toEqual({ ok: false, error: "not_found" });
      expect(
        await app.withTenant(KAVERI, (c) =>
          payInvoice(c, payments, { id: other.customer.id, businessId: KAVERI }, jobId, RETURN),
        ),
      ).toEqual({ ok: false, error: "not_found" });
      expect(asked).toEqual([]);
    });
  });

  describe("cash", () => {
    it("takes cash up to what is due, cancels open links, and marks the bill paid once covered", async () => {
      const { jobId, customer } = await completedJob();
      await payBill(jobId, customer);

      expect(await cash(jobId, 10_000)).toEqual({ ok: true, paid: false });
      expect(await linkStatuses(jobId)).toEqual(["invoice cancelled"]);
      expect(await cash(jobId, QUOTE_TOTAL - 10_000 + 1)).toEqual({ ok: false, error: "too_much" });
      expect(await cash(jobId, QUOTE_TOTAL - 10_000)).toEqual({ ok: true, paid: true });

      expect(await invoice(jobId)).toMatchObject({ status: "paid", paid: { minor: QUOTE_TOTAL } });
      expect(await cash(jobId, 100)).toEqual({ ok: false, error: "closed" });
    });

    it("takes a cash deposit before the work, up to the agreed total", async () => {
      const { jobId } = await acceptedJob(10_000);
      expect(await cash(jobId, QUOTE_TOTAL + 1)).toEqual({ ok: false, error: "too_much" });
      expect(await cash(jobId, 10_000)).toEqual({ ok: true, paid: false });
      expect(await invoice(jobId)).toBeNull();
    });

    it("finds no job of another business, though the id is right", async () => {
      const { jobId } = await completedJob();
      expect(
        await app.withTenant(KAVERI, (c) =>
          recordCash(
            c,
            audit,
            payments,
            { businessId: KAVERI, memberId: SHARMA_OWNER },
            jobId,
            100,
          ),
        ),
      ).toEqual({ ok: false, error: "not_found" });
    });
  });

  describe("voiding", () => {
    it("voids a paid invoice; a new one bills extra work approved since, counting what was paid", async () => {
      const { jobId, customer } = await completedJob();
      await cash(jobId, QUOTE_TOTAL);
      const before = await invoice(jobId);

      expect(await sharma((c) => voidInvoice(c, audit, payments, sharmaOwner, jobId))).toEqual({
        ok: true,
      });
      expect(await invoice(jobId)).toBeNull();
      await answer(customer, jobId, await proposeChange(jobId, [line("Extra pipe", 4_000)]), true);
      const again = await sharma((c) => bill(c, deps(), jobId));

      expect(again).toMatchObject({ ok: true, due: { minor: 4_000 } });
      const after = await invoice(jobId);
      expect(after?.number).toBeGreaterThan(before?.number as number);
      expect(after).toMatchObject({ status: "issued", total: { minor: QUOTE_TOTAL + 4_000 } });
    });

    it("audits the void strictly, naming the owner", async () => {
      const { jobId, invoiceId } = await completedJob();
      await sharma((c) => voidInvoice(c, audit, payments, sharmaOwner, jobId));
      const { rows } = await owner.tx((c) =>
        c.query<{ actor_kind: string; actor_id: string }>(
          "select actor_kind, actor_id from audit.event where action = 'invoice.void' and entity_id = $1",
          [invoiceId],
        ),
      );
      expect(rows).toEqual([{ actor_kind: "member", actor_id: SHARMA_OWNER }]);
    });
  });

  describe("in the database", () => {
    const asApp = (sql: string, values: unknown[]) =>
      sharma((c) => c.query(sql, values)).then(
        () => "done",
        (error: Error) => error.message,
      );

    it("keeps a paid invoice and its lines frozen", async () => {
      const { jobId, invoiceId } = await completedJob();
      await cash(jobId, QUOTE_TOTAL);

      expect(
        await asApp("update kk.invoice set total_minor = 1 where id = $1", [invoiceId]),
      ).toMatch(/cannot change/);
      expect(
        await asApp("update kk.invoice set status = 'issued', paid_at = null where id = $1", [
          invoiceId,
        ]),
      ).toMatch(/cannot change/);
      expect(
        await asApp("update kk.invoice_line set description = 'x' where invoice_id = $1", [
          invoiceId,
        ]),
      ).toMatch(/permission denied/);
      expect(await asApp("delete from kk.invoice where id = $1", [invoiceId])).toMatch(
        /permission denied/,
      );
    });

    it("refuses a line added to an invoice after it was written", async () => {
      const { jobId, invoiceId } = await completedJob();
      expect(
        await asApp(
          `insert into kk.invoice_line (business_id, job_id, invoice_id, position, description, unit,
             quantity_milli, unit_price_minor, tax_rate_bp, net_minor, tax_minor)
           values ($1, $2, $3, 9, 'Zero', 'job', 1000, 0, 0, 0, 0)`,
          [SHARMA, jobId, invoiceId],
        ),
      ).toMatch(/do not match its lines/);
    });

    it("refuses to mark paid an invoice that payments do not cover", async () => {
      const { jobId, invoiceId } = await completedJob();
      await cash(jobId, QUOTE_TOTAL - 1);
      expect(
        await asApp("update kk.invoice set status = 'paid', paid_at = now() where id = $1", [
          invoiceId,
        ]),
      ).toMatch(/payments do not cover it/);
    });
  });

  it("keeps a completed job in the customer's Active list until its bill is paid", async () => {
    const { jobId, customer } = await completedJob();
    const listed = async (group: "active" | "completed") =>
      (await sharma((c) => customerJobs(c, customer, group))).map((j) => j.id);

    expect(await listed("active")).toContain(jobId);
    expect(await listed("completed")).not.toContain(jobId);
    await cash(jobId, QUOTE_TOTAL);
    expect(await listed("active")).not.toContain(jobId);
    expect(await listed("completed")).toContain(jobId);
  });
});
