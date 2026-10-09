/**
 * Model side of the solver: message → Plan (the compiler), example → World (independent fact encoding for
 * verification), task → inputs, and the `classify` judgement hook. Every call is JSON-only and its output is
 * validated; the model never produces a final answer.
 */
import { chat } from "../failover.js";
import { OPS, VOCAB, vocabText, validatePlan, normalizePlan, type Plan } from "./plan.js";
import type { World, Classifier, Rec } from "./exec.js";
import type { WorkedExample } from "./example.js";
import { ruleText } from "./example.js";

export type Usage = { calls: number; cost: number; inTok: number; outTok: number };
export const usage: Usage = { calls: 0, cost: 0, inTok: 0, outTok: 0 };
export type Caller = (messages: Array<{ role: string; content: string }>, model: string, opts: { temperature?: number; maxTokens?: number }) => Promise<string | null>;

export const defaultCaller: Caller = async (messages, model, opts) => {
  const j: any = await chat({ messages, temperature: opts.temperature ?? 0, max_tokens: opts.maxTokens ?? 8000 }, { primary: model, fallbacks: [], attempts: 2, waitMs: 240000 });
  if (!j) return null;
  usage.calls++; usage.cost += Number(j.usage?.cost ?? 0) || 0; usage.inTok += j.usage?.prompt_tokens ?? 0; usage.outTok += j.usage?.completion_tokens ?? 0;
  return j.choices?.[0]?.message?.content ?? null;
};

export function jsonOf(t: string | null): any {
  if (!t) return null;
  const s = t.replace(/^```[a-z]*\s*/i, "").replace(/\s*```\s*$/i, "");
  const i = s.indexOf("{"), j = s.lastIndexOf("}"); if (i < 0 || j < i) return null;
  const body = s.slice(i, j + 1);
  try { return JSON.parse(body); } catch { /* fall through */ }
  // tolerate // comments and trailing commas (outside strings)
  let o = "", str = false;
  for (let k = 0; k < body.length; k++) {
    const ch = body[k];
    if (str) { o += ch; if (ch === "\\") { o += body[++k] ?? ""; } else if (ch === '"') str = false; continue; }
    if (ch === '"') { str = true; o += ch; continue; }
    if (ch === "/" && body[k + 1] === "/") { while (k < body.length && body[k] !== "\n") k++; o += "\n"; continue; }
    o += ch;
  }
  try { return JSON.parse(o.replace(/,(\s*[}\]])/g, "$1")); } catch { return null; }
}

const OP_DOC = Object.entries(OPS).map(([k, a]) => `${k}{${a.join(", ")}}`).join("  ");
export const PLAN_SYSTEM = `You compile a clinic back-office POLICY MESSAGE into a Plan: a JSON program that a deterministic executor runs on records read from the clinic site. You never compute an answer yourself; the Plan computes it.

PLAN JSON:
{"workflow": str,
 "inputs": [{"name": str, "type": "patient"|"date"|"time"|"int"|"dec"|"text"|"id", "note": str}],   // slots every request of this kind gives
 "constants": {name: value},          // numbers/dates the message states (e.g. "today": "2026-10-14", limits, windows). Copy exactly.
 "tables": {name: {"headers": [str], "rows": [[str]]}},   // every table/list the rule uses, copied exactly from the message
 "needs": [{"entity": E, "scope": "patient"|"clinic", "filters": str, "fields": [field]}],   // what must be read from the site
 "steps": [{"id": str, "expr": EXPR}],   // evaluated in order; steps.<id> holds the value
 "answer": EXPR}                          // the final answer string, exactly in the message's answer form

EXPR: a literal (string/number/bool/null), an array of EXPRs, {"var": "inputs.x" | "steps.x" | "constants.x" | "$" | "$.field.sub" | "$$.field"}, or {"op": NAME, ...args}.
"$" is the current item inside a lambda argument (where / to / by / of); "$$" is the outer item in a nested lambda.
An input of type "patient" becomes the resolved patient RECORD (fields below); "select" with "scope":"patient" returns only that patient's records (merged duplicates included).

OPS (args; "?" = optional): ${OP_DOC}
Semantics:
- select{entity, where?, scope?}: records of an entity; where is a boolean lambda over $.
- argmax/argmin{from, by, tie}: the record with the largest/smallest key; tie: "error" (decline, default) | "first" | "last".
- one{from}: exactly one element, otherwise the executor declines. first{from}: first element or null.
- sum/min/max{from, of}: of is a lambda (omit for a list of values). count{from} → number.
- lookup{table, match:{column: EXPR}, column}: the single matching row's cell (comparisons are case-insensitive; numbers numerically).
- rows{table}: the table as a list of objects keyed by header; use "$.<Header>" in lambdas.
- eq/ne/lt/le/gt/ge{a, b}: numbers compared numerically (exact decimals), everything else as case-insensitive text; ISO dates compare correctly as text.
- contains{text, any:[words]}: case-insensitive substring of any; matches{text, regex}: case-insensitive JS regex.
- pctChange{from, to} = |to - from| / |from| * 100 exactly. Numbers are exact decimals (no rounding).
- dates are "YYYY-MM-DD". addDays/addMonths(month-end clamp)/addYears{date, n (negative allowed), feb29: "feb28"|"mar1"}; daysBetween{from, to} = to - from in days; ageOn{dob, on} = whole years;
  weekday 1=Mon..7=Sun; isOpen{date, closed:[dates], weekends?=true}; businessDaysBetween{after, through, closed} counts open days d with after < d <= through;
  addBusinessDays{date, n, closed} = the n-th open day after date; prevOpenDay{date, closed} = the open day on or before date.
- firstMatch{cases:[{when, then}], else}: rules in PRIORITY order; the first true "when" wins.
- fmt{value, as: "date"|"money2"|"int"|"dec"|"text"}: money2 = exactly two decimals (declines if not exact to the cent).
- concat{parts:[...]}, join{from, sep}.
- decline{why}: use when the message says the case cannot be decided, or the data is ambiguous.
- sameName{a, b}: true when two person/provider/payer names are the same name (word order, commas, case, accents and credentials like MD/PA ignored). Use it for every comparison of names.
- classify{text, question, labels:[...]}: ONLY for reading the meaning of free text (a note) into one of the labels; returns null when unsure. Never use it to compute the answer.
A null (unknown) value reaching a condition or the answer makes the executor decline (a skip), which is always better than a wrong answer.

SITE VOCABULARY (entity: fields; name[{...}] = list of sub-records; name[] = list of strings):
${vocabText()}
Field meanings: dates are ISO; amounts are decimals; patient.recordNumber = the chart's record number (MRN); patient.insured = the chart has insurance on file; patient.problems = problem-list entries;
document.results = lab results printed on a report; document.doses = tetanus/vaccine doses printed on an outside immunization record;
claim.filed = false for a claim on the "not yet filed" list; claim.type Original|Secondary|Corrected; claim.submissions[].by = "payer"|"clearinghouse", accepted = bool;
remittance.kind = "payment"|"reversal", reverses = id of the payment it reverses; adjustments[].group "CO"/"PR"/..., reason = number;
appointment.start = "HH:MM" 24h local; appointment.bookedOn = date booked; startMovedOn = dates the start time was moved;
closure.status Active|Withdrawn, closure.scope = "all" or a location name; immunization.status Active|"Entered in error";
note.type = chart note|phone call|message|Triage..., note.text = full text; activity = appointment/chart history events; payer.filingTerms = claim filing term sets.
References between records hold the NAME as the site shows it, never an id: appointment.provider = "Jane Roe, MD", appointment.location / closure.location = location name, claim.payer / authorization.payer / coverage.payer = payer name. Only fields ending in "Id" (patientId, claimId, appointmentId) and remittance.reverses hold ids.
Use only these entities and fields.

RULES:
- Steps are lazy: a step is evaluated only when the answer (or another evaluated step) uses it, so data a branch needs is only required on that branch; a guard that must stop the task has to be on the answer's path (e.g. a firstMatch case whose "then" is decline).
- Implement the message's rule completely, including every exclusion, tie rule, boundary ("exactly at a limit is not ..."), priority order and special answer token.
- Copy the message's tables and constants verbatim into "tables"/"constants"; do not invent numbers.
- Make the plan general: it must work for ANY request of this kind, not only the example.
- Reply with the Plan JSON only.`;

export async function writePlan(message: string, ex: WorkedExample | null, o: { model: string; temperature?: number; repairOf?: { plan: unknown; issues: string[] }; caller?: Caller; siteSummary?: string }): Promise<{ plan: Plan | null; issues: string[]; raw: string | null }> {
  const call = o.caller ?? defaultCaller;
  const rules = ruleText(message);
  const user = (o.siteSummary ? `WHAT THE SITE HOLDS (toolkit site model; filters a need may set):\n${o.siteSummary}\n\n` : "") + `POLICY MESSAGE (worked example removed):\n${rules}\n\n` + (ex ? `A typical request of this kind: "${ex.request}"\n\n` : "") + `Write the Plan JSON.`;
  const msgs = [{ role: "system", content: PLAN_SYSTEM }, { role: "user", content: user }];
  if (o.repairOf) msgs.push({ role: "assistant", content: JSON.stringify(o.repairOf.plan) }, { role: "user", content: `The Plan has problems:\n- ${o.repairOf.issues.join("\n- ")}\nFix them and reply with the full corrected Plan JSON only.` });
  const raw = await call(msgs, o.model, { temperature: o.temperature ?? 0, maxTokens: 12000 });
  const j = jsonOf(raw); const plan = j ? normalizePlan(j) : null;
  if (!plan) return { plan: null, issues: [`model reply is not JSON (${(raw ?? "null").length} chars: ${(raw ?? "").slice(0, 60).replace(/\s+/g, " ")} … ${(raw ?? "").slice(-60).replace(/\s+/g, " ")})`], raw };
  const issues = validatePlan(plan);
  return { plan: issues.length ? plan : plan, issues, raw };
}

const WORLD_SYSTEM = `You encode the FACTS of a worked example from a clinic policy message as site records, so a program can be tested on them. You never decide the answer.

Reply with JSON only: {"patientId": "<id of the patient the request is about, or null>", "today": "<YYYY-MM-DD if the message states today, else null>", "entities": {"<entity>": [ {record}, ... ]}}
Entities and fields (use only these; name[{...}] is a list of sub-records, name[] a list of strings):
${vocabText()}
Field meanings: dates "YYYY-MM-DD", times "HH:MM" 24h, amounts as decimal strings ("190.00"), booleans true/false, codes as printed ("CO", reason 197 as the number 197).
patient.insured = the chart has insurance on file; problems = problem-list entries; document.results = lab results printed on a report; document.doses = doses printed on an outside immunization record;
claim.filed = false for a claim on the not-yet-filed list; submissions[].by "payer"|"clearinghouse"; remittance.kind "payment"|"reversal", reverses = the id of the payment it reverses;
closure.status Active|Withdrawn, scope "all" or a location name; immunization.status Active|"Entered in error"; every record has an "id"; patient-owned records have "patientId".
References between records hold the NAME as the site shows it, never an id: appointment.provider = "Jane Roe, MD", appointment.location / closure.location = location name, claim.payer / authorization.payer / coverage.payer = payer name. Only fields ending in "Id" (patientId, claimId, appointmentId) and remittance.reverses hold ids. Write names exactly as the message/request writes them.

RULES:
- Encode every fact the example states or clearly implies, including records the explanation says are NOT counted or are excluded (a dose on the visit date, an earlier reversed remittance, a later no-show, ...): those are what make the example a test.
- When the explanation gives only a count (e.g. "17 patients have an Active chart entry"), create that many distinct records with plausible ids/names.
- When the explanation states a value without its record (e.g. "the contract gives 120 days under Appeals"), put it on the right entity (payer.appealsDays = 120).
- Every record carries every field the rule reads for that kind of record (report and record numbers, the patient's sex and record number, a claim's submissions and lines, a remittance's lines, ...). When the example doesn't state one, choose a value consistent with the explanation and the expected answer (e.g. a sex for which the stated results give the stated outcome; the chart's record number on a report filed in that chart). A list the explanation implies is empty is [] (not omitted).
- Never invent facts that would change the answer.
- Free text (notes, account notes) should be realistic text that says what the explanation says it says.`;

export async function buildWorld(message: string, ex: WorkedExample, o: { model: string; caller?: Caller }): Promise<{ world: World | null; why: string }> {
  const call = o.caller ?? defaultCaller;
  const raw = await call([{ role: "system", content: WORLD_SYSTEM }, { role: "user", content: `POLICY MESSAGE:\n${message}\n\nTHE WORKED EXAMPLE TO ENCODE:\nRequest: "${ex.request}"\nExpected answer: ${ex.answer}\nExplanation:\n${ex.explanation}\n\nEncode the example's facts as records. JSON only.` }], o.model, { temperature: 0, maxTokens: 16000 });
  const j = jsonOf(raw);
  if (!j || typeof j.entities !== "object") return { world: null, why: "world builder reply is not JSON" };
  const entities: Record<string, Rec[]> = {};
  const bad: string[] = [];
  for (const [e, rs] of Object.entries(j.entities)) { if (!VOCAB[e]) { bad.push(e); continue; } if (Array.isArray(rs)) entities[e] = rs as Rec[]; }
  return { world: { inputs: {}, entities, resolved: j.patientId ? { patient: String(j.patientId) } : undefined, today: j.today ?? undefined }, why: bad.length ? `dropped unknown entities ${bad.join(",")}` : "" };
}

/** Task text → the plan's inputs (model extracts strings; types are checked here). */
export async function extractInputs(plan: Plan, task: string, o: { model: string; caller?: Caller }): Promise<{ inputs: Record<string, unknown> | null; why: string }> {
  const call = o.caller ?? defaultCaller;
  const spec = plan.inputs.map((i) => `- ${i.name} (${i.type}${i.note ? `: ${i.note}` : ""})`).join("\n");
  const raw = await call([{ role: "system", content: `Extract the named slots from a clinic back-office request. Reply JSON only: {"<name>": value}. Types: patient → {"name": "<as written>", "dob": "YYYY-MM-DD" or null}; date → "YYYY-MM-DD"; time → "HH:MM" 24h; int/dec → number as a string; text/id → string exactly as written. A slot the request does not give → null. Convert written dates to ISO. Never guess.` }, { role: "user", content: `Slots:\n${spec}\n\nRequest: "${task}"` }], o.model, { temperature: 0, maxTokens: 600 });
  const j = jsonOf(raw); if (!j) return { inputs: null, why: "input extraction failed" };
  const out: Record<string, unknown> = {};
  for (const i of plan.inputs) {
    const v = j[i.name];
    if (v === null || v === undefined) { out[i.name] = null; continue; }
    if (i.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) return { inputs: null, why: `input ${i.name}: not a date: ${v}` };
    if (i.type === "time" && !/^\d{2}:\d{2}$/.test(String(v))) return { inputs: null, why: `input ${i.name}: not a time: ${v}` };
    out[i.name] = i.type === "patient" ? { name: String(v?.name ?? ""), dob: v?.dob ?? null } : String(v);
  }
  return { inputs: out, why: "" };
}

/** The patient a request names, among the world's patients: every name word matches, DOB when given; exactly one. */
export function resolvePatientIn(world: World, p: { name: string; dob?: string | null } | null): string | null {
  if (!p?.name) return null;
  const words = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[.,]/g, " ").split(/\s+/).filter(Boolean);
  const want = words(p.name);
  const hits = (world.entities.patient ?? []).filter((r) => { const have = new Set(words(String(r.name ?? ""))); return want.every((w) => have.has(w)) && (!p.dob || !r.dob || r.dob === p.dob); });
  return hits.length === 1 ? String(hits[0].id) : null;
}

/** classify hook: two reads (two models) must agree, cached. */
export function modelClassifier(models: [string, string], caller: Caller = defaultCaller): Classifier {
  const cache = new Map<string, string | null>();
  return async (text, question, labels) => {
    const k = JSON.stringify([text, question, labels]); if (cache.has(k)) return cache.get(k)!;
    const ask = async (m: string) => { const j = jsonOf(await caller([{ role: "system", content: `You read one piece of clinic text and answer a question about what it says, choosing exactly one label. Go only by what the text says. Reply JSON only: {"label": "<one of the labels, or UNSURE>"}` }, { role: "user", content: `Text: """${text}"""\nQuestion: ${question}\nLabels: ${labels.join(" | ")}` }], m, { temperature: 0, maxTokens: 100 })); return typeof j?.label === "string" ? j.label : null; };
    const a = await ask(models[0]); const b = a === null ? null : await ask(models[1]);
    const v = a && a === b && labels.includes(a) ? a : null; cache.set(k, v); return v;
  };
}
