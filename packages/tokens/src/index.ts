import { pathToFileURL } from "node:url";
import type { MigrationFolder } from "@bodhchakra/db";

export { issue, type Link, type LinkPurpose, type NewLink, resolve, revoke } from "./link.ts";
export {
  CLIENT_HEADER,
  MAX_SKEW_SECONDS,
  MIN_SECRET_LENGTH,
  SIGNATURE_HEADER,
  type SignInput,
  signRequest,
  TIMESTAMP_HEADER,
  type VerifyInput,
  type VerifyResult,
  verifyRequest,
} from "./request.ts";

/** The link table's migrations; an app lists them before tenancy, which references them. */
export const migrations: MigrationFolder = {
  name: "tokens",
  dir: pathToFileURL(`${import.meta.dirname}/../migrations/`),
};
