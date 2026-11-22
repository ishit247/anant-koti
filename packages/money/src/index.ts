// Money as integers (docs/architecture.md 8): an amount is a whole number of minor units (paise) with its ISO
// currency, a quantity is a whole number of thousandths, a tax rate is basis points. Nothing here goes through
// floating point except formatting for display.

export interface Money {
  /** Minor units (paise for INR); negative for a discount. */
  readonly minor: number;
  /** ISO 4217, upper case. */
  readonly currency: string;
}

const CURRENCY = /^[A-Z]{3}$/;

/** An amount; throws on a fractional or unsafe amount, or a currency that is not an ISO code. */
export function money(minor: number, currency: string): Money {
  if (!Number.isSafeInteger(minor))
    throw new RangeError(`money: ${minor} is not a whole safe amount`);
  if (!CURRENCY.test(currency)) throw new RangeError(`money: "${currency}" is not an ISO currency`);
  return { minor, currency };
}

export interface Line {
  /** Thousandths: 1.5 hours is 1500. Must be positive. */
  readonly quantityMilli: number;
  /** Per unit, tax-exclusive; negative for a discount line. */
  readonly unitPriceMinor: number;
  /** Basis points: 18 % is 1800. */
  readonly taxRateBp: number;
}

export interface LineAmounts {
  readonly net: Money;
  readonly tax: Money;
}

export interface Totals {
  /** One per input line, in the same order. */
  readonly lines: readonly LineAmounts[];
  readonly net: Money;
  readonly tax: Money;
  readonly total: Money;
}

/**
 * Line-level rounding, as GST invoices do: each line's net is quantity × price rounded to a minor unit, its tax
 * is net × rate rounded, and the totals are sums of the rounded lines. Halves round away from zero, so a
 * discount line mirrors the charge it offsets (and matches Postgres `round(numeric)`). Throws on an input out of
 * range or a result too large to hold exactly.
 */
export function lineTotals(lines: readonly Line[], currency: string): Totals {
  money(0, currency);
  let net = 0n;
  let tax = 0n;
  const amounts = lines.map((line, i) => {
    const { quantityMilli, unitPriceMinor, taxRateBp } = line;
    if (!Number.isSafeInteger(quantityMilli) || quantityMilli <= 0)
      throw new RangeError(
        `lineTotals: line ${i} quantity ${quantityMilli} is not a positive whole`,
      );
    if (!Number.isSafeInteger(unitPriceMinor))
      throw new RangeError(`lineTotals: line ${i} price ${unitPriceMinor} is not a whole amount`);
    if (!Number.isInteger(taxRateBp) || taxRateBp < 0 || taxRateBp > 10_000)
      throw new RangeError(`lineTotals: line ${i} tax rate ${taxRateBp} is outside 0–10000 bp`);
    const lineNet = divideRounded(BigInt(quantityMilli) * BigInt(unitPriceMinor), 1000n);
    const lineTax = divideRounded(lineNet * BigInt(taxRateBp), 10_000n);
    net += lineNet;
    tax += lineTax;
    return { net: exact(lineNet, currency), tax: exact(lineTax, currency) };
  });
  return {
    lines: amounts,
    net: exact(net, currency),
    tax: exact(tax, currency),
    total: exact(net + tax, currency),
  };
}

/** n / d rounded half away from zero; d is positive. BigInt division truncates toward zero. */
function divideRounded(n: bigint, d: bigint): bigint {
  const quotient = n / d;
  const remainder = n % d;
  const twice = 2n * (remainder < 0n ? -remainder : remainder);
  if (twice < d) return quotient;
  return n < 0n ? quotient - 1n : quotient + 1n;
}

function exact(minor: bigint, currency: string): Money {
  if (minor > BigInt(Number.MAX_SAFE_INTEGER) || minor < BigInt(Number.MIN_SAFE_INTEGER))
    throw new RangeError(`money: ${minor} is too large to hold exactly`);
  return money(Number(minor), currency);
}

const digits = new Map<string, number>();

/** How many decimal places the currency's minor unit has: 2 for INR, 0 for JPY. */
export function minorDigits(currency: string): number {
  money(0, currency);
  let places = digits.get(currency);
  if (places === undefined) {
    places =
      new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2;
    digits.set(currency, places);
  }
  return places;
}

const formats = new Map<string, Intl.NumberFormat>();

/** For display only: "₹2,950.00", "-₹50.00". The locale is en-IN until a market needs another. */
export function formatMoney(amount: Money): string {
  let format = formats.get(amount.currency);
  if (!format) {
    format = new Intl.NumberFormat("en-IN", { style: "currency", currency: amount.currency });
    formats.set(amount.currency, format);
  }
  return format.format(amount.minor / 10 ** minorDigits(amount.currency));
}

/**
 * Decimal text as typed ("450", "450.5", "-50") to a whole number of 10^-places units, without floating point:
 * `parseDecimal("1.5", 3)` is 1500. Null when the text is not such a number; `signed` allows a leading minus.
 */
export function parseDecimal(text: string, places: number, signed = false): number | null {
  const match = /^(-?)(\d{1,12})(?:\.(\d+))?$/.exec(text.trim());
  if (!match) return null;
  const [, sign = "", whole = "0", fraction = ""] = match;
  if (sign && !signed) return null;
  if (fraction.length > places) return null;
  const value = Number(whole) * 10 ** places + Number(fraction.padEnd(places, "0") || "0");
  return sign && value !== 0 ? -value : value;
}

/** The inverse of parseDecimal, for a form field: `formatDecimal(45050, 2)` is "450.5", 1500 at 3 is "1.5". */
export function formatDecimal(value: number, places: number): string {
  if (!Number.isSafeInteger(value))
    throw new RangeError(`formatDecimal: ${value} is not a whole number`);
  const digits = String(Math.abs(value)).padStart(places + 1, "0");
  const whole = digits.slice(0, digits.length - places);
  const fraction = digits.slice(digits.length - places).replace(/0+$/, "");
  return `${value < 0 ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}
