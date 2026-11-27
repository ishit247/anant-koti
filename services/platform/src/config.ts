import { PLANS } from "@bodhchakra/billing";
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
  /** Razorpay's API for subscriptions (D6), on the platform's own account. Development points it at a fake. */
  BILLING_RAZORPAY_API: z
    .url({ protocol: /^https?$/ })
    .transform((url) => new URL(url).origin)
    .default("https://api.razorpay.com"),
  BILLING_RAZORPAY_KEY_ID: z.string().regex(/^rzp_(test|live)_[A-Za-z0-9]{6,40}$/),
  BILLING_RAZORPAY_KEY_SECRET: z.string().min(16),
  /** Set on the platform account's webhook to `https://hooks.<platform-tld>/hooks/razorpay`. */
  BILLING_RAZORPAY_WEBHOOK_SECRET: z.string().min(16),
  /** Each plan's Razorpay plan id, e.g. `{"solo":"plan_…","team":"plan_…"}`; the prices are set there (D9). */
  // An enum-keyed record needs every plan.
  BILLING_RAZORPAY_PLANS: jsonObject.pipe(
    z.record(z.enum(PLANS), z.string().regex(/^plan_[A-Za-z0-9]{6,40}$/)),
  ),
  /** The app that receives billing's status events, by its client id in SERVICE_CLIENTS. */
  EVENTS_CLIENT: clientId,
  /** That app's internal base URL; events go to `<url>/internal/v1/<topic>`. */
  EVENTS_URL: z.url({ protocol: /^https?$/ }).transform((url) => new URL(url).origin),
});

export const platformConfig = settings.transform((config, ctx) => {
  if (!Object.hasOwn(config.SERVICE_CLIENTS, config.EVENTS_CLIENT)) {
    ctx.addIssue({ code: "custom", path: ["EVENTS_CLIENT"], message: "is not in SERVICE_CLIENTS" });
    return z.NEVER;
  }
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
    ...rest
  } = config;
  const whatsapp =
    WHATSAPP_PHONE_NUMBER_ID &&
    WHATSAPP_ACCESS_TOKEN &&
    WHATSAPP_APP_SECRET &&
    WHATSAPP_VERIFY_TOKEN
      ? {
          apiUrl: WHATSAPP_API_URL,
          phoneNumberId: WHATSAPP_PHONE_NUMBER_ID,
          accessToken: WHATSAPP_ACCESS_TOKEN,
          appSecret: WHATSAPP_APP_SECRET,
          verifyToken: WHATSAPP_VERIFY_TOKEN,
        }
      : undefined;
  return { ...rest, whatsapp };
});
