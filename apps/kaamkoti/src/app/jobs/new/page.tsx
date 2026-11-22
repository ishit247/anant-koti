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
      <p>
        <a href="/jobs">← Requests</a>
      </p>
      <h1>Log a phone enquiry</h1>
      <p className="muted">
        Someone called or messaged you? Add it here, then send them their link.
      </p>
      <EnquiryForm items={items.filter((i) => i.active)} />
      <OwnerNav current="/jobs" />
    </>
  );
}
