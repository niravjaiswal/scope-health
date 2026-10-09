/**
 * Offline checks of the best-effort tier (no model, no browser):
 *  - THE invariant: no Set 1 task (fixtures/set1-items.jsonl + every task of the 164 / s1 logs) can reach the tier — with the
 *    flag on, bestEffort() refuses every task a family claims, even when the caller passes family = null;
 *  - the text gate refuses yes/no, judgement and anchor-less questions;
 *  - plainForm: digits / ISO dates / two-decimal amounts / verbatim text; sentences, times, display dates → ISO or null;
 *  - tally + estimate on hand-made votes: the signals order the estimate as the design says (cross-family + deterministic
 *    + grounded ≫ single ungrounded), vetoes are not probabilities.
 *   npx tsx src/wrenfield/bestEffort-test.ts
 */
import { readFileSync, existsSync } from "node:fs";
import { bestEffort, beRouted, beTextGate, plainForm, tally, estimate, genericSpec, proofOf, type Signals } from "./bestEffort.js";
import { familyMatch } from "./families.js";
import type { Vote } from "./workflowExec.js";

let fails = 0, n = 0; const t = (c: boolean, m: string) => { n++; if (!c) { fails++; console.log("FAIL", m); } };
process.env.AGENT_BEST_EFFORT = "on"; process.env.AGENT_LIST_COUNT ??= "on";

// ── 1. the invariant over every Set 1 task we have
const texts = new Set<string>();
const items1 = readFileSync(new URL("../../fixtures/set1-items.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
for (const x of items1) if (x.kind === "task") texts.add(x.text);
for (const f of ["run-164-set1.log", "run-162-set1.log", "run-r4-set1.log", "run-s1-set1.log", "run-s3a-set1.log"]) {
  const p = new URL(`../../fixtures/set1/${f}`, import.meta.url); if (!existsSync(p)) continue;
  for (const l of readFileSync(p, "utf8").split("\n")) { if (!l.includes('"event":"item"')) continue; try { const j = JSON.parse(l); if (j.kind === "task") texts.add(j.text); } catch {} }
}
const fakeIndex: any = { crawler: { today: "2026-10-14" }, findPatient: () => null, providers: new Map(), appointments: [], byDate: () => [] };
let withFamily = 0, noFamily: string[] = [], reached = 0, routed = 0;
for (const text of texts) {
  const fam = familyMatch(text);
  if (fam) withFamily++; else noFamily.push(text);
  if (beRouted(text, fam)) routed++;
  // the caller's family AND a null family (a caller bug) must both be refused for a family's task
  for (const passed of [fam, null]) { const r = await bestEffort(fakeIndex, text, passed as any, 1e9); if (fam && (r.ran || r.answer !== null || r.why !== "")) reached++; }
}
t(reached === 0, `best-effort reached ${reached} Set 1 family tasks (must be 0)`);
t(routed === 0, `beRouted true for ${routed} Set 1 tasks (every Set 1 task has a family)`);
console.log(`Set 1 tasks checked: ${texts.size} (${withFamily} with a family, ${noFamily.length} without${noFamily.length ? ": " + noFamily.slice(0, 3).map((x) => x.slice(0, 60)).join(" | ") : ""}); reached ${reached}, routed ${routed}`);

// ── 2. text gate
t(beTextGate("Is Maria Lopez (born 1980-02-02) insured?") !== "", "yes/no refused");
t(beTextGate("Does Soto, Julia (DOB 1990-01-01) have any allergies on file?") !== "", "yes/no (does) refused");
t(beTextGate("Why was the claim for Soto, Julia denied?") !== "", "judgement refused");
t(beTextGate("How many invoices are there?") !== "", "no anchor refused");
t(beTextGate("How many days ago was Grace Hayes's (DOB 1955-08-21) most recent completed visit?") !== "", "days-ago arithmetic refused");
t(beTextGate("What percentage of Andrew Torres's (born 1977-01-02) appointments in 2025 were completed?") !== "", "percentage refused");
t(beTextGate("How old is Grace Hayes (DOB 1955-08-21)?") !== "", "age refused");
t(beTextGate("How many invoices were issued on 2026-09-30?") === "", "a date is an anchor");
t(beTextGate("What was the status of Soto, Julia's (DOB 1990-01-01) appointment on 2025-03-18?") === "", "patient + date passes");
t(beTextGate("When was Soto, Julia (born 03/04/1990) last seen?") === "", "when + patient passes");

// ── 3. plain forms
const pf = (s: string) => plainForm(s)?.answer ?? null, pk = (s: string) => plainForm(s)?.kind ?? null;
t(pf("3") === "3" && pk("3") === "int", "int");
t(pf("007") === "7", "int leading zeros");
t(pf("$118.40") === "118.40" && pk("$118.40") === "amount", "amount with $");
t(pf("1,234.50") === "1234.50", "amount with comma");
t(pf("2025-11-24") === "2025-11-24" && pk("2025-11-24") === "date", "iso date");
t(pf("Nov 24, 2025") === "2025-11-24", "display date → ISO");
t(pf("11/24/2025") === "2025-11-24", "US date → ISO");
t(pf("Nov 24, 2025, 9:00 AM MDT") === null || pk("Nov 24, 2025, 9:00 AM MDT") === "text", "date-time: not a date answer");
t(pf("3:15 PM") === null, "time of day refused");
t(pf("None on file") === null && pf("Not recorded") === null && pf("—") === null && pf("No provider assigned") === null && pf("Unassigned") === null, "empty-value placeholders refused");
t(pf("Yes") === null && pf("none") === null && pf("UNKNOWN") === null, "yes/none/unknown refused");
t(pf("Follow-up visit") === "Follow-up visit" && pk("Follow-up visit") === "text", "text verbatim");
t(pf("The patient has three completed appointments in the window.") === null, "a sentence refused");
t(pf("`Late cancel`") === "Late cancel", "backticks stripped");

// ── 4. tally + estimate
const V = (model: string, answer: string | null, grounded = true, applies: boolean | null = true): Vote => ({ model, answer, applies, quotes: grounded ? 1 : 0, grounded, ungrounded: grounded ? [] : ["x"] });
const spec = genericSpec();
{ const r = tally([V("anthropic/claude-haiku-5.5", "3"), V("google/gemini-3.8-flash", "3")], spec, false); t(r.answer === "3" && r.agree === "cross" && !r.dissent && r.grounded === "all", "cross-family agreement"); }
{ const r = tally([V("anthropic/claude-haiku-5.5", "3"), V("anthropic/claude-sonnet-5.5", "3")], spec, false); t(r.agree === "same", "same-family agreement"); }
{ const r = tally([V("anthropic/claude-haiku-5.5", "Nov 24, 2025"), V("google/gemini-3.8-flash", "2025-11-24")], spec, false); t(r.answer === "2025-11-24" && r.agree === "cross" && !r.dissent, "display and ISO dates agree after normalisation"); }
{ const r = tally([V("anthropic/claude-haiku-5.5", "3"), V("google/gemini-3.8-flash", "4")], spec, false); t(r.dissent && r.agree === "single", "dissent"); }
{ const r = tally([V("anthropic/claude-haiku-5.5", "3"), V("google/gemini-3.8-flash", null)], spec, false); t(r.answer === "3" && r.agree === "single" && !r.dissent, "an abstention is not dissent"); }
{ const r = tally([V("anthropic/claude-haiku-5.5", "3", true, false), V("google/gemini-3.8-flash", "3")], spec, false); t(r.applyVeto, "applies=false is a veto"); }
{ const r = tally([V("anthropic/claude-haiku-5.5", "Yes"), V("google/gemini-3.8-flash", "Yes")], spec, false); t(r.answer === null, "yes/no never tallied"); }
const base: Signals = { votes: 2, agree: "cross", dissent: false, det: "none", grounded: "all", proof: "page", example: "na", kind: "text", memo: false, form: "plain", gatherIssues: 0, stripped: 0 };
const p = (s: Partial<Signals>) => estimate({ ...base, ...s }).p;
t(p({}) > 0.9, `cross + grounded + page proof ≥ 0.9 (got ${p({})})`);
t(p({ det: "agree" }) > p({}), "deterministic agreement raises");
t(p({ agree: "single" }) < p({}), "single vote lowers");
t(p({ agree: "single", grounded: "none" }) < 0.5, `single ungrounded < 0.5 (got ${p({ agree: "single", grounded: "none" })})`);
t(p({ dissent: true, agree: "single" }) < 0.4, `dissent < 0.4 (got ${p({ dissent: true, agree: "single" })})`);
t(p({ kind: "int" }) < p({ kind: "text" }), "a count is riskier than a text copy");
t(p({ kind: "int" }) < 0.8 && p({ kind: "int", det: "agree" }) >= 0.9 && p({ kind: "int", memo: true }) >= 0.9, `a plain count needs a memo or a deterministic agreement (got ${p({ kind: "int" })})`);
t(p({ proof: "unread" }) < p({ proof: "page" }), "an unread list lowers");
t(estimate({ ...base, det: "differ" }).p < 0.01 && estimate({ ...base, example: "fail" }).p < 0.01, "differ / example fail are vetoes (p ≈ 0)");
t(estimate({ ...base, agree: "single", grounded: "none", kind: "int" }).weakest.startsWith("grounded"), "weakest signal named");

// ── 4b. memo forms
import { memoFormOk } from "./bestEffort.js";
import { parseWorkflowSpec } from "./workflowExec.js";
{ const m = parseWorkflowSpec("From compliance: who created a patient record\n\nUse the Activity tab. Answer with that user's username exactly as shown, for example `framirez`. If the Activity tab shows no such entry, answer `UNKNOWN`.\n\n## Example\n\nIf someone asks: \"Who created the chart for Hale, Rita (DOB 05/28/1950)?\"\n\nThe answer is `framirez`.")!;
  t(memoFormOk("ljones", m) === "loose" || memoFormOk("ljones", m) === "bare", "a lowercase username passes the memo's example form");
  t(memoFormOk("NOT_A_TOKEN", m) === null, "an unknown token never passes");
  t(memoFormOk("2025-11-24", m) === null, "a date does not pass a username memo"); }

// ── 4c. mixed identifiers
import { mixedId } from "./bestEffort.js";
{ const lab = parseWorkflowSpec("From the lab: triage\n\nAnswer `RELEASE`, `NURSE_REVIEW:<count>` or `CALL_PROVIDER_NOW:<tests>`.\n\nIf someone asks: \"What happens to the CBC for Ann Lee (born 1970-01-01), received 2026-01-01?\"\n\nThe answer is `NURSE_REVIEW:1`.")!;
  t(mixedId("HZD392530760") && mixedId("YER335741605", lab), "member IDs are mixed identifiers, with or without a memo");
  t(!mixedId("NURSE_REVIEW:3", lab) && !mixedId("2026-12-15") && !mixedId("42018903") && !mixedId("Late cancel"), "memo tokens, dates, numbers and words are not"); }

// ── 5. proof of the gathered lists
const G = (pages: Array<[string, string, string?]>): any => ({ pages: pages.map(([name, text, proof]) => ({ name, text, proof })), inputs: {}, steps: [], ms: {}, stripped: 0 });
t(proofOf(G([["Chart of X (demographics)", "Name X"]])) === "nolist", "no list → nolist");
t(proofOf(G([["Chart of X — invoice list (3 rows; …)", "Invoice | Total\n1 | 2", "pager walked [page]"]])) === "page", "page proof");
t(proofOf(G([["Chart of X — invoice list (3 rows)", "Invoice | Total", "about N [model]"]])) === "model", "model proof");
t(proofOf(G([["Chart of X — invoice list", "(not read: budget spent)"]])) === "unread", "unread list");

console.log(`${n - fails}/${n} checks passed`);
if (fails) { console.log("FAIL"); process.exit(1); } else console.log("ALL PASS");
