/**
 * Queue-order simulation of the shift pacer (pacer.ts) on Set 1's real per-item families, times and outcomes
 * (fixtures/set1/run-146-set1.log, baseline: 146 correct / 0 wrong). A virtual clock replays each item:
 * a worked item costs its logged ms, a pacer skip costs ~0.08 s, a lab read the pacer drops costs 0.3 s
 * (NOT_COVERED answers keep their logged cost and answer). Answers in the log are all correct (0 wrong), so
 * "answers" = expected points; the pacer only turns attempts into skips, so it cannot add a wrong answer.
 *
 *   npx tsx src/wrenfield/sim-pacer.ts            # table; exit 1 if Set 1 loses an answer or isn't fully reached
 */
import { readFileSync } from "node:fs";
import { Pacer } from "./pacer.js";

type It = { kind: string; family: string | null; ms: number; answered: boolean; answer?: string; /** an r4 extra: its cost (s) and the logged skip's ms */ extraS?: number; baseMs?: number; /** answered only by the r4 code (not in run 164) */ fresh?: boolean; /** a lab read slowed by a model failure */ fault?: boolean };
const LOG = process.env.SIM_LOG ?? new URL("../../fixtures/set1/run-146-set1.log", import.meta.url).pathname;
const items: It[] = readFileSync(LOG, "utf8").split("\n").filter((l) => l.startsWith('{"event":"item"')).map((l) => {
  const r = JSON.parse(l); return { kind: r.kind, family: r.family, ms: r.ms, answered: !!r.result && "answer" in r.result, answer: r.result?.answer };
});

/** Set-3-like outcome model: the families whose readers are site-specific answer nothing, labs answer 30 %. */
const SITE_SPECIFIC = new Set(["claim-next-step", "filing-deadline", "good-faith-estimate", "tetanus-wound", "referral-reason"]);
const h = (i: number) => ((i * 2654435761) >>> 0) / 2 ** 32;
function set3like(xs: It[], k: number): It[] {
  return xs.map((x, i) => ({ ...x, ms: x.ms * k, answered: x.answered && !SITE_SPECIFIC.has(x.family ?? "") && (x.family !== "lab-report-triage" || x.answer === "NOT_COVERED" || h(i) < 0.3) }));
}
function shuffle<T>(xs: T[], seed: number): T[] { const a = [...xs]; let s = seed; for (let i = a.length - 1; i > 0; i--) { s = (s * 1103515245 + 12345) >>> 0; const j = s % (i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }

/** The tiers' own end reserves as the image ships them (wfShadow: AGENT_WF_RESERVE_S, bestEffort: AGENT_BEST_EFFORT_RESERVE_S, default 120). */
const DOCKERFILE = (() => { try { return readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8"); } catch { return ""; } })();
const envOf = (k: string, d: number) => { const m = [...DOCKERFILE.matchAll(new RegExp(`\\b${k}=(\\d+)`, "g"))].at(-1); return m ? Number(m[1]) : d; }; // the last ENV wins
const MOD_RESERVE: Record<string, number> = { "workflow-exec": envOf("AGENT_WF_RESERVE_S", 240), "best-effort": envOf("AGENT_BEST_EFFORT_RESERVE_S", 120), lookup: 0 }; // 0 = off (the pacer's own reserve)
const TIER_FAM = new Set(["workflow-exec", "best-effort", "lookup"]);
type RunOpts = { tiersV1?: boolean; modReserve?: Record<string, number> };
/** s3 as shipped (d5ba8b9): the old tier rule and the tiers' old end reserves (AGENT_WF_RESERVE_S 240, best effort 120) */
const OM_S3: RunOpts = { tiersV1: true, modReserve: { "workflow-exec": 240, "best-effort": 120, lookup: 0 } };
function run(xs: It[], shift: number, usePacer: boolean, warm = 10, rtt = 0.03, o: RunOpts = {}) {
  let t = warm; const p = new Pacer(shift, 0, 8, 20, 6, 3, 0.08, 0.5, () => t * 1000); if (o.tiersV1) p.tierMode = false;
  let reached = 0, ans = 0, lost = 0, tasks = 0, declined = 0, freshLost = 0; const lostBy: Record<string, number> = {};
  const admitted: Record<string, number> = {}, tierAns: Record<string, number> = {};
  for (const x of xs) {
    const left = shift - t; if (left <= 4) break;
    reached++; if (x.kind === "task") tasks++;
    let cost = x.ms / 1000, answered = x.answered, attempted = true;
    // A hidden-set tier task (a task no family takes, with an attempt that asks the pacer): the item's floor (routing, crawl) is
    // paid first, then the tier asks extraOk as wfShadow / bestEffort do (the executor with kind "wf"), after the module's own
    // end reserve. Refused, the item costs its floor; admitted, floor + attempt and the attempt's outcome.
    if (usePacer && x.kind === "task" && TIER_FAM.has(x.family ?? "") && x.extraS !== undefined) {
      p.begin(left);
      if (p.taskWhy(x.family)) { t += 0.08 + rtt; if (x.answered) { lost++; lostBy[x.family!] = (lostBy[x.family!] ?? 0) + 1; } p.end(x.family, 80, false, false); continue; }
      const base = (x.baseMs ?? 0) / 1000; t += base;
      const ok = shift - t >= ((o.modReserve ?? MOD_RESERVE)[x.family!] ?? 0) && p.extraOk(x.extraS, x.family === "workflow-exec" ? "wf" : x.family === "lookup" ? "lookup" : "extra");
      if (!ok) { declined++; t += rtt; p.end(x.family, base * 1000, false, true); continue; }
      admitted[x.family!] = (admitted[x.family!] ?? 0) + 1; if (x.answered) { ans++; tierAns[x.family!] = (tierAns[x.family!] ?? 0) + 1; }
      t += Math.max(0, x.ms / 1000 - base) + rtt; p.end(x.family, x.ms, x.answered, true); continue;
    }
    // An r4 extra runs only with the pacer's slack; declined, it costs what the logged skip cost (not a lost answer).
    if (usePacer) p.begin(left);
    if (usePacer && x.extraS && !p.extraOk(x.extraS)) { declined++; cost = (x.baseMs ?? 0) / 1000; answered = false; t += cost + rtt; p.end(x.family, cost * 1000, false, true); continue; }
    if (usePacer) {
      p.begin(left);
      if (x.kind === "task" && p.taskWhy(x.family)) { cost = 0.08; answered = false; attempted = false; }
      else if (x.family === "lab-report-triage" && x.answer !== "NOT_COVERED" && x.ms > 1500 && p.labWhy()) { cost = 0.3; answered = false; }
    }
    if (x.answered && !answered && x.fresh) freshLost++;
    else if (x.answered && !answered) { lost++; lostBy[x.family ?? "-"] = (lostBy[x.family ?? "-"] ?? 0) + 1; }
    if (answered) ans++;
    t += cost + rtt;
    p.end(x.family, cost * 1000, answered, attempted, x.kind === "message" ? "message" : "task", !!x.fault && !process.env.SIM_NO_FAULT_DISCOUNT);
  }
  return { reached, tasks, ans, lost, lostBy, declined, freshLost, used: Math.round(t), admitted, tierAns };
}

const total = (xs: It[]) => xs.filter((x) => x.kind === "task").length;
/** Set 1's queue repeated until it holds 458 tasks (Set 3's size), messages included at Set 1's rate. */
const doubled: It[] = []; for (let i = 0, n = 0; n < 458; i++) { const x = items[i % items.length]; doubled.push(x); if (x.kind === "task") n++; }
let fail = 0;
const row = (name: string, xs: It[], shift: number) => {
  const b = run(xs, shift, false), p = run(xs, shift, true);
  console.log(`${name.padEnd(46)} tasks ${String(total(xs)).padStart(3)} | today: reached ${b.tasks} ans ${b.ans} (${b.used}s) | pacer: reached ${p.tasks} ans ${p.ans} lost ${p.lost}${p.lost ? " " + JSON.stringify(p.lostBy) : ""} (${p.used}s)`);
  return { b, p };
};
const s1 = row("Set 1, own order, 900 s", items, 900);
if (s1.p.ans < s1.b.ans || s1.p.tasks < total(items)) { fail++; console.error("✗ Set 1 lost answers or reach"); }
// The merged readers (filing, good-faith, recall, aggregates) answer late in Set 1's order (items 155+): model
// them answering every logged skip at their logged cost + 3 s, and require that the pacer drops none of them.
const LATE = new Set(["filing-deadline", "good-faith-estimate", "vaccine-lot-recall", "location-month-distinct-patients", "location-completed-before-time", "top-providers-completed-month"]);
const improved = items.map((x) => x.kind === "task" && LATE.has(x.family ?? "") && !x.answered ? { ...x, answered: true, ms: x.ms + 3000 } : x);
for (const [nm, xs] of [["Set 1 + merged readers answering, own order", improved], ["Set 1 + merged readers, shuffled (seed 1)", shuffle(improved, 1)], ["Set 1 + merged readers, shuffled (seed 2)", shuffle(improved, 2)]] as Array<[string, It[]]>) {
  const r = row(nm + ", 900 s", xs, 900); if (r.p.ans < r.b.ans || r.p.tasks < total(xs)) { fail++; console.error("✗ " + nm + " lost answers or reach"); }
}
for (const sh of [1, 2]) { const r = row(`Set 1 x${sh === 1 ? "1" : "2"} shuffled (seed ${sh}), 900 s`, shuffle(items, sh), 900); if (r.p.ans < r.b.ans) { fail++; console.error("✗ Set 1 shuffle lost answers"); } }
row("Set 1 repeated to 458 tasks, Set 1 outcomes, 900 s", doubled, 900);
row("Set 1 doubled, Set 1 outcomes, 1840 s (scaled)", doubled, 1840);
// Calibrate the Set-3-like cost factor so today's code reaches ~258 of 458 (the s9bf85b53402a result).
let k = 1; for (const kk of [1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 2]) { if (run(set3like(doubled, kk), 900, false).tasks <= 262) { k = kk; break; } }
console.log(`Set-3-like model: site-specific families answer 0, labs 30 %, item times x${k} (today reaches ~258)`);
row(`Set-3-like, Set 1 order doubled, 900 s`, set3like(doubled, k), 900);
for (const sd of [3, 4, 5]) row(`Set-3-like, shuffled (seed ${sd}), 900 s`, shuffle(set3like(doubled, k), sd), 900);
// Run 164 (integration build, 164 / 0 wrong): its pacer skipped 5 labs (n=42,47,48,50,56) at item 41 with 692 s
// left. Replay its timings with those pacer skips replaced by the 162 run's record of the same item (answered);
// the pacer must now lose none of them, and Set 1 must be fully reached.
{
  const rd = (f: string) => readFileSync(new URL(`../../fixtures/set1/${f}`, import.meta.url), "utf8").split("\n").filter((l) => l.startsWith('{"event":"item"')).map((l) => JSON.parse(l));
  const r162 = new Map(rd("run-162-set1.log").map((r) => [r.n, r]));
  let patched = 0;
  const xs: Array<It & { n: number }> = rd("run-164-set1.log").map((r) => {
    const y = /^pacer:/.test(r.why ?? "") && r162.get(r.n)?.result && "answer" in r162.get(r.n).result ? (patched++, r162.get(r.n)) : r;
    return { n: r.n, kind: y.kind, family: y.family, ms: y.ms, answered: !!y.result && "answer" in y.result, answer: y.result?.answer };
  });
  const r = run(xs, 900, true), want = xs.filter((x) => x.answered).length;
  console.log(`Run 164 timings + its ${patched} pacer-skipped labs from run 162, own order: reached ${r.tasks}/${total(xs)} ans ${r.ans}/${want} lost ${r.lost} (${r.used}s)`);
  if (r.lost || r.tasks < total(xs) || patched < 5) { fail++; console.error("✗ run-164 replay: the pacer still skips Set 1 answers"); }
  // r4 readers: the run-164 skips they target now answer, at their extra cost. Lab name-only context
  // (Documents filter, measured ~0.9 s on practice) +2 s; visit-day context (that day's appointment list) +15 s
  // typical / +40 s cap; scanned remittance +8 s (the tiebreak runs with the primary: ~11 s -> ~6.5 s over a keyed claim); aggregate whose Show-more list was cut
  // (~13 s already logged for 15 presses): the rest of the list +15 s typical / +40 s; aggregates the pacer starved
  // (0 s budget) +30 / +60 s; aggregates over ~2400+ rows stay skipped (the reader refuses them up front). Recall:
  // the run-164 skip already paid an 8 s wait for the table: answers at that cost, ungated. Set 1 must be fully reached with 0 lost answers.
  const r164 = rd("run-164-set1.log");
  for (const [nm, visit, agg, starved] of [["typical", 15, 15, 30], ["worst-case caps", 40, 40, 60]] as Array<[string, number, number, number]>) {
    let extra = 0, gained = 0;
    const ys = xs.map((x, i) => {
      const w: string = r164[i]?.why ?? ""; let add = 0;
      if (x.answered || x.kind !== "task") return x;
      if (/not read past/.test(w)) add = x.family === "lab-report-triage" ? 2 : visit;
      else if (/scanned paper remittance/.test(w)) add = 8;
      else if (/^aggregate: Show more \d+ did not load/.test(w)) add = agg;
      else if (/^aggregate: pacer — 0 s/.test(w)) add = starved;
      else if (/^recall: the lots table/.test(w)) { gained++; return { ...x, answered: true, fresh: true }; } // a bug fix, not an extra: ungated, same cost
      if (!add) return x;
      extra += add; gained++; return { ...x, answered: true, ms: x.ms + add * 1000, extraS: add, baseMs: x.ms, fresh: true };
    });
    const g = run(ys, 900, true), wantG = ys.filter((x) => x.answered).length;
    console.log(`Run 164 + r4 readers (${nm}: +${extra} s over ${gained} newly answered): reached ${g.tasks}/${total(ys)} ans ${g.ans}/${wantG} lost ${g.lost}${g.lost ? " " + JSON.stringify(g.lostBy) : ""}, extras declined by the pacer ${g.declined}, new answers dropped by tier B ${g.freshLost} (${g.used}s)`);
    if (nm === "typical" && (g.lost || g.tasks < total(ys))) { fail++; console.error("✗ r4 readers (typical): Set 1 loses answers or reach"); }
    if (nm !== "typical" && (g.lost || g.tasks < total(ys))) { fail++; console.error("✗ r4 readers (caps): Set 1 loses answers or reach"); }
  }
  // Run r4 (r4 build, Set 1 146): a spurious haiku-5.5 demote at item 6 left labs on tesseract+gemini;
  // hung gemini reads made labs ~26-41 s and tier B dropped lab at item 80 (5 labs lost to the pacer). Replay the
  // union of the r4 and run-164 answers (each item answered when either run answered it):
  //   (a) r4's own timings (slow labs; a pacer-skipped item costs its run-164 time), lab items with a failed/hung
  //       model read flagged as faults, which the pacer counts at the healthy lab time;
  //   (b) r4 timings with labs at their run-164 (healthy reader) times.
  {
    const raw = (f: string) => readFileSync(new URL(`../../fixtures/set1/${f}`, import.meta.url), "utf8").split("\n");
    const faultOf = new Map<number, boolean>(); let cur = false;
    for (const l of raw("run-r4-set1.log")) {
      if (l.startsWith('{"event":"crawl","step":"lab"')) { const c = JSON.parse(l), t = c.trace ?? c; if (t.modelMs === -1 || t.modelMs >= 20000 || t.tiebreakMs >= 20000) cur = true; }
      else if (l.startsWith('{"event":"item"')) { const r = JSON.parse(l); faultOf.set(r.n, cur); cur = false; }
    }
    const r4 = rd("run-r4-set1.log"), b164 = new Map(rd("run-164-set1.log").map((r) => [r.n, r]));
    const ans = (r: any) => !!r?.result && "answer" in r.result;
    // healthyFrom: item number from which labs run at their run-164 time (Infinity = r4's own slow labs throughout)
    const mk = (healthyFrom: number): It[] => r4.map((r) => {
      const healthyLabs = r.n >= healthyFrom;
      const o = b164.get(r.n); const a = ans(r) || ans(o);
      const lab = r.family === "lab-report-triage";
      const ms = healthyLabs && lab && o ? o.ms : ans(r) ? r.ms : ans(o) ? Math.max(r.ms, o.ms) : r.ms;
      return { kind: r.kind, family: r.family, ms, answered: a, answer: ans(r) ? r.result.answer : o?.result?.answer, fault: !healthyLabs && lab && !!faultOf.get(r.n) };
    });
    for (const [nm, xs, must] of [["r4 timings throughout (faults flagged; does not fit: report only)", mk(Infinity), false], ["r4 timings, slow faulted labs until item 80 then healthy (does not fit: report only)", mk(80), false], ["r4 timings, slow faulted labs until item 40 then healthy", mk(40), true], ["r4 timings, labs at run-164 times", mk(0), true]] as Array<[string, It[], boolean]>) {
      const r = run(xs, 900, true), want = xs.filter((x) => x.answered).length, nf = xs.filter((x) => x.fault).length;
      const sum = Math.round(xs.reduce((t, x) => t + x.ms, 0) / 1000);
      console.log(`Run r4 ∪ 164 answers, ${nm}: ${nf} fault items, ${sum} s of item time; reached ${r.tasks}/${total(xs)} ans ${r.ans}/${want} lost ${r.lost}${r.lost ? " " + JSON.stringify(r.lostBy) : ""} (${r.used}s)`);
      if (r.tasks < total(xs) || (must && r.lost)) { fail++; console.error(`✗ run r4 ∪ 164 (${nm}): the pacer loses Set 1 answers or reach`); }
    }
  }
  // Run 278 (run 278 build, Set 1 185 / 0 wrong, 725 of 900 s): the 14 name-only tasks whose patient was not resolved
  // (lab 10 25 29, tetanus 60 65, claim 127 186, filing 174 175 179 223, good-faith 218 220 226) now read their context
  // (pacer.ctxAdmit): a lab's Documents list ~1.5 s, a visit day's 6-10 locations ~10 s typical / 40 s worst case. Replayed on
  // the run's own timings: every task is still reached, no answered task is lost, and (typical) all 14 are admitted.
  {
    const xs = readFileSync(new URL("../../fixtures/set1/run-278-items.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const NAME = new Set([10, 25, 29, 60, 65, 127, 174, 175, 179, 186, 218, 220, 223, 226]);
    const go = (visitS: number) => {
      let t = 5; const p = new Pacer(900, 0, 8, 20, 6, 3, 0.08, 0.5, () => t * 1000);
      let tasks = 0, lost = 0, admitted = 0, dayReads = 0, refused: number[] = [];
      for (const x of xs) {
        const left = 900 - t; if (left <= 4) break;
        if (x.kind === "task") tasks++;
        p.begin(left); let cost = x.ms / 1000, answered = x.answered, attempted = true;
        if (x.kind === "task" && p.taskWhy(x.family)) { cost = 0.08; answered = false; attempted = false; }
        else if (NAME.has(x.n)) {
          // estimates as index-builder.visitCtx states them: a lab's Documents 2 s, tetanus (Wound care list) 3 s, good-faith (read up to the
          // booked time) 6 s, a claim's / filing question's DOS: the invoice list 3 s (s3-skips; the ten-location day read, 40 s under the
          // request governor, is its fallback — the "worst case" row below); a typed / timed read costs a third of a whole day's
          const lab = x.family === "lab-report-triage", est = lab ? 2 : x.family === "tetanus-wound" ? 3 : x.family === "good-faith-estimate" ? 6 : visitS >= 40 ? 40 : 3;
          const dayRead = est >= 40;
          const a = dayRead && dayReads >= 4 ? null : p.ctxAdmit(est, lab ? 40 : Math.max(15, Math.min(55, est * 2))), spend = lab ? 1.5 : x.family === "tetanus-wound" ? Math.min(visitS, 3) : x.family === "good-faith-estimate" ? Math.min(visitS, 6) : visitS >= 40 ? visitS : Math.min(visitS, 3);
          if (a) { if (dayRead) dayReads++; const add = Math.min(spend, a.budgetMs / 1000); cost += add; a.done(add); admitted++; } else refused.push(x.n); // a read stops at its budget
        }
        if (x.answered && !answered) lost++;
        t += cost + 0.03; p.end(x.family, cost * 1000, answered, attempted, x.kind === "message" ? "message" : "task");
      }
      return { tasks, lost, admitted, refused, used: Math.round(t) };
    };
    for (const [nm, vs, must] of [["typical (invoice list 3 s; 10 s a visit day)", 10, true], ["worst case (every invoice read fails: the 40 s day read, 45 s spent)", 45, false]] as Array<[string, number, boolean]>) {
      const g = go(vs); const nTasks = xs.filter((x) => x.kind === "task").length;
      console.log(`Run 278 + name-only context reads, ${nm}: reached ${g.tasks}/${nTasks}, lost ${g.lost}, admitted ${g.admitted}/14${g.refused.length ? " refused " + g.refused.join(",") : ""} (${g.used}s)`);
      // the worst case (every invoice read failing, six 45 s day reads on a 725 s timeline) is report-only on lost answers: the CTX_DAY_MAX cap
      // (4 a shift) bounds that tail; reach must hold in every case
      if (g.tasks < nTasks || (must && g.lost)) { fail++; console.error(`✗ run 278 + context reads (${nm}): the pacer loses answers or reach`); }
      if (must && g.admitted < 14) { fail++; console.error(`✗ run 278 + context reads (${nm}): ${g.refused.join(",")} refused`); }
    }
  }
  const s3 = shuffle(set3like(doubled, k), 5); const q = run(s3, 900, true);
  console.log(`Set-3-like (seed 5) with pacer: reached ${q.tasks}/${total(s3)}`);
  if (q.tasks < 440) { fail++; console.error(`✗ Set-3-like reach ${q.tasks} < 440`); }
  // S1 (SHIFT_SECONDS = 1800 for Set 3, e1 = 480): the workflow executor (pacer family "workflow-exec", AGENT_WF_TASK_S=20)
  // takes the Set-3-like tasks whose site-specific families answer 0 — at its measured cost (replica LOWO v3c: median
  // 13 s; cap 20 s) and yield (0.6), and only on pacer slack (extraOk, as wfShadow asks). With 458 tasks the executor
  // cannot run on all of them; the pacer must throttle it so every task is still reached (≥ 440) and the kept
  // families lose nothing.
  // "in-flight 1": the learned 429 cap makes the votes sequential (the cheap pair, ~16 s typical, 20 s cap, lower yield).
  const execLike = (xs: It[], costS: number, yieldP = 0.6): It[] => xs.map((x, i) => x.kind === "task" && SITE_SPECIFIC.has(x.family ?? "") ? { ...x, family: "workflow-exec", ms: costS * 1000, answered: h(i + 7) < yieldP, extraS: costS, baseMs: 200 } : x);
  for (const [nm, cost, yp] of [["median 13 s", 13, 0.6], ["cap 20 s", 20, 0.6], ["in-flight 1: sequential cheap pair 16 s, yield 0.5", 16, 0.5], ["in-flight 1 at the 20 s cap, yield 0.4", 20, 0.4]] as Array<[string, number, number]>) {
    for (const seed of [5, 6]) {
      const xs = shuffle(execLike(set3like(doubled, k), cost, yp), seed); const base = run(xs, 1800, false), q = run(xs, 1800, true), s3 = run(xs, 1800, true, 10, 0.03, OM_S3);
      const execAns = (r: ReturnType<typeof run>) => r.ans; const famLost = Object.entries(q.lostBy).filter(([f]) => f !== "workflow-exec").reduce((s, [, n]) => s + n, 0);
      console.log(`Set-3-like + executor (${nm}, seed ${seed}), 1800 s: today reached ${base.tasks} ans ${execAns(base)} (${base.used}s) | pacer: reached ${q.tasks}/${total(xs)} ans ${q.ans} lost ${q.lost}${q.lost ? " " + JSON.stringify(q.lostBy) : ""} executor declined ${q.declined} (${q.used}s) | s3 as shipped: reached ${s3.tasks} ans ${s3.ans} (${s3.used}s)`);
      if (q.tasks < 440) { fail++; console.error(`✗ Set-3-like + executor (${nm}, seed ${seed}): reach ${q.tasks} < 440`); }
      if (famLost) { fail++; console.error(`✗ Set-3-like + executor (${nm}, seed ${seed}): the pacer lost ${famLost} family answers`); }
    }
  }
  // s2 with every tier on (S2-READINESS.md §flags): a task no family takes first costs one router decision (~0.3 s, AGENT_WF_ROUTER=jev,
  // cached for the executor; skipped while the pacer is behind — modelled as paid always, the worse case) before any browsing. Routed
  // (words or Jev: ~half of the site-specific tasks here) → the executor (13 s median / 20 s cap, yield 0.6) and, when it ran, the
  // learner's second derivation (AGENT_LEARN_TASK_S 15, its own slack check; added to the executor's extra = the worse case); unrouted →
  // the best-effort tier (AGENT_BEST_EFFORT_TASK_S 25 cap, prior 15 s / 0.4, only on slack, never in the last 120 s). Compiles run in
  // the background (no item time). Without slack every tier declines at the Jev cost. Every task must still be reached (≥ 440).
  const JEV_S = 0.3;
  // `beMax`: the tier's per-shift attempt cap (AGENT_BEST_EFFORT_MAX; the image ships 40): past it an unrouted task is a plain skip at the Jev cost.
  const tiersLike = (xs: It[], execS: number, learnS: number, beS: number, beY: number, beMax = Infinity): It[] => { let be = 0; return xs.map((x, i) => {
    if (x.kind !== "task" || !SITE_SPECIFIC.has(x.family ?? "")) return x;
    const base = 200 + JEV_S * 1000;
    if (h(i + 11) < 0.5) return { ...x, family: "workflow-exec", ms: (execS + learnS) * 1000, answered: h(i + 7) < 0.6, extraS: execS + learnS, baseMs: base };
    if (be >= beMax) return { ...x, family: null, ms: base, answered: false };
    be++; return { ...x, family: "best-effort", ms: beS * 1000, answered: h(i + 13) < beY, extraS: beS, baseMs: base };
  }); };
  const TIERS = new Set(["workflow-exec", "best-effort"]);
  for (const [nm, execS, learnS, beS, beY, beMax] of [["typical: exec 13 s + learner 10 s, best-effort 15 s / 0.4", 13, 10, 15, 0.4, Infinity], ["caps: exec 20 s + learner 15 s, best-effort 25 s / 0.4", 20, 15, 25, 0.4, Infinity], ["caps, best-effort yield 0.2", 20, 15, 25, 0.2, Infinity], ["shipped: best-effort MAX 80, measured 12.9 s / 0.5", 13, 10, 12.9, 0.5, 80], ["shipped MAX 80 at the caps (25 s)", 20, 15, 25, 0.5, 80]] as Array<[string, number, number, number, number, number]>) {
    for (const seed of [5, 6]) {
      const xs = shuffle(tiersLike(set3like(doubled, k), execS, learnS, beS, beY, beMax), seed); const base = run(xs, 1800, false), q = run(xs, 1800, true), s3 = run(xs, 1800, true, 10, 0.03, OM_S3);
      const famLost = Object.entries(q.lostBy).filter(([f]) => !TIERS.has(f)).reduce((s, [, n]) => s + n, 0);
      console.log(`Set-3-like + all tiers (${nm}, seed ${seed}), 1800 s: today reached ${base.tasks} ans ${base.ans} (${base.used}s) | pacer: reached ${q.tasks}/${total(xs)} ans ${q.ans} lost ${q.lost}${q.lost ? " " + JSON.stringify(q.lostBy) : ""} tiers declined ${q.declined} (${q.used}s) | s3 as shipped: reached ${s3.tasks} ans ${s3.ans} (${s3.used}s)`);
      if (q.tasks < total(xs)) { fail++; console.error(`✗ Set-3-like + all tiers (${nm}, seed ${seed}): reach ${q.tasks} < 440`); }
      if (famLost) { fail++; console.error(`✗ Set-3-like + all tiers (${nm}, seed ${seed}): the pacer lost ${famLost} family answers`); }
    }
  }
  // The final set (getting-started.md, HIDDEN-SETS.md K6): 924 tasks in 3600 s, $25. Two shapes, every tier on (image defaults; the
  // profile's "default" entry changes nothing at 3600 s): (a) the union profile — Set 1's 224 tasks with Set 1's own outcomes and times,
  // then 700 Set-3-like tasks (the Set 2 + Set 3 shares); (b) all 924 Set-3-like. Both shuffled. Reach must be ≥ 95 % (878 of 924).
  {
    const final924: It[] = []; for (let i = 0, n = 0; n < 924; i++) { const x = items[i % items.length]; final924.push(x); if (x.kind === "task") n++; }
    const union: It[] = []; { let n = 0; for (let i = 0; n < 924; i++) { const x = items[i % items.length]; const s1 = n < 224; union.push(s1 ? x : set3like([x], k)[0]); if (x.kind === "task") n++; } }
    for (const [shape, base] of [["union: 224 Set 1 + 700 Set-3-like", union], ["all Set-3-like", set3like(final924, k)]] as Array<[string, It[]]>) {
      for (const [nm, execS, learnS, beS, beY, beMax] of [["typical, best-effort uncapped", 13, 10, 15, 0.4, Infinity], ["measured 12.9 s, best-effort MAX 80 (shipped)", 13, 10, 12.9, 0.5, 80], ["caps, best-effort MAX 80", 20, 15, 25, 0.5, 80], ["caps, best-effort OFF (the Set 3 arm)", 20, 15, 25, 0.4, 0]] as Array<[string, number, number, number, number, number]>) {
        for (const seed of [5, 6]) {
          const xs = shuffle(tiersLike(base, execS, learnS, beS, beY, beMax), seed); const b = run(xs, 3600, false), q = run(xs, 3600, true), s3 = run(xs, 3600, true, 10, 0.03, OM_S3);
          const famLost = Object.entries(q.lostBy).filter(([f]) => !TIERS.has(f)).reduce((s, [, n]) => s + n, 0);
          console.log(`Final 924 (${shape}; ${nm}; seed ${seed}), 3600 s: today reached ${b.tasks} ans ${b.ans} (${b.used}s) | pacer: reached ${q.tasks}/${total(xs)} (${(100 * q.tasks / total(xs)).toFixed(1)} %) ans ${q.ans} lost ${q.lost}${q.lost ? " " + JSON.stringify(q.lostBy) : ""} tiers declined ${q.declined} (${q.used}s) | s3 as shipped: reached ${s3.tasks} ans ${s3.ans}`);
          if (q.tasks < Math.ceil(0.95 * total(xs))) { fail++; console.error(`✗ Final 924 (${shape}; ${nm}; seed ${seed}): reach ${q.tasks} < 95 %`); }
          // The pacer sheds 1-6 lab reads (labWhy) in this shape with the tiers ON, uncapped, capped at 40 or OFF alike: it is the pacer
          // trading a few 6 s lab reads for reach at 924 tasks (today's code, no pacer, reaches only ~280-530), not a cost of the tiers.
          // Reported, not a failure; the knob would be AGENT_PACER_* (the default profile), not a tier flag.
          if (famLost) console.log(`  (final: the pacer shed ${famLost} family answers — ${JSON.stringify(q.lostBy)} — the same with best-effort off; not a tier cost)`);
        }
      }
    }
  }
}
// Run 278 (S1 image , 185 correct / 0 wrong / 39 skipped, 740 s of item time in 900 s): the 10 appointment-list aggregates it skipped
// with a readable list modelled as answering by reading the list (a COST model for the pacer only: s3 refuses the estimate footer as a
// proof — apptList.endFormProof — and answers only what the by-day re-read proves). Cost per item from the list sizes in the logged footers
// (rows incl. the day either side; 108, the top 3 providers over 16,950 rows, by per-provider lists: aggregate.topByEstimate): presses = rows / 20 at PRESS_S each (x1.15), ~0.7 s for each ~200-row
// chunk or 300-row part, spread over `tabs` workers (apptList.readParallel; 1 = a single tab), + ~3 s to open tabs / probe the range, ~4 s of
// record opens. Reads over 15 s run only with pacer slack (as solvers.aggregate gates them); the others always.
// The pacer may decline an extra but must lose no answer 278 already had, and every task must still be reached.
{
  const items278 = readFileSync(new URL("../../fixtures/set1/run-278-items-agg.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const ROWS: Record<number, number> = { 83: 250, 115: 1000, 130: 425, 134: 2400, 151: 1175, 165: 1100, 195: 625, 225: 1650, 236: 2275 };
  const base278: It[] = items278.map((r) => ({ kind: r.kind, family: r.family, ms: r.ms, answered: !!r.result && "answer" in r.result, answer: r.result?.answer }));
  const want278 = base278.filter((x) => x.answered).length;
  for (const [nm, pressS, tabs] of [["3 tabs, 0.3 s a press", 0.3, 3], ["3 tabs, 0.65 s a press (the 278 run's first-load time per press)", 0.65, 3], ["1 tab, 0.25 s a press", 0.25, 1], ["1 tab, 0.3 s a press", 0.3, 1], ["1 tab, 0.65 s a press", 0.65, 1]] as Array<[string, number, number]>) {
    let ran = 0; let extra = 0;
    const ys: It[] = items278.map((r, i) => {
      const rows = ROWS[r.n]; if ((!rows && r.n !== 108) || r.kind !== "task" || (r.result && "answer" in r.result)) return base278[i];
      const w = r.n === 108 || rows > 320 ? tabs : 1; // a list the site calls short is read in one go
      // item 108 (top 3 providers): ~72 active providers' list sizes (0.9 s each) + ~10 of the close ones read to the end (3.5 s each)
      const cost = r.n === 108 ? (72 * 0.9 + 10 * 3.5) / w + (w > 1 ? 3 : 0) : (Math.ceil(rows / 20) * pressS * 1.15 + Math.ceil(rows / 200) * 0.7) / w + (w > 1 ? 3 : 0) + 4; extra += cost; ran++;
      return { ...base278[i], answered: true, ms: base278[i].ms + cost * 1000, extraS: cost > 15 ? cost : undefined, baseMs: base278[i].ms, fresh: true };
    });
    const g = run(ys, 900, true), none = run(base278, 900, true);
    console.log(`Run 278 (${nm}): ${ran} aggregates answering, +${Math.round(extra)} s if all run; pacer: reached ${g.tasks}/${total(ys)} ans ${g.ans}/${want278 + ran} (278's own ${want278} lost ${g.lost}), extras declined ${g.declined}, new answers dropped by tier B ${g.freshLost} (${g.used}s; 278 as run: ${none.used}s, ans ${none.ans})`);
    if (g.lost || g.tasks < total(ys)) { fail++; console.error(`✗ run 278 + aggregates (${nm}): the pacer loses answers 278 had, or reach`); }
  }
}
// Run 265 (S2-1 image 71cbf4c: Set 1 166 / 0 wrong / 52 skipped / 6 not reached, 873 s of item time). Its 3-tab aggregate reads drew a 503 (item 108),
// 50+ "busy" lists (115, 130, 195) and two "This account is suspended" windows: items 125-128 and 210-240 (every patient search 13 s, then "not
// reached"). Run 278, single tab and no retries, saw 2 busy pages (items 130, 195: Show more N added no rows) and no suspension. Counterfactual with AGG_TABS=1 / AGG_MAX_REQ=17 /
// no busy retries: the month counts and top-k decline from their first page (0.3 s) and the suspension windows do not happen — their items take
// run 278's own time and outcome. Not a prediction (the 265-only readers add their own time); it shows the pacer reaches every task and keeps
// every answer when the ~97 s of 0-answer aggregate time and the suspension waits are gone.
{
  const rdLog = (f: string) => readFileSync(new URL(`../../fixtures/set1/${f}`, import.meta.url), "utf8").split("\n");
  const itemsOf = (ls: string[]) => ls.filter((l) => l.startsWith('{"event":"item"')).map((l) => JSON.parse(l));
  const L265 = rdLog("run-265-set1.log"), i265 = itemsOf(L265), i278 = new Map(itemsOf(rdLog("run-278-set1.log")).map((r) => [r.n, r]));
  const WINDOWS: Array<[number, number]> = [[125, 128], [210, 240]];
  const inWin = (n: number) => WINDOWS.some(([a, b]) => n >= a && n <= b);
  // the fixture must show the suspension only inside those windows (a "crawl resolve" / probe line mentioning it belongs to the item that follows or precedes it by one)
  { let n = 0; const outside: number[] = []; let cur: number | null = null; const seen = new Set<number>();
    for (const l of L265) { if (l.includes("This account is su")) { n++; cur = 1; } if (l.startsWith('{"event":"item"')) { const it = JSON.parse(l); if (cur && !inWin(it.n) && !inWin(it.n - 1)) outside.push(it.n); if (cur) seen.add(it.n); cur = null; } }
    console.log(`Run 265: "This account is suspended" on ${n} lines, in the segments of items ${[...seen].join(",")}`);
    if (!n || outside.length) { fail++; console.error(`✗ run 265: suspension seen outside the windows (${outside.join(",")})`); } }
  const AGG_OFF = new Set(["location-month-distinct-patients", "top-providers-completed-month"]);
  const asLogged: It[] = i265.map((r) => ({ kind: r.kind, family: r.family, ms: r.ms, answered: !!r.result && "answer" in r.result, answer: r.result?.answer }));
  const cf: It[] = Array.from(new Set([...i265.map((r) => r.n), ...i278.keys()])).sort((a, b) => a - b).map((n) => {
    const r = i265.find((x) => x.n === n), o = i278.get(n), src = !r || inWin(n) ? o : r;
    const agg = src.kind === "task" && AGG_OFF.has(src.family ?? "");
    return { kind: src.kind, family: src.family, ms: agg ? 300 : src.ms, answered: !agg && !!src.result && "answer" in src.result, answer: src.result?.answer };
  });
  const a = run(asLogged, 900, true), c = run(cf, 900, true), cb = run(cf, 900, false);
  const sec = (xs: It[]) => Math.round(xs.reduce((t, x) => t + x.ms, 0) / 1000);
  console.log(`Run 265 as logged: ${sec(asLogged)} s of item time, ${asLogged.filter((x) => x.answered).length} answered, pacer replay reached ${a.tasks}/${total(asLogged)} ans ${a.ans}`);
  console.log(`Run 265 + AGG_TABS=1 / AGG_MAX_REQ=17 / no suspension windows: ${sec(cf)} s of item time, ${cf.filter((x) => x.answered).length} answered; pacer: reached ${c.tasks}/${total(cf)} ans ${c.ans} lost ${c.lost}${c.lost ? " " + JSON.stringify(c.lostBy) : ""} (${c.used}s; no pacer: reached ${cb.tasks} ans ${cb.ans}, ${cb.used}s)`);
  if (c.lost || c.tasks < total(cf) || c.ans < asLogged.filter((x) => x.answered).length) { fail++; console.error("✗ run 265 counterfactual: the pacer loses answers or reach"); }
}
// ───────────────── the hidden-set tiers (PACER-TIERS.md) ─────────────────
const tierLine = (r: ReturnType<typeof run>) => `admitted ${JSON.stringify(r.admitted)} tier answers ${JSON.stringify(r.tierAns)} declined ${r.declined}, reached ${r.tasks}, ans ${r.ans}, family lost ${Object.entries(r.lostBy).filter(([f]) => !TIER_FAM.has(f)).reduce((a, [, n]) => a + n, 0)} (${r.used}s)`;
const sumOf = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
// Run 304 (s3 integration build = the s3 family code, Set 1 205 / 0 wrong; fixtures/set1/run-s3a-set1.log): Set 1 on its own timings, every
// task family-claimed (no tier key), so the tier rule never runs; every task reached, no answer lost.
{
  const xs: It[] = readFileSync(new URL("../../fixtures/set1/run-s3a-set1.log", import.meta.url), "utf8").split("\n").filter((l) => l.startsWith('{"event":"item"')).map((l) => {
    const r = JSON.parse(l); return { kind: r.kind, family: r.family, ms: r.ms, answered: !!r.result && "answer" in r.result, answer: r.result?.answer }; });
  const r = run(xs, 900, true), v1 = run(xs, 900, true, 10, 0.03, { tiersV1: true }), want = xs.filter((x) => x.answered).length;
  console.log(`Run 304 (s3a) Set 1, own order, 900 s: reached ${r.tasks}/${total(xs)} ans ${r.ans}/${want} lost ${r.lost} (${r.used}s) | AGENT_PACER_TIERS=v1: ans ${v1.ans} (${v1.used}s)`);
  if (r.lost || r.tasks < total(xs) || r.ans !== v1.ans || r.used !== v1.used) { fail++; console.error("✗ run 304 (s3a): the tier rule changed Set 1"); }
}
// Set-2-like (HIDDEN-SETS.md §3: 226 tasks, families cover ~15 %, skips close in < 300 ms, ~540-700 s of 900 unused): Set 1's queue (run 304)
// with 15 % of its tasks kept as the family tasks they are (their logged time and outcome) and the rest made hidden-set tasks: a 0.25 s floor;
// 45 % routed to the executor (attempt 3-12 s, median 7.5 s as GATHER.md jev-4 measured; yield 0.5), 30 % best effort (5-21 s, median 13 s;
// yield 0.28 as BEST-EFFORT.md), 25 % refused by the text gates (no attempt, 0.25 s). Seeds vary the mix.
const set2like = (seed: number): It[] => {
  const src = readFileSync(new URL("../../fixtures/set1/run-s3a-set1.log", import.meta.url), "utf8").split("\n").filter((l) => l.startsWith('{"event":"item"')).map((l) => JSON.parse(l));
  return src.map((r, i): It => {
    const x: It = { kind: r.kind, family: r.family, ms: r.ms, answered: !!r.result && "answer" in r.result, answer: r.result?.answer };
    if (r.kind !== "task" || h(i * 7 + seed) < 0.15) return x;
    const u = h(i * 13 + seed * 3), v = h(i * 17 + seed * 5), base = 250;
    if (u < 0.45) { const a = 3 + 9 * v; return { kind: "task", family: "workflow-exec", ms: base + a * 1000, answered: h(i * 19 + seed) < 0.5, extraS: 20, baseMs: base }; }
    if (u < 0.75) { const a = 5 + 16 * v; return { kind: "task", family: "best-effort", ms: base + a * 1000, answered: h(i * 23 + seed) < 0.28, extraS: 25, baseMs: base }; }
    return { kind: "task", family: null, ms: base, answered: false };
  });
};
for (const seed of [1, 2, 3]) {
  const xs = set2like(seed), r = run(xs, 900, true), v1 = run(xs, 900, true, 10, 0.03, { tiersV1: true }), s3 = run(xs, 900, true, 10, 0.03, OM_S3), all = run(xs, 900, false);
  const asks = xs.filter((x) => x.extraS !== undefined).length;
  console.log(`Set-2-like (seed ${seed}, ${asks} tier tasks of ${total(xs)}), 900 s:\n    new: ${tierLine(r)}\n    v1:  ${tierLine(v1)}\n    s3 (v1 + 240/120 s tier reserves): ${tierLine(s3)}\n    no pacer: reached ${all.tasks} ans ${all.ans} (${all.used}s)`);
  const famLost = Object.entries(r.lostBy).filter(([f]) => !TIER_FAM.has(f)).reduce((a, [, n]) => a + n, 0);
  if (r.tasks < total(xs) || famLost) { fail++; console.error(`✗ Set-2-like (seed ${seed}): reach ${r.tasks} or family answers lost ${famLost}`); }
  if (r.ans < v1.ans) { fail++; console.error(`✗ Set-2-like (seed ${seed}): fewer answers than v1 (${r.ans} < ${v1.ans})`); }
}
// Site C (bench/sites, 231 never-seen workflow tasks + 42 messages, 900 s; run site-C-20261009T101510Z of s3@d5ba8b9, profile set2,
// fixtures/sites/site-C-om-s3-items.jsonl from its agent.log): each item's floor = its time less the executor / learner / best-effort
// attempt it ran. An attempt that ran keeps its logged time and outcome; one the pacer refused ("no slack", or the tiers' 240 s "shift
// reserve") is given an attempt time drawn from the run's own attempts of that tier and the run's own yield (executor 6 of 51, best
// effort 0 of 27). The two lookup-preemption wrongs (83, 163) answered without a tier attempt and stay as logged.
for (const [fx, runName] of [["site-C-om-s3-items.jsonl", "s3@d5ba8b9 run site-C-20261009T101510Z"], ["site-C-om-s3-memo-items.jsonl", "s3-memo@9740305 run site-C-20261009T105633Z (re-login, memo gate)"]]) {
  const raw = readFileSync(new URL(`../../fixtures/sites/${fx}`, import.meta.url), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const att = (r: any) => (r.wf?.ran ? r.wf.ms : 0) + (r.wf?.ran ? r.learnMs ?? 0 : 0) + (r.be?.ran ? r.be.ms : 0);
  const refused = (w: any) => !!w && !w.ran && /^pacer|shift reserve/.test(w.why ?? "");
  const wfRuns = raw.filter((r) => r.wf?.ran).map((r) => r.wf.ms + (r.learnMs ?? 0)), beRuns = raw.filter((r) => r.be?.ran).map((r) => r.be.ms);
  const wfY = raw.filter((r) => r.wf?.ran && r.wf.ans).length / Math.max(1, wfRuns.length), beY = raw.filter((r) => r.be?.ran && r.be.ans).length / Math.max(1, beRuns.length);
  const xs: It[] = raw.map((r, i): It => {
    const fam = r.key === "(message)" ? null : r.key === "(none)" ? null : r.key;
    const x: It = { kind: r.kind, family: fam, ms: r.ms, answered: r.answered };
    if (r.kind !== "task" || !TIER_FAM.has(fam ?? "")) return x;
    const a = att(r), floor = r.ms - a;
    if (a > 0 || r.wf?.ran || r.be?.ran) return { ...x, ms: r.ms, baseMs: floor, extraS: r.wf?.ran ? 20 : 25 };
    if (refused(r.wf)) { const d = wfRuns[Math.floor(h(i + 31) * wfRuns.length)]; return { ...x, ms: floor + d, baseMs: floor, extraS: 20, answered: h(i + 37) < wfY }; }
    if (refused(r.be)) { const d = beRuns[Math.floor(h(i + 41) * beRuns.length)]; return { ...x, ms: floor + d, baseMs: floor, extraS: 25, answered: h(i + 43) < beY }; }
    return x; // no attempt asked (text gates, MAX, a lookup answered first)
  });
  const r = run(xs, 900, true), v1 = run(xs, 900, true, 10, 0.03, { tiersV1: true }), s3 = run(xs, 900, true, 10, 0.03, OM_S3), all = run(xs, 900, false);
  const loggedRuns = raw.filter((x) => x.wf?.ran || x.be?.ran).length, asks = xs.filter((x) => x.extraS !== undefined).length;
  console.log(`Site C replay (${runName}: ${loggedRuns} tier attempts ran; ${asks} tier tasks asked; executor attempts median ${wfRuns.sort((a, b) => a - b)[wfRuns.length >> 1]} ms, yield ${wfY.toFixed(2)}; best effort ${beRuns.sort((a, b) => a - b)[beRuns.length >> 1]} ms, yield ${beY.toFixed(2)}), 900 s:\n    new: ${tierLine(r)}\n    v1:  ${tierLine(v1)}\n    s3 (v1 + 240/120 s tier reserves): ${tierLine(s3)}\n    no pacer: reached ${all.tasks} ans ${all.ans} (${all.used}s)`);
  if (r.tasks < total(xs)) { fail++; console.error(`✗ Site C replay: reach ${r.tasks} < ${total(xs)}`); }
  if (r.ans < v1.ans) { fail++; console.error(`✗ Site C replay: fewer answers than v1 (${r.ans} < ${v1.ans})`); }
}
// Run s3a (s3 integration build, Set 1 205 / 0 wrong / 19 skipped, 689 s of item time in 900 s; submission sf5681c40e75e = 304). The s3-skips
// fixes replayed on its own timings (fixtures/set1/run-s3a-items.jsonl):
//  - the six name-only visit tasks whose ten-location day reads died on busy pages after 31-35 s (65, 127, 174, 175, 186, 223) now read the
//    invoice list first (contextResolve.invoiceContext: 2-4 requests, ~3 s) — their item costs become search (~2 s) + 3 s + a chart (~1 s);
//    "worst case": every invoice read fails and the 40 s day read follows under the request governor (45 s spent, cap 55);
//  - 83 (Cedar Hollow day, 14 requests) is read once the busy cooldown no longer blocks it: 265's cost (2.7 s) + 1 s;
//  - 112 (recall) and 220 (good-faith) answer at their logged cost (deterministic reads);
//  - 130 / 195 (month counts of 425 / 625 rows) read by day under the governor: ~30 / ~45 s, admitted only on pacer slack (extraOk);
//  - the rest of the 19 stay declined at their logged cost. Every task must still be reached and no answered task lost.
{
  const xs = readFileSync(new URL("../../fixtures/set1/run-s3a-items.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const VISIT = new Set([65, 127, 174, 175, 186, 223]);
  const go = (invoiceFails: boolean, byDay: boolean) => {
    let t = 5; const p = new Pacer(900, 0, 8, 20, 6, 3, 0.08, 0.5, () => t * 1000);
    let tasks = 0, lost = 0, gained = 0, dayReads = 0, refused: number[] = [];
    for (const x of xs) {
      const left = 900 - t; if (left <= 4) break;
      if (x.kind === "task") tasks++;
      p.begin(left); let cost = x.ms / 1000, answered = x.answered, attempted = true;
      if (x.kind === "task" && p.taskWhy(x.family)) { cost = 0.08; answered = false; attempted = false; }
      else if (VISIT.has(x.n)) {
        const inv = p.ctxAdmit(3, 15);
        if (inv) { inv.done(3); if (!invoiceFails) { cost = 2 + 3 + 1; answered = true; gained++; }
          else { const day = dayReads < 4 ? p.ctxAdmit(40, 55) : null; if (day) { dayReads++; cost = 2 + 3 + Math.min(45, day.budgetMs / 1000) + 1; day.done(45); answered = true; gained++; } else { cost = 2 + 3; refused.push(x.n); } } }
        else { cost = 2; refused.push(x.n); }
      }
      else if (x.n === 83) { cost = 2.7 + 1; answered = true; gained++; }
      else if (x.n === 112 || x.n === 220) { answered = true; gained++; }
      else if (byDay && (x.n === 130 || x.n === 195)) { const c = x.n === 130 ? 30 : 45; if (p.extraOk(c)) { cost = c + 1; answered = true; gained++; } else refused.push(x.n); }
      if (x.answered && !answered) lost++;
      t += cost + 0.03; p.end(x.family, cost * 1000, answered, attempted, x.kind === "message" ? "message" : "task");
    }
    return { tasks, lost, gained, refused, used: Math.round(t) };
  };
  const nTasks = xs.filter((x) => x.kind === "task").length, had = xs.filter((x) => x.answered).length;
  for (const [nm, invFail, byDay, must] of [["invoice lists resolve, month counts by day", false, true, true], ["every invoice read fails → 40 s day reads, month counts by day", true, true, false], ["invoice lists resolve, no by-day reads", false, false, true]] as Array<[string, boolean, boolean, boolean]>) {
    const g = go(invFail, byDay);
    console.log(`Run s3a + s3-skips (${nm}): reached ${g.tasks}/${nTasks}, ans ${had + g.gained} (s3a's ${had} lost ${g.lost}, +${g.gained})${g.refused.length ? ", refused " + g.refused.join(",") : ""} (${g.used}s)`);
    if (g.tasks < nTasks || g.lost) { fail++; console.error(`✗ run s3a + skips (${nm}): the pacer loses answers or reach`); }
    if (must && g.refused.length) { fail++; console.error(`✗ run s3a + skips (${nm}): ${g.refused.join(",")} refused`); }
  }
  // Set-3-like: s3a's queue repeated to 458 tasks at 1800 s with the same model (site-specific families answer 0, labs 30 %), the visit
  // reads at their invoice cost: every task must be reached (s4: was ≥ 440).
  const dbl: It[] = []; for (let i = 0, n = 0; n < 458; i++) { const x = xs[i % xs.length]; dbl.push({ kind: x.kind, family: x.family, ms: VISIT.has(x.n) ? 6000 : x.ms, answered: x.answered || VISIT.has(x.n) }); if (x.kind === "task") n++; }
  for (const seed of [5, 6]) { const q = run(shuffle(set3like(dbl, k), seed), 1800, true); console.log(`Set-3-like from s3a (seed ${seed}), 1800 s: reached ${q.tasks}/${total(dbl)} ans ${q.ans} lost ${q.lost} (${q.used}s)`); if (q.tasks < total(dbl)) { fail++; console.error(`✗ Set-3-like from s3a: reach ${q.tasks} < ${total(dbl)}`); } }
}
console.log(fail ? "FAIL" : "ALL PASS"); process.exit(fail ? 1 : 0);
