"use server";
import { defineRoute } from "@bodhchakra/tenancy";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireMember } from "../../../guard.ts";
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
