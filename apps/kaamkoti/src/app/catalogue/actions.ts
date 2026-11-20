"use server";
import { defineRoute } from "@bodhchakra/tenancy";
import { revalidatePath } from "next/cache";
import { saveCatalogue } from "../../business-profile.ts";
import { parseCatalogueForm } from "../../catalogue-form.ts";
import { requireMember } from "../../guard.ts";
import { server } from "../../server.ts";

const route = defineRoute({ scope: "member", roles: ["owner"] });

export interface CatalogueState {
  readonly saved?: boolean;
  readonly error?: string;
  /** What was typed, so a rejected save does not wipe the form. */
  readonly rows?: readonly Record<string, string>[];
}

export async function saveCatalogueAction(
  _previous: CatalogueState,
  form: FormData,
): Promise<CatalogueState> {
  const owner = await requireMember(route, "/catalogue");
  const parsed = parseCatalogueForm(form);
  if (!parsed.ok) return { error: parsed.error, rows: parsed.typed };
  await server().db.withTenant(owner.businessId, (client) =>
    saveCatalogue(client, owner.businessId, parsed.rows),
  );
  revalidatePath("/catalogue");
  return { saved: true };
}
