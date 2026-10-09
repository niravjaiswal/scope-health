/** No-regression gate vs the 162 and 164 runs (union of answered tasks) (submission sa028e4cf11f6, merge-best@: Set 1 162 / 0 wrong).
 *  fixtures/set1/run-162-set1.log. For every task the 162 run ANSWERED, under the current code:
 *   - routes to the same family (familyMatch), same keyword plan (toPlan; only for families without a solver) and the same slots (= same reader
 *     dispatch and reader inputs), same crawl decision (KEYWORD_OK);
 *   - the adaptive fallback cannot fire (it needs family === null);
 *   - the merged good-faith notes rule keeps every captured 162 note decision (215/233 insured).
 *  Exit 1 on any answered-task difference.
 *   npx tsx src/wrenfield/parity-162.ts */
import { readFileSync } from "node:fs";
import { familyMatch, KEYWORD_OK, FAMILY_SOLVERS } from "./families.js";
import { toPlan } from "./run.js";
import { extractSlots } from "./parse.js";
import * as R from "./familyReaders.js";
// UNION of the two 0-wrong Set 1 runs: run 162 and ours 164 (integration build).
const rd = (f: string) => readFileSync(new URL(`../../fixtures/set1/${f}`, import.meta.url), "utf8").split("\n")
  .filter((l) => l.startsWith('{"event":"item"')).map((l) => JSON.parse(l)).filter((i) => i.kind === "task");
const byText = new Map<string, any>();
const isAns = (i: any) => !!i?.result && "answer" in i.result;
for (const f of ["run-164-set1.log", "run-162-set1.log"]) for (const i of rd(f)) { const o = byText.get(i.text); if (!o || (!isAns(o) && isAns(i))) byText.set(i.text, i); }
const items = [...byText.values()];
const sortJ = (o: unknown) => JSON.stringify(Object.fromEntries(Object.entries((o ?? {}) as Record<string, unknown>).sort()));
let answered = 0, bad = 0, adaptive = 0; const byFam: Record<string, number> = {};
for (const i of items) {
  if (!i.result || !("answer" in i.result)) continue;
  answered++; byFam[i.family] = (byFam[i.family] ?? 0) + 1;
  const f = familyMatch(i.text);
  const fam = f?.family ?? null, plan = toPlan(i.text)?.type ?? null, slots = f?.slots ?? extractSlots(i.text);
  const crawl = fam ? !!KEYWORD_OK[fam] : null, crawl162 = i.family ? !!KEYWORD_OK[i.family] : null;
  if (!fam) adaptive++;
  const diffs: string[] = [];
  if (fam !== i.family) diffs.push(`family ${i.family} → ${fam}`);
  // the keyword plan only matters for families without their own solver (handleItem dispatches solver families first)
  if (!FAMILY_SOLVERS.has(fam ?? "") && plan !== i.plan) diffs.push(`plan ${i.plan} → ${plan}`);
  if (sortJ(slots) !== sortJ(i.slots)) diffs.push(`slots ${sortJ(i.slots)} → ${sortJ(slots)}`);
  if (crawl !== crawl162) diffs.push("crawl decision");
  if (diffs.length) { bad++; console.log(`DIFF n=${i.n} (${i.result.answer}): ${diffs.join("; ")} :: ${i.text.slice(0, 90)}`); }
}
// captured 162-answered good-faith note bodies (openings logged by run 146; same Set 1 site) → the 162 answers
const NOTES: Array<[number, string, string, string]> = [
  [215, "Emma will not self-pay for the visit on 5/7/2026. Insurance is to be billed.", "2026-05-07", "insured"],
  [233, "Megan will not self-pay for the visit on December 10, 2024. Insurance is to be billed.", "2024-12-10", "insured"],
];
for (const [n, b, d, want] of NOTES) { const r = R.notesDecision([b], d); if (r !== want) { bad++; console.log(`DIFF n=${n}: notes ${JSON.stringify(r)} ≠ 162 ${want}`); } }
const n222 = R.notesDecision(["Self-pay for the 1/6/2025 appointment at the patient's request. Do not bill insurance."], "2025-01-06");
console.log(`  162 skip n=222 (dated self-pay note): now ${JSON.stringify(n222)} (baseline addition)`);
console.log(`  answered by family: ${JSON.stringify(byFam)}`);
console.log(`  adaptive-eligible (family null): ${adaptive} of ${answered} answered; ${items.filter((i) => !familyMatch(i.text)).length} of ${items.length} Set 1 tasks`);
console.log(bad ? `✗ parity-162∪164: ${bad} differences on ${answered} answered tasks` : `✓ parity-162∪164: ${answered}/${answered} answered tasks keep family, plan, slots, crawl; notes 215/233 keep INSURED`);
process.exit(bad ? 1 : 0);
