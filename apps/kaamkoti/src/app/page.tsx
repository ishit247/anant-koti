import { currentBusiness, defineRoute, listMembers } from "@bodhchakra/tenancy";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { businessProfile } from "../business-profile.ts";
import { requireMember } from "../guard.ts";
import { countNewRequests } from "../inbox.ts";
import { server } from "../server.ts";
import { OwnerNav } from "./owner-nav.tsx";
import { ShareLink } from "./share-link.tsx";
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
        <p className="actions">
          <a className="button" href="/login?return=/signup">
            Start free
          </a>
          <a className="button quiet" href="/login">
            Sign in
          </a>
        </p>
      </>
    );
  }
  const me = await requireMember(route);
  const { business, members, profile, newRequests } = await server().db.withTenant(
    me.businessId,
    async (client) => ({
      business: await currentBusiness(client),
      members: await listMembers(client),
      profile: await businessProfile(client),
      newRequests: me.role === "owner" ? await countNewRequests(client) : 0,
    }),
  );
  if (me.role === "owner" && !profile) redirect("/onboarding");
  const publicLink = `${server().publicOrigin}/b/${encodeURIComponent(business.slug)}`;
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
        {business.city} · {me.role === "owner" ? "owner" : "technician"}
      </p>
      {me.role === "owner" ? (
        <>
          <a className="card stat" href="/jobs">
            <span>
              <strong>{newRequests === 0 ? "No new requests" : "New requests"}</strong>
              <br />
              <span className="small">Open your requests</span>
            </span>
            <span className="count">{newRequests}</span>
          </a>

          <h2>Your public page</h2>
          <div className="card">
            <p className="muted small">
              Customers request a visit here. Put the link on WhatsApp, a card or a board.
            </p>
            <ShareLink
              link={publicLink}
              label="Your public page"
              message={`Book ${business.name}:`}
            />
            <a href={`/b/${encodeURIComponent(business.slug)}`}>Open the page</a>
          </div>

          <h2>Team</h2>
          <div className="card">
            <ul className="cards">
              {members.map((m) => (
                <li key={m.memberId} className="row">
                  <span>{m.displayName}</span>
                  <span className="chip">{m.role}</span>
                </li>
              ))}
            </ul>
            <InviteForm businessName={business.name} />
          </div>
          <OwnerNav current="/" />
        </>
      ) : (
        <p className="empty">Your jobs will appear here once the owner assigns them.</p>
      )}
    </>
  );
}
