#!/usr/bin/env node
// Write data/major-school.tsv from the catalog mapping.
//
//   node scripts/major-map.mjs

import { mkdirSync, writeFileSync } from "fs";
import * as path from "path";
import { DEPARTMENT_SCHOOL, PROGRAMS, SCHOOLS, levelOf } from "./major-school.mjs";

const argv = process.argv.slice(2);
const i = argv.indexOf("--out");
const OUT = i === -1 ? "data/major-school.tsv" : argv[i + 1];

const rows = PROGRAMS.map(([program, department]) => [
  program,
  levelOf(program),
  department,
  SCHOOLS[DEPARTMENT_SCHOOL[department]] ?? "",
]).sort((a, b) => a[0].localeCompare(b[0]) || a[2].localeCompare(b[2]));

const unmapped = [...new Set(rows.filter((r) => !r[3]).map((r) => r[2]))];

const text =
  [["Program", "Level", "Department", "School"].join("\t"), ...rows.map((r) => r.join("\t"))].join(
    "\n",
  ) + "\n";

if (OUT === "-") {
  process.stdout.write(text);
} else {
  mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
  writeFileSync(OUT, text);
}

const tally = {};
for (const r of rows) tally[r[3] || "(none)"] = (tally[r[3] || "(none)"] ?? 0) + 1;

console.error(`${rows.length} programs → ${OUT === "-" ? "stdout" : OUT}`);
for (const [school, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
  console.error(`  ${String(n).padStart(4)}  ${school}`);
}
if (unmapped.length) {
  console.error(`\nno school for: ${unmapped.join(", ")}`);
}
