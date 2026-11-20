import { defineRoute } from "@bodhchakra/tenancy";

// biome-ignore lint/correctness/noUnusedVariables: read by scanRoutes, which scans the source text
const route = defineRoute({ scope: "none" });

export default function Layout() {
  return null;
}
