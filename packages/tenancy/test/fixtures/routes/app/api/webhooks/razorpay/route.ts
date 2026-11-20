import { defineRoute } from "@bodhchakra/tenancy";

export const route = defineRoute({ scope: "provider-webhook" });

export async function POST() {
  return new Response(null, { status: 204 });
}
