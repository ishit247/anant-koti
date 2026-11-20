import { currentBusiness, defineRoute, listMembers } from "@bodhchakra/tenancy";
import { headers } from "next/headers";
import { requireMember } from "../guard.ts";
import { server } from "../server.ts";
import { InviteForm } from "./team/invite-form.tsx";

// Signed-out visitors see the welcome; signed-in members see their own business. Both are decided here, and the
// member branch runs through requireMember, whose scope is the member's own business.
const route = defineRoute({ scope: "member", roles: ["owner", "technician"] });

export default async function Home() {
  const session = await server().auth.getSession((await headers()).get("cookie"));
  if (!session) {
    return (
      <>
        <h1>Kaam Koti</h1>
        <p>Quotes, jobs and payments for tradespeople, in one place.</p>
        <p>
          <a className="button" href="/login?return=/signup">
            Start free
          </a>{" "}
          <a href="/login">Sign in</a>
        </p>
      </>
    );
  }
  const me = await requireMember(route);
  const { business, members } = await server().db.withTenant(me.businessId, async (client) => ({
    business: await currentBusiness(client),
    members: await listMembers(client),
  }));
  return (
    <>
      <header className="bar">
        <h1>{business.name}</h1>
        <form action="/signout" method="post">
          <button type="submit" className="quiet">
            Sign out
          </button>
        </form>
      </header>
      <p className="muted">
        {business.city} · you are {me.role === "owner" ? "the owner" : "a technician"}
      </p>
      {me.role === "owner" ? (
        <>
          <h2>Team</h2>
          <ul>
            {members.map((m) => (
              <li key={m.memberId}>
                {m.displayName} <span className="muted">({m.role})</span>
              </li>
            ))}
          </ul>
          <InviteForm businessName={business.name} />
        </>
      ) : null}
    </>
  );
}
