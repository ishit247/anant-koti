// Regenerates migrations/identity/0001_identity.sql from the better-auth configuration in src/identity.ts:
//   node scripts/identity-sql.ts > migrations/identity/0001_identity.sql
// Needs the dev stack (`pnpm run up`). test/identity-schema.test.ts fails when the file drifts.
import { identitySql } from "../test/identity-sql.ts";

process.stdout.write(await identitySql());
