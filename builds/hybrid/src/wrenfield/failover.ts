/**
 * Model transport with cross-provider failover.
 *
 * Practice runs showed: a call hung, the client aborted it at 30 s, and every later call got a
 * 429 for the rest of the shift (docs/shift.md: the endpoint's own 429 concurrency_limit is at 32 requests in
 * progress; provider 429s are passed through). So this transport:
 *   - never aborts a request before the proxy's own 120 s upstream timeout;
 *   - after a hang threshold (2.5x recent median latency, 4-10 s) without an answer, races the SAME request on the next model in the chain
 *     (a different provider), leaving the slow one running; first success wins;
 *   - after a fallback wins, prefers it for SWITCH_MS before trying the primary again;
 *   - retries 5xx/transport failures on the next model with short bounded backoff; a 429 concurrency_limit is a busy
 *     slot, not a failed model: the SAME call waits (jittered backoff, inside its budget) and is retried, and the
 *     in-flight limit is learned down (judged practice: the proxy's cap was 1, not shift.md's 32);
 *   - marks a model unusable for the shift when the endpoint rejects it (400/404);
 *   - logs one machine-readable line per request leg (no prompts, keys or provider messages).
 */
import * as spend from "./spend.js";
const BASE = () => process.env.LLM_BASE_URL;
const KEY = () => process.env.LLM_API_KEY;
const num = (k: string, d: number) => { const n = Number(process.env[k]); return Number.isFinite(n) && n > 0 ? n : d; };
const MAX_HANG_MS = () => num("AGENT_HANG_MS", 10000);
const recent: number[] = [];
/** A request is "hung" at 2.5x the median recent latency, clamped to [4 s, AGENT_HANG_MS]:
 *  normal calls take ~1.5-3 s, so waiting a fixed 10 s wastes several tasks' worth of time. */
const HANG_MS = () => { if (recent.length < 3) return MAX_HANG_MS(); const s = [...recent].sort((a, b) => a - b); return Math.min(MAX_HANG_MS(), Math.max(4000, 2.5 * s[s.length >> 1])); };
const SWITCH_MS = () => num("AGENT_SWITCH_MS", 60000);
const TIMEOUT_MS = () => num("AGENT_REQUEST_TIMEOUT_MS", 125000);
// docs/shift.md: the endpoint answers 429 concurrency_limit only past 32 requests in progress; a 429 seen earlier was a
// provider 429 passed through. 4 in flight (env-overridable; the Dockerfile bakes 4), ONE slot reserved for image reads
// (lab / remittance / outside record / document) so hung generalist or compile calls can never starve them. The
// executor's votes run on the text slots (workflowExec runVotes concurrency = maxInFlight − 1 = the text limit).
// AGENT_MAX_IN_FLIGHT=1 restores serial calls.
const MAX_IN_FLIGHT = () => num("AGENT_MAX_IN_FLIGHT", 4);
/** The endpoint's concurrency cap is LEARNED: the judged practice proxy answered 429 concurrency_limit with two requests
 *  in flight (fixtures/practice-s1-tdb7020293b3d.log) although docs/shift.md says 32. The limit starts at
 *  AGENT_MAX_IN_FLIGHT and, on a 429 concurrency_limit, drops for the rest of the shift to max(1, requests in flight when
 *  that request was sent − 1) — logged as {"event":"llm","kind":"inflight"}. A scored set that never answers 429 keeps the
 *  full parallelism. */
let learned = Infinity;
const inFlightLimit = () => Math.max(1, Math.min(MAX_IN_FLIGHT(), learned));
/** The in-flight limit in force (dynamic). */
export const maxInFlight = (): number => inFlightLimit();
/** image = document / lab / remittance / outside-record reads (the deterministic families'); text = the executor's votes and
 *  gather, the generalist; compile = a message compile (between tasks); background = the executor's eager worked-example
 *  gate (runs at message time, must never hold a slot a foreground read is waiting for). */
export type CallClass = "image" | "text" | "compile" | "background";
/** Slots a class may use: image reads the whole limit; the others one fewer, so an image read always finds a slot. At a
 *  limit of 1 all share the one slot: a waiting image read goes first, a background call last (see `chat`). */
const limitFor = (cls: CallClass) => (cls === "image" ? inFlightLimit() : Math.max(1, inFlightLimit() - 1));
/** Hard client-side timeout per class: the HTTP request is ABORTED and our slot released — a hung call (gemini's 25–109 s
 *  hangs; judged practice td750384c4e29: a hung gemini vote held the single slot for 45 s) never holds a slot past its
 *  budget. It counts as a failed call (the readers' retry-once rule applies). */
const HARD_MS = (cls: CallClass) => num(cls === "image" ? "AGENT_HARD_TIMEOUT_IMAGE_MS" : cls === "compile" ? "AGENT_HARD_TIMEOUT_COMPILE_MS" : cls === "background" ? "AGENT_HARD_TIMEOUT_BACKGROUND_MS" : "AGENT_HARD_TIMEOUT_TEXT_MS",
  cls === "image" ? 12000 : cls === "compile" ? 20000 : cls === "background" ? 12000 : 15000);
export const hardTimeoutMs = (cls: CallClass): number => HARD_MS(cls);
/** The spend governor's two classes: image reads (never gated) vs everything else (gated at the reserve line). */
const spendCls = (c: CallClass): spend.SpendClass => (c === "image" ? "image" : "text");
/** Text slots in force (the executor's vote concurrency; 1 = sequential votes). */
export const textSlots = (): number => limitFor("text");
function lowerLimit(observed: number): void {
  const n = Math.max(1, observed - 1);
  if (n < inFlightLimit()) { learned = n; log({ kind: "inflight", limit: n, observed }); }
}
/** Test hook: forget the learned cap. */
export function _resetLimit(): void { learned = Infinity; }
const FALLBACKS = () => (process.env.AGENT_FALLBACK_MODELS ?? "google/gemini-3.8-flash,openai/gpt-6-luna").split(",").map((s) => s.trim()).filter(Boolean);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const state = { inFlight: 0, exhausted: false, consecutive429: 0, switched: "" as string, switchedUntil: 0, bad: new Set<string>(), waitingImage: 0, waitingFg: 0 };
export const transportState = state;

type Leg = { model: string; hedged: boolean; done: Promise<{ json?: any; status: number; transient: boolean; code?: string; slotBusy?: boolean }> };
/** Every request leg still running (including legs a caller stopped waiting for: they keep the proxy's one slot), with the
 *  time its hard timeout aborts it — a waiter's slot wait covers the earliest of them. */
const flying = new Set<Promise<unknown>>();
const deadlines = new Map<Promise<unknown>, number>();

function log(rec: Record<string, unknown>) { try { process.stderr.write(JSON.stringify({ event: "llm", ...rec }) + "\n"); } catch {} }

/**
 * Fault injection (tests / local fault runs only; unset in a real shift): AGENT_FAULT="model=mode,..." where mode is
 *   first   the first call to the model fails (HTTP 502)       twoOfThree  calls 1 and 2 of every 3 fail
 *   down    every call fails                                   empty       200 with an empty reply
 *   slow    every call answers 504 after AGENT_FAULT_SLOW_MS (default 30000) — longer than any read waits
 *   429     the first call answers 429 concurrency_limit       504         the first call answers 504 upstream_timeout
 *   402     every call answers 402 cost_cap_reached           hangFirst   the first call hangs AGENT_FAULT_SLOW_MS, later calls answer
 */
const faultCalls = new Map<string, number>();
function injectFault(model: string): { status: number; json?: any } | null {
  const spec = process.env.AGENT_FAULT; if (!spec) return null;
  const mode = spec.split(",").map((x) => x.split("=")).find(([m]) => m?.trim() === model)?.[1]?.trim(); if (!mode) return null;
  const k = (faultCalls.get(model) ?? 0) + 1; faultCalls.set(model, k);
  if (mode === "first") return k === 1 ? { status: 502 } : null;
  if (mode === "twoOfThree") return k % 3 !== 0 ? { status: 502 } : null;
  if (mode === "down") return { status: 502 };
  if (mode === "empty") return { status: 200, json: { model, choices: [{ message: { content: "" }, finish_reason: "stop" }] } };
  if (mode === "429") return k === 1 ? { status: 429, json: { error: { code: "concurrency_limit" } } } : null;
  if (mode === "504") return k === 1 ? { status: 504, json: { error: { code: "upstream_timeout" } } } : null;
  if (mode === "402") return { status: 402, json: { error: { code: "cost_cap_reached" } } };
  return null;
}
const hangSeen = new Set<string>();
/** slow: every call; hangFirst: only the first call (a later hedged duplicate answers normally). */
const slowFault = (model: string) => {
  const spec = process.env.AGENT_FAULT ?? "";
  if (spec.split(",").some((x) => x.trim() === `${model}=slow`)) return true;
  if (spec.split(",").some((x) => x.trim() === `${model}=hangFirst`) && !hangSeen.has(model)) { hangSeen.add(model); return true; }
  return false;
};
/** Test hook: reset the fault-injection call counters. */
export function _resetFaults(): void { faultCalls.clear(); hangSeen.clear(); }
/** Test hook: calls that reached the fault injector for `model` (injected or passed through). */
export const _faultCallCount = (model: string): number => faultCalls.get(model) ?? 0;

/** `usage: {include: true}` asks an OpenRouter-backed endpoint to return `usage.cost` (the accounting the spend cap is
 *  measured in). AGENT_USAGE_INCLUDE=0 turns it off; a 400 answered to a body carrying it turns it off for the shift and
 *  the leg is retried without it (the model is NOT marked rejected on that first 400). */
let usageInclude = process.env.AGENT_USAGE_INCLUDE !== "0";
/** The endpoint path under LLM_BASE_URL. The default is the chat API; a decision call (decisions.ts: Jev, OpenRouter's
 *  System One API mirrored by the proxy as `$LLM_BASE_URL/systemone`) names its own path and never carries the chat
 *  API's `usage: {include}` (its reply always has `usage.cost`). Same slots, timeouts, 429 / 402 handling, accounting. */
const CHAT_PATH = "chat/completions";
function launch(body: Record<string, unknown>, model: string, hedged: boolean, cls: CallClass = "text", path = CHAT_PATH): Leg {
  state.inFlight++;
  const observed = state.inFlight; // requests in flight when this one is sent (itself included): the cap, if it answers 429
  const t0 = Date.now();
  const hardMs = Math.min(HARD_MS(cls), TIMEOUT_MS());
  const ac = new AbortController(); let aborted = false;
  const killer = setTimeout(() => { aborted = true; ac.abort(); }, hardMs);
  const done = (async () => {
    let status = 0, code: string | undefined, headers: string[] | undefined, spent: { usd: number; source: string } | undefined;
    const withUsage = usageInclude && path === CHAT_PATH;
    try {
      if (slowFault(model)) { await sleep(num("AGENT_FAULT_SLOW_MS", 30000)); status = 504; code = "injected-slow"; spent = spend.noteCall(model, spendCls(cls), null, body); return { status, transient: true, code }; }
      const inj = injectFault(model);
      const r: any = inj ? { ok: inj.status === 200, status: inj.status, json: async () => inj.json ?? { error: { code: "injected" } }, headers: new Map() } : await fetch(path.startsWith("http") ? path : `${BASE()}/${path}`, {
        method: "POST", headers: { Authorization: `Bearer ${KEY()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, model, ...(withUsage ? { usage: { include: true } } : {}) }), signal: ac.signal,
      });
      status = r.status;
      const json: any = await r.json().catch(() => null);
      if (r.ok && json) { state.consecutive429 = 0; recent.push(Date.now() - t0); if (recent.length > 20) recent.shift(); spent = spend.noteCall(model, spendCls(cls), json.usage, body); return { json, status, transient: false }; }
      const c = json?.error?.code; if (typeof c === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(c)) code = c;
      headers = [...r.headers.keys()].filter((k) => /^(x-|retry-after$)/.test(k)).slice(0, 20);
      if (r.status === 429) state.consecutive429++;
      // the endpoint's concurrency cap: the slot is busy, not the model — nothing was served or charged; `chat` waits and
      // retries the SAME call (never the next model), and the in-flight limit is lowered for the rest of the shift
      if (r.status === 429 && code === "concurrency_limit") { lowerLimit(observed); return { status, transient: true, code, slotBusy: true }; }
      if (r.status === 402) { state.exhausted = true; spend.noteExhausted(); return { status, transient: false, code }; } // nothing was served: nothing to account
      spent = spend.noteCall(model, spendCls(cls), null, body); // a failed leg may still have been charged for its prompt
      if (r.status === 400 && withUsage && !inj) { usageInclude = false; code = code ?? "usage_include_refused"; return { status, transient: true, code }; } // retry once without `usage`
      if (r.status === 400 || r.status === 404) state.bad.add(model); // endpoint rejects this model/body
      return { status, transient: r.status === 429 || r.status >= 500, code };
    } catch (e) {
      code = aborted ? "hard_timeout" : e instanceof Error ? e.name : "error";
      spent = spend.noteCall(model, spendCls(cls), null, body);
      return { status, transient: true, code };
    } finally {
      clearTimeout(killer);
      state.inFlight--;
      log({ model, hedged, status, code, headers, ms: Date.now() - t0, cls, ...(path !== CHAT_PATH ? { path } : {}), ...(aborted ? { hardMs } : {}), ...(spent ? { usd: +spent.usd.toFixed(5), usdSource: spent.source } : {}) });
    }
  })();
  flying.add(done); deadlines.set(done, t0 + hardMs); done.finally(() => { flying.delete(done); deadlines.delete(done); });
  return { model, hedged, done };
}

/** The model order for one call: the sticky fallback while a switch is active, then the primary,
 *  then the remaining fallbacks; models the endpoint rejected are dropped. */
function chain(primary: string, fallbacks = FALLBACKS()): string[] {
  // An explicit empty fallback list means "this model or nothing" (e.g. the lab readers, whose agreement
  // rule needs two DIFFERENT models): the sticky switch must not reroute such a call either.
  const pinned = fallbacks.length === 0;
  const head = !pinned && state.switched && Date.now() < state.switchedUntil ? [state.switched, primary] : [primary];
  return [...new Set([...head, ...fallbacks])].filter((m) => !state.bad.has(m));
}

/**
 * POST one chat completion with failover. `body` must not set `model`. Resolves to the parsed
 * response JSON, or null when every attempt failed, the budget is exhausted, or `waitMs` elapsed
 * (in which case outstanding legs keep running and are never aborted early).
 */
export async function chat(body: Record<string, unknown>, opts: { primary: string; fallbacks?: string[]; waitMs?: number; attempts?: number; onFail?: (cause: string) => void; cls?: CallClass; path?: string }): Promise<any | null> {
  const cls: CallClass = opts.cls ?? "text"; const path = opts.path ?? CHAT_PATH;
  // a slot is free for this class under the limit IN FORCE (it may drop while we wait); priority at the shared slot:
  // an image read first, then text / compile, a background call (the eager example gate) only when nobody else waits
  const fg = cls === "text" || cls === "compile";
  const slotFree = () => state.inFlight < limitFor(cls) && (cls === "image" || (state.waitingImage === 0 && (fg || state.waitingFg === 0)));
  const fail = (cause: string) => { lastCause = cause; try { opts.onFail?.(cause); } catch {} return null; };
  if (!BASE() || !KEY()) return fail("no endpoint");
  if (state.exhausted) return fail("budget exhausted (402)");
  const models = chain(opts.primary, opts.fallbacks);
  if (!models.length) return fail("model rejected by the endpoint this shift");
  // Spend governor (spend.ts): a text call starts only while the shift's spend plus this call's estimate stays under the
  // reserve line; the last part of the cap is the deterministic families' image reads'. Image reads are never gated here.
  if (cls !== "image") { const est = spend.estimateUsd(body, models[0]); if (!spend.allow("text", est)) { log({ kind: "spend_gate", model: opts.primary, estUsd: +est.toFixed(4), spentUsd: +spend.state.total.usd.toFixed(3), lineUsd: +spend.lineUsd().toFixed(2) }); return fail(`spend governor: $${spend.state.total.usd.toFixed(2)} spent, text calls stopped at the $${spend.lineUsd().toFixed(2)} line`); } }
  const stopAt = Date.now() + (opts.waitMs ?? TIMEOUT_MS());
  // A leg another caller stopped waiting for (a 48-69 s gemini hang) still holds its slot. Wait for a slot inside
  // this call's own budget instead of failing at once with no request made (run r4, MAX_IN_FLIGHT 1: haiku-5.5
  // "failed" this way, was demoted, and 23 labs lost their reader).
  const waitSlot = async (): Promise<boolean> => {
    if (slotFree()) return true;
    const w0 = Date.now(); if (cls === "image") state.waitingImage++; else if (fg) state.waitingFg++;
    // the wait covers the earliest hard timeout among the legs holding the slots (a hung holder is aborted then), so a
    // reader never gives up on a slot that is about to free — bounded by AGENT_SLOT_WAIT_EXTRA_MS past its own budget
    const until = () => { const dl = [...deadlines.values()]; const first = dl.length ? Math.min(...dl) + 300 : 0; return Math.max(stopAt, Math.min(first, stopAt + num("AGENT_SLOT_WAIT_EXTRA_MS", 15000))); };
    try {
      while (!slotFree() && Date.now() < until()) {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([...flying, new Promise((r) => { timer = setTimeout(r, Math.max(1, Math.min(250, until() - Date.now()))); })]).catch(() => {});
        clearTimeout(timer);
      }
    } finally { if (cls === "image") state.waitingImage--; else if (fg) state.waitingFg--; }
    const waited = Date.now() - w0;
    if (!slotFree()) { log({ kind: "no_slot", model: opts.primary, cls, waitedMs: waited, limit: inFlightLimit() }); return false; }
    if (waited > 200) log({ kind: "slot_wait", model: opts.primary, cls, waitedMs: waited, limit: inFlightLimit() });
    return true;
  };
  if (!(await waitSlot())) return fail(`no free request slot within the budget (limit ${inFlightLimit()}, another request still running)`);
  const attempts = opts.attempts ?? 3;
  let next = 0, launched = 0;
  const live = new Set<Leg>();
  const start = (hedged: boolean) => {
    if (launched >= attempts || !slotFree() || state.exhausted) return false;
    const leg = launch(body, models[next++ % models.length], hedged, cls, path); launched++; live.add(leg); return true;
  };
  let last = "no answer";
  start(false);
  let hedgeAt = Date.now() + HANG_MS(), backoff = 250, busyBackoff = 150;
  while (live.size) {
    const wait = Math.max(0, Math.min(hedgeAt, stopAt) - Date.now());
    let timer: NodeJS.Timeout | undefined;
    const tick = new Promise<"tick">((r) => { timer = setTimeout(r, wait, "tick"); });
    const res = await Promise.race([tick, ...[...live].map((l) => l.done.then((o) => ({ l, o })))]);
    clearTimeout(timer);
    if (res === "tick") {
      if (Date.now() >= stopAt) return fail(`timeout: no answer within ${opts.waitMs ?? TIMEOUT_MS()} ms`); // stop waiting; legs settle in background
      if (start(true)) hedgeAt = Date.now() + HANG_MS(); else hedgeAt = stopAt; // hang → race the next provider
      continue;
    }
    live.delete(res.l);
    if (res.o.json) {
      if (res.l.model !== opts.primary) { state.switched = res.l.model; state.switchedUntil = Date.now() + SWITCH_MS(); }
      else if (state.switched) state.switchedUntil = 0;              // primary healthy again
      return res.o.json;
    }
    if (res.o.slotBusy) {
      // 429 concurrency_limit: the slot was busy, not the model. A hedged duplicate is simply dropped (the endpoint cannot
      // take it); the call itself waits for a slot (jittered backoff, inside its own budget) and retries the SAME model —
      // it never costs an attempt and never moves to the next model.
      if (res.l.hedged) { hedgeAt = stopAt; continue; }
      launched--; next--;
      if (live.size) { hedgeAt = stopAt; continue; }
      const nap = busyBackoff + Math.floor(Math.random() * busyBackoff); busyBackoff = Math.min(1500, busyBackoff * 2);
      if (Date.now() + nap >= stopAt) return fail(`slot busy (429 concurrency_limit, limit ${inFlightLimit()}) until the budget ran out`);
      await sleep(nap);
      if (!(await waitSlot())) return fail(`slot busy (429 concurrency_limit, limit ${inFlightLimit()}): no free request slot within the budget`);
      start(false); hedgeAt = Date.now() + HANG_MS();
      continue;
    }
    last = res.o.status ? `HTTP ${res.o.status}${res.o.code ? " " + res.o.code : ""}` : `transport ${res.o.code ?? "error"}`;
    if (state.exhausted) return fail("budget exhausted (402)");
    if (!live.size && launched < attempts && Date.now() + backoff < stopAt) {
      if (res.o.transient) { await sleep(backoff); backoff = Math.min(2000, backoff * 2); }
      start(false); hedgeAt = Date.now() + HANG_MS();
    }
  }
  return fail(last);
}
/** Why the most recent failed `chat` call returned null (for read-failure logs). */
export let lastCause = "";

/** Models the endpoint listed at startup (empty until checkModels succeeds). */
const listed = new Set<string>();
/** Opt-in models: used only once the models check has CONFIRMED the endpoint lists them. */
export const PREFERRED_MODELS = ["anthropic/claude-haiku-5.5"];

/**
 * The model for one role from a preference chain "preferred,...,default". The LAST entry is the safe
 * default (today's model) and is returned whenever no earlier entry is confirmed: an earlier entry is
 * used only when checkModels saw it listed AND the endpoint has not rejected it this shift (400/404,
 * or `demote` after a failed call). Models check not finished / failed / not listed → the default:
 * no behaviour change when the preferred model is missing.
 */
export function pickModel(chain: string[]): string {
  for (const m of chain.slice(0, -1)) if (listed.has(m) && usable(m)) return m;
  return chain[chain.length - 1];
}
/** A preferred model is served as another model: stop using it this shift. */
export function demote(model: string, why: string): void {
  if (state.bad.has(model)) return;
  state.bad.add(model); log({ kind: "demote", model, why });
}

// ── model health: one failed read never takes a model out for the shift ──
const DEMOTE_AFTER = () => num("AGENT_DEMOTE_AFTER", 3);       // consecutive failed reads before a model is rested
const REPROBE_TASKS = () => num("AGENT_REPROBE_TASKS", 10);    // tasks a rested model sits out before one probe read
const health = new Map<string, { fails: number; restUntil: number }>();
let taskNo = 0, faults = 0;
/** Failed model reads so far this shift (any cause): the pacer discounts an item's time when it grew. */
export const faultCount = (): number => faults;
/** Called once per queue item (shiftMain): the clock for re-probing a rested model. */
export function taskTick(): void { taskNo++; }
const restedNow = (m: string) => { const h = health.get(m); return !!h && h.restUntil > taskNo; };
/** The outcome of one read by `model`. `cause` names the failure (HTTP status, timeout, parse, empty...). A failure
 *  that is not the model's (no free slot: another request held it) is logged but not counted. */
export function noteRead(model: string, ok: boolean, cause = "", role = "read"): void {
  const h = health.get(model) ?? { fails: 0, restUntil: 0 }; health.set(model, h);
  if (ok) { if (h.fails) log({ kind: "recovered", model, after: h.fails }); h.fails = 0; return; }
  // not the model's fault: no free slot, 429 concurrency/rate limit (short backoff inside chat), 402 spend cap (every
  // model path is off for the shift: state.exhausted)
  const counts = !/^no free request slot|^slot busy|^HTTP 429|^budget exhausted|cost_cap_reached/.test(cause); // a hard timeout (hung call) DOES count: it is the model's
  if (counts) h.fails++;
  faults++;
  log({ kind: "read_fail", model, role, cause, consecutive: h.fails, counted: counts });
  if (counts && h.fails >= DEMOTE_AFTER() && h.restUntil <= taskNo) {
    h.restUntil = taskNo + REPROBE_TASKS();
    log({ kind: "rest", model, why: `${h.fails} consecutive failed reads`, reprobeAfterTasks: REPROBE_TASKS() });
  }
}
/** Test hook: reset the health table and the task clock. */
export function _resetHealth(): void { health.clear(); taskNo = 0; faults = 0; }
/** True when `m` may be used now: not rejected for the shift and not resting. */
export const usable = (m: string): boolean => !state.bad.has(m) && !restedNow(m);
/** True once the startup models check saw `m` listed and the endpoint has not rejected it. */
export const isListed = (m: string): boolean => listed.has(m) && usable(m);
/** Test hook: pretend the models check listed `ids` (undefined → reset to "not checked"). */
export function _setListed(ids?: string[]): void { listed.clear(); state.bad.clear(); health.clear(); for (const m of ids ?? []) listed.add(m); }

/** Log which configured models the endpoint lists (GET /v1/models is free) and drop fallbacks it
 *  doesn't offer; record the listed set so pickModel can enable PREFERRED_MODELS. Fire-and-forget at
 *  startup; never blocks or fails the shift. */
export async function checkModels(primary: string): Promise<void> {
  if (!BASE() || !KEY()) return;
  try {
    const r = await fetch(`${BASE()}/models`, { headers: { Authorization: `Bearer ${KEY()}` } });
    const j: any = await r.json().catch(() => null);
    const ids = new Set<string>((j?.data ?? []).map((m: any) => String(m?.id)));
    const wanted = [...new Set([primary, ...FALLBACKS(), "google/gemini-3.8-flash", ...PREFERRED_MODELS, "anthropic/claude-sonnet-5.5", "anthropic/claude-opus-5.5", "typesafe/jev-1.13"])];
    if (ids.size) for (const m of FALLBACKS()) if (m !== primary && !ids.has(m)) state.bad.add(m);
    if (r.ok) for (const m of wanted) if (ids.has(m)) listed.add(m);
    log({ kind: "models", status: r.status, listed: ids.size, present: Object.fromEntries(wanted.map((m) => [m, ids.has(m)])) });
  } catch (e) { log({ kind: "models", code: e instanceof Error ? e.name : "error" }); }
}
