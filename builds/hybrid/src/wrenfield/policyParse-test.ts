/**
 * Per-field policy parsing: a reworded governing message parses to the same fields, a field the message
 * does not state clearly declines ONLY the answers that need it, and a changed value is never read as
 * the old one.   npx tsx src/wrenfield/policyParse-test.ts   (in gates.sh)
 */
import { readFileSync } from "node:fs";
import { MessageStore, type ClinicIndex } from "./inference.js";
import { solveFamily } from "./solvers.js";
import { takeWhy, resetWhy } from "./why.js";
import { parsePolicy, canon, POLICY_FIELDS, tracked, messageFamily } from "./policyParse.js";
import { decideClaim, parseClaimFields, type ClaimContext, type ClaimPolicy, type Remittance } from "./claimNextStep.js";
import { tablesIn, todayIn, headingsIn } from "./policyText.js";

let pass = 0, fail = 0;
const ok = (c: unknown, m: string) => { if (c) pass++; else { fail++; console.error("✗ " + m); } };
const eq = (a: unknown, b: unknown, m: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

const items = readFileSync(new URL("../../fixtures/set1-items.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { kind: string; text: string });
const wf = (fam: string) => items.find((i) => i.kind === "message" && messageFamily(i.text) === fam)!.text;
const FILING = wf("filing-deadline"), GFE = wf("good-faith-estimate"), CLAIM = wf("claim-next-step"), TET = wf("tetanus-wound"), RECALL = wf("vaccine-lot-recall"), LAB = wf("lab-report-triage");

// ── helpers ──
ok(todayIn("Today is 2026-10-14. Later: today is 2026-10-14.") === "2026-10-14", "today: repeated statements agree");
ok(todayIn("The current date is October 14, 2026.") === "2026-10-14", "today: reworded, written date");
ok(todayIn("Today is 2026-10-14. ... today is 2026-10-15.") === null, "today: disagreeing statements → null");
ok(todayIn("No date here.") === undefined, "today: none → undefined");
{ const t = tablesIn("- Reason: 1; Meaning: Deductible.\n- Reason: 2; Meaning: Coinsurance.\n"); eq(t[0]?.headers, ["Reason", "Meaning"], "bullet rows read as a table"); eq(t[0]?.rows.length, 2, "bullet table rows"); }
ok(tablesIn("- One: a; Two: b\n- Other: c; Keys: d\n").length === 0, "bullets with different keys are not one table");
eq(headingsIn("intro\n**Bold head**\nbody\n## Hash head\nmore").map((s) => s.heading), ["", "Bold head", "Hash head"], "headings in any form");

// ── a store holding the given messages (raw text is what the family solvers read) ──
async function storeOf(...raws: string[]) { const st = new MessageStore(async (raw, order) => ({ id: `m${order}`, order, raw, kind: "noise", scope: [], active: true })); for (const r of raws) await st.ingest(r); return st; }
async function solve(family: string, slots: Record<string, string>, index: Partial<ClinicIndex>, ...raws: string[]) {
  resetWhy(); const st = await storeOf(...raws);
  const v = await solveFamily({ family, slots }, { findPatient: () => null, appointments: [], providers: new Map(), byDate: () => [], ...index } as ClinicIndex, st);
  return { v, why: v == null ? takeWhy() : "" };
}

// ── filing: a field miss declines only the answers needing it ──
{
  const terms = [{ effectiveISO: "2024-01-01", originalDays: 365, secondaryDays: 90, correctedDays: 180 }];
  const ctx = (o: object = {}) => ({ filingContext: async () => ({ todayISO: "", type: "Original" as const, serviceDateISO: "2026-05-07", primaryRemitISO: null, originalRemitISO: null, termsSets: terms, payer: "Union Workers Health Fund", ...o }) });
  const slots = { name: "Davis, Andrea", dos: "2026-05-07" };
  eq((await solve("filing-deadline", slots, ctx(), FILING)).v, "2027-05-07", "filing: the message's worked example");
  const noHol = FILING.replace(/We only file on days[\s\S]*?which aren't the same\.\n/, "");
  ok(noHol !== FILING, "fixture: holiday paragraph removed");
  const r1 = await solve("filing-deadline", slots, ctx(), noHol);
  ok(r1.v === null && /office closures/.test(r1.why), "filing: no closures → a date answer declines (" + r1.why.slice(0, 80) + ")");
  eq((await solve("filing-deadline", slots, ctx({ termsSets: [{ effectiveISO: "2027-01-01", originalDays: 365 }] }), noHol)).v, "NO_FILING_TERMS", "filing: no closures → NO_FILING_TERMS still answered");
  eq((await solve("filing-deadline", slots, ctx({ type: "Secondary" }), noHol)).v, "AWAITING_PRIMARY", "filing: no closures → AWAITING_PRIMARY still answered");
  const noToday = FILING.replace(/Today is 2026-10-14[.,]\s*/g, "");
  ok((await solve("filing-deadline", slots, ctx(), noToday)).v === null, "filing: no 'today' → a date answer declines");
  eq((await solve("filing-deadline", slots, ctx({ type: "Secondary" }), noToday)).v, "AWAITING_PRIMARY", "filing: no 'today' → AWAITING_PRIMARY still answered");
  const later = FILING.replace("the nearest earlier day it's open. It never moves later.", "the next day it's open. It never moves earlier.");
  ok((await solve("filing-deadline", slots, ctx(), later)).v === null, "filing: a closed last day that moves LATER → a date answer declines");
  const bold = FILING.replace(/^##\s+(.+)$/gm, "**$1**");
  eq((await solve("filing-deadline", slots, ctx(), bold)).v, "2027-05-07", "filing: bold headings → same answer (closures from the holiday paragraph only)");
  eq(parsePolicy("filing-deadline", bold).fields.closedISO, parsePolicy("filing-deadline", FILING).fields.closedISO, "filing: bold headings → the same closures, not every date in the message");
  const reworded = FILING.replace(/Today is 2026-10-14/g, "The current date is October 14, 2026").replace("It's closed Saturdays, Sundays, and these holidays:", "It is closed on weekends and on these holidays:");
  eq((await solve("filing-deadline", slots, ctx(), reworded)).v, "2027-05-07", "filing: reworded today + closures sentence → same answer");
}

// ── good faith: INSURED needs only its token ──
{
  const slots = { name: "Williams, Ann", date: "2026-03-05", time: "11:00" };
  const idx = (owed: boolean) => ({ goodFaithContext: async () => ({ owedEstimate: owed, schedulingDateISO: "2026-03-02", apptDateISO: "2026-03-05", closuresISO: [] }) });
  eq((await solve("good-faith-estimate", slots, idx(true), GFE)).v, "2026-03-03", "gfe: 3 business days → first business day after booking");
  const noBands = GFE.replace(/- 0 to 2 business days[^\n]*\n- 3 to 9[^\n]*\n- 10 or more[^\n]*\n/, "");
  ok(noBands !== GFE, "fixture: bands removed");
  eq((await solve("good-faith-estimate", slots, idx(false), noBands)).v, "NOT_REQUIRED:INSURED", "gfe: no bands → INSURED still answered");
  const r = await solve("good-faith-estimate", slots, idx(true), noBands);
  ok(r.v === null && /bands/.test(r.why), "gfe: no bands → a due date declines (never the built-in bands)");
}

// ── claim: the engine's reads decide which missing fields matter ──
{
  const ctx = (rems: Remittance[]): ClaimContext => ({ serviceDateISO: "2026-07-06", payer: "Tallgrass Health Plan", contract: { appealDays: 120, filingDays: 90 }, remittances: rems, billedLines: [{ line: 1, procedure: "99213", modifiers: ["59"] }], submissions: [], authorizations: [], notes: [] });
  const paid: Remittance = { trace: "CHK1", paymentDateISO: "2026-08-17", kind: "payment", reverses: null, scanned: false, lines: [{ line: 1, procedure: "99213", modifiers: [], adjustments: [{ group: "CO", reason: 45, cents: 1000 }, { group: "PR", reason: 2, cents: 2500 }], remarks: [], billedCents: 10000, paidCents: 6500 }] };
  const bundled: Remittance = { ...paid, lines: [{ line: 1, procedure: "99213", modifiers: ["59"], adjustments: [{ group: "CO", reason: 97, cents: 10000 }], remarks: [], billedCents: 10000, paidCents: 0 }] };
  const noNcci = CLAIM.replace(/\| Column 1 code[\s\S]*?\| 17110 \| 11200 \| 0 \|\n/, "");
  ok(noNcci !== CLAIM, "fixture: NCCI table removed");
  const { fields, why } = parseClaimFields(noNcci); const miss = parsePolicy("claim-next-step", noNcci).missing;
  ok(miss.includes("ncci") && !miss.includes("priority"), "claim: only the NCCI field is missing (" + why.join("; ") + ")");
  const run = (c: ClaimContext) => { const t = tracked(fields as ClaimPolicy, miss); let v: ReturnType<typeof decideClaim>; try { v = decideClaim(c, t.p); } catch { v = { decline: "threw" }; } return t.touched().length ? "DECLINE:" + t.touched().join(",") : "answer" in v ? v.answer : "decline " + v.decline; };
  eq(run(ctx([])), "AWAIT_PAYER", "claim: no remittance → AWAIT_PAYER without the NCCI table");
  eq(run(ctx([paid])), "BILL_PATIENT:25.00", "claim: paid line → BILL_PATIENT without the NCCI table");
  eq(run(ctx([bundled])), "DECLINE:ncci", "claim: a reason-97 denial reads the NCCI table → declines");
  const reworded = CLAIM.replace(/Today is 2026-10-14/g, "The current date is 2026-10-14").replace(/^##\s+(.+)$/gm, "### $1");
  const a = parsePolicy("claim-next-step", CLAIM), b = parsePolicy("claim-next-step", reworded);
  ok(!b.missing.length && POLICY_FIELDS["claim-next-step"].every((k) => canon(a.fields[k]) === canon(b.fields[k])), "claim: reworded message → the same fields");
}

// ── tetanus: NO_WOUND_VISIT needs only the tokens; a dose decision needs the tables ──
{
  const slots = { name: "Lewis, Kathryn", visit: "2025-02-08" };
  const noDecision = TET.replace(/\| Documented tetanus doses before the visit[\s\S]*?otherwise `NONE` \|\n/, "");
  ok(noDecision !== TET, "fixture: decision table removed");
  const idx = (wound: boolean) => ({ tetanusContext: async () => ({ visitDateISO: "2025-02-08", woundVisit: wound, woundClass: "other" as const, doseDatesISO: ["1999-02-24", "2013-01-14"] }) });
  eq((await solve("tetanus-wound", slots, idx(false), noDecision)).v, "NO_WOUND_VISIT", "tetanus: no decision table → NO_WOUND_VISIT still answered");
  const r = await solve("tetanus-wound", slots, idx(true), noDecision);
  ok(r.v === null && /lowMax|cleanYears|otherYears/.test(r.why), "tetanus: no decision table → a dose decision declines (" + r.why.slice(0, 80) + ")");
  eq((await solve("tetanus-wound", slots, idx(true), TET)).v, "VACCINE_AND_TIG:2:2013-01-14", "tetanus: full rule decides");
}

// ── recall: UNKNOWN_LOT needs only its token ──
{
  const noRules = RECALL.replace(/\bwhole number\b/g, "integer");
  const idx = (v: string) => ({ recallLeft: async (_: string, p: { unknownToken: string }) => (v === "UNKNOWN" ? p.unknownToken : v) });
  eq((await solve("vaccine-lot-recall", { lot: "M81X24L" }, idx("UNKNOWN"), noRules)).v, "UNKNOWN_LOT", "recall: counting rules unclear → UNKNOWN_LOT still answered");
  ok((await solve("vaccine-lot-recall", { lot: "M81X24L" }, idx("4"), noRules)).v === null, "recall: counting rules unclear → a count declines");
  eq((await solve("vaccine-lot-recall", { lot: "M81X24L" }, idx("4"), RECALL)).v, "4", "recall: full rule counts");
}

// ── lab: covered panels from any heading wording, one reader for compiler and engine ──
{
  const a = parsePolicy("lab-report-triage", LAB), b = parsePolicy("lab-report-triage", LAB.replace("## Panels this rule covers", "**Which panels are covered**"));
  eq(b.fields.covered, a.fields.covered, "lab: renamed bold heading → same covered list");
  const c = parsePolicy("lab-report-triage", LAB.replace("## Panels this rule covers\n\nComplete blood count, Basic metabolic panel, Thyroid panel. For a report of any other panel, answer `NOT_COVERED`.", "## Scope\n\nComplete blood count, Basic metabolic panel, Thyroid panel. For a report of any other panel, answer `NOT_COVERED`."));
  eq(c.fields.covered, a.fields.covered, "lab: covered list from the 'any other panel → NOT_COVERED' sentence");
  const d = parsePolicy("lab-report-triage", LAB.replace("Complete blood count, Basic metabolic panel, Thyroid panel. For", "Complete blood count, Lipid panel, Thyroid panel. For"));
  eq(d.fields.covered, ["Complete blood count", "Lipid panel", "Thyroid panel"], "lab: a different covered list is read, not the old one");
}

console.log(fail ? `✗ policyParse-test: ${pass} passed, ${fail} failed` : `✓ policyParse-test: ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
