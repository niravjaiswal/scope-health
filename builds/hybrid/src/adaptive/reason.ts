/**
 * Pure-inference answers — for questions that don't touch the site (arithmetic, general knowledge, or
 * "apply the rule stated earlier"). There's no page to ground against, so the never-wrong gate here is
 * CORROBORATION: two independent Haiku passes (different prompts/framing) must land on the same
 * normalized answer. Agree → answer; disagree or either abstains → skip. For deterministic questions
 * (math, a rule lookup) two passes agree reliably; for anything the model is unsure about they won't,
 * so we skip instead of guessing.
 */
import { chat } from "../wrenfield/failover.js";

const MODEL = () => process.env.AGENT_MODEL ?? "anthropic/claude-haiku-5.5";
const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");

async function once(question: string, context: string, framing: string): Promise<string | null> {
  const sys = `Answer the request precisely using ONLY arithmetic, well-established general knowledge, and the context provided. ${framing} If the answer is not certain and determinable, reply exactly NONE. Reply with ONLY the final value — no working, no words around it.`;
  try {
    const j: any = await chat({ max_tokens: 200, messages: [
      { role: "system", content: sys },
      { role: "user", content: `${context ? "Context:\n" + context.slice(0, 4000) + "\n\n" : ""}Request: ${question}\n\nValue (or NONE):` },
    ] }, { primary: MODEL(), waitMs: 15000 });
    let t = (j?.choices?.[0]?.message?.content ?? "").toString().trim().replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/i, "").replace(/^["'`]+|["'`]+$/g, "").trim();
    return !t || /^none$/i.test(t) ? null : t;
  } catch { return null; }
}

/** Two independent passes must agree (normalized) → that shared answer; else null (skip). */
export async function answerReasoning(question: string, context: string): Promise<string | null> {
  const a = await once(question, context, "Compute the exact result.");
  if (!a) return null;
  const b = await once(question, context, "Work it out carefully and independently; do not assume any particular answer.");
  if (!b) return null;
  return norm(a) === norm(b) ? a : null;
}
