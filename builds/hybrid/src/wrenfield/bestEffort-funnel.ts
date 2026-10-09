/**
 * Offline funnel of the best-effort tier over every labelled queue we have (no model, no browser): tasks → claimed by a family
 * (never attempted) → refused by the text gate (yes/no, judgement, derived arithmetic, nothing to gather by) → attemptable, and
 * of those how many a memo routes (wfFor), lookup.ts parses, or chartAnswers parses. Hard negatives (expected "(skip)") that
 * remain attemptable are the ones only the live signals can stop.
 *   npx tsx src/wrenfield/bestEffort-funnel.ts
 */
import { readFileSync, existsSync } from "node:fs";
import { familyMatch } from "./families.js";
import { beTextGate } from "./bestEffort.js";
import { wfNoteMessage, wfFor, _resetWorkflows } from "./wfShadow.js";
import { lookupSpec } from "./lookup.js";
import { chartQuestion } from "./chartAnswers.js";

process.env.AGENT_BEST_EFFORT = "on"; process.env.AGENT_WORKFLOW_EXEC ??= "on";
const neg = (e: unknown) => e === "(skip)" || String(e).toUpperCase() === "SKIP";
console.log("| queue | tasks | family (never attempted) | text gate | attemptable | memo-routed | lookup parses | chart parses | hard negatives | negatives still attemptable |");
console.log("|---|---|---|---|---|---|---|---|---|---|");
for (const f of ["cov-suite.json", "set2-hyp-queue.json", "practice-it-queue.json", "practice-queue.json", "best-effort-negatives.json", "../bench/set1-replica/queue.json"]) {
  const p = new URL(`../../fixtures/${f}`, import.meta.url); if (!existsSync(p)) continue;
  const q = JSON.parse(readFileSync(p, "utf8")); _resetWorkflows(); let n = 0;
  const c = { tasks: 0, family: 0, gate: 0, attempt: 0, memo: 0, lookup: 0, chart: 0, neg: 0, negAttempt: 0 };
  for (const it of q.items) { n++; if (it.kind === "message") { wfNoteMessage(it.text, n); continue; } c.tasks++;
    const isNeg = neg(it.expected); if (isNeg) c.neg++;
    if (familyMatch(it.text)) { c.family++; continue; }
    if (beTextGate(it.text)) { c.gate++; continue; }
    c.attempt++; if (isNeg) c.negAttempt++; if (wfFor(it.text)) c.memo++; if (!("why" in lookupSpec(it.text))) c.lookup++; if (chartQuestion(it.text)) c.chart++; }
  console.log(`| ${f.replace("../bench/set1-replica/queue.json", "set1-replica")} | ${c.tasks} | ${c.family} | ${c.gate} | ${c.attempt} | ${c.memo} | ${c.lookup} | ${c.chart} | ${c.neg} | ${c.negAttempt} |`);
}
