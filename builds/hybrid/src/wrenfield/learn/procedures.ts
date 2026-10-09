/**
 * Procedure library — what the agent has learned about workflows, as data (LESSONS.md §A: cache templates with
 * parameters, match structurally; Logic-LM: rules as a declarative IR, never code).
 *
 * One Procedure per workflow signature (the memo's title tokens, entity nouns and answer-format grammar):
 *   - `plan`:   the declarative Plan IR (solver/plan.ts) a deterministic executor runs — or none, when only the
 *               vote procedure (workflowExec votes under a decision policy) has been verified;
 *   - `policy`: the vote procedure's decision policy (k / strict / ground / example mode / models);
 *   - `verification`: which worked examples each candidate reproduced, how (live site / the example's text facts), when;
 *   - `calibration`: weights of the confidence signals → estimated precision (the harness compares it with MIN_P);
 *   - `stats`: attempts, answers, agreements, failures, example failures, demotions.
 * The library is baked into the image (library.json, written by bench/learn/train.mjs), loaded at boot (`loadLibrary`),
 * extended during the shift (learner.ts) and serialised at shift end into the log as one `{"event":"library"}` line, so a
 * Set 1 / practice run exports what it learned (bench/learn/grade-shadow.mjs reads it back). Pure data + pure functions:
 * no model, no site, no clock other than the caller's.
 */
import { readFileSync } from "node:fs";
import type { WfSpec } from "../workflowExec.js";
import type { Plan } from "../solver/plan.js";

export type Signature = { title: string[]; nouns: string[]; heads: string[]; bare: string[]; inputs: string[] };
export type VerifyLevel = "live" | "text" | "none";
export type Verification = { candidate: string; request: string; want: string; got: string | null; ok: boolean; level: VerifyLevel; at: string; ms?: number; why?: string };
export type Policy = { k: number; strict: boolean; ground: boolean; example: "require" | "pass-or-na" | "ignore"; models?: string[] };
export type Stats = { attempts: number; answered: number; agreements: number; disagreements: number; failures: number; exampleFailures: number; demotions: number; recompiles: number; msTotal: number };
export type Status = "candidate" | "verified" | "demoted" | "retired";
export type Procedure = {
  id: string; title: string; signature: Signature; status: Status;
  plan?: Plan | null; planStatus?: Status; planSource?: string;
  policy: Policy;
  verification: Verification[];
  calibration: Weights;
  stats: Stats;
  createdAt: string; updatedAt: string; source: "baked" | "shift";
};
/** Confidence signals of one answer (null = not observable for this derivation). */
export type Signals = { agree: boolean | null; voters: number; dissent: boolean; grounded: boolean | null; complete: boolean | null; example: boolean | null; format: boolean; applies: boolean | null; plan: boolean; live: boolean };
/** Logistic weights over the signals: p = σ(bias + Σ w·x). `null` signals contribute 0 (unknown = no evidence). */
export type Weights = { bias: number; agree: number; voters: number; dissent: number; grounded: number; complete: number; example: number; exampleFail: number; format: number; applies: number; plan: number; live: number };
export type Library = { version: 1; builtAt: string; commit?: string; note?: string; weights: Weights; policy: Policy; minP: { canary: number; on: number }; procedures: Procedure[] };

export const DEFAULT_WEIGHTS: Weights = { bias: -1.2, agree: 1.6, voters: 0.5, dissent: -7, grounded: 1.2, complete: 0.6, example: 0.9, exampleFail: -9, format: 1.0, applies: 0.8, plan: 0.7, live: 0.5 };
/** The measured operating point of the vote procedure (NEXT.md: k=1 strict ground, example pass-or-na). */
export const DEFAULT_POLICY: Policy = { k: 1, strict: true, ground: true, example: "pass-or-na" };
export const emptyStats = (): Stats => ({ attempts: 0, answered: 0, agreements: 0, disagreements: 0, failures: 0, exampleFailures: 0, demotions: 0, recompiles: 0, msTotal: 0 });

const STOP = new Set("the a an of to for and or in on at by with what when how is are be it its this that from we our your you they them their do does did which who has have had any each every one patient patients visit please could would should need want tell look know about there these those into over after before not all per via may yet off was were been".split(" "));
const words = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").split(/[^a-z]+/).filter((w) => w.length >= 3 && !STOP.has(w));
const sing = (w: string) => (w.endsWith("ies") ? w.slice(0, -3) + "y" : w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
/** Entity nouns the product vocabulary names (siteModel entities + their common synonyms). */
const NOUNS = ["patient", "appointment", "visit", "document", "report", "letter", "invoice", "balance", "payment", "claim", "remittance", "immunization", "vaccine", "dose", "lot", "note", "provider", "payer", "plan", "insurance", "authorization", "coverage", "problem", "diagnosis", "order", "referral", "lab", "panel", "wound", "tetanus", "estimate", "deadline", "filing", "recall", "location", "slot", "schedule"];
export function signatureOf(spec: WfSpec): Signature {
  const all = new Set(words(spec.raw).map(sing));
  const inputs: string[] = [];
  const t = spec.raw;
  if (/\bpatient\b|\bborn\b|\bDOB\b|date of birth/i.test(t)) inputs.push("patient");
  if (/\bdates?\b|\bday\b|\bon <date>|\bservice date/i.test(t)) inputs.push("date");
  if (/\binvoice (?:number|#|no\b)|\b\d{8}\b/i.test(t)) inputs.push("invoice");
  if (/\blots?\b/i.test(t)) inputs.push("lot");
  if (/\bprovider\b/i.test(t)) inputs.push("provider");
  return { title: [...new Set(words(spec.title).map(sing))], nouns: NOUNS.filter((n) => all.has(sing(n))), heads: [...spec.heads.keys()].sort(), bare: [...spec.bare].sort(), inputs };
}
const jacc = (a: string[], b: string[]) => { const A = new Set(a), B = new Set(b); const i = [...A].filter((x) => B.has(x)).length; const u = new Set([...A, ...B]).size; return u ? i / u : 1; };
/** Structural similarity of two signatures in [0,1]: title tokens, nouns, answer heads (exact head set weighs most: the
 *  grammar is the strongest sign of "the same workflow"), bare shapes and inputs. */
export function similarity(a: Signature, b: Signature): number {
  const heads = a.heads.length || b.heads.length ? (a.heads.join() === b.heads.join() ? 1 : jacc(a.heads, b.heads)) : jacc(a.bare, b.bare);
  return 0.35 * heads + 0.3 * jacc(a.title, b.title) + 0.2 * jacc(a.nouns, b.nouns) + 0.15 * jacc(a.inputs, b.inputs);
}
export const MATCH_MIN = Number(process.env.AGENT_LEARN_MATCH_MIN ?? 0.75);

export class ProcedureLibrary {
  lib: Library;
  constructor(lib?: Library) { this.lib = lib ?? { version: 1, builtAt: new Date().toISOString(), weights: { ...DEFAULT_WEIGHTS }, policy: { ...DEFAULT_POLICY }, minP: { canary: 0.8, on: 0.6 }, procedures: [] }; }
  get weights(): Weights { return this.lib.weights; }
  get policy(): Policy { return this.lib.policy; }
  /** The procedure for a memo: the best structural match at or above MATCH_MIN, else a new candidate (source "shift"). */
  forSpec(spec: WfSpec, now = new Date().toISOString()): { proc: Procedure; matched: number | null } {
    const sig = signatureOf(spec);
    let best: Procedure | null = null, bs = 0;
    for (const p of this.lib.procedures) { const s = similarity(sig, p.signature); if (s > bs) { bs = s; best = p; } }
    if (best && bs >= MATCH_MIN) { best.updatedAt = now; return { proc: best, matched: +bs.toFixed(3) }; }
    const proc: Procedure = { id: idOf(sig, this.lib.procedures.length), title: spec.title, signature: sig, status: "candidate", plan: null, planStatus: undefined, policy: { ...this.lib.policy }, verification: [], calibration: { ...this.lib.weights }, stats: emptyStats(), createdAt: now, updatedAt: now, source: "shift" };
    this.lib.procedures.push(proc);
    return { proc, matched: null };
  }
  byId(id: string): Procedure | undefined { return this.lib.procedures.find((p) => p.id === id); }
  /** Serialisable snapshot (the shift-end `library` event; plans included so a log can rebuild library.json). */
  snapshot(): Library { return JSON.parse(JSON.stringify(this.lib)); }
}
const idOf = (sig: Signature, n: number) => (sig.title.slice(0, 3).join("-") || sig.heads.slice(0, 2).join("-").toLowerCase() || "wf") + "-" + String(n + 1).padStart(2, "0");

/** The library the image carries: AGENT_LEARN_LIBRARY (a path) else learn/library.json next to this file; a missing or
 *  unreadable file gives an empty library with the default weights (never a crash). */
export function loadLibrary(path?: string): ProcedureLibrary {
  const p = path ?? process.env.AGENT_LEARN_LIBRARY ?? new URL("./library.json", import.meta.url).pathname;
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as Library;
    if (j?.version !== 1 || !Array.isArray(j.procedures)) throw new Error("not a library");
    j.weights = { ...DEFAULT_WEIGHTS, ...(j.weights ?? {}) }; j.policy = { ...DEFAULT_POLICY, ...(j.policy ?? {}) }; j.minP = { ...{ canary: 0.8, on: 0.6 }, ...(j.minP ?? {}) } as Library["minP"];
    for (const q of j.procedures) { q.stats = { ...emptyStats(), ...(q.stats ?? {}) }; q.calibration = { ...j.weights, ...(q.calibration ?? {}) }; q.verification ??= []; q.source = "baked"; }
    return new ProcedureLibrary(j);
  } catch { return new ProcedureLibrary(); }
}

// ── confidence ──
const sigm = (x: number) => 1 / (1 + Math.exp(-x));
/** Estimated precision of an answer from its signals under the weights. Unknown (null) signals add nothing; a failed
 *  example or a dissenting run pulls hard (the asymmetric objective: a wrong answer costs what a right one earns). */
export function estimatePrecision(s: Signals, w: Weights): number {
  let z = w.bias;
  if (s.agree === true) z += w.agree; z += w.voters * Math.max(0, Math.min(3, s.voters) - 1);
  if (s.dissent) z += w.dissent;
  if (s.grounded === true) z += w.grounded; else if (s.grounded === false) z -= w.grounded;
  if (s.complete === true) z += w.complete; else if (s.complete === false) z -= w.complete;
  if (s.example === true) z += w.example; else if (s.example === false) z += w.exampleFail;
  if (s.format) z += w.format; else z -= 2 * w.format;
  if (s.applies === true) z += w.applies; else if (s.applies === false) z -= 8;
  if (s.plan) z += w.plan; if (s.live) z += w.live;
  return +sigm(z).toFixed(4);
}
/** Signals of a vote-procedure decision (workflowExec votes + the gather's proofs + the example gate). */
export function signalsOfVotes(v: { votes: Array<{ answer: string | null; grounded: boolean; applies: boolean | null }>; answer: string | null; formatOk: boolean; exampleOk: boolean | null; complete: boolean | null }): Signals {
  const answered = v.votes.filter((x) => x.answer != null);
  const voters = answered.filter((x) => x.answer === v.answer).length;
  const distinct = new Set(answered.map((x) => x.answer)).size;
  return { agree: v.answer == null ? null : voters >= 2, voters, dissent: distinct > 1, grounded: answered.length ? answered.filter((x) => x.answer === v.answer).every((x) => x.grounded) : null,
    complete: v.complete, example: v.exampleOk, format: v.formatOk, applies: v.votes.some((x) => x.applies === false) ? false : v.votes.some((x) => x.applies === true) ? true : null, plan: false, live: false };
}
/** Fold a second, independent derivation (the Plan executor over a live World) into the signals. */
export function withPlan(s: Signals, plan: { answer: string | null; complete: boolean; live: boolean }, voteAnswer: string | null): Signals {
  if (plan.answer == null) return s;
  const agree = voteAnswer != null ? plan.answer === voteAnswer : s.agree;
  return { ...s, plan: true, live: plan.live, complete: s.complete === null ? plan.complete : s.complete && plan.complete, agree, dissent: s.dissent || (voteAnswer != null && plan.answer !== voteAnswer), voters: s.voters + 1 };
}

// ── stats / status transitions ──
export const RETIRE_AFTER = Number(process.env.AGENT_LEARN_RETIRE_AFTER ?? 2);
export function noteVerification(p: Procedure, v: Verification): Status {
  p.verification.push(v); p.updatedAt = v.at;
  if (v.candidate === "plan") {
    if (v.ok) { p.planStatus = "verified"; if (p.status === "candidate") p.status = "verified"; }
    else { p.stats.exampleFailures++; p.planStatus = p.stats.exampleFailures >= RETIRE_AFTER ? "retired" : "demoted"; }
  } else if (v.ok) { if (p.status === "candidate") p.status = "verified"; }
  else { p.stats.exampleFailures++; p.status = p.stats.exampleFailures >= RETIRE_AFTER ? "retired" : "demoted"; p.stats.demotions++; }
  return p.status;
}
export function noteOutcome(p: Procedure, o: { answered: boolean; agree: boolean | null; failure?: boolean; ms: number; at: string }): void {
  p.stats.attempts++; p.stats.msTotal += o.ms; p.updatedAt = o.at;
  if (o.answered) p.stats.answered++;
  if (o.agree === true) p.stats.agreements++; else if (o.agree === false) p.stats.disagreements++;
  if (o.failure) { p.stats.failures++; p.stats.demotions++; if (p.status === "verified") p.status = "demoted"; }
}
/** Rule-of-three precision bound the procedure has earned so far: (wrong + 3) / answered (LESSONS.md §C.5); null before any answer. */
export const boundOf = (p: Procedure): number | null => p.stats.answered ? +((p.stats.disagreements + 3) / p.stats.answered).toFixed(3) : null;
