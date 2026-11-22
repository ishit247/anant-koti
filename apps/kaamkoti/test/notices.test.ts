import { createAudit } from "@bodhchakra/audit";
import { type Db, type DbClient, type TestDb, testDb } from "@bodhchakra/db";
import { createJobs, type Jobs } from "@bodhchakra/jobs";
import { createLogger } from "@bodhchakra/log";
import { createNotify, type Notify } from "@bodhchakra/notify";
import { createOutbox } from "@bodhchakra/outbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  logPhoneEnquiry,
  migrations,
  noticeQuoteSent,
  openDraft,
  RUNTIME_ROLE,
  seed,
  sendQuote,
} from "../src/index.ts";

const SHARMA = "10000000-0000-4000-8000-000000000001";
const SHARMA_OWNER = "10000000-0000-4000-8000-0000000a0001";
const SHARMA_GAS_REFILL = "10000000-0000-4000-8000-0000000b0002";
// Request #1, from Anita Deshpande, who gave an email.
const SHARMA_JOB_1 = "10000000-0000-4000-8000-0000000e0001";
const PUBLIC_ORIGIN = "http://localhost:45450";

const log = createLogger({ service: "test", write: () => {} });
const audit = createAudit(log);
const sharmaOwner = { businessId: SHARMA, memberId: SHARMA_OWNER };

describe("notices", () => {
  let database: TestDb;
  let app: Db;
  let owner: Db;
  let jobs: Jobs;
  let notify: Notify;
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
      await noticeQuoteSent(c, notify, { quoteId, publicOrigin: PUBLIC_ORIGIN });
      if (fail) throw new Error("the send's transaction failed");
    });
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
    jobs = createJobs({ url: database.url(RUNTIME_ROLE), log, sendOnly: true });
    const outbox = createOutbox({ jobs, log });
    await jobs.start(outbox.jobTypes);
    notify = createNotify(outbox);
  });
  afterAll(async () => {
    await jobs.stop();
    await database.drop();
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
    const quoteId = await draftFor(await phoneRequest());
    await sendWithNotice(quoteId);

    const [message] = await queued(`notify:quote.sent:${quoteId}`);
    expect(message?.payload.to).toEqual({ phone: "+919000001099" });
  });

  it("queues nothing when the send's transaction rolls back", async () => {
    const quoteId = await draftFor(await phoneRequest());
    await expect(sendWithNotice(quoteId, true)).rejects.toThrow("transaction failed");

    expect(await queued(`notify:quote.sent:${quoteId}`)).toEqual([]);
  });

  it("refuses to announce a quote that was not sent", async () => {
    const quoteId = await draftFor(await phoneRequest());
    await expect(
      sharma((c) => noticeQuoteSent(c, notify, { quoteId, publicOrigin: PUBLIC_ORIGIN })),
    ).rejects.toThrow("is not a sent quote");
  });
});
