import { scanRoutes } from "@bodhchakra/tenancy";
import { describe, expect, it } from "vitest";

describe("Kaam Koti routes", () => {
  it("declares its scope in every page, route handler, layout and server-action file", async () => {
    const { routes, undeclared } = await scanRoutes(new URL("../src/", import.meta.url));

    expect(routes.length).toBeGreaterThan(0);
    expect(undeclared).toEqual([]);
  });
});
