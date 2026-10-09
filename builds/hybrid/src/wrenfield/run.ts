/**
 * END-TO-END run of the inference layer over the practice-shift items.
 * Feeds the real Item 1 message + the four tasks through the scaffold:
 *   message → compile the new/established rule into the store
 *   task    → parse (slots+intent) → resolve against the index → execute → format
 * and checks the close-requests against the documented expected answers.
 *
 * The index here is a small sample mirroring the data in gettingStarted.md; swapping
 * it for the browserless crawl of real Wrenfield is the only change for a live shift.
 */
import { extractSlots, classifyIntent } from "./parse.js";
import { compileMessage } from "./llm.js";
import { invoiceBalance } from "./solvers.js";
import { why } from "./why.js";
import { chartQuestion, chartAnswer } from "./chartAnswers.js";
import { lookupSpec } from "./lookup.js";
import { guard } from "./guards.js";
import { parseNEMessage, type NEParams } from "./neParse.js";
import { labCoveredPanels } from "./labTriage.js";
import { dateTimeOn, hhmm, namedZone, zoneOk } from "./formFlags.js";
import { messageFamily, parsePolicy, logPolicyParse } from "./policyParse.js";
import { classifyMemo } from "./memoGate.js";
import {
  Classifier, MessageStore, handleItem,
  type ClinicIndex, type PatientRecord, type Appointment, type Provider, type QueryPlan,
  type CompiledMessage, type CompiledRule, type RuleContext,
} from "./inference.js";

// ── sample clinic data (mirrors the doc's examples) ──
const PROVIDERS = new Map<string, Provider>([
  ["Logan Brown", { name: "Logan Brown", specialty: "Internal Medicine", active: true }],
  ["Frances Ward", { name: "Frances Ward", specialty: "Internal Medicine", active: true }],
  ["Sharon Morales", { name: "Sharon Morales", specialty: "Family Medicine", active: true }],
]);
const appt = (dateISO: string, provider: string, status: string, service: string): Appointment => ({ dateISO, provider, status, service, location: "Northgate" });
const PATIENTS: PatientRecord[] = [
  { id: "p1", name: "Jack Williams", dobISO: "", demographics: {}, documents: [],
    appointments: [appt("2026-03-31", "Frances Ward", "Completed", "Follow-up visit")] },
  { id: "p2", name: "Guadalupe Driscoll", dobISO: "", demographics: {}, documents: [],
    appointments: [appt("2025-11-10", "Sharon Morales", "Completed", "Office visit"), appt("2026-01-20", "Sharon Morales", "Completed", "Office visit"), appt("2026-02-05", "Sharon Morales", "Completed", "Office visit"), appt("2026-09-23", "Sharon Morales", "Completed", "Office visit"), appt("2026-03-01", "Sharon Morales", "No-show", "Office visit")] },
  { id: "p3", name: "Randy Singh", dobISO: "1939-12-04", demographics: {}, appointments: [],
    documents: [{ title: "Referral letter", kind: "referral letter", receivedISO: "2025-11-10", source: "Plains Dermatology Associates" }] },
  { id: "p4", name: "Julie Martínez", dobISO: "2010-01-10", demographics: { phone: "(620) 323-6931" }, documents: [],
    appointments: [appt("2026-11-01", "Sharon Morales", "Scheduled", "Follow-up visit")] },
];

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
export const index: ClinicIndex = {
  providers: PROVIDERS,
  nameIsPatient: (name) => PATIENTS.some((p) => norm(p.name) === norm(name)),
  appointments: PATIENTS.flatMap((p) => p.appointments),
  findPatient(name, dobISO) {
    const cands = PATIENTS.filter((p) => norm(p.name) === norm(name));
    if (dobISO) return cands.find((p) => p.dobISO === dobISO) ?? null;
    return cands.length === 1 ? cands[0] : null; // ambiguous (0 or >1) without DOB → decline
  },
  byDate: () => [],
};

// ── the new/established rule, PARAMETERIZED so messages can amend it (state machine) ──
const d2u = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return Date.UTC(y, m - 1, d); };
const DEFAULT_EXCLUDED = ["lab draw", "immunization", "x-ray", "ultrasound", "electrocardiogram", "echocardiogram", "allergy injection", "blood pressure check", "hearing test", "vision screening", "infusion therapy", "anticoagulation check"];
export const neDefaults = (): NEParams => ({ windowYears: 3, excluded: DEFAULT_EXCLUDED.slice(), statuses: ["completed"], matchProvider: true, matchSpecialty: true });

/** Build the rule evaluator for a given parameter set. Facts (e.g. a message stating a provider's
 *  specialty, or that a provider left keeping their specialty) override the crawled specialty. */
function makeNewOrEstablished(p: NEParams): (ctx: RuleContext) => string {
  const excluded = new Set(p.excluded.map(norm)); const statuses = new Set(p.statuses.map(norm));
  return (ctx: RuleContext): string => {
    const patient = ctx.patient; const providerName = ctx.params.provider; const visitISO = ctx.params.date;
    if (!patient || !providerName || !visitISO) return "UNCERTAIN";
    if (patient.appointmentsComplete === false) return "UNCERTAIN"; // can't prove absence or recency from a partial history
    const specOf = (name: string) => { const f = ctx.facts.find((x) => norm(x.subject) === norm(name) && /special/i.test(x.predicate)); return f ? String(f.value) : ctx.index.providers.get(name)?.specialty; };
    const visitSpec = specOf(providerName);
    const [vy, vm, vd] = visitISO.split("-").map(Number);
    const feb29 = vm === 2 && vd === 29;
    const startU = Date.UTC(vy - p.windowYears, vm - 1, feb29 ? 28 : vd) + 86400000; // day after same-date-N-years-earlier
    const endU = d2u(visitISO) - 86400000;                                           // day before the visit
    let uncertainLatest = ""; // latest in-window candidate whose specialty can't be verified
    const counting = patient.appointments.filter((a) => {
      if (!statuses.has(norm(a.status))) return false;
      if (excluded.has(norm(a.service))) return false;
      const u = d2u(a.dateISO); if (u < startU || u > endU) return false;
      if (p.matchProvider && a.provider === providerName) return true; // same provider → counts
      if (!p.matchSpecialty) return false;
      const spec = specOf(a.provider);
      if (!visitSpec || !spec) { if (a.dateISO > uncertainLatest) uncertainLatest = a.dateISO; return false; } // can't verify same-specialty
      return spec === visitSpec;
    });
    const best = counting.length ? counting.reduce((a, b) => (d2u(a.dateISO) >= d2u(b.dateISO) ? a : b)).dateISO : "";
    // An unverifiable candidate LATER than the best verified one could be the most recent → decline.
    if (uncertainLatest && uncertainLatest > best) return "UNCERTAIN";
    if (best) return `ESTABLISHED:${best}`;
    return "NEW";
  };
}
export const neRule = (p: NEParams, version: number): CompiledRule => ({ ruleType: "billing.new-or-established", version, evaluate: makeNewOrEstablished(p), params: p as any });

/** Merge an amendment's changes onto the current new/established parameters. */
export function applyNEChanges(base: NEParams, ch: any): NEParams {
  const p: NEParams = { windowYears: base.windowYears, excluded: base.excluded.slice(), statuses: base.statuses.slice(), matchProvider: base.matchProvider, matchSpecialty: base.matchSpecialty };
  if (typeof ch.windowYears === "number") p.windowYears = ch.windowYears;
  if (Array.isArray(ch.addExcluded)) for (const s of ch.addExcluded) if (!p.excluded.some((e) => norm(e) === norm(s))) p.excluded.push(s);
  if (Array.isArray(ch.removeExcluded)) p.excluded = p.excluded.filter((e) => !ch.removeExcluded.some((r: string) => norm(r) === norm(e)));
  if (Array.isArray(ch.setStatuses) && ch.setStatuses.length) p.statuses = ch.setStatuses;
  if (typeof ch.matchProvider === "boolean") p.matchProvider = ch.matchProvider;
  if (typeof ch.matchSpecialty === "boolean") p.matchSpecialty = ch.matchSpecialty;
  return p;
}
const currentNEParams = (known: CompiledMessage[]): NEParams => {
  for (let i = known.length - 1; i >= 0; i--) { const m = known[i]; if (m.active && m.rule?.params && m.scope.includes("billing.new-or-established")) return m.rule.params as unknown as NEParams; }
  return neDefaults();
};

// ── lab-report triage: only what the task text decides (covered panels, "not covered from <date>") ──
type LabParams = { covered: string[]; notCovered: Array<{ panel: string; fromISO: string }> };
const labRule = (p: LabParams, version: number): CompiledRule => ({ ruleType: "lab.triage", version, params: p as any, evaluate: (ctx) => {
  const panel = norm(ctx.params.panel || ""), received = ctx.params.received || "";
  if (!panel) return null;
  // A panel slot that CONTAINS a covered panel's name but is not it ("Wells, Matthew, Basic metabolic
  // panel" captured from "Last, First" order) is a mis-split slot, not an uncovered panel → decline.
  if (/,/.test(ctx.params.panel || "") || p.covered.some((c) => norm(c) !== panel && panel.includes(norm(c)))) return null;
  if (!p.covered.some((c) => norm(c) === panel)) return "NOT_COVERED";
  if (p.notCovered.some((n) => norm(n.panel) === panel && received && received >= n.fromISO)) return "NOT_COVERED";
  return null; // a covered report needs the report itself read and the tables applied — not built → skip
} });
const currentLabParams = (known: CompiledMessage[]): LabParams | null => {
  for (let i = known.length - 1; i >= 0; i--) { const m = known[i]; if (m.active && m.rule?.params && m.scope.includes("lab.triage")) return m.rule.params as unknown as LabParams; }
  return null;
};

// ── message compiler: build the agent's state from each message ──
//   • the base new/established workflow → regex fast-path (no model, works offline)
//   • everything else → model-compile into an amendment / fact / governing-workflow / noise
export const compiler = async (raw: string, order: number, known: CompiledMessage[] = []): Promise<CompiledMessage> => {
  try { const fam = messageFamily(raw); if (fam) logPolicyParse(parsePolicy(fam, raw), raw); } catch {} // which rule fields this message gave (diagnostics only)
  const isNewEst = /\bnew\b[\s\S]{0,40}\bestablished\b|\bestablished\b[\s\S]{0,40}\bnew\b/i.test(raw);
  const looksAmendment = /\b(instead|change|changed|update|amend|from now|no longer|new rule|correction|revise|override|should now|going forward)\b/i.test(raw);
  // Base workflow definition (not an amendment) → default params, no model needed.
  if (isNewEst && /appointment|visit|provider|special|window|3\s*year|count/i.test(raw) && !looksAmendment) {
    // Parameters come from the message itself (window, statuses, excluded services, matching);
    // a message we cannot read completely is recorded as an uncompiled workflow → its tasks decline.
    const ne = parseNEMessage(raw);
    // (memo: the memo gate governs its tasks when it did not parse; the family keeps them only when it did — store.familyBlocked)
    if (!ne.params) { console.log(JSON.stringify({ event: "ne_message_unparsed", why: ne.why })); return { id: `m${order}`, order, raw, kind: "workflow", scope: ["govern:established"], active: true, memo: true, why: "new/established (unparsed)" }; }
    return { id: `m${order}`, order, raw, kind: "workflow", scope: ["billing.new-or-established"], rule: neRule(ne.params, order + 1), active: true, memo: true, why: "new/established" };
  }
  // Lab-report triage workflow: the covered-panel list and a "not covered from <date>" amendment are
  // decidable from the message text alone, so compile them without the model (Set 1: 6 of 45 tasks).
  if (/\blab reports?\b/i.test(raw) && /NOT_COVERED/.test(raw)) {
    const covered = labCoveredPanels(raw);   // the one covered-list reader (labTriage.ts): any heading wording / form
    if (covered?.length) return { id: `m${order}`, order, raw, kind: "workflow", scope: ["lab.triage"], rule: labRule({ covered, notCovered: [] }, order + 1), active: true, memo: true, why: "lab triage" };
    const amend = raw.match(/\b(?:An?|The)\s+([A-Z][A-Za-z ]+?)\s+(?:lab )?report is not covered by this rule/);
    const from = raw.match(/received on or after (\d{4}-\d{2}-\d{2})/i);
    const base = currentLabParams(known);
    const labMemo = [...known].reverse().find((m) => m.memo && m.scope.includes("lab.triage"));
    if (amend && from && base) return { id: `m${order}`, order, raw, kind: "amendment", scope: ["lab.triage"], rule: labRule({ covered: base.covered, notCovered: [...base.notCovered, { panel: amend[1].trim(), fromISO: from[1] }] }, order + 1), active: true, amends: labMemo?.id, effective: from[1], why: "lab triage amendment" };
  }
  // Structure first (memoGate.ts, no model): a workflow memo ("How to answer", answer tokens, a worked example), or an amendment /
  // revocation of an earlier memo. An amendment of a memo we compiled into a rule (new/established) goes to the model's change
  // compile below, as before.
  const memos = known.filter((m) => m.memo);
  const mc = classifyMemo(raw, memos);
  if (mc?.kind === "workflow") return { id: `m${order}`, order, raw, kind: "workflow", scope: [`memo:${order}`], active: true, memo: true, why: mc.why };
  if (mc && mc.target !== undefined) {
    const t = memos[mc.target];
    if (mc.kind === "revocation") return { id: `m${order}`, order, raw, kind: "revocation", scope: t.scope, active: true, revokes: t.id, why: mc.why };
    if (!t.rule) return { id: `m${order}`, order, raw, kind: "amendment", scope: t.scope, active: true, amends: t.id, effective: mc.effective, why: mc.why };
  }
  // Anything else: ask the model to compile it into a state change (off the task hot path).
  let c: Awaited<ReturnType<typeof compileMessage>> = null;
  try { c = await compileMessage(raw); } catch {}
  // A model "amendment" changes the new/established parameters only when a new/established rule is in force or the message is about
  // new/established visits; any other amendment the structure did not tie to a memo is kept, inert (it once rebuilt the
  // new/established rule from the built-in defaults).
  if (c?.kind === "amendment" && c.changes && !isNewEst && !known.some((m) => m.active && m.rule && m.scope.includes("billing.new-or-established")))
    return { id: `m${order}`, order, raw, kind: "amendment", scope: [], active: true, why: "model amendment, no memo" };
  if (c?.kind === "amendment" && c.changes) {
    // An amendment to a base message we could not read (uncompiled) must not resurrect built-in defaults.
    if (known.some((m) => m.active && m.scope.includes("govern:established")) && !known.some((m) => m.active && m.rule && m.scope.includes("billing.new-or-established")))
      return { id: `m${order}`, order, raw, kind: "workflow", scope: ["govern:established"], active: true };
    const params = applyNEChanges(currentNEParams(known), c.changes);
    return { id: `m${order}`, order, raw, kind: "amendment", scope: ["billing.new-or-established"], rule: neRule(params, order + 1), active: true };
  }
  if (c?.kind === "fact" && c.fact?.subject && c.fact?.predicate) {
    return { id: `m${order}`, order, raw, kind: "fact", scope: [], fact: { subject: String(c.fact.subject), predicate: String(c.fact.predicate), value: c.fact.value }, active: true };
  }
  if (c?.kind === "workflow" && c.scope?.length) {
    // A rule family we can't execute. Record its scope so governed tasks can decline (never guess).
    return { id: `m${order}`, order, raw, kind: "workflow", scope: c.scope.map((s) => `govern:${norm(s)}`), active: true };
  }
  return { id: `m${order}`, order, raw, kind: "noise", scope: [], active: true };
};

// ── wire the classifier (keyword tier → QueryPlan) ──
export const toPlan = (text: string): QueryPlan | null => {
  const i = classifyIntent(text); if (!i) return null;
  return { type: i.type, entity: (i.entity ?? "patient") as any, op: i.op as any, output: { field: i.field, answerType: i.answerType as any }, ruleType: i.ruleType };
};
const classifier = new Classifier(toPlan, async () => { throw new Error("novel template — would call model"); }, new MessageStore(compiler));

// ── params extractor (slots → filter bindings) ──
export const params = (text: string): Record<string, string> => {
  const s = extractSlots(text); const r: Record<string, string> = {};
  if (s.patient) r.name = s.patient; if (s.dob) r.dob = s.dob;
  if (s.provider) r.provider = s.provider.name; if (s.dates[0]) r.date = s.dates[0];
  if (s.statuses[0]) r.status = s.statuses[0];
  if (s.invoice) r.invoice = s.invoice;
  if (s.relativeTime) r.reltime = "1";
  return r;
};

// ── document matching: pick WHICH document a content question refers to ──
const MON3: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
/** Choose the single document a question targets, by type (lab report / referral / statement) and
 *  date (full ISO, or a month+day mentioned in the question). Returns null if 0 or >1 match. */
function pickDoc(q: string, p: Record<string, string>, docs: Array<{ title: string; kind: string; receivedISO: string; docHref?: string }>): { docHref?: string } | null {
  const wantLab = /lab report|lab result|lab value|panel|cholesterol|triglyc|\bhdl\b|\bldl\b|glucose|a1c|hemoglob|hematocrit|\btsh\b|vitamin\s*d|creatinine|potassium|sodium|calcium|platelet|blood cell|\bwbc\b|\brbc\b|bilirubin|albumin|\bbun\b|egfr/i.test(q);
  const wantReferral = /referral/i.test(q);
  const wantStatement = /statement|account/i.test(q);
  // date: prefer a full ISO from slots; else a month+day in the question (year optional)
  let iso = p.date && /^\d{4}-\d{2}-\d{2}$/.test(p.date) ? p.date : undefined;
  let md: string | undefined;
  // A written date in the question: a full one only when the slots found none (the slots already
  // normalised written dates), and never the patient's date of birth ("born May 17, 1980" picked the
  // DOB as the document date and sent a referral question to the generalist).
  for (const m of q.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?/gi)) {
    const mm = MON3[m[1].slice(0, 3).toLowerCase()]; const dd = m[2].padStart(2, "0");
    if (m[3]) { const full = `${m[3]}-${mm}-${dd}`; if (full === p.dob || iso) continue; iso = full; break; }
    md = `-${mm}-${dd}`; break;
  }
  let cands = docs.filter((d) => {
    if (wantLab && !/lab report/i.test(d.kind)) return false;
    if (wantReferral && !/referral/i.test(d.kind)) return false;
    if (wantStatement && !/statement/i.test(d.kind)) return false;
    if (iso && d.receivedISO !== iso) return false;
    if (md && !d.receivedISO.endsWith(md)) return false;
    return true;
  });
  if (cands.length > 1) { // narrow a lab report by its panel name (e.g. "Lipid panel")
    const panel = q.match(/\b(lipid|vitamin\s*d|liver function|comprehensive metabolic|basic metabolic|metabolic|thyroid|lipid panel|cbc|complete blood count|urinalysis|hemoglobin a1c)\b/i);
    if (panel) cands = cands.filter((d) => new RegExp(panel[1].replace(/\s+/g, "\\s*"), "i").test(d.title));
  }
  return cands.length === 1 ? cands[0] : null;
}

// ── the solver dispatch (plan → value over the index) ──
export const exec = (plan: QueryPlan, idx: ClinicIndex, store: MessageStore, p: Record<string, string>, question?: string): unknown => {
  if (plan.type.startsWith("skip.")) return null; // derived-part / ambiguous / near miss of a field we don't compute → skip (never −1)
  if (plan.type.startsWith("model.")) { why("model-invented plans are never executed"); return null; } // Set 1: 37 wrong
  // Resolve referenced entities up front. A parsed "name" might be a patient OR a
  // provider (e.g. "appointments did Sharon Morales have") — disambiguate via the index.
  const patient = p.name ? idx.findPatient(p.name, p.dob) : null;
  const nameIsPatient = p.name ? (idx.nameIsPatient?.(p.name) ?? false) : false;
  const providerName = p.provider || (p.name && !nameIsPatient && idx.providers.get(p.name) ? p.name : ""); // untitled name is a provider only if NOT a patient
  const provider = providerName ? idx.providers.get(providerName) ?? null : null;
  // CORRECTNESS GUARD: if a question names an entity that doesn't resolve, decline (skip) —
  // never default to an answer. Converts a possible −1 into a 0.
  const patientCentric = plan.op === "rule" || plan.type.startsWith("patient.") || plan.type.startsWith("chart.");
  if (patientCentric && !patient) { why(p.name ? `patient not resolved: ${p.name}${p.dob ? " " + p.dob : ""} (see the crawl resolve line)` : "no patient named in the question"); return null; }
  if (plan.entity === "provider" && !provider) { why(`provider not resolved: ${providerName || "(none named)"}`); return null; }
  if (plan.op === "count" && p.name && !patient && !provider) { why(`named entity not resolved: ${p.name}`); return null; } // named entity didn't resolve

  const statusEq = (s: string) => !p.status || norm(s) === norm(p.status);
  const providerEq = (s: string) => !providerName || norm(s) === norm(providerName);
  const dateEq = (s: string) => !p.date || s === p.date;

  if (plan.type.startsWith("chart.")) {
    if (!patient) return null; // why already set above
    if (p.provider || /,\s*(?:MD|DO|NP|PA|PA-C)\b/.test(question ?? "")) { why("chart: question names a provider (provider-scope, not the patient's own chart)"); return null; }
    const cq = chartQuestion(question ?? ""); if (!cq || `chart.${cq.kind}` !== plan.type) { why("chart: re-parse disagrees"); return null; }
    return chartAnswer(cq, patient, why, (idx as any).today || (idx as any).crawler?.today || undefined);
  }
  if (plan.op === "document") {
    // Value lives inside a rendered document. Deterministically pick WHICH document (by type +
    // date); handleItem then screenshots it and reads the value with the vision model. Ambiguous
    // or no match → skip (never guess the wrong chart/report).
    if (!patient) { why("document question without a resolved patient"); return null; }
    const doc = pickDoc(question ?? "", p, patient.documents);
    if (!doc) { why(`no single matching document among ${patient.documents.length} (type/date filter): ` + patient.documents.map((d) => `${d.kind} ${d.receivedISO}`).slice(0, 6).join(", ")); return null; }
    if (!doc.docHref) { why(`matched ${(doc as any).kind ?? "document"} ${(doc as any).receivedISO ?? ""} but its row has no view link`); return null; }
    return { __doc: { docHref: doc.docHref, question: question ?? "" } };
  }

  if (plan.op === "rule") {
    if (idx.hasSpecialties === false) { why("no provider roster, so same-specialty can't be verified"); return null; } // decline (safe)
    const rule = store.ruleFor(plan.ruleType!); if (!rule) { why(`no compiled rule for ${plan.ruleType}`); return null; }
    if (!p.provider || !p.date) { why("rule needs the visit's provider and date"); return null; }
    const res = rule.evaluate({ index: idx, patient: patient ?? undefined, params: p, facts: [] });
    if (res === "UNCERTAIN") { why(patient?.appointmentsComplete === false ? "new/established: appointment history incomplete" : "new/established: an in-window visit has an unverifiable specialty"); return null; }
    return res;
  }

  if (patient && patient.appointmentsComplete === false && (plan.op === "count" || plan.type === "patient.next-appointment")) { why("appointment history incomplete"); return null; }
  if (plan.op === "count") {
    if (p.reltime && !p.date) { why("relative time window not resolved"); return null; }
    // A count over a provider's day / a location / slots is not a count over one patient's chart: a
    // reworded provider-day question whose provider (or a bystander) shares a patient's name was
    // answered with that patient's appointment count.
    if (/\b(locations?|providers?|patients|slots?|openings?|calendar|schedule)\b|,\s*(?:MD|DO|NP|PA|PA-C)\b/i.test(question ?? "")) { why("count over a provider / location / slots, not over one patient's chart"); return null; }
    // We only count deterministically over a RESOLVED patient's own data. A clinic-wide count
    // (e.g. "appointments today") has no local index → return null so the generalist reads the
    // dashboard/schedule instead of us confidently answering 0.
    if (!patient) { why("clinic-wide count has no reader"); return null; }
    // A one-patient chart count the lookup path parses goes there: it accounts for every word of the question (a
    // document type, "fees") where this count ignores them (practice: "count of Lab report documents" counted all
    // 3 documents, truth 2; "how many no-show fees" answered the no-show count).
    // A chart with recurring series stays with this count (series-aware: occurrences expanded, history proven complete): the lookup
    // path reads the appointments table alone and declines such a chart (guards.ts LOOKUP_RECURRING).
    if (process.env.AGENT_LOOKUP !== "off" && !((patient as any).hasSeries && guard("LOOKUP_RECURRING"))) { const ls = lookupSpec(question ?? ""); if (!("why" in ls) && ls.count) { why("chart count deferred to the lookup path"); return null; } }
    // a count of fees / charges / payments is not a count of appointments or documents ("how many no-show fees")
    if (/\b(?:fees?|charge[sd]?|charging|billed|bills?|paid|payments?|owe[ds]?|costs?)\b|\$/i.test(question ?? "")) { why("count of money items, not of chart rows"); return null; }
    switch (plan.entity) {
      case "appointment": return patient.appointments.filter((a) => statusEq(a.status) && providerEq(a.provider) && dateEq(a.dateISO)).length;
      case "document": return patient.documents.filter((d) => dateEq(d.receivedISO)).length;
      default: return null;
    }
  }

  if (plan.op === "extreme" && plan.type === "patient.next-appointment") {
    const upcoming = (patient?.appointments ?? []).filter((a) => /scheduled/i.test(a.status)).sort((a, b) => a.dateISO.localeCompare(b.dateISO));
    // AGENT_FORM_DATETIME: the clock time rides along ("2026-11-01T09:20"): a Date answer ignores it, a Date-and-time answer needs it
    if (upcoming[0] && dateTimeOn()) { const ts = upcoming.filter((a) => a.dateISO === upcoming[0].dateISO).map((a) => zoneOk(a.time, namedZone(question ?? "")) ? hhmm(a.time) : undefined); if (ts.every(Boolean)) return `${upcoming[0].dateISO}T${ts.sort()[0]}`; }
    return upcoming[0]?.dateISO ?? null;
  }

  switch (plan.type) {
    case "patient.phone": if (!patient?.demographics.phone) why("phone field empty or undecodable (obfuscation font not captured)"); return patient?.demographics.phone ?? null;
    case "patient.referral-source": { const d = patient?.documents.find((d) => /referral/i.test(d.kind) && (!p.date || d.receivedISO === p.date)); if (!d?.source) why(d ? "referral letter found but its title names no practice" : `no referral letter received ${p.date || "(any date)"} among ${patient?.documents.length ?? 0} documents`); return d?.source ?? null; }
    case "patient.email": return patient?.demographics.email ?? null;
    case "patient.address": return patient?.demographics.address ?? null;
    case "patient.dob": if (p.dob) { why("the question already states the DOB"); return null; } return patient?.dobISO ?? null;
    case "invoice.balance": return p.invoice ? invoiceBalance(idx, p.invoice, p.name, p.date) : null;
    case "provider.specialty": return provider?.specialty ?? null;
    default: why(`no solver for plan ${plan.type}`); return null;
  }
};

export async function main() {
  const store = new MessageStore(compiler);
  const cls = new Classifier(toPlan, async () => { throw new Error("novel"); }, store);
  const deps = { index, store, classifier: cls, params, verify: (_: QueryPlan, raw: unknown) => raw != null, exec };

  const items: Array<{ kind: "task" | "message"; text: string; expect: string }> = [
    { kind: "message", text: "New or established? A patient is established if they had a completed appointment with the same provider or same specialty in the 3 years before the visit…", expect: "acknowledge" },
    { kind: "task", text: "Billing question: Guadalupe Driscoll, visit with Sharon Morales, MD on 2025-11-05. Is that a new or an established patient visit?", expect: "NEW" },
    { kind: "task", text: "Referral letter received on 2025-11-10 for patient Randy Singh (born 1939-12-04): which practice made the referral?", expect: "Plains Dermatology Associates" },
    { kind: "task", text: "What phone number do we have on file for patient Julie Martínez (born 2010-01-10)?", expect: "(620) 323-6931" },
    { kind: "task", text: "Is Jack Williams a new patient or established for the visit with Logan Brown, MD on 2026-10-29?", expect: "ESTABLISHED:2026-03-31" },
  ];

  let pass = 0;
  for (const it of items) {
    const out = await handleItem(it, deps);
    const got = "acknowledge" in out ? "acknowledge" : "answer" in out ? out.answer : "skip";
    const ok = got === it.expect; if (ok) pass++;
    console.log(`${ok ? "✓" : "✗"} [${it.kind}] got="${got}"  expected="${it.expect}"`);
  }
  console.log(`\n${pass}/${items.length} end-to-end`);
}
if (process.argv[1]?.endsWith("run.ts")) main().catch((e) => { console.error(e); process.exit(1); });
