import { limitsOf, subscriptionOf } from "@bodhchakra/billing";
import { currentBusiness, defineRoute, listMembers } from "@bodhchakra/tenancy";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { businessProfile } from "../business-profile.ts";
import { requireMember } from "../guard.ts";
import { countNewRequests } from "../inbox.ts";
import { formatWhen, STATUS_LABEL, statusTone } from "../job-labels.ts";
import { server } from "../server.ts";
import { subscriptionView } from "../subscription.ts";
import { myWork } from "../work.ts";
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
  const { db, payments } = server();
  const { business, members, profile, newRequests, paymentsConnected, work, subscription } =
    await db.withTenant(me.businessId, async (client) => ({
      business: await currentBusiness(client),
      subscription: me.role === "owner" ? await subscriptionOf(client) : null,
      members: await listMembers(client),
      profile: await businessProfile(client),
      newRequests: me.role === "owner" ? await countNewRequests(client) : 0,
      paymentsConnected:
        me.role === "owner" && (await payments.connectedAccount(client, me.businessId)) !== null,
      work: me.role === "technician" ? await myWork(client, me.memberId) : [],
    }));
  if (me.role === "owner" && !profile) redirect("/onboarding");
  const plan = subscription ? subscriptionView(subscription, new Date()) : null;
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

          <h2>Online payments</h2>
          <a className="card stat" href="/settings/payments">
            <span>
              <strong>{paymentsConnected ? "Razorpay connected" : "Take deposits online"}</strong>
              <br />
              <span className="small">
                {paymentsConnected ? "Change the keys" : "Connect your Razorpay account"}
              </span>
            </span>
          </a>

          {plan ? (
            <>
              <h2>Subscription</h2>
              <a className="card" href="/settings/billing">
                <span className="row">
                  <strong>{plan.live ? "Your page is open" : "Your page is closed"}</strong>
                  <span className={`chip ${plan.tone}`}>{plan.label}</span>
                </span>
                <span className="muted small">{plan.line}</span>
              </a>
            </>
          ) : null}

          <h2>Team</h2>
          <div className="card">
            {subscription ? (
              <p className="muted small">
                {members.length} of {limitsOf(subscription).seats} seats
              </p>
            ) : null}
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
        <>
          <h2>My jobs</h2>
          {work.length > 0 ? (
            <ul className="cards">
              {work.map((job) => (
                <li key={job.jobId}>
                  <a className="card" href={`/work/${job.jobId}`}>
                    <div className="row">
                      <strong>
                        #{job.number} · {job.contactName}
                      </strong>
                      <span className={`chip ${statusTone(job.status)}`}>
                        {STATUS_LABEL[job.status]}
                      </span>
                    </div>
                    <span className="muted small">
                      {formatWhen(job.startsAt)}
                      {job.address ? ` · ${job.address}` : ""}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">Your jobs will appear here once the owner assigns them.</p>
          )}
        </>
      )}
    </>
  );
}
