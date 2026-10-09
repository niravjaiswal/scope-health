/**
 * Plan induction + replay — the "builds a deterministic model along the way" half.
 *
 * INDUCE: after the agentic loop grounds an answer, turn the successful trajectory into a reusable
 * recipe. Concrete slot values in each tool's args are replaced by their ROLE, and the runtime-
 * resolved patient path is replaced by {PATIENT}, so the recipe re-binds to a new question. The final
 * read is remembered as how the answer was extracted (document / table / page-text).
 *
 * REPLAY: for a later question of the same intent, re-bind the roles and run the nav/resolve steps
 * deterministically (no exploration — "it knows where to go"), then do ONE cheap Haiku extract on the
 * page it lands on. Grounded → answer; anything off (site changed, value absent) → null → the caller
 * falls back to a fresh agentic solve and repairs the plan.
 */
import type { Plan, PlanStep, Slot, Observation } from "./types.js";
import type { ToolCtx } from "./tools.js";
import { TOOL_BY_NAME } from "./tools.js";
import { extract as llmExtract } from "./llm.js";
import { grounded } from "./ground.js";

export interface TraceStep { tool: string; args: Record<string, any>; obs: Observation }

const patientPath = (obs: Observation): string | undefined => (obs.tool === "search_patient" && obs.ok ? (obs.text.match(/\/patients\/[A-Za-z0-9]+/) || [])[0] : undefined);
const roleKeyFor = (slots: Slot[]) => { const seen: Record<string, number> = {}; return slots.map((s) => { const n = (seen[s.role] = (seen[s.role] ?? 0) + 1); return { ...s, key: n === 1 ? `{${s.role}}` : `{${s.role}${n}}` }; }); };

/** Build a Plan from a grounded trajectory. Only successful, non-terminal steps become plan steps.
 *  `ruleMark` records how many governing rules were active at learn time, so a later rule change
 *  invalidates blind replay (the caller re-solves under the new rule). */
export function induce(question: string, slots: Slot[], trace: TraceStep[], ruleMark = 0): Plan {
  const keyed = roleKeyFor(slots);
  const patient = trace.map((t) => patientPath(t.obs)).find(Boolean);
  const templ = (v: string): string => {
    let out = v;
    if (patient && out.includes(patient)) out = out.replace(patient, "{PATIENT}");
    for (const k of keyed) if (k.value && out === k.value) return k.key; // exact-value args → role token
    for (const k of keyed) if (k.value && out.includes(k.value)) out = out.split(k.value).join(k.key);
    return out;
  };
  const steps: PlanStep[] = [];
  for (const t of trace) {
    if (!t.obs.ok) continue;
    if (t.tool === "answer" || t.tool === "give_up" || t.tool === "read_text" || t.tool === "links") continue;
    const args: Record<string, string> = {};
    for (const [k, v] of Object.entries(t.args)) args[k] = templ(String(v ?? ""));
    steps.push({ tool: t.tool, args });
  }
  const last = [...trace].reverse().find((t) => t.obs.ok && (t.tool === "read_document" || t.tool === "read_table"));
  const extract: Plan["extract"] = last?.tool === "read_document" ? { kind: "document", hint: question } : last?.tool === "read_table" ? { kind: "table", hint: String(last.args.match ?? "") } : { kind: "model", hint: question };
  return { steps, extract, ruleMark };
}

/** Replay a Plan for a new question. Returns a grounded answer or null (→ caller re-solves agentic).
 *  `context` carries the current rules/facts so the final extract answers under them. */
export async function replay(plan: Plan, question: string, slots: Slot[], ctx: ToolCtx, context = ""): Promise<string | null> {
  const keyed = roleKeyFor(slots);
  const bind: Record<string, string> = {}; for (const k of keyed) bind[k.key] = k.value;
  let patientHref: string | undefined;
  const sub = (v: string): string => { let out = v; for (const [key, val] of Object.entries(bind)) out = out.split(key).join(val); if (patientHref) out = out.split("{PATIENT}").join(patientHref); return out; };
  const obs: Observation[] = [];
  for (const st of plan.steps) {
    const tool = TOOL_BY_NAME.get(st.tool); if (!tool) return null;
    const args: Record<string, any> = {}; for (const [k, v] of Object.entries(st.args)) args[k] = sub(v);
    if (st.tool !== "search_patient" && /\{PATIENT\}/.test(JSON.stringify(args))) return null; // needed a patient we never resolved
    const o = await tool.run(ctx, args).catch(() => null); if (!o || !o.ok) return null;
    obs.push(o);
    const pp = patientPath(o); if (pp) patientHref = pp;
  }
  // Final extraction on what we landed on.
  let value: string | null = null;
  if (plan.extract.kind === "document") { const d = [...obs].reverse().find((o) => o.tool === "read_document"); value = d ? (d.text.match(/document value:\s*(.+)/)?.[1]?.trim() ?? null) : null; }
  else { const text = plan.extract.kind === "table" ? obs.filter((o) => o.tool === "read_table").map((o) => o.text).join("\n") : await ctx.crawler.decodedText().catch(() => ""); value = await llmExtract(question, text, context); if (value) obs.push({ tool: "extract", text, ok: true }); }
  if (!value) return null;
  return grounded(value, obs) ? value : null;
}
