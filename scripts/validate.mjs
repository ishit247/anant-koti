// pnpm run validate quick|standard|full. Output goes to .validation/; the terminal gets one
// line per stage. quick = lint, types, boundaries. standard adds tests. full is standard until
// later phases add browser and mutation checks.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const quick = [
  ["lint", "pnpm", ["run", "lint"]],
  ["typecheck", "pnpm", ["run", "typecheck"]],
  ["boundaries", "pnpm", ["run", "check:boundaries"]],
];
const standard = [...quick, ["test", "pnpm", ["run", "test"]]];
const levels = { quick, standard, full: standard };

const level = process.argv[2];
const stages = levels[level];
if (!stages) {
  console.error("usage: pnpm run validate quick|standard|full");
  process.exit(2);
}

mkdirSync(".validation", { recursive: true });
let failed = false;
for (const [name, cmd, args] of stages) {
  const run = spawnSync(cmd, args, { encoding: "utf8", shell: true });
  const log = `.validation/${name}.log`;
  writeFileSync(log, `${run.stdout ?? ""}${run.stderr ?? ""}`);
  const ok = run.status === 0;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` (see ${log})`}`);
  if (!ok) failed = true;
}
process.exit(failed ? 1 : 0);
