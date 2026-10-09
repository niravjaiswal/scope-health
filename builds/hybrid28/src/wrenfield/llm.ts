import type { QueryPlan } from "./inference.js";
import { chat } from "./failover.js";

/** Model tier: translate a NOVEL question into a QueryPlan via the shift's
 *  OpenAI-compatible endpoint (LLM_BASE_URL/LLM_API_KEY). Called once per novel
 *  template (the Classifier memoizes the result). Forced tool call → validated JSON. */
const BASE = () => process.env.LLM_BASE_URL;
const KEY = () => process.env.LLM_API_KEY;
const MODEL = () => process.env.AGENT_MODEL ?? "anthropic/claude-haiku-4.5";

const SYSTEM = `Translate a clinic back-office question into a QueryPlan over a fixed schema. Reply ONLY via emit_plan.
Entities: patient | provider | appointment | invoice | document | aggregate.
Ops: lookup | count | sum | extreme | rule.
Known fields: demographics.phone, demographics.email, demographics.address, dob, specialty, document.referral.source, appointment.next.
Entities (patient/provider/date/status) are already extracted by the caller; you only pick entity, op, output.field, answerType.
answerType: whole | decimal | date | datetime | phone | text | list.`;

const TOOL = {
  type: "function",
  function: {
    name: "emit_plan",
    description: "Emit the structured query plan.",
    parameters: {
      type: "object",
      properties: {
        entity: { type: "string", enum: ["patient", "provider", "appointment", "invoice", "document", "aggregate"] },
        op: { type: "string", enum: ["lookup", "count", "sum", "extreme", "rule"] },
        field: { type: "string" },
        answerType: { type: "string", enum: ["whole", "decimal", "date", "datetime", "phone", "text", "list"] },
      },
      required: ["entity", "op", "answerType"],
    },
  },
};

const VISION_MODEL = () => process.env.AGENT_VISION_MODEL ?? MODEL();
const VISION_SYSTEM = `You read ONE clinical document shown as an image (often a lab report) and extract a single exact value. Be precise and literal: copy digits, units, IDs, dates, and names exactly as printed. Never guess, infer, or explain. Reply ONLY with a JSON object: {"value":"<the exact value>"} when it is clearly present, or {"value":null} when it is absent or you are not certain.`;

/** Read one value out of a document image (screenshot) via the OpenAI-compatible vision API.
 *  Returns the extracted value, or null when absent/uncertain/on any error → the caller skips.
 *  Hardened against the model leaking a prose "it's not here" explanation as if it were a value. */
export async function askDocument(question: string, pngBase64: string, onFail?: (cause: string) => void, model?: string): Promise<string | null> {
  if (!BASE() || !KEY()) { onFail?.("transport: no endpoint"); return null; }
  const body = {
    // answers are short values (≤ 80 chars pass the guard below); gemini / gpt spend output tokens on `reasoning: low` first,
    // so they get room for it (practice reason letter 2026-10-08: gemini's content came back EMPTY at 64 tokens)
    model: model ?? VISION_MODEL(), max_tokens: /^(google|openai)\//.test(model ?? VISION_MODEL()) ? 512 : 64,
    messages: [
      { role: "system", content: VISION_SYSTEM },
      { role: "user", content: [
        { type: "text", text: `Question: ${question}\n\nReturn ONLY {"value":"<exact value copied from the document; for a measurement use the number in its result field>"} or {"value":null} if it is not on this document or you are not sure. No prose.` },
        { type: "image_url", image_url: { url: `data:image/png;base64,${pngBase64}` } },
      ] },
    ],
  };
  try {
    const { model, ...rest } = body;
    // this model or nothing (fallbacks: []): the document pair's agreement rule needs two DIFFERENT models (index-builder
    // readDocument); gemini / gpt get `reasoning: low` (without it gemini thinks for 11–30 s). Hard timeout: failover HARD_MS image.
    const j: any = await chat({ ...rest, ...(/^(google|openai)\//.test(model) ? { reasoning: { effort: process.env.AGENT_VISION_REASONING ?? "low" } } : {}) }, { primary: model, fallbacks: [], attempts: 2, waitMs: 20000, cls: "image", onFail: (c) => { onFail?.(`transport: ${c}`); try { process.stderr.write(JSON.stringify({ event: "llm", kind: "read_fail", model, role: "document", cause: c }) + "\n"); } catch {} } });
    if (!j) return null;
    let t = (j.choices?.[0]?.message?.content ?? "").toString().trim();
    t = t.replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/i, "").trim();
    // Prefer the JSON value; fall back to raw text if the model didn't use JSON.
    let v: string | null = null;
    const m = t.match(/"value"\s*:\s*(null|"((?:[^"\\]|\\.)*)")/i);
    if (m) v = m[1].toLowerCase() === "null" ? null : m[2].replace(/\\"/g, '"');
    else v = t;
    // why a read gave no value (the next Set 1 log can audit the reader): the raw reply head, never the question
    const reject = (reason: string) => { try { process.stderr.write(JSON.stringify({ event: "llm", kind: "doc_reject", model, reason, head: t.slice(0, 120) }) + "\n"); } catch {} return null; };
    if (v == null) return reject("value null");
    v = v.trim().replace(/^["'`]+|["'`]+$/g, "").trim();
    // never-wrong guards: a real field value is short and single-line. Reject NONE/empty, any
    // multi-line/prose answer, or obvious "not present" explanations → skip rather than risk −1.
    if (!v || /^(none|null|n\/a|unknown)$/i.test(v)) return reject("empty / none");
    if (v.includes("\n") || v.length > 80) return reject(v.includes("\n") ? "multi-line" : `too long (${v.length})`);
    if (/\b(not (present|include|listed|shown|found|available|certain)|does not|isn't|is not|typically|no such|unable to|cannot|can't)\b/i.test(v)) return reject("prose / not-present");
    return v;
  } catch { return null; }
}

/** The document pair (index-builder readDocument: referral source / reason). Two independent reads must agree exactly —
 *  a single vision misread is a wrong answer. The pair is CROSS-PROVIDER from the start: haiku-5.5 + gemini-3.8-flash
 *  (under the transport's image hard timeout), haiku-4.5 as the substitute when one of them fails in transport (judged
 *  practice td750384c4e29 + MODEL-BENCH: the two haikus over-read the same way, gemini does not). Sequential: the judge
 *  proxy allows one request in flight. A read that failed in transport (no free slot, hard timeout, HTTP error: no model
 *  answer at all) is retried once on the same model, then once on the substitute; a model that answered "no value" is not
 *  asked again. AGENT_DOC_MODEL_A / _B override the pair. */
export async function askDocumentPair(question: string, pngBase64: string, why: (s: string) => void = () => {}): Promise<string | null> {
  const { isListed, usable } = await import("./failover.js");
  const same = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const H5 = "anthropic/claude-haiku-5.5", H4 = "anthropic/claude-haiku-4.5", G = "google/gemini-3.8-flash";
  const pick = (...ms: string[]) => ms.find((m) => isListed(m) && usable(m)) ?? H4;
  const first = process.env.AGENT_DOC_MODEL_A ?? pick(H5, H4), second = process.env.AGENT_DOC_MODEL_B ?? pick(G, first === H4 ? H5 : H4);
  const substitute = [H4, H5, G].find((m) => m !== first && m !== second && usable(m)) ?? H4;
  const ask = async (model: string) => {
    let cause = "";
    let v = await askDocument(question, pngBase64, (c) => { cause = c; }, model).catch(() => null);
    if (!v && cause.startsWith("transport")) {
      try { process.stderr.write(JSON.stringify({ event: "llm", kind: "read_fail", role: "document", model, cause, retry: true }) + "\n"); } catch {}
      cause = ""; v = await askDocument(question, pngBase64, (c) => { cause = c; }, model).catch(() => null);
    }
    if (!v && cause.startsWith("transport") && substitute !== model) {
      try { process.stderr.write(JSON.stringify({ event: "llm", kind: "read_fail", role: "document", model, cause, substitute }) + "\n"); } catch {}
      cause = ""; v = await askDocument(question, pngBase64, (c) => { cause = c; }, substitute).catch(() => null);
    }
    return { v, cause };
  };
  // The two reads are independent and both always needed (a first read with no value ends the task, which wastes the
  // second call only): asked together they cost one model round trip (~2.5 s) instead of two. AGENT_DOC_PARALLEL=0: one after the other.
  const par = process.env.AGENT_DOC_PARALLEL !== "0";
  const pb = par ? ask(second) : null; if (pb) pb.catch(() => {});
  const ra = await ask(first), a = ra.v; if (!a) { why(`vision: first read found no value${ra.cause ? ` (${ra.cause})` : ""}`); return null; }
  let rb = await (pb ?? ask(second)), b = rb.v, pair = `${first.split("/").pop()}+${second.split("/").pop()}`;
  // the cross-provider second reader ABSTAINED (answered no value, not a transport failure — MODEL-BENCH: gemini abstains
  // on ~4 % of readable fields; practice reason letter 2026-10-08): the substitute reads instead. That degrades the pair
  // to two Anthropic models (the 243 run's live pair: referral-reason 5/5 on Set 1) only for this document; logged.
  // AGENT_DOC_PAIR_FALLBACK=0 keeps the strict cross-provider pair (a gemini abstention is then a skip).
  if (!b && !rb.cause && substitute !== second && substitute !== first && process.env.AGENT_DOC_PAIR_FALLBACK !== "0") {
    try { process.stderr.write(JSON.stringify({ event: "llm", kind: "doc_pair", second, abstained: true, substitute }) + "\n"); } catch {}
    rb = await ask(substitute); b = rb.v; pair = `${first.split("/").pop()}+${substitute.split("/").pop()} (${second.split("/").pop()} abstained)`;
  }
  if (!b) { why(`vision: second read found no value${rb.cause ? ` (${rb.cause})` : ""}`); return null; }
  if (same(a) !== same(b)) { why(`vision: reads disagree ("${a.slice(0, 40)}" vs "${b.slice(0, 40)}")`); return null; }
  try { process.stderr.write(JSON.stringify({ event: "llm", kind: "doc_pair", pair, agreed: true }) + "\n"); } catch {}
  return a;
}

/** Extract a flat JSON object of fields from a document image (e.g. a lab report's test values +
 *  collected date + record/report numbers). Returns the parsed object or null. The caller does the
 *  consensus (multiple varied calls must agree) and the clinical decision — the model only reads. */
export async function askDocumentJSON(instruction: string, pngBase64: string): Promise<Record<string, string> | null> {
  if (!BASE() || !KEY()) return null;
  const body = {
    model: VISION_MODEL(), max_tokens: 400,
    messages: [
      { role: "system", content: `You transcribe ONE clinical document shown as an image. Copy numbers, dates, and IDs EXACTLY as printed — never round, infer, or compute. Reply ONLY with a flat JSON object of string values. Omit any field you cannot read with certainty (do not guess).` },
      { role: "user", content: [
        { type: "text", text: instruction + `\n\nReturn ONLY a flat JSON object, e.g. {"Sodium":"145","Potassium":"5.0"}. Omit fields not clearly legible. No prose, no nesting.` },
        { type: "image_url", image_url: { url: `data:image/png;base64,${pngBase64}` } },
      ] },
    ],
  };
  try {
    const { model, ...rest } = body;
    const j: any = await chat(rest, { primary: model, waitMs: 25000, cls: "image" });
    let t = (j?.choices?.[0]?.message?.content ?? "").toString().trim().replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/i, "").trim();
    const s = t.indexOf("{"), e = t.lastIndexOf("}"); if (s < 0 || e < s) return null;
    const obj = JSON.parse(t.slice(s, e + 1));
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) if (v != null && typeof v !== "object") { const sv = String(v).trim(); if (sv && !/^(none|null|n\/a)$/i.test(sv)) out[k] = sv; }
    return out;
  } catch { return null; }
}

/** Model-compile a back-office MESSAGE into a state change (runs between tasks, off the hot path).
 *  The agent keeps a state machine of rules+facts; a message can amend the new/established rule,
 *  state a fact later tasks read, define a rule family we can't execute (→ govern), or be noise. */
const MSG_SYSTEM = `You convert a clinic back-office MESSAGE into a structured state change for an agent. The agent already implements ONE workflow: "billing.new-or-established" (new vs established patient visits), with these parameters: windowYears (int), excluded (list of service names that never make a patient established), statuses (which appointment statuses count, default ["Completed"]), matchProvider (bool), matchSpecialty (bool).
Classify the message and reply ONLY via emit_message:
- kind "amendment": it CHANGES the new/established workflow. Fill target "billing.new-or-established" and changes: any of windowYears, addExcluded[], removeExcluded[], setStatuses[], matchProvider, matchSpecialty.
- kind "fact": it states a durable fact later tasks need (e.g. a provider's specialty, a provider left, a config default). Fill fact: {subject, predicate, value} (subject = the entity name; predicate = short attribute like "specialty"; value = the value).
- kind "workflow": it defines a NEW kind of task-rule that is NOT new/established (some other computed answer). Fill scope with a few keywords describing the tasks it governs.
- kind "noise": irrelevant to the work (announcements, chit-chat).`;

const MSG_TOOL = {
  type: "function",
  function: {
    name: "emit_message",
    description: "Emit the structured state change for this message.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["amendment", "fact", "workflow", "noise"] },
        target: { type: "string" },
        changes: { type: "object", properties: { windowYears: { type: "number" }, addExcluded: { type: "array", items: { type: "string" } }, removeExcluded: { type: "array", items: { type: "string" } }, setStatuses: { type: "array", items: { type: "string" } }, matchProvider: { type: "boolean" }, matchSpecialty: { type: "boolean" } } },
        fact: { type: "object", properties: { subject: { type: "string" }, predicate: { type: "string" }, value: {} } },
        scope: { type: "array", items: { type: "string" } },
      },
      required: ["kind"],
    },
  },
};

export type CompiledMsg = { kind: "amendment" | "fact" | "workflow" | "noise"; target?: string; changes?: any; fact?: { subject: string; predicate: string; value: unknown }; scope?: string[] };
export async function compileMessage(text: string): Promise<CompiledMsg | null> {
  if (!BASE() || !KEY()) return null;
  try {
    const j: any = await chat({ max_tokens: 300, messages: [{ role: "system", content: MSG_SYSTEM }, { role: "user", content: `Message:\n${text}` }], tools: [MSG_TOOL], tool_choice: { type: "function", function: { name: "emit_message" } } }, { primary: MODEL(), waitMs: 20000, cls: "compile" });
    if (!j) return null;
    return JSON.parse(j.choices[0].message.tool_calls[0].function.arguments);
  } catch { return null; }
}

/** Generalist fallback: answer a question using ONLY the provided chart text. Used when the
 *  deterministic solvers can't handle the question/clinic. The caller VERIFIES the answer is
 *  grounded in the context before using it, so a hallucination becomes a skip, not a wrong answer. */
export async function answerFromContext(question: string, context: string): Promise<string | null> {
  if (!BASE() || !KEY()) return null;
  const sys = `You answer a clinic back-office question using ONLY the chart text provided. Extract the exact value as it appears (copy it verbatim; for a list, join with commas). Do NOT compute, guess, or use outside knowledge. If the answer is not clearly present in the text, reply exactly: NONE. Reply with ONLY the value — no words, labels, or punctuation around it.`;
  try {
    const j: any = await chat({ max_tokens: 120, messages: [{ role: "system", content: sys }, { role: "user", content: `CHART:\n${context}\n\nQUESTION: ${question}\n\nAnswer (exact value, or NONE):` }] }, { primary: MODEL(), waitMs: 15000 });
    if (!j) return null;
    let t = (j.choices?.[0]?.message?.content ?? "").toString().trim();
    t = t.replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/i, "").trim().replace(/^["'`]+|["'`]+$/g, "").trim();
    return !t || /^none$/i.test(t) ? null : t;
  } catch { return null; }
}

export async function translateToPlan(text: string): Promise<QueryPlan> {
  if (!BASE() || !KEY()) throw new Error("model tier unavailable (no LLM_BASE_URL/KEY)");
  const j: any = await chat({ max_tokens: 200, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: `Question: ${text}` }], tools: [TOOL], tool_choice: { type: "function", function: { name: "emit_plan" } } }, { primary: MODEL(), waitMs: 15000 });
  if (!j) throw new Error("LLM unavailable");
  const a = JSON.parse(j.choices[0].message.tool_calls[0].function.arguments);
  return { type: `model.${a.entity}.${a.op}.${a.field ?? ""}`, entity: a.entity, op: a.op, output: { field: a.field, answerType: a.answerType }, ruleType: a.op === "rule" ? "billing.new-or-established" : undefined };
}
