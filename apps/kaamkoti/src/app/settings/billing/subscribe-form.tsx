"use client";
import { useActionState } from "react";
import { type CheckoutState, subscribe } from "./actions.ts";

export interface PlanChoice {
  readonly plan: "solo" | "team";
  readonly title: string;
  readonly price: string;
}

/** The plan and, for Team, the seats; the owner authorises the payment on Razorpay's page. */
export function SubscribeForm({
  plans,
  seats,
  next,
}: {
  plans: readonly PlanChoice[];
  /** The people in the business now: Team's starting seat count. */
  seats: number;
  /** What happens after the button, in one line. */
  next: string;
}) {
  const [state, action, pending] = useActionState<CheckoutState, FormData>(subscribe, {});
  return (
    <form action={action}>
      <section className="panel" aria-labelledby="plan-title">
        <h2 id="plan-title">Choose a plan</h2>
        <div className="choices">
          {plans.map((choice) => (
            <label key={choice.plan} className="choice place">
              <input
                type="radio"
                name="plan"
                value={choice.plan}
                defaultChecked={choice.plan === "team"}
                required
              />
              <span className="text">
                <strong>{choice.title}</strong>
                <span className="muted small">{choice.price}</span>
              </span>
            </label>
          ))}
        </div>
        <label>
          People on Team
          <input
            name="seats"
            type="number"
            inputMode="numeric"
            min={1}
            max={100}
            defaultValue={seats}
            required
          />
        </label>
        <p className="hint">You and each technician. Solo is just you.</p>
      </section>
      {state.error ? (
        <p className="error" role="alert">
          {state.error}
        </p>
      ) : null}
      <div className="dock stacked">
        <button type="submit" disabled={pending}>
          {pending ? "Opening Razorpay…" : "Continue to payment"}
        </button>
        <p className="muted small">{next}</p>
      </div>
    </form>
  );
}
