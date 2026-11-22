import { defineRoute } from "@bodhchakra/tenancy";
import { updateOwnDetails } from "../../../../../customer-space.ts";
import { customerPost } from "../../../../../guard.ts";

// The signed-in customer's own name and mobile in this business (D15), from Profile's Edit sheet. Only their own
// row is written: the customer comes from the session, never from the form.
// biome-ignore lint/correctness/noUnusedVariables: read by scanRoutes, which scans the source text
const route = defineRoute({ scope: "customer" });

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const profile = `/b/${encodeURIComponent(slug)}/profile`;
  const form = await request.formData().catch(() => null);
  // Documented fallback: a body that is not a form is the sender's mistake, answered as such.
  if (!form) return new Response("Expected a form.\n", { status: 400 });
  const text = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value : "";
  };
  return customerPost(request, slug, profile, async (client, customer) => {
    // Nothing to edit before the first request creates the row.
    if (!customer) return profile;
    const outcome = await updateOwnDetails(client, customer, {
      name: text("name"),
      phone: text("phone"),
    });
    return outcome === "saved" ? `${profile}?saved=details` : `${profile}?error=${outcome}`;
  });
}
