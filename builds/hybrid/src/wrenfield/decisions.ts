/**
 * Jev (TypeSafe's System One decision model) through the shift's proxy — the same transport as every other model call.
 *
 * Jev is not a chat model: it takes `state` (text or JSON) and typed `questions` and returns typed answers with
 * probabilities (no prose, no reasoning). Three primitives:
 *   choice  which one of these options?        → {choice, confidence, probabilities: {option: p}}
 *   noul    does this condition hold?          → {noul: p(yes)}
 *   score   where on this ordered scale?       → {score, confidence, probabilities: {"0": p, …}, legend}
 * Model `typesafe/jev-1.13` (alias `~typesafe/jev-latest`), 32K context, $0.042/M input, output free, ~200–300 ms.
 *
 * Endpoint (probed 2026-10-08 against OpenRouter with our key, see JEV-ROUTER.md): OpenRouter serves the SAME request
 * and response shape at POST /api/v1/systemone (the TypeSafe SDK path, which the organisers whitelisted on the proxy as
 * POST $LLM_BASE_URL/systemone) and at POST /api/alpha/decisions. Body {model, state, questions}; the model may be written
 * `typesafe/jev-1.13` or bare `jev-1.13`; an extra `usage: {include: true}` is tolerated; the reply always carries
 * `usage: {input_tokens, output_tokens, cost}`. So the client posts `${LLM_BASE_URL}/${AGENT_DECISIONS_PATH ?? "systemone"}`
 * (AGENT_DECISIONS_URL overrides the whole URL for a local bench against OpenRouter's alpha path).
 *
 * Transport: failover.chat with the call's own path — the same request slots (text class), hard client-side timeout
 * (AGENT_HARD_TIMEOUT_TEXT_MS, 15 s), learned 429 concurrency cap, 402 → shift exhausted, spend-governor accounting
 * (usage.cost; estimate from the body when a leg fails) and one {"event":"llm"} line per leg. Jev has no fallback model:
 * the chain is pinned (fallbacks: []), a hung call is hedged on the same model. Every call also logs
 * {"event":"llm","kind":"decision", …} with the question types, token usage and cost — never the state.
 *
 * Fail closed: any transport error, HTTP error, malformed or incomplete reply → null (the caller treats it as unknown).
 */
import { chat, lastCause } from "./failover.js";

export const DECISION_MODEL = (): string => process.env.AGENT_DECISION_MODEL ?? "typesafe/jev-1.13";
const PATH = (): string => process.env.AGENT_DECISIONS_URL ?? (process.env.AGENT_DECISIONS_PATH ?? "systemone").replace(/^\/+/, "");
/** Hard budget of one decision call (ms): under the text hard timeout so a hung call frees its slot first. */
const WAIT_MS = (): number => { const n = Number(process.env.AGENT_DECISION_WAIT_MS); return Number.isFinite(n) && n > 0 ? n : 14000; };

export type ChoiceQ = { type: "choice"; instructions: string; criteria: Record<string, string> };
export type NoulQ = { type: "noul"; instructions: string; criteria?: { true: string; false: string } };
export type ScoreQ = { type: "score"; instructions: string; criteria: string[] };
export type Question = ChoiceQ | NoulQ | ScoreQ;
export type ChoiceA = { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> };
export type NoulA = { type: "noul"; noul: number };
export type ScoreA = { type: "score"; score: number; confidence: number; probabilities: Record<string, number>; legend: Record<string, string> };
export type Answer = ChoiceA | NoulA | ScoreA;
export type Decision = { answers: Record<string, Answer>; usage: { input_tokens: number; output_tokens: number; cost: number }; model: string; ms: number };

/** State as Jev sees it: a string is sent as is; an object / array as JSON (Jev references nested fields). */
export type State = string | Record<string, unknown> | unknown[];

const log = (rec: Record<string, unknown>) => { try { process.stderr.write(JSON.stringify({ event: "llm", kind: "decision", ...rec }) + "\n"); } catch {} };
const prob = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) && x >= -1e-9 && x <= 1 + 1e-9 ? Math.min(1, Math.max(0, x)) : null);

/** Validate one answer against its question: wrong type, a choice outside the options, a probability that is not a
 *  number in [0, 1] → null (the whole decision is then dropped: a half-valid reply is not acted on). */
function parseAnswer(q: Question, a: any): Answer | null {
  if (!a || typeof a !== "object") return null;
  if (q.type === "choice") {
    if (a.type !== "choice" || typeof a.choice !== "string" || !(a.choice in q.criteria)) return null;
    const probabilities: Record<string, number> = {};
    for (const k of Object.keys(q.criteria)) { const p = prob(a.probabilities?.[k] ?? 0); if (p === null) return null; probabilities[k] = p; }
    const confidence = prob(a.confidence); if (confidence === null) return null;
    return { type: "choice", choice: a.choice, confidence, probabilities };
  }
  if (q.type === "noul") { const p = prob(a.noul); return a.type === "noul" && p !== null ? { type: "noul", noul: p } : null; }
  if (a.type !== "score" || typeof a.score !== "number" || !Number.isFinite(a.score)) return null;
  const probabilities: Record<string, number> = {}; const legend: Record<string, string> = {};
  for (let i = 0; i < q.criteria.length; i++) { const p = prob(a.probabilities?.[String(i)] ?? 0); if (p === null) return null; probabilities[String(i)] = p; legend[String(i)] = String(a.legend?.[String(i)] ?? q.criteria[i]); }
  const confidence = prob(a.confidence); if (confidence === null) return null;
  return { type: "score", score: a.score, confidence, probabilities, legend };
}

/**
 * One decision request: `state` + typed `questions` → every answer validated, or null on any failure.
 * `cls` background = only when no reader / text call waits for a slot (the eager, off-hot-path uses).
 */
export async function decide(state: State, questions: Record<string, Question>, opts: { cls?: "text" | "background"; waitMs?: number; model?: string; tag?: string } = {}): Promise<Decision | null> {
  const model = opts.model ?? DECISION_MODEL();
  const keys = Object.keys(questions); if (!keys.length) return null;
  const types = keys.map((k) => questions[k].type).join(",");
  const t0 = Date.now();
  // the body never carries `model`: failover.launch sets it per leg (chain pinned to this one model)
  const body: Record<string, unknown> = { state, questions };
  let j: any = null; let cause = "";
  try {
    j = await chat(body, { primary: model, fallbacks: [], attempts: 2, waitMs: opts.waitMs ?? WAIT_MS(), cls: opts.cls ?? "text", path: PATH(), onFail: (c) => { cause = c; } });
  } catch (e) { cause = String(e).slice(0, 80); j = null; }
  const ms = Date.now() - t0;
  if (!j) { log({ model, tag: opts.tag, types, ok: false, cause: cause || lastCause || "no reply", ms }); return null; }
  const answers: Record<string, Answer> = {};
  for (const k of keys) { const a = parseAnswer(questions[k], j.answers?.[k]); if (!a) { log({ model, tag: opts.tag, types, ok: false, cause: `malformed answer "${k}"`, ms }); return null; } answers[k] = a; }
  const u = j.usage ?? {};
  const usage = { input_tokens: Number(u.input_tokens) || 0, output_tokens: Number(u.output_tokens) || 0, cost: Number(u.cost) || 0 };
  log({ model: String(j.model ?? model), tag: opts.tag, types, ok: true, ms, inputTokens: usage.input_tokens, usd: +usage.cost.toFixed(6) });
  return { answers, usage, model: String(j.model ?? model), ms };
}

export type Choice = { choice: string; confidence: number; probabilities: Record<string, number>; usage: Decision["usage"]; ms: number };
/** Which one of `options` ({key: description}) applies to `state`? null = unknown (never a guess). */
export async function choose(state: State, instructions: string, options: Record<string, string>, opts: Parameters<typeof decide>[2] = {}): Promise<Choice | null> {
  if (Object.keys(options).length < 2) return null;
  const d = await decide(state, { q: { type: "choice", instructions, criteria: options } }, opts); if (!d) return null;
  const a = d.answers.q as ChoiceA; return { choice: a.choice, confidence: a.confidence, probabilities: a.probabilities, usage: d.usage, ms: d.ms };
}
/** Does the condition hold for `state`? → p(yes) in [0, 1], null = unknown. `criteria` spell out yes / no. */
export async function holds(state: State, instructions: string, criteria?: { true: string; false: string }, opts: Parameters<typeof decide>[2] = {}): Promise<number | null> {
  const d = await decide(state, { q: { type: "noul", instructions, ...(criteria ? { criteria } : {}) } }, opts); if (!d) return null;
  return (d.answers.q as NoulA).noul;
}
export type Rating = { score: number; confidence: number; probabilities: Record<string, number>; legend: Record<string, string>; usage: Decision["usage"]; ms: number };
/** Where on the ordered `levels` (first = index 0) does `state` fall? null = unknown. */
export async function rate(state: State, instructions: string, levels: string[], opts: Parameters<typeof decide>[2] = {}): Promise<Rating | null> {
  if (levels.length < 2) return null;
  const d = await decide(state, { q: { type: "score", instructions, criteria: levels } }, opts); if (!d) return null;
  const a = d.answers.q as ScoreA; return { score: a.score, confidence: a.confidence, probabilities: a.probabilities, legend: a.legend, usage: d.usage, ms: d.ms };
}

/** Test hook: parse a raw reply the way `decide` does (no transport). */
export const _parseAnswer = parseAnswer;
