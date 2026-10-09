/** Gate for Baseline adaptive runtime-learning fallback (src/adaptive). It has live evidence only on few tasks
 *  (: 0 answers on Set 1, Sets 2/3 mostly not reached), so it gets the same guards as our generalist:
 *   - only a task no family recognises (a recognised family's reader answers it or nobody does);
 *   - never a question in a solved family's domain, nor counts / dates / deadlines / rule outcomes / money /
 *     identifiers (generalistBlocked) — the reworded and near-miss forms of our families stay skips;
 *  and in shiftMain: never on a pacer skip or when behind pace, ≤ 12 s per task; its ungrounded "reasoning"
 *  path is off (adaptive/solver.ts). Returns "" when the fallback may run, else why not. */
import { generalistBlocked } from "./inference.js";
import { toPlan } from "./run.js";
/** Answers the adaptive layer may never send: empty-state / yes-no tokens (set2-hyp: "None on file" → −1). */
export function adaptiveAnswerOk(a: string): boolean { return !/^\s*(none|no|yes|n\/?a|unknown|not (found|listed|on file)|-|—)\b/i.test(a) && a.trim().length > 0; }
export function adaptiveGate(text: string, family: string | null): string {
  if (family) return `family ${family} recognised: its reader answers or nobody does`;
  const g = generalistBlocked(text); if (g) return "adaptive: " + g;
  // our keyword planner / chart answerers recognised the question: they answer or deliberately decline
  // (local set2-hyp: adaptive answered a primary-provider question chartAnswers declines on format → −1)
  const p = toPlan(text); if (p) return `adaptive: planned as ${p.type} (ours answers or declines)`;
  // yes/no questions: near-misses of field lookups (set2-hyp "Is X female?" → adaptive said "No" → −1)
  if (/^\s*(is|are|does|do|did|was|were|has|have|had|can|could|will|should)\b/i.test(text)) return "adaptive: yes/no question";
  // identifiers the generalist list words differently (variants: "telephone number in X's chart")
  if (/\b(tele)?phone\b|\bcell\b|\bmobile\b|\bcontact number\b|\bnumber on file\b|\be-?mail\b|\baddress\b/i.test(text)) return "adaptive: never copies contact identifiers";
  return "";
}
