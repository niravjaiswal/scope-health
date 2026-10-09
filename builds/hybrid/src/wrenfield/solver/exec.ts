/**
 * Reference executor: runs a Plan (plan.ts) over a World. Deterministic: exact rationals, ISO dates, no
 * model except the optional `classify` hook (free-text judgement supplied by the toolkit). Any error,
 * `decline`, or unknown value reaching the answer → { answer: null, why }.
 */
import { Q, isISO, addDays, addMonths, addYears, daysBetween, ageOn, weekday, isOpen, businessDaysBetween, addBusinessDays, prevOpenDay } from "./num.js";
import type { Expr, Plan } from "./plan.js";

export type Rec = Record<string, unknown>;
export type World = { inputs: Record<string, unknown>; entities: Record<string, Rec[]>; resolved?: { patient?: string }; today?: string };
export type Classifier = (text: string, question: string, labels: string[]) => Promise<string | null>;
export type ExecResult = { answer: string | null; why: string; steps: Record<string, unknown> };

class Decline extends Error {}
const decline = (why: string): never => { throw new Decline(why); };

const num = (x: unknown, what: string): Q => { const q = Q.parse(x); if (!q) decline(`${what}: not a number: ${short(x)}`); return q!; };
const date = (x: unknown, what: string): string => { if (!isISO(x)) decline(`${what}: not a date: ${short(x)}`); return x as string; };
const list = (x: unknown, what: string): unknown[] => { if (!Array.isArray(x)) decline(`${what}: not a list: ${short(x)}`); return x as unknown[]; };
const int = (x: unknown, what: string): number => { const q = num(x, what); if (!q.isInt()) decline(`${what}: not a whole number`); return Number(q.n); };
const short = (x: unknown) => { try { return JSON.stringify(x instanceof Q ? x.toString() : x)?.slice(0, 80); } catch { return String(x); } };
const isNull = (x: unknown) => x === null || x === undefined;
const str = (x: unknown) => x instanceof Q ? x.toString() : String(x);
const dateList = (x: unknown, what: string): string[] => list(x, what).map((d, i) => date(d instanceof Object && !(d instanceof Q) ? (d as Rec).date : d, `${what}[${i}]`));

/** A person/organisation name as an order-free word set: case, accents, punctuation and trailing credentials ignored. */
export const nameKey = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/,?\s*\b(md|do|pa-c|pa|np|rn|cnm|crna|phd|psyd|dds|dmd|lcsw|lpc)\b\.?/g, " ").replace(/[.,]/g, " ").split(/\s+/).filter(Boolean).sort().join(" ");

/** Compare: numbers numerically, otherwise strings (ISO dates order as strings). null → unknown. */
function cmp(a: unknown, b: unknown): number | null {
  if (isNull(a) || isNull(b)) return null;
  if (typeof a === "boolean" || typeof b === "boolean") { const ba = typeof a === "boolean" ? a : /^(true|yes)$/i.test(String(a)) ? true : /^(false|no)$/i.test(String(a)) ? false : null; const bb = typeof b === "boolean" ? b : /^(true|yes)$/i.test(String(b)) ? true : /^(false|no)$/i.test(String(b)) ? false : null; return ba === null || bb === null ? null : ba === bb ? 0 : ba ? 1 : -1; }
  const qa = !isISO(a) ? Q.parse(a) : null, qb = !isISO(b) ? Q.parse(b) : null;
  if (qa && qb) return qa.cmp(qb);
  const sa = str(a).trim().toLowerCase(), sb = str(b).trim().toLowerCase();
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}
function truthy(x: unknown, what: string): boolean {
  if (x === true || x === false) return x;
  if (isNull(x)) decline(`${what}: unknown condition`);
  decline(`${what}: condition is not true/false: ${short(x)}`);
  return false;
}

export async function runPlan(plan: Plan, world: World, opts: { classify?: Classifier } = {}): Promise<ExecResult> {
  const steps: Record<string, unknown> = {};
  const inputs: Record<string, unknown> = { ...world.inputs };
  for (const i of plan.inputs) if (i.type === "patient") {
    const pid = world.resolved?.patient; const p = (world.entities.patient ?? []).find((r) => r.id === pid);
    inputs[i.name] = p ?? null;
  }
  const ctx: Ctx = { plan, world, inputs, steps, classify: opts.classify, pending: new Map(), busy: new Set() };
  try {
    const a = await ev(plan.answer, ctx, [], "answer");
    if (isNull(a)) return { answer: null, why: "answer unknown", steps };
    const out = str(a).trim();
    if (!out || /\s{2,}|\n/.test(out)) return { answer: null, why: "answer empty or multi-line", steps };
    return { answer: out, why: "", steps };
  } catch (e) {
    return { answer: null, why: e instanceof Decline ? e.message : `error: ${(e as Error).message}`, steps };
  }
}

type Ctx = { plan: Plan; world: World; inputs: Record<string, unknown>; steps: Record<string, unknown>; classify?: Classifier; pending: Map<string, Promise<unknown>>; busy: Set<string> };

/** Steps are lazy let-bindings: evaluated on first use, memoised. A step the answer never reaches can't
 *  decline the task (data a branch doesn't need is never required). */
async function step(id: string, c: Ctx): Promise<unknown> {
  if (id in c.steps) return c.steps[id];
  const s = c.plan.steps.find((x) => x.id === id); if (!s) return decline(`unknown step ${id}`);
  let p = c.pending.get(id);
  if (!p) {
    if (c.busy.has(id)) return decline(`step ${id} refers to itself`);
    c.busy.add(id);
    p = ev(s.expr, c, [], `steps.${id}`).then((v) => { c.steps[id] = v; c.busy.delete(id); return v; }, (e) => { c.busy.delete(id); throw e; });
    c.pending.set(id, p);
  }
  return p;
}

function path(base: unknown, parts: string[]): unknown {
  let v = base;
  for (const p of parts) { if (isNull(v)) return null; if (Array.isArray(v) && /^\d+$/.test(p)) v = v[Number(p)]; else if (typeof v === "object") v = (v as Rec)[p]; else return null; }
  return v === undefined ? null : v;
}

async function ev(e: Expr | unknown, c: Ctx, stack: unknown[], at: string): Promise<unknown> {
  if (e === null || typeof e === "string" || typeof e === "number" || typeof e === "boolean") return e;
  if (Array.isArray(e)) { const out = []; for (let i = 0; i < e.length; i++) out.push(await ev(e[i], c, stack, `${at}[${i}]`)); return out; }
  if (typeof e !== "object") return null;
  const o = e as Record<string, any>;
  if ("var" in o) {
    const [h, ...rest] = String(o.var).split(".");
    if (h === "$") return path(stack[stack.length - 1], rest);
    if (h === "$$") return path(stack[stack.length - 2], rest);
    if (h === "inputs") return path(c.inputs, rest);
    if (h === "steps") return path(await step(rest[0], c), rest.slice(1));
    if (h === "constants") return path(c.plan.constants ?? {}, rest);
    return decline(`${at}: bad var ${o.var}`);
  }
  const A = (k: string) => ev(o[k], c, stack, `${at}.${k}`);
  const lam = (k: string, item: unknown) => ev(o[k], c, [...stack, item], `${at}.${k}`);
  const items = async () => list(await A("from"), `${at}.from`);
  switch (o.op) {
    case "select": {
      let rs = (c.world.entities[o.entity] ?? []).slice();
      if (o.scope === "patient" && o.entity !== "patient") { const pid = c.world.resolved?.patient; if (!pid) decline(`${at}: no resolved patient`); rs = rs.filter((r) => isNull(r.patientId) || r.patientId === pid); }
      if (!("where" in o)) return rs;
      const out = []; for (const r of rs) if (truthy(await lam("where", r), `${at}.where`)) out.push(r); return out;
    }
    case "filter": { const out = []; for (const r of await items()) if (truthy(await lam("where", r), `${at}.where`)) out.push(r); return out; }
    case "map": { const out = []; for (const r of await items()) out.push(await lam("to", r)); return out; }
    case "flatMap": { const out: unknown[] = []; for (const r of await items()) { const v = await lam("to", r); if (Array.isArray(v)) out.push(...v); else if (!isNull(v)) out.push(v); } return out; }
    case "count": case "len": return new Q(BigInt((await items()).length));
    case "sum": { let t = new Q(0n); for (const r of await items()) t = t.add(num("of" in o ? await lam("of", r) : r, `${at}.of`)); return t; }
    case "min": case "max": {
      const vs = []; for (const r of await items()) { const v = "of" in o ? await lam("of", r) : r; if (isNull(v)) decline(`${at}: unknown value`); vs.push(v); }
      if (!vs.length) return null;
      return vs.reduce((m, v) => { const k = cmp(v, m)!; return (o.op === "max" ? k > 0 : k < 0) ? v : m; });
    }
    case "argmax": case "argmin": {
      const rs = await items(); if (!rs.length) return null;
      const keyed: Array<[unknown, unknown]> = []; for (const r of rs) { const k = await lam("by", r); if (isNull(k)) decline(`${at}: unknown sort key`); keyed.push([k, r]); }
      const sign = o.op === "argmax" ? 1 : -1;
      const best = keyed.reduce((m, x) => (cmp(x[0], m[0])! * sign > 0 ? x : m));
      const ties = keyed.filter((x) => cmp(x[0], best[0]) === 0);
      if (ties.length > 1) { const t = o.tie ?? "error"; if (t === "error") decline(`${at}: tie for ${o.op}`); return (t === "last" ? ties[ties.length - 1] : ties[0])[1]; }
      return best[1];
    }
    case "one": { const rs = await items(); if (rs.length !== 1) decline(`${at}: expected exactly one, found ${rs.length}`); return rs[0]; }
    case "first": { const rs = await items(); return rs.length ? rs[0] : null; }
    case "sortBy": {
      const keyed: Array<[unknown, unknown]> = []; for (const r of await items()) { const k = await lam("by", r); if (isNull(k)) decline(`${at}: unknown sort key`); keyed.push([k, r]); }
      keyed.sort((x, y) => cmp(x[0], y[0])! * (o.desc ? -1 : 1)); return keyed.map((x) => x[1]);
    }
    case "distinct": { const seen = new Set<string>(); const out = []; for (const r of await items()) { const k = "by" in o ? await lam("by", r) : r; const s = JSON.stringify(k instanceof Q ? k.toString() : k); if (!seen.has(s)) { seen.add(s); out.push("by" in o ? k : r); } } return out; }
    case "any": { for (const r of await items()) if (truthy(await lam("where", r), `${at}.where`)) return true; return false; }
    case "all": { for (const r of await items()) if (!truthy(await lam("where", r), `${at}.where`)) return false; return true; }
    case "get": return path(await A("from"), String(o.field).split("."));
    case "in": { const v = await A("value"); if (isNull(v)) return null; return list(await A("list"), `${at}.list`).some((x) => cmp(x, v) === 0); }
    case "rows": { const t = c.plan.tables?.[o.table]; if (!t) decline(`${at}: no table ${o.table}`); return t!.rows.map((r) => Object.fromEntries(t!.headers.map((h, i) => [h, r[i]]))); }
    case "lookup": {
      const t = c.plan.tables?.[o.table]; if (!t) decline(`${at}: no table ${o.table}`);
      const want: Array<[number, unknown]> = []; for (const [k, v] of Object.entries(o.match ?? {})) want.push([t!.headers.indexOf(k), await ev(v, c, stack, `${at}.match.${k}`)]);
      if (want.some(([, v]) => isNull(v))) return null;
      const hits = t!.rows.filter((r) => want.every(([i, v]) => cmp(r[i], v) === 0));
      if (hits.length !== 1) decline(`${at}: ${hits.length} rows of ${o.table} match`);
      return hits[0][t!.headers.indexOf(o.column)];
    }
    case "and": { let unknown = false; for (const a of list(o.args, `${at}.args`)) { const v = await ev(a, c, stack, at); if (v === false) return false; if (isNull(v)) unknown = true; else truthy(v, at); } return unknown ? null : true; }
    case "or": { let unknown = false; for (const a of list(o.args, `${at}.args`)) { const v = await ev(a, c, stack, at); if (v === true) return true; if (isNull(v)) unknown = true; else truthy(v, at); } return unknown ? null : false; }
    case "not": { const v = await A("a"); return isNull(v) ? null : !truthy(v, at); }
    case "if": { const v = truthy(await A("cond"), `${at}.cond`); return v ? A("then") : ("else" in o ? A("else") : null); }
    case "eq": case "ne": case "lt": case "le": case "gt": case "ge": {
      const a = await A("a"), b = await A("b");
      if (o.op === "eq" || o.op === "ne") { if (isNull(a) && isNull(b)) return o.op === "eq"; if (isNull(a) || isNull(b)) return o.op === "ne"; }
      const k = cmp(a, b); if (k === null) return null;
      return o.op === "eq" ? k === 0 : o.op === "ne" ? k !== 0 : o.op === "lt" ? k < 0 : o.op === "le" ? k <= 0 : o.op === "gt" ? k > 0 : k >= 0;
    }
    case "isNull": return isNull(await A("a"));
    case "sameName": { const a = await A("a"), b = await A("b"); if (isNull(a) || isNull(b)) return null; return nameKey(str(a)) === nameKey(str(b)); }
    case "coalesce": { for (const a of list(o.args, `${at}.args`)) { const v = await ev(a, c, stack, at); if (!isNull(v)) return v; } return null; }
    case "contains": { const t = await A("text"); if (isNull(t)) return null; const s = str(t).toLowerCase(); const any = await A("any"); return (Array.isArray(any) ? any : [any]).some((w) => s.includes(str(w).toLowerCase())); }
    case "startsWith": { const t = await A("text"), p = await A("prefix"); if (isNull(t) || isNull(p)) return null; return str(t).trimStart().toLowerCase().startsWith(str(p).toLowerCase()); }
    case "matches": { const t = await A("text"); if (isNull(t)) return null; return new RegExp(String(o.regex), "i").test(str(t)); }
    case "concat": { const ps = list(await A("parts"), `${at}.parts`); if (ps.some(isNull)) return null; return ps.map(str).join(""); }
    case "join": { const ps = await items(); if (ps.some(isNull)) return null; return ps.map(str).join("sep" in o ? str(await A("sep")) : ","); }
    case "upper": { const v = await A("a"); return isNull(v) ? null : str(v).toUpperCase(); }
    case "lower": { const v = await A("a"); return isNull(v) ? null : str(v).toLowerCase(); }
    case "split": { const v = await A("text"); return isNull(v) ? null : str(v).split(str(await A("sep"))).map((x) => x.trim()).filter(Boolean); }
    case "num": { const v = await A("a"); return isNull(v) ? null : num(v, at); }
    case "fmt": {
      const v = await A("value"); if (isNull(v)) return null;
      switch (o.as) {
        case "date": return date(v, at);
        case "money2": { const f = num(v, at).fixed(2); if (f === null) decline(`${at}: amount not exact to the cent`); return f; }
        case "int": return String(int(v, at));
        case "dec": return num(v, at).toString();
        default: return str(v);
      }
    }
    case "add": case "sub": case "mul": case "div": {
      const a = await A("a"), b = await A("b"); if (isNull(a) || isNull(b)) return null;
      const qa = num(a, `${at}.a`), qb = num(b, `${at}.b`);
      return o.op === "add" ? qa.add(qb) : o.op === "sub" ? qa.sub(qb) : o.op === "mul" ? qa.mul(qb) : (qb.n === 0n ? decline(`${at}: division by zero`) : qa.div(qb));
    }
    case "abs": { const v = await A("a"); return isNull(v) ? null : num(v, at).abs(); }
    case "neg": { const v = await A("a"); return isNull(v) ? null : new Q(0n).sub(num(v, at)); }
    case "pctChange": { const f = await A("from"), t = await A("to"); if (isNull(f) || isNull(t)) return null; const qf = num(f, at); if (qf.n === 0n) decline(`${at}: change from zero`); return num(t, at).sub(qf).abs().div(qf.abs()).mul(new Q(100n)); }
    case "addDays": { const d = await A("date"), n = await A("n"); if (isNull(d) || isNull(n)) return null; return addDays(date(d, at), int(n, at)); }
    case "addMonths": { const d = await A("date"), n = await A("n"); if (isNull(d) || isNull(n)) return null; return addMonths(date(d, at), int(n, at)); }
    case "addYears": { const d = await A("date"), n = await A("n"); if (isNull(d) || isNull(n)) return null; return addYears(date(d, at), int(n, at), o.feb29 === "mar1" ? "mar1" : "feb28"); }
    case "daysBetween": { const a = await A("from"), b = await A("to"); if (isNull(a) || isNull(b)) return null; return new Q(BigInt(daysBetween(date(a, at), date(b, at)))); }
    case "ageOn": { const a = await A("dob"), b = await A("on"); if (isNull(a) || isNull(b)) return null; return new Q(BigInt(ageOn(date(a, at), date(b, at)))); }
    case "weekday": { const d = await A("date"); return isNull(d) ? null : new Q(BigInt(weekday(date(d, at)))); }
    case "isOpen": { const d = await A("date"); if (isNull(d)) return null; return isOpen(date(d, at), dateList(await A("closed"), `${at}.closed`), o.weekends !== false); }
    case "businessDaysBetween": { const a = await A("after"), b = await A("through"); if (isNull(a) || isNull(b)) return null; return new Q(BigInt(businessDaysBetween(date(a, at), date(b, at), dateList(await A("closed"), `${at}.closed`)))); }
    case "addBusinessDays": { const d = await A("date"), n = await A("n"); if (isNull(d) || isNull(n)) return null; return addBusinessDays(date(d, at), int(n, at), dateList(await A("closed"), `${at}.closed`)); }
    case "prevOpenDay": { const d = await A("date"); if (isNull(d)) return null; return prevOpenDay(date(d, at), dateList(await A("closed"), `${at}.closed`)); }
    case "today": return c.world.today ?? (c.plan.constants?.today as string | undefined) ?? decline(`${at}: today unknown`);
    case "firstMatch": {
      for (const [i, cs] of list(o.cases, `${at}.cases`).entries()) { const k = cs as Rec; if (truthy(await ev(k.when, c, stack, `${at}.cases[${i}].when`), `${at}.cases[${i}].when`)) return ev(k.then, c, stack, `${at}.cases[${i}].then`); }
      return "else" in o ? A("else") : decline(`${at}: no case matched`);
    }
    case "decline": return decline(`${at}: decline: ${o.why ?? ""}`);
    case "classify": {
      const t = await A("text"); if (isNull(t)) return null;
      if (!c.classify) decline(`${at}: classify unavailable`);
      const q = typeof o.question === "string" ? o.question : await A("question"); if (isNull(q)) return null;
      const labels = (o.labels as unknown[]).map(String); const v = await c.classify!(str(t), str(q), labels);
      if (v === null || !labels.includes(v)) return null; return v;
    }
    default: return decline(`${at}: unknown op ${o.op}`);
  }
}
