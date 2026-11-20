import { MIN_SECRET_LENGTH } from "@bodhchakra/tokens";
import { z } from "zod";

const origin = (protocols: RegExp) =>
  z.url({ protocol: protocols }).transform((url) => new URL(url).origin);

/** What the web process reads from its environment; bad values stop start-up (`defineConfig`). */
export const webConfig = z.object({
  /** Connects as the runtime role, kaamkoti_app. */
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  /** Where browsers reach this app; the sign-in callback and sign-out return are built from it. */
  APP_ORIGIN: origin(/^https?$/),
  /** Platform's public sign-in host: where browsers go, and the ID token's `iss`. */
  IDENTITY_ORIGIN: origin(/^https?$/),
  /** Platform as this app reaches it on the internal network. */
  PLATFORM_INTERNAL_URL: origin(/^https?$/),
  /** Must match the secret in platform's SIGN_IN_CLIENTS. */
  SIGN_IN_CLIENT_SECRET: z.string().min(MIN_SECRET_LENGTH),
});
