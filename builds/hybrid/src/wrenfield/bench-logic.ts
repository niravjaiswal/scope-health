/**
 * Tier-1 logic benchmark: the solver path (parse → plan → exec → format) against an oracle written
 * independently from the policy text, with no browser. Run: npx tsx src/wrenfield/bench-logic.ts [seed] [n]
 *
 * Sections: policy conformance (every edge case the workflow message names), recurrence expansion,
 * message amendments, question parsing, randomized boundary fuzz, and KNOWN GAPS (risks expected to
 * fail today — reported, not counted as failures, so fixing one shows up as "now passes").
 * Exit code 1 on any unexpected failure or any WRONG answer.
 */
import { format, MessageStore, type ClinicIndex, type PatientRecord, type Appointment, type Provider, type CompiledMessage } from "./inference.js";
import { toPlan, params, exec, compiler, neDefaults, neRule, applyNEChanges } from "./run.js";
import { extractSlots } from "./parse.js";
import { Crawler } from "./crawl.js";
import { taskFamily, ANSWERABLE } from "./families.js";
import { readFileSync } from "node:fs";

// ── independent calendar + oracle (string dates only; no Date objects) ──
const leap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const dim = (y: number, m: number) => [31, leap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (s: string) => s.split("-").map(Number) as [number, number, number];
const fmt = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
function addDay(s: string, k: 1 | -1): string {
  let [y, m, d] = ymd(s); d += k;
  if (d > dim(y, m)) { d = 1; m++; if (m > 12) { m = 1; y++; } }
  if (d < 1) { m--; if (m < 1) { m = 12; y--; } d = dim(y, m); }
  return fmt(y, m, d);
}
type Params = { windowYears: number; excluded: string[]; statuses: string[]; matchProvider: boolean; matchSpecialty: boolean };
const lc = (s: string) => s.toLowerCase().trim();
/** Policy text: "starts the day after the same date N years earlier and ends the day before the visit;
 *  for a visit on February 29, the same date N years earlier is February 28." */
function window(visit: string, years: number): [string, string] {
  const [y, m, d] = ymd(visit);
  const same = m === 2 && d === 29 ? fmt(y - years, 2, 28) : fmt(y - years, m, d);
  return [addDay(same, 1), addDay(visit, -1)];
}
function oracle(appts: Appointment[], spec: (n: string) => string | undefined, prov: string, visit: string, p: Params): string | null {
  const [lo, hi] = window(visit, p.windowYears);
  const ex = new Set(p.excluded.map(lc)), st = new Set(p.statuses.map(lc));
  const vs = spec(prov);
  let best = "", unknown = "";
  for (const a of appts) {
    if (!st.has(lc(a.status)) || ex.has(lc(a.service)) || a.dateISO < lo || a.dateISO > hi) continue;
    let ok = p.matchProvider && a.provider === prov;
    if (!ok && p.matchSpecialty) { const s = spec(a.provider); if (!s || !vs) { if (a.dateISO > unknown) unknown = a.dateISO; continue; } ok = s === vs; }
    if (ok && a.dateISO > best) best = a.dateISO;
  }
  // An unverifiable candidate later than the best verified one could be the most recent → no answer.
  if (unknown && unknown > best) return null;
  return best ? `ESTABLISHED:${best}` : "NEW";
}

// ── a tiny clinic + the real solver path ──
const PROVIDERS: Array<[string, string, string | undefined, boolean]> = [
  ["Walter Guzman", "PA", "Behavioral Health", true], ["Lawrence Bennett", "MD", "Behavioral Health", false], // former provider keeps specialty
  ["Kenneth Sullivan", "NP", "Family Medicine", true], ["Elena Gutierrez", "NP", "Family Medicine", true],
  ["Douglas Hughes", "MD", "Cardiology", true], ["Priya Raman", "DO", "Cardiology", true], ["Sam Ortiz", "PA-C", undefined, true],
];
const titleOf = new Map(PROVIDERS.map(([n, t]) => [n, t]));
const specOf = (n: string) => PROVIDERS.find(([x]) => x === n)?.[2];
const DEFAULT_EXCLUDED = ["Lab draw", "Immunization", "X-ray", "Ultrasound", "Electrocardiogram", "Echocardiogram", "Allergy injection", "Blood pressure check", "Hearing test", "Vision screening", "Infusion therapy", "Anticoagulation check"];
const DEFAULTS: Params = { windowYears: 3, excluded: DEFAULT_EXCLUDED, statuses: ["Completed"], matchProvider: true, matchSpecialty: true };
const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
const nameKey = (s: string) => norm(s).split(" ").sort().join(" ");

function clinic(patients: PatientRecord[]): ClinicIndex {
  const providers = new Map<string, Provider>(PROVIDERS.map(([n, , s, active]) => [n, { name: n, specialty: s as string, active }]));
  return {
    providers, hasSpecialties: true, appointments: patients.flatMap((p) => p.appointments), byDate: () => [],
    nameIsPatient: (n) => patients.some((p) => nameKey(p.name) === nameKey(n)),
    findPatient: (n, dob) => { const c = patients.filter((p) => nameKey(p.name) === nameKey(n) && (!dob || p.dobISO === dob)); return c.length === 1 ? c[0] : null; },
  };
}
const A = (dateISO: string, provider: string, status = "Completed", service = "Office visit", location = "Northgate"): Appointment => ({ dateISO, provider, status, service, location });
const patient = (name: string, dobISO: string, appointments: Appointment[], extra: Partial<PatientRecord> = {}): PatientRecord =>
  ({ id: name, name, dobISO, demographics: {}, documents: [], appointments, ...extra });

async function storeWith(...msgs: Array<{ changes?: any; base?: true }>): Promise<MessageStore> {
  // Stub compiler: the first message is the base workflow; later ones are amendments with the given changes.
  let current = neDefaults();
  const s = new MessageStore(async (raw, order): Promise<CompiledMessage> => {
    const m = msgs[order]!;
    current = m.base ? neDefaults() : applyNEChanges(current, m.changes);
    return { id: `m${order}`, order, raw, kind: m.base ? "workflow" : "amendment", scope: ["billing.new-or-established"], rule: neRule(current, order + 1), active: true };
  });
  for (let i = 0; i < msgs.length; i++) await s.ingest(`message ${i}`);
  return s;
}
function solve(text: string, idx: ClinicIndex, store: MessageStore): string | null {
  const plan = toPlan(text); if (!plan) return null;
  const raw = exec(plan, idx, store, params(text), text);
  if (raw == null || typeof raw === "object") return null;
  return format[plan.output.answerType as keyof typeof format](raw);
}
const ask = (p: PatientRecord, prov: string, visit: string, style = 0) => {
  const [first, ...rest] = p.name.split(" "); const last = rest.join(" "), t = titleOf.get(prov);
  return [
    `Is ${p.name} (born ${p.dobISO}) new or established for ${prov}, ${t} on ${visit}?`,
    `On ${visit} there is a visit with ${prov}, ${t} for ${last}, ${first}, DOB ${p.dobISO}, and I need new vs. established for it.`,
    `Billing question: ${p.name} (born ${p.dobISO}), visit with ${prov}, ${t} on ${visit}. Is that a new or an established patient visit?`,
  ][style % 3];
};

// ── reporting ──
type Row = { section: string; name: string; ok: boolean; detail?: string; gap?: boolean };
const rows: Row[] = [];
const check = (section: string, name: string, got: unknown, want: unknown, gap = false) =>
  rows.push({ section, name, ok: JSON.stringify(got) === JSON.stringify(want), gap, detail: `got=${JSON.stringify(got)} want=${JSON.stringify(want)}` });

async function conformance() {
  const S = "conformance";
  const base = await storeWith({ base: true });
  const one = (appts: Appointment[], prov: string, visit: string, want: string | null, label: string, style = 0, gap = false) => {
    const p = patient("Judith Jackson", "2004-11-12", appts), idx = clinic([p]);
    const o = oracle(appts, specOf, prov, visit, DEFAULTS);
    check(S, `${label} [oracle]`, o, want);                       // the oracle itself agrees with the hand-worked answer
    check(S, `${label} [agent, phrasing ${style % 3}]`, solve(ask(p, prov, visit, style), idx, base), want, gap);
  };
  const WG = "Walter Guzman", V = "2026-11-05";
  one([A("2023-11-05", WG)], WG, V, "NEW", "window: same date 3y earlier is too old");
  one([A("2023-11-06", WG)], WG, V, "ESTABLISHED:2023-11-06", "window: day after is inside", 1);
  one([A("2026-11-04", WG)], WG, V, "ESTABLISHED:2026-11-04", "window: day before visit counts", 2);
  one([A(V, WG)], WG, V, "NEW", "window: visit date does not count");
  one([A("2026-12-01", WG)], WG, V, "NEW", "window: after visit does not count", 1);
  one([A("2025-02-28", WG)], WG, "2028-02-29", "NEW", "Feb 29 visit: Feb 28 three years earlier is too old");
  one([A("2025-03-01", WG)], WG, "2028-02-29", "ESTABLISHED:2025-03-01", "Feb 29 visit: Mar 1 is inside", 2);
  one([A("2025-02-28", WG)], WG, "2025-03-01", "ESTABLISHED:2025-02-28", "non-leap: Feb 28 inside window for Mar 1 visit", 1);
  for (const s of ["Scheduled", "Cancelled", "Late cancel", "No-show"]) one([A("2025-05-05", WG, s)], WG, V, "NEW", `status ${s} does not count`);
  for (const [i, svc] of DEFAULT_EXCLUDED.entries()) one([A("2025-05-05", WG, "Completed", svc)], WG, V, "NEW", `excluded service ${svc}`, i);
  one([A("2025-05-05", "Lawrence Bennett")], WG, V, "ESTABLISHED:2025-05-05", "same specialty, former provider counts");
  one([A("2025-05-05", "Kenneth Sullivan")], WG, V, "NEW", "different specialty does not count", 1);
  one([A("2025-03-11", WG), A("2026-01-01", WG, "No-show"), A("2026-02-01", WG, "Completed", "Lab draw")], WG, V, "ESTABLISHED:2025-03-11", "most recent COUNTING date, later non-counting ignored", 2);
  one([A("2025-03-11", WG, "Completed", "Office visit", "Northgate"), A("2026-04-02", "Lawrence Bennett", "Completed", "Follow-up", "Westfield")], WG, V, "ESTABLISHED:2026-04-02", "every location counts");
  one([A("2025-05-05", "Sam Ortiz")], WG, V, null, "unknown specialty: skip, never NEW", 1);
  one([A("2024-01-01", WG), A("2025-05-05", "Sam Ortiz")], WG, V, null, "unknown-specialty visit LATER than the verified one: skip", 2);
  one([A("2025-05-05", WG), A("2024-01-01", "Sam Ortiz")], WG, V, "ESTABLISHED:2025-05-05", "unknown-specialty visit EARLIER than the verified one: answer");
  // The workflow message's own worked example (10 appointments, 8 Behavioral Health).
  const linda = patient("Linda Stewart", "2009-04-25", [
    A("2026-06-18", "Lawrence Bennett", "Completed", "Prenatal visit"), A("2026-07-02", WG, "No-show"), A("2026-08-01", WG, "Completed", "Lab draw"),
    A("2025-01-10", WG), A("2024-02-02", WG, "Cancelled"), A("2023-11-05", WG), A("2026-11-05", WG, "Scheduled"), A("2026-12-01", WG, "Scheduled"),
    A("2025-06-06", "Kenneth Sullivan"), A("2026-09-09", "Douglas Hughes"),
  ]);
  check(S, "policy worked example [agent]", solve(`On 2026-11-05 there is a visit with Walter Guzman, PA for Stewart, Linda, DOB 2009-04-25, and I need new vs. established for it.`, clinic([linda]), base), "ESTABLISHED:2026-06-18");
  // Identity: two patients with the same name, different DOB → the DOB picks one; same name + same DOB → skip.
  const j1 = patient("Ana Corbett", "2000-11-13", [A("2025-05-05", WG)]), j2 = patient("Ana Corbett", "1990-01-01", []);
  check(S, "identity: same name, DOB disambiguates", solve(ask(j1, WG, V), clinic([j1, j2]), base), "ESTABLISHED:2025-05-05");
  check(S, "identity: duplicate name+DOB → skip", solve(ask(j1, WG, V), clinic([j1, { ...j1, id: "dup", appointments: [] }]), base), null);
  check(S, "identity: unknown patient → skip", solve(ask(patient("Nobody Here", "1999-09-09", []), WG, V), clinic([j1]), base), null);
  // R1: a failed/partial appointments read must never look like "no appointments".
  const failed = patient("Peter Henry", "1975-06-23", [], { appointmentsComplete: false });
  check(S, "R1: failed appointments read → skip, not NEW", solve(ask(failed, "Douglas Hughes", "2026-12-25"), clinic([failed]), base), null);
  const partial = patient("Peter Henry", "1975-06-23", [A("2025-01-01", "Douglas Hughes")], { appointmentsComplete: false });
  check(S, "R1: partial read → skip, not an older ESTABLISHED date", solve(ask(partial, "Douglas Hughes", "2026-12-25"), clinic([partial]), base), null);
  const none = patient("Peter Henry", "1975-06-23", [], { appointmentsComplete: true });
  check(S, "R1: confirmed-empty history → NEW", solve(ask(none, "Douglas Hughes", "2026-12-25"), clinic([none]), base), "NEW");
  check(S, "R1: partial read → appointment count skipped", solve("How many completed appointments does Peter Henry have?", clinic([partial]), base), null);
}

function recurrence() {
  const S = "recurrence";
  check(S, "weekly on Tuesday", Crawler.recurDates("week on Tuesday", "2026-01-01", "2026-01-31"), ["2026-01-06", "2026-01-13", "2026-01-20", "2026-01-27"]);
  check(S, "every 2 weeks on Monday, inclusive bounds", Crawler.recurDates("2 weeks on Monday", "2026-01-05", "2026-02-02"), ["2026-01-05", "2026-01-19", "2026-02-02"]);
  check(S, "weekdays across a weekend", Crawler.recurDates("weekday", "2026-01-09", "2026-01-13"), ["2026-01-09", "2026-01-12", "2026-01-13"]);
  check(S, "daily across a month end", Crawler.recurDates("every day", "2026-01-30", "2026-02-02"), ["2026-01-30", "2026-01-31", "2026-02-01", "2026-02-02"]);
  check(S, "monthly on the 15th", Crawler.recurDates("month on the 15th", "2026-01-01", "2026-03-31"), ["2026-01-15", "2026-02-15", "2026-03-15"]);
  // Known gap: a day-of-month the month lacks overflows into the next month (Feb 31 → Mar 3). Whether
  // Wrenfield skips or clamps to the month's last day is unverified; either way Mar 3 is never right.
  check(S, "monthly on the 31st: no overflow into the next month", Crawler.recurDates("month on the 31st", "2026-01-01", "2026-04-30").filter((d) => !d.endsWith("-31")), []);
  check(S, "monthly on the 29th, non-leap Feb: no overflow", Crawler.recurDates("month on the 29th", "2027-01-01", "2027-03-31").filter((d) => !d.endsWith("-29")), []);
  // Skip-vs-clamp for short months is unverified, so such a series marks the history incomplete.
  check(S, "monthly on the 31st across short months is ambiguous", Crawler.recurAmbiguous("month on the 31st", "2026-01-01", "2026-04-30"), true);
  check(S, "monthly on the 15th is not ambiguous", Crawler.recurAmbiguous("month on the 15th", "2026-01-01", "2026-04-30"), false);
  check(S, "monthly on the 30th within Jan only is not ambiguous", Crawler.recurAmbiguous("month on the 30th", "2026-01-01", "2026-01-31"), false);
  check(S, "weekly across a leap day", Crawler.recurDates("week on Thursday", "2028-02-24", "2028-03-09"), ["2028-02-24", "2028-03-02", "2028-03-09"]);
}

async function amendments() {
  const S = "amendments";
  const WG = "Walter Guzman", V = "2026-11-05";
  const run = async (appts: Appointment[], msgs: Array<{ changes?: any; base?: true }>, p: Params, want: string | null, label: string) => {
    const pt = patient("Laura Torres", "2001-02-20", appts), store = await storeWith(...msgs);
    check(S, `${label} [oracle]`, oracle(appts, specOf, WG, V, p), want);
    check(S, `${label} [agent]`, solve(ask(pt, WG, V), clinic([pt]), store), want);
  };
  await run([A("2024-06-01", WG)], [{ base: true }, { changes: { windowYears: 2 } }], { ...DEFAULTS, windowYears: 2 }, "NEW", "window shortened to 2 years");
  await run([A("2025-05-05", "Lawrence Bennett")], [{ base: true }, { changes: { matchSpecialty: false } }], { ...DEFAULTS, matchSpecialty: false }, "NEW", "same provider only");
  await run([A("2025-05-05", WG, "Completed", "Telehealth visit")], [{ base: true }, { changes: { addExcluded: ["Telehealth visit"] } }], { ...DEFAULTS, excluded: [...DEFAULT_EXCLUDED, "Telehealth visit"] }, "NEW", "added excluded service");
  await run([A("2025-05-05", WG, "Completed", "Lab draw")], [{ base: true }, { changes: { removeExcluded: ["Lab draw"] } }], { ...DEFAULTS, excluded: DEFAULT_EXCLUDED.filter((s) => s !== "Lab draw") }, "ESTABLISHED:2025-05-05", "removed excluded service");
  await run([A("2025-05-05", WG, "Late cancel")], [{ base: true }, { changes: { setStatuses: ["Completed", "Late cancel"] } }], { ...DEFAULTS, statuses: ["Completed", "Late cancel"] }, "ESTABLISHED:2025-05-05", "late cancel now counts");
  await run([A("2023-01-01", WG)], [{ base: true }, { changes: { windowYears: 2 } }, { changes: { windowYears: 4 } }], { ...DEFAULTS, windowYears: 4 }, "ESTABLISHED:2023-01-01", "later amendment holds");
  await run([A("2024-06-01", WG)], [{ base: true }, { changes: { windowYears: 2 } }, { base: true }], DEFAULTS, "ESTABLISHED:2024-06-01", "restated base workflow resets the rule");
  // Real compiler, no model available: the base message installs the rule; noise must not replace it.
  delete process.env.LLM_BASE_URL; delete process.env.LLM_API_KEY;
  const real = new MessageStore(compiler);
  await real.ingest(JSON.parse(readFileSync(new URL("../../fixtures/practice-queue.json", import.meta.url), "utf8")).items[0].text); // the full message: parameters are read from it
  // A truncated message (no exclusion list / statuses) is not read with defaults: its tasks decline.
  { const t = new MessageStore(compiler); await t.ingest("From billing: telling new patients from established ones\n\nA patient is established if they had an appointment that counts with the same provider, or with another provider in the same specialty, in the 3 years before the visit date.");
    const pt0 = patient("Laura Torres", "2001-02-20", [A("2025-08-14", WG)]);
    check(S, "real compiler: a truncated message declines", solve(ask(pt0, WG, V), clinic([pt0]), t), null); }
  await real.ingest("The vending machine by the back entrance takes cards again, but the coin slot is still jammed.");
  await real.ingest("We established a new coffee station by the front desk.");
  const pt = patient("Laura Torres", "2001-02-20", [A("2025-08-14", WG)]);
  check(S, "real compiler: base rule survives noise messages", solve(ask(pt, WG, V), clinic([pt]), real), "ESTABLISHED:2025-08-14");
}

function parsing() {
  const S = "parsing";
  const want = (q: string, patient: string, dob: string | undefined, provider: string | undefined, date: string | undefined) => {
    const s = extractSlots(q);
    check(S, q.slice(0, 70), { patient: s.patient, dob: s.dob, provider: s.provider?.name, date: s.dates[0] }, { patient, dob, provider, date });
  };
  want("Is Judith Jackson (born 2004-11-12) new or established for Kenneth Sullivan, NP on 2028-07-20?", "Judith Jackson", "2004-11-12", "Kenneth Sullivan", "2028-07-20");
  want("On 2026-12-25 there is a visit with Douglas Hughes, MD for Henry, Peter, DOB 1975-06-23, and I need new vs. established for it.", "Peter Henry", "1975-06-23", "Douglas Hughes", "2026-12-25");
  want("Is Laura Torres (born 2001-02-20) new or established for Elena Gutierrez, NP on 2025-12-30?", "Laura Torres", "2001-02-20", "Elena Gutierrez", "2025-12-30");
  want("Is José Núñez (born 03/04/1980) new or established for Priya Raman, DO on November 5, 2026?", "José Núñez", "1980-03-04", "Priya Raman", "2026-11-05");
  want("Is Mary-Kate O'Neil (born 1990-01-31) new or established for Sam Ortiz, PA-C on 2026-01-02?", "Mary-Kate O'Neil", "1990-01-31", "Sam Ortiz", "2026-01-02");
  want("What phone number do we have on file for patient Carol Jones (born 1982-09-07)?", "Carol Jones", "1982-09-07", undefined, undefined);
  want("Referral letter received on 2024-12-01 for patient Ana Corbett (born 2000-11-13): which practice made the referral?", "Ana Corbett", "2000-11-13", undefined, "2024-12-01");
}

/** Gating on real queues: every Set 1 task gets a family; only families with a tested solver are worked,
 *  and their keyword plan must agree with the family. Practice tasks must all still be answerable. */
function gating() {
  const S = "gating";
  const here = new URL("../../fixtures/", import.meta.url).pathname;
  const set1 = readFileSync(here + "set1-items.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((x) => x.kind === "task");
  const unknown = set1.filter((t) => !taskFamily(t.text));
  check(S, "Set 1: every task classified", unknown.length, 0);
  const worked = set1.filter((t) => ANSWERABLE[taskFamily(t.text)!]);
  const mism = worked.filter((t) => !ANSWERABLE[taskFamily(t.text)!]!.includes(toPlan(t.text)?.type ?? ""));
  check(S, `Set 1: worked tasks (${worked.length}) route to their family's solver`, mism.map((t) => t.text.slice(0, 60)), []);
  const lab = set1.filter((t) => taskFamily(t.text) === "lab-report-triage");
  check(S, `Set 1: all ${lab.length} lab-triage tasks are gated (no DOB answers)`, lab.filter((t) => ANSWERABLE["lab-report-triage"]).length, 0);
  const practice = JSON.parse(readFileSync(here + "practice-queue.json", "utf8")).items.filter((x: any) => x.kind === "task");
  for (const t of practice) {
    const f = taskFamily(t.text);
    check(S, `practice answerable: ${t.text.slice(0, 50)}`, !!(f && ANSWERABLE[f]?.includes(toPlan(t.text)?.type ?? "")), true);
  }
}

/** Randomized boundary fuzz: appointments clustered around window edges, multiple locations, former
 *  providers, unknown specialties, random amendments; oracle vs the agent. */
async function fuzz(seed: number, n: number) {
  let x = seed >>> 0; const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)]!;
  const STATUS = ["Completed", "Completed", "Completed", "Scheduled", "Cancelled", "Late cancel", "No-show"];
  const SVC = ["Office visit", "Follow-up", "Prenatal visit", "Telehealth visit", ...DEFAULT_EXCLUDED];
  const LOC = ["Northgate", "Westfield", "Harbor Point", "Cedar Ridge"];
  const tally = { CORRECT: 0, WRONG: 0, SKIP_SAFE: 0, SKIP_MISSED: 0 }; const wrongs: string[] = [];
  for (let i = 0; i < n; i++) {
    const vy = 2024 + Math.floor(rnd() * 5), vm = 1 + Math.floor(rnd() * 12), vd = rnd() < 0.08 && vm === 2 && leap(vy) ? 29 : 1 + Math.floor(rnd() * dim(vy, vm));
    const visit = fmt(vy, vm, vd), [lo] = window(visit, 3);
    const near = () => { let s = pick([lo, visit, addDay(lo, -1), addDay(visit, -1)]); for (let k = Math.floor(rnd() * 40); k > 0; k--) s = addDay(s, rnd() < 0.5 ? 1 : -1); return s; };
    const far = () => fmt(vy - Math.floor(rnd() * 4), 1 + Math.floor(rnd() * 12), 1 + Math.floor(rnd() * 28));
    const appts = Array.from({ length: Math.floor(rnd() * 12) }, () => A(rnd() < 0.6 ? near() : far(), pick(PROVIDERS)[0], pick(STATUS), pick(SVC), pick(LOC)));
    const prov = pick(PROVIDERS.filter(([, , s]) => s))[0];
    const msgs: Array<{ changes?: any; base?: true }> = [{ base: true }];
    let p: Params = { ...DEFAULTS };
    if (rnd() < 0.3) {
      const ch = pick<any>([{ windowYears: 2 }, { windowYears: 5 }, { matchSpecialty: false }, { addExcluded: ["Telehealth visit"] }, { removeExcluded: ["Lab draw"] }, { setStatuses: ["Completed", "Late cancel"] }]);
      msgs.push({ changes: ch });
      p = { ...p, ...(ch.windowYears ? { windowYears: ch.windowYears } : {}), ...(ch.matchSpecialty === false ? { matchSpecialty: false } : {}),
        ...(ch.addExcluded ? { excluded: [...p.excluded, ...ch.addExcluded] } : {}), ...(ch.removeExcluded ? { excluded: p.excluded.filter((s) => !ch.removeExcluded.includes(s)) } : {}),
        ...(ch.setStatuses ? { statuses: ch.setStatuses } : {}) };
    }
    const pt = patient("Laura Torres", "2001-02-20", appts);
    const want = oracle(appts, specOf, prov, visit, p);
    const got = solve(ask(pt, prov, visit, i), clinic([pt]), await storeWith(...msgs));
    if (got === null) tally[want === null ? "SKIP_SAFE" : "SKIP_MISSED"]++;
    else if (got === want) tally.CORRECT++;
    else { tally.WRONG++; if (wrongs.length < 8) wrongs.push(`    visit ${visit} with ${prov}, params ${JSON.stringify(msgs.slice(1))}: got ${got}, want ${want}`); }
  }
  return { tally, wrongs };
}

async function main() {
  const seed = Number(process.argv[2] ?? 2026), n = Number(process.argv[3] ?? 5000);
  await conformance(); recurrence(); await amendments(); parsing(); gating();
  const fz = await fuzz(seed, n);
  const sections = [...new Set(rows.map((r) => r.section))];
  let unexpected = 0;
  for (const s of sections) {
    const rs = rows.filter((r) => r.section === s && !r.gap), bad = rs.filter((r) => !r.ok);
    console.log(`${bad.length ? "✗" : "✓"} ${s}: ${rs.length - bad.length}/${rs.length}`);
    for (const r of bad) console.log(`    FAIL ${r.name}: ${r.detail}`);
    unexpected += bad.length;
  }
  console.log(`✓ fuzz (seed ${seed}, ${n} questions): correct ${fz.tally.CORRECT}, WRONG ${fz.tally.WRONG}, skip-safe ${fz.tally.SKIP_SAFE}, skip-missed ${fz.tally.SKIP_MISSED}`.replace(/^✓/, fz.tally.WRONG ? "✗" : "✓"));
  fz.wrongs.forEach((w) => console.log(w));
  const gaps = rows.filter((r) => r.gap);
  if (gaps.length) { console.log("known gaps (expected to fail until fixed):"); for (const g of gaps) console.log(`    ${g.ok ? "NOW PASSES" : "open"}  ${g.name}: ${g.detail}`); }
  process.exitCode = unexpected || fz.tally.WRONG ? 1 : 0;
}
main().catch((e) => { console.error(e); process.exit(1); });
