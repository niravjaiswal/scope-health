/**
 * Offline checks of the learning loop (no model, no site):
 *  - harness rule (a): over the 169-task union of the 162/164 runs AND the 185 answers of the S1 run, every answered task has a
 *    deterministic family, and the harness refuses to send for a family task in every mode (Set 1 protected by construction);
 *  - modes: off / shadow (logs, never sends) / canary (budget N, p ≥ MIN_P) / on (p ≥ MIN_P_ON); the last-120 s reserve; pacer skips;
 *  - library: the six Set 1 memos get six distinct procedures; a reworded memo matches its own; JSON round trip; load of library.json;
 *  - calibration: estimatePrecision orders the signal patterns the way the asymmetric objective needs;
 *  - learner on canned executor detail: agreeing grounded votes → an answer with p; a dissenting vote → none; stats / retirement.
 *   npx tsx src/wrenfield/learn/learn-test.ts
 */
import { readFileSync } from "node:fs";
import { familyMatch } from "../families.js";
import { parseWorkflowSpec, type WfSpec } from "../workflowExec.js";
import { Harness } from "./harness.js";
import { ProcedureLibrary, loadLibrary, signatureOf, similarity, estimatePrecision, DEFAULT_WEIGHTS, noteVerification, emptyStats, type Procedure, type Signals, MATCH_MIN } from "./procedures.js";
import { Learner } from "./learner.js";

let fails = 0, n = 0; const ok = (c: boolean, m: string) => { n++; if (!c) { fails++; console.log("FAIL", m); } };
const items = (f: string) => readFileSync(new URL(`../../../fixtures/set1/${f}`, import.meta.url), "utf8").split("\n").filter((l) => l.startsWith('{"event":"item"')).map((l) => JSON.parse(l));

// ── (a) Set 1 protected by construction
{
  const byText = new Map<string, any>();
  for (const f of ["run-164-set1.log", "run-162-set1.log", "run-s1-set1.log", "run-s3a-set1.log"]) for (const i of items(f)) if (i.kind === "task" && i.result && "answer" in i.result) byText.set(i.text, i);
  const answered = [...byText.values()];
  const noFam = answered.filter((i) => !familyMatch(i.text));
  ok(answered.length >= 169, `Set 1 union has ≥ 169 answered tasks (${answered.length})`);
  ok(noFam.length === 0, `every answered Set 1 task has a family (${noFam.length} without: ${noFam.slice(0, 3).map((i) => i.text.slice(0, 50)).join(" | ")})`);
  for (const mode of ["shadow", "canary", "on"] as const) {
    const h = new Harness("t", 0, 0, 1e9, 0); let sent = 0;
    for (const i of answered) { const d = h.consider({ tier: "t", task: i.text, family: familyMatch(i.text)!.family, answer: "X", p: 1, secondsLeft: 900 }, mode); if (d.send) sent++; }
    ok(sent === 0 && h.refused.family === answered.length, `mode ${mode}: 0 of ${answered.length} family tasks sent (refused ${h.refused.family})`);
  }
  // every Set 1 task (answered or not) of the S1 run: those with no family are the only ones a learned tier may touch
  const all = items("run-s1-set1.log").filter((i) => i.kind === "task");
  const eligible = all.filter((i) => !familyMatch(i.text));
  console.log(`  Set 1 (S1 run): ${all.length} tasks, ${eligible.length} without a family (the learned tier's reach); ${answered.length} answered across 162/164/S1, all family-claimed`);
}
// ── modes
{
  const c = (p: number, secondsLeft = 900, extra: Partial<Parameters<Harness["consider"]>[0]> = {}) => ({ tier: "t", task: "q", family: null, answer: "A", p, secondsLeft, ...extra });
  const off = new Harness("t", 0.8, 0.6, 2, 120); ok(!off.consider(c(1), "off").send, "off never sends");
  const sh = new Harness("t", 0.8, 0.6, 2, 120); ok(!sh.consider(c(0.95), "shadow").send && sh.wouldSend === 1, "shadow logs a would-send, never sends");
  const ca = new Harness("t", 0.8, 0.6, 2, 120);
  ok(!ca.consider(c(0.79), "canary").send, "canary refuses p < MIN_P");
  ok(ca.consider(c(0.8), "canary").send && ca.consider(c(0.9), "canary").send, "canary sends two within the budget");
  ok(!ca.consider(c(0.99), "canary").send && ca.refused.budget === 1, "canary budget of 2 spent");
  const on = new Harness("t", 0.8, 0.6, 2, 120);
  ok(on.consider(c(0.61), "on").send && on.consider(c(0.95), "on").send && on.consider(c(0.7), "on").send, "on: unbounded count at p ≥ MIN_P_ON");
  ok(!on.consider(c(0.59), "on").send, "on refuses p < MIN_P_ON");
  ok(!on.consider(c(0.99, 100), "on").send && on.refused.reserve === 1, "never in the last 120 s");
  ok(!on.consider(c(0.99, 900, { pacerSkipped: true }), "on").send, "never on a pacer skip");
  ok(!on.consider(c(0.99, 900, { answer: null }), "on").send, "no answer → nothing to send");
  ok(!on.consider(c(0.99, 900, { family: "lab-report-triage" }), "on").send, "family task refused even in on");
}
// ── library over the six Set 1 memos
const msgs = new Map<number, string>(items("run-164-set1.log").filter((i) => i.kind === "message").map((i) => [i.n, i.text]));
const specs = [1, 30, 76, 120, 150, 198].map((k) => parseWorkflowSpec(msgs.get(k)!)!).filter(Boolean);
{
  ok(specs.length === 6, `six Set 1 workflow memos parse (${specs.length})`);
  const lib = new ProcedureLibrary();
  const ids = specs.map((s) => lib.forSpec(s).proc.id);
  ok(new Set(ids).size === 6, `six distinct procedures (${ids.join(", ")})`);
  for (let i = 0; i < specs.length; i++) for (let j = i + 1; j < specs.length; j++) { const s = similarity(signatureOf(specs[i]), signatureOf(specs[j])); ok(s < MATCH_MIN, `memo ${i} vs ${j} similarity ${s.toFixed(2)} < ${MATCH_MIN}`); }
  // a reworded copy of a memo (title kept, prose shuffled) matches its own procedure
  const re = parseWorkflowSpec(specs[3].raw.replace(/\n\n/g, "\n \n").replace(/please/gi, "kindly"))!;
  const m = lib.forSpec(re); ok(m.proc.id === ids[3] && (m.matched ?? 0) >= MATCH_MIN, `reworded claim memo matches its procedure (${m.matched})`);
  ok(lib.lib.procedures.length === 6, "no new procedure for the reworded memo");
  const snap = JSON.parse(JSON.stringify(lib.snapshot())); const lib2 = new ProcedureLibrary(snap);
  ok(lib2.forSpec(specs[0]).proc.id === ids[0] && lib2.lib.procedures.length === 6, "snapshot round trip keeps the procedures");
  const baked = loadLibrary(); ok(baked.lib.version === 1 && typeof baked.weights.bias === "number" && baked.lib.minP.canary >= 0.5, "library.json loads (weights, policy, minP)");
  const missing = loadLibrary("/nonexistent/library.json"); ok(missing.lib.procedures.length === 0 && missing.weights.agree === DEFAULT_WEIGHTS.agree, "a missing library file gives the defaults");
}
// ── calibration order
{
  const base: Signals = { agree: true, voters: 3, dissent: false, grounded: true, complete: true, example: true, format: true, applies: true, plan: true, live: true };
  const p = (s: Partial<Signals>) => estimatePrecision({ ...base, ...s }, DEFAULT_WEIGHTS);
  ok(p({}) > 0.95, `all signals → p ${p({})} > 0.95`);
  ok(p({ dissent: true }) < p({}) - 0.3, `a dissenting run pulls p down (${p({ dissent: true })})`);
  ok(p({ example: false }) < 0.3, `a failed worked example → p ${p({ example: false })} < 0.3`);
  ok(p({ format: false }) < p({}), "format mismatch lowers p");
  ok(p({ applies: false }) < 0.2, `a run saying 'does not apply' → p ${p({ applies: false })} < 0.2`);
  const one: Signals = { agree: null, voters: 1, dissent: false, grounded: true, complete: null, example: null, format: true, applies: true, plan: false, live: false };
  const single = estimatePrecision(one, DEFAULT_WEIGHTS);
  ok(single < p({}) && single > 0.5, `one grounded vote, no second derivation → p ${single} between 0.5 and the full pattern`);
  ok(estimatePrecision({ ...one, grounded: false }, DEFAULT_WEIGHTS) < 0.5, "an ungrounded single vote → p < 0.5");
}
// ── learner on canned executor detail (no model: no plan compiled, votes only)
{
  process.env.AGENT_LEARN = "shadow"; process.env.AGENT_LEARN_COMPILE = "votes";
  const spec: WfSpec = specs[3];
  const lib = new ProcedureLibrary(); const h = new Harness("t", 0.8, 0.6, 5, 120); const L = new Learner(lib, h);
  const proc = L.onMessage(spec, 120, []); ok(!!proc && proc.status === "candidate", "onMessage creates a candidate procedure");
  const vote = (answer: string | null, grounded = true, applies: boolean | null = true) => ({ model: "m", answer, applies, quotes: grounded ? 2 : 0, grounded, ungrounded: [] });
  const detail = (would: string | null, votes: any[], exampleOk: boolean | null = true) => ({ workflow: spec.title, spec, later: [], would, votes, example: { ok: exampleOk, why: "" }, pages: [{ name: "Chart of X — claim list (3 rows; pager walked)", proof: "pager walked [page]" }], ms: 1000 });
  const index: any = { crawler: null };
  const good = await L.onTask(index, "Next step on claim for X, service date 2026-01-01", { answer: null, why: "shadow", ran: true, detail: detail("APPEAL:2026-12-15", [vote("APPEAL:2026-12-15"), vote("APPEAL:2026-12-15"), vote(null)]) }, 800);
  ok(!!good && good.answer === "APPEAL:2026-12-15" && good.p >= 0.8, `agreeing grounded votes → answer with p ${good?.p}`);
  const d1 = h.consider({ tier: "learner", task: "t", family: null, answer: good!.answer, p: good!.p, secondsLeft: 800 }, "shadow"); ok(!d1.send && h.wouldSend === 1, "shadow: would send, did not");
  const dis = await L.onTask(index, "Next step on claim for Y, service date 2026-01-01", { answer: null, why: "runs disagree", ran: true, detail: detail(null, [vote("APPEAL:2026-12-15"), vote("WRITE_OFF:10.00")]) }, 800);
  ok(!!dis && dis.answer === null && dis.p === 0, "dissenting votes → no learned answer");
  const exf = await L.onTask(index, "Next step on claim for Z, service date 2026-01-01", { answer: null, why: "example", ran: true, detail: detail("APPEAL:2026-12-15", [vote("APPEAL:2026-12-15")], false) }, 800);
  ok(!!exf && exf.p < 0.3, `a failed worked example keeps p low (${exf?.p})`);
  ok(proc!.stats.attempts === 3 && proc!.stats.answered === 2, `stats: attempts ${proc!.stats.attempts}, answered ${proc!.stats.answered}`);
  const late = await L.onTask(index, "q", { answer: null, why: "", ran: true, detail: detail("APPEAL:2026-12-15", [vote("APPEAL:2026-12-15")]) }, 60);
  ok(!!late && !h.consider({ tier: "learner", task: "q", family: null, answer: late.answer, p: late.p, secondsLeft: 60 }, "on").send, "last 120 s: the harness refuses");
  const ev = L.events(); ok(ev.length === 2 && ev[0].event === "learn_summary" && ev[1].event === "library" && (ev[1].library as any).procedures.length === 1, "shift-end events: learn_summary + library");
  // retirement after two example failures
  const p2: Procedure = { id: "x", title: "x", signature: signatureOf(spec), status: "verified", plan: { inputs: [], needs: [], steps: [], answer: "A" } as any, planStatus: "verified", policy: lib.policy, verification: [], calibration: lib.weights, stats: emptyStats(), createdAt: "", updatedAt: "", source: "shift" };
  noteVerification(p2, { candidate: "plan", request: "r", want: "A", got: "B", ok: false, level: "live", at: "" }); ok(p2.planStatus === "demoted", "first live failure demotes the plan");
  noteVerification(p2, { candidate: "plan", request: "r", want: "A", got: "B", ok: false, level: "live", at: "" }); ok(p2.planStatus === "retired" && p2.stats.exampleFailures === 2, "second failure retires it");
}
console.log(fails ? `✗ learn-test: ${fails} of ${n} checks failed` : `✓ learn-test: ${n} checks pass`);
process.exit(fails ? 1 : 0);
