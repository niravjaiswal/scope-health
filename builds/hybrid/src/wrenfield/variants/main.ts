/**
 * One command for the integrator, after merging each branch:
 *   1. Set 1 parity vs the 158 run (exit 1 if a task the 158 run answered changed);
 *   2. task-variant robustness per family (+ hard negatives);
 *   3. page variants: any reader returning a DIFFERENT value;
 *   4. predicted Set 1 / 2 / 3 for the current code (shift fitted on the 158 code, kept fixed).
 *
 *   npx tsx src/wrenfield/variants/main.ts [--examples N] [--save out.json] [--against prev.json]
 * (scripts/variants.sh wraps this, locally or in the om-superset:test image.)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { runParity, printParity } from "./parity.js";
import { runTaskVariants, printRobustness, runRouting, printRouting, routingWrong } from "./taskVariants.js";
import { runPageVariants, printPageVariants } from "./pageVariants.js";
import { runPredictor, printPredictor, predict, type Shift } from "./predict.js";
import { FIX } from "./harness.js";

const a = process.argv; const at = (f: string) => (a.indexOf(f) >= 0 ? a[a.indexOf(f) + 1] : undefined);
/** The hidden-set shifts fitted on the 158 code (one per scenario; "all three" is the headline).
 *  Predictions for later code keep them, so a change in prediction comes from the code, not from a
 *  refit. Rewrite only on the 158 code: `--write-shift`. */
const SHIFT_FILE = FIX + "set1/variants-shift-158.json";

const parity = await runParity();
printParity(parity);
const rob = await runTaskVariants();
printRobustness(rob, Number(at("--examples") ?? 1));
const pages = await runPageVariants();
printPageVariants(pages);
// Reworded tasks + reworded governing messages: where each ends, and the would-be −1s among them.
const routing = await runRouting();
printRouting(routing, Number(at("--examples") ?? 1));
const routeWrong = routingWrong(routing);
const routed = Object.values(routing.tasks["broad-govern"] ?? {}).reduce((a, r) => a + (r["routed:reader"] ?? 0) + (r["routed:answer"] ?? 0), 0), routeN = Object.values(routing.tasks["broad-govern"] ?? {}).reduce((a, r) => a + r.n, 0);
console.log(`  routing: ${routed}/${routeN} reworded tasks reach their family's reader (broad govern words); would-be −1 ${routeWrong}`);
const fixedAll: Record<string, Shift> | undefined = existsSync(SHIFT_FILE) && !a.includes("--write-shift") ? JSON.parse(readFileSync(SHIFT_FILE, "utf8")) : undefined;
const pred = runPredictor(rob, pages, fixedAll);
printPredictor(pred);
if (a.includes("--write-shift")) { writeFileSync(SHIFT_FILE, JSON.stringify(Object.fromEntries(pred.scen.map(([n, s]) => [n, { s: s.s, l: s.l, m: s.m }])), null, 1) + "\n"); console.log(`  wrote ${SHIFT_FILE}`); }
const fixed = fixedAll?.["all three"];

// ── one-line summary (+ delta vs a saved run) ──
const shift = fixed ?? pred.scen[pred.scen.length - 1][1];
const p1 = predict(pred.fams, 224, { s: 1, l: 0, m: 0 }), p2 = predict(pred.fams, 226, shift), p3 = predict(pred.fams, 458, shift, pred.budget3);
const sum = (k: "same" | "variants" | "different" | "generalist" | "negWrong") => rob.rows.reduce((x, r) => x + r[k], 0);
const summary = {
  parityAnsweredChanged: parity.answeredChanged.length, parityNewAnswers: parity.newAnswers.length,
  variantSame: +(sum("same") / sum("variants")).toFixed(3), variantWouldBeWrong: sum("different") + sum("generalist"), negativesWrong: sum("negWrong"),
  pageDifferent: pages.findings.filter((f) => f.verdict === "DIFFERENT").length,
  set1: +(p1.correct - p1.wrong).toFixed(1), set2: +(p2.correct - p2.wrong).toFixed(1), set3: +(p3.correct - p3.wrong).toFixed(1),
  byFamily: Object.fromEntries(rob.rows.map((r) => [r.family, { same: r.same, variants: r.variants, bad: r.different + r.generalist, negWrong: r.negWrong }])),
};
console.log(`\n== SUMMARY == parity: ${summary.parityAnsweredChanged} answered changed, ${summary.parityNewAnswers} new answers | variants SAME ${(100 * summary.variantSame).toFixed(0)}%, would-be −1 ${summary.variantWouldBeWrong}, hard negatives wrong ${summary.negativesWrong} | page DIFFERENT ${summary.pageDifferent} | predicted net Set 1 ${summary.set1}, Set 2 ${summary.set2}, Set 3 ${summary.set3} (shift s=${shift.s.toFixed(2)} l=${shift.l.toFixed(2)} m=${shift.m.toFixed(2)}${fixed ? ", fixed at the 158 fit" : ", refitted"})`);
const prevFile = at("--against") ?? FIX + "set1/variants-summary-158.json"; // default: the 158 code
if (prevFile && existsSync(prevFile)) {
  const prev = JSON.parse(readFileSync(prevFile, "utf8"));
  const d = (k: string) => { const v = (summary as any)[k] - prev[k]; return `${k} ${v >= 0 ? "+" : ""}${Number(v.toFixed(3))}`; };
  console.log(`  vs ${prevFile}: ${["parityAnsweredChanged", "variantSame", "variantWouldBeWrong", "negativesWrong", "pageDifferent", "set1", "set2", "set3"].map(d).join(", ")}`);
  for (const [f, v] of Object.entries(summary.byFamily)) { const p = prev.byFamily?.[f]; if (p && (p.same !== v.same || p.bad !== v.bad || p.negWrong !== v.negWrong)) console.log(`    ${f}: SAME ${p.same}→${v.same}, would-be −1 ${p.bad}→${v.bad}, negatives wrong ${p.negWrong}→${v.negWrong}`); }
}
if (at("--save")) writeFileSync(at("--save")!, JSON.stringify(summary, null, 1));
if (routeWrong) console.log(`  ✗ routing: ${routeWrong} would-be −1 among reworded tasks / negatives / messages`);
process.exit(parity.answeredChanged.length || routeWrong ? 1 : 0);
