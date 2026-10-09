/**
 * Entry points for the live agent (hooks for the toolkit / executor branches). Nothing here is wired into
 * the shift yet: a caller does
 *   const c = await compileWorkflow(messageText);            // once per workflow message, off the hot path
 *   if (c.plan) { const r = await solveTask(c, taskText, toolkit); if (r.answer && solverMode() === "on") send(r.answer); }
 * Mode: AGENT_SOLVER = off | shadow (default) | on. Deterministic families keep every task they take.
 */
import { compileVerified, type Verdict } from "./verify.js";
import { extractInputs, modelClassifier, type Caller } from "./compile.js";
import { runPlan, type World, type Classifier } from "./exec.js";
import type { Plan } from "./plan.js";
import { parseWorkflowSpec, matchesTokenFormat } from "../workflowExec.js";

export type SolverMode = "off" | "shadow" | "on";
export const solverMode = (): SolverMode => { const m = (process.env.AGENT_SOLVER ?? "shadow").toLowerCase(); return m === "on" || m === "off" ? m : "shadow"; };

export type Compiled = { message: string; plan: Plan | null; why: string; verdict: Verdict };
/** What the live toolkit provides: read the site into a World for this plan's `needs`, for one task. */
export type Toolkit = { world(plan: Plan, inputs: Record<string, unknown>): Promise<{ world: World | null; why: string }>; classify?: Classifier };

const MODELS = () => ({
  plan: (process.env.SOLVER_PLAN_MODELS ?? "anthropic/claude-sonnet-5.5,anthropic/claude-sonnet-5.5").split(",") as [string, string],
  world: process.env.SOLVER_WORLD_MODEL ?? "anthropic/claude-sonnet-5.5",
  input: process.env.SOLVER_INPUT_MODEL ?? "anthropic/claude-haiku-5.5",
});
const cache = new Map<string, Promise<Compiled>>();

/** message → verified Plan (memoised per message text). */
export function compileWorkflow(message: string, o: { caller?: Caller; world?: World } = {}): Promise<Compiled> {
  let p = cache.get(message);
  if (!p) {
    const m = MODELS();
    p = compileVerified(message, { planModels: m.plan, worldModel: m.world, inputModel: m.input, caller: o.caller, world: o.world, classify: modelClassifier([m.input, m.plan[0]], o.caller) })
      .then((v) => ({ message, plan: v.ok ? v.plan ?? null : null, why: v.reason, verdict: v }))
      .catch((e) => ({ message, plan: null, why: "compile crashed: " + (e as Error).message, verdict: { title: "", ok: false, reason: "crash" } }));
    cache.set(message, p);
  }
  return p;
}

const shape = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) ? "date" : /^-?\d+\.\d{2}$/.test(s) ? "amount" : /^\d+$/.test(s) ? "int" : "text";
/** The answer is in one of the message's forms: a token head of its table (workflowExec's gate), or a bare
 *  value shaped like one of the message's own backticked bare examples (`2026-11-20`, `7`, `42.50`). */
export function answerFormOk(ans: string, message: string): boolean {
  const spec = parseWorkflowSpec(message);
  if (spec && matchesTokenFormat(ans, spec)) return true;
  if (/^[A-Z][A-Z0-9_]+(:|$)/.test(ans)) return false;
  const bare = [...message.matchAll(/`([^`\n]{1,40})`/g)].map((m) => m[1]).filter((t) => !/^[A-Z][A-Z0-9_]+(:|$)/.test(t) && shape(t) !== "text");
  return bare.some((t) => shape(t) === shape(ans)) || (shape(ans) === "text" && /answer with the name|as the (?:note|letter|page) (?:writes|prints) it/i.test(message));
}

/** One task under a compiled workflow: inputs → toolkit World → executor → answer-form gate. */
export async function solveTask(c: Compiled, task: string, tk: Toolkit, o: { caller?: Caller } = {}): Promise<{ answer: string | null; why: string }> {
  if (!c.plan) return { answer: null, why: "no verified plan: " + c.why };
  const x = await extractInputs(c.plan, task, { model: MODELS().input, caller: o.caller });
  if (!x.inputs) return { answer: null, why: x.why };
  // An input the task doesn't give stays null: the plan's own logic decides (null on the answer path → skip).
  const w = await tk.world(c.plan, x.inputs);
  if (!w.world) return { answer: null, why: "toolkit: " + w.why };
  const r = await runPlan(c.plan, { ...w.world, inputs: x.inputs }, { classify: tk.classify });
  if (r.answer === null) return { answer: null, why: r.why };
  if (!answerFormOk(r.answer, c.message)) return { answer: null, why: `answer ${r.answer} is not in the message's answer form` };
  return { answer: r.answer, why: "" };
}
