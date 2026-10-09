/**
 * Best-effort tier (the FIFTH answer path): a task NO deterministic family claimed, no lookup answered and no
 * memo-routed executor answered is attempted here instead of skipped, and ANSWERED when the estimated precision
 * of the attempt clears AGENT_BEST_EFFORT_MIN_P (default 0.8; scoring is +1 / −1 / 0, so break-even is 0.5).
 *
 * It can never fire on a task a family claimed: the caller passes the family match and this module refuses any
 * non-null family AND re-runs familyMatch itself (bestEffort-test.ts checks every Set 1 task against the gate).
 * Set 1, where every task has a family, therefore keeps its 0 wrong by construction.
 *
 * One attempt:
 *  1. spec: the task + the acknowledged memo it is routed to (wfShadow.wfForAsync: words, else the cached router decision; its later messages) + the site model.
 *     A plain question (no memo) gets a generic spec: one value copied or counted from the pages, in its plainest form.
 *  2. gather (wfGather.gatherV3): deterministic prefetch by the task's named inputs through the toolkit (patient by the
 *     shared resolver, chart tabs by label with completeness proofs, clinic lists filtered by their own controls), then
 *     ONE cheap-model round with read-only tools (open pages, list entities, read a lab image by two agreeing readers).
 *     Every page is quarantined (lines addressed to an AI / assistant stripped and counted) before a model sees it.
 *     No writes, no gate unlocks, no navigation to a link no gathered page showed.
 *  3. two derivations: (A) votes — structured extraction with quoted facts by two models of DIFFERENT provider
 *     families (haiku-5.5 ∥ gemini-3.8-flash; a sonnet tiebreak only when they disagree and time allows, counted
 *     separately); (B) a deterministic derivation when one applies: lookup.ts (one labelled value / count over a
 *     proven-complete chart list) or chartAnswers.ts (MRN / sex / provider / appointment extremes).
 *  4. estimate: independent signals combined as log-odds into ONE probability (SIGNALS below): cross-family agreement,
 *     deterministic agreement, quoted evidence grounded in the pages, completeness proof of every list used, memo
 *     worked-example reproduction, answer kind. Hard vetoes (never answered whatever the estimate): a vote says the
 *     question is not this memo's; the deterministic derivation DIFFERS; the memo's example failed; the answer is not in
 *     the memo's form; a count / absence over a list the page did not prove complete; yes / no; an unreadable date.
 *  5. decision: answer iff p ≥ MIN_P, else skip with a why naming the weakest signal. One `{"event":"best_effort"}`
 *     line per attempt carries every signal, the votes, the derivations, the estimate and the decision, so a hidden-set
 *     run still leaves a readable funnel (and bench/best-effort/calibrate.mjs measures precision per threshold).
 *
 * Flags: AGENT_BEST_EFFORT=on|off (default off), AGENT_BEST_EFFORT_MIN_P (0.8), AGENT_BEST_EFFORT_TASK_S (25, hard cap
 * 60; only with pacer slack: pacer.extraOk, like the generalist), AGENT_BEST_EFFORT_RESERVE_S (120: never in the last
 * two minutes), AGENT_BEST_EFFORT_GATHER_S (12), AGENT_BEST_EFFORT_MODELS, AGENT_BEST_EFFORT_TIEBREAK (sonnet-5.5),
 * AGENT_BEST_EFFORT_MAX (400 tasks per shift).
 */
import { familyMatch, type FamilyMatch } from "./families.js";
import type { ClinicIndex, PatientRecord } from "./inference.js";
import { pacer } from "./pacer.js";
import * as spend from "./spend.js";
import { isListed, textSlots, chat, lastCause } from "./failover.js";
import { wfForAsync, type Wf } from "./wfShadow.js";
import { runVotes, matchesTokenFormat, exampleGateText, transportExtras, type WfSpec, type Vote, type Gathered, type Runner } from "./workflowExec.js";
import { gatherV3, asGathered, type GatherOut } from "./wfGather.js";
import { lookupSpec, lookup, type LookupOut } from "./lookup.js";
import { chartQuestion, chartAnswer } from "./chartAnswers.js";
import { extractSlots } from "./parse.js";
import { parseDate } from "./solver/dates.js";

export type BeMode = "on" | "off";
export const beMode = (): BeMode => ((process.env.AGENT_BEST_EFFORT ?? "off").toLowerCase() === "on" ? "on" : "off");
const num = (k: string, d: number) => { const n = Number(process.env[k]); return Number.isFinite(n) && n >= 0 ? n : d; };
export const beMinP = (): number => Math.min(1, Math.max(0, num("AGENT_BEST_EFFORT_MIN_P", 0.8)));
export const beTaskS = (): number => Math.min(60, num("AGENT_BEST_EFFORT_TASK_S", 25) || 25);

// ── text gates: cheap vetoes before any browsing ──
const YESNO = /^\s*(?:is|are|was|were|does|do|did|has|have|had|can|could|will|would|should|shall|may|might)\b(?![^?]*\b(?:when|what|which|who|whom|whose|how many|how much|where)\b)/i;
const JUDGEMENT = /\bwhy\b|\bshould we\b|\brecommend|\bexplain\b|\bsummari[sz]e\b|\bdescribe\b|\bopinion\b|\badvice\b/i;
/** Arithmetic over page values (never copied, never counted): days ago / since / between, ages, averages, percentages, differences.
 *  A memo may define a sum ("total balance"), so "total / sum" are vetoed only when no memo routes the task (see bestEffort). */
const DERIVED = /\b(?:days?|weeks?|months?|years?) (?:ago|since|until|till|between|from|before|after|old)\b|\bhow (?:long|old|soon|late|far)\b|\baverage\b|\bmean\b|\bmedian\b|\bpercent|\b%|\bdifference\b|\bratio\b|\bper (?:day|week|month|year)\b|\belapsed\b/i;
const DERIVED_NO_MEMO = /\btotal of\b|\bsum\b|\baltogether\b|\bin total\b|\badd(?:ed)? up\b|\bcombined\b/i;
const ANCHOR = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{4}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b|\b\d{5,}\b|\blot\s*#?\s*[A-Z0-9]{5,}\b|\b(?:today|this week|this month|yesterday)\b/i;
/** Why a task can never be a best-effort attempt from its text alone, or "" when it may be. */
export function beTextGate(task: string, tokenMemo = false): string {
  const q = task.split("\n")[0].trim();
  // (a memo with an answer-token grammar answers a yes/no-shaped request with a token: "Still with the group?" → ACTIVE:<user>)
  if (YESNO.test(q) && !tokenMemo) return "a yes/no question is never answered";
  if (JUDGEMENT.test(q)) return "a judgement / explanation question is never answered";
  if (DERIVED.test(q)) return "a value computed from page values (days ago, age, average, percentage) is never answered";
  const s = extractSlots(q);
  if (!s.patient && !s.provider && !ANCHOR.test(q)) return "no named input to gather by (patient, provider, date or record number)";
  return "";
}
/** Text-only: would the tier attempt this task (its own pacer family "best-effort" before any browsing)? */
export const beRouted = (task: string, family: FamilyMatch | null): boolean => beMode() === "on" && family === null && !familyMatch(task) && beTextGate(task) === "";

// ── the generic spec for a plain question (no memo routes it) ──
const GENERIC_RAW = `From the office manager: plain questions about the clinic's data

Answer the request from the clinic pages given. The answer is ONE value copied or counted from the pages, nothing else:
- a whole number when the request counts things, for example \`3\` (\`0\` only when the gathered list is complete and empty);
- a date as \`YYYY-MM-DD\` (a page writes "Nov 24, 2025": answer \`2025-11-24\`);
- an amount in dollars with two decimals and no sign, for example \`118.40\`;
- a short text exactly as the page shows it (a name, a status, a type, an identifier), for example \`Follow-up visit\`.
Never a yes / no, never a sentence, never a value the pages do not show. When the request asks for something no gathered page states, when a needed list was not read completely, or when two records could be the one asked about, the answer is UNKNOWN.`;
export function genericSpec(task = ""): WfSpec {
  // the request is appended so the gather's prefetch heuristics (chart tabs by meaning, a clinic list by one date) see its nouns
  return { title: "plain question", heads: new Map(), generic: new Set(), bare: new Set(["int", "date", "amount", "text"]), raw: GENERIC_RAW + (task ? `\n\nThe request: ${task}` : "") };
}

// ── answer kinds and normalisation ──
export type Kind = "int" | "date" | "amount" | "text" | "token";
const MONTHS = /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}$|^\d{1,2}\/\d{1,2}\/\d{4}$|^\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+\d{4}$/i;
/** The plainest form of a value: digits, ISO date, two-decimal amount, or the text verbatim; null = not answerable
 *  (yes/no, a sentence, a date that cannot be read, a time of day). */
export function plainForm(a: string): { answer: string; kind: Kind } | null {
  let t = a.trim().replace(/^[`"'“”]+|[`"'“”.]+$/g, "").trim();
  if (!t || t.length > 80 || /\n/.test(t)) return null;
  if (/^(?:yes|no|true|false|none|unknown|n\/a)$/i.test(t)) return null;
  // a page's "nothing here" placeholder is not a value (set2-hyp held-out: "None on file" for an empty primary provider)
  if (/^(?:none|nothing|no \w+|not)(?: (?:on file|recorded|listed|available|set|assigned|known|given|found|entered|specified))$|^(?:—|–|-|n\.?a\.?|not applicable|unassigned|unknown \w+)$/i.test(t)) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return parseDate(t) ? { answer: t, kind: "date" } : null;
  if (MONTHS.test(t)) { const d = parseDate(t); return d ? { answer: d, kind: "date" } : null; }
  if (/^\d{4}-\d{2}-\d{2}[ T,]+\d{1,2}:\d{2}/.test(t) || /^\d{1,2}:\d{2}(?:\s*[ap]\.?m\.?)?$/i.test(t)) return null; // a time: form unprovable
  t = t.replace(/^\$\s*/, "");
  if (/^-?\d{1,3}(?:,\d{3})+(?:\.\d{2})?$|^-?\d+\.\d{2}$/.test(t)) { const n = t.replace(/,/g, ""); return { answer: /\./.test(n) ? n : n + ".00", kind: "amount" }; }
  if (/^-?\d+$/.test(t)) return { answer: String(Number(t)), kind: "int" };
  if (/^-?\d+\.\d+$/.test(t)) return { answer: t, kind: "amount" };
  if (t.split(/\s+/).length > 8) return null; // a sentence, not a value
  return { answer: t, kind: "text" };
}
const kindOf = (a: string, memo: boolean): Kind => memo && /^[A-Z][A-Z0-9_]+(?::|$)/.test(a) ? "token" : (plainForm(a)?.kind ?? "text");
/** A memo's answer form, loosely: the executor's token / bare-shape gate, else a bare backticked example in the memo of the
 *  same plain kind as the answer (a lowercase username `framirez`, which the strict gate's capitalised-text rule misses). */
export function memoFormOk(a: string, spec: WfSpec): "token" | "bare" | "loose" | null {
  if (matchesTokenFormat(a, spec)) return /^[A-Z][A-Z0-9_]+(?::|$)/.test(a) ? "token" : "bare";
  if (/^[A-Z][A-Z0-9_]+(?::|$)/.test(a)) return null; // an unknown token is never a memo answer
  const pf = plainForm(a); if (!pf) return null;
  const examples = [...spec.raw.matchAll(/`([^`\n]{1,40})`/g)].map((m) => m[1]).filter((t) => !/^[A-Z][A-Z0-9_]+(?::|$)/.test(t) && !/^<.+>$/.test(t) && !/^YYYY/.test(t));
  return examples.some((t) => plainForm(t)?.kind === pf.kind) ? "loose" : null;
}

/** A non-token text answer that mixes letters and digits (member ID "HZD392530760", a record number): the practice and Set 1
 *  pages draw such ids with decoy digits in scrambled fonts that a DOM read cannot tell apart (cov-suite: 3 of 3 member IDs
 *  wrong, all cross-model agreed and grounded). Only a deterministic reader that proves the value (chartAnswers MRN: the search
 *  row and the chart header agree) may give one. */
export const mixedId = (a: string, spec?: WfSpec): boolean => !(spec && spec.heads.has(a.split(":")[0])) && /[A-Za-z]/.test(a) && /\d/.test(a) && !/^\d{4}-\d{2}-\d{2}$/.test(a);

// ── signals → one probability ──
export type Signals = {
  votes: number;                 // format-valid, non-UNKNOWN votes
  agree: "cross" | "same" | "tiebreak" | "single" | "det-only" | "none"; // agreement among the answering votes (det-only: no vote, a deterministic derivation)
  dissent: boolean;              // a format-valid vote with a different answer
  det: "agree" | "differ" | "none" | "declined"; // the deterministic derivation vs the voted answer
  grounded: "all" | "some" | "none"; // quotes of the agreeing votes found verbatim in the pages
  proof: "page" | "model" | "unread" | "nolist"; // weakest completeness proof among the lists the gather read
  example: "ok" | "fail" | "na";
  kind: Kind; memo: boolean;
  form: "token" | "bare" | "loose" | "plain"; // how the answer's form was checked (memo token table / memo bare shape / a memo example of the kind / plain form)
  gatherIssues: number;          // refused / failed gather steps
  stripped: number;              // quarantined lines
};
/** Log-odds weights (hand-set from the executor's measured operating points — wfEval: two cross-family grounded votes
 *  agreeing ≈ 98–99 % right, one model alone ≈ 97 % on memo tasks; plain questions have no prior measurement, so the
 *  base is conservative). bench/best-effort/calibrate.mjs reports the measured precision per estimate bucket; the
 *  weights are tuned there, never on a scored set. */
export const WEIGHTS = {
  base: Math.log(0.6 / 0.4),
  agree: { cross: 2.2, tiebreak: 1.2, same: 1.0, single: 0, "det-only": 1.5, none: -9 },
  dissent: -3.0,
  det: { agree: 2.5, differ: -9, none: 0, declined: -0.3 },
  grounded: { all: 1.0, some: -1.5, none: -2.5 },
  proof: { page: 0.5, model: -0.8, unread: -1.5, nolist: 0 },
  example: { ok: 0.6, fail: -9, na: 0 },
  kind: { int: -0.6, date: -0.3, amount: -0.3, text: 0, token: 0.3 },
  memo: 0.3, form: { token: 0, bare: 0, loose: -0.4, plain: 0 }, gatherIssue: -0.4, stripped: -0.5,
  /** a count with no memo and no deterministic agreement: calibration (BEST-EFFORT.md §4b, 4 queues, n = 108) measured plain
   *  counts at 75 % (15/20) vs 97 % for everything else — near-miss count questions ("unreviewed", "fees charged", "cancel" vs
   *  late-cancel) agree across models and ground their quotes. −2.5 puts them under MIN_P 0.8. */
  plainInt: -2.5,
};
export function estimate(s: Signals): { p: number; parts: Record<string, number>; weakest: string } {
  const W = WEIGHTS; const parts: Record<string, number> = {
    agree: W.agree[s.agree], dissent: s.dissent ? W.dissent : 0, det: W.det[s.det], grounded: W.grounded[s.grounded], proof: W.proof[s.proof],
    example: W.example[s.example], kind: W.kind[s.kind], memo: s.memo ? W.memo : 0, form: W.form[s.form ?? "plain"], plainInt: !s.memo && s.kind === "int" && s.det !== "agree" ? W.plainInt : 0, gather: Math.min(3, s.gatherIssues) * W.gatherIssue, stripped: s.stripped ? W.stripped : 0,
  };
  const z = W.base + Object.values(parts).reduce((a, b) => a + b, 0);
  const p = 1 / (1 + Math.exp(-z));
  const weakest = Object.entries(parts).sort((a, b) => a[1] - b[1])[0];
  return { p: Math.round(p * 1000) / 1000, parts, weakest: weakest && weakest[1] < 0 ? `${weakest[0]}=${(s as any)[weakest[0]] ?? ""}` : "none" };
}

// ── votes → candidate answer ──
const family = (m: string) => m.split("/")[0];
export function tally(votes: Vote[], spec: WfSpec, memo: boolean): { answer: string | null; kind: Kind; agree: Signals["agree"]; dissent: boolean; grounded: Signals["grounded"]; votes: number; applyVeto: boolean } {
  const applyVeto = votes.some((v) => v.applies === false);
  const valid = votes.filter((v) => v.answer != null).map((v) => ({ v, norm: memo ? v.answer!.trim().replace(/^`|`$/g, "") : plainForm(v.answer!)?.answer ?? null })).filter((x) => x.norm != null && (memo ? memoFormOk(x.norm, spec) !== null : true)) as Array<{ v: Vote; norm: string }>;
  const groups = new Map<string, Vote[]>(); for (const x of valid) groups.set(x.norm, [...(groups.get(x.norm) ?? []), x.v]);
  const best = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  if (!best) return { answer: null, kind: "text", agree: "none", dissent: false, grounded: "none", votes: 0, applyVeto };
  const [answer, vs] = best; const dissent = groups.size > 1;
  const fams = new Set(vs.map((v) => family(v.model)));
  const agree: Signals["agree"] = vs.length >= 2 ? (fams.size >= 2 ? "cross" : "same") : "single";
  const grounded: Signals["grounded"] = vs.every((v) => v.grounded) ? "all" : vs.some((v) => v.grounded) ? "some" : "none";
  return { answer, kind: kindOf(answer, memo), agree, dissent, grounded, votes: valid.length, applyVeto };
}
/** Weakest completeness proof among the list pages the gather READ: a [model] proof → model; all [page] → page; no list read
 *  → nolist; every list page it tried was "(not read: …)" → unread. Unread pages beside a read list count as gather issues. */
export function proofOf(g: GatherOut): Signals["proof"] {
  const unread = (p: { text: string }) => /^\(not read:|did not open\)|No invoice page opened/.test(p.text.trim());
  const lists = g.pages.filter((p) => /list|Documents|Invoices|Appointments|Notes|lots/i.test(p.name));
  const read = lists.filter((p) => !unread(p));
  if (!read.length) return lists.length ? "unread" : "nolist";
  return read.some((p) => /\[model\]/.test(p.proof ?? "") || /about \d|\+ (?:bound|footer)/i.test(p.proof ?? "")) ? "model" : "page";
}
export const unreadPages = (g: GatherOut): number => g.pages.filter((p) => /^\(not read:|did not open\)|No invoice page opened/.test(p.text.trim())).length;

// ── the attempt ──
export type BeResult = { answer: string | null; why: string; ran: boolean };
let used = 0; export const _resetBestEffort = () => { used = 0; };
export function beModels(): string[] {
  const env = (process.env.AGENT_BEST_EFFORT_MODELS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return (env.length ? env : ["anthropic/claude-haiku-5.5", "google/gemini-3.8-flash"]).filter((m) => isListed(m));
}
const tiebreakModel = () => { const m = process.env.AGENT_BEST_EFFORT_TIEBREAK ?? "anthropic/claude-sonnet-5.5"; return isListed(m) ? m : null; };

export async function bestEffort(index: ClinicIndex, task: string, fam: FamilyMatch | null, secondsLeft: number): Promise<BeResult> {
  if (beMode() !== "on") return { answer: null, why: "", ran: false };
  // THE invariant: a task a family claimed is never attempted here (the caller's match and our own re-match must both be null)
  if (fam !== null || familyMatch(task) !== null) return { answer: null, why: "", ran: false };
  const cr = (index as any).crawler; if (!cr) return { answer: null, why: "", ran: false };
  const rec: Record<string, unknown> = { event: "best_effort", task: task.replace(/\s+/g, " ").slice(0, 160) };
  const skip = (why: string, ran = false) => { rec.why = why; rec.answer = null; try { process.stdout.write(JSON.stringify(rec) + "\n"); } catch {} return { answer: null, why: "best effort: " + why, ran }; };
  // the memo the executor was routed to (words, or the cached router decision — no new call: the executor already asked)
  const memo: Wf | null = (await wfForAsync(task).catch(() => ({ w: null }))).w;
  const tg = beTextGate(task, !!memo && memo.spec.heads.size > 0); if (tg) return skip(tg);
  if (used >= num("AGENT_BEST_EFFORT_MAX", 400)) return skip("AGENT_BEST_EFFORT_MAX reached");
  if (secondsLeft < num("AGENT_BEST_EFFORT_RESERVE_S", 120)) return skip("shift reserve");
  const taskS = beTaskS(); if (!pacer.extraOk(taskS)) return skip("pacer: no slack for a best-effort attempt");
  { const g = spend.allowTask(); if (!g.ok) return skip(g.why); }
  const models = beModels(); if (!models.length) return skip("no best-effort model listed");
  used++;
  const t0 = Date.now(); const minP = beMinP();
  if (!memo && DERIVED_NO_MEMO.test(task.split("\n")[0])) return skip("a sum / total over page values with no memo defining it is never answered");
  const spec = memo ? memo.spec : genericSpec(task); const later = memo ? memo.later : [];
  rec.memo = memo ? memo.spec.title : null; rec.models = models; rec.minP = minP;
  const g3: { v: GatherOut | null } = { v: null };
  // the votes' raw replies (head) and finish reasons are kept for the log: a vote that gave no answer is auditable
  const raws: Array<{ model: string; finish: string; head: string }> = [];
  const runner: Runner = async (body, model, waitMs, cls) => {
    const j = await chat({ ...body, ...transportExtras(model) }, { primary: model, fallbacks: [], attempts: 2, waitMs: waitMs ?? 90000, cls: cls ?? "text" });
    const c = j?.choices?.[0]; const txt = c?.message?.content ?? null;
    raws.push({ model: model.split("/").pop()!, finish: String(c?.finish_reason ?? (j ? "?" : "no reply: " + lastCause)), head: String(txt ?? "").replace(/\s+/g, " ").slice(0, 240) });
    return txt;
  };
  const work = (async () => {
    // memo worked example (cached on the memo by the executor's eager gate, else now, on one slot)
    const exP: Promise<{ ok: boolean | null; why: string }> = memo ? (memo.example ??= exampleGateText(memo.spec, { models, concurrency: 1 }).catch((e) => ({ ok: false, why: "example threw " + String(e).slice(0, 60) }))) : Promise.resolve({ ok: null, why: "" });
    const gatherS = Math.min(num("AGENT_BEST_EFFORT_GATHER_S", 12), taskS - 8);
    const g = g3.v = await gatherV3(index, spec, task, { budgetMs: Math.max(3000, gatherS * 1000) });
    // the clinic's today (dashboard date, read at warm-up): memos count windows "up to and including today"
    if (g.pages.length && cr.today) g.pages.push({ name: "Clinic dashboard: today's date", text: `Today is ${cr.today}.`, proof: "read at warm-up" });
    // the demographics page as PROVEN fields: the chart text's digits were decoded with the page-wide phone-font map, which
    // mangles a DOB / MRN drawn in another font (practice: "08/04/1791"), and a mangled DOB makes every vote answer UNKNOWN
    { const s0 = extractSlots(task.replace(/(\w)['’]s\b/g, "$1")); const pat: PatientRecord | null = s0.patient ? index.findPatient(s0.patient, s0.dob) : null;
      const dp = g.pages.find((p) => /\(demographics\)$/.test(p.name));
      if (dp && pat) { const d = pat.demographics ?? {}; const lines = [`Patient: ${pat.name}`, pat.dobISO ? `Date of birth: ${pat.dobISO}` : "", (pat as any).mrn ? `MRN: ${(pat as any).mrn}` : "", d.sex ? `Sex: ${d.sex}` : "", d.phone ? `Phone: ${d.phone}` : "", d.email ? `Email: ${d.email}` : "", d.address ? `Address: ${d.address}` : "", d["primary provider"] ? `Primary provider: ${d["primary provider"]}` : "", d["home location"] ? `Home location: ${d["home location"]}` : ""].filter(Boolean);
        const rest = dp.text.split("\n").filter((l) => !/\d/.test(l) && l.trim()).slice(0, 40); // lines without digits keep their text (badges, flags, headings)
        dp.text = lines.join("\n") + "\n" + rest.join("\n"); dp.proof = "fields read by label after the shared resolver; DOB from the search row; digits decoded per field"; } }
    // the page NAME is part of the evidence a quote may cite (a toolkit list's name states its row count and proof)
    const gathered: Gathered = { pages: asGathered(g).pages.map((p) => ({ name: p.name, text: `${p.name}\n${p.text}` })), why: g.why };
    if (!g.pages.length) return { g, gathered, votes: [] as Vote[], det: { kind: "none", answer: null, why: "no pages gathered" + (g.why ? ": " + g.why : "") }, ex: await exP };
    if (g.why) return { g, gathered, votes: [] as Vote[], det: { kind: "none", answer: null, why: "gather incomplete: " + g.why }, ex: await exP };
    const left = t0 + taskS * 1000 - Date.now();
    if (left < 5000) return { g, gathered, votes: [] as Vote[], det: { kind: "none", answer: null, why: `time budget: ${Math.round((Date.now() - t0) / 1000)} s spent gathering` }, ex: await exP };
    // (B) the deterministic derivation runs on the browser while the votes (A) run on the model slots
    const detP: Promise<{ kind: string; answer: string | null; why: string }> = (async () => {
      const ls = lookupSpec(task);
      if (!("why" in ls)) { const r: LookupOut = await lookup(task, cr, Math.max(3000, left - 1500), () => {}).catch((e) => ({ why: "lookup threw " + String(e).slice(0, 60) })); return "answer" in r ? { kind: "lookup", answer: r.answer, why: "" } : { kind: "lookup", answer: null, why: r.why }; }
      const cq = chartQuestion(task);
      if (cq) { const s = extractSlots(task); const pat: PatientRecord | null = s.patient ? index.findPatient(s.patient, s.dob) : null; if (!pat) return { kind: "chart", answer: null, why: "chart: patient record not cached" }; let w = ""; const a = chartAnswer(cq, pat, (x) => { w = x; }, cr.today); return { kind: "chart", answer: a, why: a ? "" : w }; }
      return { kind: "none", answer: null, why: "" };
    })();
    let votes = await runVotes(spec, later, task, gathered, { models, concurrency: textSlots(), waitMs: left - 500, stopEarly: false, runner });
    // a sonnet tiebreak when the two runs disagree and ≥ 7 s remain (counted separately: agree = "tiebreak")
    const tb = tiebreakModel(); const left2 = t0 + taskS * 1000 - Date.now();
    const distinct = new Set(votes.filter((v) => v.answer != null).map((v) => (spec.heads.size ? v.answer!.trim() : plainForm(v.answer!)?.answer ?? v.answer!)));
    let tiebreak = false;
    if (tb && distinct.size > 1 && left2 >= 7000 && !spend.state.cheap) { tiebreak = true; const extra = await runVotes(spec, later, task, gathered, { models: [tb], waitMs: left2 - 500 }); votes = [...votes, ...extra]; }
    const det = await detP;
    return { g, gathered, votes, det, ex: await exP, tiebreak };
  })();
  const res = await Promise.race([work, new Promise<null>((r) => setTimeout(() => r(null), taskS * 1000))]);
  rec.ms = Date.now() - t0;
  if (!res) { if (g3.v) rec.gather = { ms: g3.v.ms, steps: g3.v.steps, stripped: g3.v.stripped, pages: g3.v.pages.length }; return skip(`time budget (${taskS} s)`, true); }
  const { g, votes, det, ex } = res;
  rec.inputs = g.inputs; rec.pages = g.pages.map((p) => `${p.name} (${p.text.length})`); rec.gather = { ms: g.ms, steps: g.steps, stripped: g.stripped };
  rec.runs = votes.map((v) => ({ m: v.model.split("/").pop(), a: v.answer, applies: v.applies, q: v.quotes, grounded: v.grounded, ...(v.ungrounded.length ? { ung: v.ungrounded.slice(0, 2) } : {}), ...(v.err ? { err: v.err } : {}) }));
  rec.raws = raws;
  rec.det = det; rec.example = ex.ok === null ? "na" : ex.ok ? "ok" : ex.why;
  if (!votes.length && det.answer == null) return skip(det.why || "no votes", true);
  let t = tally(votes, spec, !!memo);
  // no vote answered but a deterministic derivation did (lookup / chart answerer: label-grounded, no model): it is the candidate,
  // with no model agreement behind it (agree = "none" is a veto; "det-only" carries its own weight for calibration)
  const detOnly = t.answer == null && det.answer != null && (memo ? memoFormOk(det.answer, spec) !== null : !!plainForm(det.answer));
  if (detOnly) t = { ...t, answer: memo ? det.answer!.trim() : plainForm(det.answer!)!.answer, kind: kindOf(det.answer!, !!memo), agree: "det-only", dissent: false, grounded: "all" };
  const detDiffers = det.answer != null && t.answer != null && (memo ? det.answer.trim() !== t.answer : (plainForm(det.answer)?.answer ?? det.answer) !== t.answer);
  const sig: Signals = {
    votes: t.votes, agree: (res as any).tiebreak && t.agree !== "single" && t.agree !== "none" ? "tiebreak" : t.agree, dissent: t.dissent,
    det: det.answer == null ? (det.kind === "none" ? "none" : "declined") : detDiffers ? "differ" : "agree",
    grounded: t.grounded, proof: proofOf(g), example: ex.ok === null ? "na" : ex.ok ? "ok" : "fail", kind: t.kind, memo: !!memo, form: memo && t.answer ? (memoFormOk(t.answer, spec) ?? "loose") : "plain",
    gatherIssues: g.steps.filter((s) => /refused|did not load|not read|error|no reply|no tool call/.test(String(s.result ?? s.note ?? ""))).length + unreadPages(g), stripped: g.stripped,
  };
  const est = estimate(sig);
  rec.signals = sig; rec.p = est.p; rec.parts = est.parts; rec.candidate = t.answer; // candidate stays logged through a veto (calibration scores it offline)
  // hard vetoes
  if (t.applyVeto) return skip("veto: a run says the request is not this memo's question", true);
  if (!t.answer) return skip("no run gave an answer in the expected form: " + votes.map((v) => `${v.model.split("/").pop()}=${v.answer ?? "-"}`).join(" "), true);
  if (sig.det === "differ") return skip(`veto: the deterministic derivation (${det.kind}) says ${det.answer}, the votes say ${t.answer}`, true);
  if (sig.example === "fail") return skip("veto: the memo's worked example was not reproduced: " + ex.why, true);
  if ((sig.kind === "int" || /^(?:0|NONE|NO_[A-Z_]+)$/.test(t.answer)) && sig.proof !== "page" && sig.proof !== "nolist") return skip(`veto: a count / absence over a list the page did not prove complete (proof=${sig.proof})`, true);
  if (sig.kind === "int" && sig.proof === "nolist" && sig.det !== "agree" && sig.agree !== "det-only") return skip("veto: a count with no list read", true);
  if (mixedId(t.answer, memo ? spec : undefined) && sig.det !== "agree") return skip("veto: an identifier mixing letters and digits read from page text (scrambled-font decoy digits; only a deterministic reader that proves it may answer)", true);
  rec.answer = t.answer;
  if (est.p < minP) return skip(`p=${est.p} < ${minP} (weakest signal ${est.weakest}; would answer ${t.answer})`, true);
  rec.why = ""; try { process.stdout.write(JSON.stringify(rec) + "\n"); } catch {}
  return { answer: t.answer, why: "", ran: true };
}
