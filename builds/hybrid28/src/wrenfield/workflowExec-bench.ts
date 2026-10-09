/**
 * Shadow-executor measurement on a Set 1 workflow with hand-worked verdicts: claim-next-step.
 * The 58 claim-differential cases (captured García page + synthetic claims built from the real markup,
 * each with a verdict worked by hand from the policy, n=120 + amendments) go through the LLM workflow
 * executor exactly as the shift would run it: the policy message (+ later messages), the request, the
 * claim page + payer contract + payers' plans as page text. The worked-example gate uses the policy's own
 * example (Coleman) case. Reports, per case, the would-be answer and whether it agrees with the verdict
 * and with the deterministic LIVE reader; and the rates: answered, right, WRONG.
 *   LLM_BASE_URL=… LLM_API_KEY=… npx tsx src/wrenfield/workflowExec-bench.ts [--models a,b] [--limit N]
 * Also a format/spec self-check that runs offline (no key): `--offline`.
 */
import { msg } from "./claimFixtures.js";
import { CASES, CONTRACT_BODY, live, ok, P132, P164, type Case } from "./claim-differential.js";
import { contractDoc, PLANS } from "./claimFixtures.js";
import { parseWorkflowSpec, matchesTokenFormat, applyWorkflow, exampleGate, type Gathered } from "./workflowExec.js";
import { readFileSync } from "node:fs";

export { pageText } from "./pageText.js";
import { pageText } from "./pageText.js";

const later = (c: Case): string[] => c.o?.pol === P132 ? [msg(132)] : c.o?.pol === P164 ? [msg(132), msg(150), msg(164), msg(176), msg(198)] : [];
function gather(c: Case): Gathered {
  const claim = c.doc();
  const payer = (pageText(claim).match(/(Senior Advantage of the Plains|Tallgrass Health Plan|Northfield Life and Health)/) ?? [])[1] ?? "Senior Advantage of the Plains";
  return { pages: [
    { name: "Claim detail page", text: pageText(claim) },
    { name: `Payer contract page (${payer})`, text: pageText(contractDoc(CONTRACT_BODY(c.o?.appeal), payer)) },
    { name: "Payers and their plans", text: PLANS.map((p) => `${p.payer} | ${p.plan}`).join("\n") },
  ] };
}

const argv = process.argv.slice(2); const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const base = msg(120); const spec = parseWorkflowSpec(base)!;
let fails = 0; const t = (c: boolean, m: string) => { if (!c) { fails++; console.log("FAIL", m); } };
// ── offline: spec + token-format gate on every Set 1 workflow message and the practice NE message
t(!!spec.example && spec.example.answer === "APPEAL:2026-12-15", "claim example parsed");
for (const v of ["APPEAL:2026-12-15", "BILL_PATIENT:34.12", "WRITE_OFF:1250.50", "NO_ACTION", "AWAIT_PAYER", "BILL_OTHER:Silver 3500", "RESUBMIT:MEMBER_ID", "CALL_PAYER", "CONTACT_PATIENT"]) t(matchesTokenFormat(v, spec), "format ok " + v);
for (const v of ["APPEAL:12/15/2026", "BILL_PATIENT:$34.12", "BILL_PATIENT:34.1", "WRITE_OFF", "APPEAL", "PAY:1", "appeal by 2026-12-15", ""]) t(!matchesTokenFormat(v, spec), "format refuses " + v);
const ne = parseWorkflowSpec(JSON.parse(readFileSync(new URL("../../fixtures/practice-queue.json", import.meta.url), "utf8")).items[0].text)!;
t(matchesTokenFormat("ESTABLISHED:2025-03-11", ne) && matchesTokenFormat("NEW", ne) && !matchesTokenFormat("ESTABLISHED", ne) && !matchesTokenFormat("ESTABLISHED:March 3", ne), "NE token format");
t(ne.example?.answer === "ESTABLISHED:2026-06-18", "NE example parsed");
const items = readFileSync(new URL("../../fixtures/set1-items.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const wfs = items.filter((x: any) => x.kind === "message").map((x: any) => parseWorkflowSpec(x.text)).filter((s: any) => s && s.example && s.raw.length > 300);
console.log(`Set 1 workflow messages with a token table + worked example: ${wfs.length} (${wfs.map((w: any) => w.title.slice(0, 40) + " → " + w.example.answer).join("; ")})`);
for (const w of wfs as any[]) t(matchesTokenFormat(w.example.answer, w), "own example matches own format: " + w.title);
if (!argv.includes("--live")) { console.log(fails ? `workflowExec offline: ${fails} FAIL` : "✓ workflowExec offline checks"); process.exit(fails ? 1 : 0); }

// ── live models (key from LLM_API_KEY, or OPENROUTER_API_KEY in the file $WF_KEY_FILE; never printed)
if (!process.env.LLM_API_KEY && process.env.WF_KEY_FILE) { process.env.LLM_API_KEY = readFileSync(process.env.WF_KEY_FILE, "utf8").match(/OPENROUTER_API_KEY=(\S+)/)?.[1]; process.env.LLM_BASE_URL ??= "https://openrouter.ai/api/v1"; }
const models = (arg("--models") ?? "anthropic/claude-sonnet-5.5,anthropic/claude-haiku-5.5").split(",");
const exCase = CASES.find((c) => /^worked example/.test(c.name))!;
const eg = await exampleGate(spec, [], gather(exCase), { models });
console.log(`example gate: ${eg.ok ? "PASS" : "FAIL"} ${eg.why}`);
const cases = CASES.filter((c) => !c.o?.fm).slice(0, Number(arg("--limit") ?? 999)); // digits drawn in a custom font are decoded by the crawler live; here the text would be raw
const tally: Record<string, number> = {}; const rows: string[] = [];
for (const c of cases) {
  const r = await applyWorkflow(spec, later(c), `Next step on claim for the patient on this claim page, service date ${c.dos}`, gather(c), { exampleOk: eg.ok, models });
  const L = live(c);
  const runsAgree = r.gates.agree && r.gates.format ? r.runs[0]! : null;
  const g = (a: string | null) => a == null ? (ok("SKIP", c.verdict) ? "skip(ok)" : "skip(lost)") : ok(a, c.verdict) ? "RIGHT" : "WRONG";
  const gw = g(r.would), gr = g(runsAgree), g0 = g(r.runs[0] ?? null);
  for (const [k, v] of [["gated", gw], ["agree+format", gr], ["single-run", g0]] as const) tally[`${k} ${v}`] = (tally[`${k} ${v}`] ?? 0) + 1;
  const vsLive = r.would == null ? "-" : L === "SKIP" ? "live-skip" : r.would === L ? "=live" : "≠live";
  tally[`gated vs LIVE ${vsLive}`] = (tally[`gated vs LIVE ${vsLive}`] ?? 0) + 1;
  rows.push(`${gw.padEnd(10)} ${String(r.would ?? "-").padEnd(22)} runs=${r.runs.join(" / ").padEnd(44)} verdict=${c.verdict.padEnd(26)} live=${L.padEnd(20)} ${c.name.slice(0, 70)}`);
  console.log(rows[rows.length - 1]);
}
console.log("\n" + Object.entries(tally).sort().map(([k, v]) => `${k}: ${v}`).join("\n"));
