/** Generic chart answerers: routing by meaning (paraphrases), hard negatives, answers on a record, and end-to-end through handleItem. */
import { chartQuestion, chartAnswer, type ChartQ } from "./chartAnswers.js";
import { classifyIntent } from "./parse.js";
import { familyMatch } from "./families.js";
import { toPlan, params, exec, compiler } from "./run.js";
import { MessageStore, Classifier, handleItem, type PatientRecord, type ClinicIndex } from "./inference.js";

let fails = 0, n = 0;
const ok = (c: boolean, m: string) => { n++; if (!c) { fails++; console.log("FAIL", m); } };

// ── routing: each kind, ≥5 paraphrases not copied from Set 1
const R: Array<[string, string]> = [
  ["What is the MRN for Aaron Torres (born 1980-01-30)?", "chart.mrn"],
  ["Give me the medical record number of patient Torres, Aaron, DOB 01/30/1980.", "chart.mrn"],
  ["Which MRN does Aaron Torres (DOB 1980-01-30) have?", "chart.mrn"],
  ["Look up the chart's MRN for Aaron Torres, born January 30, 1980.", "chart.mrn"],
  ["I need Aaron Torres's MRN (born 1980-01-30).", "chart.mrn"],
  ["What sex is recorded for Abigail Torres (born 2019-12-11)?", "chart.sex"],
  ["Tell me the sex on file for patient Torres, Abigail, DOB 2019-12-11.", "chart.sex"],
  ["What gender does the chart list for Abigail Torres (born 2019-12-11)?", "chart.sex"],
  ["Which sex is on Abigail Torres's chart (DOB 2019-12-11)?", "chart.sex"],
  ["Look up the sex field for Abigail Torres, born Dec 11, 2019.", "chart.sex"],
  ["Who is the primary provider for Aaron Torres (born 1980-01-30)?", "chart.primary-provider"],
  ["Which primary care provider is listed for Torres, Aaron, DOB 1980-01-30?", "chart.primary-provider"],
  ["Who's Aaron Torres's PCP (born 1980-01-30)?", "chart.primary-provider"],
  ["Tell me the primary provider on the chart of patient Aaron Torres (DOB 1980-01-30).", "chart.primary-provider"],
  ["What is the primary doctor listed for Aaron Torres (born 1980-01-30)?", "chart.primary-provider"],
  ["What is the home location of Aaron Torres (born 1980-01-30)?", "chart.home-location"],
  ["Which home clinic is Aaron Torres (DOB 1980-01-30) assigned to?", "chart.home-location"],
  ["Tell me the home location on file for patient Torres, Aaron, DOB 1980-01-30.", "chart.home-location"],
  ["Look up Aaron Torres's home location (born January 30, 1980).", "chart.home-location"],
  ["For Aaron Torres (born 1980-01-30), what home location does the chart show?", "chart.home-location"],
  ["When was Aaron Torres's last completed appointment (born 1980-01-30)?", "chart.appt-extreme"],
  ["On what date did Aaron Torres (DOB 1980-01-30) have his most recent completed visit?", "chart.appt-extreme"],
  ["Which provider saw Aaron Torres (born 1980-01-30) at his first completed visit?", "chart.appt-extreme"],
  ["What type of visit was Aaron Torres's most recent no-show appointment (born 1980-01-30)?", "chart.appt-extreme"],
  ["What was the date of the latest cancelled appointment for patient Aaron Torres, DOB 1980-01-30?", "chart.appt-extreme"],
  ["How many completed appointments did Aaron Torres (born 1980-01-30) have in 2025?", "chart.appt-count"],
  ["Count the no-show visits for patient Torres, Aaron, DOB 1980-01-30, during 2025. How many were there?", "chart.appt-count"],
  ["How many cancelled appointments did Aaron Torres (born 1980-01-30) have in March 2026?", "chart.appt-count"],
  ["How many completed visits did Aaron Torres (DOB 1980-01-30) have from 2025-01-01 to 2025-06-30?", "chart.appt-count"],
  ["What number of completed appointments does Aaron Torres (born 1980-01-30) have in 2026?", "chart.appt-count"],
  ["When was the most recent imaging report received for Aaron Torres (born 1980-01-30)?", "chart.doc-extreme"],
  ["On what date did the latest referral letter for patient Ana Corbett (born 2000-11-13) come in?", "chart.doc-extreme"],
  ["What date was the first discharge summary received for Torres, Aaron, DOB 1980-01-30?", "chart.doc-extreme"],
];
for (const [q, want] of R) { const i = classifyIntent(q); ok(i?.type === want, `route ${want}: got ${i?.type} :: ${q}`); ok(familyMatch(q) === null, "no family claims: " + q); }

// ── hard negatives: similar words, a different question → never a chart.* plan
const NEG = [
  "What is the MRN printed on the lab report received 2026-06-27 for Aaron Torres (born 1980-01-30)?",
  "Is Aaron Torres (born 1980-01-30) male?",
  "Does Aaron Torres (born 1980-01-30) have a primary provider?",
  "What is the phone number of Aaron Torres's primary provider (born 1980-01-30)?",
  "Who is the referring provider on Aaron Torres's referral letter (born 1980-01-30)?",
  "What is the home location's phone number for Aaron Torres (born 1980-01-30)?".replace("home location's phone number", "emergency contact's home location"),
  "How many patients had a completed visit at Highline in 2025?",
  "Which provider had the most completed visits in 2025?",
  "When is Aaron Torres's next appointment (born 1980-01-30)?",
  "How many open slots does Lawrence Rodriguez, NP have on 2026-10-20?",
  "What is the invoice number for Aaron Torres's last completed visit (born 1980-01-30)?",
  "When was Aaron Torres's last appointment (born 1980-01-30)? And what is his MRN?",
  "Was Aaron Torres's last completed visit with Zachary Ruiz, MD?",
  "What is the first letter of Aaron Torres's MRN (born 1980-01-30)?",
  "What is the primary doctor for Aaron Torres (born 1980-01-30)? Give the first and last name.",
];
for (const q of NEG) { const i = classifyIntent(q); ok(!i?.type.startsWith("chart."), `negative routed ${i?.type} :: ${q}`); }
// incomplete → routes (claims the question) but the solver must decline
const DECLINE = [
  "How many appointments did Aaron Torres (born 1980-01-30) have in 2025?",            // no status
  "How many completed appointments did Aaron Torres (born 1980-01-30) have?",          // no window
  "How many completed visits did Aaron Torres (born 1980-01-30) have between 2025-01-01 and 2025-06-30?", // inclusivity unstated
  "When was Aaron Torres's last appointment (born 1980-01-30)?",                        // no status
  "When and with whom was Aaron Torres's last completed visit (born 1980-01-30)?",      // two things
  "When was the most recent document received for Aaron Torres (born 1980-01-30)?",     // no type
];

// ── answers on a record (the practice chart of Aaron Torres as read by eye, abbreviated)
const A = (dateISO: string, service: string, provider: string, location: string, status: string) => ({ dateISO, service, provider, location, status });
const pat: PatientRecord = { id: "/patients/x", name: "Aaron Torres", dobISO: "1980-01-30", appointmentsComplete: true,
  demographics: { sex: "Male", phone: "(218) 665-4402", email: "Not on file", address: "6394 Sunset St, Cinder Pass, CO 80796", "primary provider": "Lawrence Rodriguez, NP", "home location": "Highline" } as any,
  appointments: [A("2026-10-20", "Telehealth visit", "Lawrence Rodriguez, NP", "Highline", "Scheduled"), A("2026-09-23", "Skin biopsy", "Joshua Bowman, PA", "Highline", "Completed"),
    A("2026-08-06", "Prenatal visit", "Lawrence Rodriguez, NP", "Highline", "Cancelled"), A("2025-10-24", "Office visit", "Lawrence Rodriguez, NP", "Highline", "No-show"),
    A("2025-11-04", "Office visit", "Lawrence Rodriguez, NP", "Highline", "Completed"), A("2025-05-19", "Follow-up visit", "Ann Foster, MD", "Prairie View", "Completed"),
    A("2024-12-04", "New patient visit", "Lawrence Rodriguez, NP", "Highline", "Completed")],
  documents: [{ title: "Imaging report: Chest", kind: "Imaging report", receivedISO: "2026-06-27" }, { title: "Discharge summary", kind: "Discharge summary", receivedISO: "2025-01-02" }] } as any;
(pat as any).mrn = "HG3351915";
const ans = (q: string) => { const cq = chartQuestion(q); if (!cq) return null; return chartAnswer(cq, pat, () => {}, "2026-10-08"); };
const E: Array<[string, string | null]> = [
  [R[0][0], "HG3351915"], [R[10][0], null], [R[14][0], null] /* primary provider: SKIP (title form unproven) */, [R[15][0], "Highline"], ["What sex is recorded for Aaron Torres (born 1980-01-30)?", "Male"],
  [R[20][0], "2026-09-23"], [R[22][0], null], [R[23][0], "Office visit"], [R[24][0], "2026-08-06"],
  [R[25][0], "2"], [R[26][0], "1"], [R[27][0], "0"], [R[28][0], "1"], [R[29][0], "1"],
  [R[30][0], "2026-06-27"], [R[32][0], "2025-01-02"],
  ...DECLINE.map((q) => [q, null] as [string, null]),
];
for (const [q, want] of E) { const got = ans(q); ok(got === want, `answer want ${want} got ${got} :: ${q}`); }
// an incomplete appointment history declines every appointment kind
{ const p2 = { ...pat, appointmentsComplete: false } as any; ok(chartAnswer(chartQuestion(R[20][0])!, p2, () => {}) === null, "incomplete history declines"); }
// MRN not proven → decline
{ const p3 = { ...pat } as any; delete p3.mrn; ok(chartAnswer(chartQuestion(R[0][0])!, p3, () => {}) === null, "unproven MRN declines"); }
// a tie on the extreme date with different providers → decline
{ const p4 = { ...pat, appointments: [...pat.appointments, A("2026-09-23", "Office visit", "Zachary Ruiz, MD", "Highline", "Completed")] } as any;
  ok(chartAnswer(chartQuestion(R[22][0].replace("first", "most recent"))!, p4, () => {}) === null, "tie declines"); }

// ── end-to-end through handleItem with the sample index (a patient the index can resolve)
{ const idx: ClinicIndex = { providers: new Map(), appointments: [], byDate: () => [], findPatient: (nm, dob) => (nm === "Aaron Torres" && (!dob || dob === "1980-01-30") ? pat : null), nameIsPatient: (nm) => nm === "Aaron Torres" };
  const store = new MessageStore(compiler); const cls = new Classifier(toPlan, async () => { throw new Error("x"); }, store);
  const deps = { index: idx, store, classifier: cls, params, verify: (_: any, r: unknown) => r != null, exec };
  const run = async (q: string) => { const o: any = await handleItem({ kind: "task", text: q }, deps); return "answer" in o ? o.answer : null; };
  ok(await run(R[0][0]) === "HG3351915", "e2e MRN");
  ok(await run(R[25][0]) === "2", "e2e count");
  ok(await run("How many completed visits did Aaron Torres (born 1980-01-30) have with Ann Foster, MD in 2025?") === null, "e2e provider-scope declines");
  ok(await run("What is the MRN for Zed Nobody (born 1980-01-30)?") === null, "e2e unresolved patient declines"); }

console.log(fails ? `chartAnswers: ${fails}/${n} FAIL` : `✓ chartAnswers: ${n} passed, 0 failed`);
process.exit(fails ? 1 : 0);
