/**
 * HIDDEN-SET PREDICTOR. Estimates Set 2 / Set 3 correct / wrong / skip / not-reached for the current
 * code from
 *   (a) the 158 run's Set 1 outcome per family (answered share, 113/114 accuracy, per-family ms);
 *   (b) task-variant robustness per family (taskVariants.ts): P(same answer path | reworded task)
 *       and P(other answer path | reworded task);
 *   (c) page-variant robustness per reader (pageVariants.ts): P(same value | other layout) and
 *       P(different value | other layout);
 *   (d) a task-mix model: Set 1's family mix scaled to the set size (Set 2: 226, Set 3: 458), with
 *       the queue's time budget calibrated so the 158 code reaches 254 of Set 3's tasks.
 * Two unknowns describe how far a hidden set is from Set 1: s = share of tasks still phrased like
 * Set 1, l = share of reads on a layout unlike Set 1's. They are fitted to the 158 run's actual Set 2
 * score and checked against its Set 3 score; the residual is the miscalibration.
 *
 *   npx tsx src/wrenfield/variants/predict.ts
 */
import { loadLog } from "./harness.js";
import type { RobustnessReport } from "./taskVariants.js";
import type { PageReport } from "./pageVariants.js";

export const ACTUAL_158 = { set1: { correct: 113, wrong: 1, skip: 110, notReached: 0, tasks: 224 }, set2: { correct: 24, wrong: 3, skip: 199, notReached: 0, tasks: 226 }, set3: { correct: 25, wrong: 0, skip: 229, notReached: 204, tasks: 458 } };
/** How often a would-be −1 path really ends in a wrong answer live: a DIFFERENT path usually resolves
 *  a person who may not exist (then skips); the generalist must ground its answer in page text. */
const W_DIFF = 0.5, W_GEN = 0.25;

type Fam = { family: string; n: number; answered: number; ms: number; reread: number; pSame: number; pBad: number; qSame: number; qBad: number; reader: boolean };
export type Prediction = { correct: number; wrong: number; skip: number; notReached: number; reached: number; byFamily: Record<string, { correct: number; wrong: number }> };

/** Page readers each family depends on (pageVariants reader names, prefix match). */
const PAGE_READER: Record<string, string[]> = {
  "invoice-balance": ["invoice-balance"], "provider-day-scheduled-count": ["provider-day-scheduled-count"], "provider-day-completed-count": ["provider-day-completed-count"],
  "provider-open-slots": ["provider-open-slots"], "referral-source": ["referral-source", "patient-search"], "referral-reason": ["doc-href", "patient-search"],
  "patient-phone": ["patient-search"], "lab-report-triage": ["doc-href", "patient-search"],
};

export function familyModel(rob: RobustnessReport, pages: PageReport): Fam[] {
  const log = loadLog().filter((r) => r.kind === "task");
  const fams = new Map<string, Fam>();
  for (const r of log) {
    const f = r.family ?? "(none)";
    const x = fams.get(f) ?? { family: f, n: 0, answered: 0, ms: 0, reread: 0, pSame: 1, pBad: 0, qSame: 1, qBad: 0, reader: false };
    fams.set(f, x); x.n++; x.ms += r.ms; if (r.result && "answer" in r.result) x.answered++;
  }
  for (const x of fams.values()) {
    x.ms /= x.n;
    const rr = rob.rows.find((r) => r.family === x.family);
    if (rr && rr.variants) { x.pSame = rr.same / rr.variants; x.pBad = (W_DIFF * rr.different + W_GEN * rr.generalist) / rr.variants; }
    const readers = PAGE_READER[x.family];
    if (readers) {
      const fs = pages.findings.filter((f) => readers.some((p) => f.reader.startsWith(p)));
      if (fs.length) { x.reader = true; x.qSame = fs.filter((f) => f.verdict === "SAME" || f.verdict === "EXPECTED").length / fs.length; x.qBad = fs.filter((f) => f.verdict === "DIFFERENT").length / fs.length; }
    }
  }
  return [...fams.values()];
}

/** Distance of a hidden set from Set 1: s = share of tasks still phrased like Set 1; l = share of page
 *  reads on a layout unlike Set 1's; m = share of tasks of a kind the code cannot answer at all
 *  (a family Set 1 lacks, a site the readers cannot navigate, patients that do not resolve). */
export type Shift = { s: number; l: number; m: number };

/** Expected outcome of `tasks` tasks with Set 1's family mix under `shift`, within `budgetS` seconds. */
export function predict(fams: Fam[], tasks: number, sh: Shift, budgetS = Infinity, speedup: Record<string, number> = {}): Prediction {
  const total = fams.reduce((a, f) => a + f.n, 0);
  const acc = ACTUAL_158.set1.correct / (ACTUAL_158.set1.correct + ACTUAL_158.set1.wrong);
  const msPerMsg = 1234, msgShare = 16 / 224;                       // Set 1: 16 messages, 1.2 s each (model compile)
  const tPerTask = fams.reduce((a, f) => a + (f.n / total) * f.ms * (speedup[f.family] ?? 1), 0) + msgShare * msPerMsg;
  const reached = Math.min(tasks, budgetS === Infinity ? tasks : Math.floor((budgetS * 1000) / tPerTask));
  const out: Prediction = { correct: 0, wrong: 0, skip: 0, notReached: tasks - reached, reached, byFamily: {} };
  for (const f of fams) {
    const n = (f.n / total) * reached * (1 - sh.m), a1 = f.answered / f.n;
    const route = sh.s + (1 - sh.s) * f.pSame;                       // answer path kept under rewording
    const page = (1 - sh.l) + sh.l * f.qSame;                        // value kept (or declined) under another layout
    const ans = n * a1 * route * page;
    const wrongRoute = n * (1 - sh.s) * f.pBad;                      // reworded task answered by another path
    const wrongPage = n * a1 * route * sh.l * f.qBad;                // layout read as a different value
    const c = ans * acc, w = ans * (1 - acc) + wrongRoute + wrongPage;
    out.correct += c; out.wrong += w; out.byFamily[f.family] = { correct: c, wrong: w };
  }
  out.skip = reached - out.correct - out.wrong;
  return out;
}

/** Fit the free parameters of `shift` (those not locked) to an actual score of the 158 run. */
export function fit(fams: Fam[], lock: Partial<Shift>, target = ACTUAL_158.set2): Shift & { err: number } {
  let best = { s: 1, l: 0, m: 0, err: Infinity };
  const grid = (k: keyof Shift) => (lock[k] !== undefined ? [lock[k]!] : Array.from({ length: 51 }, (_, i) => i / 50));
  for (const s of grid("s")) for (const l of grid("l")) for (const m of grid("m")) {
    const p = predict(fams, target.tasks, { s, l, m });
    const err = (p.correct - target.correct) ** 2 + 4 * (p.wrong - target.wrong) ** 2;
    if (err < best.err - 1e-9) best = { s, l, m, err };
  }
  // Two scores cannot pin three parameters: many shifts fit about equally. Among those within 0.5 of
  // the best error, take the one that needs the fewest unanswerable kinds (explain the score with the
  // measured robustness first), then the most Set-1-like phrasing — a stable, reproducible pick.
  let pick = best;
  for (const s of grid("s")) for (const l of grid("l")) for (const m of grid("m")) {
    const p = predict(fams, target.tasks, { s, l, m });
    const err = (p.correct - target.correct) ** 2 + 4 * (p.wrong - target.wrong) ** 2;
    if (err <= best.err + 0.5 && (m < pick.m - 1e-9 || (Math.abs(m - pick.m) < 1e-9 && s > pick.s + 1e-9))) pick = { s, l, m, err };
  }
  return pick;
}

const f1 = (x: number) => x.toFixed(1).padStart(6);
const SCENARIOS: Array<[string, Partial<Shift>]> = [
  ["phrasing only", { l: 0, m: 0 }], ["layout only", { s: 1, m: 0 }], ["phrasing + layout", { m: 0 }],
  ["phrasing + unanswerable kinds", { l: 0 }], ["all three", {}],
];
/** `fitted`: the shifts fitted on the 158 code, by scenario name (fixtures/set1/variants-shift-158.json).
 *  Given, every scenario predicts the CURRENT code under the 158 fit; absent, each is fitted here
 *  (meaningful only when the current code is the 158 code, which produced the actual Set 2 score). */
export function runPredictor(rob: RobustnessReport, pages: PageReport, fitted?: Record<string, Shift>) {
  const fams = familyModel(rob, pages);
  const total = fams.reduce((a, f) => a + f.n, 0);
  const tSet1 = fams.reduce((a, f) => a + (f.n / total) * f.ms, 0) + (16 / 224) * 1234;
  const budget3 = (ACTUAL_158.set3.tasks - ACTUAL_158.set3.notReached) * tSet1 / 1000;   // seconds that reach 254 tasks at Set 1 speed
  const scen = SCENARIOS.map(([name, lock]) => [name, fitted?.[name] ? { ...fitted[name], err: 0 } : fit(fams, lock)] as const);
  return { fams, scen, budget3, tSet1, fixed: !!fitted };
}

export function printPredictor(r: ReturnType<typeof runPredictor>) {
  const { fams, budget3 } = r;
  console.log(`\n== Hidden-set predictor (Set 1 family mix; s = share phrased like Set 1, l = share of reads on another layout, m = share of unanswerable kinds) ==`);
  console.log(`  per-task time at Set 1 speed ${(r.tSet1 / 1000).toFixed(2)} s; Set 3 budget that reaches 254 tasks at that speed: ${budget3.toFixed(0)} s`);
  console.log(`  ${(r.fixed ? "scenario (shift fitted on the 158 code)" : "scenario (shift fitted here to Set 2 actual)").padEnd(52)} correct  wrong   skip   n.r. | 158 actual c/w/s/nr`);
  const show = (name: string, p: Prediction, a: { correct: number; wrong: number; skip: number; notReached: number }) => console.log(`  ${name.padEnd(52)} ${f1(p.correct)} ${f1(p.wrong)} ${f1(p.skip)} ${f1(p.notReached)} | ${a.correct}/${a.wrong}/${a.skip}/${a.notReached}`);
  show("Set 1 (s=1, l=0, m=0)", predict(fams, 224, { s: 1, l: 0, m: 0 }), ACTUAL_158.set1);
  for (const [name, p] of r.scen) {
    show(`Set 2 ${name} (s=${p.s.toFixed(2)} l=${p.l.toFixed(2)} m=${p.m.toFixed(2)})`, predict(fams, 226, p), ACTUAL_158.set2);
    show(`Set 3   same shift`, predict(fams, 458, p, budget3), ACTUAL_158.set3);
  }
  const best = r.scen[r.scen.length - 1][1];
  const p2 = predict(fams, 226, best);
  console.log(`  Set 2 by family (all-three fit): ` + Object.entries(p2.byFamily).filter(([, v]) => v.correct >= 0.3 || v.wrong >= 0.2).sort((a, b) => b[1].correct - a[1].correct).map(([k, v]) => `${k} ${v.correct.toFixed(1)}${v.wrong >= 0.1 ? `/−${v.wrong.toFixed(1)}` : ""}`).join(", "));
  const p3 = predict(fams, 458, best, budget3), all3 = predict(fams, 458, best);
  const lab2x = predict(fams, 458, best, budget3, { "lab-report-triage": 0.5 });
  const net = (p: Prediction) => p.correct - p.wrong;
  console.log(`  Set 3 speed (all-three fit): reaching all 458 → ${net(all3).toFixed(1)} pts vs ${net(p3).toFixed(1)} (+${(net(all3) - net(p3)).toFixed(1)}); lab reads 2× faster → reaches ${lab2x.reached} (+${(net(lab2x) - net(p3)).toFixed(1)})`);
  const s1 = predict(fams, 458, { s: 1, l: 0, m: 0 }, budget3), s1all = predict(fams, 458, { s: 1, l: 0, m: 0 });
  console.log(`  a Set-1-like Set 3: ${net(s1).toFixed(1)} pts at current speed, ${net(s1all).toFixed(1)} if all 458 were reached`);
}

if (process.argv[1]?.endsWith("predict.ts")) {
  const { runTaskVariants } = await import("./taskVariants.js");
  const { runPageVariants } = await import("./pageVariants.js");
  printPredictor(runPredictor(await runTaskVariants(), await runPageVariants()));
}
