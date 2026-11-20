import { MIN_SECRET_LENGTH } from "@bodhchakra/tokens";
import { z } from "zod";

/** The apps allowed to call platform, by client id, each with the secret it signs with (docs/architecture.md 9.1). */
const serviceClients = z
  .string()
  .transform((text, ctx) => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      ctx.addIssue({ code: "custom", message: "must be a JSON object of client id to secret" });
      return z.NEVER;
    }
  })
  .pipe(
    z
      .record(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), z.string().min(MIN_SECRET_LENGTH))
      .refine((clients) => Object.keys(clients).length > 0, "names no client"),
  );

export const platformConfig = z.object({
  /** Connects as the runtime role, platform_app. */
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  SERVICE_CLIENTS: serviceClients,
});
