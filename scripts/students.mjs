#!/usr/bin/env node
// Export the residential student roster from data/directory.db as TSV.
//
//   node scripts/students.mjs                  # students who have a room
//   node scripts/students.mjs --all            # commuters too, blank dorm
//   node scripts/students.mjs --out -          # stdout instead of a file
//
// Requires a sweep first: node scripts/enumerate.mjs

import { mkdirSync, writeFileSync } from "fs";
import * as path from "path";
import { DatabaseSync } from "node:sqlite";
import { ROW_COLUMNS, toTsv } from "./format.mjs";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

const DB_PATH = flag("db", "data/directory.db");
const OUT = flag("out", "data/students.tsv");

const db = new DatabaseSync(DB_PATH, { readOnly: true });

// The API sends empty strings rather than nulls, so every "has a value" test
// has to go through COALESCE.
const isStudent = "COALESCE(StudentType, '') <> ''";
const hasRoom = "COALESCE(DormName, '') <> ''";
const where = has("all") ? isStudent : `${isStudent} AND ${hasRoom}`;

const people = db
  .prepare(
    `SELECT ${ROW_COLUMNS.join(", ")} FROM people
     WHERE ${where}
     ORDER BY LastName COLLATE NOCASE, FirstName COLLATE NOCASE`,
  )
  .all();

const total = db.prepare(`SELECT COUNT(*) n FROM people WHERE ${isStudent}`).get().n;
db.close();

const text = toTsv(people);
if (OUT === "-") {
  process.stdout.write(text);
} else {
  mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
  writeFileSync(OUT, text);
}

console.error(
  `${people.length.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} students` +
    (has("all") ? "" : " (those with a room; --all includes commuters)") +
    (OUT === "-" ? "" : ` → ${OUT}`),
);
