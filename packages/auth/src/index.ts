import { pathToFileURL } from "node:url";
import type { MigrationFolder } from "@bodhchakra/db";

export {
  type Auth,
  type AuthOptions,
  createAuth,
  type Redirect,
  type Session,
  type SignedIn,
  SignInRefused,
  SignInUnavailable,
  safeReturnTo,
} from "./auth.ts";

/** The module's schema migrations; an app lists this after tenancy. */
export const migrations: MigrationFolder = {
  name: "auth",
  dir: pathToFileURL(`${import.meta.dirname}/../migrations/`),
};
