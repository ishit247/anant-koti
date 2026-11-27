import { subscriptionOf } from "@bodhchakra/billing";
import { formatMoney } from "@bodhchakra/money";
import { defineRoute, listMembers } from "@bodhchakra/tenancy";
import { requireMember } from "../../../guard.ts";
import { formatDay } from "../../../job-labels.ts";
import { server } from "../../../server.ts";
import { PLAN_PRICES, subscriptionView } from "../../../subscription.ts";
import { OwnerNav } from "../../owner-nav.tsx";
import { SubscribeForm } from "./subscribe-form.tsx";

// What the business pays Kaam Koti (architecture 13): the state is the local copy platform's events keep, and
// it reads paid only once Razorpay's webhook has said so. The owner picks a plan and goes to Razorpay's page.
const route = defineRoute({ scope: "member", roles: ["owner"] });

export default async function BillingSettings() {
  const owner = await requireMember(route, "/settings/billing");
  const { subscription, people } = await server().db.withTenant(
    owner.businessId,
    async (client) => ({
      subscription: await subscriptionOf(client),
      people: (await listMembers(client)).length,
    }),
  );
  const now = new Date();
  const view = subscriptionView(subscription, now);
  const trialLeft = now < subscription.trialEndsAt;
  return (
    <>
      <header className="bar">
        <h1>Subscription</h1>
        <a className="button quiet" href="/">
          ← Home
        </a>
      </header>
      <div className="stack">
        <section className="panel" aria-labelledby="status-title">
          <h2 id="status-title">Your plan</h2>
          <div className="row">
            <strong>
              {subscription.plan === "solo"
                ? "Solo"
                : `Team · ${subscription.seats} ${subscription.seats === 1 ? "person" : "people"}`}
            </strong>
            <span className={`chip ${view.tone}`}>{view.label}</span>
          </div>
          <p className={view.live ? "muted small" : "error"}>{view.line}</p>
        </section>
        {view.canSubscribe ? (
          <SubscribeForm
            plans={[
              {
                plan: "solo",
                title: "Solo",
                price: `${formatMoney(PLAN_PRICES.solo)} a month · just you`,
              },
              {
                plan: "team",
                title: "Team",
                price: `${formatMoney(PLAN_PRICES.team)} a person a month · you and your technicians`,
              },
            ]}
            seats={people}
            next={
              trialLeft
                ? `Razorpay asks you to set up the payment. Nothing is taken until ${formatDay(subscription.trialEndsAt)}, when your trial ends. No commission on your jobs.`
                : "Razorpay asks you to set up the payment, and takes the first month then. No commission on your jobs."
            }
          />
        ) : null}
      </div>
      <OwnerNav current="/" />
    </>
  );
}
