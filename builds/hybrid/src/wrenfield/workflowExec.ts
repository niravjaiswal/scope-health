/**
 * Gated LLM workflow executor (message-defined workflows no deterministic family takes).
 *
 * For a workflow message (answer forms in backticks + rules, usually a worked example), the executor gives models the
 * message (+ later messages about it), the request and the text of the pages gathered for the request's named inputs,
 * and asks for a STRUCTURED reply: does the request ask this workflow's question; the inputs it names; every fact the
 * rule needs with a verbatim quote from a page; the rule applied; the answer. An answer is sent only when ALL gates pass:
 *   (a) example gate: the message's own worked example is reproduced (from the message's stated facts, no pages);
 *   (b) self-consistency: ≥ k of the configured runs give the same answer and no run gives a different answer;
 *   (c) format: the answer is in one of the message's own answer forms (token head + suffix shape, or a bare
 *       number / amount / date / text the message shows as an answer);
 *   (d) grounding: every run that voted for it quotes ≥ 1 fact and every quote is found verbatim in the pages;
 *   (e) applies: no run said the request asks a different question than the workflow answers.
 * Mode: AGENT_WORKFLOW_EXEC = off | shadow (default) | on. Shadow logs the would-be answer and never sends it.
 * Measured on held-out cases by wfEval.ts (precision / coverage per configuration).
 */
import { chat, isListed } from "./failover.js";

export type WfMode = "off" | "shadow" | "on";
/** AGENT_WORKFLOW_EXEC (alias AGENT_GENERALIST) = off | shadow | on. The image sets off; "on" is the generalist answer path. */
export const wfMode = (): WfMode => { const m = (process.env.AGENT_WORKFLOW_EXEC ?? process.env.AGENT_GENERALIST ?? "shadow").toLowerCase(); return m === "on" || m === "off" ? m : "shadow"; };

export type Shape = "date" | "amount" | "int" | "text" | "none";
export type WfSpec = { title: string; heads: Map<string, Set<string>>; generic: Set<string>; bare: Set<Shape>; example?: { request: string; answer: string }; raw: string };

const shapeOf = (s: string): Shape => s === "" ? "none" : /^\d{4}-\d{2}-\d{2}$/.test(s) ? "date" : /^-?\d+\.\d{2}$/.test(s) ? "amount" : /^\d+$/.test(s) ? "int" : "text";
const placeholderShape = (p: string): Shape | null => /days|count|number of|\bn\b/i.test(p) ? "int" : /date|day|YYYY|last/i.test(p) ? "date" : /amount|total|dollars/i.test(p) ? "amount" : /count|number of|days|\bn\b/i.test(p) ? "int" : /^<.+>$/.test(p) ? "text" : null;
/** Suffix signature: one shape per ":"-part (`4:2013-01-14` → "int:date"); a placeholder part (`<count>`) by its name. */
const sigOf = (suf: string): string => suf.split(":").map((p) => (/^<.+>$/.test(p) ? placeholderShape(p) ?? "text" : /^[A-Z][A-Z_]+$/.test(p) ? "word" : shapeOf(p))).join(":");
const HEAD = /^[A-Z][A-Z0-9_]{1,}$/;

/** The message's answer forms: token heads with the suffix signatures its examples / placeholders show, and bare answers. */
export function parseWorkflowSpec(raw: string): WfSpec | null {
  const all = [...raw.matchAll(/`([^`\n]{1,80})`/g)].map((m) => ({ t: m[1].trim(), at: m.index ?? 0 }));
  const heads = new Map<string, Set<string>>(); const generic = new Set<string>(); const bare = new Set<Shape>();
  const bareCand: Array<{ sh: Shape; strong: boolean }> = [];
  for (const { t, at } of all) {
    const i = t.indexOf(":"); const head = i < 0 ? t : t.slice(0, i); const suf = i < 0 ? "" : t.slice(i + 1);
    if (/^<[^>]+>$/.test(head) && suf) { generic.add(sigOf(suf)); continue; }            // `<ACTION>:<count>:<last>`
    if (HEAD.test(head) && !/^(YYYY|MM|DD)/.test(head)) {
      const set = heads.get(head) ?? new Set<string>(); heads.set(head, set);
      if (i < 0) set.add("none"); else if (suf !== "") set.add(sigOf(suf));
      continue;
    }
    const before = raw.slice(Math.max(0, at - 120), at).toLowerCase();
    const answerCtx = /answer|give|reply|for example|e\.g\.|is `?$|as `?$/.test(before) && !/`[A-Z][A-Z0-9_]+:`[^`]{0,60}$/.test(before);
    const strong = /\b(answer|give)\b[^.\n]{0,80}$/.test(before);            // "Give the date … as `YYYY-MM-DD`" (same sentence)
    let sh: Shape | null = null;
    if (/^YYYY-MM-DD$/.test(t) || /^\d{4}-\d{2}-\d{2}$/.test(t)) sh = "date";
    else if (/^-?\d+\.\d{2}$/.test(t)) sh = "amount";
    else if (/^\d+$/.test(t)) sh = "int";
    else if (/^<[^>:]+>$/.test(t)) sh = placeholderShape(t);
    else if (/^[A-Z][\w.'&-]*( [\w.'&,-]+){1,6}$/.test(t) && !/\d{2}/.test(t)) sh = "text";
    // a username / login shown as the answer ("Answer with that user's username exactly as shown, for example `framirez`"):
    // one lower-case word, only in an answer sentence (loop suite record-creator; before, no vote could ever pass the format gate)
    else if (/^[a-z][a-z0-9._-]{2,30}$/.test(t) && /\b(answer|give)\b[^.\n]{0,80}$/.test(before) && /\b(user ?name|login|user id|user)\b/.test(before)) sh = "text";
    if (sh && answerCtx) bareCand.push({ sh, strong });
  }
  // With token heads, a bare form needs a "give/answer … `X`" sentence (claim n=120 "dates as `YYYY-MM-DD`" is a format note).
  for (const b of bareCand) if (!heads.size || b.strong) bare.add(b.sh);
  // A head written bare AND with a suffix (`ESTABLISHED:` + `ESTABLISHED:2025-03-11`) → only the suffix forms.
  for (const [h, s] of heads) if (s.size > 1 && s.has("none") && all.some((x) => x.t.startsWith(h + ":") && x.t.length > h.length + 1)) s.delete("none");
  for (const [h, s] of heads) if (!s.size) { // `X:` with no example → prose may say the form
    const prose = raw.match(new RegExp("`" + h + ":`[^.\\n]*?(YYYY-MM-DD|two decimals|dollars|date)", "i"));
    s.add(prose ? (/YYYY|date/i.test(prose[1]) ? "date" : "amount") : "text");
  }
  if (!heads.size && !bare.size) return null;
  const ex = raw.match(/If someone asks:\s*"([^"]+)"\s*\n+\s*The answer is `([^`]+)`/i)
    ?? raw.match(/Request:\s*"([^"]+)"\s*\n+\s*Answer:\s*`([^`]+)`/i)
    ?? raw.match(/(?:asks|request(?:s)?|question)[^"\n]{0,30}:\s*"([^"]+)"[\s\S]{0,80}?answer is `([^`]+)`/i)
    ?? raw.match(/\n"([^"\n]{10,200}\?)"\s*[—-][^\n]{0,400}?[Tt]he answer is `([^`]+)`/);
  const title = (raw.split("\n")[0].match(/^From [^:]+:\s*(.+)$/)?.[1] ?? raw.split("\n")[0]).trim().slice(0, 100);
  return { title, heads, generic, bare, example: ex ? { request: ex[1].trim(), answer: ex[2].trim() } : undefined, raw };
}

/** Gate (c): the answer is one of the message's answer forms. */
export function matchesTokenFormat(ans: string, spec: WfSpec): boolean {
  const a = ans.trim(); if (!a || /\s{2,}|\n|`/.test(a) || a.length > 80) return false;
  const i = a.indexOf(":"); const head = i < 0 ? a : a.slice(0, i); const suf = i < 0 ? "" : a.slice(i + 1).trim();
  const sigs = spec.heads.get(head);
  if (sigs) {
    const sig = i < 0 ? "none" : sigOf(suf);
    if (sigs.has(sig) || (i >= 0 && spec.generic.has(sig))) return true;
    if (i >= 0 && spec.generic.size && [...spec.generic].some((g) => g.split(":").length === sig.split(":").length && g.split(":").every((p, k) => p === sig.split(":")[k] || (sig.split(":")[k] === "word" && /date|text/.test(p))))) return true;
    const known = sig === "word" && spec.heads.has(suf);                                  // `RESUBMIT:MEMBER_ID` — the field is a listed token
    if (sig !== "none" && !sig.includes(":") && sigs.has("text") && suf.length <= 60 && (sig !== "word" || known)) return true;
    return false;
  }
  if (HEAD.test(head) && i < 0) return false;                                            // an unknown token
  const sh = shapeOf(a);
  if (sh === "text") return spec.bare.has("text") && !HEAD.test(a.replace(/:.*/, "")) && a.length <= 60;
  return spec.bare.has(sh);
}

const SYSTEM = `You are a meticulous back-office clerk at a medical clinic. You apply a written workflow rule EXACTLY as written to the clinic pages given to you. Work only from the page text provided; never assume facts that are not on the pages. If the pages do not contain everything the rule needs (a page is missing, a value is unreadable or ambiguous, two records could be the patient), the answer is UNKNOWN.
Reply with JSON only: {"steps": "<the facts you used, short>", "answer": "<the answer string exactly in the rule's answer form, or UNKNOWN>"}`;

/** v2: structured reply — applies? inputs, quoted facts, rule, answer. */
const SYSTEM2 = `You are a meticulous back-office clerk at a medical clinic. A supervisor's WORKFLOW MESSAGE defines one kind of request and how to answer it. You get that message (later messages win when they disagree), a REQUEST, and the text of the clinic pages gathered for the request.
Work in this order:
1. applies: does the REQUEST ask exactly the question the workflow answers? (A different question that only shares words — e.g. who/when instead of how many, a total instead of what is owed — does NOT apply.)
2. inputs: the things the request names (patient, dates, numbers, types...).
3. facts: every fact the rule needs, each with "quote" = text copied EXACTLY, character for character, from ONE line of ONE page (a table row may be quoted as a part of its line). Do not paraphrase quotes.
4. rule: apply the message's steps to those facts, briefly and in order; count or compute carefully.
5. answer: exactly in the message's answer form. Answer UNKNOWN when the request does not apply, when a page the rule needs is missing or incomplete, when a value is unreadable, or when two records could be the one asked about. Never guess.
Reply with JSON only: {"applies": true|false, "inputs": {...}, "facts": [{"fact": "...", "page": "...", "quote": "..."}], "rule": "...", "answer": "..."}`;

export type Gathered = { pages: Array<{ name: string; text: string }>; why?: string };
export type Runner = (body: Record<string, unknown>, model: string, waitMs?: number, cls?: "text" | "background") => Promise<string | null>;

export const defaultRunner: Runner = async (body, model, waitMs, cls) => {
  const j = await chat({ ...body, ...transportExtras(model) }, { primary: model, fallbacks: [], attempts: 2, waitMs: waitMs ?? 90000, cls: cls ?? "text" });
  return j?.choices?.[0]?.message?.content ?? null;
};
/** Models for the runs, cheapest last; env AGENT_WF_MODELS overrides. Only models the endpoint lists. */
export function wfModels(): string[] {
  const env = (process.env.AGENT_WF_MODELS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (env.length) return env;
  return ["anthropic/claude-sonnet-5.5", "anthropic/claude-haiku-5.5"].filter((m) => isListed(m));
}

const msgBlock = (spec: WfSpec, later: string[]) => [`=== WORKFLOW MESSAGE ===\n${spec.raw}`, ...later.map((m, i) => `=== LATER MESSAGE ${i + 1} (later messages win when they disagree) ===\n${m}`)].join("\n\n");
const pageBlock = (g: Gathered, cap = 14000) => g.pages.map((p) => `=== PAGE: ${p.name} ===\n${p.text.slice(0, cap)}`).join("\n\n");
function prompt(spec: WfSpec, later: string[], request: string, g: Gathered, salt: number) {
  return { messages: [{ role: "system", content: SYSTEM }, { role: "user", content: `${msgBlock(spec, later)}\n\n${pageBlock(g)}\n\n=== REQUEST ===\n${request}\n\n(run ${salt}) Apply the workflow to this request. JSON only.` }], temperature: salt === 0 ? 0 : 0.7, max_tokens: 1500, response_format: { type: "json_object" } };
}
export function prompt2(spec: WfSpec, later: string[], request: string, g: Gathered, temperature = 0) {
  return { messages: [{ role: "system", content: SYSTEM2 }, { role: "user", content: `${msgBlock(spec, later)}\n\n${pageBlock(g, 24000)}\n\n=== REQUEST ===\n${request}\n\nJSON only.` }], temperature, max_tokens: Number(process.env.AGENT_WF_MAX_TOKENS ?? 4000), response_format: { type: "json_object" } };
}
/** Transport extras that are not part of the prompt (so cached replies keyed on the prompt stay valid): gemini / gpt
 *  without `reasoning: low` spend their budget thinking (replica runs: gemini median 11-14 s, p90 25-30 s; the lab reader
 *  sets it the same way). */
export const transportExtras = (model: string): Record<string, unknown> => (/^(google|openai)\//.test(model) ? { reasoning: { effort: process.env.AGENT_VISION_REASONING ?? "low" } } : {});
function parseAnswer(txt: string | null): string | null {
  if (!txt) return null;
  const m = txt.match(/\{[\s\S]*\}/); if (!m) return null;
  try { const a = String(JSON.parse(m[0]).answer ?? "").trim().replace(/^`|`$/g, ""); return a && a.toUpperCase() !== "UNKNOWN" ? a : null; } catch { return null; }
}

// ── v2 votes
export type Vote = { model: string; answer: string | null; applies: boolean | null; quotes: number; grounded: boolean; ungrounded: string[]; err?: string;
  /** the run's own account of the rule (why it abstained): steers the gather's second round, never an answer */
  rule?: string };
const norm = (s: string) => s.normalize("NFKC").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s*\|\s*/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
/** Gate (d): a quote is grounded when it (or every " ... "-separated piece of it) is in the pages' text. */
export function grounded(quote: string, pagesNorm: string): boolean {
  const parts = quote.split(/\s*(?:\.\.\.|…)\s*/).map(norm).filter((p) => p.length >= 2);
  return parts.length > 0 && parts.every((p) => pagesNorm.includes(p));
}
export function parseVote(model: string, txt: string | null, g: Gathered): Vote {
  const v: Vote = { model, answer: null, applies: null, quotes: 0, grounded: false, ungrounded: [] };
  if (!txt) return { ...v, err: "no reply" };
  const m = txt.match(/\{[\s\S]*\}/); if (!m) return { ...v, err: "no json" };
  let j: any; try { j = JSON.parse(m[0]); } catch { return { ...v, err: "bad json" }; }
  const a = String(j.answer ?? "").trim().replace(/^`|`$/g, "").replace(/^\$(?=\d)/, "");
  v.answer = a && !/^unknown$/i.test(a) ? a : null;
  v.applies = typeof j.applies === "boolean" ? j.applies : j.applies === "false" ? false : j.applies === "true" ? true : null;
  // page NAMES count as page text: they are ours, written from the proven read ("… list (46 rows; rows = the stated count …)"),
  // and a count answer quotes them (gather-after-1: the day's no-show count, 46, quoted from the list's name was refused)
  const pn = norm(g.pages.map((p) => p.name + "\n" + p.text).join("\n"));
  const facts = Array.isArray(j.facts) ? j.facts : [];
  for (const f of facts) { const q = String(f?.quote ?? "").trim(); if (!q) continue; v.quotes++; if (!grounded(q, pn)) v.ungrounded.push(q.slice(0, 80)); }
  v.grounded = v.quotes > 0 && v.ungrounded.length === 0;
  if (typeof j.rule === "string" && j.rule.trim()) v.rule = j.rule.trim().slice(0, 600);
  return v;
}
/** One run per model (temperature 0); a model may appear twice in `models` for a second sample (temperature 0.7).
 *  `concurrency` runs at a time (the proxy's request slots minus one kept for image reads; 1 = sequential, as on a
 *  one-slot proxy); default: all at once. `stopEarly` (the live path): once the outcome is decided under a strict
 *  policy — a run says "doesn't apply", or two runs give different answers — no further run is started (coverage-exec);
 *  runs already in flight finish. Benches keep every run (wfEval's curves need them). */
export async function runVotes(spec: WfSpec, later: string[], request: string, g: Gathered, opts: { models: string[]; runner?: Runner; concurrency?: number; waitMs?: number; stopEarly?: boolean; cls?: "text" | "background" }): Promise<Vote[]> {
  const run = opts.runner ?? defaultRunner; const seen = new Map<string, number>();
  const jobs = opts.models.map((model) => { const n = seen.get(model) ?? 0; seen.set(model, n + 1); return { model, temp: n === 0 ? 0 : 0.7 }; });
  const out: Vote[] = []; let i = 0;
  const decided = () => out.some((v) => v && v.applies === false) || new Set(out.filter((v) => v && v.answer != null).map((v) => v.answer)).size > 1;
  const workers = Array.from({ length: Math.max(1, Math.min(jobs.length, opts.concurrency ?? jobs.length)) }, async () => {
    while (i < jobs.length) {
      if (opts.stopEarly && decided()) { i = jobs.length; break; }
      const k = i++; const { model, temp } = jobs[k]; const txt = await run(prompt2(spec, later, request, g, temp), model, opts.waitMs, opts.cls).catch(() => null); out[k] = parseVote(model, txt, g);
    }
  });
  await Promise.all(workers);
  return out.filter(Boolean);
}
export type Policy = { k: number; strict: boolean; ground: boolean; applies: boolean };
/** The measured operating point (wfEval.ts, 113 cases: 86 right / 1 wrong, held-out 46 / 0): k = 1 of the runs
 *  answering, strict (any run answering differently abstains), grounded quotes, applies. Env: AGENT_WF_K (1),
 *  AGENT_WF_STRICT (1), AGENT_WF_GROUND (1). */
export const wfPolicy = (runs: number): Policy => ({ k: Math.max(1, Math.min(runs, Number(process.env.AGENT_WF_K ?? 1))), strict: process.env.AGENT_WF_STRICT !== "0", ground: process.env.AGENT_WF_GROUND !== "0", applies: true });
/** Gates (b)–(e) over the votes. */
export function decide(votes: Vote[], spec: WfSpec, p: Policy): { answer: string | null; why: string } {
  if (p.applies && votes.some((v) => v.applies === false)) return { answer: null, why: "a run says the request is not this workflow's question" };
  const ok = votes.filter((v) => v.answer != null && matchesTokenFormat(v.answer, spec) && (!p.ground || v.grounded));
  const tally = new Map<string, number>(); for (const v of ok) tally.set(v.answer!, (tally.get(v.answer!) ?? 0) + 1);
  const best = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
  const distinct = new Set(votes.filter((v) => v.answer != null).map((v) => v.answer));
  if (!best) return { answer: null, why: "no run gave a grounded answer in the message's form: " + votes.map((v) => `${v.model.split("/").pop()}=${v.answer ?? "-"}${v.answer && !v.grounded ? "(ungrounded)" : ""}`).join(" ") };
  if (p.strict && distinct.size > 1) return { answer: null, why: "runs disagree: " + [...distinct].join(" / ") };
  if (best[1] < p.k) return { answer: null, why: `only ${best[1]} of ${votes.length} runs agree (need ${p.k})` };
  return { answer: best[0], why: "" };
}
/** The sentences of the message's Example section that state the example's facts: the text after the answer sentence
 *  ("The answer is `X`." / "Answer: `X`") up to the next heading, with every backticked copy of the answer removed. */
export function exampleFacts(spec: WfSpec): string | null {
  if (!spec.example) return null;
  const raw = spec.raw; const ans = spec.example.answer;
  const at = raw.search(new RegExp("(?:[Tt]he answer is|Answer:)\\s*`" + ans.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "`"));
  if (at < 0) return null;
  let rest = raw.slice(at).replace(/^(?:[Tt]he answer is|Answer:)\s*`[^`]*`\.?/, "");
  const stop = rest.search(/\n\s*#{1,6} |\n\s*\n\s*(?:From |---)/); if (stop >= 0) rest = rest.slice(0, stop);
  rest = rest.split("`" + ans + "`").join("(the answer)").trim();
  return rest.length >= 15 ? rest : null;
}
/** Gate (a), v2: the worked example reproduced from the message's own stated facts (no pages). */
export async function exampleGateText(spec: WfSpec, opts: { models: string[]; runner?: Runner; concurrency?: number; cls?: "text" | "background"; waitMs?: number }): Promise<{ ok: boolean | null; got: Array<string | null>; why: string; transient?: boolean }> {
  if (!spec.example) return { ok: null, got: [], why: "message has no worked example" };
  // The example's own stated facts as the page (the explanation after "The answer is `X`", the answer sentence itself
  // removed). With only a pointer to the message, runs often abstained for "the page the rule needs is missing" (shadow
  // loop-2: record-creator and problem-onset blocked, 1 of 3 runs answering).
  const facts = exampleFacts(spec);
  const g: Gathered = { pages: [facts ? { name: "Clinic pages for this request, as the workflow message's Example section records them (complete for this request)", text: `For this request the clinic's pages showed the following (the message's own record of them; every value the rule needs that it states is as on the pages, and today's date is after every date it mentions):\n${facts}` }
    : { name: "(none: the message's example section states the facts of its example)", text: "Use the facts the workflow message's Example section states for its own example." }] };
  const votes = await runVotes(spec, [], spec.example.request, g, opts);
  const want = spec.example.answer.trim().toUpperCase();
  // every run that answers gives the example's answer, and at least half of the runs answer (an abstaining run is not a misreading)
  // A run that got no reply (transport: hard timeout, rested model) is no verdict: the half is counted over the runs that
  // replied, and with fewer than two replies (of ≥ 2 runs) the gate fails as `transient` — the executor re-runs it on its
  // next task of this workflow (gather-jev-2: gemini's 12 s hard timeout at message time blocked no-show history's 3 tasks
  // with "example → 2 / / ").
  const replied = votes.filter((v) => !v.err);
  const answered = replied.filter((v) => v.answer != null);
  const transient = replied.length < Math.min(2, votes.length);
  const ok = !transient && answered.length >= Math.ceil(replied.length / 2) && answered.every((v) => v.answer!.trim().toUpperCase() === want);
  const show = votes.map((v) => v.err ? `(${v.err})` : v.answer ?? "").join(" / ");
  return { ok, got: votes.map((v) => v.answer), why: ok ? "" : `example → ${show} (want ${spec.example.answer})${transient ? " [transient: too few replies]" : ""}`, ...(transient ? { transient } : {}) };
}

export type ExecResult = { would: string | null; gates: { example: boolean | null; agree: boolean; format: boolean }; runs: Array<string | null>; why: string };

/** v1 (kept for workflowExec-bench): two independent runs + the format gate; example gate passed in. */
export async function applyWorkflow(spec: WfSpec, later: string[], request: string, g: Gathered, opts: { exampleOk: boolean | null; runner?: Runner; models?: string[] }): Promise<ExecResult> {
  const run = opts.runner ?? defaultRunner; const models = opts.models ?? wfModels();
  const gates = { example: opts.exampleOk, agree: false, format: false };
  if (!models.length) return { would: null, gates, runs: [], why: "no strong model listed" };
  if (!g.pages.length) return { would: null, gates, runs: [], why: "no pages gathered" + (g.why ? ": " + g.why : "") };
  const a = parseAnswer(await run(prompt(spec, later, request, g, 0), models[0]));
  const b = parseAnswer(await run(prompt(spec, later, request, g, 1), models[1] ?? models[0]));
  gates.agree = !!a && a === b;
  gates.format = !!a && matchesTokenFormat(a, spec);
  const ok = gates.agree && gates.format && gates.example === true;
  return { would: ok ? a : null, gates, runs: [a, b], why: ok ? "" : !a ? "model gave no answer" : !gates.agree ? `runs disagree: ${a} / ${b}` : !gates.format ? "answer not in the message's form: " + a : "worked example not reproduced" };
}

/** v1 gate (a): the worked example, reproduced from the example's own pages (both runs must give it). */
export async function exampleGate(spec: WfSpec, later: string[], g: Gathered, opts: { runner?: Runner; models?: string[] } = {}): Promise<{ ok: boolean; got: Array<string | null>; why: string }> {
  if (!spec.example) return { ok: false, got: [], why: "message has no worked example" };
  const r = await applyWorkflow(spec, [], spec.example.request, g, { exampleOk: true, ...opts });
  const want = spec.example.answer.trim().toUpperCase();
  const ok = r.runs.length === 2 && r.runs.every((x) => (x ?? "").trim().toUpperCase() === want);
  return { ok, got: r.runs, why: ok ? "" : `example → ${r.runs.join(" / ")} (want ${spec.example.answer})` };
}
