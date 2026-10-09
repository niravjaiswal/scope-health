/**
 * The Plan contract (README.md) in code: types, the site-model vocabulary, the op catalog and a structural
 * validator. Leaf module.
 */
export type Expr = string | number | boolean | null | Expr[] | { var: string } | { op: string; [k: string]: unknown };
export type InputType = "patient" | "date" | "time" | "int" | "dec" | "text" | "id";
export type Need = { entity: string; scope: "patient" | "clinic"; filters?: string | Record<string, string>; fields?: string[] };
export type Table = { headers: string[]; rows: string[][] };
export type Plan = {
  workflow?: string;
  inputs: Array<{ name: string; type: InputType; note?: string }>;
  constants?: Record<string, unknown>;
  tables?: Record<string, Table>;
  needs: Need[];
  steps: Array<{ id: string; expr: Expr }>;
  answer: Expr;
};

/** entity → field → sub-fields (for list-of-record fields) or true. */
const F = (s: string): Record<string, true | Record<string, true>> => {
  const out: Record<string, true | Record<string, true>> = {};
  for (const m of s.matchAll(/(\w+)(\[\{([^}]*)\}\]|\[\])?/g)) out[m[1]] = m[3] ? Object.fromEntries(m[3].trim().split(/\s+/).map((k) => [k.replace(/\[\]$/, ""), true])) as Record<string, true> : true;
  return out;
};
export const VOCAB: Record<string, Record<string, true | Record<string, true>>> = {
  patient: F("id recordNumber name dob sex insured payer plan memberId problems[] restricted test merged"),
  appointment: F("id patientId date start status location provider service bookedOn startMovedOn[] recurring"),
  document: F("id patientId type title date received collected panel reportNumber recordNumber results[{test value unit}] doses[{vaccine date}]"),
  invoice: F("id number patientId issued serviceDate location status total payments[{date amount}] balance"),
  claim: F("id number patientId dos payer type filed primaryRemitArrived originalRemitArrived lines[{code modifiers[] description billed}] submissions[{date status by accepted resultDate}] accountNotes[{date text}]"),
  remittance: F("id number claimId kind paymentDate reverses scanned lines[{code modifiers[] adjustments[{group reason amount}] remarks[]}]"),
  authorization: F("id patientId payer code service validFrom validTo status"),
  coverage: F("id patientId payer plan from to subscriberIsPatient"),
  immunization: F("id patientId vaccine date status lot location givenElsewhere"),
  note: F("id patientId date type author text"),
  lot: F("id number vaccine location received"),
  activity: F("id appointmentId patientId date kind detail"),
  closure: F("id date status scope location name"),
  provider: F("id name specialty active"),
  payer: F("id name appealsDays claimsDays plans[] filingTerms[{effective originalDays originalMonths secondaryDays correctedDays}]"),
};
// remittance.lines[].adjustments is a nested list: allow its sub-fields.
(VOCAB.remittance.lines as Record<string, true>).adjustments = true;
export const NESTED_FIELDS = new Set(["group", "reason", "amount", "modifiers", "remarks", "adjustments", "test", "value", "unit", "vaccine", "date", "effective", "originalDays", "originalMonths", "secondaryDays", "correctedDays", "code", "description", "billed", "status", "by", "accepted", "resultDate", "text"]);
export const ALL_FIELDS = new Set<string>([...Object.values(VOCAB).flatMap((f) => Object.entries(f).flatMap(([k, v]) => [k, ...(v === true ? [] : Object.keys(v))])), ...NESTED_FIELDS]);

/** Vocabulary as prompt text. */
export function vocabText(): string {
  return Object.entries(VOCAB).map(([e, f]) => `${e}: ` + Object.entries(f).map(([k, v]) => v === true ? k : `${k}[{${Object.keys(v).join(" ")}}]`).join(" ")).join("\n");
}

/** op → argument names (required ones without "?"). Lambda args see `$`. */
export const OPS: Record<string, string[]> = {
  select: ["entity", "where?", "scope?"], filter: ["from", "where"], map: ["from", "to"], flatMap: ["from", "to"], count: ["from"],
  sum: ["from", "of?"], min: ["from", "of?"], max: ["from", "of?"], argmax: ["from", "by", "tie?"], argmin: ["from", "by", "tie?"],
  one: ["from"], first: ["from"], sortBy: ["from", "by", "desc?"], distinct: ["from", "by?"], any: ["from", "where"], all: ["from", "where"],
  get: ["from", "field"], len: ["from"], in: ["value", "list"], rows: ["table"], lookup: ["table", "match", "column"],
  and: ["args"], or: ["args"], not: ["a"], if: ["cond", "then", "else?"], eq: ["a", "b"], ne: ["a", "b"], lt: ["a", "b"], le: ["a", "b"],
  gt: ["a", "b"], ge: ["a", "b"], isNull: ["a"], coalesce: ["args"],
  contains: ["text", "any"], startsWith: ["text", "prefix"], matches: ["text", "regex"], concat: ["parts"], join: ["from", "sep?"],
  upper: ["a"], lower: ["a"], split: ["text", "sep"], num: ["a"], fmt: ["value", "as"],
  add: ["a", "b"], sub: ["a", "b"], mul: ["a", "b"], div: ["a", "b"], abs: ["a"], neg: ["a"], pctChange: ["from", "to"],
  addDays: ["date", "n"], addMonths: ["date", "n"], addYears: ["date", "n", "feb29?"], daysBetween: ["from", "to"], ageOn: ["dob", "on"],
  weekday: ["date"], isOpen: ["date", "closed", "weekends?"], businessDaysBetween: ["after", "through", "closed"],
  addBusinessDays: ["date", "n", "closed"], prevOpenDay: ["date", "closed"], today: [],
  sameName: ["a", "b"],
  firstMatch: ["cases", "else?"], decline: ["why?"], classify: ["text", "question", "labels"],
};
const LAMBDA_ARGS = new Set(["where", "to", "by", "of"]);

/** Normalise model shorthand: a bare string "$.field" / "$$.field" / "$" is a var reference. */
export function normalizePlan<T>(x: T): T {
  const walk = (v: any): any => {
    if (typeof v === "string" && /^\$\$?(?:\.[^.\s][^.]*)*$/.test(v)) return { var: v };
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") { if ("var" in v) return v; return Object.fromEntries(Object.entries(v).map(([k, y]) => [k, k === "regex" || k === "question" || k === "labels" || k === "why" ? y : walk(y)])); }
    return v;
  };
  const p: any = x; if (!p || typeof p !== "object") return x;
  return { ...p, steps: Array.isArray(p.steps) ? p.steps.map((s: any) => ({ ...s, expr: walk(s?.expr) })) : p.steps, answer: walk(p.answer) };
}

export type Issue = string;
/** Structural validation. Returns the issues (empty = valid). */
export function validatePlan(p: unknown): Issue[] {
  const out: Issue[] = [];
  if (!p || typeof p !== "object") return ["plan is not an object"];
  const plan = p as Plan;
  if (!Array.isArray(plan.inputs)) out.push("inputs must be an array");
  if (!Array.isArray(plan.needs)) out.push("needs must be an array");
  if (!Array.isArray(plan.steps)) out.push("steps must be an array");
  if (plan.answer === undefined) out.push("answer missing");
  if (out.length) return out;
  const inputs = new Set<string>();
  for (const i of plan.inputs) {
    if (!i || typeof i.name !== "string") { out.push("input without a name"); continue; }
    if (!["patient", "date", "time", "int", "dec", "text", "id"].includes(i.type)) out.push(`input ${i.name}: unknown type ${i.type}`);
    inputs.add(i.name);
  }
  for (const n of plan.needs) {
    if (!VOCAB[n?.entity]) out.push(`need: unknown entity ${n?.entity}`);
    else for (const f of n.fields ?? []) if (!VOCAB[n.entity][f]) out.push(`need ${n.entity}: unknown field ${f}`);
    if (n && n.scope !== "patient" && n.scope !== "clinic") out.push(`need ${n.entity}: scope must be patient|clinic`);
  }
  for (const [name, t] of Object.entries(plan.tables ?? {})) {
    if (!Array.isArray(t?.headers) || !Array.isArray(t?.rows)) { out.push(`table ${name}: needs headers and rows`); continue; }
    for (const r of t.rows) if (!Array.isArray(r) || r.length !== t.headers.length) out.push(`table ${name}: a row has ${Array.isArray(r) ? r.length : "?"} cells, headers ${t.headers.length}`);
  }
  const consts = new Set(Object.keys(plan.constants ?? {}));
  const fieldOk = new Set<string>([...ALL_FIELDS, ...Object.values(plan.tables ?? {}).flatMap((t) => (t?.headers ?? []).map(String))]);
  const steps = new Set<string>();
  const check = (e: unknown, where: string, lambda: number) => {
    if (e === null || ["string", "number", "boolean"].includes(typeof e)) return;
    if (Array.isArray(e)) { e.forEach((x, i) => check(x, `${where}[${i}]`, lambda)); return; }
    if (typeof e !== "object") { out.push(`${where}: bad value`); return; }
    const o = e as Record<string, unknown>;
    if ("var" in o) {
      const v = String(o.var); const [head, ...rest] = v.split(".");
      if (head === "$" || head === "$$") { if (lambda < (head === "$" ? 1 : 2)) out.push(`${where}: ${v} used outside a lambda`); for (const f of rest) if (!fieldOk.has(f) && !/^\d+$/.test(f)) out.push(`${where}: unknown field ${f} in ${v}`); }
      else if (head === "inputs") { if (!inputs.has(rest[0])) out.push(`${where}: undefined input ${rest[0]}`); }
      else if (head === "steps") { if (!steps.has(rest[0])) out.push(`${where}: step ${rest[0]} used before it is defined`); }
      else if (head === "constants") { if (!consts.has(rest[0])) out.push(`${where}: undefined constant ${rest[0]}`); }
      else out.push(`${where}: var must start with inputs/steps/constants/$/$$: ${v}`);
      return;
    }
    if (typeof o.op !== "string") { out.push(`${where}: object without op or var`); return; }
    const spec = OPS[o.op]; if (!spec) { out.push(`${where}: unknown op ${o.op}`); return; }
    for (const a of spec) if (!a.endsWith("?") && !(a in o)) out.push(`${where}: ${o.op} needs ${a}`);
    const known = new Set(spec.map((a) => a.replace("?", "")));
    for (const k of Object.keys(o)) if (k !== "op" && !known.has(k)) out.push(`${where}: ${o.op} has unknown argument ${k}`);
    if (o.op === "select" && !VOCAB[String(o.entity)]) out.push(`${where}: select of unknown entity ${o.entity}`);
    if (o.op === "lookup" || o.op === "rows") {
      const t = plan.tables?.[String(o.table)]; if (!t) out.push(`${where}: unknown table ${o.table}`);
      else if (o.op === "lookup") { for (const c of [...Object.keys((o.match ?? {}) as object), String(o.column)]) if (!t.headers.includes(c)) out.push(`${where}: table ${o.table} has no column ${c}`); }
    }
    if (o.op === "fmt" && !["date", "money2", "int", "text", "dec"].includes(String(o.as))) out.push(`${where}: fmt as must be date|money2|int|text|dec`);
    if (o.op === "firstMatch") {
      if (!Array.isArray(o.cases)) out.push(`${where}: firstMatch cases must be an array`);
      else (o.cases as any[]).forEach((c, i) => { if (!c || !("when" in c) || !("then" in c)) out.push(`${where}.cases[${i}]: needs when and then`); else { check(c.when, `${where}.cases[${i}].when`, lambda); check(c.then, `${where}.cases[${i}].then`, lambda); } });
      if ("else" in o) check(o.else, `${where}.else`, lambda);
      return;
    }
    for (const [k, v] of Object.entries(o)) {
      if (k === "op" || k === "entity" || k === "scope" || k === "table" || k === "column" || k === "as" || k === "field" || k === "tie" || k === "feb29" || k === "regex" || k === "labels" || (k === "question" && typeof v === "string")) continue;
      if (k === "match" && v && typeof v === "object" && !Array.isArray(v)) { for (const [mk, mv] of Object.entries(v)) check(mv, `${where}.match.${mk}`, lambda); continue; }
      check(v, `${where}.${k}`, LAMBDA_ARGS.has(k) ? lambda + 1 : lambda);
    }
    if (o.op === "regex" || o.op === "matches") { try { new RegExp(String(o.regex), "i"); } catch { out.push(`${where}: bad regex`); } }
  };
  for (const s of plan.steps) {
    if (!s || typeof s.id !== "string") { out.push("step without id"); continue; }
    if (steps.has(s.id)) out.push(`step ${s.id} defined twice`);
    check(s.expr, `steps.${s.id}`, 0); steps.add(s.id);
  }
  check(plan.answer, "answer", 0);
  return [...new Set(out)].slice(0, 40);
}
