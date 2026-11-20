"use server";
import { createBusiness, defineRoute } from "@bodhchakra/tenancy";
import { redirect } from "next/navigation";
import { requireSession } from "../../guard.ts";
import { server } from "../../server.ts";
import { signupInput, slugFor } from "../../signup.ts";

// The signed-in identity becomes the owner of a new business: no business exists yet to scope to.
// biome-ignore lint/correctness/noUnusedVariables: read by scanRoutes, which scans the source text
const route = defineRoute({ scope: "none" });

export interface SignupState {
  readonly error?: string;
  readonly values?: Record<string, string>;
}

const UNIQUE_VIOLATION = "23505";
const SLUG_TRIES = 4;

export async function signup(_previous: SignupState, form: FormData): Promise<SignupState> {
  const session = await requireSession("/signup");
  if (session.memberships.length > 0) redirect("/");

  const values = Object.fromEntries(
    ["yourName", "businessName", "city", "phone"].map((k) => [k, String(form.get(k) ?? "")]),
  );
  const parsed = signupInput.safeParse(values);
  if (!parsed.success) {
    const bad = parsed.error.issues[0]?.path[0];
    return {
      error: `Please check ${bad === "phone" ? "the phone number" : "every field"}.`,
      values,
    };
  }
  const { yourName, businessName, city, phone } = parsed.data;

  for (let attempt = 0; attempt < SLUG_TRIES; attempt++) {
    try {
      await createBusiness(
        server().db,
        { slug: slugFor(businessName, attempt), name: businessName, phone, city },
        { identityId: session.identityId, displayName: yourName },
      );
    } catch (error) {
      if ((error as { code?: string }).code !== UNIQUE_VIOLATION) throw error;
      continue;
    }
    redirect("/");
  }
  return {
    error: "Could not find a free web address for that name. Try a slightly different name.",
    values,
  };
}
