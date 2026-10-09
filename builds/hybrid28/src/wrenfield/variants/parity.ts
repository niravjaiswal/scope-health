/**
 * Set 1 PARITY GATE. Replays the real Set 1 queue (fixtures/set1-items.jsonl) offline and compares,
 * per task, with the 158 run (fixtures/set1/run-158-items.jsonl = the run's own per-item record):
 *   1. routing: family, keyword plan and slots as the 158 run logged them;
 *   2. action: the reader(s) + arguments + answer-or-skip of the task traced through handleItem
 *      against the instrumented fake clinic (harness.ts), vs the 158 code's action
 *      (fixtures/set1/parity-158-actions.jsonl, written by `--write-baseline` on the 158 code).
 * A change on a task the 158 run ANSWERED is a regression risk (it scored 113 of those 114); a task
 * the 158 run skipped that now reaches an answer is a NEW answer that needs hand verification.
 *
 *   npx tsx src/wrenfield/variants/parity.ts [--write-baseline] [--verbose]
 * Exit 1 when any answered task changed family/plan/slots/action.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { loadItems, loadLog, storesByPrefix, messagesBefore, trace, actionOf, familyMatch, FIX, type Trace } from "./harness.js";
import { toPlan } from "../run.js";
import { extractSlots } from "../parse.js";

const BASE = FIX + "set1/parity-158-actions.jsonl";
const J = (x: unknown) => JSON.stringify(x);

export type ParityRow = { n: number; family: string | null; answered158: boolean; changes: string[]; action: string; baseAction?: string; nowAnswers: boolean };
export type ParityReport = { rows: ParityRow[]; answeredChanged: ParityRow[]; newAnswers: ParityRow[]; lostAnswers: ParityRow[]; routingChanged: number; actionChanged: number; tasks: number; answered158: number; baseline: boolean };

export async function runParity(opts: { writeBaseline?: boolean } = {}): Promise<ParityReport> {
  const items = loadItems(), log = loadLog();
  const stores = await storesByPrefix(items, log);
  const before = messagesBefore(items);
  const base: Map<number, string> = existsSync(BASE) && !opts.writeBaseline ? new Map(readFileSync(BASE, "utf8").split("\n").filter(Boolean).map((l) => { const r = JSON.parse(l); return [r.n, r.action]; })) : new Map();
  const rows: ParityRow[] = []; const out: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i], rec = log[i], n = i + 1;
    if (it.kind !== "task") continue;
    if (!rec || rec.text !== it.text) throw new Error(`log item ${n} does not match the queue item`);
    const fam = familyMatch(it.text);
    const changes: string[] = [];
    if ((fam?.family ?? null) !== rec.family) changes.push(`family ${rec.family} → ${fam?.family ?? null}`);
    const plan = toPlan(it.text)?.type ?? null;
    if (plan !== (rec.plan ?? null)) changes.push(`plan ${rec.plan} → ${plan}`);
    const slots = fam?.slots ?? extractSlots(it.text);
    if (J(slots) !== J(rec.slots)) changes.push(`slots ${J(rec.slots)} → ${J(slots)}`);
    const t: Trace = await trace(it.text, stores[before[i]], Object.fromEntries(Object.entries(fam?.slots ?? {}).map(([k, v]) => [k, String(v)])));
    const action = actionOf(t);
    out.push(J({ n, action }));
    const b = base.get(n);
    if (b !== undefined && b !== action) changes.push(`action ${b} → ${action}`);
    rows.push({ n, family: fam?.family ?? null, answered158: !!rec.result && "answer" in rec.result, changes, action, baseAction: b, nowAnswers: t.answer !== null || /(lab|claim|filing|tetanus|goodFaith)Context\(/.test(action) });
  }
  if (opts.writeBaseline) writeFileSync(BASE, out.join("\n") + "\n");
  const answeredChanged = rows.filter((r) => r.answered158 && r.changes.length);
  const baseAnswers = (r: ParityRow) => r.baseAction !== undefined && (r.baseAction.startsWith("A:") || /(lab|claim|filing|tetanus|goodFaith)Context\(/.test(r.baseAction));
  return {
    rows, answeredChanged,
    newAnswers: rows.filter((r) => !r.answered158 && r.changes.some((c) => c.startsWith("action")) && r.nowAnswers && !baseAnswers(r)),
    lostAnswers: rows.filter((r) => r.changes.some((c) => c.startsWith("action")) && !r.nowAnswers && baseAnswers(r)),
    routingChanged: rows.filter((r) => r.changes.some((c) => !c.startsWith("action"))).length,
    actionChanged: rows.filter((r) => r.changes.some((c) => c.startsWith("action"))).length,
    tasks: rows.length, answered158: rows.filter((r) => r.answered158).length, baseline: base.size > 0,
  };
}

export function printParity(p: ParityReport, verbose = false) {
  console.log(`\n== Set 1 parity (vs run 158: ${p.tasks} tasks, ${p.answered158} answered) ==`);
  if (!p.baseline) console.log("  (no action baseline: run with --write-baseline on the 158 code)");
  console.log(`  routing changed on ${p.routingChanged} tasks; action changed on ${p.actionChanged} tasks`);
  console.log(`  ${p.answeredChanged.length ? "✗" : "✓"} previously ANSWERED tasks changed: ${p.answeredChanged.length}`);
  for (const r of p.answeredChanged) console.log(`     n=${r.n} ${r.family}: ${r.changes.join("; ").slice(0, 300)}`);
  console.log(`  new answers on tasks 158 skipped (hand-verify): ${p.newAnswers.length}`);
  const byFam = new Map<string, number>(); for (const r of p.newAnswers) byFam.set(r.family ?? "(none)", (byFam.get(r.family ?? "(none)") ?? 0) + 1);
  for (const [f, c] of byFam) console.log(`     ${f}: ${c}`);
  if (p.lostAnswers.length) console.log(`  answer paths lost vs baseline: ${p.lostAnswers.length} (${p.lostAnswers.map((r) => `n=${r.n} ${r.family}`).join(", ").slice(0, 200)})`);
  if (verbose) for (const r of p.rows.filter((r) => r.changes.length && !r.answered158)) console.log(`     n=${r.n} ${r.family}: ${r.changes.join("; ").slice(0, 300)}`);
}

if (process.argv[1]?.endsWith("parity.ts")) {
  const p = await runParity({ writeBaseline: process.argv.includes("--write-baseline") });
  printParity(p, process.argv.includes("--verbose"));
  if (process.argv.includes("--write-baseline")) console.log(`  wrote ${BASE}`);
  process.exit(p.answeredChanged.length ? 1 : 0);
}
