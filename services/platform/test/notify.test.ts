import { createAudit } from "@bodhchakra/audit";
import { type Db, type TestDb, testDb } from "@bodhchakra/db";
import { createJobs, type Jobs, type JobType } from "@bodhchakra/jobs";
import { createLogger } from "@bodhchakra/log";
import { NOTIFY_TOPIC, type NotifyMessage } from "@bodhchakra/notify";
import { signRequest } from "@bodhchakra/tokens";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrations, RUNTIME_ROLE } from "../src/index.ts";
import { createNotifyService, type SendEmail } from "../src/notify.ts";
import { createHandler } from "../src/server.ts";

const SECRET = "kaamkoti-test-secret-".padEnd(48, "x");
const PATH = `/internal/v1/${NOTIFY_TOPIC}`;
const BUSINESS = "00000000-0000-4000-8000-0000000000b1";
const RETRY_LIMIT = 2;

const until = async (check: () => boolean | Promise<boolean>, what: string, ms = 20_000) => {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

const quoteSent = (email: string | undefined, customerName = "Anita Deshpande"): NotifyMessage => ({
  businessId: BUSINESS,
  template: "quote.sent",
  to: { ...(email && { email }), phone: "+919000000101" },
  vars: {
    customerName,
    businessName: "Sharma Cooling Services",
    total: "₹295.00",
    validUntil: "29 Nov 2026",
    link: "http://localhost:45450/b/sharma-cooling/requests/test-job",
  },
});

describe("notify", () => {
  let database: TestDb;
  let platform: Db;
  let owner: Db;
  let jobs: Jobs;
  let jobTypes: readonly JobType<object>[];
  let handler: (request: Request) => Promise<Response>;
  const lines: string[] = [];
  const log = createLogger({ service: "test", write: (line) => lines.push(line) });

  /** Addresses that refuse a number of sends before accepting; Infinity never accepts. */
  const refusals = new Map<string, number>();
  const sent: Parameters<SendEmail>[0][] = [];
  const sendEmail: SendEmail = async (email) => {
    const left = refusals.get(email.to) ?? 0;
    if (left > 0) {
      refusals.set(email.to, left - 1);
      // As nodemailer does: the provider's text quotes the recipient.
      throw Object.assign(
        new Error(`Can't send mail - all recipients were rejected: <${email.to}>`),
        {
          code: "EENVELOPE",
          responseCode: 450,
        },
      );
    }
    sent.push(email);
  };

  const post = (key: string, message: NotifyMessage) => {
    const body = JSON.stringify({ key, payload: message });
    return handler(
      new Request(`http://platform${PATH}`, {
        method: "POST",
        headers: signRequest({
          client: "kaamkoti",
          secret: SECRET,
          method: "POST",
          path: PATH,
          body,
        }),
        body,
      }),
    );
  };

  const row = async (email: string) =>
    (
      await owner.tx((client) =>
        client.query<{ id: string; status: string; attempts: number; channel: string | null }>(
          "select id, status, attempts, channel from notify.message where recipient->>'email' = $1",
          [email],
        ),
      )
    ).rows;

  const audited = async (entityId: string) =>
    (
      await owner.tx((client) =>
        client.query<{ action: string; data: Record<string, unknown> }>(
          "select action, data from audit.event where entity_id = $1 order by at",
          [entityId],
        ),
      )
    ).rows;

  beforeAll(async () => {
    database = await testDb({
      owner: "platform_owner",
      runtimeRole: RUNTIME_ROLE,
      folders: migrations,
    });
    platform = database.connect(RUNTIME_ROLE);
    owner = database.connect("platform_owner");
    jobs = createJobs({ url: database.url(RUNTIME_ROLE), log, pollingIntervalSeconds: 0.5 });
    const notify = createNotifyService({
      db: platform,
      jobs,
      log,
      audit: createAudit(log),
      sendEmail,
      retry: { retryLimit: RETRY_LIMIT, retryDelay: 1 },
    });
    jobTypes = notify.jobTypes;
    await jobs.start(jobTypes);
    await notify.startSending();
    handler = createHandler({
      db: platform,
      log,
      clients: { kaamkoti: SECRET },
      topics: { [NOTIFY_TOPIC]: notify.topic },
      identity: { handle: () => null },
    });
  });
  afterAll(async () => {
    await jobs.stop();
    await database.drop();
  });

  it("sends the product's template by email and audits it", async () => {
    const response = await post("first", quoteSent("anita@example.com"));
    expect(response.status).toBe(200);

    await until(async () => (await row("anita@example.com"))[0]?.status === "sent", "the send");
    const [message] = await row("anita@example.com");
    expect(message?.attempts).toBe(1);
    const email = sent.find((e) => e.to === "anita@example.com");
    expect(email?.subject).toBe("Your quote from Sharma Cooling Services: ₹295.00");
    expect(email?.text).toContain("http://localhost:45450/b/sharma-cooling/requests/test-job");
    expect(await audited(message?.id ?? "")).toEqual([
      { action: "notify.sent", data: { template: "quote.sent", attempts: 1 } },
    ]);
  });

  it("retries a failed send and logs each failure without personal data", async () => {
    refusals.set("rahul@example.com", 2);
    await post("retried", quoteSent("rahul@example.com", "Rahul Joshi"));

    await until(
      async () => (await row("rahul@example.com"))[0]?.status === "sent",
      "the retried send",
    );
    const [message] = await row("rahul@example.com");
    expect(message?.attempts).toBe(3);
    const failures = lines.filter(
      (line) => line.includes('"notify: send failed"') && line.includes(message?.id ?? "none"),
    );
    expect(failures).toHaveLength(2);
    expect(failures[0]).toContain('"code":"EENVELOPE 450"');
    for (const line of lines) {
      expect(line).not.toContain("rahul@example.com");
      expect(line).not.toContain("Rahul Joshi");
    }
  });

  it("marks a message failed and alerts once its retries are spent", async () => {
    refusals.set("meera@example.com", Number.POSITIVE_INFINITY);
    await post("never", quoteSent("meera@example.com"));

    await until(async () => (await row("meera@example.com"))[0]?.status === "failed", "giving up");
    const [message] = await row("meera@example.com");
    expect(message?.attempts).toBe(RETRY_LIMIT + 1);
    expect(
      lines.some(
        (line) =>
          line.includes('"notify: message not sent after all retries"') &&
          line.includes(message?.id ?? "none"),
      ),
    ).toBe(true);
    expect((await audited(message?.id ?? "")).map((event) => event.action)).toEqual([
      "notify.failed",
    ]);
  });

  it("records a message with no email as having no channel, and sends nothing", async () => {
    const before = sent.length;
    await post("phone-only", quoteSent(undefined, "Suresh Gowda"));

    const { rows } = await owner.tx((client) =>
      client.query<{ id: string; status: string; channel: string | null }>(
        "select id, status, channel from notify.message where vars->>'customerName' = 'Suresh Gowda'",
      ),
    );
    expect(rows.map(({ status, channel }) => ({ status, channel }))).toEqual([
      { status: "no_channel", channel: null },
    ]);
    expect((await audited(rows[0]?.id ?? "")).map((event) => event.action)).toEqual([
      "notify.no_channel",
    ]);
    expect(sent.length).toBe(before);
  });

  it("records a repeated delivery once", async () => {
    await post("twice", quoteSent("lakshmi@example.com"));
    const again = await post("twice", quoteSent("lakshmi@example.com"));

    expect(await again.json()).toEqual({ status: "duplicate" });
    expect(await row("lakshmi@example.com")).toHaveLength(1);
  });

  it("sends a member's message to the email of their identity", async () => {
    const identityId = "00000000-0000-4000-8000-0000000000c1";
    await owner.tx((client) =>
      client.query(
        `insert into identity."user" (id, name, email, "emailVerified") values ($1, 'Ravi Sharma', 'ravi@example.com', true)`,
        [identityId],
      ),
    );
    await post("to-owner", {
      businessId: BUSINESS,
      template: "quote.response",
      to: { identityId },
      vars: {
        answer: "countered",
        customerName: "Anita Deshpande",
        number: "#12",
        total: "₹295.00",
        offered: "₹250.00",
        link: "http://127.0.0.1:45450/jobs/x",
      },
    });

    await until(async () => (await row("ravi@example.com"))[0]?.status === "sent", "the send");
    const email = sent.find((e) => e.to === "ravi@example.com");
    expect(email?.subject).toBe("Anita Deshpande offered a different price (#12)");
    expect(email?.text).toContain("offered ₹250.00 for your quote of ₹295.00");
  });

  it("records a message to an unknown identity as having no channel", async () => {
    await post("to-nobody", {
      businessId: BUSINESS,
      template: "request.edited",
      to: { identityId: "00000000-0000-4000-8000-0000000000c9" },
      vars: { customerName: "Nobody Known", number: "#3", link: "http://127.0.0.1:45450/jobs/y" },
    });
    const { rows } = await owner.tx((client) =>
      client.query<{ status: string }>(
        "select status from notify.message where vars->>'customerName' = 'Nobody Known'",
      ),
    );
    expect(rows).toEqual([{ status: "no_channel" }]);
  });

  it("purges messages older than 30 days and keeps the rest", async () => {
    await owner.tx((client) =>
      client.query(
        `insert into notify.message (product, business_id, template, channel, recipient, vars, status, created_at)
         select 'kaamkoti', $1, 'quote.sent', null, '{}', jsonb_build_object('customerName', name), 'no_channel',
                now() - make_interval(days => age)
         from (values ('Old Message', 31), ('Recent Message', 29)) as m(name, age)`,
        [BUSINESS],
      ),
    );
    const purge = jobTypes.find((type) => type.name === "notify.purge");
    if (!purge) throw new Error("notify has no purge job");
    await platform.tx((client) => jobs.send(client, purge, {}));

    const left = async () =>
      (
        await owner.tx((client) =>
          client.query<{ name: string }>(
            "select vars->>'customerName' as name from notify.message where vars->>'customerName' like '% Message'",
          ),
        )
      ).rows.map((r) => r.name);
    await until(async () => !(await left()).includes("Old Message"), "the purge");
    expect(await left()).toEqual(["Recent Message"]);
  });

  it("schedules the purge daily, and leaves the runtime role no delete of its own", async () => {
    const { rows } = await owner.tx((client) =>
      client.query("select cron from pgboss.schedule where name = 'notify.purge'"),
    );
    expect(rows).toEqual([{ cron: "30 21 * * *" }]);
    await expect(
      platform.tx((client) => client.query("delete from notify.message")),
    ).rejects.toThrow("permission denied");
  });

  it("refuses a template the product does not have, and variables it does not take", async () => {
    const unknown = await post("unknown", {
      ...quoteSent("x@example.com"),
      template: "quote.lost",
    });
    const bad = quoteSent("y@example.com");
    const badVars = await post("bad-vars", { ...bad, vars: { ...bad.vars, link: "not a link" } });

    expect([unknown.status, badVars.status]).toEqual([500, 500]);
    expect([...(await row("x@example.com")), ...(await row("y@example.com"))]).toEqual([]);
    const refusal = lines.find((line) => line.includes("has bad variables"));
    expect(refusal).toContain("(link)");
    expect(refusal).not.toContain("not a link");
  });
});
