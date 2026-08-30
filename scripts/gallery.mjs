#!/usr/bin/env node
// Build data/gallery.html — one self-contained page of faces and names, where
// dropping a new image on a card replaces it on l4.
//
//   node scripts/gallery.mjs && open data/gallery/index.html
//
// The page needs no server, so it drops straight onto Cloudflare Pages. Photos
// load from l4, and a replacement is a PUT to the same /i/:key, so the URL never
// changes and nothing has to be written back to data/photos.json. The l4 token
// is pasted into the page at use time and held in sessionStorage — it is never
// baked into the file, so the built page is safe to redeploy.
//
// Names and faces only. No year, no hometown, no dorm, no room.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import * as path from "path";
import { DatabaseSync } from "node:sqlite";
import { pick, readRoster } from "./roster.mjs";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const DB_PATH = flag("db", "data/directory.db");
const NAMES = flag("names", "names.csv");
const MAP = flag("map", "data/photos.json");
// A directory with an index.html, so the built folder is what you hand to
// Cloudflare Pages rather than a loose file you have to rename.
const OUT = flag("out", "data/gallery/index.html");

const urls = existsSync(MAP) ? JSON.parse(readFileSync(MAP, "utf-8")) : {};
const db = new DatabaseSync(DB_PATH, { readOnly: true });

// DormName is selected only because pick() prefers a person who has one when a
// name matches both a student and a staff member. It never reaches the page.
const local = db.prepare(
  "SELECT Id, FirstName, LastName, Nickname, DormName FROM people WHERE LastName LIKE ?",
);

const people = [];
let unmatched = 0;
let unphotographed = 0;

for (const { line, first, last } of readRoster(NAMES)) {
  const p = pick(local.all(`%${last}`), first, last);
  if (!p) {
    console.error(`no match: ${line}`);
    unmatched++;
    continue;
  }
  if (!urls[p.Id]) unphotographed++;
  people.push({
    name: [p.FirstName, p.LastName].filter(Boolean).join(" "),
    url: urls[p.Id] ?? "",
  });
}
db.close();

people.sort((a, b) => a.name.localeCompare(b.name));

const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Freshmen Honors Class of &rsquo;30</title>
<style>
  :root {
    --bg: #14110f;
    --card: #1d1917;
    --line: #2e2724;
    --ink: #ece4dc;
    --dim: #8b7f76;
    --accent: oklch(0.78 0.13 3);
    --ok: oklch(0.78 0.13 150);
    --bad: oklch(0.7 0.18 25);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 3rem 2rem 4rem;
    background: var(--bg); color: var(--ink);
    font: 400 16px/1.5 "Iowan Old Style", "Charter", "Hoefler Text", Georgia, serif;
  }
  header {
    display: flex; gap: 1.5rem; align-items: baseline;
    max-width: 1400px; margin: 0 auto 2.5rem;
    padding-bottom: 1.25rem; border-bottom: 1px solid var(--line);
  }
  h1 { margin: 0; font-size: 1.6rem; font-weight: 400; letter-spacing: -0.01em; }
  /* The only control on the page, so it sits in the masthead rather than
     floating over the grid. Quiet, but findable without hunting. */
  #token {
    margin-left: auto; width: 9rem;
    background: var(--card); border: 1px solid var(--line); border-radius: 3px;
    color: var(--ink); padding: .35rem .55rem;
    font-family: "SF Mono", Menlo, monospace; font-size: .7rem;
    transition: width .15s, border-color .15s;
  }
  #token::placeholder { color: var(--dim); }
  #token:focus { outline: none; width: 14rem; border-color: var(--accent); }
  #token:not(:placeholder-shown) { border-color: var(--ok); }
  #clear {
    display: none; background: none; border: 0; padding: .35rem .2rem;
    color: var(--dim); cursor: pointer;
    font-family: "SF Mono", Menlo, monospace; font-size: .7rem;
  }
  #clear:hover { color: var(--accent); }
  body.armed #clear { display: block; }
  .grid {
    max-width: 1400px; margin: 0 auto;
    display: grid; gap: 1.25rem;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  }
  figure {
    margin: 0; background: var(--card); border: 1px solid var(--line);
    border-radius: 4px; overflow: hidden; transition: border-color .12s;
  }
  figure.over { border-color: var(--accent); }
  figure.busy { opacity: .5; }
  figure.done { border-color: var(--ok); }
  figure.fail { border-color: var(--bad); }
  /* Cards are inert until a token is in hand, so the only thing you can do
     without one is look. */
  .shot { aspect-ratio: 3 / 4; background: #0d0b0a; display: grid; place-items: center; }
  body.armed .shot { cursor: pointer; }
  .shot img { width: 100%; height: 100%; object-fit: cover; display: block; }
  figcaption { padding: .7rem .8rem .85rem; font-size: .95rem; line-height: 1.25; }
</style>

<header>
  <h1>Freshmen Honors Class of &rsquo;30</h1>
  <input id="token" type="password" placeholder="l4 token" autocomplete="off">
  <button id="clear" title="Forget the token">clear</button>
</header>
<div class="grid" id="grid"></div>

<script>
const PEOPLE = ${JSON.stringify(people)};
const grid = document.getElementById("grid");
const tokenBox = document.getElementById("token");

const token = () => tokenBox.value.trim();

// Single source of truth for "can this page upload". Everything interactive
// hangs off body.armed, so arming and disarming needs no per-card bookkeeping.
function sync() {
  sessionStorage.setItem("l4", token());
  document.body.classList.toggle("armed", !!token());
}

tokenBox.value = sessionStorage.getItem("l4") ?? "";
tokenBox.addEventListener("input", sync);
document.getElementById("clear").addEventListener("click", () => {
  tokenBox.value = "";
  sync();
  tokenBox.focus();
});
sync();

for (const person of PEOPLE) {
  const fig = document.createElement("figure");
  const shot = document.createElement("div");
  shot.className = "shot";
  // An empty frame reads as "no photo yet" without needing to say so.
  shot.innerHTML = person.url
    ? '<img loading="lazy" alt="" src="' + person.url + '">'
    : "";

  const cap = document.createElement("figcaption");
  cap.textContent = person.name;

  fig.append(shot, cap);
  grid.append(fig);
  if (person.url) wire(fig, shot, person);
}

// One replace path shared by the file picker and the drop target.
function wire(fig, shot, person) {
  const file = document.createElement("input");
  file.type = "file";
  file.accept = "image/*";
  file.addEventListener("change", () => file.files[0] && send(file.files[0]));
  shot.addEventListener("click", () => token() && file.click());

  for (const type of ["dragenter", "dragover"]) {
    shot.addEventListener(type, (e) => {
      if (!token()) return; // no token, no drop target
      e.preventDefault();
      fig.classList.add("over");
    });
  }
  for (const type of ["dragleave", "dragend"]) {
    shot.addEventListener(type, () => fig.classList.remove("over"));
  }
  shot.addEventListener("drop", (e) => {
    if (!token()) return;
    e.preventDefault();
    fig.classList.remove("over");
    const dropped = e.dataTransfer.files[0];
    if (dropped) send(dropped);
  });

  async function send(blob) {
    if (!token()) return;
    fig.className = "busy";
    const body = new FormData();
    body.append("file", blob);
    try {
      const res = await fetch(person.url, {
        method: "PUT",
        headers: { Authorization: "Bearer " + token() },
        body,
      });
      if (!res.ok) throw new Error(await res.text());
      // Same key, same URL — bust the browser cache so the new one shows.
      shot.querySelector("img").src = person.url + "?v=" + Date.now();
      fig.className = "done";
    } catch (err) {
      fig.className = "fail";
      fig.title = String(err);
    }
  }
}
</script>
`;

mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
writeFileSync(OUT, html);
console.error(
  `${people.length} people, ${people.filter((p) => p.url).length} with photos → ${OUT}` +
    (unmatched ? `\n${unmatched} not found in the directory` : "") +
    (unphotographed ? `\n${unphotographed} without a photo on l4 yet` : ""),
);
