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

export const platformConfig = z.object({
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
  /** Sign-in codes go out by SMTP until notify (3.2) delivers them. */
  SMTP_URL: z.url({ protocol: /^smtps?$/ }),
  EMAIL_FROM: z.string().min(3),
});
