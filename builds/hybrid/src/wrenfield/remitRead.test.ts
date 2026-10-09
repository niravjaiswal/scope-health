/**
 * Scanned paper remittance reader (remitRead.ts) on the REAL Set 1 scan (run 164, EFT514458381, Murphy,
 * Samantha, DOS 2026-03-16) and the real claim pages whose current remittance was scanned.
 *   npx tsx src/wrenfield/remitRead.test.ts
 *
 * Hand reading of fixtures/set1/scan/eob-EFT514458381.png (State Family Assistance, paid 04/23/2026,
 * total 278.88, one claim 59329159, billed 465.00 paid 278.88):
 *   1  99214 mod 25  200.00  CO-45 36.56   paid 163.44
 *   2  20610         145.00  CO-45 29.56   paid 115.44
 *   3  20605 mod 59  120.00  CO-97 120.00  paid   0.00     legend: CO, 45, 97; no remark codes
 * Worked (message 120): denied by 97 only → denied amount 120.00. NCCI row 20610/20605 indicator 1, 20610
 * billed on the same claim, 20605 billed with modifier 59 → grounds. Appeal window: State Family Assistance
 * contract 120 days (claim_contract, runs 162/164) from 2026-04-23 → 2026-08-21 < today 2026-10-14 →
 * WRITE_OFF:120.00. (With 180 days it would be APPEAL:2026-10-20.)
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { readRemit, parseRemitText, docOfModel, fieldsOf, agree, linesFrom, centsOf, adjCode, tesseractRemit, type RDoc, type RemitExpect } from "./remitRead.js";
import { claimPageOf, parseClaimPage } from "./claimReader.js";
import { decideClaim, declineBeforeLines, parseClaimPolicy, currentRemittance, type ClaimContext, type ClaimPolicy } from "./claimNextStep.js";
import { isDecline } from "./familyReaders.js";
import { msg, dom, claimDoc, PLANS } from "./claimFixtures.js";

let passes = 0, fails = 0;
const ok = (c: unknown, m: string) => { if (c) passes++; else { fails++; console.error("✗ " + m); } };
const eq = (got: unknown, want: unknown, m: string) => ok(JSON.stringify(got) === JSON.stringify(want), `${m}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const here = (p: string) => new URL(p, import.meta.url);
const PNG = readFileSync(here("../../fixtures/set1/scan/eob-EFT514458381.png")).toString("base64");
const MODELS = JSON.parse(readFileSync(here("../../fixtures/set1/scan/eob-EFT514458381.models.json"), "utf8")) as Record<string, unknown>;
const H55 = docOfModel(MODELS["anthropic/claude-haiku-5.5"])!, GEM = docOfModel(MODELS["google/gemini-3.8-flash"])!, H45 = docOfModel(MODELS["anthropic/claude-haiku-4.5"])!;
const clone = (d: RDoc): RDoc => JSON.parse(JSON.stringify(d));
const BILLED = [{ line: 1, procedure: "99214", modifiers: ["25"] }, { line: 2, procedure: "20610", modifiers: [] }, { line: 3, procedure: "20605", modifiers: ["59"] }];
const EX: RemitExpect = { trace: "EFT514458381", paymentDateISO: "2026-04-23", dosISO: "2026-03-16", claimNo: null, billedLines: BILLED, totalCents: 27888 };
const TRUTH = [
  { line: 1, procedure: "99214", modifiers: ["25"], adjustments: [{ group: "CO", reason: 45, cents: 3656 }], remarks: [], billedCents: 20000, paidCents: 16344 },
  { line: 2, procedure: "20610", modifiers: [], adjustments: [{ group: "CO", reason: 45, cents: 2956 }], remarks: [], billedCents: 14500, paidCents: 11544 },
  { line: 3, procedure: "20605", modifiers: ["59"], adjustments: [{ group: "CO", reason: 97, cents: 12000 }], remarks: [], billedCents: 12000, paidCents: 0 },
];

console.log("── normalisation");
eq(["200.00", "11544", "29,56", "0.00", "$1,250.50", "36", "12.5", "1,250"].map(centsOf), ["20000", "11544", "2956", "0", "125050", undefined, undefined, undefined], "centsOf");
eq(["CO-45", "CO97", "co - 45", "PR-1", "C0-45", "XX-45"].map(adjCode), ["CO-45", "CO-97", "CO-45", "PR-1", undefined, undefined], "adjCode");

console.log("── the three models on the real scan (recorded responses)");
for (const [n, d] of [["haiku-5.5", H55], ["gemini-3.8-flash", GEM], ["haiku-4.5", H45]] as const) {
  const l = linesFrom(fieldsOf(d, EX.dosISO), EX);
  eq(l, TRUTH, `${n} alone reads the hand truth`);
}

const hasTess = (() => { try { execFileSync(process.env.TESSERACT_PATH ?? "tesseract", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const tessOf = async () => (hasTess ? tesseractRemit(PNG) : null);
const fixedModel = (by: Record<string, RDoc | null>) => async (_png: string, model: string) => (by[model] === undefined ? by["*"] ?? null : by[model]) ? { doc: (by[model] === undefined ? by["*"] : by[model])!, ms: 1 } : null;
const M1 = "anthropic/claude-haiku-5.5", TB = "google/gemini-3.8-flash"; // tier when haiku-5.5 is listed
process.env.AGENT_LAB_MODEL = M1; process.env.AGENT_LAB_TIEBREAK = TB;

const main = async () => {
  if (hasTess) {
    console.log("── tesseract on the real scan: never a wrong agreed field");
    const t = await tesseractRemit(PNG);
    ok(t, "tesseract read");
    const tf = fieldsOf(t!.doc, EX.dosISO), hf = fieldsOf(H55, EX.dosISO);
    const wrong = Object.keys(tf).filter((k) => hf[k] !== undefined && tf[k] !== hf[k]);
    // tesseract versions differ (macOS 5.x vs the image's): its misreads only ever open fields for the tiebreak
    console.log(`   tesseract fields differing from the truth (left to the tiebreak): ${wrong.join(", ") || "none"}`);
    ok(tf.payDate === "2026-04-23" && tf["claim.billed"] === "46500", "tesseract reads the header");
  } else console.log("   (tesseract not installed: tesseract checks skipped)");

  console.log("── full pipeline: tesseract ∥ haiku-5.5, gemini tiebreak");
  {
    const r = await readRemit(PNG, EX, { tess: tessOf, model: fixedModel({ [M1]: H55, [TB]: GEM }) });
    eq(r.lines, TRUTH, "agreed read = hand truth");
    ok(r.trace.unknown.length === 0, "nothing left open");
  }
  {
    // the primary model misreads line 2's paid, the tiebreak reads it right: tesseract has no line 2 → open → decline
    const bad = clone(H55); bad.blocks![0].lines[1]!.paid = "11554"; bad.blocks![0].lines[1]!.adj[0].cents = "2946";
    const r = await readRemit(PNG, EX, { tess: tessOf, model: fixedModel({ [M1]: bad, [TB]: GEM }) });
    ok(typeof r.lines === "string" && /no agreed read/.test(r.lines), "a field only one model reads (tesseract silent) → decline: " + JSON.stringify(r.lines));
  }
  {
    // primary misreads line 1 amount; tesseract + tiebreak agree on the truth → kept
    const bad = clone(H55); bad.blocks![0].lines[0]!.adj[0].cents = "3665"; bad.blocks![0].lines[0]!.paid = "16335";
    const r = await readRemit(PNG, EX, { tess: tessOf, model: fixedModel({ [M1]: bad, [TB]: GEM }) });
    if (hasTess) eq(r.lines, TRUTH, "primary misread fixed by tesseract = tiebreak");
  }
  {
    const r = await readRemit(PNG, EX, { tess: tessOf, model: fixedModel({ [M1]: null, [TB]: null }) });
    ok(typeof r.lines === "string", "both models down → decline");
  }
  {
    // speculative tiebreak: it starts WITH the primary (wall time = the slower model, not the sum), and the agreed fields are
    // exactly the sequential ones (REMIT_TB_PARALLEL=0). A slow fake model (150 ms) makes the order observable.
    const t0 = Date.now(); const started: Record<string, number> = {};
    const slow = async (_png: string, model: string) => { started[model] = Date.now() - t0; await new Promise((r) => setTimeout(r, 150)); return { doc: model === M1 ? H55 : GEM, ms: 150 }; };
    // tesseract absent/blank on purpose: every field is open, so the tiebreak is consulted for all of them
    const blank = async () => ({ doc: { blocks: null } as RDoc, ms: 1 });
    const par = await readRemit(PNG, EX, { tess: blank, model: slow }); const tPar = Date.now() - t0;
    ok(started[TB] !== undefined && started[TB] < 100, `tiebreak starts with the primary (${started[TB]} ms)`);
    ok(tPar < 290, `wall time is the slower model, not the sum (${tPar} ms)`);
    process.env.REMIT_TB_PARALLEL = "0";
    const t1 = Date.now(); for (const k of Object.keys(started)) delete started[k];
    const seq = await readRemit(PNG, EX, { tess: blank, model: async (p, m) => { started[m] = Date.now() - t1; return slow(p, m); } });
    delete process.env.REMIT_TB_PARALLEL;
    ok(started[TB] >= 140, `REMIT_TB_PARALLEL=0 starts the tiebreak after the primary (${started[TB]} ms)`);
    eq(par.lines, seq.lines, "parallel and sequential tiebreak agree on the same lines");
    eq(par.trace.unknown, seq.trace.unknown, "same open fields");
  }
  {
    // two models agree on a remark code no-one printed and the legend lacks it → legend check declines
    const a = clone(H55), b = clone(GEM); a.blocks![0].lines[2]!.rem = ["N290"]; b.blocks![0].lines[2]!.rem = ["N290"];
    const f = agree(fieldsOf(a, EX.dosISO), fieldsOf(b, EX.dosISO), null);
    eq(f.open, [], "agreed");
    ok(typeof linesFrom(f.out, EX) === "string", "remark code not in the advice's legend → decline");
  }

  console.log("── keyed-page cross-checks");
  const F = agree(fieldsOf(H55, EX.dosISO), fieldsOf(GEM, EX.dosISO), null).out;
  ok(typeof linesFrom(F, { ...EX, trace: "EFT514458318" }) === "string", "another trace → decline");
  ok(typeof linesFrom(F, { ...EX, paymentDateISO: "2026-04-24" }) === "string", "another payment date → decline");
  ok(typeof linesFrom(F, { ...EX, totalCents: 27889 }) === "string", "remittance page total differs → decline");
  ok(typeof linesFrom(F, { ...EX, billedLines: BILLED.slice(0, 2) }) === "string", "claim has 2 lines, scan 3 → decline");
  ok(typeof linesFrom(F, { ...EX, billedLines: [BILLED[0], BILLED[1], { line: 3, procedure: "20605", modifiers: [] }] }) === "string", "modifier differs from the billed line → decline");
  ok(typeof linesFrom(F, { ...EX, claimNo: "59329158" }) === "string", "another claim number → decline");
  eq(fieldsOf(H55, "2026-03-17")["claim.n"], undefined, "no block on the asked date → no claim fields");
  { const x = { ...F, "L2.paid": "11545" }; ok(typeof linesFrom(x, EX) === "string", "a line that does not balance → decline"); }
  { const x = { ...F, "claim.paid": "27887" }; ok(typeof linesFrom(x, EX) === "string", "claim paid ≠ sum of lines → decline"); }
  { const x = { ...F, legend: "CO|45,97,16|" }; ok(typeof linesFrom(x, EX) === "string", "one-claim advice whose legend lists an unused code → decline"); }

  console.log("── tesseract text parser");
  {
    const d = parseRemitText("Payment date 04/23/2026\nTrace number EFT1\nClaim 1234 Service 03/16/2026 Rendering provider X Billed 465.00 Paid 278.88\n1 03/16/2026 99214 25 1 200.00 163.44 CO-45 36 56 163.44\n2 03/16/2026 20610 1 145.00 115.44 CO-45 29.56 PR-2 10.00 N290 105.44\nTotal paid 278.88\nAdjustment and remark codes on this advice\nCO Contractual\nPR Patient\n2 Coinsurance\n45 Charge\nN290 Missing\nState Family Assistance. This advice explains");
    eq(d.blocks![0].lines.map((l) => l && [l.mods, l.adj, l.rem, l.paid]), [[["25"], [{ code: "CO-45", cents: "3656" }], [], "16344"], [[], [{ code: "CO-45", cents: "2956" }, { code: "PR-2", cents: "1000" }], ["N290"], "10544"]], "rows with a split decimal, two adjustments and a remark");
    eq(d.legend, "CO,PR|2,45|N290", "legend");
  }

  console.log("── engine on the read lines (claim page in the real Set 1 markup)");
  const P = parseClaimPolicy(msg(120), []) as ClaimPolicy;
  const doc = claimDoc({ dos: "Mar 16, 2026", payer: "State Family Assistance", service: [{ proc: "99214", mod: "25" }, { proc: "20610" }, { proc: "20605", mod: "59" }], rems: [{ trace: "EFT514458381", date: "Apr 23, 2026", type: "Payment", scanned: true }], auths: [], notes: [] });
  const f = parseClaimPage(claimPageOf(doc), { Scr: "identity" }, "2026-03-16");
  ok(!isDecline(f), "synthetic scanned claim page parses: " + JSON.stringify((f as any).decline));
  if (!isDecline(f)) {
    const cr = currentRemittance(f.remittances);
    ok(!("decline" in cr) && cr.cur?.scanned, "current remittance is the scanned one");
    const ctx = (days: number): ClaimContext => ({ serviceDateISO: "2026-03-16", payer: f.payer, plan: f.plan, contract: { appealDays: days, filingDays: 180 }, remittances: f.remittances, billedLines: f.billedLines, submissions: f.submissions, authorizations: f.authorizations, notes: f.notes, knownPlans: PLANS, mergedRecord: false });
    const d0 = decideClaim(ctx(120), P); ok("decline" in d0, "unread scan still declines in the engine");
    const lines = linesFrom(F, { ...EX, billedLines: f.billedLines });
    eq(lines, TRUTH, "lines match the claim's billed lines");
    if (!("decline" in cr) && cr.cur && typeof lines !== "string") { cr.cur.lines = lines; cr.cur.scanned = false; }
    eq(decideClaim(ctx(120), P), { answer: "WRITE_OFF:120.00" }, "hand-worked Murphy answer (State Family Assistance, 120 days)");
    eq(decideClaim(ctx(180), P), { answer: "APPEAL:2026-10-20" }, "with 180 appeal days → appeal (NCCI grounds)");
  }

  console.log("── declines that need no lines (the scan is not read for them)");
  {
    const cur = { trace: "EFT514458381", paymentDateISO: "2026-04-23", kind: "payment" as const, reverses: null, scanned: true, lines: null };
    eq(declineBeforeLines("State Family Assistance", cur, "2026-03-16", P), null, "an ordinary scanned claim has no early decline");
    ok("decline" in (declineBeforeLines("State Family Assistance", { ...cur, paymentDateISO: "2026-03-01" }, "2026-03-16", P) ?? {}), "paid before the date of service → decline without reading");
    ok("decline" in (declineBeforeLines("State Family Assistance", cur, "2026-03-16", { ...P, co45: false }) ?? {}), "no CO-45 statement → decline without reading");
    ok("decline" in (declineBeforeLines("State Family Assistance", cur, "2026-03-16", { ...P, blocks: [{ payer: "state family assistance", why: "a later message blocks this payer" }] }) ?? {}), "payer blocked by a later message → decline without reading");
    eq(declineBeforeLines("Another Payer", cur, "2026-03-16", { ...P, blocks: [{ payer: "State Family Assistance", why: "x" }] }), null, "another payer is not blocked");
  }

  console.log("── the real Set 1 claim pages whose current remittance was scanned");
  for (const [tr, dos] of [["EFT650915886", "2026-07-06"], ["EFT258624683", "2026-08-28"]] as const) {
    const html = readFileSync(here(`../../fixtures/set1/scan/claim-${tr}.html`), "utf8");
    const p = claimPageOf(dom(html));
    const iso = dos;
    const fam: Record<string, "identity"> = Object.fromEntries(p.families.map((x) => [x, "identity"]));
    const g = parseClaimPage(p, fam, iso);
    ok(!isDecline(g), `${tr} page parses: ${JSON.stringify((g as any).decline)}`);
    if (!isDecline(g)) { const c = currentRemittance(g.remittances); ok(!("decline" in c) && c.cur?.trace === tr && c.cur.scanned && g.scanned.some((s) => s.trace === tr && s.href), `${tr} is the scanned current remittance with a remittance link`); }
  }
  {
    const rp = claimPageOf(dom(readFileSync(here("../../fixtures/set1/scan/remit-EFT514458381.html"), "utf8")));
    eq(rp.h1, "Remittance EFT514458381", "remittance page h1");
    ok(/view (the )?scanned document/i.test(rp.text) && /\b1 page\b/.test(rp.text), "remittance page shows the viewer (1 page)");
  }

  console.log(`remitRead: ${passes} passed, ${fails} failed`);
  if (fails) process.exit(1);
};
main();
