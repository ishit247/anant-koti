import { pathToFileURL } from "node:url";
import type { MigrationFolder } from "@bodhchakra/db";

export {
  type BusinessProfile,
  createBusiness,
  currentBusiness,
  type NewBusiness,
  type Owner,
  resolveSlug,
} from "./business.ts";
export {
  acceptInvite,
  createInvite,
  InviteRefused,
  type InviteSummary,
  inviteSummary,
} from "./invite.ts";
export {
  addMember,
  listMembers,
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
  dir: pathToFileURL(`${import.meta.dirname}/../migrations/`),
};
