#!/usr/bin/env node
// Sweep the whole Cedarville directory into a local SQLite database.
//
//   node scripts/enumerate.mjs
//   node scripts/enumerate.mjs --db people.db --concurrency 6
//
// The directory only answers name searches and only ever returns the first N
// matches, so we enumerate by splitting the name space until every query fits
// under that cap. A query that comes back pegged at the cap is hiding rows and
// gets split; a query that comes back short is complete and that branch stops.
// When the run ends with nothing pegged, we have provably seen everything.
//
// Splitting walks the last-name prefix first, and when that runs out of depth
// it starts constraining the first name instead — so `smit` becomes `smit + a`
// … `smit + z` rather than a dead end. A last-name-only sweep is enough on its
// own: every person in the directory has an a–z last name, so a–z at depth 1
// covers the population. (--also-first adds the redundant first-name sweep back
// if you ever want to check that assumption; it roughly triples the run.)
//
// Everything is written as we go and every finished query is recorded, so the
// run is resumable — re-running picks up where it stopped. Pass --refresh to
// start the sweep over (rows already in the db are kept and updated).

import { mkdirSync } from "fs";
import * as path from "path";
import { DatabaseSync } from "node:sqlite";
import { genderOf } from "./dorm-gender.mjs";
import { AuthExpiredError, mintCookie, search, sleep } from "./lib.mjs";

// ─── options ───────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

const DB_PATH = flag("db", "data/directory.db");
const CONCURRENCY = Number(flag("concurrency", 4));
const DELAY = Number(flag("delay", 120)); // ms between requests per worker
const MAX_DEPTH = Number(flag("depth", 4)); // per axis, so 2× that in total
const ALPHABET = flag("alphabet", "abcdefghijklmnopqrstuvwxyz").split("");

// ─── database ──────────────────────────────────────────────────────────────

const COLUMNS = [
  "Id", "Username", "FirstName", "LastName", "MiddleName", "Nickname",
  "AddressCity", "AddressState", "AddressCountry",
  "DepartmentDescription", "Title",
  "OfficeBuildingCode", "OfficeBuildingName", "OfficeRoom", "OfficePhone",
  "DormCode", "DormName", "DormRoom",
  "StudentType", "StudentClass", "studentWorker", "empInactive", "PhotoUrl",
];

mkdirSync(path.dirname(path.resolve(DB_PATH)), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS people (
    ${COLUMNS.map((c) => `${c} TEXT`).join(",\n    ")},
    first_seen TEXT NOT NULL,
    last_seen  TEXT NOT NULL,
    PRIMARY KEY (Id)
  );
  CREATE INDEX IF NOT EXISTS people_dorm ON people (DormName);
  CREATE INDEX IF NOT EXISTS people_last ON people (LastName);

  CREATE TABLE IF NOT EXISTS queries (
    last  TEXT NOT NULL,
    first TEXT NOT NULL,
    count INTEGER NOT NULL,
    at    TEXT NOT NULL,
    PRIMARY KEY (last, first)
  );
`);

// Earlier runs keyed queries by (field, prefix). Carry them over so a sweep in
// progress does not have to start from scratch.
const queryCols = db.prepare("PRAGMA table_info(queries)").all().map((c) => c.name);
if (queryCols.includes("field")) {
  db.exec(`
    ALTER TABLE queries RENAME TO queries_v1;
    CREATE TABLE queries (
      last  TEXT NOT NULL,
      first TEXT NOT NULL,
      count INTEGER NOT NULL,
      at    TEXT NOT NULL,
      PRIMARY KEY (last, first)
    );
    INSERT OR IGNORE INTO queries (last, first, count, at)
      SELECT CASE WHEN field = 'LastNameSearch' THEN prefix ELSE '' END,
             CASE WHEN field = 'LastNameSearch' THEN '' ELSE prefix END,
             count, at
      FROM queries_v1;
    DROP TABLE queries_v1;
  `);
}

if (has("refresh")) db.exec("DELETE FROM queries");

const upsert = db.prepare(`
  INSERT INTO people (${COLUMNS.join(", ")}, first_seen, last_seen)
  VALUES (${COLUMNS.map(() => "?").join(", ")}, ?, ?)
  ON CONFLICT(Id) DO UPDATE SET
    ${COLUMNS.slice(1).map((c) => `${c} = excluded.${c}`).join(",\n    ")},
    last_seen = excluded.last_seen
`);
const exists = db.prepare("SELECT 1 FROM people WHERE Id = ?");
const noteQuery = db.prepare(
  "INSERT OR REPLACE INTO queries (last, first, count, at) VALUES (?, ?, ?, ?)",
);
const count = (sql, ...args) => db.prepare(sql).get(...args).n;

// ─── crawl state ───────────────────────────────────────────────────────────

const done = new Map(); // "last\x00first" -> row count
const split = new Set(); // jobs we have already expanded
const queue = [];
const key = (last, first) => `${last}\x00${first}`;

for (const row of db.prepare("SELECT last, first, count FROM queries").all()) {
  done.set(key(row.last, row.first), row.count);
}

// Largest result set the server has ever handed back. Recovered from the db so
// a resumed run knows the cap before it has made a single request — otherwise
// the settle loop starts blind and re-queues nothing.
let cap = db.prepare("SELECT COALESCE(MAX(count), 0) n FROM queries").get().n;
let requests = 0;
let added = 0;
let updated = 0;
let stuck = 0;
let current = "";
let errors = 0;
const started = Date.now();

const push = (last, first) => {
  if (!done.has(key(last, first))) queue.push({ last, first });
};

const exhausted = (last, first) => last.length >= MAX_DEPTH && first.length >= MAX_DEPTH;

// A pegged query is hiding rows behind it. Narrow it: lengthen the last-name
// prefix while there is room, and once that axis bottoms out, start pinning the
// first name instead.
function expand(last, first) {
  if (split.has(key(last, first))) return;
  split.add(key(last, first));

  if (last.length < MAX_DEPTH) for (const c of ALPHABET) push(last + c, first);
  else for (const c of ALPHABET) push(last, first + c);
}

for (const c of ALPHABET) push(c, "");
if (has("also-first")) for (const c of ALPHABET) push("", c);

function record(last, first, people) {
  const now = new Date().toISOString();
  db.exec("BEGIN");
  try {
    for (const p of people) {
      const fresh = !exists.get(String(p.Id));
      upsert.run(...COLUMNS.map((c) => (p[c] == null ? null : String(p[c]))), now, now);
      if (fresh) added++;
      else updated++;
    }
    noteQuery.run(last, first, people.length, now);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  done.set(key(last, first), people.length);
  if (people.length > cap) cap = people.length;
}

// ─── progress ──────────────────────────────────────────────────────────────

const tty = process.stderr.isTTY;
const dim = (s) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s) => (tty ? `\x1b[1m${s}\x1b[0m` : s);
const accent = (s) => (tty ? `\x1b[38;5;212m${s}\x1b[0m` : s);
const blue = (s) => (tty ? `\x1b[38;5;75m${s}\x1b[0m` : s);
const amber = (s) => (tty ? `\x1b[38;5;179m${s}\x1b[0m` : s);
const GENDER_INK = { male: blue, female: accent, mixed: amber };
const n = (x) => x.toLocaleString("en-US");
const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

function clock(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

let frame = 0;
let painted = 0;
function paint(final = false) {
  const elapsed = Date.now() - started;
  const rate = requests / (elapsed / 1000 || 1);
  const spin = final ? accent("●") : accent(SPIN[frame++ % SPIN.length]);
  const lines = [
    `${spin} ${bold(current || "…")}  ${dim("cap")} ${cap || "?"}  ` +
      `${dim("queue")} ${n(queue.length)}  ${dim("done")} ${n(done.size)}` +
      (stuck ? `  ${dim("stuck")} ${stuck}` : "") +
      (errors ? `  ${dim("err")} ${errors}` : ""),
    `  ${accent(n(added))} new  ${dim(`${n(updated)} seen again`)}  ` +
      `${dim("·")}  ${n(requests)} req  ${rate.toFixed(1)}/s  ${clock(elapsed)}`,
  ];

  if (!tty) {
    if (final || requests % 50 === 0) process.stderr.write(lines.join("  |  ") + "\n");
    return;
  }
  if (painted) process.stderr.write(`\x1b[${painted}A`);
  for (const line of lines) process.stderr.write(`\x1b[2K${line}\n`);
  painted = lines.length;
}

// ─── run ───────────────────────────────────────────────────────────────────

const cookie = await mintCookie();
const ticker = tty ? setInterval(paint, 90) : null;
let expired = false;

const label = (j) => `${j.last || "*"}${j.first ? ` +${j.first}` : ""}`;

async function worker() {
  while (queue.length && !expired) {
    const job = queue.shift();
    current = label(job);
    try {
      const people = await search(cookie, {
        LastNameSearch: job.last,
        FirstNameSearch: job.first,
      });
      requests++;
      record(job.last, job.first, people);
      if (!tty) paint(); // no spinner to lean on when piped to a file
    } catch (e) {
      if (e instanceof AuthExpiredError) {
        expired = true;
        break;
      }
      errors++;
      done.set(key(job.last, job.first), 0);
    }
    if (DELAY) await sleep(DELAY);
  }
}

// Each settle pass drains the queue, then re-checks every finished query
// against the cap we now know about and splits the ones that were pegged. It
// converges once a pass adds no work, which means nothing is pegged anymore.
while (true) {
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (expired) break;
  const before = queue.length;
  stuck = 0;
  for (const [k, c] of done) {
    if (!cap || c < cap) continue;
    const [last, first] = k.split("\x00");
    if (!last) continue; // a --also-first probe; the last-name axis covers it
    if (exhausted(last, first)) stuck++;
    else expand(last, first);
  }
  if (queue.length === before) break;
}

if (ticker) clearInterval(ticker);
paint(true);

if (expired) {
  console.error("\nsession expired mid-run — progress is saved, just run it again to resume");
}

// ─── summary ───────────────────────────────────────────────────────────────

const total = count("SELECT COUNT(*) n FROM people");
// The API sends empty strings, not nulls, for fields that do not apply.
const withDorm = count("SELECT COUNT(*) n FROM people WHERE COALESCE(DormName, '') <> ''");
const staff = count("SELECT COUNT(*) n FROM people WHERE COALESCE(Title, '') <> ''");

const say = (l, v) => console.error(`  ${dim(l.padEnd(16))} ${bold(v)}`);
console.error("");
say("people", n(total));
say("with a dorm", n(withDorm));
say("with a title", n(staff));
say("queries", n(done.size));
say("result cap", cap ? String(cap) : "never hit");
if (errors) say("errors", n(errors));
say("coverage", stuck ? accent(`${stuck} blind spots`) : "complete");

if (stuck) {
  console.error(
    `  ${dim(`${stuck} queries are still capped with both axes at depth ${MAX_DEPTH};`)}\n` +
      `  ${dim(`re-run with --depth ${MAX_DEPTH + 2} to reach behind them`)}`,
  );
}

const rows = (sql, limit) => db.prepare(sql).all(limit);
const bar = (v, max, ink = accent) =>
  ink("▇".repeat(Math.max(1, Math.round((v / max) * 24))));

const classes = rows(
  `SELECT COALESCE(NULLIF(StudentClass, ''), '—') k, COUNT(*) n FROM people
   WHERE COALESCE(StudentType, '') <> '' GROUP BY k ORDER BY n DESC LIMIT ?`,
  12,
);
if (classes.length) {
  console.error(`\n  ${dim("students by class")}`);
  const max = classes[0].n;
  for (const r of classes)
    console.error(`  ${r.k.padEnd(4)} ${String(r.n).padStart(5)}  ${bar(r.n, max)}`);
}

const dorms = rows(
  `SELECT DormName k, COUNT(*) n FROM people
   WHERE COALESCE(DormName, '') <> '' GROUP BY k ORDER BY n DESC LIMIT ?`,
  40, // all 35 buildings fit, including the mixed apartments in the tail
);
if (dorms.length) {
  console.error(
    `\n  ${dim("dorms")}   ${blue("▇")} ${dim("male")}  ${accent("▇")} ${dim("female")}  ${amber("▇")} ${dim("mixed")}`,
  );
  const max = dorms[0].n;
  for (const r of dorms) {
    const ink = GENDER_INK[genderOf(r.k)] ?? dim;
    console.error(`  ${r.k.padEnd(28)} ${String(r.n).padStart(5)}  ${bar(r.n, max, ink)}`);
  }
}

console.error(`\n  ${dim(`saved to ${DB_PATH}`)}`);
db.close();
