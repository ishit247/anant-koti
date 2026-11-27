"use server";
import { defineRoute } from "@bodhchakra/tenancy";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { extraWorkInput } from "../../../change-order.ts";
import { requireMember } from "../../../guard.ts";
import { server } from "../../../server.ts";
import {
  addFoundWork,
  checkIn,
  completeWork,
  tickChecklist,
  type WorkError,
} from "../../../work.ts";

// The job id comes from the form and is only a lookup key: work.ts finds the job inside the member's own
// business and, for a technician, only on a work visit given to them (architecture 4.3).
const route = defineRoute({ scope: "member", roles: ["owner", "technician"] });

export interface WorkState {
  readonly error?: string;
  readonly saved?: boolean;
}

const WORK_ERROR: Record<WorkError, string> = {
  not_found: "That job was not found.",
  refused: "This job has moved on. Reload the page to see where it stands.",
};

async function worker(form: FormData) {
  const jobId = z.uuid().safeParse(form.get("jobId"));
  if (!jobId.success) return null;
  const member = await requireMember(route, `/work/${jobId.data}`);
  return { jobId: jobId.data, member };
}

/** The technician has arrived: the job is under way. */
export async function checkInAction(_previous: WorkState, form: FormData): Promise<WorkState> {
  const found = await worker(form);
  if (!found) return { error: WORK_ERROR.not_found };
  const { db, audit } = server();
  const result = await db.withTenant(found.member.businessId, (client) =>
    checkIn(client, audit, found.member, found.jobId),
  );
  if (!result.ok) return { error: WORK_ERROR[result.error] };
  redirect(`/work/${found.jobId}`);
}

/** Saves the checklist as ticked now; posted on every tick. */
export async function tickAction(_previous: WorkState, form: FormData): Promise<WorkState> {
  const found = await worker(form);
  if (!found) return { error: WORK_ERROR.not_found };
  const done = form.getAll("done").map(String);
  const result = await server().db.withTenant(found.member.businessId, (client) =>
    tickChecklist(client, found.member, found.jobId, done),
  );
  return result.ok ? { saved: true } : { error: WORK_ERROR[result.error] };
}

/** Extra work found on site, for the owner to price and the customer to approve (4.3). */
export async function foundWorkAction(_previous: WorkState, form: FormData): Promise<WorkState> {
  const found = await worker(form);
  if (!found) return { error: WORK_ERROR.not_found };
  const work = extraWorkInput.safeParse({
    title: String(form.get("title") ?? ""),
    details: String(form.get("details") ?? ""),
  });
  if (!work.success) return { error: "Say what the extra work is, in a few words." };
  const result = await server().db.withTenant(found.member.businessId, (client) =>
    addFoundWork(client, found.member, found.jobId, work.data),
  );
  if (!result.ok)
    return {
      error:
        result.error === "items"
          ? "This job has as many work items as it can take."
          : WORK_ERROR[result.error],
    };
  revalidatePath(`/work/${found.jobId}`);
  return { saved: true };
}

/** The work is done: the job is complete, with the technician's note for the owner. */
export async function completeAction(_previous: WorkState, form: FormData): Promise<WorkState> {
  const found = await worker(form);
  if (!found) return { error: WORK_ERROR.not_found };
  const { db, audit } = server();
  const result = await db.withTenant(found.member.businessId, (client) =>
    completeWork(client, audit, found.member, found.jobId, String(form.get("note") ?? "")),
  );
  if (!result.ok) return { error: WORK_ERROR[result.error] };
  redirect(`/work/${found.jobId}`);
}
