// Which halls are men's and which are women's.
//
// Derived from directory.db, not from a housing brochure: every resident's
// first name was scored against a list of unambiguously gendered given names,
// then tallied per building. The traditional halls came back perfectly split —
// dozens of markers on one side, zero on the other — so the labels are solid
// even though any single name guess is not. The College View apartments are
// genuinely mixed at the building level (they divide by unit), and Cedar Park
// is family housing, so both are left as "mixed".

export const DORM_GENDER = {
  // men's
  "Brock Hall": "male",
  "Carr Hall": "male",
  "Faith Hall": "male",
  "Gromacki Hall": "male",
  "Harriman Hall": "male",
  "Lawlor Hall": "male",
  "Marshall Hall": "male",
  "McChesney Hall": "male",
  "Murdoch Hall": "male",
  "Palmer Hall": "male",
  "Parker Hall": "male",
  "Rickard Hall": "male",
  "Rogers Hall": "male",
  "Shrubsole House": "male",
  "St Clair Hall": "male",
  "Walker Hall": "male",
  "West Hall": "male",

  // women's
  "Bates Hall": "female",
  "Diehl Johnson Hall": "female",
  "Jenkins Hall": "female",
  "Johnson Hall": "female",
  "Maddox Hall": "female",
  "McKinney Hall": "female",
  "Morton Hall": "female",
  "Murphy Hall": "female",
  "Printy Hall": "female",
  "Rooke Hall": "female",
  "South Hall": "female",
  "Willetts Hall": "female",
  "Wood Hall": "female",

  // mixed at the building level
  "Cedar Park": "mixed",
  "College View Apartment A": "mixed",
  "College View Apartment B": "mixed",
  "College View Apartment C": "mixed",
  "College View Apartment D": "mixed",
};

export const genderOf = (dorm) => DORM_GENDER[dorm] ?? "";
