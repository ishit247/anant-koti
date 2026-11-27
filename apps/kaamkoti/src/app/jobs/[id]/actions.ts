"use server";
import { minorDigits, parseDecimal } from "@bodhchakra/money";
import { currentBusiness, defineRoute } from "@bodhchakra/tenancy";
import { redirect } from "next/navigation";
import { z } from "zod";
import { cancelJob } from "../../../cancel.ts";
import { openChangeDraft } from "../../../change-order.ts";
import { requireMember } from "../../../guard.ts";
import { bill, recordCash, voidInvoice } from "../../../invoice.ts";
import { openDraft } from "../../../quote.ts";
import {
  confirmVisitFor,
  isPlannedVisitOf,
  planVisit,
  type VisitAnswerError,
  type VisitError,
  type VisitKind,
} from "../../../schedule.ts";
import { server } from "../../../server.ts";

const route = defineRoute({ scope: "member", roles: ["owner"] });

export interface PlanVisitState {
  readonly error?: string;
}

const VISIT_ERROR: Record<VisitError, string> = {
  input: "Check the date, time and length of the visit.",
  not_found: "That request was not found.",
  closed: "This request cannot take that visit now.",
  technician: "Choose someone from your team.",
  conflict: "That person already has a visit at that time. Pick another time or person.",
};

/** Plans a site visit or the work. The job and technician come from the form, so both are checked in the business. */
export async function planVisitAction(
  _previous: PlanVisitState,
  form: FormData,
): Promise<PlanVisitState> {
  const jobId = z.uuid().safeParse(form.get("jobId"));
  if (!jobId.success) return { error: VISIT_ERROR.not_found };
  const owner = await requireMember(route, `/jobs/${jobId.data}`);
  const { db, audit, notices } = server();
  const result = await db.withTenant(owner.businessId, async (client) => {
    const planned = await planVisit(client, audit, owner, {
      jobId: jobId.data,
      kind: String(form.get("kind")) as VisitKind,
      technicianId: String(form.get("technicianId")),
      start: String(form.get("start")),
      minutes: form.get("minutes"),
    });
    if (planned.ok && planned.status === "proposed")
      await notices.visitProposed(client, planned.appointmentId);
    else if (planned.ok) await notices.visitPlanned(client, planned.appointmentId);
    return planned;
  });
  if (!result.ok) return { error: VISIT_ERROR[result.error] };
  redirect(`/jobs/${jobId.data}`);
}

export interface ConfirmVisitState {
  readonly error?: string;
}

const CONFIRM_ERROR: Record<VisitAnswerError, string> = {
  not_found: "That visit was not found.",
  answered: "The customer has already answered this time, or a newer one was proposed.",
  closed: "This request cannot be scheduled now.",
};

/** The customer agreed to the proposed time another way (by phone): the owner confirms it for them. */
export async function confirmVisitAction(
  _previous: ConfirmVisitState,
  form: FormData,
): Promise<ConfirmVisitState> {
  const jobId = z.uuid().safeParse(form.get("jobId"));
  if (!jobId.success) return { error: CONFIRM_ERROR.not_found };
  const owner = await requireMember(route, `/jobs/${jobId.data}`);
  const { db, audit, notices } = server();
  const appointmentId = String(form.get("appointmentId"));
  const result = await db.withTenant(owner.businessId, async (client) => {
    const confirmed = await confirmVisitFor(client, audit, owner, appointmentId);
    if (confirmed.ok) await notices.visitPlanned(client, appointmentId);
    return confirmed;
  });
  if (!result.ok) return { error: CONFIRM_ERROR[result.error] };
  redirect(`/jobs/${jobId.data}`);
}

export interface OnTheWayState {
  readonly error?: string;
  readonly sent?: boolean;
}

/** The owner has set out for a planned visit: the customer is told. */
export async function onTheWayAction(
  _previous: OnTheWayState,
  form: FormData,
): Promise<OnTheWayState> {
  const jobId = z.uuid().safeParse(form.get("jobId"));
  const appointmentId = z.uuid().safeParse(form.get("appointmentId"));
  if (!jobId.success || !appointmentId.success) return { error: CONFIRM_ERROR.not_found };
  const owner = await requireMember(route, `/jobs/${jobId.data}`);
  const { db, notices } = server();
  const found = await db.withTenant(owner.businessId, async (client) => {
    if (!(await isPlannedVisitOf(client, jobId.data, appointmentId.data))) return false;
    await notices.visitOnTheWay(client, appointmentId.data);
    return true;
  });
  return found ? { sent: true } : { error: CONFIRM_ERROR.not_found };
}

export interface CancelJobState {
  readonly error?: string;
}

/** The owner cancels the request: its visits and any open payment link go with it (architecture 6). */
export async function cancelJobAction(
  _previous: CancelJobState,
  form: FormData,
): Promise<CancelJobState> {
  const jobId = z.uuid().safeParse(form.get("jobId"));
  if (!jobId.success) return { error: "That request was not found." };
  const owner = await requireMember(route, `/jobs/${jobId.data}`);
  const { db, audit, payments } = server();
  const result = await db.withTenant(owner.businessId, (client) =>
    cancelJob(client, audit, payments, owner.businessId, jobId.data, {
      role: "owner",
      memberId: owner.memberId,
    }),
  );
  if (!result.ok) {
    return {
      error:
        result.error === "refused"
          ? "This request has moved on too far to be cancelled."
          : "That request was not found.",
    };
  }
  redirect(`/jobs/${jobId.data}`);
}

export interface StartQuoteState {
  readonly error?: string;
}

/** Opens the job's draft (a new version if none is open) and goes to the editor. */
export async function startQuote(
  _previous: StartQuoteState,
  form: FormData,
): Promise<StartQuoteState> {
  const jobId = z.uuid().safeParse(form.get("jobId"));
  if (!jobId.success) return { error: "That request was not found." };
  const owner = await requireMember(route, `/jobs/${jobId.data}`);
  const result = await server().db.withTenant(owner.businessId, (client) =>
    openDraft(client, owner, jobId.data),
  );
  if (!result.ok) {
    return {
      error:
        result.error === "closed"
          ? "This request has moved on, so it cannot be quoted again."
          : "That request was not found.",
    };
  }
  redirect(`/jobs/${jobId.data}/quote`);
}

export interface InvoiceState {
  readonly error?: string;
}

/** Cash the owner took for the job, typed in rupees (4.4); the bill is paid once it is covered. */
export async function recordCashAction(
  _previous: InvoiceState,
  form: FormData,
): Promise<InvoiceState> {
  const jobId = z.uuid().safeParse(form.get("jobId"));
  if (!jobId.success) return { error: "That request was not found." };
  const owner = await requireMember(route, `/jobs/${jobId.data}`);
  const { db, audit, payments } = server();
  const result = await db.withTenant(owner.businessId, async (client) => {
    const { currency } = await currentBusiness(client);
    const minor = parseDecimal(String(form.get("amount") ?? "").trim(), minorDigits(currency));
    if (minor === null) return { ok: false as const, error: "too_much" as const };
    return recordCash(client, audit, payments, owner, jobId.data, minor);
  });
  if (!result.ok) {
    return {
      error:
        result.error === "too_much"
          ? "Enter an amount up to what is still owed."
          : result.error === "closed"
            ? "Nothing is owed on this request now."
            : "That request was not found.",
    };
  }
  redirect(`/jobs/${jobId.data}`);
}

/** Voids the job's invoice; the owner may then issue a new one (4.4). */
export async function voidInvoiceAction(
  _previous: InvoiceState,
  form: FormData,
): Promise<InvoiceState> {
  const jobId = z.uuid().safeParse(form.get("jobId"));
  if (!jobId.success) return { error: "That request was not found." };
  const owner = await requireMember(route, `/jobs/${jobId.data}`);
  const { db, audit, payments } = server();
  const result = await db.withTenant(owner.businessId, (client) =>
    voidInvoice(client, audit, payments, owner, jobId.data),
  );
  if (!result.ok) {
    return {
      error:
        result.error === "none"
          ? "This request has no invoice to void."
          : "That request was not found.",
    };
  }
  redirect(`/jobs/${jobId.data}`);
}

/** Issues the completed job's invoice: after a void, or once extra work is answered (4.4). */
export async function issueInvoiceAction(
  _previous: InvoiceState,
  form: FormData,
): Promise<InvoiceState> {
  const jobId = z.uuid().safeParse(form.get("jobId"));
  if (!jobId.success) return { error: "That request was not found." };
  const owner = await requireMember(route, `/jobs/${jobId.data}`);
  const deps = server();
  const result = await deps.db.withTenant(owner.businessId, (client) =>
    bill(client, deps, jobId.data),
  );
  if (!result.ok) {
    return {
      error:
        result.error === "waiting"
          ? "Extra work is waiting for the customer's answer; the invoice follows it."
          : result.error === "issued"
            ? "This request already has an invoice."
            : result.error === "closed"
              ? "Only completed work is invoiced."
              : "That request was not found.",
    };
  }
  redirect(`/jobs/${jobId.data}`);
}

/** Opens the job's change-order draft (a new one if none is open) and goes to the editor (4.3). */
export async function startChange(
  _previous: StartQuoteState,
  form: FormData,
): Promise<StartQuoteState> {
  const jobId = z.uuid().safeParse(form.get("jobId"));
  if (!jobId.success) return { error: "That request was not found." };
  const owner = await requireMember(route, `/jobs/${jobId.data}`);
  const result = await server().db.withTenant(owner.businessId, (client) =>
    openChangeDraft(client, owner, jobId.data),
  );
  if (!result.ok) {
    return {
      error:
        result.error === "closed"
          ? "Extra work can be priced only between acceptance and the invoice. Void the invoice to add more."
          : "That request was not found.",
    };
  }
  redirect(`/jobs/${jobId.data}/change`);
}
