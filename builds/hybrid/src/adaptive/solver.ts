/**
 * The solver loop — one task in, one grounded answer (or skip) out.
 *
 *   signature → resolve intent (learned)
 *     has a plan?  → REPLAY it (fast, deterministic nav + one extract). grounded → answer.
 *     no plan / replay failed → AGENTIC ReAct loop with the tool set; on a grounded answer, INDUCE a
 *       plan and store it under this intent so the next same-intent question replays instead.
 *
 * Every answer passes the grounding gate; anything else is a skip. That keeps the aggressive agentic
 * exploration never-wrong: a wrong turn costs time and a 0, never a −1.
 */
import type { Solved } from "./types.js";
import type { ToolCtx, Tool } from "./tools.js";
import { TOOL_DEFS, TOOL_BY_NAME } from "./tools.js";
import { signature } from "./signature.js";
import { classify, step } from "./llm.js";
import { Knowledge } from "./memory.js";
import { induce, replay, type TraceStep } from "./plan.js";
import { acceptAnswer } from "./ground.js";
import { ShiftState } from "./state.js";
import { classifyKind } from "./triage.js";
import { answerReasoning } from "./reason.js";

const MAX_STEPS = Number(process.env.ADAPTIVE_MAX_STEPS ?? 5);

const SYSTEM = (context: string) => `You are a clinic back-office agent answering ONE question by navigating the live app with tools.
Rules:
- Find the answer by exploring: start at a relevant section (try goto "/" then follow links, or search_patient for a person), read pages/tables/documents.
- NEVER-WRONG: only call answer when you can quote, in evidence, text you actually saw that contains the value. If you cannot ground it, keep looking or give_up. A skip is free; a wrong answer is penalized.
- Be efficient: you have a limited number of steps. Prefer the most direct path.
- Answer with the exact value as printed (dates YYYY-MM-DD; money as printed; lists joined by ", ").
${context ? "\nKnown rules/facts for this clinic:\n" + context : ""}`;

/** The verbs and measures a question asks about (opened / created / changed / signed …, first / last / most / total / count …). */
const ASK = /\b(open|view|access|creat|add|enter|record|chang|edit|updat|modif|delet|remov|sign|approv|review|sen[dt]|mail|print|cancel|schedul|book|complet|bill|pa(?:y|id)|refer|order|first|last|latest|earliest|most|least|total|count|how many|number of|sum|average|oldest|newest|next|previous)/gi;
const askOf = (q: string) => [...new Set([...q.toLowerCase().matchAll(ASK)].map((m) => m[1]))].sort().join(",");
/** A learned plan replays only for a task with the same verbs / measures as the question it was learned from (no record → no replay). */
export const sameAsk = (task: string, learned?: string): boolean => !!learned && askOf(task) === askOf(learned);

export async function solve(question: string, ctx: ToolCtx, kb: Knowledge, state: ShiftState, deadlineMs: number): Promise<Solved> {
  const context = state.activeContext(question);

  // 0) TRIAGE: route before touching the site.
  const kind = await classifyKind(question, context);
  if (kind === "noise") return { skip: true, reason: "triage: not an answerable site question" };
  // baseline guard: the "reasoning" path answers from model passes with no page read (ungrounded) — no
  // live evidence it is never wrong (547c78e's model engine: Set 2 10 wrong, Set 3 9) → off unless ADAPTIVE_REASONING=1.
  if (kind === "reasoning" && process.env.ADAPTIVE_REASONING !== "1") return { skip: true, reason: "reasoning path disabled (ungrounded)" };
  if (kind === "reasoning") {
    const v = await answerReasoning(question, context);
    return v ? { answer: v, intent: "reasoning", via: "agentic" } : { skip: true, reason: "reasoning: passes did not corroborate" };
  }

  const sig = signature(question);
  const { intent } = await kb.resolveIntent(sig, classify, question);
  const cls = kb.get(intent);

  // 1) REPLAY a learned plan (fast path) — unless a governing rule changed since it was learned, in
  //    which case the saved decision may no longer hold → re-solve under the current rule.
  // (and only when the task asks the same thing the plan was learned for: its own verbs / measures match — gather bench: a learned
  // "who created the record" plan answered "who last OPENED the chart")
  if (cls?.plan && !state.rulesChangedSince(cls.plan.ruleMark ?? 0) && sameAsk(question, cls.plan.question)) {
    const v = await replay(cls.plan, question, sig.slots, ctx, context).catch(() => null);
    if (v) { kb.win(intent); return { answer: v, intent, via: "replay" }; }
    kb.loss(intent); // plan didn't ground here → may be dropped; fall through to re-solve
  }

  // 2) AGENTIC ReAct loop — learn how to answer this intent on this clinic.
  const history: Array<{ role: string; content: any; tool_call_id?: string; name?: string }> = [
    { role: "user", content: `Question: ${question}\n\nSlots: ${sig.slots.map((s) => `${s.role}=${s.value}`).join(", ") || "(none)"}` },
  ];
  const trace: TraceStep[] = [];
  const observations: TraceStep["obs"][] = [];
  for (let i = 0; i < MAX_STEPS; i++) {
    if (Date.now() > deadlineMs) return { skip: true, reason: "out of time", intent };
    const call = await step(SYSTEM(context), history, TOOL_DEFS);
    if (!call) return { skip: true, reason: "model gave no action", intent };
    const tool: Tool | undefined = TOOL_BY_NAME.get(call.name);
    if (!tool) { history.push(asst(call), toolMsg(call, "unknown tool")); continue; }
    if (call.name === "give_up") return { skip: true, reason: String(call.args.reason || "agent gave up"), intent };
    if (call.name === "answer") {
      const obs = await tool.run(ctx, call.args);
      trace.push({ tool: call.name, args: call.args, obs });
      const value = acceptAnswer(obs, observations);
      if (value) {
        kb.setPlan(intent, { ...induce(question, sig.slots, trace, state.ruleMark()), question }); kb.win(intent);
        return { answer: value, intent, via: "agentic" };
      }
      // ungrounded → tell the model and let it keep going (don't accept a hallucination)
      history.push(asst(call), toolMsg(call, "REJECTED: that value is not grounded in anything you read. Keep exploring or give_up."));
      continue;
    }
    const obs = await tool.run(ctx, call.args).catch((e) => ({ tool: call.name, text: "error: " + String(e).slice(0, 80), ok: false }));
    trace.push({ tool: call.name, args: call.args, obs });
    observations.push(obs);
    history.push(asst(call), toolMsg(call, obs.text));
  }
  return { skip: true, reason: "step budget exhausted without a grounded answer", intent };
}

const asst = (c: { id: string; name: string; args: any }) => ({ role: "assistant", content: "", tool_calls: [{ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }] } as any);
const toolMsg = (c: { id: string; name: string }, text: string) => ({ role: "tool", tool_call_id: c.id, name: c.name, content: text } as any);
