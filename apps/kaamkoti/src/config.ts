import { MIN_SECRET_LENGTH } from "@bodhchakra/tokens";
import { z } from "zod";

const origin = (protocols: RegExp) =>
  z.url({ protocol: protocols }).transform((url) => new URL(url).origin);

/** Request and job photos (docs/architecture.md 2); signed URLs only. */
export const PRIVATE_BUCKET = "kaamkoti-private";

/** What the web process reads from its environment; bad values stop start-up (`defineConfig`). */
export const webConfig = z.object({
  /** Connects as the runtime role, kaamkoti_app. */
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  /** Where browsers reach this app; the sign-in callback and sign-out return are built from it. */
  APP_ORIGIN: origin(/^https?$/),
  /**
   * The bare domain: public pages and the customer space (D15), with the customer sign-in callback. Another host
   * than APP_ORIGIN, so each host's session cookie stays on it (architecture 1).
   */
  PUBLIC_ORIGIN: origin(/^https?$/),
  /** Platform's public sign-in host: where browsers go, and the ID token's `iss`. */
  IDENTITY_ORIGIN: origin(/^https?$/),
  /** Platform as this app reaches it on the internal network. */
  PLATFORM_INTERNAL_URL: origin(/^https?$/),
  /** Must match the secret in platform's SIGN_IN_CLIENTS. */
  SIGN_IN_CLIENT_SECRET: z.string().min(MIN_SECRET_LENGTH),
  /** Rate-limit counters for the public request form and customer links. */
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  /** Garage's S3 API as this process reaches it, and as a browser does (presigned photo URLs). */
  S3_ENDPOINT: origin(/^https?$/),
  S3_PUBLIC_ENDPOINT: origin(/^https?$/),
  S3_REGION: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().regex(/^GK[0-9a-f]{24}$/),
  S3_SECRET_ACCESS_KEY: z.string().regex(/^[0-9a-f]{64}$/),
});

/** What the worker process reads: it runs the jobs and delivers the outbox to platform. */
export const workerConfig = z.object({
  /** Connects as the runtime role, kaamkoti_app. */
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  /** Platform as this app reaches it on the internal network; outbox messages go to its internal API. */
  PLATFORM_INTERNAL_URL: origin(/^https?$/),
  /** Signs outbox deliveries; must match `kaamkoti` in platform's SERVICE_CLIENTS. */
  SERVICE_SECRET: z.string().min(MIN_SECRET_LENGTH),
});
