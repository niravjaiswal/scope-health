/**
 * Answer-form flags (formFlags.ts, FORM-THEORIES.md): AGENT_FORM_PROVIDER = off|stated|titled|bare, AGENT_FORM_DATETIME = off|on.
 * Flags OFF must be today's behaviour byte for byte (the same record with providerRaw / time captured answers as before);
 * each flag value changes only what its doc says. Also: a credentialed list of providers is never sent as one comma-joined string.
 *   npx tsx src/wrenfield/formFlags.test.ts
 */
import { providerFormCue, providerAnswer, hhmm, dateTime, providerMode, dateTimeOn, namedZone } from "./formFlags.js";
import { chartQuestion, chartAnswer } from "./chartAnswers.js";
import { classifyIntent } from "./parse.js";
import { lookupSpec, answerFromRows, type LookupSpec } from "./lookup.js";
import { parseAggQuery } from "./aggregate.js";
import { toPlan, params, exec, compiler } from "./run.js";
import { MessageStore, Classifier, handleItem, type PatientRecord, type ClinicIndex } from "./inference.js";
import type { Row } from "./solver/toolkit.js";

let fails = 0, n = 0;
const ok = (c: boolean, m: string) => { n++; if (!c) { fails++; console.log("FAIL", m); } };
const setEnv = (provider: string | undefined, dt: string | undefined) => {
  if (provider === undefined) delete process.env.AGENT_FORM_PROVIDER; else process.env.AGENT_FORM_PROVIDER = provider;
  if (dt === undefined) delete process.env.AGENT_FORM_DATETIME; else process.env.AGENT_FORM_DATETIME = dt;
};

// ── flag parsing: unknown values are off
setEnv(undefined, undefined); ok(providerMode() === "off" && !dateTimeOn(), "default off");
setEnv("TITLED", "ON"); ok(providerMode() === "titled" && dateTimeOn(), "case-insensitive");
setEnv("yes", "1"); ok(providerMode() === "off" && !dateTimeOn(), "unknown values are off");

// ── the form a question states
const CUE: Array<[string, "bare" | "titled" | null]> = [
  ["Which primary doctor does Aaron Torres (born 1980-01-30) have? Give the first and last name.", "bare"],
  ["List them with the most first, by first and last name.", "bare"],
  ["Who is the primary provider for Aaron Torres? Name only, please.", "bare"],
  ["Primary provider for Aaron Torres, without the title.", "bare"],
  ["Primary provider for Aaron Torres, no credentials.", "bare"],
  ["Who is the primary provider for Aaron Torres? Include their credentials.", "titled"],
  ["Primary provider for Aaron Torres, with title.", "titled"],
  ["Who is the primary provider for Aaron Torres (born 1980-01-30)?", null],
  ["Primary provider, as last name, first name.", null],
  ["Primary provider: first and last name, with their credentials.", null], // states both -> never guess
];
for (const [q, want] of CUE) ok(providerFormCue(q) === want, `cue ${want} :: ${q} got ${providerFormCue(q)}`);

// ── providerAnswer matrix
{
  const A = (shown: string | undefined, cue: "bare" | "titled" | null, mode: any, bare?: string) => { const r = providerAnswer(shown, cue, mode, bare); return "answer" in r ? r.answer : null; };
  ok(A("Roy Nelson, MD", null, "off") === null && A("Roy Nelson, MD", "bare", "off") === null, "off declines even when the question states a form");
  ok(A("Roy Nelson, MD", null, "stated") === null, "stated: no cue declines");
  ok(A("Roy Nelson, MD", "bare", "stated") === "Roy Nelson" && A("Roy Nelson, MD", "titled", "stated") === "Roy Nelson, MD", "stated: the cue decides");
  ok(A("Roy Nelson, MD", null, "titled") === "Roy Nelson, MD" && A("Roy Nelson, MD", null, "bare") === "Roy Nelson", "titled / bare defaults");
  ok(A("Roy Nelson, MD", "bare", "titled") === "Roy Nelson" && A("Roy Nelson, MD", "titled", "bare") === "Roy Nelson, MD", "a stated form beats the default");
  ok(A("Dr. Ana Ruiz, NP", null, "bare") === "Ana Ruiz" && A("Ana Ruiz", null, "titled") === "Ana Ruiz", "bare strips Dr./credential; a name shown bare stays");
  ok(A(undefined, null, "titled") === null && A("None on file", null, "bare") === null && A("—", null, "titled") === null, "empty states decline");
  ok(A(undefined, null, "titled", "Roy Nelson") === null, "titled without the shown text declines (title not captured)");
  ok(A(undefined, null, "bare", "Roy Nelson") === "Roy Nelson", "bare falls back to the stripped name");
}

// ── clock times
ok(hhmm("2:20 PM MDT") === "14:20" && hhmm("9:00 AM MDT") === "09:00" && hhmm("12:05 AM") === "00:05" && hhmm("12:30 PM") === "12:30" && hhmm("14:20") === "14:20" && hhmm("09:20:00") === "09:20", "hhmm forms");
ok(hhmm("") === undefined && hhmm("noon") === undefined && hhmm("13:00 PM") === undefined && hhmm("9:20:30") === undefined && hhmm("25:00") === undefined, "hhmm declines");
ok(dateTime("2026-09-30", ", 2:20 PM MDT") === "2026-09-30T14:20" && dateTime("2026-09-30", "") === undefined, "dateTime");
ok(namedZone("at 2 PM Central time") === "C" && namedZone("in Mountain Standard Time please") === "M" && namedZone("in EST") === "E" && namedZone("UTC") === "other" && namedZone("at the local time") === null && namedZone("When was it?") === null, "namedZone");
ok(dateTime("2026-09-30", "2:20 PM MDT", "M") === "2026-09-30T14:20" && dateTime("2026-09-30", "2:20 PM MDT", "C") === undefined && dateTime("2026-09-30", "2:20 PM", "M") === undefined && dateTime("2026-09-30", "2:20 PM MDT", "other") === undefined && dateTime("2026-09-30", "2:20 PM", null) === "2026-09-30T14:20", "a named zone must match the site's zone; no conversion");

// ── a chart: appointment rows carry providerRaw / time (as the crawl captures them)
const A1 = (dateISO: string, time: string | undefined, service: string, provider: string, raw: string | undefined, location: string, status: string) => ({ dateISO, time, service, provider, providerRaw: raw, location, status });
const base = (): PatientRecord => ({ id: "/patients/x", name: "Aaron Torres", dobISO: "1980-01-30", appointmentsComplete: true,
  demographics: { sex: "Male", phone: "(218) 665-4402", email: "Not on file", address: "6394 Sunset St", "primary provider": "Lawrence Rodriguez, NP", "home location": "Highline" } as any,
  appointments: [A1("2026-10-20", "9:00 AM MDT", "Telehealth visit", "Lawrence Rodriguez", "Lawrence Rodriguez, NP", "Highline", "Scheduled"),
    A1("2026-09-23", "2:20 PM MDT", "Skin biopsy", "Joshua Bowman", "Joshua Bowman, PA", "Highline", "Completed"),
    A1("2025-11-04", "8:40 AM MDT", "Office visit", "Lawrence Rodriguez", "Lawrence Rodriguez, NP", "Highline", "Completed"),
    A1("2025-05-19", "10:00 AM MDT", "Follow-up visit", "Ann Foster", "Ann Foster, MD", "Prairie View", "Completed")],
  documents: [] } as any);
const ans = (pat: PatientRecord, q: string) => { const cq = chartQuestion(q); if (!cq) return "ROUTE-NULL"; return chartAnswer(cq, pat, () => {}, "2026-10-08"); };
const PRIM = "Who is the primary provider for Aaron Torres (born 1980-01-30)?";
const PRIM_BARE = "Who is the primary provider for Aaron Torres (born 1980-01-30)? Give the first and last name.";
const PRIM_TITLE = "Who is the primary provider for Aaron Torres (born 1980-01-30)? Include their credentials.";
const LASTPROV = "Which provider saw Aaron Torres (born 1980-01-30) at the most recent completed visit?";
const FIRSTPROV = "Which provider saw Aaron Torres (born 1980-01-30) at the first completed visit?";
const LASTDATE = "When was Aaron Torres's last completed appointment (born 1980-01-30)?";
const FIRSTDATE = "On what date did Aaron Torres (DOB 1980-01-30) have the first completed visit?";

// flags OFF: today's behaviour, even with providerRaw / time on the rows
setEnv(undefined, undefined);
{
  const p = base();
  ok(ans(p, PRIM) === null && ans(p, LASTPROV) === null, "off: provider declines");
  ok(ans(p, LASTDATE) === "2026-09-23" && ans(p, FIRSTDATE) === "2025-05-19", "off: dates stay date-only");
  ok(classifyIntent(PRIM_BARE)?.type === "skip.derived", "off: 'first and last name' is a derived-part skip, as today");
  ok(ans(p, PRIM_BARE) === null, "off: a stated form does not unlock");
}
// stated
setEnv("stated", undefined);
{
  const p = base();
  ok(ans(p, PRIM) === null && ans(p, LASTPROV) === null, "stated: unstated form declines");
  ok(classifyIntent(PRIM_BARE)?.type === "chart.primary-provider", "stated: 'first and last name' routes to the chart answerer");
  ok(ans(p, PRIM_BARE) === "Lawrence Rodriguez" && ans(p, PRIM_TITLE) === "Lawrence Rodriguez, NP", "stated: primary provider by the question's form");
  ok(ans(p, LASTPROV + " Give the first and last name.") === "Joshua Bowman" && ans(p, LASTPROV + " Include their credentials.") === "Joshua Bowman, PA", "stated: row provider by the question's form");
}
// titled / bare
setEnv("titled", undefined);
{
  const p = base();
  ok(ans(p, PRIM) === "Lawrence Rodriguez, NP" && ans(p, LASTPROV) === "Joshua Bowman, PA" && ans(p, FIRSTPROV) === "Ann Foster, MD", "titled: the product's text");
  ok(ans(p, PRIM_BARE) === "Lawrence Rodriguez", "titled: a stated bare form still wins");
  const noRaw = base(); noRaw.appointments = noRaw.appointments.map((a: any) => ({ ...a, providerRaw: undefined }));
  ok(ans(noRaw, LASTPROV) === null && ans(noRaw, PRIM) === "Lawrence Rodriguez, NP", "titled: a row whose title was not captured declines");
  const tie = base(); tie.appointments.push(A1("2026-09-23", "4:00 PM MDT", "Office visit", "Ann Foster", "Ann Foster, MD", "Highline", "Completed") as any);
  ok(ans(tie, LASTPROV) === null, "titled: two providers on the extreme date decline");
  const noPrimary = base(); (noPrimary.demographics as any)["primary provider"] = "None on file";
  ok(ans(noPrimary, PRIM) === null, "titled: an empty primary provider declines");
}
setEnv("bare", undefined);
{
  const p = base();
  ok(ans(p, PRIM) === "Lawrence Rodriguez" && ans(p, LASTPROV) === "Joshua Bowman" && ans(p, FIRSTPROV) === "Ann Foster", "bare: first + last name");
  ok(ans(p, PRIM_TITLE) === "Lawrence Rodriguez, NP", "bare: a stated titled form still wins");
  const noRaw = base(); noRaw.appointments = noRaw.appointments.map((a: any) => ({ ...a, providerRaw: undefined }));
  ok(ans(noRaw, LASTPROV) === "Joshua Bowman", "bare: needs no captured title");
}
// datetime
setEnv(undefined, "on");
{
  const p = base();
  ok(ans(p, LASTDATE) === "2026-09-23T14:20" && ans(p, FIRSTDATE) === "2025-05-19T10:00", "datetime: the extreme appointment's clock time rides along");
  const two = base(); two.appointments.push(A1("2026-09-23", "9:15 AM MDT", "Office visit", "Joshua Bowman", "Joshua Bowman, PA", "Highline", "Completed") as any);
  ok(ans(two, LASTDATE) === "2026-09-23T14:20" && ans(two, "On what date did Aaron Torres (DOB 1980-01-30) have the first completed visit on file?") === "2025-05-19T10:00", "datetime: two on the extreme date -> the later (last) / earlier (first) time");
  const first2 = base(); first2.appointments.push(A1("2025-05-19", "8:00 AM MDT", "Office visit", "Ann Foster", "Ann Foster, MD", "Prairie View", "Completed") as any);
  ok(ans(first2, FIRSTDATE) === "2025-05-19T08:00", "datetime: first = the earliest time that day");
  const noTime = base(); noTime.appointments = noTime.appointments.map((a: any) => ({ ...a, time: undefined }));
  ok(ans(noTime, LASTDATE) === "2026-09-23", "datetime: no captured time -> the date alone, as today");
  const oneNoTime = base(); oneNoTime.appointments.push(A1("2026-09-23", undefined, "Office visit", "Joshua Bowman", "Joshua Bowman, PA", "Highline", "Completed") as any);
  ok(ans(oneNoTime, LASTDATE) === "2026-09-23", "datetime: a same-day row without a time -> the date alone");
  ok(ans(p, PRIM) === null, "datetime on does not touch the provider flag");
  ok(ans(p, LASTDATE.replace("?", " in Mountain time?")) === "2026-09-23T14:20", "datetime: the named zone is the site's zone");
  ok(ans(p, LASTDATE.replace("?", " in Central time?")) === "2026-09-23", "datetime: another named zone -> the date alone, no conversion");
}

// ── lookup cells (answerFromRows): a titled provider cell, a "Date and time" cell
const R = (cells: Record<string, string>): Row => ({ cells, links: [] });
const APPT_H = ["Date and time", "Type", "Provider", "Location", "Status"];
const APPTS = [
  R({ "Date and time": "Sep 30, 2026, 2:20 PM MDT", Type: "Immunization", Provider: "Janet Marshall, MD", Location: "Stonebrook", Status: "Completed" }),
  R({ "Date and time": "Oct 28, 2025, 9:00 AM MDT", Type: "Diabetes management", Provider: "Hannah Ramos, MD", Location: "Willow Creek", Status: "Completed" }),
  R({ "Date and time": "Jun 2, 2025, 10:40 AM MDT", Type: "Follow-up", Provider: "Hannah Ramos, MD", Location: "Willow Creek", Status: "Cancelled" }),
];
const lk = (q: string) => { const s = lookupSpec(q); if ("why" in s) return "SKIP " + s.why; const o = answerFromRows(s as LookupSpec, APPT_H, APPTS, "page"); return "answer" in o ? o.answer : "SKIP " + o.why; };
const LKP = "What provider did Julia Soto (DOB 1966-08-03) have at her last completed appointment?";
const LKD = "When was Julia Soto's (DOB 1966-08-03) last completed appointment?";
setEnv(undefined, undefined);
ok(lk(LKP).startsWith("SKIP") && lk(LKD) === "2026-09-30", "lookup off: titled cell declines, date-only");
setEnv("titled", "on");
ok(lk(LKP) === "Janet Marshall, MD" && lk(LKD) === "2026-09-30T14:20", `lookup titled+datetime: ${lk(LKP)} / ${lk(LKD)}`);
setEnv("bare", undefined);
ok(lk(LKP) === "Janet Marshall" && lk(LKD) === "2026-09-30", "lookup bare: stripped name, date-only");
setEnv("stated", undefined);
ok(lk(LKP).startsWith("SKIP"), "lookup stated: unstated form declines");
setEnv(undefined, "on");
ok(lk("What type of visit did Julia Soto (DOB 1966-08-03) have on 2025-06-02?") === "Follow-up", "datetime flag leaves a non-date answer alone");

// ── next appointment keyword plan, end to end through handleItem
{
  const pat = base();
  const idx: ClinicIndex = { providers: new Map(), appointments: [], byDate: () => [], findPatient: (nm, dob) => (nm === "Aaron Torres" && (!dob || dob === "1980-01-30") ? pat : null), nameIsPatient: (nm) => nm === "Aaron Torres" };
  const store = new MessageStore(compiler); const cls = new Classifier(toPlan, async () => { throw new Error("x"); }, store);
  const deps = { index: idx, store, classifier: cls, params, verify: (_: any, r: unknown) => r != null, exec };
  const run = async (q: string) => { const o: any = await handleItem({ kind: "task", text: q }, deps); return "answer" in o ? o.answer : null; };
  const NEXT = "When is Aaron Torres's next appointment (born 1980-01-30)?";
  setEnv(undefined, undefined); ok(await run(NEXT) === "2026-10-20", "next appointment off: date only (today)");
  setEnv(undefined, "on"); ok(await run(NEXT) === "2026-10-20T09:00", "next appointment datetime: with the time");
  setEnv("stated", undefined); ok(await run(PRIM_BARE) === "Lawrence Rodriguez" && await run(PRIM) === null, "e2e stated: the question's own form answers, an unstated one declines");
  setEnv("titled", undefined); ok(await run(PRIM) === "Lawrence Rodriguez, NP", "e2e titled");
  setEnv(undefined, undefined); ok(await run(PRIM_BARE) === null && await run(PRIM) === null, "e2e off: both decline");
}

// ── a credentialed list of providers is never one comma-joined string
{
  setEnv(undefined, undefined);
  const T = (t: string) => parseAggQuery(t);
  const SET1 = "Which three providers had the most completed visits across all locations in January 2025? List them with the most first, by first and last name. Only providers who are active today count. Leave out appointments of patients whose record is a test record or has been deleted. If any are tied, put them in alphabetical order by last name, then first name.";
  ok(T(SET1).q !== null, "set 1 top-providers wording still parses");
  const cred = T(SET1.replace("by first and last name", "with their credentials"));
  ok(cred.q === null && /split at every comma/.test((cred as any).why ?? ""), `credentials in a list of 3 declines :: ${JSON.stringify(cred).slice(0, 120)}`);
  const one = T("Which provider had the most completed visits across all locations in January 2025, with their credentials? Only providers who are active today count. Leave out appointments of patients whose record is a test record or has been deleted.");
  ok(one.q !== null && one.q.names === "first-last-credential" && one.q.k === 1, "a single credentialed name is still parsed");
}

setEnv(undefined, undefined);
console.log(fails ? `formFlags: ${fails}/${n} FAIL` : `✓ formFlags: ${n} passed, 0 failed`);
process.exit(fails ? 1 : 0);
