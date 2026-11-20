import type { NextConfig } from "next";

const config: NextConfig = {
  // The workspace packages ship TypeScript source.
  transpilePackages: [
    "@bodhchakra/audit",
    "@bodhchakra/auth",
    "@bodhchakra/config",
    "@bodhchakra/db",
    "@bodhchakra/log",
    "@bodhchakra/tenancy",
    "@bodhchakra/tokens",
  ],
  // Invite links carry their secret in the path; no page may leak it in a Referer header.
  headers: async () => [
    { source: "/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
  ],
};
export default config;
