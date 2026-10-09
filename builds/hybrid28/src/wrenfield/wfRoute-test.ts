/**
 * Offline checks of the Jev memo router (wfRoute.ts, decisions.ts, wfShadow glue) — no model calls:
 *  - decisions: a reply is validated field by field (type, options, probabilities in [0,1]); no endpoint → null;
 *  - memo options: every Set 1 memo yields a rule sentence, its answer forms and its example request; keys unique; none present;
 *  - judge: routed only at p ≥ 0.8 AND runner-up ≤ 0.1; "none" and an unknown option never route; env thresholds;
 *  - Set 1 parity: walking the 164 ∪ 162 items as shiftMain does, Jev is never consulted for a task a family claimed
 *    (every answered Set 1 task) nor for one the words route (wfFor); it is asked once per no-family task (cached);
 *    router off / executor off / pacer quick → never asked; a transport failure → unrouted, never a throw;
 *  - the wf_route log line is written for every decision, with the probabilities.
 *   npx tsx src/wrenfield/wfRoute-test.ts
 */
import { readFileSync } from "node:fs";
import { _parseAnswer, decide } from "./decisions.js";
import { firstRule, exampleRequest, memoKeys, memoOptions, judge, routeByJev, NONE, thresholds, type Memo } from "./wfRoute.js";
import { parseWorkflowSpec } from "./workflowExec.js";
import { wfNoteMessage, wfFor, wfForAsync, wfRoutedAsync, _resetWorkflows, _setRouteChooser } from "./wfShadow.js";
import { familyMatch } from "./families.js";

let fails = 0; const t = (c: boolean, m: string) => { if (!c) { fails++; console.log("FAIL", m); } };
process.env.AGENT_WORKFLOW_EXEC = "shadow"; process.env.AGENT_WF_ROUTER = "jev"; process.env.AGENT_WF_EAGER_EXAMPLE = "0";
delete process.env.LLM_BASE_URL; delete process.env.LLM_API_KEY;

// ── decisions: validation + fail closed ──
{
  const cq = { type: "choice" as const, instructions: "x", criteria: { a: "A", b: "B", [NONE]: "none" } };
  t(_parseAnswer(cq, { type: "choice", choice: "a", confidence: 0.9, probabilities: { a: 0.9, b: 0.1 } })?.type === "choice", "choice parses (missing option prob = 0)");
  t(_parseAnswer(cq, { type: "choice", choice: "zzz", confidence: 0.9, probabilities: { a: 0.9 } }) === null, "choice outside the options → null");
  t(_parseAnswer(cq, { type: "choice", choice: "a", confidence: 1.5, probabilities: { a: 0.9 } }) === null, "confidence outside [0,1] → null");
  t(_parseAnswer(cq, { type: "noul", noul: 0.5 }) === null, "wrong answer type → null");
  t(_parseAnswer({ type: "noul", instructions: "x" }, { type: "noul", noul: 0.42 })?.type === "noul", "noul parses");
  t(_parseAnswer({ type: "noul", instructions: "x" }, { type: "noul", noul: "0.42" }) === null, "noul with a string → null");
  const sq = { type: "score" as const, instructions: "x", criteria: ["lo", "mid", "hi"] };
  const sa: any = _parseAnswer(sq, { type: "score", score: 1.9, confidence: 0.8, probabilities: { "0": 0, "1": 0.1, "2": 0.9 }, legend: { "0": "lo", "1": "mid", "2": "hi" } });
  t(sa?.type === "score" && sa.legend["2"] === "hi", "score parses with legend");
  t(_parseAnswer(sq, { type: "score", score: "high", confidence: 0.8 }) === null, "score not a number → null");
  const d = await decide("state", { q: cq });
  t(d === null, "no endpoint → decide null (fail closed)");
}
// ── memo options over the Set 1 memos ──
const items1 = readFileSync(new URL("../../fixtures/set1-items.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const specs = items1.filter((x: any) => x.kind === "message" && x.text.length >= 300 && /^From [^:\n]{2,60}:/.test(x.text)).map((x: any) => parseWorkflowSpec(x.text)!).filter(Boolean);
t(specs.length === 6, `6 Set 1 memos parsed (got ${specs.length})`);
const keys = memoKeys(specs); const memos: Memo[] = specs.map((spec, i) => ({ key: keys[i], spec }));
t(new Set(keys).size === 6 && keys.every((k) => /^[a-z0-9_]+$/.test(k) && k !== NONE), "memo keys unique slugs: " + keys.join(","));
for (const m of memos) {
  const r = firstRule(m.spec.raw), ex = exampleRequest(m.spec);
  t(r.length >= 40 && r.length <= 260 && !/^#/.test(r), `${m.key}: first rule sentence (${r.length}): ${r.slice(0, 60)}`);
  t(ex.length >= 10, `${m.key}: example request: ${ex.slice(0, 60)}`);
}
const opts = memoOptions(memos);
t(Object.keys(opts).length === 7 && typeof opts[NONE] === "string", "options = 6 memos + none");
t(/Answers look like: .*(RELEASE|NURSE_REVIEW)/.test(opts[keys[0]]) && /Example request/.test(opts[keys[0]]), "option carries answer forms + example: " + opts[keys[0]].slice(0, 120));
t(Object.values(opts).every((v) => v.length <= 700), "options bounded");
// duplicate titles get distinct keys
t(new Set(memoKeys([specs[0], specs[0], specs[1]])).size === 3, "duplicate titles → distinct keys");
// ── judge ──
const ch = (probabilities: Record<string, number>, ms = 5) => { const best = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]; return { choice: best[0], confidence: 1, probabilities, usage: { input_tokens: 1, output_tokens: 1, cost: 0.00001 }, ms }; };
const k0 = keys[0], k1 = keys[1]; const TH = { p: 0.8, p2: 0.1 };
t(judge(ch({ [k0]: 0.9, [k1]: 0.05, [NONE]: 0.05 }), memos, TH).routed?.key === k0, "p 0.9 / 0.05 → routed");
t(judge(ch({ [k0]: 0.8, [k1]: 0.1, [NONE]: 0.1 }), memos, TH).routed?.key === k0, "p 0.8 / 0.1 (at the lines) → routed");
t(judge(ch({ [k0]: 0.79, [k1]: 0.01, [NONE]: 0.2 }), memos, TH).routed === null, "p 0.79 → unrouted");
t(judge(ch({ [k0]: 0.85, [k1]: 0.15 }), memos, TH).routed === null && /runner-up/.test(judge(ch({ [k0]: 0.85, [k1]: 0.15 }), memos, TH).why), "runner-up 0.15 → unrouted");
t(judge(ch({ [k0]: 0.85, [NONE]: 0.15 }), memos, TH).routed === null, "none as runner-up 0.15 → unrouted");
t(judge(ch({ [NONE]: 0.99, [k0]: 0.01 }), memos, TH).routed === null && judge(ch({ [NONE]: 0.99, [k0]: 0.01 }), memos, TH).why === "none of the memos", "none → unrouted");
t(judge(ch({ ghost: 1 }), memos, TH).routed === null, "unknown option → unrouted");
process.env.AGENT_WF_ROUTE_P = "0.6"; process.env.AGENT_WF_ROUTE_P2 = "0.3";
t(thresholds().p === 0.6 && thresholds().p2 === 0.3 && judge(ch({ [k0]: 0.65, [k1]: 0.25, [NONE]: 0.1 }), memos).routed?.key === k0, "env thresholds");
process.env.AGENT_WF_ROUTE_P = "abc"; process.env.AGENT_WF_ROUTE_P2 = "2"; t(thresholds().p === 0.8 && thresholds().p2 === 0.2, "bad env → defaults (0.8 / 0.2: JEV-ROUTER.md §5)");
delete process.env.AGENT_WF_ROUTE_P; delete process.env.AGENT_WF_ROUTE_P2;
// ── routeByJev: log line + fail closed ──
{
  const lines: string[] = []; const w = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = (s: string) => { lines.push(String(s)); return true; };
  try {
    const d = await routeByJev("Next step on claim: García, Abigail, DOB 1952-04-03, service date 2026-07-14", memos, { chooser: async () => ch({ [keys[3]]: 0.97, [NONE]: 0.03 }) });
    t(d?.routed?.key === keys[3], "routeByJev routes");
    const n = await routeByJev("What is the weather?", memos, { chooser: async () => null });
    t(n === null, "chooser null → no decision");
  } finally { (process.stdout as any).write = w; }
  const recs = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r?.event === "wf_route");
  t(recs.length === 2 && recs[0].routed && recs[0].p >= 0.97 && recs[0].probs && recs[0].head && !recs[0].why, "wf_route log line for the routed task: " + JSON.stringify(recs[0]).slice(0, 160));
  t(recs[1] && recs[1].routed === null && /transport/.test(recs[1].why), "wf_route log line for the failed decision");
}
// ── Set 1 parity: Jev never consulted for a family's task; once per no-family task; lexical first ──
for (const f of ["run-164-set1.log", "run-162-set1.log", "run-s3a-set1.log"]) {
  const items = readFileSync(new URL(`../../fixtures/set1/${f}`, import.meta.url), "utf8").split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((x) => x?.event === "item");
  _resetWorkflows(); const asked: string[] = []; _setRouteChooser(async (state: any) => { asked.push(state.request); return ch({ [NONE]: 1 }); });
  let answered = 0, famTasks = 0, lexical = 0, noFamily = 0;
  for (const it of items) {
    if (it.kind === "message") { wfNoteMessage(it.text, it.n); continue; }
    const fam = familyMatch(it.text); if (it.result && "answer" in it.result) answered++;
    if (fam) { famTasks++; continue; }               // shiftMain: paceKey = family; wfExecuteDetail only when !family
    noFamily++; if (wfFor(it.text)) lexical++;
    const r = await wfForAsync(it.text); if (wfFor(it.text)) t(r.via === "words", "words win over Jev");
    await wfRoutedAsync(it.text);                      // the pace key asks the same cached decision
  }
  const expectAsked = noFamily - lexical;
  t(asked.length === expectAsked, `${f}: Jev asked ${asked.length} times = ${expectAsked} no-family, non-lexical tasks (${famTasks} family tasks, ${answered} answered: never asked); cached for the pace key`);
  console.log(`${f}: ${famTasks} tasks claimed by a family, ${noFamily} without (${lexical} routed by words, ${asked.length} asked of Jev)`);
}
// off switches + quick + throwing chooser
{
  _resetWorkflows(); let calls = 0; _setRouteChooser(async () => { calls++; return ch({ [NONE]: 1 }); });
  wfNoteMessage(items1.find((x: any) => x.n === 120).text, 120);
  const task = "Please tell me the weather on Mars for García, Abigail.";
  t(!(await wfForAsync(task, { quick: true })).w && calls === 0, "quick → Jev not asked");
  process.env.AGENT_WF_ROUTER = "off"; t(!(await wfForAsync(task)).w && calls === 0, "router off → not asked"); process.env.AGENT_WF_ROUTER = "jev";
  process.env.AGENT_WORKFLOW_EXEC = "off"; t(!(await wfForAsync(task)).w && calls === 0, "executor off → not asked"); process.env.AGENT_WORKFLOW_EXEC = "shadow";
  await wfForAsync(task); await wfForAsync(task); t(calls === 1, "asked once per task text (cached)");
  _setRouteChooser(async () => { throw new Error("boom"); }); _resetWorkflows(); wfNoteMessage(items1.find((x: any) => x.n === 120).text, 120);
  t(!(await wfForAsync(task)).w, "throwing chooser → unrouted, no throw");
  // a routed task comes back with via "jev" and the memo
  _setRouteChooser(async () => ch({ [memoKeys([parseWorkflowSpec(items1.find((x: any) => x.n === 120).text)!])[0]]: 0.95, [NONE]: 0.05 })); _resetWorkflows(); wfNoteMessage(items1.find((x: any) => x.n === 120).text, 120);
  const q = "The payer has answered for García, Abigail (DOB 1952-04-03), visit of 2026-07-14. What do we do now?";
  t(wfFor(q) === null, "the words do not route this phrasing");
  const r = await wfForAsync(q);
  t(r.via === "jev" && /claim/.test(r.w?.spec.title ?? ""), "Jev routes to the claim memo: " + r.via);
  // an identical memo re-sent is one workflow
  wfNoteMessage(items1.find((x: any) => x.n === 120).text, 130);
  t((await wfForAsync(q)).via === "jev", "duplicate memo deduped (still routes)");
  _setRouteChooser(undefined);
}
console.log(fails ? `wfRoute-test: ${fails} FAIL` : "✓ wfRoute-test");
process.exit(fails ? 1 : 0);
