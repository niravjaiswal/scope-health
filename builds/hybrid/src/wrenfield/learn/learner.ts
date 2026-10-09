/**
 * Within-shift learner — the agent learns a procedure per workflow memo WHILE the shift runs, from the only ground truth a
 * hidden shift offers: the memo's worked example(s) and self-checks (independent derivations agreeing, quoted evidence,
 * completeness proofs, the memo's answer grammar). It never routes (wfShadow.wfFor / the Jev router do) and never writes a
 * model-driven answerer (the executor's votes are one derivation, the Plan executor the other).
 *
 *  message acknowledged  → `onMessage`: the memo's procedure is looked up in the library (structural signature) or created;
 *                          candidate Plans are compiled in the background (solver/compile.ts: two writers, validator, the
 *                          worked example reproduced on the example's text facts, mutation agreement) under the spend
 *                          governor and the pacer's slack; the vote procedure's example gate is wfShadow's (already eager).
 *  task routed to a memo → `onTask`: the executor's votes (wfExecuteDetail's detail) are derivation 1; a Plan the library
 *                          holds for the memo is derivation 2 — first verified LIVE on the memo's own worked example (inputs
 *                          extracted, the World read from this site through the toolkit with completeness proofs, the
 *                          executor's answer must equal the stated one), then run on the task. Signals → estimated precision
 *                          (procedures.estimatePrecision with the procedure's calibration) → the harness decides.
 *  verification failure  → demote; two failures of its own example → retire the Plan and recompile ONCE with the failure as a
 *                          counter-example (the executor's live trace, never the expected answer, per LESSONS.md §A).
 * Budget: never without pacer slack (pacer.extraOk), never in the last AGENT_LEARN_RESERVE_S (120) s, text spend through
 * failover.chat's spend gate; per-task cap AGENT_LEARN_TASK_S (15), compile cap AGENT_LEARN_COMPILE_S (240) in the
 * background class. Every step is one `{"event":"learn"}` line (kind: message | compile | verify | task | recompile | retire).
 */
import { chat, isListed, maxInFlight } from "../failover.js";
import { transportExtras, type WfSpec } from "../workflowExec.js";
import { pacer } from "../pacer.js";
import * as spend from "../spend.js";
import type { ClinicIndex } from "../inference.js";
import type { WfDetail } from "../wfShadow.js";
import { compileVerified, runOnExample, hardcoded, type Verdict } from "../solver/verify.js";
import { writePlan, extractInputs, type Caller } from "../solver/compile.js";
import { workedExample, ruleText, type WorkedExample } from "../solver/example.js";
import { runPlan, type World } from "../solver/exec.js";
import type { Plan } from "../solver/plan.js";
import { answerFormOk } from "../solver/index.js";
import { Toolkit } from "../solver/toolkit.js";
import { fillWorld } from "../solver/world.js";
import { ProcedureLibrary, loadLibrary, signalsOfVotes, withPlan, estimatePrecision, noteVerification, noteOutcome, boundOf, type Procedure, type Signals, type Verification } from "./procedures.js";
import { learnMode, learnHarness, type Harness } from "./harness.js";

const num = (k: string, d: number) => { const n = Number(process.env[k]); return Number.isFinite(n) && n >= 0 ? n : d; };
const now = () => new Date().toISOString();
const log = (rec: Record<string, unknown>) => { try { process.stdout.write(JSON.stringify({ event: "learn", ...rec }) + "\n"); } catch {} };
/** What the learner compiles: "votes" (the executor's vote procedure only: no compile calls), "plan" (declarative Plans
 *  through the solver compiler), "both" (default when learning is on). */
const compileKind = (): "votes" | "plan" | "both" => { const k = (process.env.AGENT_LEARN_COMPILE ?? "both").toLowerCase(); return k === "votes" || k === "plan" ? k : "both"; };

export type Learned = { answer: string | null; p: number; signals: Signals; procedure: string; why: string; ms: number; derivations: { votes: string | null; plan: string | null } };

/** Background-class caller for the compiler: bounded wait, the spend gate inside chat, `reasoning: low` for gemini / gpt. */
const bgCaller = (waitMs: number): Caller => async (messages, model, opts) => {
  const j: any = await chat({ messages, temperature: opts.temperature ?? 0, max_tokens: opts.maxTokens ?? 8000, ...transportExtras(model) }, { primary: model, fallbacks: [], attempts: 2, waitMs, cls: "background" });
  return j?.choices?.[0]?.message?.content ?? null;
};
/** Compiler models: SOLVER_PLAN_MODELS, else the measured sonnet pair, else what is listed (two different families when possible). */
function planModels(): [string, string] | null {
  const env = (process.env.SOLVER_PLAN_MODELS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (env.length >= 2 && env.every(isListed)) return [env[0], env[1]];
  const pref = ["anthropic/claude-sonnet-5.5", "anthropic/claude-haiku-5.5", "google/gemini-3.8-flash"].filter(isListed);
  if (pref.length >= 2) return [pref[0], pref[1]]; if (pref.length === 1) return [pref[0], pref[0]];
  return null;
}
const inputModel = () => ["anthropic/claude-haiku-5.5", "google/gemini-3.8-flash", "anthropic/claude-haiku-4.5"].find(isListed) ?? null;

export class Learner {
  lib: ProcedureLibrary;
  private compiling: Promise<void> | null = null;
  private verdicts = new Map<string, Verdict>();      // procedure id → the compile verdict (its example world feeds recompiles)
  private liveChecked = new Set<string>();           // procedure ids whose Plan was checked live this shift
  stats = { messages: 0, compiles: 0, compiled: 0, verifiedLive: 0, tasks: 0, planRuns: 0, planAnswers: 0, agreements: 0, disagreements: 0, recompiles: 0 };
  constructor(lib?: ProcedureLibrary, public harness: Harness = learnHarness) { this.lib = lib ?? loadLibrary(); }

  /** A workflow memo was acknowledged. Off the hot path: a message item has no browsing; the compile runs in the background. */
  onMessage(spec: WfSpec, order: number, later: string[] = []): Procedure | null {
    if (learnMode() === "off") return null;
    this.stats.messages++;
    const { proc, matched } = this.lib.forSpec(spec);
    log({ kind: "message", order, procedure: proc.id, matched, status: proc.status, plan: proc.plan ? proc.planStatus : null, title: spec.title });
    if (compileKind() !== "votes" && !proc.plan && proc.planStatus !== "retired" && spec.example) this.scheduleCompile(proc, spec, later);
    return proc;
  }

  private scheduleCompile(proc: Procedure, spec: WfSpec, later: string[]): void {
    const run = async () => {
      const models = planModels(); const im = inputModel();
      if (!models || !im) return log({ kind: "compile", procedure: proc.id, skipped: "no compiler models listed" });
      const est = num("AGENT_LEARN_COMPILE_USD", 0.3);
      if (!spend.allow("text", est)) return log({ kind: "compile", procedure: proc.id, skipped: "spend governor", spent: +spend.state.total.usd.toFixed(3), line: +spend.lineUsd().toFixed(2) });
      // an endpoint that answered 429 at 2 in flight (the practice proxy: failover's learned cap = 1) has no slot a background
      // compile could use without holding a reader's: practice t2454f368aa69 held a message 8.3 s (0.9 s before) while the
      // compile's sonnet call sat in the one slot. The scored sets' proxies never capped (0 x 429 in the 278 / 265 logs).
      if (maxInFlight() <= 1) return log({ kind: "compile", procedure: proc.id, skipped: "endpoint at 1 in flight (learned 429 cap)", limit: maxInFlight() });
      const capS = num("AGENT_LEARN_COMPILE_S", 240); const t0 = Date.now(); this.stats.compiles++;
      log({ kind: "compile", procedure: proc.id, start: true, models, capS });
      const raw = [spec.raw, ...later].join("\n\n");
      const v = await Promise.race([
        compileVerified(spec.raw, { planModels: models, worldModel: models[0], inputModel: im, caller: bgCaller(90000), mutations: num("AGENT_LEARN_MUTATIONS", 20) }).catch((e) => ({ title: spec.title, ok: false, reason: "compile threw: " + String(e).slice(0, 120) } as Verdict)),
        new Promise<Verdict>((r) => setTimeout(() => r({ title: spec.title, ok: false, reason: `compile cap ${capS} s` }), capS * 1000)),
      ]);
      void raw;
      this.verdicts.set(proc.id, v);
      const ex = v.example;
      // a compile that never got a model reply (transport: 401 / 402 / timeout / cap) is no verdict on the plan: level "none",
      // not an example failure (practice run learn-shadow-loop-1: an expired key would otherwise have retired every procedure)
      const transport = !v.ok && /not JSON|compile cap|threw|no reply|input extraction failed/i.test(v.reason);
      const ver: Verification = { candidate: "plan", request: ex?.request ?? spec.example?.request ?? "", want: ex?.answer ?? spec.example?.answer ?? "", got: v.ok ? ex?.answer ?? null : (v.a?.got ?? v.b?.got ?? null), ok: v.ok, level: transport ? "none" : "text", at: now(), ms: Date.now() - t0, why: v.reason };
      if (v.ok && v.plan) { proc.plan = v.plan; proc.planStatus = "candidate"; proc.planSource = `compile ${models.join("+")}`; this.stats.compiled++; proc.verification.push(ver); proc.updatedAt = ver.at; }
      else if (transport) { proc.verification.push(ver); proc.updatedAt = ver.at; }
      else noteVerification(proc, ver);
      log({ kind: "compile", procedure: proc.id, ok: v.ok, reason: v.reason, ms: Date.now() - t0, agree: v.agree, a: v.a?.stage, b: v.b?.stage, planStatus: proc.planStatus ?? null });
    };
    // one compile at a time, in the background; never blocks the queue loop
    this.compiling = (this.compiling ?? Promise.resolve()).then(run).catch(() => {});
  }

  /** One task the executor was routed to a memo for. `exec` = wfExecuteDetail's result (detail present when it ran). */
  async onTask(index: ClinicIndex, task: string, exec: { answer: string | null; why: string; ran: boolean; detail?: WfDetail }, secondsLeft: number): Promise<Learned | null> {
    const d = exec.detail; if (!d || learnMode() === "off") return null;
    const t0 = Date.now(); this.stats.tasks++;
    const { proc } = this.lib.forSpec(d.spec);
    const listPages = d.pages.filter((p) => /list|received|issued|lots|appointments/i.test(p.name));
    const complete = listPages.length ? listPages.every((p) => !!p.proof && !/\(not read/.test(p.name)) : null;
    let signals = signalsOfVotes({ votes: d.votes, answer: d.would, formatOk: d.would != null, exampleOk: d.example.ok, complete });
    const derivations = { votes: d.would, plan: null as string | null };
    let why = exec.answer ? "executor answered" : exec.why;
    // derivation 2: the Plan, when the library holds one for this memo and the shift has the slack for it
    const taskS = num("AGENT_LEARN_TASK_S", 15);
    const planOk = proc.plan && proc.planStatus !== "retired" && compileKind() !== "votes";
    if (planOk && secondsLeft > num("AGENT_LEARN_RESERVE_S", 120) && pacer.extraOk(taskS)) {
      const cr = (index as any).crawler;
      if (cr) {
        const deadline = t0 + taskS * 1000;
        if (!this.liveChecked.has(proc.id)) await this.verifyLive(proc, d.spec, cr, deadline);
        if (proc.plan && proc.planStatus !== "retired" && Date.now() < deadline - 2000) {
          const r = await this.runPlanOn(proc.plan, task, cr, deadline, d.spec.raw);
          this.stats.planRuns++;
          if (r.answer != null) {
            this.stats.planAnswers++; derivations.plan = r.answer;
            signals = withPlan(signals, { answer: r.answer, complete: r.complete, live: true }, d.would);
            if (d.would != null) { if (d.would === r.answer) this.stats.agreements++; else { this.stats.disagreements++; why = `derivations disagree: votes ${d.would} / plan ${r.answer}`; } }
          } else why = exec.answer ? why : `${why}; plan: ${r.why}`;
        }
      }
    }
    // the learned answer: both derivations agree, or the one that answered when the other abstained — never a disputed one
    const answer = derivations.votes != null && derivations.plan != null ? (derivations.votes === derivations.plan ? derivations.votes : null) : derivations.votes ?? derivations.plan;
    const p = answer == null ? 0 : estimatePrecision(signals, proc.calibration);
    const ms = Date.now() - t0;
    noteOutcome(proc, { answered: answer != null, agree: derivations.votes != null && derivations.plan != null ? derivations.votes === derivations.plan : null, failure: derivations.votes != null && derivations.plan != null && derivations.votes !== derivations.plan, ms, at: now() });
    log({ kind: "task", procedure: proc.id, status: proc.status, planStatus: proc.planStatus ?? null, derivations, answer, p, signals, bound: boundOf(proc), ms, why, task: task.replace(/\s+/g, " ").slice(0, 100) });
    return { answer, p, signals, procedure: proc.id, why, ms, derivations };
  }

  /** The Plan on the memo's own worked example, LIVE: the example's inputs → the World read from this site → the executor's
   *  answer must be the stated one. The example's patient may not exist on this site: then the check is "none" (neither pass
   *  nor fail; the text-level verification stands). A failure demotes; the second retires the Plan and triggers one recompile. */
  private async verifyLive(proc: Procedure, spec: WfSpec, cr: any, deadline: number): Promise<void> {
    this.liveChecked.add(proc.id);
    const ex = workedExample(spec.raw) ?? (spec.example ? { request: spec.example.request, answer: spec.example.answer, explanation: "", section: "" } : null);
    if (!ex || !proc.plan) return;
    const t0 = Date.now();
    const r = await this.runPlanOn(proc.plan, ex.request, cr, deadline, spec.raw);
    const level = r.unresolved || /^inputs:/.test(r.why) ? "none" : "live"; // the example's patient not on this site, or no model reply for the inputs: no verdict
    const ok = level === "live" && r.answer != null && r.answer.trim() === ex.answer.trim();
    const v: Verification = { candidate: "plan", request: ex.request, want: ex.answer, got: r.answer, ok, level, at: now(), ms: Date.now() - t0, why: ok ? "" : r.why || `got ${r.answer}` };
    if (level === "none") { proc.verification.push(v); log({ kind: "verify", procedure: proc.id, level, ok: null, why: r.why, ms: v.ms }); return; }
    const st = noteVerification(proc, v); if (ok) this.stats.verifiedLive++;
    log({ kind: "verify", procedure: proc.id, level, ok, got: r.answer, want: ex.answer, why: v.why, planStatus: proc.planStatus, status: st, ms: v.ms });
    if (!ok && proc.planStatus === "retired") await this.recompile(proc, spec, ex, r);
  }

  /** Retired Plan → one recompile with the live failure as a counter-example (the executor's step values on the live World,
   *  never the expected answer); the new Plan must validate, not hardcode the answer and reproduce the example on the text
   *  world before it becomes a candidate (then it is checked live again at the next task). */
  private async recompile(proc: Procedure, spec: WfSpec, ex: WorkedExample, fail: { answer: string | null; why: string; steps?: Record<string, unknown> }): Promise<void> {
    const max = num("AGENT_LEARN_RECOMPILE_MAX", 1);
    if (proc.stats.recompiles >= max || !proc.plan) return;
    const models = planModels(); const im = inputModel(); const verdict = this.verdicts.get(proc.id);
    if (!models || !im || !spend.allow("text", num("AGENT_LEARN_COMPILE_USD", 0.3))) return log({ kind: "recompile", procedure: proc.id, skipped: "no models or spend" });
    proc.stats.recompiles++; this.stats.recompiles++;
    const t0 = Date.now();
    const trace = Object.entries(fail.steps ?? {}).map(([k, v]) => `${k} = ${JSON.stringify(v)?.slice(0, 200)}`).join("\n");
    const issues = [`On the live clinic site, for the message's own worked example request "${ex.request}", the plan ${fail.answer == null ? `declined (${fail.why})` : `answered ${fail.answer}, which is not the example's answer`}.${trace ? ` Executor step values on the live records:\n${trace}` : ""}\nRe-read the rule and fix the plan (data access, field names, filters, rule order, boundaries). Do not hardcode answers.`];
    const w = await writePlan(spec.raw, ex, { model: models[0], temperature: 0.3, caller: bgCaller(90000), repairOf: { plan: proc.plan, issues } }).catch(() => ({ plan: null, issues: ["recompile threw"], raw: null }));
    let ok = false, why = w.issues[0] ?? "";
    if (w.plan && !w.issues.length) {
      const hc = hardcoded(w.plan, ex, ruleText(spec.raw));
      if (hc.length) why = "hardcodes the example answer";
      else if (verdict?.world) { const r = await runOnExample(w.plan, verdict.world, ex, { inputModel: im, caller: bgCaller(60000) }); ok = r.stage === "ok"; why = r.why; }
      else { ok = true; why = "no example world to re-verify on (accepted as candidate; live check pending)"; }
    }
    if (ok && w.plan) { proc.plan = w.plan; proc.planStatus = "candidate"; proc.planSource = `recompile ${models[0]}`; this.liveChecked.delete(proc.id); proc.verification.push({ candidate: "plan", request: ex.request, want: ex.answer, got: ex.answer, ok: true, level: "text", at: now(), ms: Date.now() - t0, why: "recompiled with counter-example" }); }
    log({ kind: "recompile", procedure: proc.id, ok, why, ms: Date.now() - t0, planStatus: proc.planStatus });
  }

  /** inputs (model) → World (toolkit, proofs) → executor → the memo's answer form. `unresolved`: the request's patient is not on this site. */
  private async runPlanOn(plan: Plan, request: string, cr: any, deadline: number, raw: string): Promise<{ answer: string | null; why: string; complete: boolean; unresolved?: boolean; steps?: Record<string, unknown> }> {
    const im = inputModel(); if (!im) return { answer: null, why: "no input model", complete: false };
    const x = await extractInputs(plan, request, { model: im, caller: bgCaller(Math.max(3000, Math.min(12000, deadline - Date.now()))) }).catch((e) => ({ inputs: null, why: String(e).slice(0, 80) }));
    if (!x.inputs) return { answer: null, why: "inputs: " + x.why, complete: false };
    const tk = new Toolkit(cr, (r) => log({ kind: "toolkit", ...r }));
    const w = await fillWorld(tk, plan.needs, x.inputs, { budgetMs: Math.max(2000, deadline - Date.now() - 1000) }).catch((e) => ({ why: String(e).slice(0, 120) }));
    if ("why" in w) return { answer: null, why: "world: " + w.why, complete: false, unresolved: /patient|not found|no row|resolve|namesake|ambiguous/i.test(w.why) };
    const world: World = { ...w.world, inputs: { ...w.world.inputs, ...Object.fromEntries(Object.entries(x.inputs).filter(([k]) => !(k in w.world.inputs))) } };
    const complete = w.provenance.every((p) => p.strength === "page");
    const r = await runPlan(plan, world);
    if (r.answer == null) return { answer: null, why: r.why, complete, steps: r.steps };
    if (!answerFormOk(r.answer, raw)) return { answer: null, why: `answer ${r.answer} is not in the memo's answer form`, complete, steps: r.steps };
    return { answer: r.answer, why: "", complete, steps: r.steps };
  }

  /** Shift end: the library (what was learned) and the learner's funnel. */
  events(): Array<Record<string, unknown>> {
    return [{ event: "learn_summary", mode: learnMode(), compile: compileKind(), ...this.stats, procedures: this.lib.lib.procedures.map((p) => ({ id: p.id, status: p.status, plan: p.planStatus ?? null, attempts: p.stats.attempts, answered: p.stats.answered, agree: p.stats.agreements, disagree: p.stats.disagreements, exampleFailures: p.stats.exampleFailures, bound: boundOf(p) })) },
      { event: "library", library: this.lib.snapshot() }];
  }
}
/** The shift's learner (constructed lazily by shiftMain so a boot without the flag costs nothing). */
let shared: Learner | null = null;
export const learner = (): Learner => (shared ??= new Learner());
export const _resetLearner = () => { shared = null; };
