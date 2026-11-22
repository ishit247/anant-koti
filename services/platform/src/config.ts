import { MIN_SECRET_LENGTH } from "@bodhchakra/tokens";
import { z } from "zod";

const jsonObject = z.string().transform((text, ctx) => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    ctx.addIssue({ code: "custom", message: "must be a JSON object" });
    return z.NEVER;
  }
});

const clientId = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);

/** The apps allowed to call platform, by client id, each with the secret it signs with (docs/architecture.md 9.1). */
const serviceClients = jsonObject.pipe(
  z
    .record(clientId, z.string().min(MIN_SECRET_LENGTH))
    .refine((clients) => Object.keys(clients).length > 0, "names no client"),
);

/**
 * The apps that sign people in through platform (docs/architecture.md 3), by client id. Every one is a
 * first-party confidential client: it skips consent and must use PKCE.
 */
const signInClients = jsonObject.pipe(
  z
    .record(
      clientId,
      z.object({
        secret: z.string().min(MIN_SECRET_LENGTH),
        redirectUris: z.array(z.url()).min(1),
        postLogoutRedirectUris: z.array(z.url()).min(1),
      }),
    )
    .refine((clients) => Object.keys(clients).length > 0, "names no client"),
);

export type SignInClients = z.infer<typeof signInClients>;

/** The WhatsApp channel's settings: all set, or none (the channel is off and email is the one channel). */
const WHATSAPP_KEYS = [
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_VERIFY_TOKEN",
  "NOTIFY_WHATSAPP_MONTHLY_QUOTA",
] as const;

const settings = z.object({
  /** Connects as the runtime role, platform_app. */
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  SERVICE_CLIENTS: serviceClients,
  /** The public origin of the sign-in host (`https://id.<platform-tld>`): the `iss` of every ID token. */
  IDENTITY_ORIGIN: z.url({ protocol: /^https?$/ }).transform((url) => new URL(url).origin),
  /** Signs better-auth's cookies and seals its signing keys and stored codes. */
  IDENTITY_SECRET: z.string().min(MIN_SECRET_LENGTH),
  SIGN_IN_CLIENTS: signInClients,
  /** Rate-limit counters only; nothing that must survive a restart. */
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  /** Sign-in codes and notify's email channel. */
  SMTP_URL: z.url({ protocol: /^smtps?$/ }),
  /** The sign-in codes' sender. */
  EMAIL_FROM: z.string().min(3),
  /** The sender of notify's emails to customers and owners. */
  NOTIFY_EMAIL_FROM: z.string().min(3),
  /** Meta's Graph API, with its version. Tests point it at a fake. */
  WHATSAPP_API_URL: z.url({ protocol: /^https?$/ }).default("https://graph.facebook.com/v23.0"),
  /** The sending number's id in Meta's WhatsApp Manager (not the number itself). */
  WHATSAPP_PHONE_NUMBER_ID: z
    .string()
    .regex(/^[0-9]{1,30}$/)
    .optional(),
  /** A system user's permanent token with `whatsapp_business_messaging`. */
  WHATSAPP_ACCESS_TOKEN: z.string().min(20).optional(),
  /** The Meta app's secret, which signs the status webhook. */
  WHATSAPP_APP_SECRET: z.string().min(16).optional(),
  /** Any random string, given to Meta when the webhook is subscribed. */
  WHATSAPP_VERIFY_TOKEN: z.string().min(16).optional(),
  /** WhatsApp messages per business per month, until plans carry the quota (5.1). */
  NOTIFY_WHATSAPP_MONTHLY_QUOTA: z.coerce.number().int().min(1).optional(),
});

export const platformConfig = settings.transform((config, ctx) => {
  const set = WHATSAPP_KEYS.filter((key) => config[key] !== undefined);
  if (set.length > 0 && set.length < WHATSAPP_KEYS.length) {
    for (const key of WHATSAPP_KEYS.filter((k) => !set.includes(k)))
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: "required with the other WHATSAPP_ settings",
      });
    return z.NEVER;
  }
  const {
    WHATSAPP_API_URL,
    WHATSAPP_PHONE_NUMBER_ID,
    WHATSAPP_ACCESS_TOKEN,
    WHATSAPP_APP_SECRET,
    WHATSAPP_VERIFY_TOKEN,
    NOTIFY_WHATSAPP_MONTHLY_QUOTA,
    ...rest
  } = config;
  const whatsapp =
    WHATSAPP_PHONE_NUMBER_ID &&
    WHATSAPP_ACCESS_TOKEN &&
    WHATSAPP_APP_SECRET &&
    WHATSAPP_VERIFY_TOKEN &&
    NOTIFY_WHATSAPP_MONTHLY_QUOTA
      ? {
          apiUrl: WHATSAPP_API_URL,
          phoneNumberId: WHATSAPP_PHONE_NUMBER_ID,
          accessToken: WHATSAPP_ACCESS_TOKEN,
          appSecret: WHATSAPP_APP_SECRET,
          verifyToken: WHATSAPP_VERIFY_TOKEN,
          monthlyQuota: NOTIFY_WHATSAPP_MONTHLY_QUOTA,
        }
      : undefined;
  return { ...rest, whatsapp };
});
