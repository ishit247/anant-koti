import { describe, expect, it } from "vitest";
import { defineRoute, scanRoutes } from "../src/index.ts";

const fixtures = new URL("./fixtures/routes/", import.meta.url);

describe("scanRoutes", () => {
  it("finds pages, layouts, route handlers and server-action files, and nothing else", async () => {
    const { routes } = await scanRoutes(fixtures);

    expect(routes).toEqual([
      "app/api/webhooks/razorpay/route.ts",
      "app/jobs/[id]/page.ts",
      "app/jobs/actions.ts",
      "app/layout.ts",
      "app/page.ts",
    ]);
  });

  it("reports every route without an exported declaration", async () => {
    const { undeclared } = await scanRoutes(fixtures);

    expect(undeclared).toEqual(["app/jobs/[id]/page.ts", "app/jobs/actions.ts"]);
  });

  it("fails on a directory that does not exist, instead of passing with no routes", async () => {
    await expect(scanRoutes(new URL("./no-such-dir/", fixtures))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("defineRoute", () => {
  it("returns the declaration frozen", () => {
    const route = defineRoute({ scope: "member", roles: ["owner"] });

    expect(route).toEqual({ scope: "member", roles: ["owner"] });
    expect(Object.isFrozen(route)).toBe(true);
  });

  it("does not compile a member route that names no roles, or an unknown scope", () => {
    // @ts-expect-error a member route must say which roles it allows
    defineRoute({ scope: "member" });
    // @ts-expect-error not a scope
    defineRoute({ scope: "anyone" });
  });
});
