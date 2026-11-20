import type { MigrationFolder } from "@bodhchakra/db";

export { createBusiness, type NewBusiness, type Owner, resolveSlug } from "./business.ts";
export {
  addMember,
  type Membership,
  membershipsOf,
  type NewMember,
  NotPermittedError,
  ROLES,
  type Role,
  requireRole,
} from "./member.ts";
export {
  defineRoute,
  type RouteDeclaration,
  type RouteScan,
  SCOPES,
  type Scope,
  scanRoutes,
} from "./route.ts";

/** The module's schema migrations; an app lists this before its own folder. */
export const migrations: MigrationFolder = {
  name: "tenancy",
  dir: new URL("../migrations/", import.meta.url),
};
