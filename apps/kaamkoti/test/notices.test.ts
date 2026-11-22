import { createAudit } from "@bodhchakra/audit";
import { type Db, type DbClient, type TestDb, testDb } from "@bodhchakra/db";
import { createJobs, type Jobs } from "@bodhchakra/jobs";
import { createLogger } from "@bodhchakra/log";
import { createNotify } from "@bodhchakra/notify";
import { createOutbox } from "@bodhchakra/outbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  answerQuote,
  answerVisit,
  createNotices,
  logPhoneEnquiry,
  migrations,
  moveVisit,
  type Notices,
  openDraft,
  planVisit,
  RUNTIME_ROLE,
  seed,
  sendQuote,
  type VisitAnswer,
} from "../src/index.ts";

const SHARMA = "10000000-0000-4000-8000-000000000001";
const SHARMA_OWNER = "10000000-0000-4000-8000-0000000a0001";
const SHARMA_GAS_REFILL = "10000000-0000-4000-8000-0000000b0002";
// Request #1, from Anita Deshpande, who gave an email.
const SHARMA_JOB_1 = "10000000-0000-4000-8000-0000000e0001";
const APP_ORIGIN = "http://127.0.0.1:45450";
const PUBLIC_ORIGIN = "http://localhost:45450";

const log = createLogger({ service: "test", write: () => {} });
const audit = createAudit(log);
const sharmaOwner = { businessId: SHARMA, memberId: SHARMA_OWNER };

const until = async (check: () => Promise<boolean>, what: string, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

describe("notices", () => {
  let database: TestDb;
  let app: Db;
  let owner: Db;
  let jobs: Jobs;
  let notices: Notices;
  /** The owner's identity, as platform knows them. */
  let ownerIdentity: string;
  const sharma = <T>(fn: (c: DbClient) => Promise<T>) => app.withTenant(SHARMA, fn);

  const queued = async (key: string) =>
    (
      await owner.tx((client) =>
        client.query<{ topic: string; payload: Record<string, unknown> }>(
          "select topic, payload from outbox.message where idempotency_key = $1",
          [key],
        ),
      )
    ).rows;
  /** Payloads of the queued messages of one template. */
  const ofTemplate = async (template: string) =>
    (
      await owner.tx((client) =>
        client.query<{ payload: Record<string, unknown> }>(
          "select payload from outbox.message where payload->>'template' = $1 order by created_at",
          [template],
        ),
      )
    ).rows.map((row) => row.payload);

  async function draftFor(jobId: string): Promise<string> {
    const draft = await sharma((c) => openDraft(c, sharmaOwner, jobId));
    if (!draft.ok) throw new Error(draft.error);
    return draft.quoteId;
  }

  /** A request by phone from a customer who gave no email. */
  async function phoneRequest(): Promise<string> {
    const enquiry = await sharma((c) =>
      logPhoneEnquiry(c, audit, sharmaOwner, {
        name: "Vikram Patil",
        phone: "90000 01099",
        address: "21 FC Road, Pune",
        tasks: [SHARMA_GAS_REFILL],
        customTask: "Remote battery change",
      }),
    );
    if (!enquiry.ok) throw new Error(enquiry.error);
    return enquiry.jobId;
  }

  /** Sends the draft as the quote editor's action does, with the notice in the same transaction. */
  function sendWithNotice(quoteId: string, fail = false): Promise<void> {
    return sharma(async (c) => {
      const sent = await sendQuote(c, audit, sharmaOwner, quoteId, 7);
      if (!sent.ok) throw new Error(sent.error);
      await notices.quoteSent(c, quoteId);
      if (fail) throw new Error("the send's transaction failed");
    });
  }

  /** A phone request with a sent quote: its job and quote. */
  async function quotedRequest(): Promise<{ jobId: string; quoteId: string }> {
    const jobId = await phoneRequest();
    const quoteId = await draftFor(jobId);
    await sendWithNotice(quoteId);
    return { jobId, quoteId };
  }

  beforeAll(async () => {
    database = await testDb({
      owner: "kaamkoti_owner",
      runtimeRole: RUNTIME_ROLE,
      folders: migrations,
    });
    await seed(database.url("kaamkoti_owner"), log);
    app = database.connect(RUNTIME_ROLE);
    owner = database.connect("kaamkoti_owner");
    // A worker: the expiry notice is run here, as in the worker process.
    jobs = createJobs({ url: database.url(RUNTIME_ROLE), log, pollingIntervalSeconds: 0.5 });
    const outbox = createOutbox({ jobs, log });
    notices = createNotices({
      notify: createNotify(outbox),
      jobs,
      appOrigin: APP_ORIGIN,
      publicOrigin: PUBLIC_ORIGIN,
    });
    await jobs.start([...outbox.jobTypes, ...notices.jobTypes]);
    await notices.startWorking(app);
    const member = await owner.tx((c) =>
      c.query<{ identity_id: string }>("select identity_id from tenancy.member where id = $1", [
        SHARMA_OWNER,
      ]),
    );
    ownerIdentity = member.rows[0]?.identity_id ?? "";
  });
  afterAll(async () => {
    await jobs.stop();
    await database.drop();
  });

  it("tells the owner of a new request by identity, and acknowledges it to the customer", async () => {
    await sharma((c) => notices.requestReceived(c, SHARMA_JOB_1));

    const [toOwner] = await queued(`notify:request.received:${SHARMA_JOB_1}`);
    expect(toOwner?.payload).toMatchObject({
      businessId: SHARMA,
      template: "request.received",
      to: { identityId: ownerIdentity },
      vars: { customerName: "Anita Deshpande", link: `${APP_ORIGIN}/jobs/${SHARMA_JOB_1}` },
    });
    expect(toOwner?.payload.vars).toHaveProperty("number", expect.stringMatching(/^#\d+$/));
    expect(toOwner?.payload.vars).toHaveProperty("items", expect.stringMatching(/^- /));
    const [toCustomer] = await queued(`notify:request.acknowledged:${SHARMA_JOB_1}`);
    expect(toCustomer?.payload).toMatchObject({
      to: { email: "anita@example.com", phone: "+919000001001" },
      vars: {
        businessName: "Sharma Cooling Services",
        link: `${PUBLIC_ORIGIN}/b/sharma-cooling/requests/${SHARMA_JOB_1}`,
      },
    });
  });

  it("tells the owner of each saved change to a request", async () => {
    const before = (await ofTemplate("request.edited")).length;
    await sharma((c) => notices.requestEdited(c, SHARMA_JOB_1));
    await sharma((c) => notices.requestEdited(c, SHARMA_JOB_1));

    const edited = await ofTemplate("request.edited");
    expect(edited).toHaveLength(before + 2);
    expect(edited.at(-1)).toMatchObject({ to: { identityId: ownerIdentity } });
  });

  it("queues quote.sent to the customer, linking to their page for the job on the bare domain", async () => {
    const quoteId = await draftFor(SHARMA_JOB_1);
    await sendWithNotice(quoteId);

    const [message] = await queued(`notify:quote.sent:${quoteId}`);
    expect(message?.topic).toBe("notify.send");
    expect(message?.payload).toMatchObject({
      businessId: SHARMA,
      template: "quote.sent",
      to: { email: "anita@example.com", phone: "+919000001001" },
      vars: {
        customerName: "Anita Deshpande",
        businessName: "Sharma Cooling Services",
        link: `${PUBLIC_ORIGIN}/b/sharma-cooling/requests/${SHARMA_JOB_1}`,
      },
    });
    expect(message?.payload.vars).toHaveProperty("total", expect.stringMatching(/^₹/));
  });

  it("gives platform only the phone of a customer with no email", async () => {
    const { quoteId } = await quotedRequest();

    const [message] = await queued(`notify:quote.sent:${quoteId}`);
    expect(message?.payload.to).toEqual({ phone: "+919000001099" });
  });

  it("queues nothing when the send's transaction rolls back", async () => {
    const quoteId = await draftFor(await phoneRequest());
    await expect(sendWithNotice(quoteId, true)).rejects.toThrow("transaction failed");

    expect(await queued(`notify:quote.sent:${quoteId}`)).toEqual([]);
    const expiry = await owner.tx((c) =>
      c.query("select 1 from pgboss.job where data->>'quoteId' = $1", [quoteId]),
    );
    expect(expiry.rowCount).toBe(0);
  });

  it("refuses to announce a quote that was not sent", async () => {
    const quoteId = await draftFor(await phoneRequest());
    await expect(sharma((c) => notices.quoteSent(c, quoteId))).rejects.toThrow(
      "is not a sent quote",
    );
  });

  it("tells the owner of a counter, with the price offered", async () => {
    const { jobId, quoteId } = await quotedRequest();
    await sharma(async (c) => {
      const answered = await answerQuote(c, audit, jobId, quoteId, {
        kind: "counter",
        totalMinor: 25_000,
        note: null,
      });
      if (!answered.ok) throw new Error(answered.error);
      await notices.quoteAnswered(c, quoteId);
    });

    const [message] = await queued(`notify:quote.response:${quoteId}`);
    expect(message?.payload).toMatchObject({
      template: "quote.response",
      to: { identityId: ownerIdentity },
      vars: { answer: "countered", offered: "₹250.00", link: `${APP_ORIGIN}/jobs/${jobId}` },
    });
  });

  it("asks the customer to confirm the work's time, and tells the owner and the customer the answer", async () => {
    const { jobId, quoteId } = await quotedRequest();
    const propose = (start: string) =>
      sharma(async (c) => {
        const proposed = await planVisit(c, audit, sharmaOwner, {
          jobId,
          kind: "work",
          technicianId: SHARMA_OWNER,
          start,
          minutes: 60,
        });
        if (!proposed.ok) throw new Error(proposed.error);
        await notices.visitProposed(c, proposed.appointmentId);
        return proposed.appointmentId;
      });
    const answer = (appointmentId: string, given: VisitAnswer) =>
      sharma(async (c) => {
        const { rows } = await c.query<{ customer_id: string }>(
          "select customer_id from kk.job where id = $1",
          [jobId],
        );
        const customer = { id: rows[0]?.customer_id as string, businessId: SHARMA };
        const answered = await answerVisit(c, audit, customer, jobId, appointmentId, given);
        if (!answered.ok) throw new Error(answered.error);
        await notices.visitAnswered(c, appointmentId);
        if (given.kind === "confirm") await notices.visitPlanned(c, appointmentId);
      });

    await sharma(async (c) => {
      const answered = await answerQuote(c, audit, jobId, quoteId, { kind: "accept" });
      if (!answered.ok) throw new Error(answered.error);
      await notices.quoteAnswered(c, quoteId);
    });
    const first = await propose("2026-12-05T10:30");
    await answer(first, { kind: "decline", note: "Afternoons suit me" });
    const second = await propose("2026-12-05T15:00");
    await answer(second, { kind: "confirm" });

    expect((await queued(`notify:quote.response:${quoteId}`))[0]?.payload.vars).toMatchObject({
      answer: "accepted",
    });
    expect((await queued(`notify:appointment.proposed:${first}`))[0]?.payload).toMatchObject({
      to: { phone: "+919000001099" },
      vars: {
        when: "5 Dec, 10:30 am",
        link: `${PUBLIC_ORIGIN}/b/sharma-cooling/requests/${jobId}`,
      },
    });
    expect((await queued(`notify:appointment.response:${first}`))[0]?.payload).toMatchObject({
      to: { identityId: ownerIdentity },
      vars: { answer: "declined", note: "Afternoons suit me", link: `${APP_ORIGIN}/jobs/${jobId}` },
    });
    expect((await queued(`notify:appointment.response:${second}`))[0]?.payload.vars).toMatchObject({
      answer: "confirmed",
      when: "5 Dec, 3:00 pm",
    });
    const confirmed = (await ofTemplate("appointment.confirmed")).filter((payload) =>
      String((payload.vars as Record<string, string>).link).endsWith(jobId),
    );
    expect(confirmed).toMatchObject([
      { to: { phone: "+919000001099" }, vars: { visit: "work visit", when: "5 Dec, 3:00 pm" } },
    ]);
  });

  it("queues the owner's expiry notice at the quote's validity", async () => {
    const { quoteId } = await quotedRequest();
    const { rows } = await owner.tx((c) =>
      c.query<{ start_after: Date; valid_until: Date }>(
        `select j.start_after, q.valid_until from pgboss.job j, kk.quote q
         where j.name = 'kaamkoti.quote_expiry' and j.data->>'quoteId' = $1 and q.id = $1::uuid`,
        [quoteId],
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.start_after).toEqual(rows[0]?.valid_until);
  });

  /** Brings the quote's expiry job forward to now, as if its validity had run out. */
  const expireNow = (quoteId: string) =>
    owner.tx((c) =>
      c.query(
        "update pgboss.job set start_after = now() where name = 'kaamkoti.quote_expiry' and data->>'quoteId' = $1",
        [quoteId],
      ),
    );
  const expiryDone = (quoteId: string) => async () =>
    (
      await owner.tx((c) =>
        c.query(
          "select 1 from pgboss.job where name = 'kaamkoti.quote_expiry' and data->>'quoteId' = $1 and state = 'completed'",
          [quoteId],
        ),
      )
    ).rowCount === 1;

  it("tells the owner when a quote nobody answered runs out", async () => {
    const { jobId, quoteId } = await quotedRequest();
    await expireNow(quoteId);

    await until(expiryDone(quoteId), "the expiry job");
    const [message] = await queued(`notify:quote.expired:${quoteId}`);
    expect(message?.payload).toMatchObject({
      template: "quote.expired",
      to: { identityId: ownerIdentity },
      vars: { customerName: "Vikram Patil", link: `${APP_ORIGIN}/jobs/${jobId}` },
    });
  });

  it("says nothing at the expiry of a quote that was answered", async () => {
    const { jobId, quoteId } = await quotedRequest();
    await sharma((c) => answerQuote(c, audit, jobId, quoteId, { kind: "reject" }));
    await expireNow(quoteId);

    await until(expiryDone(quoteId), "the expiry job");
    expect(await queued(`notify:quote.expired:${quoteId}`)).toEqual([]);
  });

  /** A planned site visit of a new phone request, told as the planner's action does. */
  async function plannedVisit(start: string): Promise<{ jobId: string; appointmentId: string }> {
    const jobId = await phoneRequest();
    const appointmentId = await sharma(async (c) => {
      const planned = await planVisit(c, audit, sharmaOwner, {
        jobId,
        kind: "site_visit",
        technicianId: SHARMA_OWNER,
        start,
        minutes: 60,
      });
      if (!planned.ok) throw new Error(planned.error);
      await notices.visitPlanned(c, planned.appointmentId);
      return planned.appointmentId;
    });
    return { jobId, appointmentId };
  }

  const reminderJobs = (appointmentId: string) =>
    owner.tx((c) =>
      c.query<{ state: string; start_after: Date; starts_at: string }>(
        `select state, start_after, data->>'startsAt' as starts_at from pgboss.job
         where name = 'kaamkoti.visit_reminder' and data->>'appointmentId' = $1 order by created_on`,
        [appointmentId],
      ),
    );
  const remindersRan = (appointmentId: string, count: number) => async () => {
    const { rows } = await reminderJobs(appointmentId);
    return rows.length === count && rows.every((row) => row.state === "completed");
  };
  /** Brings the visit's reminders forward to now, as if the day before had come. */
  const dayBefore = (appointmentId: string) =>
    owner.tx((c) =>
      c.query(
        "update pgboss.job set start_after = now() where name = 'kaamkoti.visit_reminder' and data->>'appointmentId' = $1",
        [appointmentId],
      ),
    );

  it("reminds the customer the day before a visit", async () => {
    const { jobId, appointmentId } = await plannedVisit("2026-12-08T10:30");
    const queuedJobs = (await reminderJobs(appointmentId)).rows;
    expect(queuedJobs).toHaveLength(1);
    const [only] = queuedJobs;
    expect(only?.start_after.getTime()).toBe(
      new Date(only?.starts_at ?? "").getTime() - 86_400_000,
    );

    await dayBefore(appointmentId);
    await until(remindersRan(appointmentId, 1), "the reminder job");
    const reminders = (await ofTemplate("appointment.reminder")).filter((payload) =>
      String((payload.vars as Record<string, string>).link).endsWith(jobId),
    );
    expect(reminders).toMatchObject([
      { to: { phone: "+919000001099" }, vars: { visit: "site visit", when: "8 Dec, 10:30 am" } },
    ]);
  });

  it("does not remind about a time the visit has moved from", async () => {
    const { appointmentId } = await plannedVisit("2026-12-09T10:30");
    await sharma(async (c) => {
      const moved = await moveVisit(c, audit, sharmaOwner, appointmentId, {
        technicianId: SHARMA_OWNER,
        start: "2026-12-10T10:30",
        minutes: 60,
      });
      if (!moved.ok) throw new Error(moved.error);
      await notices.visitPlanned(c, appointmentId);
    });

    await dayBefore(appointmentId);
    await until(remindersRan(appointmentId, 2), "both reminder jobs");
    expect(
      await queued(`notify:appointment.reminder:${appointmentId}:2026-12-09T05:00:00.000Z`),
    ).toEqual([]);
    expect(
      await queued(`notify:appointment.reminder:${appointmentId}:2026-12-10T05:00:00.000Z`),
    ).toHaveLength(1);
  });

  it("queues no reminder for a visit less than a day away", async () => {
    const soon = new Date(Date.now() + 3 * 3_600_000);
    const { appointmentId } = await plannedVisit(
      new Date(soon.getTime() + 330 * 60_000).toISOString().slice(0, 16),
    );
    expect((await reminderJobs(appointmentId)).rows).toEqual([]);
  });

  it("tells the customer the owner is on the way, once for a visit time", async () => {
    const { jobId, appointmentId } = await plannedVisit("2026-12-11T10:30");
    await sharma((c) => notices.visitOnTheWay(c, appointmentId));
    await sharma((c) => notices.visitOnTheWay(c, appointmentId));

    const [message, ...rest] = await ofTemplate("appointment.on_the_way").then((all) =>
      all.filter((p) => String((p.vars as Record<string, string>).link).endsWith(jobId)),
    );
    expect(rest).toEqual([]);
    expect(message).toMatchObject({
      to: { phone: "+919000001099" },
      vars: { businessName: "Sharma Cooling Services" },
    });
  });

  it("will not say the owner is on the way for a visit that is not planned", async () => {
    const { appointmentId } = await plannedVisit("2026-12-12T10:30");
    await owner.tx((c) =>
      c.query("update kk.appointment set status = 'cancelled' where id = $1", [appointmentId]),
    );
    await expect(sharma((c) => notices.visitOnTheWay(c, appointmentId))).rejects.toThrow(
      "is not a planned visit",
    );
  });
});
