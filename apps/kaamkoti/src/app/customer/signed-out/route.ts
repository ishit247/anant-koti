import { defineRoute } from "@bodhchakra/tenancy";

// Where platform returns a customer after signing out; `state` is the slug they signed out from, and only a
// well-formed slug is followed, so this cannot send anyone elsewhere.
export const route = defineRoute({ scope: "none" });

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function GET(request: Request) {
  const state = new URL(request.url).searchParams.get("state") ?? "";
  return new Response(null, {
    status: 303,
    headers: { location: SLUG.test(state) && state.length <= 60 ? `/b/${state}` : "/" },
  });
}
