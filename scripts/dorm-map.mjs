#!/usr/bin/env node
// Write data/dorm-gender.tsv: every building in the directory, its gender, and
// many people currently live there. Counts come from the db, so re-run this
// after a sweep rather than editing the tsv by hand.
//
//   node scripts/dorm-map.mjs

import { mkdirSync, writeFileSync } from "fs";
import * as path from "path";
import { DatabaseSync } from "node:sqlite";
import { DORM_GENDER, genderOf } from "./dorm-gender.mjs";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const DB_PATH = flag("db", "data/directory.db");
const OUT = flag("out", "data/dorm-gender.tsv");

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const counts = new Map(
  db
    .prepare(
      `SELECT DormName k, COUNT(*) n FROM people
       WHERE COALESCE(DormName, '') <> '' GROUP BY k`,
    )
    .all()
    .map((r) => [r.k, r.n]),
);
db.close();

// Known buildings in map order (men's, women's, mixed), then anything the sweep
// found that the map has not been told about yet.
const known = Object.keys(DORM_GENDER);
const unknown = [...counts.keys()].filter((d) => !(d in DORM_GENDER)).sort();

const lines = [["Dorm", "Gender", "Residents"].join("\t")];
for (const dorm of [...known, ...unknown]) {
  lines.push([dorm, genderOf(dorm) || "unknown", counts.get(dorm) ?? 0].join("\t"));
}

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, lines.join("\n") + "\n");

console.error(`${known.length + unknown.length} dorms → ${OUT}`);
if (unknown.length) {
  console.error(`unmapped, add to scripts/dorm-gender.mjs: ${unknown.join(", ")}`);
}
