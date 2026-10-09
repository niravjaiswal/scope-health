/**
 * Risk-audit guards (guards.ts) on the lookup path, offline. Each guard: the risky question declines with the guard on,
 * answers (the 265 behaviour) with it off, and the safe neighbours keep answering either way.
 *   npx tsx src/wrenfield/guards.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { JSDOM } from "jsdom";
import { lookup, lookupSpec, answerFromRows, answerFromBlocks, hasRecurringSeries, type LookupSpec } from "./lookup.js";
import { guard } from "./guards.js";
import { chartQuestion } from "./chartAnswers.js";
import type { Row } from "./solver/toolkit.js";

let fail = 0, n = 0;
const ok = (c: boolean, msg: string) => { n++; if (!c) { fail++; console.log("FAIL " + msg); } };
const R = (cells: Record<string, string>): Row => ({ cells, links: [] });

const APPT_H = ["Date and time", "Type", "Provider", "Location", "Status"];
const ap = (when: string, type: string, loc: string, status: string) => R({ "Date and time": when, Type: type, Provider: "Hannah Ramos, MD", Location: loc, Status: status });
const PAST = [ap("Oct 28, 2025, 9:00 AM MDT", "Diabetes management", "Willow Creek", "Completed"), ap("Jun 2, 2025, 10:40 AM MDT", "Follow-up", "Willow Creek", "Cancelled"), ap("Jan 14, 2025, 8:20 AM MST", "Physical", "Stonebrook", "Completed")];
const WITH_BOOKED = [ap("Dec 1, 2026, 8:20 AM MST", "Follow-up", "Prairie View", "Scheduled"), ...PAST];
const LAST_CANCELLED = [ap("Nov 5, 2025, 9:00 AM MST", "Follow-up", "Stonebrook", "No-show"), ...PAST];
const ACT_H = ["When", "User", "What"];
const ACTS = [
  R({ When: "Oct 9, 2026, 7:21 PM MDT", User: "frontdesk", What: "Opened the chart" }),
  R({ When: "Jul 30, 2026, 7:21 PM MDT", User: "amendez", What: "Opened the chart" }),
  R({ When: "Jul 1, 2026, 7:21 PM MDT", User: "jrodriguez", What: "Changed the phone number" }),
  R({ When: "Sep 11, 2023, 8:52 AM MDT", User: "mmartinez", What: "Created the record" }),
];
const PROB_H = ["Code", "Condition", "Onset"];
const PROBS = [R({ Code: "L20.9", Condition: "Atopic dermatitis", Onset: "Nov 10, 2013" }), R({ Code: "J45.909", Condition: "Asthma, unspecified", Onset: "Feb 2, 2015" })];
const DOC_H = ["Title", "Type", "Received", "Actions"];
const DOCS = [R({ Title: "Basic metabolic panel", Type: "Lab report", Received: "Nov 12, 2025", Actions: "View" }), R({ Title: "Complete blood count", Type: "Lab report", Received: "Mar 3, 2025", Actions: "View" })];
const INS = [{ heading: "Soto, Lisa", pairs: [["MRN", "HG3354880"]] as Array<[string, string]> },
  { heading: "Primary insurance", pairs: [["Payer", "Senior Advantage of the Plains"], ["Plan", "Senior Complete"]] as Array<[string, string]> }];

const P = "Julia Soto (DOB 1966-08-03)";
function run(q: string, rows: Row[] = PAST, entity = "appointment"): string {
  const s = lookupSpec(q); if ("why" in s) return "SKIP " + s.why;
  if (s.entity === "insurance-fields") { const o = answerFromBlocks(s, INS); return "answer" in o ? o.answer : "SKIP " + o.why; }
  const t: Record<string, [string[], Row[]]> = { appointment: [APPT_H, rows], activity: [ACT_H, ACTS], problem: [PROB_H, PROBS], document: [DOC_H, DOCS] };
  const [h, r] = t[s.entity] ?? t[entity];
  const o = answerFromRows(s as LookupSpec, h, r, "page"); return "answer" in o ? o.answer : "SKIP " + o.why;
}
const skip = (q: string, rows?: Row[]) => { const g = run(q, rows); ok(g.startsWith("SKIP"), `guard on: want a skip, got ${g} :: ${q}`); };
const want = (q: string, a: string, rows?: Row[]) => { const g = run(q, rows); ok(g === a, `want ${a}, got ${g} :: ${q}`); };
const off = (name: string, f: () => void) => { const old = process.env[`AGENT_GUARD_${name}`]; process.env[`AGENT_GUARD_${name}`] = "off"; try { f(); } finally { if (old === undefined) delete process.env[`AGENT_GUARD_${name}`]; else process.env[`AGENT_GUARD_${name}`] = old; } };

// ── the switch itself
ok(guard("LOOKUP_TIME") === true, "default on");
{ process.env.AGENT_GUARDS = "off"; ok(!guard("LOOKUP_TIME"), "AGENT_GUARDS=off turns it off"); process.env.AGENT_GUARD_LOOKUP_TIME = "on"; ok(guard("LOOKUP_TIME"), "a per-guard on wins"); delete process.env.AGENT_GUARD_LOOKUP_TIME; delete process.env.AGENT_GUARDS; }

// ── LOOKUP_TIME: a cell shows date AND time; "date and time" answered with the date alone is the wrong form
skip(`What date and time was ${P}'s last completed appointment?`);
skip(`When was ${P}'s last completed appointment, date and time?`);
want(`When was ${P}'s last completed appointment?`, "2025-10-28");
want(`What date was ${P}'s last completed appointment?`, "2025-10-28");
off("LOOKUP_TIME", () => want(`What date and time was ${P}'s last completed appointment?`, "2025-10-28"));

// ── CHART_TIME: the 278 chart answerer had the same hazard (the end-to-end practice run answered "2026-01-07" to "date and time")
{
  const qT = `What date and time was ${P}'s last completed appointment?`, qD = `On what date was ${P}'s last completed appointment?`;
  ok(chartQuestion(qT) === null, "chartQuestion: 'date and time' is not routed");
  ok(chartQuestion(qD)?.kind === "appt-extreme", "chartQuestion: a date question still is");
  off("CHART_TIME", () => ok(chartQuestion(qT)?.kind === "appt-extreme", "guard off: routed as before"));
}

// ── LOOKUP_ACTIVITY: our own chart opens are rows of the log
skip(`Which user most recently opened ${P}'s chart?`);
skip(`Who was the last user on ${P}'s record?`);
skip(`How many activity entries does ${P} have?`);
skip(`What was the last activity on ${P}'s record?`);
want(`Which user created ${P}'s record?`, "mmartinez");
want(`Which user changed the phone number on ${P}'s record?`, "jrodriguez");
off("LOOKUP_ACTIVITY", () => want(`Who was the last user on ${P}'s record?`, "frontdesk"));

// ── LOOKUP_EDGE: "last appointment" = the newest row only when that row is a completed visit
skip(`Where was ${P}'s last appointment?`, WITH_BOOKED);            // newest row is booked, not yet happened
skip(`What type was ${P}'s last appointment?`, LAST_CANCELLED);     // newest row is a no-show
skip(`What type was ${P}'s first appointment?`, [...PAST, ap("Feb 1, 2024, 8:00 AM MST", "Physical", "Stonebrook", "Cancelled")]);
want(`Where was ${P}'s last appointment?`, "Willow Creek", PAST);   // newest row is a completed visit: both readings agree
want(`Where was ${P}'s last completed appointment?`, "Willow Creek", WITH_BOOKED); // the status is named: one reading
want(`Where was ${P}'s last scheduled appointment?`, "Prairie View", WITH_BOOKED);
off("LOOKUP_EDGE", () => want(`Where was ${P}'s last appointment?`, "Prairie View", WITH_BOOKED));

// ── LOOKUP_SYN_DATE: "diagnosed" asks for the onset date only in a when / what-date question
skip(`What was ${P} diagnosed with first?`);
want(`When was ${P} diagnosed with atopic dermatitis?`, "2013-11-10");
want(`When did atopic dermatitis begin for ${P}?`, "2013-11-10");
want(`Which condition was ${P} diagnosed with in 2015?`, "Asthma, unspecified");
skip(`Which lab report arrived last for ${P}?`);
want(`When did the last lab report arrive for ${P}?`, "2025-11-12");
off("LOOKUP_SYN_DATE", () => want(`What was ${P} diagnosed with first?`, "2013-11-10"));

// ── LOOKUP_INS_DATE: the insurance page shows today's coverage
skip(`Which payer covered ${P} on 2025-05-01?`);
skip(`What was the previous insurance payer of ${P}?`);
skip(`Which payer did ${P} have before 2025-01-01?`);
want(`Which payer covers ${P}?`, "Senior Advantage of the Plains");
want(`What insurance plan is listed for Lisa Soto, date of birth 08/17/2014?`, "Senior Complete");
off("LOOKUP_INS_DATE", () => want(`Which payer covered ${P} on 2025-05-01?`, "Senior Advantage of the Plains"));

// ── LOOKUP_RECURRING: a chart's recurring series are appointments that are not rows of the table (captured chart texts)
{
  const covDir = new URL("../../bench/loop/data/cov/", import.meta.url);
  const page1 = (f: string) => readFileSync(new URL(f, covDir), "utf8").split("=====PAGE 2")[0];
  const withSeries = page1("c-4v3xdxzrp4-appointments.txt");           // Hayes, Roy: "1 recurring appointment" above the table
  ok(hasRecurringSeries(withSeries, 0), "practice chart with a recurring series (text)");
  ok(hasRecurringSeries("", 1) && hasRecurringSeries("x", 2), "a /recurring/ link is enough");
  ok(hasRecurringSeries("", 0), "unreadable text counts as a series (decline)");
  const none = readdirSync(covDir).filter((f) => /-appointments\.txt$/.test(f)).map((f) => [f, page1(f)] as const).filter(([, t]) => !/recurring/i.test(t));
  ok(none.length >= 25 && none.every(([, t]) => !hasRecurringSeries(t, 0)), `charts without a series are not flagged (${none.length} checked)`);
  ok(!hasRecurringSeries("Appointments, newest first\nDate and time\tType\n0 recurring appointments\n", 0), "an explicit zero");
  ok(hasRecurringSeries("Recurring appointments\nEvery 4 weeks on Friday at 14:00\nWound care with X\nFeb 6, 2026 to Jul 20, 2026, 1 changed date\n\n1 recurring appointment", 0), "Set 1 chart wording");
}


// the recon capture of a Set 1 chart's Appointments tab (4 recurring series above the table): the live probe finds the /recurring/ links
{
  const recon = readFileSync(new URL("../../fixtures/set1/recon-158.txt", import.meta.url), "utf8");
  const seg = recon.split("@@@@ /patients/{id}/appointments ::")[1]?.split("\n@@@@")[0] ?? "";
  const html = seg.split("---- HTML ----")[1] ?? "";
  const doc = new JSDOM(html).window.document;
  const links = doc.querySelectorAll('a[href*="/recurring/"]').length;
  ok(links === 4, `Set 1 chart (Johnson, Elena): 4 /recurring/ links found by the probe's selector, got ${links}`);
  ok(hasRecurringSeries(doc.body.textContent ?? "", links), "...and flagged");
  const tables = [...doc.querySelectorAll("table")].map((t) => t.querySelector("caption")?.textContent ?? "");
  ok(tables.some((t) => /^Appointments, newest first/.test(t)), "the series are NOT rows of the appointments table (the table holds only the one-off appointments)");
}

// ── LOOKUP_PROVIDER: a DOB-less name that is also on the provider roster is not a patient (declines before any browsing)
{
  const isProvider = (n: string) => /^hannah ramos$/i.test(n.trim());
  const q = "How many appointments did Hannah Ramos have on 2025-06-02?";
  const r = await lookup(q, null as any, 1000, () => {}, { isProvider });
  ok("why" in r && /provider/.test(r.why), `provider name, no DOB declines: ${JSON.stringify(r)}`);
  const r2 = await lookup(q, null as any, 1000, () => {}, { isProvider: () => false }).catch((e) => ({ why: "threw (reached the browser path, as intended): " + String(e).slice(0, 40) }));
  ok("why" in r2 && !/also a provider/.test(r2.why), "a non-provider name goes on to the patient lookup");
  process.env.AGENT_GUARD_LOOKUP_PROVIDER = "off";
  const r3 = await lookup(q, null as any, 1000, () => {}, { isProvider }).catch((e) => ({ why: "threw (reached the browser path)" }));
  ok("why" in r3 && !/also a provider/.test(r3.why), "guard off: no provider decline");
  delete process.env.AGENT_GUARD_LOOKUP_PROVIDER;
}

console.log(`guards.test: ${n - fail}/${n} passed`);
if (fail) process.exit(1);
