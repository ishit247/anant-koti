import type { z } from "zod";

/**
 * Parse environment variables once at start-up. Throws listing the offending variable names
 * (never their values, which may be secrets) so that bad config stops the process.
 */
export function defineConfig<S extends z.ZodType>(
  schema: S,
  env: Record<string, string | undefined> = process.env,
): Readonly<z.output<S>> {
  const result = schema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid configuration: ${problems}`);
  }
  return Object.freeze(result.data);
}
