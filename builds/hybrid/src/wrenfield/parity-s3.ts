/** S3 parity gate: the 304 run (s3 integration build, submission sf5681c40e75e: Set 1 205 correct / 0 wrong / 19 skipped, every task
 *  reached; fixtures/set1/run-s3a-set1.log) replayed under the current routing. Every task it ANSWERED must route to the same family,
 *  the same keyword plan (families without a solver), the same slots and the same crawl decision (as parity-162 / parity-s2 check for
 *  the earlier runs). The 19 skips are listed with their reasons so a later change that answers one is a visible, documented gain.
 *  Also asserts the estimate-as-proof rule answered nothing in that run (no aggregate `via` ending in "~", no `endEstimate` proof):
 *  s3 refuses it (apptList.endFormProof), so the refusal costs this run's Set 1 nothing.
 *  Exit 1 on any routing difference, or if the run's answered count is not 205.
 *   npx tsx src/wrenfield/parity-s3.ts */
import { readFileSync } from "node:fs";
import { familyMatch, KEYWORD_OK, FAMILY_SOLVERS } from "./families.js";
import { toPlan } from "./run.js";
import { extractSlots } from "./parse.js";

const fx = (f: string) => readFileSync(new URL(`../../fixtures/set1/${f}`, import.meta.url), "utf8");
type Item = { n: number; kind: string; family: string | null; text: string; plan: string | null; slots: unknown; result: any; why?: string; agg?: any };
const rd = (f: string): { items: Item[]; aggVias: string[] } => {
  const out: Item[] = []; const aggVias: string[] = []; let agg: any = null;
  for (const l of fx(f).split("\n")) {
    if (l.startsWith('{"event":"aggregate",')) { try { agg = JSON.parse(l); if (agg?.stats?.via) aggVias.push(String(agg.stats.via)); } catch {} }
    else if (l.startsWith('{"event":"item"')) { const i = JSON.parse(l); if (i.kind === "task") out.push({ ...i, agg }); agg = null; }
  }
  return { items: out, aggVias };
};
const sortJ = (o: unknown) => JSON.stringify(Object.fromEntries(Object.entries((o ?? {}) as Record<string, unknown>).sort()));
const isAns = (i: Item) => !!i.result && "answer" in i.result;
let bad = 0;
const routeDiffs = (i: Item): string[] => {
  const f = familyMatch(i.text);
  const fam = f?.family ?? null, plan = toPlan(i.text)?.type ?? null, slots = f?.slots ?? extractSlots(i.text);
  const crawl = fam ? !!KEYWORD_OK[fam] : null, crawlWas = i.family ? !!KEYWORD_OK[i.family] : null;
  const d: string[] = [];
  if (fam !== i.family) d.push(`family ${i.family} → ${fam}`);
  if (!FAMILY_SOLVERS.has(fam ?? "") && plan !== i.plan) d.push(`plan ${i.plan} → ${plan}`);
  if (sortJ(slots) !== sortJ(i.slots)) d.push(`slots ${sortJ(i.slots)} → ${sortJ(slots)}`);
  if (crawl !== crawlWas) d.push("crawl decision");
  return d;
};

const { items, aggVias } = rd("run-s3a-set1.log");
const ans = items.filter(isAns); let diffs = 0;
for (const i of ans) { const d = routeDiffs(i); if (d.length) { diffs++; bad++; console.log(`DIFF n=${i.n} (${i.result.answer}): ${d.join("; ")} :: ${i.text.slice(0, 90)}`); } }
const byFam: Record<string, number> = {}; for (const i of ans) byFam[i.family ?? "(none)"] = (byFam[i.family ?? "(none)"] ?? 0) + 1;
console.log(`${diffs ? "✗" : "✓"} run 304 (s3 integration): ${ans.length - diffs}/${ans.length} answered tasks keep family, plan, slots, crawl (${items.length} tasks in the log)  ${JSON.stringify(byFam)}`);
if (ans.length !== 205) { bad++; console.log(`✗ the 304 run's Set 1 log holds ${ans.length} answered tasks, not the 205 the ledger records`); }
if (items.length !== 224) { bad++; console.log(`✗ ${items.length} tasks in the log, not 224 (every task reached)`); }

// every answered task is a family's: no tier (executor, learner, best-effort) could reach it (they run only with family === null)
const noFam = ans.filter((i) => !familyMatch(i.text));
if (noFam.length) { bad++; console.log(`✗ ${noFam.length} answered tasks have no family under the current routing: ${noFam.map((i) => i.n).join(",")}`); }
else console.log(`✓ all ${ans.length} answered tasks are family-claimed under the current routing: no tier can reach any of them`);

// the estimate-as-proof rule answered nothing in this run
const est = aggVias.filter((v) => /~$/.test(v));
const estItems = items.filter((i) => isAns(i) && i.agg?.stats?.via && /~$/.test(String(i.agg.stats.via)));
if (est.length || estItems.length) { bad++; console.log(`✗ ${estItems.length} answered tasks rested on the estimate-as-proof rule (via ${est.join(",")}); refusing it (apptList.endFormProof) would cost them`); }
else console.log(`✓ 0 answered tasks rested on the estimate-as-proof rule (aggregate vias: ${JSON.stringify([...new Set(aggVias)])}): refusing it costs this run nothing`);

// the skips, for the record
const skips = items.filter((i) => !isAns(i));
const reasons: Record<string, number> = {};
for (const i of skips) { const r = String(i.why ?? i.result?.why ?? "(no why)").replace(/\d[\d,.]*/g, "N").slice(0, 70); reasons[`${i.family ?? "(none)"}: ${r}`] = (reasons[`${i.family ?? "(none)"}: ${r}`] ?? 0) + 1; }
console.log(`${skips.length} skipped tasks in the 304 run:`); for (const [k, v] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(2)}  ${k}`);

console.log(bad ? `\n✗ parity-s3: ${bad} problems` : `\n✓ parity-s3: the 304 run's ${ans.length} answered tasks keep their path; no tier reaches any; the estimate rule answered none`);
process.exit(bad ? 1 : 0);
