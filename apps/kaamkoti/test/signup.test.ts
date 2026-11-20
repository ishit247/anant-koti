import { describe, expect, it } from "vitest";
import { signupInput, slugFor } from "../src/signup.ts";

const form = { yourName: "Asha", businessName: "Sharma Cooling", city: "Pune" };

describe("signup input", () => {
  it.each([
    ["98765 43210", "+919876543210"],
    ["+44 20 7946 0958", "+442079460958"],
    ["98765-43210", "+919876543210"],
  ])("reads %s as %s", (phone, expected) => {
    expect(signupInput.parse({ ...form, phone }).phone).toBe(expected);
  });

  it.each(["12345", "5876543210", "abc", ""])("refuses the phone %j", (phone) => {
    expect(signupInput.safeParse({ ...form, phone }).success).toBe(false);
  });

  it("refuses a blank business name", () => {
    expect(
      signupInput.safeParse({ ...form, businessName: "  ", phone: "9876543210" }).success,
    ).toBe(false);
  });
});

describe("slugFor", () => {
  const valid = /^[a-z0-9]+(-[a-z0-9]+)*$/;

  it("uses the plain name first and a random suffix on a retry", () => {
    expect(slugFor("Sharma Cooling & Services!")).toBe("sharma-cooling-services");
    expect(slugFor("Sharma Cooling", 1)).toMatch(/^sharma-cooling-[0-9a-f]{4}$/);
  });

  it.each(["AB", "!!!", "ए सी", "x".repeat(200)])("always makes a legal slug from %j", (name) => {
    const slug = slugFor(name);
    expect(slug).toMatch(valid);
    expect(slug.length).toBeGreaterThanOrEqual(3);
    expect(slug.length).toBeLessThanOrEqual(60);
  });
});
