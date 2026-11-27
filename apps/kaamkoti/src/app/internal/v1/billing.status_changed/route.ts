import { defineRoute } from "@bodhchakra/tenancy";
import { server } from "../../../../server.ts";

// Platform's billing events (architecture 9.1, 13), delivered by its outbox. The signature, as client `platform`
// under the secret the two share, is the whole guard: the event names its business, and only platform may
// move a business's subscription copy. 401 for anything else; a 200 for an event applied, stale or repeated.
// biome-ignore lint/correctness/noUnusedVariables: read by scanRoutes, which scans the source text
const route = defineRoute({ scope: "service" });

/** A status event is a few hundred bytes. */
const MAX_BODY_BYTES = 16 * 1024;

export async function POST(request: Request) {
  const length = Number(request.headers.get("content-length"));
  if (!(length > 0 && length <= MAX_BODY_BYTES)) return new Response(null, { status: 413 });
  return server().billing.receiveStatus(request);
}
