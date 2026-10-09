/**
 * Model spend governor. The judge gives each shift a fixed model spend ($8 Set 1 / Set 2, $15 Set 3, $1 practice —
 * `arena sets`); once it is used up the endpoint answers 402 cost_cap_reached to EVERY later request, which would also
 * end the deterministic families' image reads (lab / remittance / outside record / referral). The cap is not in the
 * container's environment (reference-agent/contracts agentProtocol.ts), so it is derived from SHIFT_SECONDS
 * (900 → $8, 1200 → $1 practice, 1800 → $15; AGENT_SPEND_CAP_USD overrides) and every request is accounted here:
 *
 *  - cost per call from the response `usage` (`usage.cost` when the proxy passes OpenRouter's accounting through —
 *    failover.ts asks for it with `usage: {include: true}` — else prompt/completion tokens × the price table below),
 *    or a conservative estimate from the request body when no usage came back (a failed or abandoned leg may still be
 *    charged); every figure × AGENT_SPEND_SAFETY (1.1);
 *  - the last AGENT_SPEND_RESERVE_FRAC (25 %) of the cap is reserved for the deterministic families' image reads: a
 *    TEXT call (executor votes, gather, compile, generalist) may start only while spent + its estimate stays under the
 *    reserve line; image reads are never gated here (a 402 is their terminal signal, handled by failover/labRead);
 *  - the executor stops taking tasks when its projected per-task spend (measured EMA, prior AGENT_WF_TASK_USD) would
 *    cross the line (wfShadow.wfExecuteDetail), and prefers its cheaper vote models while text spend runs ahead of the
 *    pace of the shift (wfRunModels: sonnet dropped, haiku-5.5 + gemini kept — wfEval offline 108 right / 2 wrong);
 *  - one `{"event":"spend"}` line per queue item (shiftMain): the item's and the shift's spend by class, cap, line,
 *    pace and the governor's decisions, so a Set 1 log audits the accounting.
 */
const num = (k: string, d: number) => { const n = Number(process.env[k]); return Number.isFinite(n) && n >= 0 ? n : d; };

/** $ per million input / output tokens (feature-queue/model-selection-research.md §1: the judge proxy's prices; haiku-5.5
 *  derived from MODEL-BENCH.md's measured $/read, rounded up). Unknown models take the most expensive known price. */
export const PRICE: Record<string, [number, number]> = {
  "anthropic/claude-opus-5.5": [4, 20], "anthropic/claude-sonnet-5.5": [2, 10], "anthropic/claude-haiku-4.5": [1, 5], "anthropic/claude-haiku-5.5": [0.25, 1.25],
  "google/gemini-3.8-flash": [0.75, 3.75], "google/gemini-3.1-pro-preview": [2, 12], "google/gemini-3.1-flash-lite": [0.25, 1.5],
  "openai/gpt-6-luna": [0.1, 0.5], "openai/gpt-6-sol": [2, 10], "openai/gpt-6.1-sol": [2, 10], "openai/gpt-6-astra": [10, 50], "anthropic/claude-fable-5.1": [10, 50],
  // Jev (TypeSafe System One decision model, decisions.ts): $0.042/M input, output free (OpenRouter model page, 2026-10-08)
  "typesafe/jev-1.13": [0.042, 0], "~typesafe/jev-latest": [0.042, 0], "typesafe/jev-latest": [0.042, 0],
};
const UNKNOWN_PRICE: [number, number] = [10, 50];
export const priceOf = (model: string): [number, number] => PRICE[model] ?? UNKNOWN_PRICE;
/** Cheap vote models: input price under $1/M (haiku-5.5, gemini flash, luna). */
export const isCheap = (model: string): boolean => priceOf(model)[0] < 1;

/** The shift's model spend cap in USD: AGENT_SPEND_CAP_USD, else by SHIFT_SECONDS (docs/shift.md + `arena sets`:
 *  Set 1/2 = 15 min $8, Set 3 = 30 min $15, practice = 20 min $1). An unknown length takes the nearer, lower cap. */
export function capUsd(): number {
  const env = Number(process.env.AGENT_SPEND_CAP_USD); if (Number.isFinite(env) && env > 0) return env;
  const sh = Number(process.env.SHIFT_SECONDS);
  if (!Number.isFinite(sh) || sh <= 0) return 8;
  if (sh === 900) return 8; if (sh === 1200) return 1; if (sh === 1800) return 15;
  return sh >= 1500 ? 15 : sh >= 1000 ? 1 : 8;
}
export const reserveFrac = (): number => Math.min(0.9, num("AGENT_SPEND_RESERVE_FRAC", 0.25));
/** Spend (USD) above which no new text call starts: the rest of the cap is the image reads'. */
export const lineUsd = (): number => capUsd() * (1 - reserveFrac());
const SAFETY = () => Math.max(1, num("AGENT_SPEND_SAFETY", 1.1));

export type SpendClass = "image" | "text";
type Bucket = { usd: number; calls: number; image: number; text: number; estimated: number };
const bucket = (): Bucket => ({ usd: 0, calls: 0, image: 0, text: 0, estimated: 0 });
export const state = {
  total: bucket(), task: bucket(), taskNo: 0, taskKey: null as string | null,
  gatedCalls: 0, gatedTasks: 0, cheap: false, exhausted: false,
  pace: { secondsLeft: Infinity, shift: 0, seen: 0, e1: 0 },
  /** measured text spend per executor task (EMA) */
  wfTaskUsd: null as number | null, wfTasks: 0,
  sources: { cost: 0, tokens: 0, estimate: 0 },
};

/** Conservative token estimate of a request body: text chars / 3.5 plus 1600 per image; output = the smaller of
 *  max_tokens and 1000. */
export function estimateTokens(body: Record<string, unknown>): { prompt: number; completion: number; images: number } {
  let s = ""; try { s = JSON.stringify(body.messages ?? body); } catch { s = ""; }
  let images = 0; let textChars = s.length;
  for (const m of s.matchAll(/data:image\/[a-z]+;base64,([A-Za-z0-9+/=\\]+)/g)) { images++; textChars -= m[1].length; }
  const maxOut = Number(body.max_tokens); const completion = Math.min(Number.isFinite(maxOut) && maxOut > 0 ? maxOut : 1000, 1000);
  return { prompt: Math.ceil(Math.max(0, textChars) / 3.5) + images * 1600, completion, images };
}
export function estimateUsd(body: Record<string, unknown>, model: string): number {
  const [pi, po] = priceOf(model); const t = estimateTokens(body);
  return ((pi * t.prompt + po * t.completion) / 1e6) * SAFETY();
}
/** The cost of one finished call: the proxy's `usage.cost`, else its token counts × price, else the body estimate. */
export function costOf(model: string, usage: any, body: Record<string, unknown>): { usd: number; source: "cost" | "tokens" | "estimate" } {
  const c = Number(usage?.cost);
  if (usage && Number.isFinite(c) && c >= 0 && (c > 0 || Number(usage?.prompt_tokens) === 0)) return { usd: c * SAFETY(), source: "cost" };
  const p = Number(usage?.prompt_tokens), q = Number(usage?.completion_tokens);
  if (usage && Number.isFinite(p) && p >= 0) { const [pi, po] = priceOf(model); return { usd: ((pi * p + po * (Number.isFinite(q) ? q : 0)) / 1e6) * SAFETY(), source: "tokens" }; }
  return { usd: estimateUsd(body, model), source: "estimate" };
}

/** Account one request leg (failover.launch): `usage` from a 2xx reply, null for a failed / abandoned leg (its prompt
 *  may still have been charged: the estimate is taken). */
export function noteCall(model: string, cls: SpendClass, usage: any, body: Record<string, unknown>): { usd: number; source: string } {
  const r = costOf(model, usage, body);
  for (const b of [state.total, state.task]) { b.usd += r.usd; b.calls++; b[cls] += r.usd; if (r.source === "estimate") b.estimated += r.usd; }
  state.sources[r.source]++;
  return r;
}
/** May a call of this class start now? Image reads: always (the 402 is their terminal signal). Text: only while the
 *  spend so far plus this call's estimate stays under the reserve line. */
export function allow(cls: SpendClass, estUsd: number): boolean {
  if (cls === "image") return true;
  if (state.exhausted) return false;
  const ok = state.total.usd + Math.max(0, estUsd) <= lineUsd();
  if (!ok) state.gatedCalls++;
  return ok;
}
/** The pace of the shift (shiftMain, once per item): seconds left, items seen and the pacer's expected size. */
export function tick(p: { secondsLeft: number; seen: number; e1: number; shiftSeconds?: number }): void {
  state.pace = { secondsLeft: p.secondsLeft, shift: p.shiftSeconds ?? num("SHIFT_SECONDS", 900), seen: p.seen, e1: p.e1 };
  const was = state.cheap; state.cheap = aheadOfPace();
  if (was !== state.cheap) log({ kind: "cheap", on: state.cheap, projected: +projectedTextUsd().toFixed(3), line: +lineUsd().toFixed(2) });
}
/** Projected text spend for the whole shift: by items (seen ≥ 20: spend so far × expected items / items seen), else by
 *  time (spend so far / fraction of the shift elapsed); 0 before there is a pace. */
export function projectedTextUsd(): number {
  const t = state.total.text; const { secondsLeft, shift, seen, e1 } = state.pace;
  if (seen >= 20 && e1 > 0) return t * Math.max(e1, seen) / seen;
  if (Number.isFinite(secondsLeft) && shift > 0) { const f = Math.max(0, Math.min(1, (shift - secondsLeft) / shift)); if (f >= 0.05) return t / f; }
  return 0;
}
/** Text spend runs ahead of pace: its projection crosses the reserve line (the executor then votes with cheaper models). */
export const aheadOfPace = (): boolean => projectedTextUsd() > lineUsd();
/** Projected text spend of one executor task: the measured EMA, else the prior AGENT_WF_TASK_USD (0.05). */
export const estTaskUsd = (): number => state.wfTaskUsd ?? num("AGENT_WF_TASK_USD", 0.05);
/** The executor may take a task: its projected spend stays under the line (counted as a gated task when not). */
export function allowTask(): { ok: boolean; why: string } {
  const est = estTaskUsd();
  if (state.exhausted) return { ok: false, why: "spend governor: model spend exhausted (402)" };
  if (state.total.usd + est <= lineUsd()) return { ok: true, why: "" };
  state.gatedTasks++;
  return { ok: false, why: `spend governor: $${state.total.usd.toFixed(2)} spent + ~$${est.toFixed(3)} per executor task crosses the $${lineUsd().toFixed(2)} line (last ${Math.round(reserveFrac() * 100)} % of $${capUsd()} kept for image reads)` };
}
/** The endpoint answered 402 (failover): nothing more is spent this shift. */
export function noteExhausted(): void { state.exhausted = true; }

/** Start accounting one queue item. */
export function beginTask(n: number, key: string | null): void { state.task = bucket(); state.taskNo = n; state.taskKey = key; }
/** End one queue item: fold an executor task's text spend into the EMA; log the item's spend line. */
export function endTask(extra: Record<string, unknown> = {}): void {
  const t = state.task;
  if (state.taskKey === "workflow-exec" && t.text > 0) { state.wfTasks++; state.wfTaskUsd = state.wfTaskUsd == null ? t.text : state.wfTaskUsd * 0.7 + t.text * 0.3; }
  log({ n: state.taskNo, family: state.taskKey, task: { usd: +t.usd.toFixed(4), calls: t.calls, image: +t.image.toFixed(4), text: +t.text.toFixed(4) },
    total: { usd: +state.total.usd.toFixed(3), calls: state.total.calls, image: +state.total.image.toFixed(3), text: +state.total.text.toFixed(3), estimated: +state.total.estimated.toFixed(3) },
    cap: capUsd(), line: +lineUsd().toFixed(2), projected: +projectedTextUsd().toFixed(2), cheap: state.cheap, wfTaskUsd: state.wfTaskUsd == null ? null : +state.wfTaskUsd.toFixed(4),
    gated: { calls: state.gatedCalls, tasks: state.gatedTasks }, exhausted: state.exhausted, sources: state.sources, ...extra });
}
function log(rec: Record<string, unknown>) { try { process.stdout.write(JSON.stringify({ event: "spend", ...rec }) + "\n"); } catch {} }
/** Test hook. */
export function _reset(): void {
  state.total = bucket(); state.task = bucket(); state.taskNo = 0; state.taskKey = null; state.gatedCalls = 0; state.gatedTasks = 0; state.cheap = false; state.exhausted = false;
  state.pace = { secondsLeft: Infinity, shift: 0, seen: 0, e1: 0 }; state.wfTaskUsd = null; state.wfTasks = 0; state.sources = { cost: 0, tokens: 0, estimate: 0 };
}
