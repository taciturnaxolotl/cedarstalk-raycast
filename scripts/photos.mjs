#!/usr/bin/env node
// Fetch the honors roster's directory photos and push them to the l4 CDN, then
// remember the URL each one landed on.
//
//   L4_TOKEN=… node scripts/photos.mjs
//   node scripts/photos.mjs --dry-run        # download only, upload nothing
//
// l4 hands back a random 12-character key, so the resulting URLs are unlisted
// rather than enumerable, and the images travel with no name attached. The
// name/room/year join stays in data/dorms.tsv on your disk.
//
// The URL map at data/photos.json is the record of what has been published.
// Re-running skips anyone already in it, so this is safe to repeat; delete an
// entry to force a re-upload.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import * as path from "path";
import { DatabaseSync } from "node:sqlite";
import { BASE_URL, mintCookie, search, sleep } from "./lib.mjs";
import { pick, readRoster } from "./roster.mjs";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

const DB_PATH = flag("db", "data/directory.db");
const NAMES = flag("names", "names.csv");
const MAP = flag("map", "data/photos.json");
const CACHE = flag("cache", "data/photos");
const ENDPOINT = flag("endpoint", "https://l4.dunkirk.sh");
const DRY = has("dry-run");

const TOKEN = process.env.L4_TOKEN;
if (!DRY && !TOKEN) {
  console.error("set L4_TOKEN to the l4 AUTH_TOKEN, or pass --dry-run");
  process.exit(1);
}

const urls = existsSync(MAP) ? JSON.parse(readFileSync(MAP, "utf-8")) : {};
const saveMap = () => writeFileSync(MAP, JSON.stringify(urls, null, 2) + "\n");

const SELECT = "Id, FirstName, LastName, Nickname, DormName, PhotoUrl";
const db = existsSync(DB_PATH) ? new DatabaseSync(DB_PATH, { readOnly: true }) : null;
const local = db?.prepare(`SELECT ${SELECT} FROM people WHERE LastName LIKE ?`);

mkdirSync(CACHE, { recursive: true });
mkdirSync(path.dirname(path.resolve(MAP)), { recursive: true });

let cookie = null;
const needCookie = async () => (cookie ??= await mintCookie());

// The photo endpoint is session-gated, so this is the one fetch that must carry
// the cookie. Absolute URLs point somewhere else and are left alone.
async function download(photoUrl) {
  const relative = !photoUrl.startsWith("http");
  const res = await fetch(relative ? `${BASE_URL}${photoUrl}` : photoUrl, {
    headers: relative
      ? { cookie: await needCookie(), referer: `${BASE_URL}/cedarinfo/directory` }
      : {},
  });
  if (!res.ok) throw new Error(`photo HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function upload(buf, name) {
  const form = new FormData();
  form.append("file", new Blob([buf], { type: "image/jpeg" }), name);
  const res = await fetch(`${ENDPOINT}/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: form,
  });
  if (!res.ok) throw new Error(`upload HTTP ${res.status} ${await res.text()}`);
  const body = await res.json();
  if (!body?.url) throw new Error(`upload returned no url: ${JSON.stringify(body)}`);
  return body.url;
}

const roster = readRoster(NAMES);
let uploaded = 0;
let skipped = 0;
let failed = 0;

for (const { line, first, last } of roster) {
  let person = local ? pick(local.all(`%${last}`), first, last) : null;
  if (!person) {
    try {
      person = pick(
        await search(await needCookie(), { FirstNameSearch: first, LastNameSearch: last }),
        first,
        last,
      );
      await sleep(150);
    } catch (e) {
      console.error(`${line}: ${e.message}`);
      failed++;
      continue;
    }
  }

  if (!person) {
    console.error(`no match: ${line}`);
    failed++;
    continue;
  }
  if (!person.PhotoUrl) {
    console.error(`no photo: ${line}`);
    failed++;
    continue;
  }
  if (urls[person.Id]) {
    skipped++;
    continue;
  }

  try {
    const buf = await download(person.PhotoUrl);
    writeFileSync(path.join(CACHE, `${person.Id}.jpg`), buf);
    if (DRY) {
      uploaded++;
      continue;
    }
    urls[person.Id] = await upload(buf, `${person.Id}.jpg`);
    saveMap(); // write through, so a crash never loses what is already public
    uploaded++;
    console.error(`${line} → ${urls[person.Id]}`);
  } catch (e) {
    console.error(`${line}: ${e.message}`);
    failed++;
  }
  await sleep(200);
}

if (!DRY) saveMap();
db?.close();
console.error(
  `\n${roster.length} on the roster — ${uploaded} ${DRY ? "downloaded" : "uploaded"}, ` +
    `${skipped} already done, ${failed} failed` +
    (DRY ? "" : ` → ${MAP}`),
);
