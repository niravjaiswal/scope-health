/**
 * Haiku 5.5 wrappers for the adaptive agent, over the shared failover transport. Two jobs:
 *  (1) classify(): name a question's INTENT (semantic) so rephrasings across sets unify to one
 *      learned class — this is what the pre-baked family catalog used to do, now learned at runtime.
 *  (2) step(): one turn of a ReAct loop — given the question + observations so far + the tool menu,
 *      pick the next tool call (or answer/give_up). Forced tool call → always structured.
 *
 * Reasoning model is Haiku 5.5 (fast enough to run a multi-step loop per unknown question). Vision is
 * reused from the wrenfield reader (askDocument) so document questions share one OCR path.
 */
import { chat } from "../wrenfield/failover.js";

const MODEL = () => process.env.AGENT_MODEL ?? "anthropic/claude-haiku-5.5";

export interface ToolCall { id: string; name: string; args: Record<string, any> }

/** Name the question's intent + a one-line description of what answer it wants. Short, stable labels
 *  (snake_case) so the same label recurs for the same semantic question however it's phrased. */
export async function classify(question: string, knownIntents: string[]): Promise<{ intent: string; wants: string } | null> {
  const sys = `You label the INTENT of a back-office clinic question so that differently-worded questions asking the same thing get the SAME label. Reply ONLY via emit. Use an existing label when the question means the same as one; otherwise coin a new short snake_case label.`;
  const tool = { type: "function", function: { name: "emit", description: "Emit the intent label and what it asks for.",
    parameters: { type: "object", properties: {
      intent: { type: "string", description: "short snake_case label, reused across rephrasings" },
      wants: { type: "string", description: "one line: what value/answer the question asks for" },
    }, required: ["intent", "wants"] } } };
  try {
    const j: any = await chat({ max_tokens: 120, messages: [
      { role: "system", content: sys },
      { role: "user", content: `Existing labels: ${knownIntents.length ? knownIntents.join(", ") : "(none yet)"}\n\nQuestion: ${question}` },
    ], tools: [tool], tool_choice: { type: "function", function: { name: "emit" } } }, { primary: MODEL(), waitMs: 15000 });
    const a = JSON.parse(j.choices[0].message.tool_calls[0].function.arguments);
    const intent = String(a.intent || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    return intent ? { intent, wants: String(a.wants || "") } : null;
  } catch { return null; }
}

/** One ReAct turn. `history` is the running transcript (prior tool calls + observations). `toolDefs`
 *  is the OpenAI-style tool menu. Returns the model's chosen tool call, or null on transport failure. */
export async function step(system: string, history: Array<{ role: string; content: any; tool_call_id?: string; name?: string }>, toolDefs: any[]): Promise<ToolCall | null> {
  try {
    const j: any = await chat({ max_tokens: 500, messages: [{ role: "system", content: system }, ...history], tools: toolDefs, tool_choice: "required" }, { primary: MODEL(), waitMs: 20000 });
    const tc = j?.choices?.[0]?.message?.tool_calls?.[0];
    if (!tc) return null;
    let args: Record<string, any> = {};
    try { args = JSON.parse(tc.function.arguments || "{}"); } catch { args = {}; }
    return { id: tc.id || "call", name: tc.function.name, args };
  } catch { return null; }
}

/** Extract ONE value from page text for a question, grounded: returns a value that appears in `text`
 *  or null. Used by replay (the fast path) so a learned plan's final read is one cheap call, and as a
 *  fallback extractor in the agentic loop. */
export async function extract(question: string, text: string, context = ""): Promise<string | null> {
  const sys = `Answer the question using ONLY the text (and any rules in the context). Copy the exact value as printed (for a list, join with ", "). Apply any governing rule in the context exactly. If it is not clearly present/derivable, reply exactly NONE. Reply with ONLY the value.`;
  try {
    const j: any = await chat({ max_tokens: 120, messages: [
      { role: "system", content: sys },
      { role: "user", content: `${context ? "CONTEXT:\n" + context.slice(0, 3000) + "\n\n" : ""}TEXT:\n${text.slice(0, 7000)}\n\nQUESTION: ${question}\n\nValue (or NONE):` },
    ] }, { primary: MODEL(), waitMs: 15000 });
    let t = (j?.choices?.[0]?.message?.content ?? "").toString().trim().replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/i, "").replace(/^["'`]+|["'`]+$/g, "").trim();
    return !t || /^none$/i.test(t) ? null : t;
  } catch { return null; }
}
