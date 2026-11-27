import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { defineConfig } from "@bodhchakra/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { platformConfig } from "../src/config.ts";
import { codeTexter, whatsappSender } from "../src/whatsapp.ts";

/** A stand-in for Meta's Graph API: records each request and answers with the next reply queued. */
describe("whatsappSender", () => {
  let server: Server;
  let apiUrl: string;
  const requests: { path: string; authorization?: string; body: unknown }[] = [];
  const replies: { status: number; body: unknown }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        requests.push({
          path: req.url ?? "",
          authorization: req.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        });
        const reply = replies.shift() ?? { status: 500, body: {} };
        res
          .writeHead(reply.status, { "content-type": "application/json" })
          .end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v23.0`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const send = () =>
    whatsappSender({ apiUrl, phoneNumberId: "1234567890", accessToken: "token-".padEnd(30, "t") })({
      to: "+919000000101",
      name: "kaamkoti_quote_sent",
      language: "en",
      params: ["Anita", "₹295.00"],
    });

  it("posts the template to the number's messages endpoint and returns Meta's message id", async () => {
    replies.push({
      status: 200,
      body: { messaging_product: "whatsapp", messages: [{ id: "wamid.ABC" }] },
    });

    expect(await send()).toEqual({ providerId: "wamid.ABC" });
    expect(requests.at(-1)).toEqual({
      path: "/v23.0/1234567890/messages",
      authorization: `Bearer ${"token-".padEnd(30, "t")}`,
      body: {
        messaging_product: "whatsapp",
        to: "919000000101",
        type: "template",
        template: {
          name: "kaamkoti_quote_sent",
          language: { code: "en" },
          components: [
            {
              type: "body",
              parameters: [
                { type: "text", text: "Anita" },
                { type: "text", text: "₹295.00" },
              ],
            },
          ],
        },
      },
    });
  });

  it("sends a sign-in code by the authentication template, in its body and its copy button", async () => {
    replies.push({ status: 200, body: { messages: [{ id: "wamid.CODE" }] } });
    const sender = whatsappSender({
      apiUrl,
      phoneNumberId: "1234567890",
      accessToken: "token-".padEnd(30, "t"),
    });
    await codeTexter(sender)("+919000000102", "042917");
    const sent = requests.at(-1)?.body as { to: string; template: unknown };
    expect(sent.to).toBe("919000000102");
    expect(sent.template).toEqual({
      name: "sign_in_code",
      language: { code: "en" },
      components: [
        { type: "body", parameters: [{ type: "text", text: "042917" }] },
        {
          type: "button",
          sub_type: "url",
          index: "0",
          parameters: [{ type: "text", text: "042917" }],
        },
      ],
    });
  });

  it("reduces a refusal to Meta's code and the HTTP status, without Meta's text", async () => {
    replies.push({
      status: 400,
      body: { error: { message: "Recipient 919000000101 is not a valid user", code: 131026 } },
    });

    const error = await send().catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "WHATSAPP_131026", responseCode: 400 });
    expect(String((error as Error).message)).not.toContain("9000000101");
  });
});

describe("platform config", () => {
  const base = {
    DATABASE_URL: "postgres://platform_app@localhost/platform",
    SERVICE_CLIENTS: JSON.stringify({ kaamkoti: "s".repeat(48) }),
    IDENTITY_ORIGIN: "http://localhost:45460",
    IDENTITY_SECRET: "i".repeat(48),
    SIGN_IN_CLIENTS: JSON.stringify({
      kaamkoti: {
        secret: "c".repeat(48),
        redirectUris: ["http://localhost:45450/auth/callback"],
        postLogoutRedirectUris: ["http://localhost:45450/"],
      },
    }),
    REDIS_URL: "redis://localhost:6379",
    SMTP_URL: "smtp://localhost:1025",
    EMAIL_FROM: "id@localhost",
    NOTIFY_EMAIL_FROM: "messages@localhost",
    BILLING_RAZORPAY_KEY_ID: "rzp_test_Platform01",
    BILLING_RAZORPAY_KEY_SECRET: "k".repeat(24),
    BILLING_RAZORPAY_WEBHOOK_SECRET: "w".repeat(24),
    BILLING_RAZORPAY_PLANS: JSON.stringify({ solo: "plan_Solo000001", team: "plan_Team000001" }),
    EVENTS_CLIENT: "kaamkoti",
    EVENTS_URL: "http://localhost:45450",
  };

  it("reads billing's plans, and stops start-up when a plan has no Razorpay plan", () => {
    expect(defineConfig(platformConfig, base).BILLING_RAZORPAY_PLANS.team).toBe("plan_Team000001");
    expect(() =>
      defineConfig(platformConfig, {
        ...base,
        BILLING_RAZORPAY_PLANS: JSON.stringify({ team: "plan_Team000001" }),
      }),
    ).toThrow(/BILLING_RAZORPAY_PLANS/);
  });

  it("stops start-up when the events app is not a service client", () => {
    expect(() => defineConfig(platformConfig, { ...base, EVENTS_CLIENT: "pos" })).toThrow(
      /EVENTS_CLIENT/,
    );
  });

  it("leaves WhatsApp off when none of its settings is given", () => {
    expect(defineConfig(platformConfig, base).whatsapp).toBeUndefined();
  });

  it("stops start-up when only some WhatsApp settings are given, naming the missing ones", () => {
    expect(() =>
      defineConfig(platformConfig, { ...base, WHATSAPP_ACCESS_TOKEN: "t".repeat(30) }),
    ).toThrow(/WHATSAPP_PHONE_NUMBER_ID.*WHATSAPP_APP_SECRET.*WHATSAPP_VERIFY_TOKEN/);
  });
});
