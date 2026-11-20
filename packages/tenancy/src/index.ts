import type { MigrationFolder } from "@bodhchakra/db";

/** The module's schema migrations; an app lists this before its own folder. */
export const migrations: MigrationFolder = {
  name: "tenancy",
  dir: new URL("../migrations/", import.meta.url),
};
