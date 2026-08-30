#!/usr/bin/env node
// Look up everyone in names.csv and write first/last/dorm/room/sex as TSV,
// ready to paste into a spreadsheet.
//
//   node scripts/dorms.mjs
//   node scripts/dorms.mjs --names roommates.csv --out -    # - means stdout
//
// Reads data/directory.db when it exists (run scripts/enumerate.mjs to build
// it) and only goes to the network for names it cannot find there.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import * as path from "path";
import { DatabaseSync } from "node:sqlite";
import { ROW_COLUMNS, header, toRow } from "./format.mjs";
import { mintCookie, search, sleep } from "./lib.mjs";
import { pick, readRoster } from "./roster.mjs";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const DB_PATH = flag("db", "data/directory.db");
const NAMES = flag("names", "names.csv");
const OUT = flag("out", "data/dorms.tsv");
const MAP = flag("map", "data/photos.json");

const db = existsSync(DB_PATH) ? new DatabaseSync(DB_PATH, { readOnly: true }) : null;
const local = db?.prepare(
  `SELECT ${[...ROW_COLUMNS, "Nickname"].join(", ")} FROM people WHERE LastName LIKE ?`,
);

let cookie = null;
const rows = readRoster(NAMES);

// This is the list people actually look at, so it carries the photo column.
// The URLs come from whatever scripts/photos.mjs has already published; without
// that file the column is simply blank.
const PHOTO = {
  photo: true,
  photos: existsSync(MAP) ? JSON.parse(readFileSync(MAP, "utf-8")) : {},
};
const out = [header(PHOTO).join("\t")];

let fromDb = 0;
let fromNet = 0;
let missed = 0;

for (const { line, first, last } of rows) {
  let person = local ? pick(local.all(`%${last}`), first, last) : null;
  if (person) fromDb++;

  if (!person) {
    cookie ??= await mintCookie();
    try {
      person = pick(await search(cookie, { FirstNameSearch: first, LastNameSearch: last }), first, last);
      fromNet++;
    } catch (e) {
      console.error(`${line}: ${e.message}`);
      break;
    }
    await sleep(150);
  }

  if (!person) {
    console.error(`no match: ${line}`);
    missed++;
  }
  // Keep unmatched people in place with the name we searched for, so the row
  // count still lines up with names.csv.
  out.push(toRow(person ?? { FirstName: first, LastName: last }, PHOTO).join("\t"));
}

const text = out.join("\n") + "\n";
if (OUT === "-") {
  process.stdout.write(text);
} else {
  mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
  writeFileSync(OUT, text);
}

console.error(
  `\n${rows.length} names — ${fromDb} from ${DB_PATH}, ${fromNet} looked up live, ` +
    `${missed} not found${OUT === "-" ? "" : ` → ${OUT}`}`,
);
db?.close();
