import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { migrations as auditMigrations, createAudit } from "@bodhchakra/audit";
import { type Db, type DbClient, type TestDb, testDb } from "@bodhchakra/db";
import { createLogger } from "@bodhchakra/log";
import { money } from "@bodhchakra/money";
import { migrations as outboxMigrations } from "@bodhchakra/outbox";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPayments,
  migrations,
  type PaymentEvent,
  type Payments,
  signRazorpayWebhook,
} from "../src/index.ts";

interface Asked {
  path: string;
  authorization: string | undefined;
  body: Record<string, unknown>;
}

const read = async (request: IncomingMessage) => {
  let text = "";
  for await (const chunk of request) text += chunk;
  return text;
};

describe("payments", () => {
  let database: TestDb;
  let app: Db;
  let owner: Db;
  let payments: Payments;
  let stub: Server;
  let asked: Asked[];
  let linkNumber = 0;

  const businessA = randomUUID();
  const businessB = randomUUID();
  const memberA = randomUUID();
  const secretA = "whsec-a-0123456789";
  const secretB = "whsec-b-9876543210";

  const count = (sql: string, params: unknown[] = []) =>
    owner.tx(async (client) => Number((await client.query<{ n: string }>(sql, params)).rows[0]?.n));

  beforeAll(async () => {
    database = await testDb({
      owner: "kaamkoti_owner",
      runtimeRole: "kaamkoti_app",
      folders: [auditMigrations, outboxMigrations, migrations],
    });
    app = database.connect("kaamkoti_app");
    owner = database.connect("kaamkoti_owner");

    stub = createServer(async (request, response) => {
      const body = JSON.parse((await read(request)) || "{}") as Record<string, unknown>;
      asked.push({ path: request.url ?? "", authorization: request.headers.authorization, body });
      if (request.url === "/v1/payment_links") {
        linkNumber += 1;
        const id = `plink_Test${String(linkNumber).padStart(6, "0")}`;
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ id, short_url: `https://rzp.io/i/${id}`, status: "created" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    await new Promise<void>((done) => stub.listen(0, "127.0.0.1", done));

    const log = createLogger({ service: "test", write: () => {} });
    payments = createPayments({
      sealingKey: randomBytes(32).toString("base64"),
      audit: createAudit(log),
      log,
      razorpayApi: `http://127.0.0.1:${(stub.address() as AddressInfo).port}`,
    });
    for (const [businessId, webhookSecret] of [
      [businessA, secretA],
      [businessB, secretB],
    ] as const) {
      await app.withTenant(businessId, (client) =>
        payments.connectAccount(client, {
          businessId,
          keyId: "rzp_test_AbCdEf123456",
          keySecret: `key-secret-${businessId}`,
          webhookSecret,
          by: memberA,
        }),
      );
    }
  });
  afterAll(async () => {
    stub.closeAllConnections();
    stub.close();
    await database.drop();
  });
  beforeEach(() => {
    asked = [];
  });

  const newLink = (subjectId = randomUUID(), minor = 50_000, acceptPartial = false) =>
    app.withTenant(businessA, (client) =>
      payments.createPaymentLink(client, {
        businessId: businessA,
        subjectId,
        purpose: "deposit",
        amount: money(minor, "INR"),
        acceptPartial,
        description: "Deposit for the bathroom job",
      }),
    );

  const providerLinkId = (linkId: string) =>
    owner.tx(
      async (client) =>
        (
          await client.query<{ p: string }>(
            "select provider_link_id as p from payments.link where id = $1",
            [linkId],
          )
        ).rows[0]?.p as string,
    );

  const paidBody = (
    plink: string,
    paymentId: string,
    amount: number,
    event = "payment_link.paid",
  ): string =>
    JSON.stringify({
      entity: "event",
      account_id: "acc_Test",
      event,
      contains: ["payment_link", "order", "payment"],
      payload: {
        payment_link: { entity: { id: plink, currency: "INR", status: "paid" } },
        payment: {
          entity: { id: paymentId, amount, currency: "INR", status: "captured", method: "upi" },
        },
      },
      created_at: 1_764_000_000,
    });

  const deliver = (
    rawBody: string,
    { businessId = businessA, secret = secretA as string | null } = {},
  ) => {
    const events: PaymentEvent[] = [];
    const outcome = payments.handleWebhook(
      app,
      {
        businessId,
        signature: secret === null ? null : signRazorpayWebhook(rawBody, secret),
        rawBody,
      },
      async (_client: DbClient, event) => {
        events.push(event);
      },
    );
    return { outcome, events };
  };

  const paid = (subjectId: string) =>
    app.withTenant(businessA, (client) => payments.paidFor(client, subjectId, "INR"));

  describe("creating a link", () => {
    it("asks Razorpay on the business's own keys, with our link id as the reference and no Razorpay messages", async () => {
      const link = await newLink();

      expect(asked).toHaveLength(1);
      expect(asked[0]?.authorization).toBe(
        `Basic ${Buffer.from(`rzp_test_AbCdEf123456:key-secret-${businessA}`).toString("base64")}`,
      );
      expect(asked[0]?.body).toMatchObject({
        amount: 50_000,
        currency: "INR",
        reference_id: link.id,
        notify: { sms: false, email: false },
      });
      expect(link).toMatchObject({
        status: "created",
        url: expect.stringMatching(/^https:\/\/rzp\.io\//),
      });
    });

    it("sends the payer back to the return URL by a plain GET", async () => {
      await app.withTenant(businessA, (client) =>
        payments.createPaymentLink(client, {
          businessId: businessA,
          subjectId: randomUUID(),
          purpose: "deposit",
          amount: money(10_000, "INR"),
          acceptPartial: false,
          description: "Deposit",
          returnUrl: "https://kaamkoti.example/b/sharma/requests/1",
        }),
      );

      expect(asked[0]?.body).toMatchObject({
        callback_url: "https://kaamkoti.example/b/sharma/requests/1",
        callback_method: "get",
      });
    });

    it("tells a connected business's key id, and nothing for one without an account", async () => {
      const connected = await app.withTenant(businessA, (c) =>
        payments.connectedAccount(c, businessA),
      );
      const none = randomUUID();
      const missing = await app.withTenant(none, (c) => payments.connectedAccount(c, none));

      expect([connected, missing]).toEqual([{ keyId: "rzp_test_AbCdEf123456" }, null]);
    });

    it("returns the open link for the same subject and purpose instead of making a second", async () => {
      const subjectId = randomUUID();
      const first = await newLink(subjectId);
      const second = await newLink(subjectId);

      expect(second.id).toBe(first.id);
      expect(asked).toHaveLength(1);
    });

    it("records nothing as paid: a created link is money asked for, not received", async () => {
      const link = await newLink();

      expect(link.paid.minor).toBe(0);
      expect((await paid(link.subjectId)).minor).toBe(0);
    });

    it("stores the secrets sealed, never as plain text", async () => {
      const stored = await count(
        `select count(*) as n from payments.account
         where position(convert_to($1, 'utf8') in key_secret) > 0
            or position(convert_to($2, 'utf8') in webhook_secret) > 0`,
        [`key-secret-${businessA}`, secretA],
      );
      expect(stored).toBe(0);
    });

    it("cannot use a sealed secret copied into another business's row", async () => {
      const businessC = randomUUID();
      await owner.tx((client) =>
        client.query(
          `insert into payments.account (business_id, provider, key_id, key_secret, webhook_secret)
           select $2, provider, key_id, key_secret, webhook_secret from payments.account where business_id = $1`,
          [businessA, businessC],
        ),
      );

      await expect(
        app.withTenant(businessC, (client) =>
          payments.createPaymentLink(client, {
            businessId: businessC,
            subjectId: randomUUID(),
            purpose: "deposit",
            amount: money(10_000, "INR"),
            acceptPartial: false,
            description: "x",
          }),
        ),
      ).rejects.toThrow();
      expect(asked).toHaveLength(0);
    });
  });

  describe("the webhook", () => {
    it("records a verified payment, marks the link paid and hands the app the event in the same transaction", async () => {
      const link = await newLink();
      const { outcome, events } = deliver(
        paidBody(await providerLinkId(link.id), "pay_Paid000001", 50_000),
      );

      expect(await outcome).toBe("applied");
      expect(events).toEqual([
        expect.objectContaining({
          kind: "payment.received",
          payment: expect.objectContaining({ method: "online", amount: money(50_000, "INR") }),
          link: expect.objectContaining({ id: link.id, status: "paid" }),
        }),
      ]);
      expect((await paid(link.subjectId)).minor).toBe(50_000);
      expect(
        await count(
          "select count(*) as n from audit.event where action = 'payment.recorded' and data->>'linkId' = $1",
          [link.id],
        ),
      ).toBe(1);
    });

    it("refuses a forged signature and records nothing", async () => {
      const link = await newLink();
      const { outcome, events } = deliver(
        paidBody(await providerLinkId(link.id), "pay_Forged0001", 50_000),
        { secret: "guessed-secret" },
      );

      expect(await outcome).toBe("refused");
      expect(events).toHaveLength(0);
      expect((await paid(link.subjectId)).minor).toBe(0);
    });

    it("refuses a webhook with no signature", async () => {
      const link = await newLink();
      const { outcome } = deliver(
        paidBody(await providerLinkId(link.id), "pay_NoSign0001", 50_000),
        {
          secret: null,
        },
      );

      expect(await outcome).toBe("refused");
    });

    it("refuses a body signed by another business, sent to this business's URL", async () => {
      const link = await newLink();
      const { outcome } = deliver(
        paidBody(await providerLinkId(link.id), "pay_Other00001", 50_000),
        {
          secret: secretB,
        },
      );

      expect(await outcome).toBe("refused");
      expect((await paid(link.subjectId)).minor).toBe(0);
    });

    it("does not let one business's verified webhook pay another business's link", async () => {
      const link = await newLink();
      const { outcome } = deliver(
        paidBody(await providerLinkId(link.id), "pay_CrossB0001", 50_000),
        {
          businessId: businessB,
          secret: secretB,
        },
      );

      expect(await outcome).toBe("ignored");
      expect((await paid(link.subjectId)).minor).toBe(0);
    });

    it("acknowledges a replayed webhook without applying it again", async () => {
      const link = await newLink();
      const body = paidBody(await providerLinkId(link.id), "pay_Replay0001", 50_000);
      await deliver(body).outcome;

      const replay = deliver(body);

      expect(await replay.outcome).toBe("duplicate");
      expect(replay.events).toHaveLength(0);
      expect((await paid(link.subjectId)).minor).toBe(50_000);
    });

    it("records a payment once even when it arrives again in a differently worded event", async () => {
      const link = await newLink(randomUUID(), 50_000, true);
      const plink = await providerLinkId(link.id);
      await deliver(paidBody(plink, "pay_Twice00001", 20_000, "payment_link.partially_paid"))
        .outcome;

      const again = deliver(paidBody(plink, "pay_Twice00001", 20_000, "payment_link.paid"));

      expect(await again.outcome).toBe("ignored");
      expect((await paid(link.subjectId)).minor).toBe(20_000);
    });

    it("adds part-payments up, and the link is paid only when they reach its amount", async () => {
      const link = await newLink(randomUUID(), 50_000, true);
      const plink = await providerLinkId(link.id);

      const first = deliver(
        paidBody(plink, "pay_Part000001", 20_000, "payment_link.partially_paid"),
      );
      await first.outcome;
      const second = deliver(paidBody(plink, "pay_Part000002", 30_000));
      await second.outcome;

      expect(first.events[0]).toMatchObject({ link: { status: "partially_paid" } });
      expect(second.events[0]).toMatchObject({
        link: { status: "paid", paid: money(50_000, "INR") },
      });
      expect((await paid(link.subjectId)).minor).toBe(50_000);
    });

    it("refuses a payment beyond the link's amount and records none of it", async () => {
      const link = await newLink(randomUUID(), 50_000, true);

      await expect(
        deliver(paidBody(await providerLinkId(link.id), "pay_TooMuch001", 60_000)).outcome,
      ).rejects.toThrow("beyond its amount");
      expect((await paid(link.subjectId)).minor).toBe(0);
    });

    it("rolls the payment and the inbox back when the app's handler fails, so Razorpay's retry applies it", async () => {
      const link = await newLink();
      const body = paidBody(await providerLinkId(link.id), "pay_Retry00001", 50_000);
      const request = {
        businessId: businessA,
        signature: signRazorpayWebhook(body, secretA),
        rawBody: body,
      };

      await expect(
        payments.handleWebhook(app, request, async () => {
          throw new Error("invoice update failed");
        }),
      ).rejects.toThrow("invoice update failed");
      expect((await paid(link.subjectId)).minor).toBe(0);

      expect(await payments.handleWebhook(app, request, async () => {})).toBe("applied");
      expect((await paid(link.subjectId)).minor).toBe(50_000);
    });

    it("ignores a payment on a link we did not create", async () => {
      expect(await deliver(paidBody("plink_NotOurs001", "pay_Stranger01", 50_000)).outcome).toBe(
        "ignored",
      );
    });

    it("closes an open link when Razorpay reports it expired", async () => {
      const link = await newLink();
      const body = JSON.stringify({
        event: "payment_link.expired",
        payload: {
          payment_link: { entity: { id: await providerLinkId(link.id), currency: "INR" } },
        },
      });
      const { outcome, events } = deliver(body);

      expect(await outcome).toBe("applied");
      expect(events[0]).toMatchObject({
        kind: "link.closed",
        link: { id: link.id, status: "expired" },
      });
    });
  });

  describe("cancelling and cash", () => {
    it("cancels an open link at Razorpay and here", async () => {
      const link = await newLink();
      const plink = await providerLinkId(link.id);
      asked = [];

      await app.withTenant(businessA, (client) =>
        payments.cancelLink(client, { businessId: businessA, linkId: link.id }),
      );

      expect(asked.map((a) => a.path)).toEqual([`/v1/payment_links/${plink}/cancel`]);
      const [after] = await app.withTenant(businessA, (client) =>
        payments.linksFor(client, link.subjectId),
      );
      expect(after?.status).toBe("cancelled");
    });

    it("adds a member's cash payment to what the subject has received, and audits it", async () => {
      const link = await newLink(randomUUID(), 50_000, true);
      await deliver(
        paidBody(
          await providerLinkId(link.id),
          "pay_Mixed00001",
          20_000,
          "payment_link.partially_paid",
        ),
      ).outcome;

      const cash = await app.withTenant(businessA, (client) =>
        payments.recordManual(client, {
          businessId: businessA,
          subjectId: link.subjectId,
          amount: money(30_000, "INR"),
          by: memberA,
        }),
      );

      expect((await paid(link.subjectId)).minor).toBe(50_000);
      expect(
        await count(
          "select count(*) as n from audit.event where entity_id = $1 and actor_id = $2",
          [cash.id, memberA],
        ),
      ).toBe(1);
    });
  });

  describe("the database", () => {
    it("shows a business none of another's links or payments", async () => {
      const link = await newLink();
      await deliver(paidBody(await providerLinkId(link.id), "pay_Isolate001", 50_000)).outcome;

      const seen = await app.withTenant(businessB, async (client) => ({
        links: (await payments.linksFor(client, link.subjectId)).length,
        paid: (await payments.paidFor(client, link.subjectId, "INR")).minor,
      }));
      expect(seen).toEqual({ links: 0, paid: 0 });
    });

    it("never lets the app change or delete a recorded payment", async () => {
      const subjectId = randomUUID();
      await app.withTenant(businessA, (client) =>
        payments.recordManual(client, {
          businessId: businessA,
          subjectId,
          amount: money(1_000, "INR"),
          by: memberA,
        }),
      );

      await expect(
        app.withTenant(businessA, (client) =>
          client.query("update payments.payment set amount_minor = 1 where subject_id = $1", [
            subjectId,
          ]),
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        app.withTenant(businessA, (client) =>
          client.query("delete from payments.payment where subject_id = $1", [subjectId]),
        ),
      ).rejects.toThrow(/permission denied/);
    });
  });
});
