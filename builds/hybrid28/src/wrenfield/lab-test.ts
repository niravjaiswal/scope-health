/**
 * Lab-report triage checks (offline, no browser, no model):
 *   A. engine edge cases against the governing message's own text (exact limits, exact change %,
 *      sex neither F/M, sex unread, Feb 29 ages, diabetes on the problem list, 65 boundary);
 *   B. previous-report selection (filed twice, other record number, tie → higher report number,
 *      12-month window incl. Feb 29, received date plays no part, unreadable → unknown);
 *   C. name-only patient resolution over a paged, sorted list (namesake on a later page, accents,
 *      "Last, First", list not read far enough → skip);
 *   D. slot extraction: every Set 1 lab question gives the same slots as the Set 1 patterns, ≥5
 *      paraphrases per slot shape, and hard negatives that must not route.
 *   npx tsx src/wrenfield/lab-test.ts
 */
import { readFileSync } from "node:fs";
import { parseLabRule, triageLab, changeExceeds, ageOn, windowStart, pickPrevious, problemListHasT2DM, type LabPatient } from "./labTriage.js";
import { resolveByName, sortsAfter, searchTerms, rowMatches, type Row } from "./nameResolve.js";
import { extractLabSlots, findDates } from "./labSlots.js";
import { familyMatch } from "./families.js";

let pass = 0, fail = 0;
const eq = (got: unknown, want: unknown, label: string) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { fail++; console.error(`✗ ${label}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`); }
};

const items = readFileSync(new URL("../../fixtures/set1-items.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { n: number; kind: string; text: string });
const MSG = items.find((i) => i.kind === "message" && /lab report/i.test(i.text) && /NOT_COVERED/.test(i.text))!.text;
const rule = parseLabRule(MSG);

// ── A. engine ──
const F = (age = 40, dm: boolean | "unknown" = false): LabPatient => ({ sex: "Female", ageAtCollection: age, hasT2DM: dm });
const M = (age = 40, dm: boolean | "unknown" = false): LabPatient => ({ sex: "Male", ageAtCollection: age, hasT2DM: dm });
const O = (age = 40): LabPatient => ({ sex: "Other", ageAtCollection: age, hasT2DM: false });
const U = (age = 40): LabPatient => ({ sex: "Unknown", ageAtCollection: age, hasT2DM: false });
const cbc = (v: Partial<Record<string, number>> = {}) => ({ panel: "Complete blood count", values: { "White blood cell count": 7.0, Hemoglobin: 13.0, Hematocrit: 40.0, "Platelet count": 250, ...v } as Record<string, number> });
const bmp = (v: Partial<Record<string, number>> = {}) => ({ panel: "Basic metabolic panel", values: { Sodium: 140, Potassium: 4.0, Chloride: 100, "Carbon dioxide": 25, "Blood urea nitrogen": 15, Creatinine: 0.9, Glucose: 85, Calcium: 9.5, ...v } as Record<string, number> });
const tsh = (v: Partial<Record<string, number>> = {}) => ({ panel: "Thyroid panel", values: { "Thyroid stimulating hormone": 2.0, "Free T4": 1.2, ...v } as Record<string, number> });

eq(triageLab(rule, bmp({ Sodium: 145, Potassium: 5.0, Chloride: 98, "Carbon dioxide": 23, "Blood urea nitrogen": 17, Creatinine: 1.17, Glucose: 85, Calcium: 9.7 }), F(14), "none"), "NURSE_REVIEW:1", "worked example (Nancy Oliver)");
// change rule — the message's own Hemoglobin example: 12.0 → 13.8 is exactly 15 % → not an item; 13.9 is
eq(triageLab(rule, cbc({ Hemoglobin: 13.8 }), F(), { Hemoglobin: 12.0, "Platelet count": 250 }), "RELEASE", "Hgb 12.0→13.8 exactly 15% is not a review item (float said 15.000000000000005)");
eq(triageLab(rule, cbc({ Hemoglobin: 13.9 }), F(), { Hemoglobin: 12.0, "Platelet count": 250 }), "NURSE_REVIEW:1", "Hgb 12.0→13.9 >15% is a review item");
eq(triageLab(rule, cbc({ Hemoglobin: 14.0 }), F(), { Hemoglobin: 16.1, "Platelet count": 250 }), "RELEASE", "Hgb 16.1→14.0 down 13% in range");
eq(triageLab(rule, cbc({ Hemoglobin: 14.0, Hematocrit: 45 }), M(), { Hemoglobin: 16.1, "Platelet count": 250 }), "RELEASE", "Hgb 16.1→14.0 (male) in range, <15%");
eq(triageLab(rule, cbc({ Hemoglobin: 16.1, Hematocrit: 45 }), M(), { Hemoglobin: 14.0, "Platelet count": 250 }), "RELEASE", "Hgb 14.0→16.1 exactly 15% (float FP)");
eq(triageLab(rule, cbc({ "Platelet count": 260 }), F(), { Hemoglobin: 13.0, "Platelet count": 200 }), "RELEASE", "Plt 200→260 exactly 30%");
eq(triageLab(rule, cbc({ "Platelet count": 261 }), F(), { Hemoglobin: 13.0, "Platelet count": 200 }), "NURSE_REVIEW:1", "Plt 200→261 >30%");
eq(triageLab(rule, cbc({ "Platelet count": 170 }), F(), { Hemoglobin: 13.0, "Platelet count": 250 }), "NURSE_REVIEW:1", "Plt 250→170 down 32%");
eq(triageLab(rule, bmp({ Creatinine: 0.75 }), F(), { Creatinine: 0.60 }), "RELEASE", "Creat 0.60→0.75 exactly 25% (float FP)");
eq(triageLab(rule, bmp({ Creatinine: 0.6 }), F(), { Creatinine: 0.8 }), "RELEASE", "Creat 0.8→0.6 exactly 25% down (float FP)");
eq(triageLab(rule, bmp({ Creatinine: 1.10 }), F(), { Creatinine: 0.88 }), "RELEASE", "Creat 0.88→1.10 exactly 25%, 1.10 on the female end");
eq(triageLab(rule, bmp({ Creatinine: 1.11 }), F(), { Creatinine: 0.88 }), "NURSE_REVIEW:1", "Creat 1.11 out of female range and >25% → ONE item");
eq(triageLab(rule, bmp({ Creatinine: 1.0 }), M(), { Creatinine: 0.79 }), "NURSE_REVIEW:1", "Creat 0.79→1.0 >25% while in range");
// exact limits / range ends
eq(triageLab(rule, cbc({ Hemoglobin: 7.0 }), F(), "none"), "NURSE_REVIEW:1", "Hgb exactly 7.0 is not critical (out of range → review)");
eq(triageLab(rule, cbc({ Hemoglobin: 6.9 }), F(), "unknown"), "CALL_PROVIDER_NOW:Hemoglobin", "Hgb 6.9 critical (prev irrelevant)");
eq(triageLab(rule, bmp({ Potassium: 6.2, Sodium: 120 }), F(), "none"), "NURSE_REVIEW:2", "K 6.2 / Na 120 exactly at limits: not critical, out of range");
eq(triageLab(rule, bmp({ Potassium: 6.3, Sodium: 119.9, Glucose: 401 }), F(), "none"), "CALL_PROVIDER_NOW:Glucose,Potassium,Sodium", "criticals alphabetical");
eq(triageLab(rule, bmp({ Sodium: 135, Potassium: 3.5, Chloride: 107, "Carbon dioxide": 22, Calcium: 10.2 }), F(), "none"), "RELEASE", "values exactly on review-range ends are in range");
eq(triageLab(rule, bmp({ "Blood urea nitrogen": 100 }), F(), "none"), "NURSE_REVIEW:1", "BUN exactly 100 not critical");
eq(triageLab(rule, bmp({ "Blood urea nitrogen": 101 }), F(), "none"), "CALL_PROVIDER_NOW:Blood urea nitrogen", "BUN 101 critical");
eq(triageLab(rule, bmp({ Chloride: 60 }), F(), "none"), "NURSE_REVIEW:1", "Chloride has no critical limit");
// sex neither F nor M → in range if inside EITHER range; sex unread → skip only if it matters
eq(triageLab(rule, cbc({ Hemoglobin: 12.5, Hematocrit: 37 }), O(), "none"), "RELEASE", "sex Other: Hgb 12.5 / Hct 37 inside the female range");
eq(triageLab(rule, cbc({ Hemoglobin: 17.0, Hematocrit: 52 }), O(), "none"), "RELEASE", "sex Other: Hgb 17.0 / Hct 52 inside the male range");
eq(triageLab(rule, cbc({ Hemoglobin: 11.9 }), O(), "none"), "NURSE_REVIEW:1", "sex Other: Hgb 11.9 outside both");
eq(triageLab(rule, cbc({ Hemoglobin: 13.0 }), U(), "none"), null, "sex unread and Hgb 13.0 differs F/M → skip");
eq(triageLab(rule, cbc({ Hemoglobin: 14.0, Hematocrit: 42 }), U(), "none"), "RELEASE", "sex unread but in both ranges → answer");
eq(triageLab(rule, cbc({ Hemoglobin: 13.0, "White blood cell count": 1.0 }), U(), "none"), "CALL_PROVIDER_NOW:White blood cell count", "sex unread, critical decides");
// diabetes on the problem list
eq(triageLab(rule, bmp({ Glucose: 150 }), F(50, true), "none"), "RELEASE", "T2DM: glucose 150 in 70–180");
eq(triageLab(rule, bmp({ Glucose: 180 }), F(50, true), "none"), "RELEASE", "T2DM: glucose exactly 180 in range");
eq(triageLab(rule, bmp({ Glucose: 150 }), F(50, false), "none"), "NURSE_REVIEW:1", "no T2DM: glucose 150 out of 70–99");
eq(triageLab(rule, bmp({ Glucose: 150 }), F(50, "unknown"), "none"), null, "problem list unread and glucose 150 → skip");
eq(triageLab(rule, bmp({ Glucose: 85 }), F(50, "unknown"), "none"), "RELEASE", "problem list unread, glucose 85 → same either way");
eq(triageLab(rule, bmp({ Glucose: 190 }), F(50, "unknown"), "none"), "NURSE_REVIEW:1", "problem list unread, glucose 190 out either way");
eq(triageLab(rule, bmp({ Glucose: 65 }), F(50, true), "none"), "NURSE_REVIEW:1", "T2DM: glucose 65 below 70");
// age 65 boundary (BUN, TSH)
eq(triageLab(rule, bmp({ "Blood urea nitrogen": 22 }), F(64), "none"), "NURSE_REVIEW:1", "BUN 22 at 64 → out (7–20)");
eq(triageLab(rule, bmp({ "Blood urea nitrogen": 22 }), F(65), "none"), "RELEASE", "BUN 22 at 65 → in (8–26)");
eq(triageLab(rule, bmp({ "Blood urea nitrogen": 7.5 }), F(65), "none"), "NURSE_REVIEW:1", "BUN 7.5 at 65 → out (8–26)");
eq(triageLab(rule, tsh({ "Thyroid stimulating hormone": 5.5 }), F(64), "none"), "NURSE_REVIEW:1", "TSH 5.5 at 64 → out");
eq(triageLab(rule, tsh({ "Thyroid stimulating hormone": 5.5 }), F(65), "none"), "RELEASE", "TSH 5.5 at 65 → in");
eq(triageLab(rule, tsh({ "Free T4": 1.8 }), F(30), "unknown"), "RELEASE", "Thyroid panel has no change rule: unknown previous irrelevant");
// change-rule bookkeeping
eq(triageLab(rule, cbc(), F(), "unknown"), null, "in-range change-rule test + unknown previous → skip");
eq(triageLab(rule, cbc({ Hemoglobin: 11.0, "Platelet count": 140 }), F(), "unknown"), "NURSE_REVIEW:2", "both change-rule tests already out of range → previous not needed");
eq(triageLab(rule, cbc(), F(), { Hemoglobin: 13.0 }), null, "previous read but Platelet value missing → skip");
eq(triageLab(rule, { panel: "Lipid panel", values: {} }, F(), "none"), "NOT_COVERED", "other panel → NOT_COVERED");
// exact change arithmetic matches rational arithmetic on every 1- and 2-decimal boundary pair
{
  let bad = 0, n = 0;
  for (let p = 40; p <= 300; p++) for (const pct of [15, 25, 30]) for (const scale of [10, 100]) for (const dir of [1, -1]) {
    const num = p * (100 + dir * pct); if (num % 100 !== 0) continue; // v = p·(1±pct) exactly representable at this scale
    const v = num / 100 / scale, pv = p / scale; n++;
    if (changeExceeds(v, pv, pct)) bad++;                                    // exactly pct → never "more than"
    if (!changeExceeds(v + dir / scale, pv, pct)) bad++;                     // one printed step further → more than
  }
  eq({ bad, some: n > 100 }, { bad: 0, some: true }, `changeExceeds exact on ${n} boundary pairs`);
}
// ages, Feb 29, window
eq([ageOn("2008-02-29", "2026-02-28"), ageOn("2008-02-29", "2026-03-01"), ageOn("2008-02-29", "2024-02-29"), ageOn("1961-10-14", "2026-10-13"), ageOn("1961-10-14", "2026-10-14")], [17, 18, 16, 64, 65], "ages incl. Feb 29 (older on Mar 1 in common years)");
eq([windowStart("2026-05-10"), windowStart("2024-02-29"), windowStart("2025-03-01"), windowStart("2026-01-31")], ["2025-05-10", "2023-02-28", "2024-03-01", "2025-01-31"], "12-month window start (Feb 29 → Feb 28)");
eq([problemListHasT2DM(["Type 2 diabetes mellitus"]), problemListHasT2DM(["Type 2 diabetes mellitus without complications", "Hypertension"]), problemListHasT2DM(["Diabetes mellitus, type 2"]),
  problemListHasT2DM(["Type 1 diabetes mellitus"]), problemListHasT2DM(["Prediabetes"]), problemListHasT2DM(["Family history of type 2 diabetes mellitus"]), problemListHasT2DM(["Gestational diabetes"]), problemListHasT2DM([])],
  [true, true, true, false, false, false, false, false], "problem list T2DM by condition name");

// ── B. previous report ──
const V = (h: number) => ({ Hemoglobin: h, "Platelet count": 250 });
const asked = { collected: "2026-05-10", report: "R-5001", record: "MRN100" };
eq(pickPrevious(asked, []), "none", "no other report → none");
eq(pickPrevious(asked, [{ collected: "2026-01-02", report: "R-4000", record: "MRN100", values: V(11) }, { collected: "2026-03-02", report: "R-4500", record: "MRN100", values: V(12) }]), V(12), "latest collected before");
eq(pickPrevious(asked, [{ collected: "2026-05-10", report: "R-5001", record: "MRN100", values: V(9) }, { collected: "2026-03-02", report: "R-4500", record: "MRN100", values: V(12) }]), V(12), "same report number filed twice is not a previous");
eq(pickPrevious(asked, [{ collected: "2026-04-01", report: "R-4800", record: "MRN999", values: V(9) }, { collected: "2026-03-02", report: "R-4500", record: "MRN100", values: V(12) }]), V(12), "another record number is ignored");
eq(pickPrevious(asked, [{ collected: "2026-04-01", report: "R-4800", record: "MRN999", values: V(9) }]), "none", "only another chart's report → none");
eq(pickPrevious(asked, [{ collected: "2026-03-02", report: "R-4500", record: "MRN100", values: V(12) }, { collected: "2026-03-02", report: "R-4600", record: "MRN100", values: V(14) }]), V(14), "tie on collected → higher report number");
eq(pickPrevious(asked, [{ collected: "2026-03-02", report: "R-990", record: "MRN100", values: V(12) }, { collected: "2026-03-02", report: "R-1000", record: "MRN100", values: V(14) }]), V(14), "tie: report numbers compared as numbers (1000 > 990)");
eq(pickPrevious(asked, [{ collected: "2026-03-02", report: undefined, record: "MRN100", values: V(12) }, { collected: "2026-03-02", report: "R-4600", record: "MRN100", values: V(14) }]), "unknown", "tie with an unread report number → unknown");
eq(pickPrevious(asked, [{ collected: "2025-05-10", report: "R-1", record: "MRN100", values: V(12) }]), V(12), "collected exactly 12 months before → used");
eq(pickPrevious(asked, [{ collected: "2025-05-09", report: "R-1", record: "MRN100", values: V(12) }]), "none", "collected 12 months + 1 day before → none");
eq(pickPrevious({ collected: "2024-02-29", report: "R-9", record: "M1" }, [{ collected: "2023-02-28", report: "R-1", record: "M1", values: V(12) }]), V(12), "Feb 29 report: Feb 28 a year earlier is inside");
eq(pickPrevious({ collected: "2024-02-29", report: "R-9", record: "M1" }, [{ collected: "2023-02-27", report: "R-1", record: "M1", values: V(12) }]), "none", "Feb 29 report: Feb 27 a year earlier is outside");
eq(pickPrevious(asked, [{ collected: "2026-06-01", report: "R-6000", record: "MRN100", values: V(9) }]), "none", "a report collected after this one is not a previous");
eq(pickPrevious(asked, [{ collected: "2025-01-01", report: "R-1", record: "MRN100", values: V(9) }, { collected: "2025-12-01", report: "R-2", record: "MRN100", values: V(12) }]), V(12), "latest wins even when the older one is in the window too");
eq(pickPrevious(asked, [{ collected: "2026-03-02", report: "R-4500", record: undefined, values: V(12) }]), "unknown", "candidate record number unread → unknown");
eq(pickPrevious(asked, [{ collected: undefined, report: "R-4500", record: "MRN100", values: V(12) }]), "unknown", "candidate collected date unread → unknown");
eq(pickPrevious({ collected: "2026-05-10", report: "R-5001" }, [{ collected: "2026-03-02", report: "R-4500", record: "MRN100", values: V(12) }]), "unknown", "asked report's record number unread → unknown");
eq(pickPrevious(asked, [{ collected: "2026-03-02", report: "R-4500", record: "mrn-100", values: V(12) }]), V(12), "record numbers compared ignoring case/punctuation");
// end to end: previous chosen then the exact change rule
eq(triageLab(rule, cbc({ Hemoglobin: 13.8 }), F(), pickPrevious(asked, [{ collected: "2026-03-02", report: "R-4500", record: "MRN100", values: { Hemoglobin: 12.0, "Platelet count": 250 } }, { collected: "2026-04-01", report: "R-4800", record: "MRN999", values: { Hemoglobin: 10.0, "Platelet count": 250 } }])), "RELEASE", "misfiled 10.0 ignored; 12.0→13.8 exactly 15% → RELEASE");

// ── B2. the hand-labelled lab cases (fixtures/set1/workflow-cases.json, worked out from the message) ──
{
  const cases = (JSON.parse(readFileSync(new URL("../../fixtures/set1/workflow-cases.json", import.meta.url), "utf8")) as any[]).filter((c) => c.family === "lab-report-triage");
  let ran = 0, ok = 0; const bad: string[] = [];
  const base: Record<string, Record<string, number>> = { "complete blood count": cbc({ Hemoglobin: 14.0, Hematocrit: 42 }).values, "basic metabolic panel": bmp().values, "thyroid panel": tsh().values };
  const check = (got: unknown, want: unknown, c: any) => { ran++; if (JSON.stringify(got) === JSON.stringify(want)) ok++; else bad.push(`${c.kind}/${c.subrule ?? "answer"} ${JSON.stringify(c.input).slice(0, 120)} → got ${JSON.stringify(got)} want ${JSON.stringify(c.expected)}`); };
  for (const c of cases) {
    const i = c.input;
    if (c.subrule === "fails_change_rule") check(changeExceeds(i.current, i.previous, i.threshold_pct), c.expected, c);
    else if (c.subrule === "previous_report_usable") check(i.previous_collected >= windowStart(i.collected), c.expected, c);
    else if (c.subrule === "age_years") check(ageOn(i.dob, i.collected), c.expected, c);
    else if (c.subrule === "report_belongs_to_chart") check(pickPrevious({ collected: "2026-05-10", report: "R9", record: i.chart_record_number }, [{ collected: "2026-03-01", report: "R1", record: i.report_record_number, values: V(1) }]) === "none" ? "IGNORE" : "USE", c.expected, c);
    else if (c.subrule === "previous_report_pick" && i.candidates) {
      const v = pickPrevious({ collected: i.this_collected, report: "R9", record: "M" }, i.candidates.map((x: any) => ({ collected: x.collected, report: x.report_no, record: "M", values: { tag: Number(x.report_no.replace(/\D/g, "")) } })));
      check(typeof v === "object" ? `R${v.tag}` : v, c.expected, c);
    } else if (c.subrule === "previous_report_pick" && i.chart_copies) {
      const v = pickPrevious({ collected: "2026-05-01", report: i.this_report_no, record: "M" }, i.chart_copies.slice(1).map((x: any) => ({ collected: "2026-05-01", report: x.report_no, record: "M", values: {} })));
      check(v === "none" ? null : v, c.expected, c);
    } else if (c.subrule === "out_of_range") {
      const panel = /blood urea|glucose/i.test(i.test) ? "basic metabolic panel" : /thyroid/i.test(i.test) ? "thyroid panel" : "complete blood count";
      const values = { ...base[panel], [i.test]: Number(i.value) };
      const pt: LabPatient = { sex: i.sex ? "Other" : "Female", ageAtCollection: i.age ?? 40, hasT2DM: !!i.t2dm_on_problem_list };
      const r = triageLab(rule, { panel, values }, pt, "none");
      check(r === "NURSE_REVIEW:1", c.expected, c);
    } else if (c.level === "answer" && (i.abnormal || i.critical_tests === undefined) && i.panel && !/after|on or after/i.test(String(i.received_before ?? "")) && !(i.received >= "2026-06-01" && /metabolic/i.test(i.panel))) {
      const panel = String(i.panel).toLowerCase();
      if (!base[panel]) { if (c.expected === "NOT_COVERED") check(triageLab(rule, { panel: i.panel, values: {} }, F(), "none"), c.expected, c); continue; }
      if (!i.abnormal && !i.results) continue;
      const vals = typeof i.results === "object" ? i.results : { ...base[panel], ...Object.fromEntries(Object.entries(i.abnormal ?? {}).map(([k, v]) => [k, Number(v)])) };
      const p = i.patient ?? {}; const sexes: Array<LabPatient["sex"]> = p.sex ? [/female/i.test(p.sex) ? "Female" : "Male"] : ["Female", "Male"];
      for (const sx of sexes) check(triageLab(rule, { panel, values: vals }, { sex: sx, ageAtCollection: p.age_at_collection ?? 40, hasT2DM: !!p.t2dm_on_problem_list }, "none"), c.expected, c);
    }
  }
  if (bad.length) console.error(bad.map((b) => "  " + b).join("\n"));
  console.log(`hand-labelled workflow cases: ${ok}/${ran} (of ${cases.length} lab cases)`);
  eq([ok, ran >= 60], [ran, true], `hand-labelled workflow cases: ${ok}/${ran}`);
}

// ── C. name-only resolution over a sorted, paged list ──
const mk = (n: string, i: number): Row => ({ name: n, href: `/patients/${i}`, dob: "01/01/1980" });
const murphy = ["Abigail", "Adam", "Ahmed", "Ahmed", "Alexander", "Amanda", "Amy", "Andrew", "Angela", "Anthony", "Barbara", "Betty", "Brian", "Camila", "Carol", "Charles", "Christopher", "Daniel", "David", "Deborah", "Dennis", "Donald", "Donna", "Edward", "Elizabeth", "Emily", "Eric", "Frank", "Gary", "George", "Helen", "Jacob", "James", "Jason", "Jennifer", "Jessica", "John", "Joseph", "Karen", "Kenneth", "Laura", "Linda", "Lisa", "Mark", "Mary", "Matthew", "Michael", "Nancy", "Patricia", "Paul", "Rebecca", "Richard", "Robert", "Sandra", "Sarah", "Steven", "Susan", "Teresa", "Thomas", "Timothy", "William"].map((f, i) => mk(`Murphy, ${f}`, i));
const pages = (rows: Row[], size = 20) => Array.from({ length: Math.ceil(rows.length / size) }, (_, i) => rows.slice(i * size, i * size + size));
/** Simulate the crawler: read pages until the last row sorts past the name or the list ends. */
const readUntil = (rows: Row[], name: string, size = 20) => { const ps = pages(rows, size); const got: Row[] = []; let i = 0; for (; i < ps.length; i++) { got.push(...ps[i]); if (sortsAfter(ps[i][ps[i].length - 1].name, name)) return { got, complete: true, pages: i + 1 }; } return { got, complete: true, pages: i }; };
{
  const r = readUntil(murphy, "Teresa Murphy"); const res = resolveByName(r.got, "Teresa Murphy", r.complete);
  eq([r.pages, res.chosen?.name], [3, "Murphy, Teresa"], "Teresa Murphy on page 3 resolves after paging (158: page 1 only → skip)");
  eq(resolveByName(pages(murphy)[0], "Teresa Murphy", false).chosen, null, "page 1 only, not past the name → skip");
  // 17 a page: page 1 ends on Murphy, Christopher; a namesake opens page 2
  const two = [...murphy.slice(0, 17), mk("Murphy, Christopher", 900), ...murphy.slice(17)];
  eq(pages(two, 17)[0].filter((r) => /Christopher/.test(r.name)).length, 1, "fixture: one Christopher on page 1");
  eq(resolveByName(pages(two, 17)[0], "Christopher Murphy", true).chosen?.href, "/patients/16", "(what page 1 alone would have chosen)");
  const r2 = readUntil(two, "Christopher Murphy", 17); const res2 = resolveByName(r2.got, "Christopher Murphy", r2.complete);
  eq([r2.pages, res2.chosen, (res2 as any).why], [2, null, "2 patients named Christopher Murphy"], "namesake on the next page → read → ambiguous → skip");
  const p1 = pages(two, 17)[0]; eq(sortsAfter(p1[p1.length - 1].name, "Christopher Murphy"), false, "page ending ON the name is not proof (namesake may follow)");
  eq(resolveByName(murphy, "Ahmed Murphy", true).chosen, null, "two Ahmed Murphy → skip");
  eq(resolveByName(murphy, "Murphy, Camila", true).chosen?.name, "Murphy, Camila", "\"Last, First\" asked");
  eq(resolveByName([mk("Martínez, Noëlle", 1), mk("Martinez, Nora", 2)], "Noelle Martinez", true).chosen?.name, "Martínez, Noëlle", "accents folded both ways");
  eq(resolveByName([mk("Martinez, Noelle", 1)], "Noëlle Martinez", true).chosen?.name, "Martinez, Noelle", "accent in the task only");
  eq(resolveByName([mk("Rivera, Jose Luis", 1), mk("Rivera, Jose", 2)], "Jose Rivera", true).chosen, null, "Jose Rivera vs Jose Luis Rivera → ambiguous");
  eq(resolveByName([mk("O'Brien, Adam", 1)], "Adam OBrien", true).chosen?.name, "O'Brien, Adam", "apostrophe-insensitive");
  eq(resolveByName([mk("Wallace, Matthew", 1), mk("Walls, Matthew", 2)], "Matthew Wells", true).chosen, null, "sound-alike rows are not the name");
  eq(rowMatches("Smith-Jones, Mary", "Mary Smith-Jones"), true, "hyphenated surname");
  // sound-alike list: Martin rows precede Martinez; a "Martinez" row does not prove the end of "Martin"
  eq([sortsAfter("Martinez, Adam", "Noelle Martin"), sortsAfter("Martins, Adam", "Noelle Martinez"), sortsAfter("Morton, Adam", "Noelle Martin"), sortsAfter("Murphy, Thomas", "Teresa Murphy"), sortsAfter("Murphy, Teresa Ann", "Teresa Murphy"), sortsAfter("Garcia, Helen", "George García")],
    [false, true, true, true, false, true], "sortsAfter: collation-safe end-of-namesakes proof");
  eq([searchTerms("Anderson, Evelyn"), searchTerms("Noëlle Martinez"), searchTerms("Maria De la Cruz"), searchTerms("Cher")], [["Anderson"], ["Martinez"], ["Cruz", "De la Cruz"], []], "search terms (Last, First; compound)");
}

// ── D. slots: Set 1 phrasings, paraphrases, hard negatives ──
{
  const lab = items.filter((i) => i.kind === "task" && familyMatch(i.text)?.family === "lab-report-triage");
  let same = 0, n = 0;
  for (const it of lab) {
    const fm = familyMatch(it.text)!.slots; const x = extractLabSlots(it.text); n++;
    const norm = (s?: string) => (s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/,/g, " ").split(/\s+/).filter(Boolean).sort().join(" ");
    if (x && norm(x.name) === norm(fm.name) && x.panel.toLowerCase() === fm.panel.toLowerCase() && x.received === fm.received && (x.dob ?? "") === (fm.dob ?? "")) same++;
    else console.error(`  extractor differs on n=${it.n}: ${JSON.stringify(x)} vs ${JSON.stringify(fm)}`);
  }
  eq([same, n], [45, 45], "variant test: the paraphrase extractor gives the Set 1 slots on all 45 Set 1 lab questions");
}
const P = (text: string, want: { panel: string; name: string; dob?: string; received: string } | null, label: string) => {
  const fm = familyMatch(text);
  const got = fm && fm.family === "lab-report-triage" && fm.slots.panel && fm.slots.name && fm.slots.received ? { panel: fm.slots.panel, name: fm.slots.name, ...(fm.slots.dob ? { dob: fm.slots.dob } : {}), received: fm.slots.received } : null;
  eq(got, want ? { panel: want.panel, name: want.name, ...(want.dob ? { dob: want.dob } : {}), received: want.received } : null, label);
};
// paraphrases — name order, DOB present/absent, ISO/US/written dates, reordered clauses (none copied from Set 1)
P("Teresa Murphy's complete blood count came in on 09/30/2026 — call the provider, nurse review, or release?", { panel: "Complete blood count", name: "Teresa Murphy", received: "2026-09-30" }, "para: possessive, US date, CBC lower-case");
P("Can you triage the Basic metabolic panel for Peters, Omar received May 30, 2026?", { panel: "Basic metabolic panel", name: "Peters, Omar", received: "2026-05-30" }, "para: Last, First + written date");
P("Lab report triage: patient Billy Nguyen (date of birth 3/14/1990), CBC received 2025-07-05. What should we do?", { panel: "Complete blood count", name: "Billy Nguyen", dob: "1990-03-14", received: "2025-07-05" }, "para: CBC abbreviation + US DOB");
P("We got a thyroid panel for Emma Howard, born October 9, 2011, received on 12 August 2026. What happens to it?", { panel: "Thyroid panel", name: "Emma Howard", dob: "2011-10-09", received: "2026-08-12" }, "para: written DOB + day-month date");
P("What's the next step for the Basic metabolic panel received 2025-11-20 for Matthew Wells?", { panel: "Basic metabolic panel", name: "Matthew Wells", received: "2025-11-20" }, "para: received before name");
P("Received 2026-06-13: Complete blood count for Jose Wheeler. Release it to the patient, nurse review, or call the provider?", { panel: "Complete blood count", name: "Jose Wheeler", received: "2026-06-13" }, "para: date first, clauses reordered");
P("How should we handle the lipid panel filed 2025-09-21 for Patricia Butler (DOB 05/16/1983)?", { panel: "Lipid panel", name: "Patricia Butler", dob: "1983-05-16", received: "2025-09-21" }, "para: other panel + filed + US DOB");
P("Decide what to do with Noëlle Martinez's complete blood count lab report, which arrived Aug 26, 2026.", { panel: "Complete blood count", name: "Noëlle Martinez", received: "2026-08-26" }, "para: accents + arrived + abbreviated month");
P("Please triage: García, George — Complete blood count — received 10/14/2026", { panel: "Complete blood count", name: "García, George", received: "2026-10-14" }, "para: dashes, Last, First");
P("For Maria De la Cruz, the BMP received 2026-02-03: call provider, nurse review or release?", { panel: "Basic metabolic panel", name: "Maria De la Cruz", received: "2026-02-03" }, "para: compound surname + BMP");
// hard negatives — similar wording, different question, or a slot that can't be pinned down
P("Who ordered the Complete blood count lab report for Teresa Murphy received on 2026-09-30?", null, "neg: who ordered");
P("When was the Basic metabolic panel lab report for Omar Peters received?", null, "neg: when received (no received date)");
P("What was the potassium value on the Basic metabolic panel for Omar Peters received 2026-05-30?", null, "neg: a single value");
P("How many lab reports were received on 2026-09-30?", null, "neg: count");
P("What happens to the lab report for Teresa Murphy received 2026-09-30?", null, "neg: no panel named");
P("What happens to the Complete blood count for Teresa Murphy or Teresa Murphy-Lee received 2026-09-30?", null, "neg: two names");
P("Next step for the Complete blood count for Teresa Murphy received 2026-09-30 or 2026-10-01?", null, "neg: two received dates");
P("What happens to the Complete blood count and the Basic metabolic panel for Teresa Murphy received 2026-09-30?", null, "neg: two panels");
P("Is Teresa Murphy new or established for Amy Fuller on 2026-09-30?", null, "neg: new vs established");
P("What is the reference range for potassium on a Basic metabolic panel?", null, "neg: reference range");
eq(findDates("born 02/29/2023 and 2026-02-30 and Feb 29, 2024").map((d) => d.iso), ["2024-02-29"], "invalid calendar dates are not dates");

console.log(`\n${fail ? "✗" : "✓"} lab-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
