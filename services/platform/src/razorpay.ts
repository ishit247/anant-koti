// Razorpay Subscriptions on the platform's own account (D6): what businesses pay us. Customer payments to a
// business use that business's account and live in @bodhchakra/payments; the two share the provider, not the
// account or the code path. Nothing outside billing sees these shapes.
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const TIMEOUT_MS = 10_000;
/** Razorpay needs an end; monthly plans run ten years unless cancelled. */
const TOTAL_COUNT = 120;

export interface RazorpayAccount {
  /** `https://api.razorpay.com`; tests and the browser check point it at a fake. */
  api: string;
  keyId: string;
  keySecret: string;
  /** Signs the subscription webhook. */
  webhookSecret: string;
}

const providerId = z.string().regex(/^sub_[A-Za-z0-9]{6,40}$/);
const created = z.object({ id: providerId, short_url: z.url({ protocol: /^https?$/ }) });
const providerError = z.object({ error: z.object({ code: z.string() }).optional() });

async function call(account: RazorpayAccount, path: string, body: unknown): Promise<unknown> {
  const response = await fetch(new URL(path, account.api), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Basic ${Buffer.from(`${account.keyId}:${account.keySecret}`).toString("base64")}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    // Only Razorpay's error code: its description can echo the payer's details.
    const code = providerError.safeParse(json).data?.error?.code ?? "unknown";
    throw new Error(`billing: razorpay ${path} refused with ${response.status} (${code})`);
  }
  return json;
}

export async function createSubscription(
  account: RazorpayAccount,
  request: {
    planId: string;
    seats: number;
    /** Unix seconds: the first charge, at the trial's end. Absent: charged when authorised. */
    startAt?: number;
    notes: Record<string, string>;
  },
): Promise<{ providerId: string; url: string }> {
  const subscription = created.parse(
    await call(account, "/v1/subscriptions", {
      plan_id: request.planId,
      quantity: request.seats,
      total_count: TOTAL_COUNT,
      customer_notify: 1,
      ...(request.startAt ? { start_at: request.startAt } : {}),
      notes: request.notes,
    }),
  );
  return { providerId: subscription.id, url: subscription.short_url };
}

export async function cancelSubscription(account: RazorpayAccount, id: string): Promise<void> {
  await call(account, `/v1/subscriptions/${encodeURIComponent(id)}/cancel`, {
    cancel_at_cycle_end: 0,
  });
}

/** `X-Razorpay-Signature`: hex HMAC-SHA256 of the raw body under the webhook secret. It has no timestamp. */
export function signatureValid(rawBody: string, signature: string | null, secret: string): boolean {
  if (signature === null || !/^[0-9a-f]{64}$/.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}

/** What Razorpay does; for tests and the browser check's fake. */
export function sign(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

/** The events billing acts on, and what each does to the subscription. Others are acknowledged and ignored. */
export const EVENTS = {
  "subscription.authenticated": "authorised",
  "subscription.activated": "paid",
  "subscription.charged": "paid",
  "subscription.pending": "past_due",
  "subscription.halted": "past_due",
  "subscription.cancelled": "cancelled",
  "subscription.completed": "cancelled",
} as const;
export type EventEffect = (typeof EVENTS)[keyof typeof EVENTS];

const unixSeconds = z.number().int().positive();

export const eventName = z.object({ event: z.string() });
export const subscriptionEvent = z.object({
  event: z.enum(Object.keys(EVENTS) as [keyof typeof EVENTS, ...(keyof typeof EVENTS)[]]),
  /** When Razorpay made the event: the order they are applied in, whatever order they arrive in. */
  created_at: unixSeconds,
  payload: z.object({
    subscription: z.object({
      entity: z.object({
        id: providerId,
        plan_id: z.string().min(1).max(60),
        quantity: z.number().int().min(1).max(100).default(1),
        /** The end of the period now paid for; null before the first charge. */
        current_end: unixSeconds.nullable().default(null),
      }),
    }),
  }),
});
export type SubscriptionEvent = z.infer<typeof subscriptionEvent>;
