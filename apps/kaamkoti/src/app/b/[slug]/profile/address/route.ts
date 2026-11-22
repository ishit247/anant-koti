import { defineRoute } from "@bodhchakra/tenancy";
import {
  addAddress,
  deleteAddress,
  label,
  readPlace,
  readPlaceForm,
  updateAddress,
} from "../../../../../address-book.ts";
import { customerPost } from "../../../../../guard.ts";

// Adds, changes or deletes one of the signed-in customer's saved addresses (D15), from Profile's sheets. The
// customer comes from the session and every write names them, so another customer's address id is answered
// 404, like a missing one. Jobs keep their own copy of what they were sent with.
// biome-ignore lint/correctness/noUnusedVariables: read by scanRoutes, which scans the source text
const route = defineRoute({ scope: "customer" });

const notFound = () => new Response("No such address.\n", { status: 404 });

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const profile = `/b/${encodeURIComponent(slug)}/profile`;
  const form = await request.formData().catch(() => null);
  // Documented fallback: a body that is not a form is the sender's mistake, answered as such.
  if (!form) return new Response("Expected a form.\n", { status: 400 });
  const id = form.get("id");
  const existing = typeof id === "string" && id !== "" ? id : null;
  const intent = form.get("intent");
  return customerPost(request, slug, profile, async (client, customer) => {
    if (!customer) return existing ? notFound() : profile;
    if (intent === "delete") {
      if (!existing || !(await deleteAddress(client, customer, existing))) return notFound();
      return `${profile}?saved=deleted`;
    }
    const read = readPlace(readPlaceForm(form));
    const name = label.safeParse(form.get("label"));
    if (!read.ok || !name.success) return `${profile}?error=${read.ok ? "contact" : read.error}`;
    if (existing) {
      if (!(await updateAddress(client, customer, existing, name.data, read.place)))
        return notFound();
    } else if ((await addAddress(client, customer, name.data, read.place)) === "full")
      return `${profile}?error=addresses_full`;
    return `${profile}?saved=address`;
  });
}
