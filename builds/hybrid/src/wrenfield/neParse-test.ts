/** Message-driven new/established parameters: the practice message, paraphrased and amended messages, hard negatives. */
import { readFileSync } from "node:fs";
import { parseNEMessage, neWindow } from "./neParse.js";

let fails = 0;
const ok = (c: boolean, m: string) => { if (!c) { fails++; console.log("FAIL", m); } };
const DEFAULT_EX = ["Lab draw", "Immunization", "X-ray", "Ultrasound", "Electrocardiogram", "Echocardiogram", "Allergy injection", "Blood pressure check", "Hearing test", "Vision screening", "Infusion therapy", "Anticoagulation check"];

const q = JSON.parse(readFileSync(new URL("../../fixtures/practice-queue.json", import.meta.url), "utf8"));
const MSG: string = q.items.find((x: any) => x.kind === "message" && /new patients from established/i.test(x.text)).text;

// 1. the practice message reads to the built-in defaults exactly
{ const r = parseNEMessage(MSG); ok(!!r.params, "practice message parses: " + r.why);
  ok(r.params?.windowYears === 3, "practice window 3");
  ok(JSON.stringify(r.params?.excluded) === JSON.stringify(DEFAULT_EX), "practice excluded list: " + JSON.stringify(r.params?.excluded));
  ok(JSON.stringify(r.params?.statuses) === '["completed"]', "practice statuses");
  ok(r.params?.matchProvider === true && r.params?.matchSpecialty === true, "practice matching"); }

// 2. amended / reworded messages: parameters follow the message
const sub = (a: string | RegExp, b: string) => MSG.replace(a, b);
{ const m = sub(/3 years/g, "2 years").replace(/3-year/g, "2-year").replace(/3 years earlier/g, "2 years earlier").replace(/2023-11-06 through 2026-11-04/g, "2024-11-06 through 2026-11-04").replace("2023-11-05", "2024-11-05");
  const r = parseNEMessage(m); ok(r.params?.windowYears === 2, "2-year window: " + r.why); }
{ const r = parseNEMessage(sub("Lab draw, Immunization, ", "Immunization, Telehealth visit, ")); ok(!!r.params && !r.params.excluded.includes("Lab draw") && r.params.excluded.includes("Telehealth visit"), "excluded list follows message: " + r.why); }
{ const r = parseNEMessage(sub("Its status is Completed.", "Its status is Completed or Checked out.")); ok(JSON.stringify(r.params?.statuses) === '["completed","checked out"]', "two statuses: " + r.why); }
{ const r = parseNEMessage(sub("Its status is Completed. Scheduled, Cancelled, Late cancel, and No-show appointments do not count.", "Its status is Completed or Late cancel. Scheduled, Cancelled, and No-show appointments do not count.")); ok(JSON.stringify(r.params?.statuses) === '["completed","late cancel"]', "late cancel counts: " + r.why); }
{ const r = parseNEMessage(sub("which never make a patient established:", "which do not make anyone established:")); ok(!!r.params, "reworded exclusion lead-in: " + r.why); }
{ const r = parseNEMessage(sub(/3 years/g, "three years").replace(/3-year/g, "three-year")); ok(r.params?.windowYears === 3, "written-out years: " + r.why); }

// 2b. a fully reworded message (own structure, not the practice wording)
{ const P = `From the coding team: new vs established patient visits

We bill new and established visits differently. Each question names a patient, a provider and a visit date.

Treat the patient as established when they had a qualifying appointment with the same provider, or anyone in that specialty, within the 2 years before the visit. If not, they are new.

Qualifying means:
- The appointment's status is Completed or Checked out. Scheduled, Cancelled and No-show appointments do not count.
- These visit types never count toward established status: Lab draw, Flu shot, Hearing test.
- It falls in the 2-year window, which runs from the day after the same date 2 years back to the day before the visit; for a visit on 2027-03-10 the window is 2025-03-11 through 2027-03-09.

Answer \`NEW\` or \`ESTABLISHED:\` plus the date of the most recent qualifying appointment (YYYY-MM-DD).`;
  const r = parseNEMessage(P); ok(r.params?.windowYears === 2 && JSON.stringify(r.params?.statuses) === '["completed","checked out"]' && JSON.stringify(r.params?.excluded) === '["Lab draw","Flu shot","Hearing test"]' && r.params.matchSpecialty, "reworded message: " + r.why + JSON.stringify(r.params)); }

// 3. hard negatives: anything we can't read or don't implement → decline
const neg = (m: string, label: string) => { const r = parseNEMessage(m); ok(r.params === null, "must decline: " + label); };
neg(sub(/2023-11-06 through 2026-11-04/g, "2023-11-05 through 2026-11-04"), "window example our arithmetic doesn't reproduce");
neg(sub(/3 years before the visit date/, "5 years before the visit date"), "two different window lengths");
neg(sub("Its status is Completed.", "Its status is Finished."), "unknown status word");
neg(sub("Its status is Completed. Scheduled, Cancelled, Late cancel, and No-show", "Its status is Completed or No-show. Scheduled, Cancelled, Late cancel, and No-show"), "status both counts and doesn't");
neg(sub("the same date 3 years earlier is February 28", "the same date 3 years earlier is March 1"), "Feb 29 rule differs");
neg(sub(/`ESTABLISHED:[^`]*`/g, "`EST`"), "different answer tokens");
neg(sub(/It is not one of these services[^\n]*\n/, ""), "no excluded list");
neg(sub("the most recent appointment that counts", "the earliest appointment that counts").replace("The most recent one", "The earliest one"), "earliest instead of most recent");

// 4. window arithmetic agrees with the message text
ok(neWindow("2026-11-05", 3).join("..") === "2023-11-06..2026-11-04", "window 2026-11-05");
ok(neWindow("2028-02-29", 3).join("..") === "2025-03-01..2028-02-28", "window Feb 29");

console.log(fails ? `neParse: ${fails} FAIL` : "neParse: all ok");
process.exit(fails ? 1 : 0);
