// WhatsApp over Meta's Cloud API (D7). Business-initiated messages must use a template Meta has approved, so the
// sender takes a template's name and its body's parameters, never free text. Meta's error text can quote the
// number, so a refusal is reduced to Meta's numeric code and the HTTP status.
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/** One approved template to one number (E.164). Resolves to Meta's id of the message, which its webhook names. */
export type SendWhatsApp = (message: {
  readonly to: string;
  readonly name: string;
  readonly language: string;
  readonly params: readonly string[];
  /** An authentication template's copy-code button, which Meta requires to carry the code as well. */
  readonly copyCode?: string;
}) => Promise<{ providerId: string }>;

/** The authentication template the sign-in code goes by, as submitted to Meta: "{{1}} is your verification code." */
export const SIGN_IN_CODE_TEMPLATE = { name: "sign_in_code", language: "en" } as const;

/** Identity's sign-in codes by WhatsApp: the code is the body's one parameter and the copy button's. */
export const codeTexter =
  (send: SendWhatsApp) =>
  async (phone: string, code: string): Promise<void> => {
    await send({ to: phone, ...SIGN_IN_CODE_TEMPLATE, params: [code], copyCode: code });
  };

export interface WhatsAppAccount {
  /** The Graph API base, with its version, e.g. `https://graph.facebook.com/v23.0`. */
  apiUrl: string;
  phoneNumberId: string;
  accessToken: string;
}

const accepted = z.object({
  messages: z.array(z.object({ id: z.string().min(1).max(200) })).min(1),
});
const refused = z.object({ error: z.object({ code: z.number().int() }) });

/** A refusal the notify job can log: `code` and `responseCode` only, as nodemailer's errors carry. */
const failure = (code: string, responseCode?: number) =>
  Object.assign(new Error(`whatsapp: not accepted (${code})`), { code, responseCode });

export function whatsappSender(account: WhatsAppAccount): SendWhatsApp {
  const endpoint = `${account.apiUrl.replace(/\/$/, "")}/${account.phoneNumberId}/messages`;
  return async ({ to, name, language, params, copyCode }) => {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${account.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          // Meta takes the number without its plus.
          to: to.replace(/^\+/, ""),
          type: "template",
          template: {
            name,
            language: { code: language },
            components: [
              { type: "body", parameters: params.map((text) => ({ type: "text", text })) },
              ...(copyCode === undefined
                ? []
                : [
                    {
                      type: "button",
                      sub_type: "url",
                      index: "0",
                      parameters: [{ type: "text", text: copyCode }],
                    },
                  ]),
            ],
          },
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw failure("WHATSAPP_NETWORK");
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const meta = refused.safeParse(body);
      throw failure(
        meta.success ? `WHATSAPP_${meta.data.error.code}` : "WHATSAPP",
        response.status,
      );
    }
    const sent = accepted.safeParse(body);
    if (!sent.success) throw failure("WHATSAPP_BAD_RESPONSE", response.status);
    return { providerId: (sent.data.messages[0] as { id: string }).id };
  };
}

/**
 * Meta signs each webhook with the app secret: `X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the raw body>`.
 * The signature carries no time, so a replayed body verifies; what it reports is applied idempotently.
 */
export function verifySignature(appSecret: string, body: Buffer, header: string | null): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const given = Buffer.from(header.slice("sha256=".length), "hex");
  const expected = createHmac("sha256", appSecret).update(body).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Meta's webhook, reduced to the message statuses; incoming messages and everything else are ignored. */
export const statusWebhook = z.object({
  entry: z.array(
    z.object({
      changes: z.array(
        z.object({
          value: z.object({
            statuses: z
              .array(
                z.object({
                  id: z.string().min(1).max(200),
                  status: z.string().max(40),
                  errors: z.array(z.object({ code: z.number().int() })).optional(),
                }),
              )
              .optional(),
          }),
        }),
      ),
    }),
  ),
});
