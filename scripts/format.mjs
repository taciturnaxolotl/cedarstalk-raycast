// One definition of what a person row looks like when it leaves here, so the
// roster export and the honors list stay the same shape.

import { genderOf } from "./dorm-gender.mjs";

const CLASS_LABELS = {
  FR: "Freshman",
  SO: "Sophomore",
  JR: "Junior",
  SR: "Senior",
  GR: "Graduate",
  GS: "Graduate Student",
  HS: "High School",
  MG: "Masters",
  ND: "Non-Degree",
  P1: "Pharmacy Year 1",
  P2: "Pharmacy Year 2",
  P3: "Pharmacy Year 3",
  P4: "Pharmacy Year 4",
};

// Anything not in here passes through untouched — foreign provinces come back
// spelled out already, and a wrong guess is worse than the original string.
const STATES = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi",
  MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
  NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma",
  OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin",
  WY: "Wyoming", DC: "District of Columbia",
  AS: "American Samoa", GU: "Guam", MP: "Northern Mariana Islands",
  PR: "Puerto Rico", VI: "U.S. Virgin Islands",
  AA: "Armed Forces Americas", AE: "Armed Forces Europe", AP: "Armed Forces Pacific",
};

const BASE_URL = "https://selfservice.cedarville.edu";

const BASE_HEADER = [
  "First Name",
  "Middle Name",
  "Last Name",
  "Year",
  "Hometown",
  "State",
  "Dorm",
  "Room",
  "Gender",
];

export const header = ({ photo = false } = {}) =>
  photo ? [...BASE_HEADER, "Photo"] : BASE_HEADER;

// A spreadsheet =IMAGE() formula, pointing at the copy on the CDN.
//
// It has to be the CDN copy: Sheets fetches these anonymously from Google's own
// servers, with no session cookie, so the directory's own photo URL would only
// ever render as a broken image. Anyone without an uploaded copy gets an empty
// cell rather than a broken one — run scripts/photos.mjs to fill them in.
function imageFormula(person, photos) {
  const url = photos?.[person.Id];
  if (!url) return "";
  return `=IMAGE("${String(url).replace(/"/g, '""')}")`;
}

// The db columns a query needs to select for toRow to have anything to work on.
export const ROW_COLUMNS = [
  "Id",
  "FirstName",
  "MiddleName",
  "LastName",
  "StudentClass",
  "AddressCity",
  "AddressState",
  "DormName",
  "DormRoom",
  "PhotoUrl",
];

// Tabs and newlines inside a field would silently shift every later column, so
// they get flattened rather than trusted.
const cell = (v) => String(v ?? "").replace(/[\t\r\n]+/g, " ").trim();

export const toRow = (p, { photo = false, photos } = {}) => {
  const row = [
    cell(p.FirstName),
    cell(p.MiddleName),
    cell(p.LastName),
    cell(CLASS_LABELS[p.StudentClass] ?? p.StudentClass),
    cell(p.AddressCity),
    cell(STATES[cell(p.AddressState).toUpperCase()] ?? p.AddressState),
    cell(p.DormName),
    cell(p.DormRoom),
    genderOf(p.DormName),
  ];
  if (photo) row.push(imageFormula(p, photos));
  return row;
};

export const toTsv = (people, opts) =>
  [
    header(opts).join("\t"),
    ...people.map((p) => toRow(p, opts).join("\t")),
  ].join("\n") + "\n";
