// Enforces the module rules in docs/architecture.md §12: one-way layers, imports only through a
// package's public API (`@bodhchakra/<name>`), and no relative imports that leave a package.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RANK = { foundation: 0, core: 1, domain: 2, app: 3 };
const SKIP = new Set(["node_modules", ".next", "dist", ".turbo", "coverage"]);
const SOURCE = /\.(ts|tsx|mjs|js)$/;
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g;

function* files(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (SOURCE.test(name)) yield path;
  }
}

const members = new Map(); // package name -> { dir, layer }
for (const group of ["packages", "apps"]) {
  const base = join(root, group);
  if (!existsSync(base)) continue;
  for (const name of readdirSync(base)) {
    const dir = join(base, name);
    const manifest = join(dir, "package.json");
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, "utf8"));
    const layer = group === "apps" ? "app" : pkg.bodhchakra?.layer;
    members.set(pkg.name, { dir, layer, name: pkg.name });
  }
}

const problems = [];
const edges = new Map(); // name -> Set of imported package names

for (const self of members.values()) {
  if (!(self.layer in RANK)) {
    problems.push(
      `${self.name}: package.json needs "bodhchakra": { "layer": "foundation|core|domain" }`,
    );
    continue;
  }
  edges.set(self.name, new Set());
  for (const file of files(self.dir)) {
    const where = relative(root, file).split(sep).join("/");
    for (const [, spec] of readFileSync(file, "utf8").matchAll(IMPORT)) {
      if (spec.startsWith(".")) {
        const target = resolve(dirname(file), spec);
        if (target !== self.dir && !target.startsWith(self.dir + sep)) {
          problems.push(`${where}: relative import "${spec}" leaves the package`);
        }
      } else if (spec.startsWith("@bodhchakra/")) {
        const [scope, name, ...rest] = spec.split("/");
        const target = members.get(`${scope}/${name}`);
        if (rest.length > 0)
          problems.push(`${where}: "${spec}" reaches into a package's internals`);
        else if (!target) problems.push(`${where}: "${spec}" is not a package in this repo`);
        else if (target.name !== self.name) {
          edges.get(self.name).add(target.name);
          if (RANK[target.layer] > RANK[self.layer]) {
            problems.push(
              `${where}: ${self.layer} package imports ${target.layer} package "${spec}"`,
            );
          }
        }
      }
    }
  }
}

// Same-layer imports are allowed (auth uses tenancy) but must not form a cycle.
const state = new Map();
function visit(name, trail) {
  if (state.get(name) === "done") return;
  if (state.get(name) === "active") {
    problems.push(`import cycle: ${[...trail.slice(trail.indexOf(name)), name].join(" -> ")}`);
    return;
  }
  state.set(name, "active");
  for (const next of edges.get(name) ?? []) visit(next, [...trail, name]);
  state.set(name, "done");
}
for (const name of edges.keys()) visit(name, []);

if (problems.length > 0) {
  console.error(problems.join("\n"));
  console.error(`boundaries: ${problems.length} problem(s)`);
  process.exit(1);
}
console.log(`boundaries: ok (${members.size} packages)`);
