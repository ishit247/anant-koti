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
  answerQuote,
  cancelJob,
  createNotices,
  jobDeposit,
  logPhoneEnquiry,
  migrations,
  type Notices,
  openDraft,
  payDeposit,
  planVisit,
  type QuoteLineInput,
  RUNTIME_ROLE,
  saveDraft,
  seed,
  sendQuote,
} from "../src/index.ts";

const SHARMA = "10000000-0000-4000-8000-000000000001";
const SHARMA_OWNER = "10000000-0000-4000-8000-0000000a0001";
const KAVERI = "20000000-0000-4000-8000-000000000002";
const WEBHOOK_SECRET = "whsec-sharma-0123456789";
const RETURN = "http://localhost:45450/b/sharma/requests/x?pay=back";

const log = createLogger({ service: "test", write: () => {} });
const audit = createAudit(log);
const sharmaOwner = { businessId: SHARMA, memberId: SHARMA_OWNER };
// ₹200 plus 18% tax: ₹236.
const visitFee: QuoteLineInput = {
  jobTaskId: null,
  catalogueItemId: null,
  description: "Visit fee",
  unit: "visit",
  quantityMilli: 1000,
  unitPriceMinor: 20_000,
  taxRateBp: 1800,
};

const read = async (request: IncomingMessage) => {
  let text = "";
  for await (const chunk of request) text += chunk;
  return text;
};

describe("the deposit on an accepted quote", () => {
  let database: TestDb;
  let app: Db;
  let owner: Db;
  let jobs: Jobs;
  let notices: Notices;
  let payments: Payments;
  let stub: Server;
  let asked: string[];
  let refuseCancel = false;
  let linkNumber = 0;

  const sharma = <T>(fn: (c: DbClient) => Promise<T>) => app.withTenant(SHARMA, fn);

  /** A phone request from a new customer, quoted with this deposit and accepted by them. */
  async function acceptedJob(depositMinor = 10_000, phone = "98220 11122") {
    const job = await sharma((c) =>
      logPhoneEnquiry(c, audit, sharmaOwner, {
        name: "Meera Kulkarni",
        phone,
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
        lines: [visitFee],
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
    return { jobId, customer: { id: rows[0]?.customer_id as string, businessId: SHARMA } };
  }

  const pay = (jobId: string, customer: { id: string; businessId: string }) =>
    sharma((c) => payDeposit(c, payments, customer, jobId, RETURN));
  const deposit = (jobId: string) => sharma((c) => jobDeposit(c, payments, SHARMA, jobId));

  /** What Razorpay sends when the link is paid in full. */
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
        if (event.kind === "payment.received")
          await notices.paymentReceived(client, event.payment, event.link);
      },
    );
  }

  const linkStatuses = async (jobId: string) =>
    (
      await owner.tx((c) =>
        c.query<{ status: string }>(
          "select status from payments.link where subject_id = $1 order by created_at",
          [jobId],
        ),
      )
    ).rows.map((r) => r.status);

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
        const id = `plink_Dep${String(linkNumber).padStart(6, "0")}`;
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ id, short_url: `https://rzp.io/i/${id}` }));
        return;
      }
      if (refuseCancel) {
        response
          .writeHead(400, { "content-type": "application/json" })
          .end(JSON.stringify({ error: { code: "BAD_REQUEST_ERROR" } }));
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
    refuseCancel = false;
  });

  it("asks for the accepted quote's deposit, nothing paid yet, payable online", async () => {
    const { jobId } = await acceptedJob(10_000);

    expect(await deposit(jobId)).toMatchObject({
      amount: { minor: 10_000 },
      paid: { minor: 0 },
      due: { minor: 10_000 },
      online: true,
    });
  });

  it("is not there when the accepted quote asks for none", async () => {
    const { jobId, customer } = await acceptedJob(0);

    expect(await deposit(jobId)).toBeNull();
    expect(await pay(jobId, customer)).toEqual({ ok: false, error: "nothing_due" });
  });

  it("sends the customer to a Razorpay link for the deposit, the same one if they press Pay again", async () => {
    const { jobId, customer } = await acceptedJob(10_000);

    const first = await pay(jobId, customer);
    const second = await pay(jobId, customer);

    expect(first).toEqual({ ok: true, url: expect.stringMatching(/^https:\/\/rzp\.io\/i\//) });
    expect(second).toEqual(first);
    expect(asked).toEqual(["/v1/payment_links"]);
  });

  it("does not let another customer pay, or even find, the job", async () => {
    const { jobId } = await acceptedJob(10_000);
    const other = await acceptedJob(10_000, "98220 33344");

    expect(await pay(jobId, other.customer)).toEqual({ ok: false, error: "not_found" });
    expect(asked).toEqual([]);
  });

  it("finds no job of another business, though the id is right", async () => {
    const { jobId, customer } = await acceptedJob(10_000);

    expect(
      await app.withTenant(KAVERI, (c) =>
        payDeposit(c, payments, { ...customer, businessId: KAVERI }, jobId, RETURN),
      ),
    ).toEqual({ ok: false, error: "not_found" });
  });

  it("shows the deposit paid only once Razorpay's verified webhook records it, and tells the owner", async () => {
    const { jobId, customer } = await acceptedJob(10_000);
    await pay(jobId, customer);
    expect((await deposit(jobId))?.due.minor).toBe(10_000);

    expect(await razorpayPays(jobId, 10_000, `pay_Dep${jobId.slice(0, 8)}`)).toBe("applied");

    expect(await deposit(jobId)).toMatchObject({ paid: { minor: 10_000 }, due: { minor: 0 } });
    expect(await pay(jobId, customer)).toEqual({ ok: false, error: "nothing_due" });
    const { rows } = await owner.tx((c) =>
      c.query<{ payload: { template: string; vars: Record<string, string> } }>(
        `select payload from outbox.message where idempotency_key like 'notify:payment.received:%'
         and payload->'vars'->>'link' like '%' || $1`,
        [jobId],
      ),
    );
    expect(
      rows.map((r) => [r.payload.template, r.payload.vars.amount, r.payload.vars.what]),
    ).toEqual([["payment.received", "₹100.00", "the deposit"]]);
  });

  it("refuses to make a link while the business has not connected Razorpay", async () => {
    const { jobId, customer } = await acceptedJob(10_000);
    await owner.tx((c) => c.query("delete from payments.account where business_id = $1", [SHARMA]));
    try {
      expect(await pay(jobId, customer)).toEqual({ ok: false, error: "offline" });
      expect(asked).toEqual([]);
    } finally {
      await sharma((c) =>
        payments.connectAccount(c, {
          businessId: SHARMA,
          keyId: "rzp_test_SharmaKey1234",
          keySecret: "sharma-key-secret-0123",
          webhookSecret: WEBHOOK_SECRET,
          by: SHARMA_OWNER,
        }),
      );
    }
  });

  describe("cancelling the job", () => {
    it("cancels its open link at Razorpay and here, with its visits", async () => {
      const { jobId, customer } = await acceptedJob(10_000);
      await pay(jobId, customer);
      const visit = await sharma((c) =>
        planVisit(c, audit, sharmaOwner, {
          jobId,
          kind: "site_visit",
          technicianId: SHARMA_OWNER,
          start: "2031-05-01T10:00",
          minutes: 60,
        }),
      );
      if (!visit.ok) throw new Error(visit.error);
      asked = [];

      const cancelled = await sharma((c) =>
        cancelJob(c, audit, payments, SHARMA, jobId, { role: "owner", memberId: SHARMA_OWNER }),
      );

      expect(cancelled).toEqual({ ok: true, from: "accepted", to: "cancelled" });
      expect(asked).toEqual([expect.stringMatching(/^\/v1\/payment_links\/plink_Dep\d+\/cancel$/)]);
      expect(await linkStatuses(jobId)).toEqual(["cancelled"]);
      expect(await pay(jobId, customer)).toEqual({ ok: false, error: "closed" });
      const { rows } = await owner.tx((c) =>
        c.query<{ status: string }>("select status from kk.appointment where id = $1", [
          visit.appointmentId,
        ]),
      );
      expect(rows[0]?.status).toBe("cancelled");
    });

    it("leaves the job as it was when Razorpay refuses to cancel the link", async () => {
      const { jobId, customer } = await acceptedJob(10_000);
      await pay(jobId, customer);
      refuseCancel = true;

      await expect(
        sharma((c) =>
          cancelJob(c, audit, payments, SHARMA, jobId, { role: "owner", memberId: SHARMA_OWNER }),
        ),
      ).rejects.toThrow(/refused with 400/);

      const { rows } = await owner.tx((c) =>
        c.query<{ status: string }>("select status from kk.job where id = $1", [jobId]),
      );
      expect(rows[0]?.status).toBe("accepted");
      expect(await linkStatuses(jobId)).toEqual(["created"]);
    });

    it("asks Razorpay nothing for a job past cancelling", async () => {
      const { jobId, customer } = await acceptedJob(10_000);
      await pay(jobId, customer);
      await owner.tx((c) =>
        c.query("update kk.job set status = 'completed' where id = $1", [jobId]),
      );
      asked = [];

      expect(
        await sharma((c) =>
          cancelJob(c, audit, payments, SHARMA, jobId, { role: "owner", memberId: SHARMA_OWNER }),
        ),
      ).toEqual({ ok: false, error: "refused" });
      expect(asked).toEqual([]);
      expect(await linkStatuses(jobId)).toEqual(["created"]);
    });
  });
});
