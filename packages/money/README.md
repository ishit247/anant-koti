# @bodhchakra/money

Money as integers (docs/architecture.md 8). Layer: foundation, no dependencies. Kaam Koti prices quotes with
it; invoices (4.3) and payments (4.1) use the same arithmetic.

## API

| Export                             | What it does                                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| `money(minor, currency)`           | An amount `{ minor, currency }`; throws on a fractional or unsafe amount or a non-ISO currency. |
| `lineTotals(lines, currency)`      | Each line's `net` and `tax`, and the `net`, `tax` and `total` of all lines, as `Money`.         |
| `formatMoney(amount)`              | Display text, `en-IN`: "₹1,23,456.78", "-₹50.00".                                               |
| `minorDigits(currency)`            | Decimal places of the minor unit: 2 for INR, 0 for JPY.                                         |
| `parseDecimal(text, places, sign)` | Typed decimal text to whole `10^-places` units without floating point; null if not a number.    |
| `formatDecimal(value, places)`     | The inverse, for a form field: `formatDecimal(45050, 2)` is "450.5".                            |
| `Money`, `Line`, `Totals`…         | The types.                                                                                      |

A line is `{ quantityMilli, unitPriceMinor, taxRateBp }`: quantity in thousandths (1.5 hours is 1500), the
tax-exclusive unit price in minor units (negative for a discount), the tax rate in basis points (18 % is 1800).

## Rules it enforces

- Line-level rounding, as GST invoices do: net = round(quantity × price / 1000), tax = round(net × rate /
  10000), totals are sums of rounded lines. Halves round away from zero, which is Postgres `round(numeric)`,
  so a database `CHECK` can restate the same rule; a discount line mirrors the charge it offsets.
- The arithmetic runs in `BigInt`; a result that a JavaScript number cannot hold exactly throws instead of
  losing paise. Inputs out of range (quantity not positive, rate outside 0–10000) throw `RangeError`.
- All lines of one call share one currency, so mixing currencies cannot happen inside a total. A business has one
  currency in the MVP. `add` and other arithmetic across amounts arrive with their first use (payments, 4.1).
- Only `formatMoney` uses floating point, for display.

A total below zero is legal arithmetic; refusing it is the caller's rule (a quote or invoice must not be negative).
