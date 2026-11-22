"use server";
import { defineRoute } from "@bodhchakra/tenancy";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireMember } from "../../../guard.ts";
import { reissueJobLink } from "../../../inbox.ts";
import { openDraft } from "../../../quote.ts";
import { server } from "../../../server.ts";

const route = defineRoute({ scope: "member", roles: ["owner"] });

export interface ResendState {
  /** The new secret, shown once in the owner's own response; only its hash is stored. */
  readonly secret?: string;
  readonly error?: string;
}

/** The job comes from the form, so it is checked against the owner's business: another business's job is "not found". */
export async function resendJobLink(_previous: ResendState, form: FormData): Promise<ResendState> {
  const jobId = z.uuid().safeParse(form.get("jobId"));
  if (!jobId.success) return { error: "That request was not found." };
  const owner = await requireMember(route, `/jobs/${jobId.data}`);
  const { db, audit } = server();
  const result = await db.withTenant(owner.businessId, (client) =>
    reissueJobLink(client, audit, owner, jobId.data),
  );
  return result ? { secret: result.secret } : { error: "That request was not found." };
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
