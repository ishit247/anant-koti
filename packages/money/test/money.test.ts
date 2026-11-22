import { describe, expect, it } from "vitest";
import {
  formatDecimal,
  formatMoney,
  lineTotals,
  minorDigits,
  money,
  parseDecimal,
} from "../src/index.ts";

const inr = (minor: number) => money(minor, "INR");

describe("lineTotals", () => {
  it("multiplies quantity by price and adds tax on each line, then sums the lines", () => {
    const totals = lineTotals(
      [
        { quantityMilli: 1000, unitPriceMinor: 250_000, taxRateBp: 1800 },
        { quantityMilli: 2000, unitPriceMinor: 80_000, taxRateBp: 1800 },
      ],
      "INR",
    );
    expect(totals.lines).toEqual([
      { net: inr(250_000), tax: inr(45_000) },
      { net: inr(160_000), tax: inr(28_800) },
    ]);
    expect([totals.net, totals.tax, totals.total]).toEqual([
      inr(410_000),
      inr(73_800),
      inr(483_800),
    ]);
  });

  it("takes fractional quantities in thousandths", () => {
    // 1.5 hours at ₹333.33 = ₹499.995, rounded half up to ₹500.00.
    const [line] = lineTotals(
      [{ quantityMilli: 1500, unitPriceMinor: 33_333, taxRateBp: 0 }],
      "INR",
    ).lines;
    expect(line?.net).toEqual(inr(50_000));
  });

  it("rounds each line's tax, and the total is the sum of rounded lines, not the tax of the sum", () => {
    // Each line: ₹0.03 at 18 % = 0.54 paise of tax, rounded to 1. The sum's tax would be 1.08 → 1.
    const line = { quantityMilli: 1000, unitPriceMinor: 3, taxRateBp: 1800 };
    const totals = lineTotals([line, line], "INR");
    expect(totals.tax).toEqual(inr(2));
    expect(totals.total).toEqual(inr(8));
  });

  it("rounds a half away from zero, so a discount mirrors the charge it offsets", () => {
    const charge = { quantityMilli: 500, unitPriceMinor: 1, taxRateBp: 5000 };
    const discount = { ...charge, unitPriceMinor: -1 };
    const totals = lineTotals([charge, discount], "INR");
    expect(totals.lines.map((l) => [l.net.minor, l.tax.minor])).toEqual([
      [1, 1],
      [-1, -1],
    ]);
    expect(totals.total).toEqual(inr(0));
  });

  it("charges no tax at a zero rate, the default for traders not registered for GST", () => {
    const totals = lineTotals(
      [{ quantityMilli: 1000, unitPriceMinor: 99_999, taxRateBp: 0 }],
      "INR",
    );
    expect([totals.tax, totals.total]).toEqual([inr(0), inr(99_999)]);
  });

  it("gives zero totals for no lines", () => {
    expect(lineTotals([], "INR").total).toEqual(inr(0));
  });

  it.each([
    ["a zero quantity", { quantityMilli: 0, unitPriceMinor: 100, taxRateBp: 0 }],
    ["a fractional thousandth", { quantityMilli: 1.5, unitPriceMinor: 100, taxRateBp: 0 }],
    ["a fractional price", { quantityMilli: 1000, unitPriceMinor: 0.5, taxRateBp: 0 }],
    ["a tax rate above 100 %", { quantityMilli: 1000, unitPriceMinor: 100, taxRateBp: 10_001 }],
    ["a negative tax rate", { quantityMilli: 1000, unitPriceMinor: 100, taxRateBp: -1 }],
  ])("refuses %s", (_, line) => {
    expect(() => lineTotals([line], "INR")).toThrow(RangeError);
  });

  it("refuses a total too large to hold exactly instead of losing paise", () => {
    const huge = {
      quantityMilli: Number.MAX_SAFE_INTEGER,
      unitPriceMinor: 1_000_000,
      taxRateBp: 0,
    };
    expect(() => lineTotals([huge], "INR")).toThrow(/too large/);
  });

  it("refuses a currency that is not an ISO code", () => {
    expect(() => lineTotals([], "rupees")).toThrow(RangeError);
  });
});

describe("money", () => {
  it("refuses a fractional amount", () => {
    expect(() => money(10.5, "INR")).toThrow(RangeError);
  });
});

describe("formatMoney", () => {
  it("shows rupees with Indian grouping", () => {
    expect(formatMoney(inr(12_345_678))).toBe("₹1,23,456.78");
  });

  it("shows a discount as negative", () => {
    expect(formatMoney(inr(-5_000))).toBe("-₹50.00");
  });

  it("follows the currency's minor unit", () => {
    expect(minorDigits("JPY")).toBe(0);
    expect(formatMoney(money(1500, "JPY"))).toBe("JP¥1,500");
  });
});

describe("parseDecimal", () => {
  it.each([
    ["450", 2, 45_000],
    ["450.5", 2, 45_050],
    [" 1250.75 ", 2, 125_075],
    ["1.5", 3, 1500],
    ["0.001", 3, 1],
  ])("reads %s with %i places as %i", (text, places, expected) => {
    expect(parseDecimal(text, places)).toBe(expected);
  });

  it("reads a minus only when signed", () => {
    expect(parseDecimal("-50", 2, true)).toBe(-5000);
    expect(parseDecimal("-50", 2)).toBeNull();
  });

  it.each(["", "abc", "1.234", "1e3", "1,000", "+5", "."])("refuses %j", (text) => {
    expect(parseDecimal(text, 2, true)).toBeNull();
  });
});

describe("formatDecimal", () => {
  it.each([
    [45_000, 2, "450"],
    [45_050, 2, "450.5"],
    [5, 2, "0.05"],
    [-5_000, 2, "-50"],
    [1500, 3, "1.5"],
    [1, 3, "0.001"],
  ])("writes %i with %i places as %s, which parseDecimal reads back", (value, places, text) => {
    expect(formatDecimal(value, places)).toBe(text);
    expect(parseDecimal(text, places, true)).toBe(value);
  });
});
