import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineConfig } from "./index";

const schema = z.object({ DATABASE_URL: z.string().url(), PORT: z.coerce.number().default(3000) });

describe("defineConfig", () => {
  it("returns typed, coerced values with defaults applied", () => {
    const cfg = defineConfig(schema, { DATABASE_URL: "postgres://localhost/db" });
    expect(cfg.PORT).toBe(3000);
  });

  it("returns a frozen object", () => {
    const cfg = defineConfig(schema, { DATABASE_URL: "postgres://localhost/db" });
    expect(Object.isFrozen(cfg)).toBe(true);
  });

  it("throws naming the bad variable but not its value", () => {
    expect(() => defineConfig(schema, { DATABASE_URL: "s3cret-not-a-url" })).toThrow(
      /DATABASE_URL/,
    );
    expect(() => defineConfig(schema, { DATABASE_URL: "s3cret-not-a-url" })).not.toThrow(/s3cret/);
  });
});
