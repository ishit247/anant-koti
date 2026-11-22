"use server";
import { formatMoney } from "@bodhchakra/money";
import { currentBusiness, defineRoute } from "@bodhchakra/tenancy";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireMember } from "../../../../guard.ts";
import { issueJobLink } from "../../../../job-link.ts";
import { type QuoteError, saveDraft, sendQuote } from "../../../../quote.ts";
import { readQuoteForm, type TypedQuote } from "../../../../quote-form.ts";
import { server } from "../../../../server.ts";

const route = defineRoute({ scope: "member", roles: ["owner"] });

export interface QuoteEditorState {
  readonly error?: string;
  /** What was typed, put back after every answer (React resets the form after an action). */
  readonly typed?: TypedQuote;
  /** The saved totals, as display text. */
  readonly totals?: { readonly net: string; readonly tax: string; readonly total: string };
  readonly sent?: {
    readonly version: number;
    /** The new customer link's secret, shown once in the owner's own response; only its hash is stored. */
    readonly secret: string;
  };
}

const MESSAGE: Record<QuoteError, string> = {
  not_found: "That quote was not found.",
  closed: "This request has moved on, so it cannot be quoted.",
  sent: "This version was already sent. Go back to the request to revise it.",
  lines: "A line names work that is not part of this request. Reload the page and try again.",
  negative: "The total cannot be below zero. Check the discount lines.",
  deposit: "The deposit cannot be more than the total.",
  empty: "Add at least one line before sending.",
};

const ids = z.object({ jobId: z.uuid(), quoteId: z.uuid() });

/**
 * Saves the draft, and sends it if "Send quote" was pressed, in one transaction. The quote id comes from the
 * form, so it is only looked up inside the owner's business: another business's quote is "not found".
 */
export async function saveQuoteAction(
  _previous: QuoteEditorState,
  form: FormData,
): Promise<QuoteEditorState> {
  const target = ids.safeParse({ jobId: form.get("jobId"), quoteId: form.get("quoteId") });
  if (!target.success) return { error: MESSAGE.not_found };
  const { jobId, quoteId } = target.data;
  const owner = await requireMember(route, `/jobs/${jobId}/quote`);
  const { db, audit } = server();
  const state = await db.withTenant(owner.businessId, async (client): Promise<QuoteEditorState> => {
    const { currency } = await currentBusiness(client);
    const parsed = readQuoteForm(form, currency);
    if (!parsed.ok) return { error: parsed.error, typed: parsed.typed };
    const { typed } = parsed;
    const saved = await saveDraft(client, owner, quoteId, parsed);
    if (!saved.ok) return { error: MESSAGE[saved.error], typed };
    const totals = {
      net: formatMoney(saved.totals.net),
      tax: formatMoney(saved.totals.tax),
      total: formatMoney(saved.totals.total),
    };
    if (!parsed.send) return { typed, totals };
    const sent = await sendQuote(client, audit, owner, quoteId, parsed.validDays);
    if (!sent.ok) return { error: MESSAGE[sent.error], typed, totals };
    // Each message carries a fresh link (architecture.md 7); this one carries the quote.
    const { secret } = await issueJobLink(client, sent.jobId);
    return { typed, totals, sent: { version: sent.version, secret } };
  });
  revalidatePath(`/jobs/${jobId}`);
  return state;
}
