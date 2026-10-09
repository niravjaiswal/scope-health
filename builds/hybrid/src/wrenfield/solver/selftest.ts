/**
 * Offline self-checks for the solver (no model, no network): exact numbers + calendar ops, the executor's
 * ops and decline semantics, the validator, worked-example extraction over the corpus, hand-written plans
 * reproducing two worked examples, mutation determinism, the hardcode guard, and the whole verify pipeline
 * with a canned model.   npx tsx src/wrenfield/solver/selftest.ts
 */
import { Q, addMonths, addYears, ageOn, businessDaysBetween, addBusinessDays, prevOpenDay, isOpen } from "./num.js";
import { runPlan, type World } from "./exec.js";
import { validatePlan, type Plan } from "./plan.js";
import { workedExample, ruleText } from "./example.js";
import { compileVerified, hardcoded, mutate } from "./verify.js";
import type { Caller } from "./compile.js";
import { corpus } from "./corpus.js";
import { answerFormOk } from "./index.js";

let fails = 0, n = 0;
const ok = (c: boolean, m: string) => { n++; if (!c) { fails++; console.log("FAIL", m); } };
const eq = (a: unknown, b: unknown, m: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

// --- num ---
eq(Q.parse("13.8")!.sub(Q.parse("12.0")!).div(Q.parse("12.0")!).mul(new Q(100n)).cmp(new Q(15n)), 0, "15% exactly");
eq(Q.parse("0.1")!.add(Q.parse("0.2")!).toString(), "0.3", "exact 0.1+0.2");
eq(Q.parse("1,250.5")!.fixed(2), "1250.50", "money2");
eq(Q.parse("1/3"), null, "no fraction literal");
eq(addMonths("2025-08-31", 6), "2026-02-28", "addMonths clamp");
eq(addYears("2024-02-29", -1), "2023-02-28", "feb29 → feb28");
eq(addYears("2024-02-29", 1, "mar1"), "2025-03-01", "feb29 → mar1");
eq(ageOn("2012-02-29", "2026-02-28"), 13, "feb29 birthday not yet");
eq(ageOn("2012-02-29", "2026-03-01"), 14, "feb29 birthday on Mar 1");
eq(businessDaysBetween("2026-03-02", "2026-03-05", []), 3, "GFE example: 3 business days");
eq(businessDaysBetween("2026-03-02", "2026-03-05", ["2026-03-03"]), 2, "GFE example with closure");
eq(addBusinessDays("2026-03-06", 3, []), "2026-03-11", "third business day after Fri");
eq(prevOpenDay("2026-11-28", ["2026-11-26", "2026-11-27"]), "2026-11-25", "filing: back over weekend + holidays");
ok(!isOpen("2026-03-07", []), "Saturday closed");

// --- executor ---
const W: World = { inputs: { d: "2026-01-10" }, entities: { note: [{ id: "n1", patientId: "p1", date: "2026-01-02", text: "Triage: cut" }, { id: "n2", patientId: "p2", date: "2026-01-03", text: "x" }], patient: [{ id: "p1", name: "Ann Lee" }] }, resolved: { patient: "p1" } };
const P = (steps: Plan["steps"], answer: Plan["answer"], extra: Partial<Plan> = {}): Plan => ({ inputs: [{ name: "d", type: "date" }, { name: "pt", type: "patient" }], needs: [], steps, answer, ...extra });
(async () => {
  eq((await runPlan(P([{ id: "ns", expr: { op: "select", entity: "note", scope: "patient" } }], { op: "fmt", value: { op: "count", from: { var: "steps.ns" } }, as: "int" }), W)).answer, "1", "scope patient");
  eq((await runPlan(P([], { op: "addDays", date: { var: "inputs.d" }, n: 90 }), W)).answer, "2026-04-10", "addDays 90");
  eq((await runPlan(P([], { op: "one", from: { op: "select", entity: "note" } }), W)).answer, null, "one of two declines");
  eq((await runPlan(P([], { op: "if", cond: { op: "gt", a: { var: "inputs.missing" }, b: 1 }, then: "A", else: "B" }), W)).answer, null, "unknown condition declines");
  eq((await runPlan(P([], { op: "argmax", from: [{ id: "a", d: "2026-01-01" }, { id: "b", d: "2026-01-01" }], by: { var: "$.d" } }), W)).answer, null, "tie declines by default");
  eq((await runPlan(P([], { op: "fmt", value: { op: "div", a: 10, b: 3 }, as: "money2" }), W)).answer, null, "money2 not exact declines");
  eq((await runPlan(P([], { op: "lookup", table: "t", match: { Code: "n290" }, column: "Field" }), W, {}).then((r) => r.answer)), null, "lookup without table declines");
  eq((await runPlan(P([], { op: "lookup", table: "t", match: { Code: "n290" }, column: "Field" }, { tables: { t: { headers: ["Code", "Field"], rows: [["N290", "RENDERING_PROVIDER_ID"]] } } }), W)).answer, "RENDERING_PROVIDER_ID", "lookup case-insensitive");
  eq((await runPlan(P([], { op: "firstMatch", cases: [{ when: false, then: "A" }, { when: { op: "startsWith", text: "Triage: cut", prefix: "triage:" }, then: "B" }] }), W)).answer, "B", "firstMatch priority");
  eq((await runPlan(P([], { op: "decline", why: "x" }), W)).answer, null, "decline");
  eq((await runPlan(P([], { op: "gt", a: { op: "pctChange", from: "12.0", to: "13.8" }, b: 15 }), W)).answer, "false", "change of exactly 15% is not more than 15%");
  eq((await runPlan(P([], { op: "gt", a: { op: "pctChange", from: "12.0", to: "13.9" }, b: 15 }), W)).answer, "true", "13.9 vs 12.0 is more than 15%");

  eq((await runPlan(P([{ id: "bad", expr: { op: "decline", why: "unused" } }, { id: "good", expr: "X" }], { var: "steps.good" }), W)).answer, "X", "lazy steps: an unused declining step doesn't sink the answer");
  eq((await runPlan(P([{ id: "bad", expr: { op: "decline", why: "used" } }], { op: "concat", parts: [{ var: "steps.bad" }] }), W)).answer, null, "lazy steps: a used declining step declines");
  eq((await runPlan(P([], { op: "if", cond: { op: "eq", a: false, b: true }, then: "A", else: "B" }), W)).answer, "B", "boolean eq false/true");
  eq((await runPlan(P([], { op: "if", cond: { op: "sameName", a: "Guzman, Walter PA", b: "walter guzman" }, then: "A", else: "B" }), W)).answer, "A", "sameName");
  { let asked = ""; const cl = async (_t: string, q: string, labels: string[]) => { asked = q; return labels[0]; };
    eq((await runPlan(P([], { op: "classify", text: "Recall letter mailed", question: { op: "concat", parts: ["Lot ", "M81"] }, labels: ["notified", "other"] }), W, { classify: cl })).answer, "notified", "classify with a computed question");
    eq(asked, "Lot M81", "classify question is evaluated"); }
  // --- validator ---
  ok(validatePlan({ inputs: [], needs: [], steps: [{ id: "a", expr: { op: "nope" } }], answer: "x" }).some((s) => /unknown op/.test(s)), "validator: unknown op");
  ok(validatePlan({ inputs: [], needs: [], steps: [], answer: { var: "steps.zz" } }).some((s) => /before it is defined/.test(s)), "validator: undefined step");
  ok(validatePlan({ inputs: [], needs: [{ entity: "spaceship", scope: "patient" }], steps: [], answer: "x" }).some((s) => /unknown entity/.test(s)), "validator: unknown entity");
  ok(validatePlan({ inputs: [], needs: [], steps: [], answer: { var: "$.date" } }).some((s) => /outside a lambda/.test(s)), "validator: $ outside lambda");
  ok(validatePlan({ inputs: [], needs: [], steps: [], answer: { op: "filter", from: [], where: { var: "$.bogusField" } } }).some((s) => /unknown field/.test(s)), "validator: unknown field");

  // --- corpus: every worked example extracts ---
  const C = corpus();
  ok(C.length >= 15, `corpus has ${C.length} messages`);
  for (const c of C) { const e = workedExample(c.text); if (c.expectExample) ok(!!e && e.answer.length > 0 && e.request.length > 8, `worked example in ${c.id}`); }
  for (const c of C.filter((c) => c.base === "set1-120")) eq(workedExample(c.text)?.answer, "APPEAL:2026-12-15", `claim example answer in ${c.id}`);
  ok(!ruleText(C.find((c) => c.id === "set1-120")!.text).includes("Coleman"), "ruleText drops the example");

  const msg = (id: string) => C.find((c) => c.id === id)!.text;
  ok(answerFormOk("2027-05-07", msg("set1-150")) && answerFormOk("EXPIRED:5", msg("set1-150")) && !answerFormOk("12", msg("set1-150")), "answer form: filing");
  ok(answerFormOk("7", msg("set1-76")) && answerFormOk("UNKNOWN_LOT", msg("set1-76")) && !answerFormOk("2026-01-01", msg("set1-76")), "answer form: recall");
  ok(answerFormOk("APPEAL:2026-12-15", msg("set1-120")) && !answerFormOk("APPEAL", msg("set1-120")) && !answerFormOk("MAYBE", msg("set1-120")), "answer form: claim");

  // --- hand-written plan: new vs established (practice message) reproduces its example ---
  const ne = C.find((c) => c.id === "practice-new-established")!.text;
  const NE: Plan = {
    inputs: [{ name: "patient", type: "patient" }, { name: "visitDate", type: "date" }, { name: "provider", type: "text" }],
    constants: { years: 3 },
    tables: { excluded: { headers: ["Service"], rows: ["Lab draw", "Immunization", "X-ray", "Ultrasound", "Electrocardiogram", "Echocardiogram", "Allergy injection", "Blood pressure check", "Hearing test", "Vision screening", "Infusion therapy", "Anticoagulation check"].map((s) => [s]) } },
    needs: [{ entity: "appointment", scope: "patient", fields: ["date", "status", "provider", "service"] }, { entity: "provider", scope: "clinic", fields: ["name", "specialty"] }],
    steps: [
      { id: "prov", expr: { op: "one", from: { op: "select", entity: "provider", where: { op: "eq", a: { var: "$.name" }, b: { var: "inputs.provider" } } } } },
      { id: "from", expr: { op: "addDays", date: { op: "addYears", date: { var: "inputs.visitDate" }, n: -3, feb29: "feb28" }, n: 1 } },
      { id: "to", expr: { op: "addDays", date: { var: "inputs.visitDate" }, n: -1 } },
      { id: "excl", expr: { op: "map", from: { op: "rows", table: "excluded" }, to: { var: "$.Service" } } },
      { id: "counts", expr: { op: "select", entity: "appointment", scope: "patient", where: { op: "and", args: [
        { op: "eq", a: { var: "$.status" }, b: "Completed" },
        { op: "ge", a: { var: "$.date" }, b: { var: "steps.from" } }, { op: "le", a: { var: "$.date" }, b: { var: "steps.to" } },
        { op: "not", a: { op: "in", value: { var: "$.service" }, list: { var: "steps.excl" } } },
        { op: "any", from: { op: "select", entity: "provider" }, where: { op: "and", args: [{ op: "eq", a: { var: "$.name" }, b: { var: "$$.provider" } }, { op: "eq", a: { var: "$.specialty" }, b: { var: "steps.prov.specialty" } }] } },
      ] } } },
    ],
    answer: { op: "if", cond: { op: "eq", a: { op: "count", from: { var: "steps.counts" } }, b: 0 }, then: "NEW", else: { op: "concat", parts: ["ESTABLISHED:", { op: "fmt", value: { op: "max", from: { var: "steps.counts" }, of: { var: "$.date" } }, as: "date" }] } },
  };
  eq(validatePlan(NE), [], "hand NE plan valid");
  const NEW_WORLD: World = { inputs: { patient: { name: "Stewart, Linda", dob: "2009-04-25" }, visitDate: "2026-11-05", provider: "Walter Guzman, PA" }, resolved: { patient: "p1" }, entities: {
    patient: [{ id: "p1", name: "Linda Stewart", dob: "2009-04-25" }],
    provider: [{ id: "v1", name: "Walter Guzman, PA", specialty: "Behavioral Health" }, { id: "v2", name: "Lawrence Bennett, MD", specialty: "Behavioral Health" }, { id: "v3", name: "Ana Ruiz, MD", specialty: "Cardiology" }],
    appointment: [
      { id: "a1", patientId: "p1", date: "2026-06-18", status: "Completed", provider: "Lawrence Bennett, MD", service: "Prenatal visit" },
      { id: "a2", patientId: "p1", date: "2026-09-01", status: "No-show", provider: "Walter Guzman, PA", service: "Follow-up" },
      { id: "a3", patientId: "p1", date: "2026-10-01", status: "Completed", provider: "Walter Guzman, PA", service: "Lab draw" },
      { id: "a4", patientId: "p1", date: "2026-10-02", status: "Completed", provider: "Ana Ruiz, MD", service: "Follow-up" },
      { id: "a5", patientId: "p1", date: "2023-11-05", status: "Completed", provider: "Walter Guzman, PA", service: "Follow-up" },
    ] } };
  eq((await runPlan(NE, NEW_WORLD)).answer, workedExample(ne)!.answer, "hand NE plan reproduces the practice example");
  const m1 = mutate(NEW_WORLD, 42), m2 = mutate(NEW_WORLD, 42);
  eq(m1.what, m2.what, "mutation is deterministic");
  ok(hardcoded({ ...NE, answer: "ESTABLISHED:2026-06-18" }, workedExample(ne)!, ruleText(ne)).length > 0, "hardcode guard fires");
  eq(hardcoded(NE, workedExample(ne)!, ruleText(ne)), [], "hardcode guard quiet on a real plan");

  // --- the pipeline with a canned model: both writers give NE, the world builder gives NEW_WORLD ---
  const canned: Caller = async (msgs) => {
    const sys = msgs[0].content;
    if (sys.startsWith("You compile")) return JSON.stringify(NE);
    if (sys.startsWith("You encode")) return JSON.stringify({ patientId: "p1", entities: NEW_WORLD.entities });
    if (sys.startsWith("Extract")) return JSON.stringify({ patient: { name: "Stewart, Linda", dob: "2009-04-25" }, visitDate: "2026-11-05", provider: "Walter Guzman, PA" });
    return null;
  };
  const v = await compileVerified(ne, { planModels: ["m1", "m2"], worldModel: "w", inputModel: "i", caller: canned, mutations: 25 });
  ok(v.ok, "canned pipeline accepts: " + v.reason);
  // a wrong second plan (window 2 years) must be caught by the example or by agreement
  const NE2 = JSON.parse(JSON.stringify(NE)); NE2.steps[1].expr.date.n = -2;
  const canned2: Caller = async (msgs, model, o) => msgs[0].content.startsWith("You compile") ? JSON.stringify(model === "m2" ? NE2 : NE) : canned(msgs, model, o);
  const v2 = await compileVerified(ne, { planModels: ["m1", "m2"], worldModel: "w", inputModel: "i", caller: canned2, mutations: 60 });
  ok(!v2.ok, "a 2-year-window plan is not accepted alongside the 3-year one: " + v2.reason);

  console.log(`solver selftest: ${n - fails}/${n} ok`);
  process.exit(fails ? 1 : 0);
})();
