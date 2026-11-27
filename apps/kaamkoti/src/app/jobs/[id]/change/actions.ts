"use server";
import { formatMoney } from "@bodhchakra/money";
import { currentBusiness, defineRoute } from "@bodhchakra/tenancy";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  type ChangeOrderError,
  proposeChangeOrder,
  saveChangeDraft,
} from "../../../../change-order.ts";
import { requestPageUrl } from "../../../../customer-space.ts";
import { requireMember } from "../../../../guard.ts";
import { readLines } from "../../../../quote-form.ts";
import { server } from "../../../../server.ts";
import type { QuoteEditorState } from "../quote/actions.ts";

const route = defineRoute({ scope: "member", roles: ["owner"] });

const MESSAGE: Record<ChangeOrderError, string> = {
  not_found: "That change order was not found.",
  closed: "Extra work can be priced only between acceptance and completion.",
  proposed: "This change order was already sent. Go back to the request.",
  waiting: "The customer has not answered the last change order yet. Send this one after they do.",
  lines: "A line names work that is not part of this request. Reload the page and try again.",
  negative: "The total cannot be below zero. Check the discount lines.",
  empty: "Add at least one line before sending.",
};

const ids = z.object({ jobId: z.uuid(), changeOrderId: z.uuid() });

/**
 * Saves the change-order draft, and sends it for approval if asked, in one transaction. The id comes from the
 * form, so it is only looked up inside the owner's business: another business's is "not found".
 */
export async function saveChangeAction(
  _previous: QuoteEditorState,
  form: FormData,
): Promise<QuoteEditorState> {
  const target = ids.safeParse({
    jobId: form.get("jobId"),
    changeOrderId: form.get("changeOrderId"),
  });
  if (!target.success) return { error: MESSAGE.not_found };
  const { jobId, changeOrderId } = target.data;
  const owner = await requireMember(route, `/jobs/${jobId}/change`);
  const { db, audit, notices, publicOrigin } = server();
  const state = await db.withTenant(owner.businessId, async (client): Promise<QuoteEditorState> => {
    const { currency, slug } = await currentBusiness(client);
    const read = readLines(form, currency);
    const typed = { rows: read.rows, deposit: "", valid: "" };
    if (!read.ok) return { error: read.error, typed };
    const saved = await saveChangeDraft(client, owner, changeOrderId, read.lines);
    if (!saved.ok) return { error: MESSAGE[saved.error], typed };
    const totals = {
      net: formatMoney(saved.totals.net),
      tax: formatMoney(saved.totals.tax),
      total: formatMoney(saved.totals.total),
    };
    if (form.get("intent") !== "send") return { typed, totals };
    const sent = await proposeChangeOrder(client, audit, owner, changeOrderId);
    if (!sent.ok) return { error: MESSAGE[sent.error], typed, totals };
    await notices.changeOrderProposed(client, changeOrderId);
    const link = requestPageUrl(publicOrigin, slug, sent.jobId);
    return { typed, totals, sent: { version: sent.number, link } };
  });
  revalidatePath(`/jobs/${jobId}`);
  return state;
}
