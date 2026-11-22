"use server";
import { defineRoute } from "@bodhchakra/tenancy";
import { redirect } from "next/navigation";
import { requireMember } from "../../../guard.ts";
import { logPhoneEnquiry, type PhoneEnquiryError } from "../../../inbox.ts";
import { server } from "../../../server.ts";

const route = defineRoute({ scope: "member", roles: ["owner"] });

const MESSAGES: Record<PhoneEnquiryError, string> = {
  contact: "Check the name, a mobile number with 10 digits, and the address.",
  tasks: "Pick at least one service, or describe the work.",
};

export interface EnquiryState {
  readonly error?: string;
  /** What was typed, so a refused form does not wipe it. */
  readonly typed?: Readonly<Record<string, string>>;
}

export async function logEnquiryAction(
  _previous: EnquiryState,
  form: FormData,
): Promise<EnquiryState> {
  const owner = await requireMember(route, "/jobs/new");
  const text = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value : "";
  };
  const input = {
    name: text("name"),
    phone: text("phone"),
    address: text("address"),
    customTask: text("customTask"),
    tasks: form.getAll("task").filter((v) => typeof v === "string"),
  };
  const { db, audit } = server();
  const result = await db.withTenant(owner.businessId, (client) =>
    logPhoneEnquiry(client, audit, owner, input),
  );
  if (!result.ok) {
    return {
      error: MESSAGES[result.error],
      typed: {
        name: input.name,
        phone: input.phone,
        address: input.address,
        customTask: input.customTask,
      },
    };
  }
  redirect(`/jobs/${result.jobId}`);
}
