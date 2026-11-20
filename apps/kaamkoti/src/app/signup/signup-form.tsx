"use client";
import { useActionState } from "react";
import { type SignupState, signup } from "./actions.ts";

export function SignupForm() {
  const [state, action, pending] = useActionState<SignupState, FormData>(signup, {});
  const v = state.values ?? {};
  return (
    <form action={action}>
      <label>
        Your name
        <input
          name="yourName"
          defaultValue={v.yourName}
          autoComplete="name"
          required
          maxLength={120}
        />
      </label>
      <label>
        Business name
        <input
          name="businessName"
          defaultValue={v.businessName}
          autoComplete="organization"
          required
          maxLength={120}
        />
      </label>
      <label>
        City
        <input
          name="city"
          defaultValue={v.city}
          autoComplete="address-level2"
          required
          maxLength={80}
        />
      </label>
      <label>
        Business phone
        <input
          name="phone"
          defaultValue={v.phone}
          type="tel"
          autoComplete="tel"
          inputMode="tel"
          required
        />
      </label>
      {state.error ? (
        <p className="error" role="alert">
          {state.error}
        </p>
      ) : null}
      <button type="submit" disabled={pending}>
        {pending ? "Creating…" : "Create my business"}
      </button>
    </form>
  );
}
