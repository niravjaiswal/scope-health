/**
 * Memo router: which acknowledged workflow memo (policy message) does a task belong to — asked of Jev (decisions.ts)
 * as ONE `choice` question, for a task no deterministic family claimed and the lexical router (wfShadow.wfFor) left
 * unrouted. The hidden sets deliver their workflows as memos and ask their tasks in varied wording; `wfFor` matches
 * title / example tokens and barely fires there (HANDOFF.md §4).
 *
 * Options = one per memo (title + first rule sentence + the memo's answer tokens + its example request) and "none of
 * these". The task is routed to a memo only when that option's probability ≥ AGENT_WF_ROUTE_P (0.8) AND the runner-up
 * (any other option, "none" included) ≤ AGENT_WF_ROUTE_P2 (0.2, measured: JEV-ROUTER.md §5); otherwise unrouted. Routing only picks the memo: the
 * executor's own gates (worked-example reproduction, quoted evidence, format, agreement, applies) are unchanged, so a
 * misroute costs model time, not a wrong answer. Thresholds are measured by wfRoute-bench.ts (JEV-ROUTER.md).
 *
 * Every routing decision logs {"event":"wf_route"} with the probabilities (routed or not), so a shift log tells the
 * funnel: tasks seen → routed by words → routed by Jev → executed → answered. Flag: AGENT_WF_ROUTER=jev|off (off here;
 * the integrator turns it on). Fail closed: no reply → unrouted.
 */
import { choose, type Choice } from "./decisions.js";
import type { WfSpec } from "./workflowExec.js";

export const NONE = "none_of_these";
export type Memo = { key: string; spec: WfSpec };
export type RouterMode = "jev" | "off";
export const routerMode = (): RouterMode => ((process.env.AGENT_WF_ROUTER ?? "off").toLowerCase() === "jev" ? "jev" : "off");
const num = (k: string, d: number) => { const n = Number(process.env[k]); return Number.isFinite(n) && n >= 0 && n <= 1 ? n : d; };
/** p: the chosen memo's probability floor; p2: the runner-up's ceiling — over every other option ("all", the default)
 *  or over the other MEMOS only ("memos": the mass on none_of_these then counts only through p). */
export type Thresholds = { p: number; p2: number; p2Scope?: "all" | "memos" };
export const thresholds = (): Thresholds => ({ p: num("AGENT_WF_ROUTE_P", 0.8), p2: num("AGENT_WF_ROUTE_P2", 0.2), p2Scope: (process.env.AGENT_WF_ROUTE_P2_SCOPE ?? "all") === "memos" ? "memos" : "all" });

/** The memo's first rule sentence(s): the first prose paragraph after the title that is not a heading, a one-line
 *  restatement ("New or established?") or a table; at most ~240 chars, cut at a sentence end. */
export function firstRule(raw: string): string {
  const paras = raw.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).slice(1);
  for (const p of paras) {
    if (!p || /^#{1,6}\s/.test(p) || p.startsWith("|") || p.startsWith("- ") || p.length < 40) continue;
    if (/^(If someone asks|The answer is|Example)/i.test(p)) break;
    const sents = p.match(/[^.!?]+[.!?]+(?=\s|$)/g) ?? [p];
    let out = ""; for (const s of sents) { if (out && out.length + s.length > 240) break; out += s.trim() + " "; if (out.length >= 120) break; }
    return out.trim().slice(0, 260);
  }
  return "";
}
/** The example request: the parsed worked example, else the first quoted question in the memo. */
export function exampleRequest(spec: WfSpec): string {
  const q = spec.example?.request ?? spec.raw.match(/"([^"\n]{10,220}\?)"/)?.[1] ?? "";
  return q.replace(/\s+/g, " ").trim().slice(0, 220);
}
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 48) || "memo";
/** Unique option keys from the memo titles (Jev sees the key as the option's name). */
export function memoKeys(specs: WfSpec[]): string[] {
  const seen = new Map<string, number>();
  return specs.map((s) => { const k = slug(s.title); const n = (seen.get(k) ?? 0) + 1; seen.set(k, n); return n === 1 ? k : `${k}_${n}`; }).map((k) => (k === NONE ? k + "_memo" : k));
}
/** The choice options: one description per memo + "none". */
export function memoOptions(memos: Memo[]): Record<string, string> {
  const opts: Record<string, string> = {};
  for (const m of memos) {
    const heads = [...m.spec.heads.keys()].slice(0, 6); const bare = [...m.spec.bare];
    const forms = [...heads, ...bare.map((b) => `a bare ${b}`)].join(", ");
    const ex = exampleRequest(m.spec);
    opts[m.key] = [`Memo "${m.spec.title}".`, firstRule(m.spec.raw) ? `Rule: ${firstRule(m.spec.raw)}` : "", forms ? `Answers look like: ${forms}.` : "", ex ? `Example request under this memo: "${ex}"` : ""].filter(Boolean).join(" ").slice(0, 700);
  }
  opts[NONE] = "None of these memos: the request asks a different question — another value, another count, who / when / why instead of what the memos answer, or a topic no memo covers; or it adds a condition the memo does not define (only certain patients, providers, payers, practices, amounts, times of day, a range of dates, pages, a status the memo does not count). A request that only shares words with a memo but asks something else is none.";
  return opts;
}
export const INSTRUCTIONS = "A clinic back-office request arrived. Which supervisor memo defines how to answer it? Pick a memo only when the request asks exactly the question that memo answers, with exactly the inputs that memo expects and no extra condition (the memo's example request shows the question in other words). Otherwise pick none_of_these.";

export type RouteDecision = { routed: Memo | null; best: string; p: number; second: string; p2: number; probabilities: Record<string, number>; why: string; ms: number; usd: number };
/** Apply the thresholds to Jev's choice. */
export function judge(c: Choice, memos: Memo[], th: Thresholds = thresholds()): RouteDecision {
  const order = Object.entries(c.probabilities).sort((a, b) => b[1] - a[1]);
  const [best, p] = order[0] ?? [NONE, 0];
  const [second, p2] = (th.p2Scope === "memos" ? order.filter(([k]) => k !== best && k !== NONE) : order.slice(1))[0] ?? [NONE, 0];
  const memo = memos.find((m) => m.key === best) ?? null;
  const base = { best, p, second, p2, probabilities: c.probabilities, ms: c.ms, usd: c.usage.cost };
  if (!memo) return { ...base, routed: null, why: best === NONE ? "none of the memos" : "unknown option" };
  if (p < th.p) return { ...base, routed: null, why: `p ${p.toFixed(2)} < ${th.p}` };
  if (p2 > th.p2) return { ...base, routed: null, why: `runner-up ${second} ${p2.toFixed(2)} > ${th.p2}` };
  return { ...base, routed: memo, why: "" };
}

export type Chooser = typeof choose;
/** Route one task by Jev. null = no decision (transport failure / off / no memos): unrouted, logged. */
export async function routeByJev(task: string, memos: Memo[], opts: { chooser?: Chooser; th?: Thresholds; cls?: "text" | "background"; log?: boolean } = {}): Promise<RouteDecision | null> {
  if (!memos.length) return null;
  const c = await (opts.chooser ?? choose)({ request: task }, INSTRUCTIONS, memoOptions(memos), { cls: opts.cls ?? "text", tag: "wf_route" });
  const d = c ? judge(c, memos, opts.th) : null;
  if (opts.log !== false) {
    const probs = d ? Object.fromEntries(Object.entries(d.probabilities).filter(([, v]) => v >= 0.005).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, +v.toFixed(3)])) : undefined;
    try { process.stdout.write(JSON.stringify({ event: "wf_route", router: "jev", routed: d?.routed?.spec.title ?? null, best: d?.best, p: d ? +d.p.toFixed(3) : undefined, second: d?.second, p2: d ? +d.p2.toFixed(3) : undefined, probs, why: d ? d.why || undefined : "no decision (transport)", memos: memos.length, ms: d?.ms, usd: d ? +d.usd.toFixed(6) : undefined, head: task.replace(/\s+/g, " ").slice(0, 80) }) + "\n"); } catch {}
  }
  return d;
}
