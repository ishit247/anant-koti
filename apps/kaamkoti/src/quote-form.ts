// The quote editor sends parallel fields (task, item, description, unit, quantity, price, tax), one value per
// line, plus the deposit, the validity and which button was pressed. This is the edge: it turns them into
// lines for saveDraft, or one plain message for the owner. Amounts are typed in rupees and percent.
import { minorDigits, parseDecimal } from "@bodhchakra/money";
import { z } from "zod";
import {
  MAX_QUOTE_LINES,
  QUOTE_VALID_DAYS,
  type QuoteAnswer,
  type QuoteLineInput,
} from "./quote.ts";
import { UNITS } from "./trade-template.ts";

const FIELDS = ["task", "item", "description", "unit", "quantity", "price", "tax"] as const;

/** What was typed, to put back in the form after a save or a refusal. */
export interface TypedQuote {
  readonly rows: readonly Record<(typeof FIELDS)[number], string>[];
  readonly deposit: string;
  readonly valid: string;
}

export type QuoteForm =
  | {
      readonly ok: true;
      readonly lines: QuoteLineInput[];
      readonly depositMinor: number;
      readonly validDays: number;
      /** "Send quote" rather than "Save draft". */
      readonly send: boolean;
      readonly typed: TypedQuote;
    }
  | { readonly ok: false; readonly error: string; readonly typed: TypedQuote };

const optionalId = z.union([z.literal(""), z.uuid()]).transform((id) => id || null);

/** Decimal text as whole units of 10^-places, within [min, max]. */
const decimal = (places: number, min: number, max: number) =>
  z.string().transform((text, ctx) => {
    const value = parseDecimal(text, places, min < 0);
    if (value === null || value < min || value > max) {
      ctx.addIssue({ code: "custom", message: "out of range" });
      return z.NEVER;
    }
    return value;
  });

export function readQuoteForm(form: FormData, currency: string): QuoteForm {
  const columns = FIELDS.map((field) => form.getAll(field).map(String));
  const rows = (columns[0] ?? []).map(
    (_, i) =>
      Object.fromEntries(FIELDS.map((field, c) => [field, columns[c]?.[i] ?? ""])) as Record<
        (typeof FIELDS)[number],
        string
      >,
  );
  const typed: TypedQuote = {
    rows,
    deposit: String(form.get("deposit") ?? ""),
    valid: String(form.get("valid") ?? ""),
  };
  const refuse = (error: string) => ({ ok: false as const, error, typed });

  const places = minorDigits(currency);
  const line = z.strictObject({
    task: optionalId,
    item: optionalId,
    description: z.string().trim().min(1).max(120),
    unit: z.enum(UNITS),
    quantity: decimal(3, 1, 1_000_000_000),
    price: decimal(places, -100_000_000, 100_000_000),
    tax: decimal(2, 0, 10_000),
  });
  // A line added and left empty means nothing was added.
  const entered = rows.filter((row) => row.description.trim() || row.price.trim());
  if (entered.length > MAX_QUOTE_LINES)
    return refuse(`A quote can have at most ${MAX_QUOTE_LINES} lines.`);
  const lines: QuoteLineInput[] = [];
  for (const row of entered) {
    const parsed = line.safeParse(row);
    if (!parsed.success) {
      const label = row.description.trim() || "a new line";
      return refuse(
        `Please check "${label}": it needs a description, a quantity above 0, a price like 450 or -50 for a discount, and tax in percent.`,
      );
    }
    const { task, item, description, unit, quantity, price, tax } = parsed.data;
    lines.push({
      jobTaskId: task,
      catalogueItemId: item,
      description,
      unit,
      quantityMilli: quantity,
      unitPriceMinor: price,
      taxRateBp: tax,
    });
  }
  const deposit = decimal(places, 0, 100_000_000_000).safeParse(typed.deposit.trim() || "0");
  if (!deposit.success) return refuse("The deposit must be an amount like 500, or left empty.");
  const valid = z.coerce
    .number()
    .refine((days) => (QUOTE_VALID_DAYS as readonly number[]).includes(days))
    .safeParse(typed.valid);
  if (!valid.success) return refuse("Pick how long the quote is valid.");
  return {
    ok: true,
    lines,
    depositMinor: deposit.data,
    validDays: valid.data,
    send: form.get("intent") === "send",
    typed,
  };
}

export type AnswerForm =
  | { readonly ok: true; readonly quoteId: string; readonly answer: QuoteAnswer }
  /** `form`: not a form this page sends; `counter`: the counter's price or note is not usable. */
  | { readonly ok: false; readonly error: "form" | "counter" };

/**
 * The customer's answer from their job page: which version they were looking at, the button pressed, and for
 * a counter the total they would pay (typed in rupees) and an optional note.
 */
export function readAnswerForm(form: FormData, currency: string): AnswerForm {
  const head = z
    .object({ quote: z.uuid(), answer: z.enum(["accept", "reject", "counter"]) })
    .safeParse({ quote: form.get("quote"), answer: form.get("answer") });
  if (!head.success) return { ok: false, error: "form" };
  const { quote, answer } = head.data;
  if (answer !== "counter") return { ok: true, quoteId: quote, answer: { kind: answer } };
  const counter = z
    .object({
      total: decimal(minorDigits(currency), 0, 100_000_000_000),
      note: z
        .string()
        .trim()
        .max(500)
        .transform((note) => note || null),
    })
    .safeParse({
      total: String(form.get("total") ?? "").trim(),
      note: String(form.get("note") ?? ""),
    });
  if (!counter.success) return { ok: false, error: "counter" };
  return {
    ok: true,
    quoteId: quote,
    answer: { kind: "counter", totalMinor: counter.data.total, note: counter.data.note },
  };
}
