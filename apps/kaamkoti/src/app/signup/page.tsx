import { defineRoute } from "@bodhchakra/tenancy";
import { redirect } from "next/navigation";
import { requireSession } from "../../guard.ts";
import { SignupForm } from "./signup-form.tsx";

// Signed in, but a business is exactly what this page creates, so there is nothing yet to scope to.
// biome-ignore lint/correctness/noUnusedVariables: read by scanRoutes, which scans the source text
const route = defineRoute({ scope: "none" });

export default async function SignupPage() {
  const session = await requireSession("/signup");
  if (session.memberships.length > 0) redirect("/");
  return (
    <>
      <h1>Set up your business</h1>
      <p className="muted">One minute. You can change these later.</p>
      <SignupForm />
    </>
  );
}
