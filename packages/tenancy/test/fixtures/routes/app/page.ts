import { defineRoute } from "@bodhchakra/tenancy";

export const route = defineRoute({ scope: "member", roles: ["owner", "technician"] });

export default function Page() {
  return null;
}
