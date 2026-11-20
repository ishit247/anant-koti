// Every route declares whose rows it may touch (docs/architecture.md 4.3). The declaration is a
// constant, `const route = defineRoute({ … })`, so a test can find any route that lacks one.
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Role } from "./member.ts";

export const SCOPES = [
  "member",
  "customer-token",
  "invite-token",
  "public-slug",
  "public-intake",
  "service",
  "provider-webhook",
  "none",
] as const;
export type Scope = (typeof SCOPES)[number];

/** A member route names the roles it allows, so the permission is declared beside the scope. */
export type RouteDeclaration =
  | { readonly scope: "member"; readonly roles: readonly [Role, ...Role[]] }
  | { readonly scope: Exclude<Scope, "member"> };

export function defineRoute<const D extends RouteDeclaration>(declaration: D): Readonly<D> {
  return Object.freeze(declaration);
}

/** Next.js entry points, and any file holding a server action. */
const ENTRY_FILE = /^(page|route|layout)\.tsx?$/;
const SOURCE_FILE = /\.tsx?$/;
const SERVER_ACTION = /^\s*["']use server["'];?\s*$/m;
// Next.js refuses extra exports from a page, a route handler or a "use server" file, so the declaration is a
// module constant that the guards read; `export` is also accepted for files Next does not police.
const DECLARED = /^(?:export )?const route = defineRoute\(/m;
const SKIP = new Set(["node_modules", ".next"]);

async function* sourceFiles(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (SOURCE_FILE.test(entry.name)) yield path;
  }
}

export interface RouteScan {
  /** Every route file found, relative to the scanned directory, `/`-separated and sorted. */
  readonly routes: readonly string[];
  /** The routes among them without `export const route = defineRoute(…)`. */
  readonly undeclared: readonly string[];
}

/**
 * The route-scope test kit. An app's test scans its source directory and expects `undeclared` to be empty and
 * `routes` not to be, so that pointing it at the wrong directory fails instead of passing. Static on purpose:
 * it reads files and imports none, so it needs no Next.js runtime.
 */
export async function scanRoutes(dir: URL): Promise<RouteScan> {
  const root = fileURLToPath(dir);
  const routes: string[] = [];
  const undeclared: string[] = [];
  for await (const path of sourceFiles(root)) {
    const source = await readFile(path, "utf8");
    const name = path.slice(path.lastIndexOf(sep) + 1);
    if (!ENTRY_FILE.test(name) && !SERVER_ACTION.test(source)) continue;
    const file = relative(root, path).split(sep).join("/");
    routes.push(file);
    if (!DECLARED.test(source)) undeclared.push(file);
  }
  return { routes: routes.sort(), undeclared: undeclared.sort() };
}
