// Turning a names.csv into directory records. Shared by the exports so they all
// resolve a name the same way.

import { readFileSync } from "fs";

// names.csv is one person per line, first name and last name separated by a
// tab. Multi-word names put the extra words on whichever side the tab landed,
// so anchor on the outer tokens: "Anna\tGrace Gage" is Anna … Gage.
export function readRoster(file) {
  return readFileSync(file, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\t|\s+/).filter(Boolean);
      return { line, first: parts[0], last: parts[parts.length - 1] };
    });
}

const norm = (s) => (s ?? "").toLowerCase().replace(/[^a-z]/g, "");

// Prefer whoever actually has a dorm on file — a name can hit both a student
// and a staff member.
export function pick(people, first, last) {
  const f = norm(first);
  const l = norm(last);
  const hits = people.filter(
    (p) =>
      norm(p.LastName).endsWith(l) &&
      (norm(p.FirstName).startsWith(f) || norm(p.Nickname).startsWith(f)),
  );
  return hits.find((p) => p.DormName) ?? hits[0] ?? null;
}
