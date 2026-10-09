/**
 * Lab-report triage engine (family `lab-report-triage`). The limits TABLE is parsed from the
 * governing message (so a version that changes the numbers is handled by re-reading, not a code
 * change); the decision runs in code. PURE: values + patient context + optional previous report →
 * `CALL_PROVIDER_NOW:… / NURSE_REVIEW:n / RELEASE / NOT_COVERED`, or null (can't apply → skip).
 * The OCR reader extracts the raw values; this never trusts the model for the outcome.
 * Self-check (incl. the message's worked example) offline: `npx tsx src/wrenfield/labTriage.ts`.
 */

import { tablesIn, colIdx, headingsIn } from "./policyText.js";

export interface TestRule {
  test: string;                       // canonical test name as the report prints it
  reviewF?: [number, number]; reviewM?: [number, number]; // sex ranges, if sex-specific
  reviewUnder65?: [number, number]; reviewOver65?: [number, number]; // age ranges, if age-specific
  reviewT2DM?: [number, number];      // range when Type 2 diabetes is on the problem list
  review?: [number, number];          // plain range
  critLow?: number; critHigh?: number;
  changePct?: number;                 // change-rule threshold (%), if any
}
export interface PanelRule { panel: string; tests: TestRule[] }
export interface LabRule { covered: Set<string>; panels: Map<string, PanelRule> }

const num = (s: string): number | undefined => { const m = (s || "").match(/-?\d+(?:\.\d+)?/); return m ? Number(m[0]) : undefined; };
const range = (s: string): [number, number] | undefined => { const m = (s || "").match(/(-?\d+(?:\.\d+)?)\s*to\s*(-?\d+(?:\.\d+)?)/i); return m ? [Number(m[1]), Number(m[2])] : undefined; };
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** The covered-panel list, read the same way everywhere (compiler, engine, policy log): the first line
 *  of a section whose heading is about the panels the rule covers (any heading form or wording), or the
 *  sentence before "any other panel … NOT_COVERED". Both present and different → null (unclear). */
export function labCoveredPanels(message: string): string[] | null {
  const items = (line: string): string[] | null => {
    const xs = line.replace(/`/g, "").split(".")[0].split(/,\s*(?:and\s+|or\s+)?|\s+and\s+/).map((x) => x.trim()).filter(Boolean);
    return xs.length && xs.every((x) => /^[A-Z][A-Za-z0-9 ()/-]{2,50}$/.test(x) && x.split(/\s+/).length <= 6) ? xs : null;
  };
  let byHead: string[] | null = null;
  for (const sec of headingsIn(message)) {
    if (!(/panel/i.test(sec.heading) && /cover|appl|includ|scope/i.test(sec.heading))) continue;
    const first = sec.body.split("\n").map((l) => l.trim()).find(Boolean); if (!first) continue;
    const xs = items(first.replace(/^[-*•]\s+/, "")); if (xs) { if (byHead && byHead.join("|") !== xs.join("|")) return null; byHead = xs; }
  }
  let byLine: string[] | null = null;
  for (const l of message.split("\n")) {
    if (!/\bother panels?\b/i.test(l) || !/NOT_COVERED/.test(l)) continue;
    const head = l.split(/(?<=\.)\s+/)[0]; if (/NOT_COVERED|other panel/i.test(head)) continue;
    const xs = items(head); if (xs) { if (byLine && byLine.join("|") !== xs.join("|")) return null; byLine = xs; }
  }
  if (byHead && byLine && byHead.map(norm).join("|") !== byLine.map(norm).join("|")) return null;
  return byHead ?? byLine;
}

/** Parse the covered-panel list + the per-panel limits tables out of the governing message text.
 *  A limits table is found by its column labels (test, review range, critical; unit and change rule
 *  optional), as markdown or as bullet rows; its panel is the heading / bold line / "Panel:" line right
 *  above it. */
export function parseLabRule(message: string): LabRule {
  const covered = new Set<string>((labCoveredPanels(message) ?? []).map(norm));
  const panels = new Map<string, PanelRule>();
  const lines = message.split("\n");
  for (const t of tablesIn(message)) {
    const iT = colIdx(t, /^test/i), iR = colIdx(t, /review/i), iC = colIdx(t, /critical/i), iX = colIdx(t, /change/i);
    if (iT < 0 || iR < 0 || iC < 0 || iX === -2) continue;
    let k = t.line - 1; while (k >= 0 && !lines[k].trim()) k--;
    const h = k >= 0 ? (lines[k].match(/^\s*\*\*([^*]+?)\*\*\s*:?\s*$/) ?? lines[k].match(/^\s*#{1,4}\s+(.+?)\s*$/) ?? lines[k].match(/^\s*([A-Z][A-Za-z0-9 ()/-]{2,50}):\s*$/)) : null;
    if (!h) continue;
    const panel = h[1].trim().replace(/^(?:the\s+)?(.+?)(?:\s+limits?|\s+table)?$/i, "$1");
    const tests: TestRule[] = [];
    for (const r of t.rows) {
      const name = (r[iT] ?? "").trim(); if (!name || /^-+$/.test(name)) continue;
      const rv = r[iR] || "", cr = r[iC] || "", ch = iX >= 0 ? r[iX] || "" : "";
      const tr: TestRule = { test: name };
      // review range(s)
      const f = rv.match(/Female:\s*([\d.]+\s*to\s*[\d.]+)/i), ma = rv.match(/\bMale:\s*([\d.]+\s*to\s*[\d.]+)/i);
      const u = rv.match(/under 65:\s*([\d.]+\s*to\s*[\d.]+)/i), o = rv.match(/65 or over:\s*([\d.]+\s*to\s*[\d.]+)/i);
      const dm = rv.match(/diabetes[^:]*:\s*([\d.]+\s*to\s*[\d.]+)/i);
      if (f || ma) { if (f) tr.reviewF = range(f[1]); if (ma) tr.reviewM = range(ma[1]); }
      else if (u || o) { if (u) tr.reviewUnder65 = range(u[1]); if (o) tr.reviewOver65 = range(o[1]); if (dm) tr.reviewT2DM = range(dm[1]); }
      else { tr.review = range(rv); if (dm) tr.reviewT2DM = range(dm[1]); }
      // critical
      const lo = cr.match(/below\s*(-?[\d.]+)/i), hi = cr.match(/above\s*(-?[\d.]+)/i);
      if (lo) tr.critLow = Number(lo[1]); if (hi) tr.critHigh = Number(hi[1]);
      // change rule
      const cp = ch.match(/more than\s*(\d+(?:\.\d+)?)\s*%/i); if (cp) tr.changePct = Number(cp[1]);
      tests.push(tr);
    }
    if (tests.length && !panels.has(norm(panel))) panels.set(norm(panel), { panel, tests });
    else if (panels.has(norm(panel))) panels.delete(norm(panel)); // two tables for one panel: unclear
  }
  return { covered, panels };
}

export interface LabReport { panel: string; values: Record<string, number>; }
/** `sex`: "Other" = the chart shows a sex that is neither Female nor Male (the message's either-range
 *  rule applies); "Unknown" = the chart's sex could not be read (skip if it matters).
 *  `hasT2DM`: "unknown" = the problem list could not be read completely (skip if it matters). */
export interface LabPatient { sex: "Female" | "Male" | "Other" | "Unknown"; ageAtCollection: number; hasT2DM: boolean | "unknown"; }

// ── exact decimal arithmetic. Printed results are short decimals; in binary floats 12.0 → 13.8 is
//    15.000000000000005 %, i.e. "more than 15 %" — which the message's own example says is NOT a review item.
const dec = (x: number): { n: bigint; d: number } => {
  let s = String(x);
  if (/e/i.test(s)) s = x.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
  const neg = s.startsWith("-"); const [i, f = ""] = s.replace("-", "").split(".");
  return { n: BigInt((neg ? "-" : "") + (i + f).replace(/^0+(?=\d)/, "")), d: f.length };
};
/** |v − prev| / |prev| × 100 > pct, computed exactly on the printed decimals. */
export function changeExceeds(v: number, prev: number, pct: number): boolean {
  if (prev === 0) return false;
  const a = dec(v), b = dec(prev), p = dec(pct);
  const d = Math.max(a.d, b.d);
  const A = a.n * 10n ** BigInt(d - a.d), B = b.n * 10n ** BigInt(d - b.d);
  const diff = A > B ? A - B : B - A, absB = B < 0n ? -B : B;
  return diff * 100n * 10n ** BigInt(p.d) > p.n * absB;            // diff/|B|·100 > p.n/10^p.d
}

/** Whole years on `onISO` for a birth date `dobISO`. A Feb 29 birthday turns older on Mar 1 in common
 *  years: "02-28" < "02-29" keeps the year from counting until March. */
export function ageOn(dobISO: string | undefined, onISO: string | undefined): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dobISO || "") || !/^\d{4}-\d{2}-\d{2}$/.test(onISO || "")) return undefined;
  let a = +onISO!.slice(0, 4) - +dobISO!.slice(0, 4);
  if (onISO!.slice(5) < dobISO!.slice(5)) a--;
  return a >= 0 && a < 130 ? a : undefined;
}
/** First collected date inside the change-rule window, `months` before `collectedISO` (the message:
 *  2026-05-10 → 2025-05-10; a Feb 29 collection → Feb 28 of a year without Feb 29). */
export function windowStart(collectedISO: string, months = 12): string {
  const [y, m, d] = collectedISO.split("-").map(Number);
  let yy = y, mm = m - months; while (mm < 1) { mm += 12; yy--; }
  const last = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  return `${yy}-${String(mm).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

export interface ReportHead { collected?: string; report?: string; record?: string }
export interface CandidateReport extends ReportHead { values: Record<string, number> }
const ident = (s?: string) => (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
/** The previous report for the change rule, chosen as the message says:
 *  - only reports printing the chart's record number (`anchorRecord`, else the asked report's own) —
 *    a report printing another record number is ignored;
 *  - a copy with the asked report's report number is the same report filed twice → not a previous;
 *  - the latest collected date before the asked report's; a tie → the higher report number;
 *  - used only when collected within `months` before (else "none"); the received date plays no part.
 *  Anything that can't be placed for certain (unread collected date / record number, a tie whose report
 *  numbers can't be ordered) → "unknown" (the engine then skips if the change rule matters). */
export function pickPrevious(asked: ReportHead, cands: CandidateReport[], anchorRecord?: string, months = 12): Record<string, number> | "none" | "unknown" {
  if (!cands.length) return "none";
  if (!asked.collected) return "unknown";
  const anchor = ident(anchorRecord || asked.record);
  if (!anchor) return "unknown";
  const mine: CandidateReport[] = [];
  for (const c of cands) {
    if (!c.collected || !ident(c.record)) return "unknown";       // can't tell whether / where it counts
    if (ident(c.record) !== anchor) continue;                        // another chart's report (misfiled)
    if (asked.report && ident(c.report) && ident(c.report) === ident(asked.report)) continue; // filed twice
    if (c.collected >= asked.collected) continue;                     // not before this report
    mine.push(c);
  }
  if (!mine.length) return "none";
  const latest = mine.reduce((a, c) => (c.collected! > a ? c.collected! : a), "");
  const tied = mine.filter((c) => c.collected === latest);
  let prev = tied[0];
  if (tied.length > 1) {
    const nums = tied.map((c) => (c.report ?? "").replace(/\D/g, ""));
    if (nums.some((n) => !n)) return "unknown";
    const big = nums.map((n) => BigInt(n)); let bi = 0;
    big.forEach((n, i) => { if (n > big[bi]) bi = i; });
    if (new Set(nums).size > 1 && big.filter((n) => n === big[bi]).length > 1) return "unknown";
    prev = tied[bi];
  }
  if (prev.collected! < windowStart(asked.collected, months)) return "none";
  return prev.values;
}

/** Type 2 diabetes mellitus on the problem list, from the condition NAMES (label-read, never the
 *  obfuscated code digits). A family history / screening / prediabetes / type 1 entry does not count. */
export function problemListHasT2DM(conditions: string[]): boolean {
  return conditions.some((c) => {
    const n = c.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
    if (/family history|history of|screening|risk of|pre-?diabet|ruled out|rule out|gestational|type (1|i) /.test(n)) return false;
    return /\btype (2|ii) diabetes( mellitus)?\b|\bdiabetes mellitus,? type (2|ii)\b|\bt2dm\b/.test(n);
  });
}
/** Apply the rule. `prev` supplies the previous same-panel report's values for the change rule (or
 *  null if there is none / older than 12 months / couldn't be resolved for the relevant tests). */
/** `prev`: the previous same-panel report's values (change rule applies); "none" = PROVEN there is no
 *  qualifying previous (within 12 months) so the change rule cannot fire; "unknown" = couldn't resolve
 *  it → skip if a change-rule test is otherwise in range. */
export function triageLab(rule: LabRule, report: LabReport, pt: LabPatient, prev: Record<string, number> | "none" | "unknown"): string | null {
  const pr = rule.panels.get(norm(report.panel));
  if (!rule.covered.has(norm(report.panel))) return "NOT_COVERED"; // not a covered panel (coverage from the message)
  if (!pr) return null;                                            // covered but no table parsed → can't apply → skip

  // Review range(s) for each possible reading of the patient: sex unread → Female and Male; problem
  // list unread → with and without Type 2 diabetes. A count that differs between readings → skip.
  const sexes: Array<LabPatient["sex"]> = pt.sex === "Unknown" ? ["Female", "Male"] : [pt.sex];
  const dms: boolean[] = pt.hasT2DM === "unknown" ? [false, true] : [pt.hasT2DM];
  const reviewRange = (t: TestRule, sex: LabPatient["sex"], dm: boolean): Array<[number, number]> => {
    if (t.reviewF || t.reviewM) {
      if (sex === "Female" && t.reviewF) return [t.reviewF];
      if (sex === "Male" && t.reviewM) return [t.reviewM];
      return [t.reviewF, t.reviewM].filter(Boolean) as Array<[number, number]>; // neither → in range if inside EITHER
    }
    if (t.reviewUnder65 || t.reviewOver65) return [pt.ageAtCollection >= 65 ? t.reviewOver65! : t.reviewUnder65!].filter(Boolean) as Array<[number, number]>;
    if (t.reviewT2DM && dm) return [t.reviewT2DM];
    return t.review ? [t.review] : [];
  };

  const criticals: string[] = []; let reviewItems = 0; let prevUnresolved = false; let patientUnsure = false;
  for (const t of pr.tests) {
    const v = report.values[t.test] ?? report.values[Object.keys(report.values).find((k) => norm(k) === norm(t.test)) || ""];
    if (v === undefined) return null;                              // a value we couldn't read → skip (never-wrong)
    // critical: strictly beyond a limit ("exactly at a limit is not critical")
    if ((t.critLow !== undefined && v < t.critLow) || (t.critHigh !== undefined && v > t.critHigh)) { criticals.push(t.test); continue; }
    // review item: out of range ("exactly on an end is in range") OR fails the change rule
    const outs = new Set<boolean>();
    for (const sx of sexes) for (const dm of dms) { const r = reviewRange(t, sx, dm); outs.add(r.length > 0 && !r.some(([lo, hi]) => v >= lo && v <= hi)); }
    const out = outs.size === 1 && outs.has(true);
    let changed = false;
    if (t.changePct !== undefined && !out) {
      // the change rule decides the item only when the value isn't (surely) out of range; it needs the previous.
      if (prev === "none") { /* proven no qualifying previous → change rule cannot fire */ }
      else if (prev === "unknown") prevUnresolved = true;          // couldn't resolve the previous → count unknowable
      else {
        const pv = prev[t.test] ?? prev[Object.keys(prev).find((k) => norm(k) === norm(t.test)) || ""];
        if (pv === undefined) prevUnresolved = true;               // a previous exists but this test wasn't read
        else changed = changeExceeds(v, pv, t.changePct);          // exact: "exactly the percentage is not"
      }
    }
    if (outs.size > 1 && !changed) patientUnsure = true;            // out of range under one reading only
    if (out || changed) reviewItems++;
  }
  if (criticals.length) return `CALL_PROVIDER_NOW:${criticals.sort((a, b) => a.localeCompare(b)).join(",")}`;
  if (prevUnresolved) return null;                                 // couldn't resolve a needed previous value → skip
  if (patientUnsure) return null;                                  // sex / diabetes unread and it changes the count → skip
  return reviewItems > 0 ? `NURSE_REVIEW:${reviewItems}` : "RELEASE";
}

// ── self-check (against the real governing message + its worked example) ──
if (process.argv[1]?.endsWith("labTriage.ts")) {
  const assert = (c: unknown, m: string) => { if (!c) { console.error("✗ " + m); process.exit(1); } console.log("✓ " + m); };
  const MSG = `## Panels this rule covers

Complete blood count, Basic metabolic panel, Thyroid panel. For a report of any other panel, answer \`NOT_COVERED\`.

**Complete blood count**

| Test | Unit | Review range | Critical when | Change rule |
|---|---|---|---|---|
| White blood cell count | 10^3/uL | 4.0 to 11.0 | below 2.0 or above 30.0 | none |
| Hemoglobin | g/dL | Female: 12.0 to 15.5. Male: 13.5 to 17.5 | below 7.0 or above 20.0 | more than 15% |
| Hematocrit | % | Female: 36.0 to 46.0. Male: 41.0 to 53.0 | below 21.0 or above 60.0 | none |
| Platelet count | 10^3/uL | 150 to 400 | below 50 or above 1000 | more than 30% |

**Basic metabolic panel**

| Test | Unit | Review range | Critical when | Change rule |
|---|---|---|---|---|
| Sodium | mmol/L | 135 to 145 | below 120 or above 160 | none |
| Potassium | mmol/L | 3.5 to 5.1 | below 2.8 or above 6.2 | none |
| Chloride | mmol/L | 98 to 107 | none | none |
| Carbon dioxide | mmol/L | 22 to 29 | below 10 or above 40 | none |
| Blood urea nitrogen | mg/dL | Age under 65: 7 to 20. Age 65 or over: 8 to 26 | above 100 | none |
| Creatinine | mg/dL | Female: 0.50 to 1.10. Male: 0.70 to 1.30 | above 5.00 | more than 25% |
| Glucose | mg/dL | 70 to 99. With Type 2 diabetes mellitus on the problem list: 70 to 180 | below 50 or above 400 | none |
| Calcium | mg/dL | 8.6 to 10.2 | below 6.5 or above 13.0 | none |

**Thyroid panel**

| Test | Unit | Review range | Critical when | Change rule |
|---|---|---|---|---|
| Thyroid stimulating hormone | mIU/L | Age under 65: 0.40 to 4.50. Age 65 or over: 0.40 to 6.00 | none | none |
| Free T4 | ng/dL | 0.80 to 1.80 | none | none |`;
  const rule = parseLabRule(MSG);
  assert(rule.covered.size === 3, "3 covered panels parsed");
  assert(rule.panels.size === 3, "3 panel tables parsed");
  const bmp = rule.panels.get("basic metabolic panel")!;
  assert(bmp.tests.length === 8, "BMP has 8 tests");
  const creat = bmp.tests.find((t) => /creatinine/i.test(t.test))!;
  assert(creat.reviewF?.[1] === 1.10 && creat.reviewM?.[0] === 0.70 && creat.critHigh === 5.0 && creat.changePct === 25, "creatinine rule parsed (F/M, crit>5, change 25%)");

  const pt = { sex: "Male" as const, ageAtCollection: 14, hasT2DM: false };
  // The message's worked example: BMP for Nancy Oliver (female), 14 y/o, no T2DM, no prior. Creatinine
  // 1.17 is out of the female range 0.50–1.10 → the one review item → NURSE_REVIEW:1.
  const nancy = { panel: "Basic metabolic panel", values: { Sodium: 145, Potassium: 5.0, Chloride: 98, "Carbon dioxide": 23, "Blood urea nitrogen": 17, Creatinine: 1.17, Glucose: 85, Calcium: 9.7 } };
  assert(triageLab(rule, nancy, { sex: "Female", ageAtCollection: 14, hasT2DM: false }, "none") === "NURSE_REVIEW:1", "worked example (Nancy Oliver) → NURSE_REVIEW:1 (creatinine 1.17 > female 1.10)");
  // all in range, proven no previous → RELEASE
  const allIn = { panel: "Basic metabolic panel", values: { Sodium: 140, Potassium: 4.0, Chloride: 100, "Carbon dioxide": 25, "Blood urea nitrogen": 15, Creatinine: 1.0, Glucose: 85, Calcium: 9.5 } };
  assert(triageLab(rule, allIn, pt, "none") === "RELEASE", "all in range + no previous → RELEASE");
  // same, but previous unresolved and creatinine (change-rule) is in range → SKIP (null)
  assert(triageLab(rule, allIn, pt, "unknown") === null, "in-range change-rule test + unknown previous → skip");
  // a critical value → CALL_PROVIDER_NOW (prev irrelevant)
  assert(triageLab(rule, { panel: "Basic metabolic panel", values: { Sodium: 118, Potassium: 6.5, Chloride: 100, "Carbon dioxide": 25, "Blood urea nitrogen": 15, Creatinine: 1.0, Glucose: 85, Calcium: 9.5 } }, pt, "unknown") === "CALL_PROVIDER_NOW:Potassium,Sodium", "criticals → CALL_PROVIDER_NOW alphabetical (prev irrelevant)");
  // out of range on two non-change tests → NURSE_REVIEW:2 (no prev needed)
  assert(triageLab(rule, { panel: "Basic metabolic panel", values: { Sodium: 150, Potassium: 4.0, Chloride: 100, "Carbon dioxide": 31, "Blood urea nitrogen": 15, Creatinine: 1.0, Glucose: 85, Calcium: 9.5 } }, pt, "none") === "NURSE_REVIEW:2", "two out of range → NURSE_REVIEW:2");
  // change rule: creatinine in range but +43% vs prev → review item
  assert(triageLab(rule, allIn, pt, { Creatinine: 0.7 }) === "NURSE_REVIEW:1", "creatinine +43% vs prev → change-rule review item");
  // non-covered panel
  assert(triageLab(rule, { panel: "Lipid panel", values: {} }, pt, "none") === "NOT_COVERED", "lipid panel → NOT_COVERED");
  // a missing value → skip
  assert(triageLab(rule, { panel: "Basic metabolic panel", values: { Sodium: 140 } }, pt, "none") === null, "missing value → skip");
  console.log("ALL PASS");
}
