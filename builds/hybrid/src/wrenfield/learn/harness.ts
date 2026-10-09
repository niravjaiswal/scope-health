/**
 * Safe harness for learned / best-effort answer tiers — the one place that decides whether an answer a NON-deterministic
 * path produced may be sent. Small on purpose so other tiers (the learner here, the best-effort answerer of
 * s2 best-effort, the fast-routed executor) import it instead of re-implementing the budget.
 *
 *  (a) a tier can only fire for a task NO deterministic family claimed: `consider` refuses when `family` is set, whatever
 *      the mode (Set 1 is protected by construction: every Set 1 task has a family; learn-test asserts it over the
 *      169-task union of the 162/164 runs and the 185 answers of the S1 run);
 *  (b) SHADOW (AGENT_LEARN=shadow): the would-be answer is logged, never sent (Set 1 / practice runs, graded afterwards by
 *      bench/learn/grade-shadow.mjs against the known-correct answers);
 *  (c) CANARY (AGENT_LEARN=canary, AGENT_LEARN_BUDGET=N, AGENT_LEARN_MIN_P=0.8): at most N sent answers per shift from the
 *      tier, each with estimated precision ≥ MIN_P;
 *  (d) ON (AGENT_LEARN=on): unbounded count, still ≥ AGENT_LEARN_MIN_P_ON (default 0.6: the asymmetric +1/−1/0 objective
 *      makes an answer worth sending only when p > 0.5; the margin pays for calibration error);
 *  default OFF. Never in the last AGENT_LEARN_RESERVE_S (120) seconds of the shift, never on a pacer skip.
 * Every decision is one `{"event":"learn_decision"}` line: tier, mode, task head, answer, p, signals, sent / why not.
 */
import type { Signals } from "./procedures.js";

export type LearnMode = "off" | "shadow" | "canary" | "on";
export const learnMode = (): LearnMode => { const m = (process.env.AGENT_LEARN ?? "off").toLowerCase(); return m === "shadow" || m === "canary" || m === "on" ? m : "off"; };
const num = (k: string, d: number) => { const n = Number(process.env[k]); return Number.isFinite(n) ? n : d; };

export type Consider = { tier: string; task: string; family: string | null; answer: string | null; p: number; signals?: Partial<Signals>; secondsLeft: number; pacerSkipped?: boolean; procedure?: string; why?: string; ms?: number };
export type Decision = { send: boolean; mode: LearnMode; why: string; p: number; minP: number };

export class Harness {
  sent = 0; considered = 0; wouldSend = 0; refused: Record<string, number> = {};
  constructor(public name = "learn", private minPCanary = num("AGENT_LEARN_MIN_P", 0.8), private minPOn = num("AGENT_LEARN_MIN_P_ON", 0.6), private budget = num("AGENT_LEARN_BUDGET", 5), private reserveS = num("AGENT_LEARN_RESERVE_S", 120)) {}
  /** The mode-specific precision floor. */
  minP(mode = learnMode()): number { return mode === "on" ? this.minPOn : this.minPCanary; }
  /** Decide and log. The caller sends `answer` only when `send` is true. */
  consider(c: Consider, mode = learnMode()): Decision {
    this.considered++;
    const minP = this.minP(mode);
    const base = { mode, p: c.p, minP };
    const refuse = (why: string, code: string): Decision => { this.refused[code] = (this.refused[code] ?? 0) + 1; return this.log(c, { send: false, why, ...base }); };
    if (mode === "off") return refuse("learn tier off", "off");
    if (c.family) return refuse(`family ${c.family} claimed the task: deterministic path only`, "family"); // (a) — before anything else
    if (c.answer == null) return refuse(c.why ? "no answer: " + c.why : "no answer", "none");
    if (c.pacerSkipped) return refuse("pacer skipped the task", "pacer");
    if (c.secondsLeft < this.reserveS) return refuse(`last ${this.reserveS} s of the shift`, "reserve");
    const confident = c.p >= minP;
    if (confident) this.wouldSend++;
    if (mode === "shadow") return refuse(confident ? "shadow: would send" : `shadow: would not send (p ${c.p} < ${minP})`, confident ? "shadow-would" : "shadow-low");
    if (!confident) return refuse(`p ${c.p} < ${minP}`, "lowp");
    if (mode === "canary" && this.sent >= this.budget) return refuse(`canary budget ${this.budget} spent`, "budget");
    this.sent++;
    return this.log(c, { send: true, why: mode === "canary" ? `canary ${this.sent}/${this.budget}` : "on", ...base });
  }
  private log(c: Consider, d: Decision): Decision {
    try { process.stdout.write(JSON.stringify({ event: "learn_decision", tier: c.tier, harness: this.name, mode: d.mode, sent: d.send, why: d.why, p: c.p, minP: d.minP, answer: c.answer, procedure: c.procedure, family: c.family, signals: c.signals, ms: c.ms, secondsLeft: Math.round(c.secondsLeft), task: c.task.replace(/\s+/g, " ").slice(0, 120) }) + "\n"); } catch {}
    return d;
  }
  /** Shift-end summary (one `learn_harness` line). */
  summary(): Record<string, unknown> { return { event: "learn_harness", harness: this.name, mode: learnMode(), considered: this.considered, wouldSend: this.wouldSend, sent: this.sent, budget: this.budget, minP: this.minP(), refused: this.refused }; }
}
/** The shift's harness for learned procedures (the learner and shiftMain share it). */
export const learnHarness = new Harness("learn");
