import { defineRoute } from "@bodhchakra/tenancy";
import { requireMember } from "../../../guard.ts";
import { server } from "../../../server.ts";
import { OwnerNav } from "../../owner-nav.tsx";
import { ConnectForm } from "./connect-form.tsx";

// The owner connects their own Razorpay account (architecture 8): money goes straight to it, never through us.
// The page shows the key id once connected, never a secret, and the webhook address to give Razorpay.
const route = defineRoute({ scope: "member", roles: ["owner"] });

/** The events the webhook must be subscribed to; the module ignores the rest. */
const EVENTS = [
  "payment_link.paid",
  "payment_link.partially_paid",
  "payment_link.cancelled",
  "payment_link.expired",
];

export default async function PaymentSettings({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string }>;
}) {
  const owner = await requireMember(route, "/settings/payments");
  const { db, payments, publicOrigin } = server();
  const account = await db.withTenant(owner.businessId, (client) =>
    payments.connectedAccount(client, owner.businessId),
  );
  const { saved } = await searchParams;
  const webhook = `${publicOrigin}/hooks/razorpay/${owner.businessId}`;
  return (
    <>
      <header className="bar">
        <h1>Online payments</h1>
        <a className="button quiet" href="/">
          ← Home
        </a>
      </header>
      {saved && account ? (
        <p className="notice" role="status">
          Saved. Customers can now pay deposits online.
        </p>
      ) : null}
      <div className="stack">
        <section className="panel" aria-labelledby="account-title">
          <h2 id="account-title">Razorpay</h2>
          {account ? (
            <div className="row">
              <span>{account.keyId}</span>
              <span className={`chip ${account.keyId.startsWith("rzp_live_") ? "go" : "wait"}`}>
                {account.keyId.startsWith("rzp_live_") ? "Live" : "Test mode"}
              </span>
            </div>
          ) : (
            <p className="muted small">
              Not connected. Customers pay deposits to you directly until you connect your Razorpay
              account. Money goes straight to it; Kaam Koti takes no commission.
            </p>
          )}
          <ConnectForm connected={account !== null} />
        </section>
        <section className="panel" aria-labelledby="webhook-title">
          <h2 id="webhook-title">Webhook</h2>
          <p className="muted small">
            In the Razorpay dashboard, under Webhooks, add this address with the webhook secret
            above, and tick these events: {EVENTS.join(", ")}. Payments show here only once Razorpay
            tells us through it.
          </p>
          <input readOnly value={webhook} aria-label="Webhook address" />
        </section>
      </div>
      <OwnerNav current="/" />
    </>
  );
}
