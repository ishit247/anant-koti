import { defineRoute } from "@bodhchakra/tenancy";
import { redirect } from "next/navigation";
import { businessProfile, listCatalogue } from "../../../business-profile.ts";
import { requireMember } from "../../../guard.ts";
import { server } from "../../../server.ts";
import { OwnerNav } from "../../owner-nav.tsx";
import { EnquiryForm } from "./enquiry-form.tsx";

const route = defineRoute({ scope: "member", roles: ["owner"] });

export default async function NewEnquiryPage() {
  const owner = await requireMember(route, "/jobs/new");
  const { profile, items } = await server().db.withTenant(owner.businessId, async (client) => ({
    profile: await businessProfile(client),
    items: await listCatalogue(client),
  }));
  if (!profile) redirect("/onboarding");
  return (
    <>
      <header className="bar">
        <h1>Phone enquiry</h1>
        <a className="button quiet" href="/jobs">
          ← Requests
        </a>
      </header>
      <p className="muted">Add it here, then send the customer their link.</p>
      <EnquiryForm items={items.filter((i) => i.active)} />
      <OwnerNav current="/jobs" />
    </>
  );
}
