/**
 * Plan verifier: a plan is accepted only if it is structurally valid, reproduces the message's worked
 * example exactly on the example world (inputs extracted from the example request the live way), and a
 * second, independently written plan does the same and agrees with it on mutated copies of that world.
 */
import { runPlan, type World, type Classifier, type ExecResult, type Rec } from "./exec.js";
import { validatePlan, type Plan } from "./plan.js";
import { workedExample, ruleText, type WorkedExample } from "./example.js";
import { writePlan, buildWorld, extractInputs, resolvePatientIn, type Caller } from "./compile.js";

export type Attempt = { model: string; stage: "write" | "valid" | "inputs" | "example" | "ok"; issues: string[]; got?: string | null; why?: string; plan?: Plan | null; repairs: number };
export type Verdict = {
  title: string; ok: boolean; reason: string; example?: WorkedExample;
  world?: World | null; worldWhy?: string; a?: Attempt; b?: Attempt; agree?: Agreement;
  plan?: Plan;
};

/** Literals in the plan that look like the example's answer (or its suffix) but are not in the rule text. */
export function hardcoded(plan: Plan, ex: WorkedExample, rules: string): string[] {
  const parts = [ex.answer, ...ex.answer.split(":").slice(1).filter((s) => s.length >= 2)];
  const lits: string[] = []; const walk = (x: unknown) => { if (typeof x === "string" || typeof x === "number") lits.push(String(x)); else if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === "object") Object.values(x).forEach(walk); };
  walk(plan.steps); walk(plan.answer); walk(plan.constants ?? {});
  return parts.filter((p) => !/^(?:\d|[01]?\d|NONE)$/.test(p) && lits.some((l) => l === p) && !rules.includes(p));
}

export async function runOnExample(plan: Plan, world: World, ex: WorkedExample, o: { inputModel: string; caller?: Caller; classify?: Classifier }): Promise<{ stage: "inputs" | "example" | "ok"; got: string | null; why: string; res?: ExecResult; inputs?: Record<string, unknown> }> {
  const x = await extractInputs(plan, ex.request, { model: o.inputModel, caller: o.caller });
  if (!x.inputs) return { stage: "inputs", got: null, why: x.why };
  const w: World = { ...world, inputs: x.inputs, resolved: { ...(world.resolved ?? {}) } };
  const pin = plan.inputs.find((i) => i.type === "patient");
  const given = pin ? (x.inputs[pin.name] as { name?: string } | null) : null;
  if (pin && given?.name) {
    const id = resolvePatientIn(w, x.inputs[pin.name] as any);
    if (!id) return { stage: "inputs", got: null, why: `patient ${JSON.stringify(x.inputs[pin.name])} not resolved in the example world`, inputs: x.inputs };
    w.resolved = { patient: id };
  } else if (pin) w.resolved = {}; // the request names no patient: the plan must do without one
  const res = await runPlan(plan, w, { classify: o.classify });
  const ok = res.answer !== null && res.answer.trim() === ex.answer.trim();
  return { stage: ok ? "ok" : "example", got: res.answer, why: ok ? "" : res.answer === null ? res.why : `got ${res.answer}, want ${ex.answer}`, res, inputs: x.inputs };
}

const short = (v: unknown) => { try { const s = JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? String(x) : x && x.constructor?.name === "Q" ? x.toString() : x)); return s.length > 300 ? s.slice(0, 300) + "…" : s; } catch { return String(v); } };

/** Write → validate (repair ≤2) → run on the example (one repair with the trace) for one writer. */
export async function attempt(message: string, ex: WorkedExample, world: World, o: { model: string; temperature: number; inputModel: string; caller?: Caller; classify?: Classifier; maxRepairs?: number; siteSummary?: string }): Promise<Attempt> {
  const rules = ruleText(message);
  let w = await writePlan(message, ex, { model: o.model, temperature: o.temperature, caller: o.caller, siteSummary: o.siteSummary });
  let repairs = 0; const max = o.maxRepairs ?? 2;
  if (!w.plan) { repairs++; w = await writePlan(message, ex, { model: o.model, temperature: o.temperature, caller: o.caller, siteSummary: o.siteSummary }); }
  if (!w.plan) return { model: o.model, stage: "write", issues: w.issues, repairs };
  while (w.issues.length && repairs < max) { repairs++; const prev = w.plan; w = await writePlan(message, ex, { model: o.model, temperature: o.temperature, caller: o.caller, siteSummary: o.siteSummary, repairOf: { plan: prev, issues: w.issues } }); if (!w.plan) return { model: o.model, stage: "write", issues: w.issues, repairs }; }
  if (w.issues.length) return { model: o.model, stage: "valid", issues: w.issues, plan: w.plan, repairs };
  let plan = w.plan!;
  const hc = hardcoded(plan, ex, rules); if (hc.length) return { model: o.model, stage: "valid", issues: [`hardcodes the example answer: ${hc.join(", ")}`], plan, repairs };
  let r = await runOnExample(plan, world, ex, o);
  if (r.stage === "example" && repairs < max + 1) {
    // One learning round: show the executor's step values on the example (not the expected answer).
    repairs++;
    const trace = Object.entries(r.res?.steps ?? {}).map(([k, v]) => `${k} = ${short(v)}`).join("\n");
    const issues = [`On the message's own worked example the plan ${r.got === null ? `declined (${r.why})` : `answered ${r.got}, which is not the example's answer`}. Executor step values:\n${trace}\nRe-read the rule and fix the plan (data access, field names, rule order, boundaries). Do not hardcode answers.`];
    const w2 = await writePlan(message, ex, { model: o.model, temperature: o.temperature, caller: o.caller, siteSummary: o.siteSummary, repairOf: { plan, issues } });
    if (w2.plan && !w2.issues.length && !hardcoded(w2.plan, ex, rules).length) { plan = w2.plan; r = await runOnExample(plan, world, ex, o); }
  }
  return { model: o.model, stage: r.stage, issues: r.stage === "ok" ? [] : [r.why], got: r.got, why: r.why, plan, repairs };
}

// ---- mutation agreement ----
function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
type Leaf = { obj: any; key: string | number; path: string };
function leaves(x: any, path: string, out: Leaf[]) {
  if (Array.isArray(x)) x.forEach((v, i) => { if (v && typeof v === "object") leaves(v, `${path}[${i}]`, out); else out.push({ obj: x, key: i, path: `${path}[${i}]` }); });
  else if (x && typeof x === "object") for (const [k, v] of Object.entries(x)) { if (k === "id" || k === "patientId" || k === "claimId" || k === "appointmentId" || k === "reverses") continue; if (v && typeof v === "object") leaves(v, `${path}.${k}`, out); else out.push({ obj: x, key: k, path: `${path}.${k}` }); }
}
export function mutate(world: World, seed: number): { world: World; what: string[] } {
  const w: World = JSON.parse(JSON.stringify(world)); const r = rng(seed); const what: string[] = [];
  const ls: Leaf[] = []; leaves(w.entities, "", ls);
  const pool = new Map<string, unknown[]>(); for (const l of ls) { const k = String(l.key); if (typeof l.obj[l.key] === "string") { const a = pool.get(k) ?? []; a.push(l.obj[l.key]); pool.set(k, a); } }
  const n = 1 + Math.floor(r() * 3);
  for (let i = 0; i < n && ls.length; i++) {
    const l = ls[Math.floor(r() * ls.length)]; const v = l.obj[l.key];
    let nv: unknown = v;
    if (typeof v === "boolean") nv = !v;
    else if (typeof v === "number") nv = Number.isInteger(v) ? Math.max(0, v + Math.round((r() - 0.5) * 2 * Math.max(3, Math.abs(v) * 0.5))) : Math.round(v * (0.5 + r()) * 100) / 100;
    else if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) { const d = new Date(v + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + Math.round((r() - 0.5) * 2 * (r() < 0.5 ? 10 : 800))); nv = d.toISOString().slice(0, 10); }
    else if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) { const dp = (v.split(".")[1] ?? "").length; nv = (Number(v) * (0.5 + r())).toFixed(dp); }
    else if (typeof v === "string") { const alts = [...new Set(pool.get(String(l.key)) ?? [])].filter((x) => x !== v); if (alts.length && v.length < 40) nv = alts[Math.floor(r() * alts.length)]; else continue; }
    else continue;
    l.obj[l.key] = nv; what.push(`${l.path}: ${JSON.stringify(v)} → ${JSON.stringify(nv)}`);
  }
  // occasionally drop a record from a list of 2+
  if (r() < 0.3) { const es = Object.entries(w.entities).filter(([e, rs]) => e !== "patient" && rs.length > 1); if (es.length) { const [e, rs] = es[Math.floor(r() * es.length)]; const k = Math.floor(r() * rs.length); what.push(`drop ${e}[${k}]`); rs.splice(k, 1); } }
  return { world: w, what };
}

export type Agreement = { n: number; same: number; answered: number; distinct: number; firstDiff?: string };
export async function agreement(a: Plan, b: Plan, world: World, inputsA: Record<string, unknown>, inputsB: Record<string, unknown>, n: number, classify?: Classifier): Promise<Agreement> {
  let same = 0, answered = 0; let firstDiff: string | undefined; const outs = new Set<string>();
  for (let s = 1; s <= n; s++) {
    const m = mutate(world, s * 7919);
    const ra = await runPlan(a, { ...m.world, inputs: inputsA }, { classify }); const rb = await runPlan(b, { ...m.world, inputs: inputsB }, { classify });
    if (ra.answer !== null && rb.answer !== null) { answered++; outs.add(ra.answer); }
    if (ra.answer === rb.answer) same++; else if (!firstDiff) firstDiff = `${m.what.join("; ")} ⇒ A ${ra.answer ?? "skip(" + ra.why.slice(0, 80) + ")"} / B ${rb.answer ?? "skip(" + rb.why.slice(0, 80) + ")"}`;
  }
  return { n, same, answered, distinct: outs.size, firstDiff };
}

export type VerifyOpts = { planModels: [string, string]; temps?: [number, number]; worldModel: string; inputModel: string; caller?: Caller; classify?: Classifier; mutations?: number; worldCache?: Map<string, { world: World | null; why: string }>; world?: World; third?: boolean; siteSummary?: string };

/** The whole pipeline for one message. */
export async function compileVerified(message: string, o: VerifyOpts): Promise<Verdict> {
  const title = message.split("\n")[0].slice(0, 90);
  const ex = workedExample(message);
  if (!ex) return { title, ok: false, reason: "no worked example in the message" };
  let wb = o.world ? { world: o.world, why: "recorded" } : o.worldCache?.get(ex.section);
  if (!wb) { wb = await buildWorld(message, ex, { model: o.worldModel, caller: o.caller }); o.worldCache?.set(ex.section, wb); }
  if (!wb.world) return { title, ok: false, reason: "example world: " + wb.why, example: ex };
  const world = wb.world;
  const temps = o.temps ?? [0, 0.8];
  // Sequential: the judge proxy allows one request in flight.
  let a = await attempt(message, ex, world, { model: o.planModels[0], temperature: temps[0], inputModel: o.inputModel, caller: o.caller, classify: o.classify, siteSummary: o.siteSummary });
  let b = await attempt(message, ex, world, { model: o.planModels[1], temperature: temps[1], inputModel: o.inputModel, caller: o.caller, classify: o.classify, siteSummary: o.siteSummary });
  const base = { title, example: ex, world, worldWhy: wb.why, a, b };
  // One more independent writer when exactly one plan passed, so a flaky writer doesn't sink a good plan.
  if ((a.stage === "ok") !== (b.stage === "ok") && o.third !== false) {
    const c = await attempt(message, ex, world, { model: o.planModels[1], temperature: 0.5, inputModel: o.inputModel, caller: o.caller, classify: o.classify, siteSummary: o.siteSummary });
    if (c.stage === "ok") { if (a.stage !== "ok") a = c; else b = c; }
  }
  if (a.stage !== "ok" && b.stage !== "ok") return { ...base, ok: false, reason: `A ${a.stage}: ${a.issues[0] ?? ""} | B ${b.stage}: ${b.issues[0] ?? ""}` };
  if (a.stage !== "ok" || b.stage !== "ok") { const bad = a.stage !== "ok" ? a : b; return { ...base, ok: false, reason: `one plan only (${bad === a ? "A" : "B"} ${bad.stage}: ${bad.issues[0] ?? ""})`, plan: (a.stage === "ok" ? a : b).plan ?? undefined }; }
  const ia = (await extractInputs(a.plan!, ex.request, { model: o.inputModel, caller: o.caller })).inputs ?? {};
  const ib = (await extractInputs(b.plan!, ex.request, { model: o.inputModel, caller: o.caller })).inputs ?? {};
  const pa = a.plan!.inputs.find((i) => i.type === "patient"), pb = b.plan!.inputs.find((i) => i.type === "patient");
  const resolved = pa ? resolvePatientIn(world, ia[pa.name] as any) : pb ? resolvePatientIn(world, ib[pb.name] as any) : null;
  const ag = await agreement(a.plan!, b.plan!, { ...world, resolved: resolved ? { patient: resolved } : world.resolved }, ia, ib, o.mutations ?? 40, o.classify);
  const informative = ag.answered >= Math.max(5, Math.floor(ag.n / 4));
  const ok = ag.same === ag.n && informative;
  return { ...base, ok, agree: ag, plan: a.plan!, reason: ok ? "accepted" : ag.same !== ag.n ? `plans disagree on ${ag.n - ag.same}/${ag.n} mutated worlds: ${ag.firstDiff}` : `agreement uninformative: both plans answered only ${ag.answered}/${ag.n} mutated worlds` };
}

export { validatePlan, workedExample };
export type { Rec };
