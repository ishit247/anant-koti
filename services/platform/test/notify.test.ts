import { createHmac } from "node:crypto";
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
import { kaamkoti } from "../src/templates/kaamkoti.ts";
import type { SendWhatsApp } from "../src/whatsapp.ts";

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

/** Each WhatsApp test has a business of its own, so their quotas do not mix. */
const business = (n: number) => `00000000-0000-4000-8000-0000000002${String(n).padStart(2, "0")}`;
const QUOTA = 2;
const APP_SECRET = "meta-app-secret-for-tests";
const VERIFY_TOKEN = "verify-token-for-tests";

const quoteSent = (
  email: string | undefined,
  customerName = "Anita Deshpande",
  phone?: string,
  businessId = BUSINESS,
): NotifyMessage => ({
  businessId,
  template: "quote.sent",
  to: { ...(email && { email }), ...(phone && { phone }) },
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

  /** Numbers Meta refuses a number of times before accepting, as `refusals` does for email. */
  const waRefusals = new Map<string, number>();
  const waSent: (Parameters<SendWhatsApp>[0] & { providerId: string })[] = [];
  const sendWhatsApp: SendWhatsApp = async (message) => {
    const left = waRefusals.get(message.to) ?? 0;
    if (left > 0) {
      waRefusals.set(message.to, left - 1);
      throw Object.assign(new Error(`whatsapp: not accepted for ${message.to}`), {
        code: "WHATSAPP_131000",
        responseCode: 500,
      });
    }
    const providerId = `wamid.test-${waSent.length + 1}`;
    waSent.push({ ...message, providerId });
    return { providerId };
  };

  /** Meta's status webhook, signed with `secret`. */
  const hook = (statuses: object[], secret = APP_SECRET, signature?: string) => {
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: "waba", changes: [{ field: "messages", value: { statuses } }] }],
    });
    const signed = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    return handler(
      new Request("http://hooks/hooks/whatsapp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(signature !== "" && { "x-hub-signature-256": signature ?? signed }),
        },
        body,
      }),
    );
  };

  const byName = async (customerName: string) =>
    (
      await owner.tx((client) =>
        client.query<{ id: string; status: string; channel: string | null }>(
          "select id, status, channel from notify.message where vars->>'customerName' = $1 order by created_at",
          [customerName],
        ),
      )
    ).rows;

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
      whatsapp: {
        send: sendWhatsApp,
        appSecret: APP_SECRET,
        verifyToken: VERIFY_TOKEN,
        monthlyQuota: QUOTA,
      },
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
      hooks: notify.hooks,
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

  it("records a message with no address as having no channel, and sends nothing", async () => {
    const before = sent.length;
    await post("no-address", quoteSent(undefined, "Suresh Gowda"));

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

  describe("WhatsApp", () => {
    const providerIdOf = async (messageId: string) =>
      (
        await owner.tx((client) =>
          client.query<{ provider_id: string | null }>(
            "select provider_id from notify.message where id = $1",
            [messageId],
          ),
        )
      ).rows[0]?.provider_id;

    it("sends a message with a phone on WhatsApp, with the template's parameters in order", async () => {
      await post(
        "wa-first",
        quoteSent("kavya@example.com", "Kavya Rao", "+919000000201", business(1)),
      );

      await until(async () => (await byName("Kavya Rao"))[0]?.status === "sent", "the send");
      const [message] = await byName("Kavya Rao");
      expect(message?.channel).toBe("whatsapp");
      const wa = waSent.find((m) => m.to === "+919000000201");
      expect(wa).toMatchObject({
        name: "kaamkoti_quote_sent",
        language: "en",
        params: [
          "Kavya Rao",
          "Sharma Cooling Services",
          "₹295.00",
          "29 Nov 2026",
          "http://localhost:45450/b/sharma-cooling/requests/test-job",
        ],
      });
      expect(await providerIdOf(message?.id ?? "")).toBe(wa?.providerId);
      expect(sent.some((e) => e.to === "kavya@example.com")).toBe(false);
    });

    it("goes by email once the business's monthly quota is used, and counts per business", async () => {
      for (const n of [1, 2, 3])
        await post(
          `quota-${n}`,
          quoteSent(`q${n}@example.com`, "Quota Customer", `+91900000030${n}`, business(2)),
        );
      await post(
        "quota-other",
        quoteSent(undefined, "Other Business", "+919000000309", business(3)),
      );
      await post(
        "quota-phone-only",
        quoteSent(undefined, "Phone Only", "+919000000304", business(2)),
      );

      expect((await byName("Quota Customer")).map((m) => m.channel)).toEqual([
        "whatsapp",
        "whatsapp",
        "email",
      ]);
      expect((await byName("Other Business")).map((m) => m.channel)).toEqual(["whatsapp"]);
      // Over quota with no email: nothing to send it on.
      expect((await byName("Phone Only")).map((m) => m.status)).toEqual(["no_channel"]);
      const { rows } = await owner.tx((client) =>
        client.query<{ used: number }>("select used from notify.quota where business_id = $1", [
          business(2),
        ]),
      );
      expect(rows).toEqual([{ used: QUOTA }]);
    });

    it("sends a template with no WhatsApp version by email, without using the quota", async () => {
      await post("wa-email-only", {
        businessId: business(4),
        template: "quote.expired",
        to: { email: "owner4@example.com", phone: "+919000000401" },
        vars: {
          customerName: "Expired Quote",
          number: "#4",
          total: "₹10.00",
          link: "http://x.test/j",
        },
      });
      expect((await byName("Expired Quote")).map((m) => m.channel)).toEqual(["email"]);
      const { rows } = await owner.tx((client) =>
        client.query("select 1 from notify.quota where business_id = $1", [business(4)]),
      );
      expect(rows).toEqual([]);
    });

    it("retries a refused WhatsApp send and logs Meta's code, never the number", async () => {
      waRefusals.set("+919000000501", 1);
      await post("wa-retry", quoteSent(undefined, "Retry Customer", "+919000000501", business(5)));

      await until(async () => (await byName("Retry Customer"))[0]?.status === "sent", "the retry");
      const failure = lines.find(
        (l) => l.includes('"notify: send failed"') && l.includes("WHATSAPP_131000"),
      );
      expect(failure).toContain('"code":"WHATSAPP_131000 500"');
      for (const line of lines) expect(line).not.toContain("9000000501");
    });

    it("marks a sent message delivered, and failed with an audit when Meta says it was not delivered", async () => {
      await post(
        "wa-hook-1",
        quoteSent(undefined, "Delivered Customer", "+919000000601", business(6)),
      );
      await post(
        "wa-hook-2",
        quoteSent(undefined, "Undelivered Customer", "+919000000602", business(6)),
      );
      await until(
        async () =>
          (await byName("Delivered Customer"))[0]?.status === "sent" &&
          (await byName("Undelivered Customer"))[0]?.status === "sent",
        "both sends",
      );
      const [delivered] = await byName("Delivered Customer");
      const [undelivered] = await byName("Undelivered Customer");
      const ids = {
        delivered: await providerIdOf(delivered?.id ?? ""),
        undelivered: await providerIdOf(undelivered?.id ?? ""),
      };

      const response = await hook([
        { id: ids.delivered, status: "read", recipient_id: "919000000601" },
        {
          id: ids.undelivered,
          status: "failed",
          recipient_id: "919000000602",
          errors: [{ code: 131026, title: "Message undeliverable to 919000000602" }],
        },
        { id: "wamid.not-ours", status: "delivered" },
      ]);

      expect(response.status).toBe(200);
      expect((await byName("Delivered Customer"))[0]?.status).toBe("delivered");
      expect((await byName("Undelivered Customer"))[0]?.status).toBe("failed");
      expect((await audited(undelivered?.id ?? "")).map((e) => e.action)).toEqual([
        "notify.sent",
        "notify.failed",
      ]);
      const notice = lines.find((l) => l.includes('"notify: whatsapp not delivered"'));
      expect(notice).toContain('"code":131026');
      for (const line of lines) expect(line).not.toContain("9000000602");

      // Replayed: nothing changes twice.
      await hook([{ id: ids.undelivered, status: "failed", errors: [{ code: 131026 }] }]);
      expect(await audited(undelivered?.id ?? "")).toHaveLength(2);
    });

    it("refuses a webhook that is unsigned or signed with another secret, and changes nothing", async () => {
      await post(
        "wa-forged",
        quoteSent(undefined, "Forged Customer", "+919000000701", business(7)),
      );
      await until(async () => (await byName("Forged Customer"))[0]?.status === "sent", "the send");
      const [message] = await byName("Forged Customer");
      const id = await providerIdOf(message?.id ?? "");

      const forged = await hook([{ id, status: "failed" }], "not-the-app-secret");
      const unsigned = await hook([{ id, status: "failed" }], APP_SECRET, "");
      const garbled = await hook([{ id, status: "failed" }], APP_SECRET, "sha256=00");

      expect([forged.status, unsigned.status, garbled.status]).toEqual([401, 401, 401]);
      expect((await byName("Forged Customer"))[0]?.status).toBe("sent");
    });

    it("answers Meta's subscription handshake only with the verify token", async () => {
      const handshake = (token: string) =>
        handler(
          new Request(
            `http://hooks/hooks/whatsapp?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=1158201444`,
          ),
        );
      const right = await handshake(VERIFY_TOKEN);
      const wrong = await handshake("verify-token-for-other");

      expect([right.status, await right.text()]).toEqual([200, "1158201444"]);
      expect(wrong.status).toBe(403);
    });

    it("gives each WhatsApp body as many placeholders as its parameters, and none at either end", () => {
      for (const [name, template] of Object.entries(kaamkoti)) {
        const version = (template as { whatsapp?: { body: string; params: unknown } }).whatsapp;
        if (!version) continue;
        const placeholders = [...version.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
        const sample = Object.fromEntries(
          Object.keys((template.vars as unknown as { shape?: object }).shape ?? {}).map((k) => [
            k,
            k,
          ]),
        );
        const params = (version.params as (v: unknown) => string[])(sample);
        expect({ name, placeholders }).toEqual({
          name,
          placeholders: params.map((_, i) => i + 1),
        });
        expect(version.body).not.toMatch(/^\{\{|\}\}$/);
      }
    });
  });
});
