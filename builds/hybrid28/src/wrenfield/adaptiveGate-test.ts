/** Adaptive fallback gate over the variants harness: every Set 1 task (162 log) and every paraphrase / near-miss
 *  variant of it (taskVariants TEMPLATES, 3 seeds) must be kept away from the adaptive fallback — a solved
 *  family's wording, reworded or near-miss, is answered by its reader or skipped. Also: 0 of the 162 run's
 *  answered tasks can reach it.   npx tsx src/wrenfield/adaptiveGate-test.ts */
import { readFileSync } from "node:fs";
import { familyMatch } from "./families.js";
import { variantsOf } from "./variants/taskVariants.js";
import { adaptiveGate, adaptiveAnswerOk } from "./adaptiveGate.js";
const tasks = readFileSync(new URL("../../fixtures/set1/run-162-set1.log", import.meta.url), "utf8").split("\n")
  .filter((l) => l.startsWith('{"event":"item"')).map((l) => JSON.parse(l)).filter((i) => i.kind === "task");
let n = 0, open = 0, neg = 0, negOpen = 0; const ex: string[] = [];
for (const t of tasks) {
  const fm = familyMatch(t.text);
  if (adaptiveGate(t.text, fm?.family ?? null) === "") { open++; ex.push(`SET1 n=${t.n}: ${t.text.slice(0, 90)}`); }
  n++;
  if (!fm) continue;
  const facts = Object.fromEntries(Object.entries(fm.slots).map(([k, v]) => [k, String(v)]));
  for (const seed of [1, 2, 3]) for (const v of variantsOf(t.text, fm.family, facts, seed)) {
    n++; if (v.negative) neg++;
    if (adaptiveGate(v.text, familyMatch(v.text)?.family ?? null) === "") { open++; if (v.negative) negOpen++; if (ex.length < 15) ex.push(`${fm.family} ${v.tag}: ${v.text.slice(0, 100)}`); }
  }
}
for (const e of ex) console.log("  open: " + e);
// positive control: a novel site question in no family's domain still reaches the fallback
const novel = "Which pharmacy is listed for Mary Turner?";
const ctl = adaptiveGate(novel, familyMatch(novel)?.family ?? null) === "";
console.log(`  ${n} texts (${neg} near-miss negatives): ${open} would reach the adaptive fallback (${negOpen} negatives); novel control open=${ctl}`);
// local queues: a task labelled SKIP (near-miss / unprovable format) must never reach the fallback
let qOpen = 0, qSkipOpen = 0;
for (const f of ["set2-hyp-queue.json", "practice-queue.json", "practice-it-queue.json"]) {
  const q = JSON.parse(readFileSync(new URL(`../../fixtures/${f}`, import.meta.url), "utf8")).items as Array<{ kind: string; text: string; expected?: string }>;
  for (const it of q) if (it.kind === "task" && adaptiveGate(it.text, familyMatch(it.text)?.family ?? null) === "") {
    qOpen++; const sk = /^\(?skip\)?$/i.test(String(it.expected ?? "")); if (sk) qSkipOpen++;
    console.log(`  queue ${f}: open${sk ? " (labelled SKIP!)" : ""}: ${it.text.slice(0, 90)}`);
  }
}
console.log(`  local queues: ${qOpen} tasks reach the fallback, ${qSkipOpen} of them labelled SKIP`);
for (const [a, want] of [["None on file", false], ["No", false], ["Dr. Ana Ruiz", true]] as const) if (adaptiveAnswerOk(a) !== want) { open++; console.log(`  adaptiveAnswerOk(${a}) ≠ ${want}`); }
const ok = open === 0 && ctl && qSkipOpen === 0;
console.log(ok ? "✓ adaptiveGate: no Set 1 task or variant reaches the adaptive fallback" : "✗ adaptiveGate");
process.exit(ok ? 0 : 1);
