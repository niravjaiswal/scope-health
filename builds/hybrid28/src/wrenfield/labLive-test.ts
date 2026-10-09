/**
 * labLive orchestration checks (offline: fake chart, fake readers, the real engine):
 *   A. the previous report is not read when it cannot change the answer (critical, Thyroid, every
 *      change-rule test out of range), candidates received before the window are not read, a needed
 *      candidate is asked only for the change-rule tests + collected/report/record;
 *   B. misfiled asked report (every other report agrees on another record number) → skip;
 *   C. property: on 3000 random charts the lazy reader's final answer equals the answer from reading
 *      EVERY report in full (the 158-run order of work), whenever the reference answers.
 *   npx tsx src/wrenfield/labLive-test.ts
 */
import { readFileSync } from "node:fs";
import { labLive, type LabDoc } from "./labLive.js";
import { parseLabRule, triageLab, pickPrevious, ageOn, windowStart } from "./labTriage.js";
import type { LabRead, LabNeed } from "./labRead.js";

let pass = 0, fail = 0;
const eq = (got: unknown, want: unknown, label: string) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++; else { fail++; console.error(`✗ ${label}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`); }
};
const items = readFileSync(new URL("../../fixtures/set1-items.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const rule = parseLabRule(items.find((i: any) => i.kind === "message" && /NOT_COVERED/.test(i.text)).text);

interface FakeReport { href: string; received: string; collected: string; report: string; record: string; values: Record<string, number> }
function world(panel: string, reports: FakeReport[], opts: { sex?: string; dob?: string; t2dm?: boolean; mrn?: string; speculate?: boolean; delayMs?: number } = {}) {
  const calls: Array<{ href: string; need: LabNeed }> = []; const tessCalls: string[] = [];
  const byHref = new Map(reports.map((r) => [r.href, r]));
  const docs: LabDoc[] = reports.map((r) => ({ title: `Lab report: ${panel}`, kind: "Lab report", receivedISO: r.received, docHref: r.href }));
  const fn = labLive({
    patient: async () => ({ pat: { id: "/patients/p1", dobISO: opts.dob ?? "1980-01-01", demographics: { sex: opts.sex ?? "Female" }, documents: docs, mrn: opts.mrn } }),
    image: async (href) => href,                                             // the "png" is the href
    t2dm: async () => opts.t2dm ?? false,
    speculate: opts.speculate,
    tesseractLab: async (png) => { tessCalls.push(png); const r = byHref.get(png)!; return { values: {}, record: r.record.replace(/[^A-Z0-9]/gi, "").toUpperCase(), ms: 1 }; },
    readLab: async (png, need) => {
      calls.push({ href: png, need }); const r = byHref.get(png)!;
      if (opts.delayMs) await new Promise((res) => setTimeout(res, opts.delayMs));
      const read: LabRead = { values: {} };
      for (const t of need.tests) if (r.values[t] !== undefined) read.values[t] = r.values[t];
      if (need.meta.includes("collected")) read.collected = r.collected;
      if (need.meta.includes("report")) read.report = r.report.replace(/[^A-Z0-9]/gi, "").toUpperCase();
      if (need.meta.includes("record")) read.record = r.record.replace(/[^A-Z0-9]/gi, "").toUpperCase();
      return { read, trace: { tessMs: 1, modelMs: 1, tiebreakMs: 0, tiebreak: false, disagreed: [], unknown: [], ms: 1 } };
    },
  });
  return { calls, tessCalls, run: async (received: string) => { const ctx = await fn("P", undefined, panel, received, rule); return ctx ? triageLab(rule, ctx.report, ctx.patient, ctx.prev) : null; } };
}

const CBC = (v: Partial<Record<string, number>> = {}) => ({ "White blood cell count": 7.0, Hemoglobin: 13.0, Hematocrit: 40.0, "Platelet count": 250, ...v } as Record<string, number>);
const BMP = (v: Partial<Record<string, number>> = {}) => ({ Sodium: 140, Potassium: 4.0, Chloride: 100, "Carbon dioxide": 25, "Blood urea nitrogen": 15, Creatinine: 0.9, Glucose: 85, Calcium: 9.5, ...v } as Record<string, number>);
const rep = (href: string, received: string, collected: string, values: Record<string, number>, report = "LR-" + href, record = "HG100") => ({ href, received, collected, report, record, values });

// ── misfiled against the chart's own record number (practice 2026-10-08: Morgan, Ava HG6213971's only CBC prints
//    Fatima Brown's HG1593164; there was no other CBC, so the other-reports check could not see it → answered −1) ──
{
  const w = world("Complete blood count", [rep("a", "2026-09-11", "2026-09-02", CBC({ Hemoglobin: 18.0, "Platelet count": 118 }), "LR-037729", "HG1593164")], { mrn: "HG6213971" });
  eq(await w.run("2026-09-11"), null, "only report prints another chart's record number → skip");
}
{
  const w = world("Complete blood count", [rep("a", "2026-09-11", "2026-09-02", CBC({ Hemoglobin: 6.5 }), "LR-1", "HG1593164")], { mrn: "HG6213971" });
  eq(await w.run("2026-09-11"), null, "a misfiled report is ignored even when it is critical");
}
{
  const w = world("Complete blood count", [rep("a", "2026-09-11", "2026-09-02", CBC({ Hemoglobin: 11.0 }), "LR-1", "HG6213971")], { mrn: "hg6213971" });
  eq(await w.run("2026-09-11"), "NURSE_REVIEW:1", "report prints the chart's record number → answered");
}
{
  // previous candidate printing another record number is ignored when the chart's number is known
  const w = world("Complete blood count", [rep("a", "2026-05-12", "2026-05-10", CBC({ Hemoglobin: 13.0 }), "LR-9", "HG100"), rep("b", "2026-03-10", "2026-03-08", CBC({ Hemoglobin: 10.0 }), "LR-8", "HG777")], { mrn: "HG100" });
  eq(await w.run("2026-05-12"), "RELEASE", "previous report of another chart ignored (no change-rule hit)");
}

// ── A ──
{
  const w = world("Complete blood count", [rep("a", "2026-05-12", "2026-05-10", CBC({ Hemoglobin: 6.5 })), rep("b", "2026-01-10", "2026-01-08", CBC({ Hemoglobin: 10 }))]);
  eq(await w.run("2026-05-12"), "CALL_PROVIDER_NOW:Hemoglobin", "critical → answer"); eq(w.calls.map((c) => c.href), ["a"], "critical → previous not read");
}
{
  const w = world("Thyroid panel", [rep("a", "2026-05-12", "2026-05-10", { "Thyroid stimulating hormone": 2.0, "Free T4": 1.2 }), rep("b", "2026-01-10", "2026-01-08", { "Thyroid stimulating hormone": 9.0, "Free T4": 1.2 })]);
  eq(await w.run("2026-05-12"), "RELEASE", "thyroid → answer"); eq(w.calls.map((c) => c.href), ["a"], "thyroid (no change rule) → previous not read");
}
{
  const w = world("Complete blood count", [rep("a", "2026-05-12", "2026-05-10", CBC({ Hemoglobin: 11.0, "Platelet count": 140 })), rep("b", "2026-01-10", "2026-01-08", CBC())]);
  eq(await w.run("2026-05-12"), "NURSE_REVIEW:2", "change-rule tests out of range → answer"); eq(w.calls.map((c) => c.href), ["a"], "every change-rule test out of range → previous not read");
}
{
  const w = world("Complete blood count", [rep("a", "2026-05-12", "2026-05-10", CBC({ Hemoglobin: 13.9 })), rep("b", "2026-01-10", "2026-01-08", CBC({ Hemoglobin: 12.0 })), rep("c", "2025-05-01", "2025-04-28", CBC({ Hemoglobin: 9.0 }))]);
  eq(await w.run("2026-05-12"), "NURSE_REVIEW:1", "Hgb 12.0 → 13.9 change-rule item");
  eq(w.calls.map((c) => c.href), ["a", "b"], "received before the window (2025-05-01 < 2025-05-10) → not read");
  eq(w.calls[1]?.need, { tests: ["Hemoglobin", "Platelet count"], meta: ["collected", "report", "record"] }, "candidate asked only for change-rule tests + meta");
}
{
  const w = world("Basic metabolic panel", [rep("a", "2026-05-12", "2026-05-10", BMP()), rep("b", "2025-04-01", "2025-03-30", BMP({ Creatinine: 0.5 }))]);
  eq(await w.run("2026-05-12"), "RELEASE", "only candidate out of window → none → RELEASE"); eq(w.calls.length, 1, "out-of-window candidate not read");
}
{
  const w = world("Basic metabolic panel", [rep("a", "2026-05-12", "2026-05-10", BMP())]);
  eq(await w.run("2026-05-12"), "RELEASE", "no other report → RELEASE");
}
// ── B ──
{
  const w = world("Complete blood count", [rep("a", "2026-05-12", "2026-05-10", CBC({ Hemoglobin: 6.0 }), "LR-1", "HG999"), rep("b", "2026-01-10", "2026-01-08", CBC()), rep("c", "2025-10-10", "2025-10-08", CBC())]);
  eq(await w.run("2026-05-12"), null, "misfiled asked report (others agree on another record) → skip, even with a critical");
}
{
  const w = world("Complete blood count", [rep("a", "2026-05-12", "2026-05-10", CBC({ Hemoglobin: 6.0 })), rep("b", "2026-01-10", "2026-01-08", CBC()), rep("c", "2025-10-10", "2025-10-08", CBC())]);
  eq(await w.run("2026-05-12"), "CALL_PROVIDER_NOW:Hemoglobin", "records agree → no misfiled decline"); eq(w.calls.map((c) => c.href), ["a"], "records checked by tesseract only (equal to the asked one)");
}

// ── C. property: lazy == read-everything ──
let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
const addDays = (iso: string, d: number) => new Date(Date.parse(iso + "T00:00:00Z") + d * 864e5).toISOString().slice(0, 10);
const ID = (s: string) => s.replace(/[^A-Z0-9]/gi, "").toUpperCase();
let compared = 0, same = 0, lazyOnly = 0, refOnly = 0, readsLazy = 0, readsRef = 0, readsSpec = 0, specCharts = 0;
for (let k = 0; k < 3000; k++) {
  const panel = pick(["Complete blood count", "Basic metabolic panel", "Thyroid panel"]);
  const base = panel === "Complete blood count" ? CBC() : panel === "Basic metabolic panel" ? BMP() : ({ "Thyroid stimulating hormone": 2.0, "Free T4": 1.2 } as Record<string, number>);
  const jitter = (v: Record<string, number>) => Object.fromEntries(Object.entries(v).map(([t, x]) => [t, Math.round(x * (0.4 + rnd() * 1.4) * 100) / 100]));
  const n = 1 + Math.floor(rnd() * 5); const reps: FakeReport[] = [];
  for (let i = 0; i < n; i++) {
    const col = addDays("2024-06-01", Math.floor(rnd() * 800)); const rec = addDays(col, Math.floor(rnd() * 20)); // collected ≤ received
    reps.push(rep("r" + i, rec, col, rnd() < 0.6 ? jitter(base) : { ...base }, "LR-" + (100 + Math.floor(rnd() * 4)), rnd() < 0.12 ? "HG777" : "HG100"));
  }
  const a = reps[0]; const others = reps.slice(1);
  if (reps.filter((r) => r.received === a.received).length !== 1) continue;
  const sex = pick(["Female", "Male", "X"]); const dob = pick(["1950-03-01", "1990-07-07", "2012-02-29"]); const t2dm = rnd() < 0.3;
  const w = world(panel, reps, { sex, dob, t2dm });
  const got = await w.run(a.received);
  // speculation (deps.speculate): the same answer, every lazy read is still made, and anything extra lies inside the window
  const ws = world(panel, reps, { sex, dob, t2dm, speculate: true });
  const gotS = await ws.run(a.received);
  specCharts++; readsSpec += ws.calls.length;
  if (gotS !== got) eq(gotS, got, `speculative answer == lazy answer, chart #${k}`);
  const lazyHrefs = new Set(w.calls.map((c) => c.href));
  for (const h of lazyHrefs) if (!ws.calls.some((c) => c.href === h)) eq(h, "(also read speculatively)", `speculation drops no lazy read, chart #${k}`);
  const sure = windowStart(a.received);
  for (const c of ws.calls) { const r = reps.find((x) => x.href === c.href)!; if (!lazyHrefs.has(c.href) && r.received < sure) eq(c.href, "in window", `speculative read outside the window, chart #${k}`); }
  // reference: every report read in full (the 158 order of work), same engine, same misfiled rule
  const pt = { sex: (sex === "Female" ? "Female" : sex === "Male" ? "Male" : "Other") as "Female" | "Male" | "Other", ageAtCollection: ageOn(dob, a.collected)!, hasT2DM: t2dm };
  const cand = others.map((o) => ({ collected: o.collected, report: ID(o.report), record: ID(o.record), values: o.values }));
  const recs = new Set(cand.map((c) => c.record));
  const ref = cand.length >= 2 && recs.size === 1 && !recs.has(ID(a.record)) ? null
    : triageLab(rule, { panel, values: a.values }, pt, pickPrevious({ collected: a.collected, report: ID(a.report), record: ID(a.record) }, cand));
  readsLazy += w.calls.length; readsRef += reps.length;
  if (ref !== null && got !== null) { compared++; if (ref === got) same++; else eq(got, ref, `random chart #${k} (${panel}, ${n} reports)`); }
  else if (got !== null) lazyOnly++; else if (ref !== null) refOnly++;
}
eq(same, compared, "lazy answer == read-everything answer on every chart both answer");
eq(refOnly, 0, "lazy reader never skips a chart the full read answers");
console.log(`  property: ${compared} charts compared, ${same} identical; lazy-only answers ${lazyOnly} (full read skipped), ref-only ${refOnly}; model reads ${readsLazy} vs ${readsRef} (−${Math.round(100 - (100 * readsLazy) / readsRef)}%)`);
console.log(`  speculation: ${specCharts} charts, same answers; model reads ${readsSpec} vs ${readsLazy} lazy (+${Math.round((100 * (readsSpec - readsLazy)) / readsLazy)}%)`);

// ── D. speculation overlaps the needed previous report with the asked read (each fake model read takes 60 ms) ──
{
  const reps = [rep("a", "2026-05-12", "2026-05-10", CBC({ Hemoglobin: 13.9 })), rep("b", "2026-01-10", "2026-01-08", CBC({ Hemoglobin: 12.0 })), rep("c", "2026-03-10", "2026-03-08", CBC({ Hemoglobin: 12.5 }))];
  const time = async (speculate: boolean) => { const w = world("Complete blood count", reps, { speculate, delayMs: 60 }); const t = Date.now(); const ans = await w.run("2026-05-12"); return { ans, ms: Date.now() - t, n: w.calls.length }; };
  const lazy = await time(false), spec = await time(true);
  eq(spec.ans, lazy.ans, "overlap: same answer"); eq(spec.n, lazy.n, "overlap: same reads when every candidate is needed");
  eq(spec.ms < lazy.ms - 50, true, `overlap: wall ${spec.ms} ms vs ${lazy.ms} ms lazy (asked + 2 candidates: 1 round trip instead of 3)`);
}
console.log(`${fail ? "✗" : "✓"} labLive-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
