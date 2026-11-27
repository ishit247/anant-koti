// The Razorpay side (D5): Payment Links API calls, and the webhook's signature and body. Nothing outside this
// module sees Razorpay's shapes; Stripe, when it comes, is a second file like this one.
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const RAZORPAY_API = "https://api.razorpay.com";
const TIMEOUT_MS = 10_000;

export interface Credentials {
  keyId: string;
  keySecret: string;
}

export interface LinkRequest {
  referenceId: string;
  amountMinor: number;
  currency: string;
  acceptPartial: boolean;
  description: string;
  customer?: { name: string; email?: string; phone?: string };
  /** Unix seconds; Razorpay's default is six months. */
  expireBy?: number;
  notes: Record<string, string>;
}

const createdLink = z.object({
  id: z.string().regex(/^plink_[A-Za-z0-9]{6,40}$/),
  short_url: z.url({ protocol: /^https$/ }),
});
const providerError = z.object({ error: z.object({ code: z.string() }).optional() });

async function call(
  api: string,
  credentials: Credentials,
  path: string,
  body: unknown,
): Promise<unknown> {
  const response = await fetch(new URL(path, api), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Basic ${Buffer.from(`${credentials.keyId}:${credentials.keySecret}`).toString("base64")}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    // Only Razorpay's error code goes into the message: the description can echo customer details back.
    const code = providerError.safeParse(json).data?.error?.code ?? "unknown";
    throw new Error(`payments: razorpay ${path} refused with ${response.status} (${code})`);
  }
  return json;
}

export async function createLink(
  api: string,
  credentials: Credentials,
  link: LinkRequest,
): Promise<{ providerLinkId: string; url: string }> {
  const created = createdLink.parse(
    await call(api, credentials, "/v1/payment_links", {
      amount: link.amountMinor,
      currency: link.currency,
      accept_partial: link.acceptPartial,
      ...(link.acceptPartial ? { first_min_partial_amount: 100 } : {}),
      reference_id: link.referenceId,
      description: link.description,
      ...(link.customer
        ? {
            customer: {
              name: link.customer.name,
              ...(link.customer.email ? { email: link.customer.email } : {}),
              ...(link.customer.phone ? { contact: link.customer.phone } : {}),
            },
          }
        : {}),
      ...(link.expireBy ? { expire_by: link.expireBy } : {}),
      // Our notify sends the link, in the business's name; Razorpay's own SMS and email would be a second copy.
      notify: { sms: false, email: false },
      reminder_enable: false,
      notes: link.notes,
    }),
  );
  return { providerLinkId: created.id, url: created.short_url };
}

export async function cancelLink(
  api: string,
  credentials: Credentials,
  providerLinkId: string,
): Promise<void> {
  await call(
    api,
    credentials,
    `/v1/payment_links/${encodeURIComponent(providerLinkId)}/cancel`,
    {},
  );
}

/** `X-Razorpay-Signature`: hex HMAC-SHA256 of the raw body under the webhook secret. It has no timestamp. */
export function signatureValid(rawBody: string, signature: string, secret: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}

/** The test kit's signer, also what Razorpay does. */
export function sign(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

const linkEntity = z.object({
  id: z.string().regex(/^plink_[A-Za-z0-9]{6,40}$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
});
const paymentEntity = z.object({
  id: z.string().regex(/^pay_[A-Za-z0-9]{6,40}$/),
  amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  currency: z.string().regex(/^[A-Z]{3}$/),
  status: z.string(),
  method: z.string().max(40),
});

/** The events this module acts on; every other event is acknowledged and ignored. */
export const webhookBody = z.union([
  z
    .object({
      event: z.enum(["payment_link.paid", "payment_link.partially_paid"]),
      payload: z.object({
        payment_link: z.object({ entity: linkEntity }),
        payment: z.object({ entity: paymentEntity }),
      }),
    })
    .transform((body) => ({ ...body, kind: "paid" as const })),
  z
    .object({
      event: z.enum(["payment_link.cancelled", "payment_link.expired"]),
      payload: z.object({ payment_link: z.object({ entity: linkEntity }) }),
    })
    .transform((body) => ({ ...body, kind: "closed" as const })),
]);
export type WebhookBody = z.infer<typeof webhookBody>;
