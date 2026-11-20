"use server";
import { defineRoute } from "@bodhchakra/tenancy";
import { redirect } from "next/navigation";
import { z } from "zod";
import { startFromTemplate } from "../../business-profile.ts";
import { requireMember } from "../../guard.ts";
import { server } from "../../server.ts";

const route = defineRoute({ scope: "member", roles: ["owner"] });

const choice = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/);

export async function chooseTrade(form: FormData): Promise<void> {
  const owner = await requireMember(route, "/onboarding");
  const templateKey = choice.parse(form.get("trade"));
  await server().db.withTenant(owner.businessId, (client) =>
    startFromTemplate(client, owner.businessId, templateKey),
  );
  redirect("/catalogue");
}
