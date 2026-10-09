/**
 * Lookup path, offline: question parsing + answers over row / label-block shapes captured from the practice site
 * (toolkit reads of Soto, Julia / Soto, Lisa, 2026-10-08). Hard negatives must decline.
 *   npx tsx src/wrenfield/lookup.test.ts
 */
import { lookupSpec, answerFromRows, answerFromBlocks, type LookupSpec } from "./lookup.js";
import type { Row } from "./solver/toolkit.js";

let fail = 0, n = 0;
const ok = (c: boolean, msg: string) => { n++; if (!c) { fail++; console.log("FAIL " + msg); } };
const R = (cells: Record<string, string>): Row => ({ cells, links: [] });

const APPT_H = ["Date and time", "Type", "Provider", "Location", "Status"];
const APPTS = [
  R({ "Date and time": "Sep 30, 2026, 2:20 PM MDT", Type: "Immunization", Provider: "Janet Marshall, MD", Location: "Stonebrook", Status: "Completed" }),
  R({ "Date and time": "Oct 28, 2025, 9:00 AM MDT", Type: "Diabetes management", Provider: "Hannah Ramos, MD", Location: "Willow Creek", Status: "Completed" }),
  R({ "Date and time": "Jun 2, 2025, 10:40 AM MDT", Type: "Follow-up", Provider: "Hannah Ramos, MD", Location: "Willow Creek", Status: "Cancelled" }),
  R({ "Date and time": "Jan 14, 2025, 8:20 AM MST", Type: "Follow-up", Provider: "Hannah Ramos, MD", Location: "Stonebrook", Status: "No-show" }),
];
const DOC_H = ["Title", "Type", "Received", "Actions"];
const DOCS = [
  R({ Title: "Referral letter from Summit Hollow Cardiology Partners", Type: "Referral letter", Received: "Jun 8, 2026", Actions: "View" }),
  R({ Title: "Basic metabolic panel", Type: "Lab report", Received: "Nov 12, 2025", Actions: "View" }),
  R({ Title: "Complete blood count", Type: "Lab report", Received: "Mar 3, 2025", Actions: "View" }),
];
const INV_H = ["Invoice", "Service date", "Location", "Issued", "Total", "Status", "Filed under"];
const INVS = [
  R({ Invoice: "78668907", "Service date": "Sep 30, 2026", Location: "Stonebrook", Issued: "Oct 3, 2026", Total: "$115.49", Status: "Open", "Filed under": "" }),
  R({ Invoice: "22410012", "Service date": "Jan 9, 2026", Location: "Willow Creek", Issued: "Jan 12, 2026", Total: "$80.00", Status: "Paid", "Filed under": "" }),
];
const PROB_H = ["Code", "Condition", "Onset"];
const PROBS = [R({ Code: "L20.9", Condition: "Atopic dermatitis", Onset: "Nov 10, 2013" }), R({ Code: "J45.909", Condition: "Asthma, unspecified", Onset: "Feb 2, 2015" })];
const ACT_H = ["When", "User", "What"];
const ACTS = [
  R({ When: "Jul 30, 2026, 7:21 PM MDT", User: "amendez", What: "Opened the chart" }),
  R({ When: "Sep 11, 2023, 8:52 AM MDT", User: "mmartinez", What: "Created the record" }),
];
const INS = [{ heading: "Soto, Lisa", pairs: [["MRN", "HG3354880"], ["Sex", "Female"]] as Array<[string, string]> },
  { heading: "Primary insurance", pairs: [["Payer", "Senior Advantage of the Plains"], ["Plan", "Senior Complete"], ["Member ID", "YJUK4749075961"]] as Array<[string, string]> }];
const INS2 = [...INS, { heading: "Secondary insurance", pairs: [["Payer", "State Family Assistance"], ["Plan", "Family Care"], ["Member ID", "PFF064490335"]] as Array<[string, string]> }];

const table: Record<string, [string[], Row[]]> = { appointment: [APPT_H, APPTS], document: [DOC_H, DOCS], invoice: [INV_H, INVS], problem: [PROB_H, PROBS], activity: [ACT_H, ACTS] };
function run(q: string, strength: "page" | "model" = "page", blocks = INS): string {
  const s = lookupSpec(q); if ("why" in s) return "SKIP " + s.why;
  if (s.entity === "insurance-fields" || s.entity === "chart-fields") { const o = answerFromBlocks(s, blocks); return "answer" in o ? o.answer : "SKIP " + o.why; }
  const t = table[s.entity]; if (!t) return "SKIP no fixture for " + s.entity;
  const o = answerFromRows(s as LookupSpec, t[0], t[1], strength); return "answer" in o ? o.answer : "SKIP " + o.why;
}
const want = (q: string, a: string) => { const got = run(q); ok(got === a, `${q}\n     want ${a}, got ${got}`); };
const skip = (q: string, blocks = INS) => { const got = run(q, "page", blocks); ok(got.startsWith("SKIP"), `${q}\n     want a skip, got ${got}`); };

// ── answered (bench/loop suite phrasings and paraphrases)
want("Which user created Lisa Soto's record? DOB 2014-08-17.", "mmartinez");
want("Brooks, Daniel, born 09/06/1996: status of the visit on 10/28/2025?", "Completed");
want("When did Ward, James's (DOB 2009-01-07) atopic dermatitis start?", "2013-11-10");
want("Problem list check — Hayes, Alexander (DOB 2025-10-20): onset of atopic dermatitis?", "2013-11-10");
skip("What's the member ID for Caleb Hayes, DOB 04/19/1931?"); // digits: practice draws member IDs with decoy digits
want("Payer for John Ward (DOB 01/23/2025)?", "Senior Advantage of the Plains");
want("Date of the most recent lab report in Soto, Julia's chart (born August 3, 1966)?", "2025-11-12");
want("When was the first lab report received for Julia Soto (DOB 1966-08-03)?", "2025-03-03");
want("What type of visit did Julia Soto (DOB 1966-08-03) have on 2025-06-02?", "Follow-up");
want("Where was Julia Soto's (DOB 1966-08-03) last completed appointment?", "Stonebrook");
want("How many lab reports are on file for Julia Soto (DOB 1966-08-03)?", "2");
want("How many cancelled appointments did Julia Soto (DOB 1966-08-03) have in 2025?", "1");
want("What is the status of invoice 78668907 for Julia Soto (DOB 1966-08-03)?", "Open");
skip("What was the status of Julia Soto's (DOB 1966-08-03) appointment on 2025-10-28?".replace("2025-10-28", "2025-06-02") + " Both of them."); // unaccounted words
// ── declined: hard negatives from the suite, and shapes the path must never answer
skip("How many lab reports for Ward, Emily (DOB 1936-10-29) are still unreviewed?");
skip("Why did Ward, Cheryl (DOB 04/19/1973) cancel the appointment on 2025-06-02?");
skip("What is the oldest unpaid invoice for Hayes, Jennifer (DOB 1976-10-02)?");
skip("Hayes, Caleb (born April 19, 1931) — next scheduled appointment date?");
skip("When was Hayes, Danielle (DOB 01/31/1962) last called by the office?");
skip("Number of missed appointments (no-show) for Barbara Brooks, DOB 2024-01-03, last 12 months?");
skip("Who issued invoice 77469606?");
skip("List the exact two names on Julia Soto's (DOB 1966-08-03) most recent appointment.");
skip("What are the names of Julia Soto's (DOB 1966-08-03) providers?");
skip("Reserve P04974 for the 2026-03-02 slot: what is the status of the visit?");
skip("Is Julia Soto (DOB 1966-08-03) male?");
skip("Who saw Julia Soto (DOB 1966-08-03) at her last completed visit?"); // titled provider name
skip("What is the most recent invoice for Hayes, Danielle (DOB 01/31/1962)?"); // two date columns
skip("When was Julia Soto's (DOB 1966-08-03) appointment?"); // several rows disagree
skip("How much does Julia Soto (DOB 1966-08-03) owe in total?");
skip("What time is Julia Soto's (DOB 1966-08-03) appointment on 2026-09-30?");
skip("Which payer covers Julia Soto (DOB 1966-08-03)?", INS2); // primary and secondary disagree
ok(run("How many lab reports are on file for Julia Soto (DOB 1966-08-03)?", "model").startsWith("SKIP"), "a count needs a page-proven list");
// held-out (bench/lookup-heldout.ts) regressions: "date of birth" is the DOB, never a row date; a bare date never selects rows
want("How many appointments are on file for Julia Soto, date of birth 08/03/1966,?", "4");
skip("How many appointments did Julia Soto (DOB 1966-08-03) have 2025-06-02?");
want("Who created the record for Lisa Soto (DOB 08/17/2014)?", "mmartinez");
want("What insurance plan is listed for Lisa Soto, date of birth 08/17/2014?", "Senior Complete");
want("When did atopic dermatitis begin for Ward, James (D.O.B. 01/07/2009)?", "2013-11-10");
want("When did the newest lab report for Julia Soto, DOB 1966-08-03, come in?", "2025-11-12");
ok(run("Which secondary payer covers Julia Soto (DOB 1966-08-03)?", "page", INS2) === "State Family Assistance", "block heading narrows: secondary payer");

console.log(`lookup.test: ${n - fail}/${n} passed`);
if (fail) process.exit(1);
