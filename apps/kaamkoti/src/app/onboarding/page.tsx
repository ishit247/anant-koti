import { defineRoute } from "@bodhchakra/tenancy";
import { redirect } from "next/navigation";
import { businessProfile } from "../../business-profile.ts";
import { requireMember } from "../../guard.ts";
import { server } from "../../server.ts";
import { listTradeTemplates } from "../../trade-template.ts";
import { chooseTrade } from "./actions.ts";

const route = defineRoute({ scope: "member", roles: ["owner"] });

export default async function OnboardingPage() {
  const owner = await requireMember(route, "/onboarding");
  const { profile, templates } = await server().db.withTenant(owner.businessId, async (client) => ({
    profile: await businessProfile(client),
    templates: await listTradeTemplates(client),
  }));
  if (profile) redirect("/catalogue");
  return (
    <>
      <h1>What work do you do?</h1>
      <p className="muted">
        We fill in a starting price list, job questions and terms. You can change everything next.
      </p>
      <form action={chooseTrade}>
        {templates.map((t, i) => (
          <label key={t.key} className="choice">
            <input type="radio" name="trade" value={t.key} defaultChecked={i === 0} />
            {t.body.title}
          </label>
        ))}
        <button type="submit">Continue</button>
      </form>
    </>
  );
}
