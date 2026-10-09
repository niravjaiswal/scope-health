/**
 * Triage — decide HOW a task should be answered before touching the site.
 *
 *   site      : needs data from the clinic app (a patient, a schedule, a document) → the agentic/replay solver.
 *   reasoning : self-contained — arithmetic, general knowledge, or answerable purely from the rules/
 *               facts/earlier-answers already in context ("what's 1+1", "per the rule above, what is X").
 *   noise     : not an answerable question (chit-chat, a remark, something with no determinable answer) → skip.
 *
 * A cheap deterministic pre-check catches the obvious reasoning cases (bare arithmetic, no proper
 * nouns / no site vocabulary) without an LLM; everything else asks Haiku once.
 */
import { chat } from "../wrenfield/failover.js";

const MODEL = () => process.env.AGENT_MODEL ?? "anthropic/claude-haiku-5.5";
export type Kind = "site" | "reasoning" | "noise";

// bare arithmetic / "what is X" with only numbers+operators → reasoning, no LLM needed.
const ARITH = /^[^a-z]*what(?:'s| is)?\s+[-+\d\s().*/x×÷]+\??$/i;
const PURE_MATH = /^[\s\d().+\-*/x×÷=?]+$/;

export async function classifyKind(question: string, context: string): Promise<Kind> {
  const q = question.trim();
  if (PURE_MATH.test(q) || ARITH.test(q)) return "reasoning";
  const sys = `Classify how a back-office request should be handled. Reply ONLY via emit.
- "site": answering needs data from the clinic application (a specific patient, appointment, claim, invoice, document, schedule, provider).
- "reasoning": self-contained — arithmetic, general knowledge, or fully answerable from the provided rules/facts/earlier answers, with NO clinic lookup.
- "noise": not an answerable question (a remark, chit-chat, or nothing with a determinable answer).`;
  const tool = { type: "function", function: { name: "emit", description: "Emit the handling kind.", parameters: { type: "object", properties: { kind: { type: "string", enum: ["site", "reasoning", "noise"] } }, required: ["kind"] } } };
  try {
    const j: any = await chat({ max_tokens: 60, messages: [
      { role: "system", content: sys },
      { role: "user", content: `${context ? "Context available:\n" + context.slice(0, 2000) + "\n\n" : ""}Request: ${q}` },
    ], tools: [tool], tool_choice: { type: "function", function: { name: "emit" } } }, { primary: MODEL(), waitMs: 12000 });
    const k = JSON.parse(j.choices[0].message.tool_calls[0].function.arguments).kind;
    return k === "reasoning" || k === "noise" ? k : "site";
  } catch { return "site"; } // uncertain → treat as a site question (the grounding gate still protects us)
}
