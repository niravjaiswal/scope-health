/**
 * claim-next-step: engine (claimNextStep.ts) + reader (claimReader.ts) + routing (familySlots.looseClaim).
 *   npx tsx src/wrenfield/claimReader.test.ts
 *
 * (a) the rule parsed from the governing message (n=120) and the amendments (n=132, n=164);
 * (b) the captured García claim page (Baseline Set 1 dump), hand-worked;
 * (c) synthetic claims built FROM that real page (its markup, its remittance/table structure) for every
 *     branch of the rule — each denial reason, priority, reversals, no remittance, CO-45, notes,
 *     authorization bounds, NCCI indicator + modifier 59, appeal today vs passed, Northfield amendment,
 *     cents/thousands — with the working in comments;
 * (d) page variants (reordered/extra/renamed columns, empty panels, scrambled-font digits) → same
 *     answer or a decline, never a different answer;
 * (e) paraphrases (not Set 1 text) route here; hard negatives do not.
 */
import { claimPageOf, contractTerms, resetClaimCaches, parseClaimPage, parseContract, parseAdjustments, findClaim, type FamMaps, type PPage } from "./claimReader.js";
import { decideClaim, parseClaimPolicy, classifyNote, parseCents, fmtCents, ANSWER_RE, type ClaimContext, type ClaimPolicy } from "./claimNextStep.js";
import { familyMatch } from "./families.js";
import { isDecline } from "./familyReaders.js";
import { msg, CLAIM_HTML, dom, PLANS, claimDoc, paid, deny, SVC, A, span, contractDoc, type Claim, type Line } from "./claimFixtures.js";

let passes = 0, fails = 0;
const ok = (c: unknown, m: string) => { if (c) passes++; else { fails++; console.error("✗ " + m); } };
const eq = (got: unknown, want: unknown, m: string) => ok(JSON.stringify(got) === JSON.stringify(want), `${m}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const section = (s: string) => console.log("── " + s);


// ════════ (a) rule ════════
section("policy from the message");
const P0 = parseClaimPolicy(msg(120), []) as ClaimPolicy;
ok(!("decline" in P0), "message 120 parses: " + JSON.stringify((P0 as any).decline));
eq(P0.todayISO, "2026-10-14", "today from the message");
eq(P0.priority, [29, 22, 16, 197, 97], "priority from the message");
eq(P0.denialReasons, [16, 22, 29, 97, 197], "denial reasons from the message");
eq(P0.patientReasons, [1, 2, 3], "PR reasons from the message");
eq(P0.remarkFields.map(([c]) => c), ["N290", "N286", "N382", "M51", "M76", "M77"], "remark table order");
ok(P0.knownRemarks.has("MA130"), "MA130 known");
eq(P0.ncci.length, 5, "NCCI rows");
const P132 = parseClaimPolicy(msg(120), [msg(132)]) as ClaimPolicy;
eq(P132.appealNotes, [{ payer: "Northfield Life and Health", days: 180, inWrenfield: false }], "n=132 amendment parsed");
const P164 = parseClaimPolicy(msg(120), [msg(132), msg(150), msg(164), msg(176), msg(198)]) as ClaimPolicy;
eq([P164.appealNotes.length, P164.appealNotes.at(-1)!.inWrenfield, P164.blocks.length], [2, true, 0], "n=164 'in Wrenfield now'; filing / good-faith rules and the payments note are not blocks");
ok("decline" in parseClaimPolicy(msg(120).replace("comes first in this order: 29, 22, 16, 197, 97", "comes first in this order: 29, 22, 16"), []), "priority list that disagrees with the denial set → policy refused");
ok("decline" in parseClaimPolicy(msg(120).replace("can be appealed through 2026-11-07", "can be appealed through 2026-11-08"), []), "worked appeal example that disagrees with date arithmetic → refused");
const Pmod = parseClaimPolicy(msg(120).replace("comes first in this order: 29, 22, 16, 197, 97", "comes first in this order: 22, 29, 16, 197, 97"), []) as ClaimPolicy;
eq(Pmod.priority, [22, 29, 16, 197, 97], "a changed priority order is followed (rule from the message, not constants)");
const Pblock = parseClaimPolicy(msg(120), ["Tallgrass Health Plan now requires appeals to include the remittance."]) as ClaimPolicy;
eq(Pblock.blocks.length, 1, "an unparsed later appeal message is a block");

section("money and dates");
eq([parseCents("$1,250.50"), parseCents("12.44"), parseCents("-$156.64"), parseCents("$0.01"), parseCents("1,25.00"), parseCents("$12.345")], [125050, 1244, -15664, 1, null, null], "parseCents");
eq([fmtCents(3412), fmtCents(125050), fmtCents(1), fmtCents(19000)], ["34.12", "1250.50", "0.01", "190.00"], "fmtCents");
eq(parseAdjustments("CO-45 $80.48\nPR-1 $12.44"), [{ group: "CO", reason: 45, cents: 8048 }, { group: "PR", reason: 1, cents: 1244 }], "multi-line adjustments cell");
eq(parseAdjustments("CO 45 80.48"), null, "adjustment without the dash → not understood");

// ════════ (b) the captured claim page ════════
section("captured García claim (claim 50422806 decoded / 70988502 raw)");
const FM_ID: FamMaps = { Scr: "identity" };
const CONTRACT = { appealDays: 120, filingDays: 90 };
const run = (d: Document, fm: FamMaps, dos: string, pol: ClaimPolicy = P0, extra: Partial<ClaimContext> = {}) => {
  const p = claimPageOf(d);
  const f = parseClaimPage(p, fm, dos);
  if (isDecline(f)) return "DECLINE " + f.decline;
  const ctx: ClaimContext = { serviceDateISO: dos, payer: f.payer, plan: f.plan, contract: CONTRACT, remittances: f.remittances, billedLines: f.billedLines, submissions: f.submissions, authorizations: f.authorizations, notes: f.notes, knownPlans: PLANS, mergedRecord: f.merged, ...extra };
  const v = decideClaim(ctx, pol);
  if ("decline" in v) return "DECLINE " + v.decline;
  ok(ANSWER_RE.test(v.answer), "answer in the message's format: " + v.answer);
  return v.answer;
};
{
  const d = dom(CLAIM_HTML);
  const p = claimPageOf(d);
  eq(p.families, ["Scr"], "obfuscated spans are seen as one custom font family");
  const f = parseClaimPage(p, FM_ID, "2026-07-14");
  ok(!isDecline(f), "captured page parses: " + JSON.stringify((f as any).decline));
  if (!isDecline(f)) {
    eq([f.payer, f.plan, f.payerHref, f.patientHref], ["Senior Advantage of the Plains", "Senior Complete", "/claims/payers/0qnvc9fghg", "/patients/05nk5ht641"], "details");
    eq(f.billedLines.map((b) => b.procedure), ["99396", "36415", "85025"], "service lines (raw = real CPT codes: 99396 preventive 40-64, 36415 venipuncture, 85025 CBC)");
    eq(f.submissions, [{ result: "Accepted by payer", resultDateISO: "2026-07-19" }], "submission");
    eq(f.remittances.map((r) => [r.trace, r.paymentDateISO, r.kind, r.lines?.length]), [["EFT541736844", "2026-08-20", "payment", 3]], "one payment remittance with 3 lines");
    eq(f.remittances[0].lines!.map((l) => [l.procedure, l.adjustments.map((a) => `${a.group}-${a.reason} ${a.cents}`), l.billedCents, l.paidCents]),
      [["99396", ["CO-45 8048"], 23000, 14952], ["36415", ["CO-45 556", "PR-1 1244"], 1800, 0], ["85025", ["CO-45 1032", "PR-1 2168"], 3200, 0]], "lines");
    eq([f.authorizations, f.notes.length, f.notes[0].atISO, f.merged], [[], 1, "2026-07-20T16:27:00.000Z", false], "no authorizations; one account note");
  }
  // Working: current remittance = the only payment EFT541736844 (2026-08-20). No CO-16/22/29/97/197 on any
  // line (CO-45 only) → paid. PR-1 12.44 + PR-1 21.68 = 34.12 → BILL_PATIENT:34.12. Each line balances:
  // 230.00−80.48=149.52, 18.00−5.56−12.44=0.00, 32.00−10.32−21.68=0.00.
  eq(run(d, FM_ID, "2026-07-14"), "BILL_PATIENT:34.12", "García 2026-07-14 → BILL_PATIENT:34.12");
  ok(run(d, FM_ID, "2026-07-15").startsWith("DECLINE"), "page's service date ≠ asked date → decline");
  ok(run(d, {}, "2026-07-14").startsWith("DECLINE"), "digits in a font we cannot place → decline");
  // Baseline dump decoded these spans with a wrong map (CO-45→CO-38, DOB 1952→1486). Read that way, reason 38
  // is not in the message's table → decline, never an answer.
  const baseline: Record<string, string> = { "0": "0", "1": "1", "2": "6", "3": "7", "4": "3", "5": "8", "6": "9", "7": "5", "8": "2", "9": "4" };
  ok(run(d, { Scr: baseline }, "2026-07-14").startsWith("DECLINE"), "the dump's wrong digit map → unknown reason code → decline");
}
{
  // The same page drawn in a SCRAMBLED font: each obfuscated span's digits permuted by σ; the exact family map σ⁻¹ reads it back.
  const sigma: Record<string, string> = { "0": "3", "1": "7", "2": "0", "3": "9", "4": "1", "5": "8", "6": "2", "7": "5", "8": "6", "9": "4" };
  const inv: Record<string, string> = Object.fromEntries(Object.entries(sigma).map(([a, b]) => [b, a]));
  const d = dom(CLAIM_HTML);
  for (const s of d.querySelectorAll(".wvwjwgvc")) for (const n of [...s.childNodes]) if (n.nodeType === 3) n.nodeValue = n.nodeValue!.replace(/\d/g, (c) => sigma[c]);
  for (const g of d.querySelectorAll("[aria-label^='Remittance ']")) g.setAttribute("aria-label", g.getAttribute("aria-label")!.replace(/\d/g, (c) => sigma[c]));
  eq(run(d, { Scr: inv }, "2026-07-14"), "BILL_PATIENT:34.12", "scrambled font + exact map → same answer");
  ok(run(d, FM_ID, "2026-07-14").startsWith("DECLINE"), "scrambled font read as identity → unknown codes → decline");
}

// ════════ (c) synthetic claims built from the captured page ════════
section("synthetic claims from the captured markup");
const C = (c: Claim, pol: ClaimPolicy = P0, extra: Partial<ClaimContext> = {}) => run(claimDoc(c), FM_ID, c.dosISO ?? "2026-07-14", pol, extra);

// remittance currency / reversals
eq(C({ rems: [] }), "AWAIT_PAYER", "no remittance → AWAIT_PAYER");
eq(C({ rems: [paid("EFT1"), { trace: "EFT2", date: "Sep 1, 2026", type: "Reversal of EFT1", lines: [] }] }), "AWAIT_PAYER", "the only payment reversed → AWAIT_PAYER");
// Worked: EFT1 (Aug 20, paid, PR-2 20.00) is reversed by EFT2; the earlier CHK7 (Jul 23) is then the latest unreversed payment → its 197 denial.
eq(C({ service: SVC, rems: [deny(197, "$190.00", {}, "CHK7", "Jul 23, 2026"), paid("EFT1"), { trace: "EFT2", date: "Sep 1, 2026", type: "Reversal of EFT1", lines: [] }] }), "WRITE_OFF:190.00", "reversed later payment → earlier payment is current");
eq(C({ rems: [deny(197, "$190.00", {}, "CHK7", "Jul 23, 2026"), paid("EFT1")] }), "BILL_PATIENT:20.00", "earlier remittances play no part (latest payment wins)");
ok(C({ rems: [paid("EFT1"), { trace: "EFT2", date: "Sep 1, 2026", type: "Reversal", lines: [] }] }).startsWith("DECLINE"), "reversal naming no payment → decline");
ok(C({ rems: [paid("EFT1"), paid("EFT2")] }).startsWith("DECLINE"), "two unreversed payments on the latest date → decline");
ok(C({ rems: [{ trace: "CHK9", date: "Aug 20, 2026", type: "Payment", scanned: true }] }).startsWith("DECLINE"), "current remittance scanned (paper, not keyed) → decline");
eq(C({ rems: [{ trace: "CHK9", date: "Jul 30, 2026", type: "Payment", scanned: true }, paid("EFT1")] }), "BILL_PATIENT:20.00", "an earlier scanned remittance doesn't matter");

// paid
eq(C({ rems: [{ trace: "E1", date: "Aug 20, 2026", type: "Payment", lines: [{ proc: "99396", billed: "$230.00", adj: ["CO-45 $80.48"], paid: "$149.52" }] }] }), "NO_ACTION", "CO-45 only → NO_ACTION (CO-45 never counts)");
eq(C({ rems: [{ trace: "E1", date: "Aug 20, 2026", type: "Payment", lines: [{ proc: "99396", billed: "$2,500.00", adj: ["CO-45 $1,249.49", "PR-1 $1,000.00", "PR-3 $0.01"], paid: "$250.50" }] }] }), "BILL_PATIENT:1000.01", "thousands + cents: PR-1 1,000.00 + PR-3 0.01");
ok(C({ rems: [{ trace: "E1", date: "Aug 20, 2026", type: "Payment", lines: [{ proc: "99396", billed: "$230.00", adj: ["CO-38 $80.48"], paid: "$149.52" }] }] }).startsWith("DECLINE"), "reason code not in the message's table → decline");
ok(C({ rems: [{ trace: "E1", date: "Aug 20, 2026", type: "Payment", lines: [{ proc: "99396", billed: "$230.00", adj: ["CO-45 $80.00"], paid: "$149.52" }] }] }).startsWith("DECLINE"), "line that doesn't balance → decline");
ok(C({ rems: [{ trace: "E1", date: "Aug 20, 2026", type: "Payment", lines: [{ proc: "99396", billed: "$230.00", adj: ["OA-23 $80.48"], paid: "$149.52" }] }] }).startsWith("DECLINE"), "OA group → decline");

// reason 197 — worked example: paid 2026-08-17 + 120 days = 2026-12-15 ≥ today 2026-10-14 → appeal
eq(C({ service: SVC, rems: [deny(197, "$190.00")], auths: A("Jan 1, 2026", "Dec 31, 2026") }), "APPEAL:2026-12-15", "197 covered → APPEAL:2026-12-15 (the message's worked example)");
eq(C({ service: SVC, rems: [deny(197, "$190.00")], auths: A("Jul 14, 2026", "Jul 14, 2026") }), "APPEAL:2026-12-15", "197: first and last valid day both count");
eq(C({ service: SVC, rems: [deny(197, "$190.00")], auths: A("Jan 1, 2026", "Jul 13, 2026") }), "WRITE_OFF:190.00", "197: authorization ended the day before → write off");
eq(C({ service: SVC, rems: [deny(197, "$190.00")], auths: A("Jul 15, 2026", "Dec 31, 2026") }), "WRITE_OFF:190.00", "197: authorization starts the day after → write off");
eq(C({ service: SVC, rems: [deny(197, "$190.00")], auths: A("Jan 1, 2026", "Dec 31, 2026", "Tallgrass Health Plan") }), "WRITE_OFF:190.00", "197: another payer's authorization doesn't cover");
eq(C({ service: SVC, rems: [deny(197, "$190.00")], auths: A("Jan 1, 2026", "Dec 31, 2026", "Senior Advantage of the Plains", "20605") }), "WRITE_OFF:190.00", "197: another procedure's authorization doesn't cover");
ok(C({ service: SVC, rems: [deny(197, "$190.00")], auths: [] }, P0, { mergedRecord: true }).startsWith("DECLINE"), "197 uncovered but a merged duplicate record exists → decline (its authorizations count)");
// The real Set 1 authorizations table (Number | Payer | Service | Valid from | Valid through | Visits approved |
// Status) names a Service, not a code. Ported from baseline (): a Service equal to exactly one billed line's
// description maps to that line's code; an unmappable Service valid on the DOS declines instead of WRITE_OFF.
const SVCD = [{ proc: "99396", desc: "Preventive visit, established patient, age 40 to 64" }, { proc: "20610", desc: "Joint injection" }];
const AR = (service: string, from = "Jan 1, 2026", to = "Dec 31, 2026", status?: string, payer = "Senior Advantage of the Plains") => [{ payer, service, from, to, ...(status ? { status } : {}) }];
eq(C({ service: SVCD, rems: [deny(197, "$190.00")], authsReal: AR("Joint injection") }), "APPEAL:2026-12-15", "197 + real auth table: Service = the denied line's description → covered → APPEAL");
eq(C({ service: SVCD, rems: [deny(197, "$190.00")], authsReal: AR("joint  injection") }), "APPEAL:2026-12-15", "197 + real auth table: description match ignores case/spacing");
ok(C({ service: SVCD, rems: [deny(197, "$190.00")], authsReal: AR("Wound care") }).startsWith("DECLINE"), "197 + real auth table: Service matching no billed line, valid on the DOS → decline (not WRITE_OFF)");
eq(C({ service: SVCD, rems: [deny(197, "$190.00")], authsReal: AR("Wound care", "Jan 1, 2026", "Jun 30, 2026") }), "WRITE_OFF:190.00", "197 + real auth table: unmappable Service NOT valid on the DOS doesn't matter → write off");
ok(C({ service: SVCD, rems: [deny(197, "$190.00")], authsReal: AR("Joint injection", "Jan 1, 2026", "Dec 31, 2026", "Denied") }).startsWith("DECLINE"), "197 + real auth table: covering authorization with status Denied → decline");
eq(C({ service: SVCD, rems: [deny(197, "$190.00")], authsReal: AR("Preventive visit, established patient, age 40 to 64") }), "WRITE_OFF:190.00", "197 + real auth table: Service maps to another billed code → doesn't cover → write off");
// appeal window: today vs passed (today 2026-10-14; 120 days before is 2026-06-16)
eq(C({ dos: "Jun 1, 2026", dosISO: "2026-06-01", service: SVC, rems: [deny(197, "$190.00", {}, "C1", "Jun 16, 2026")], auths: A("Jan 1, 2026", "Dec 31, 2026") }), "APPEAL:2026-10-14", "last day to appeal is today → APPEAL");
eq(C({ dos: "Jun 1, 2026", dosISO: "2026-06-01", service: SVC, rems: [deny(197, "$190.00", {}, "C1", "Jun 15, 2026")], auths: A("Jan 1, 2026", "Dec 31, 2026") }), "WRITE_OFF:190.00", "last day to appeal was yesterday → WRITE_OFF");
// Northfield amendment: the note says 180 days, the site (contract) still says 120 → go by the note
const NF = "Northfield Life and Health";
eq(C({ payer: NF, service: SVC, rems: [deny(197, "$190.00")], auths: A("Jan 1, 2026", "Dec 31, 2026", NF) }, P132), "APPEAL:2027-02-13", "Northfield: note's 180 days override the site (2026-08-17 + 180 = 2027-02-13)");
eq(C({ payer: NF, service: SVC, rems: [deny(197, "$190.00")], auths: A("Jan 1, 2026", "Dec 31, 2026", NF) }, P0), "APPEAL:2026-12-15", "Northfield before the note → site's 120 days");
ok(C({ payer: NF, service: SVC, rems: [deny(197, "$190.00")], auths: A("Jan 1, 2026", "Dec 31, 2026", NF) }, P164).startsWith("DECLINE"), "'in Wrenfield now' but the contract still says 120 → decline");
eq(C({ payer: NF, service: SVC, rems: [deny(197, "$190.00")], auths: A("Jan 1, 2026", "Dec 31, 2026", NF) }, P164, { contract: { appealDays: 180, filingDays: 90 } }), "APPEAL:2027-02-13", "'in Wrenfield now' and the contract says 180 → 180");
eq(C({ service: SVC, rems: [deny(197, "$190.00")], auths: A("Jan 1, 2026", "Dec 31, 2026") }, P132), "APPEAL:2026-12-15", "Northfield's note doesn't touch other payers");
ok(C({ service: SVC, rems: [deny(197, "$190.00")], auths: A("Jan 1, 2026", "Dec 31, 2026") }, P0, { contract: { appealDays: null, filingDays: 90 } }).startsWith("DECLINE"), "no appeal window on the contract → decline");

// reason 29 — worked: DOS 2026-06-01 + 90 = 2026-08-30 last day to file
const R29 = (rdate: string, result = "Accepted by payer") => C({ dos: "Jun 1, 2026", dosISO: "2026-06-01", service: SVC, rems: [deny(29, "$120.00")], subs: [{ sent: "Aug 1, 2026", result, rdate }] });
eq(R29("Aug 30, 2026"), "APPEAL:2026-12-15", "29: accepted on the last day to file → proof → appeal");
eq(R29("Aug 31, 2026"), "WRITE_OFF:120.00", "29: accepted a day late → write off");
eq(R29("Jul 1, 2026", "Rejected by clearinghouse"), "WRITE_OFF:120.00", "29: clearinghouse rejection never counts");
ok(R29("Jul 1, 2026", "Accepted by clearinghouse").startsWith("DECLINE"), "29: 'accepted by clearinghouse' is not payer acceptance → decline (not understood)");

// reason 22 — notes (most recent note about other insurance wins)
const N22 = (notes: Array<{ at: string; text: string }>) => C({ service: SVC, rems: [deny(22, "$80.00")], notes });
eq(N22([{ at: "2026-08-01T15:00:00Z", text: "Patient reports secondary coverage: Silver 3500 from Tallgrass Health Plan, effective 2026-01-01." }]), "BILL_OTHER:Silver 3500", "22: plan covering on DOS → BILL_OTHER:<plan> without the payer's name");
eq(N22([{ at: "2026-08-01T15:00:00Z", text: "Patient reports secondary coverage: Silver 3500 from Tallgrass Health Plan." }, { at: "2026-08-05T15:00:00Z", text: "Patient says she has no other insurance." }]), "CONTACT_PATIENT", "22: a newer note saying none replaces the earlier plan");
eq(N22([{ at: "2026-08-05T15:00:00Z", text: "Patient says she has no other insurance." }, { at: "2026-08-07T15:00:00Z", text: "Patient also has Gold 1000 from Tallgrass Health Plan." }]), "BILL_OTHER:Gold 1000", "22: a newer plan note replaces 'no other insurance'");
eq(N22([{ at: "2026-08-01T15:00:00Z", text: "Patient has Silver 3500 from Tallgrass Health Plan." }, { at: "2026-08-09T15:00:00Z", text: "Patient updated the mailing address. No change to insurance." }]), "BILL_OTHER:Silver 3500", "22: a newer unrelated note doesn't replace the plan note");
eq(N22([{ at: "2026-08-01T15:00:00Z", text: "Spouse has Gold 1000 from Tallgrass Health Plan; the patient is not covered under it." }]), "CONTACT_PATIENT", "22: someone else's plan that doesn't cover the patient");
eq(N22([{ at: "2026-08-01T15:00:00Z", text: "Patient had Bronze 6000 from Tallgrass Health Plan; coverage ended 2026-06-30." }]), "CONTACT_PATIENT", "22: plan ended before the DOS");
eq(N22([{ at: "2026-08-01T15:00:00Z", text: "Patient had Bronze 6000 from Tallgrass Health Plan; coverage ended 2026-07-14." }]), "BILL_OTHER:Bronze 6000", "22: plan ending on the DOS still covered it");
eq(N22([]), "CONTACT_PATIENT", "22: no notes → CONTACT_PATIENT");
// run 146, n=140 (Kim, Gary, DOS 2026-03-03) — the real note text: a named plan that ended before the DOS + "no other insurance"
{
  const KIM = "Spoke with the patient about other insurance. The patient had Senior Basic from Senior Advantage of the Plains until August 31, 2025, before the date of service. No other insurance was active on 3/3/2026.";
  eq(classifyNote(KIM, "2026-03-03", PLANS), { kind: "none" }, "n=140 real note: plan ended 2025-08-31 + no other insurance on the DOS → none");
  eq(classifyNote(KIM, "2025-08-15", PLANS).kind, "unclear", "same note but the plan still covered the DOS → contradiction → unclear");
  eq(classifyNote("The patient has Senior Basic from Senior Advantage of the Plains. No other insurance.", "2026-03-03", PLANS).kind, "unclear", "plan with no end + 'no other insurance' → unclear");
  eq(classifyNote("Patient had Gold 1000 from Tallgrass Health Plan, coverage ended 2026-01-31. She has no other insurance now.", "2026-03-03", PLANS), { kind: "none" }, "paraphrase: ended before the DOS, none now → none");
  eq(classifyNote("Patient has Gold 1000 from Tallgrass Health Plan effective 2026-01-01. No other coverage before that.", "2026-03-03", PLANS).kind, "unclear", "hard negative: plan active on the DOS + a denial sentence → unclear, never none");
  eq(classifyNote("Patient had Gold 1000 and Silver 3500 until 2025-01-01. No other insurance.", "2026-03-03", PLANS).kind, "unclear", "two plans → unclear");
}
ok(N22([{ at: "2026-08-01T15:00:00Z", text: "Patient mentioned some other insurance through work, details to follow." }]).startsWith("DECLINE"), "22: other insurance without a known plan → decline");
ok(C({ service: SVC, rems: [deny(22, "$80.00")], notes: [{ at: "2026-08-01T15:00:00Z", text: "Patient has Silver 3500 from Tallgrass Health Plan." }] }, P0, { knownPlans: null }).startsWith("DECLINE"), "22: plans not read → decline");

// reason 16 — remark table order; MA130 / none → CALL_PAYER
eq(C({ service: SVC, rems: [deny(16, "$50.00", { remarks: "M51 N382" })] }), "RESUBMIT:MEMBER_ID", "16: N382 comes before M51 in the table");
eq(C({ service: SVC, rems: [deny(16, "$50.00", { remarks: "MA130" })] }), "CALL_PAYER", "16: only MA130 → CALL_PAYER");
eq(C({ service: SVC, rems: [{ trace: "C1", date: "Aug 17, 2026", type: "Payment", lines: [{ proc: "20610", billed: "$50.00", adj: ["CO-16 $50.00"], remarks: "MA130", paid: "$0.00" }, { proc: "99396", billed: "$100.00", adj: ["CO-45 $20.00"], remarks: "N290", paid: "$80.00" }] }] }), "CALL_PAYER", "16: a remark on a line not denied with 16 doesn't count");
ok(C({ service: SVC, rems: [deny(16, "$50.00", { remarks: "N999" })] }).startsWith("DECLINE"), "16: remark code the message doesn't define → decline");

// reason 97 — NCCI (11102 is col 2 under both 17110 and 17000)
const B = (svc: Array<{ proc: string; mod?: string }>, deniedProc: string) => C({ service: svc, rems: [{ trace: "C1", date: "Aug 17, 2026", type: "Payment", lines: [{ proc: deniedProc, billed: "$95.00", adj: ["CO-97 $95.00"], paid: "$0.00", line: svc.findIndex((s) => s.proc === deniedProc) + 1 }] }] });
eq(B([{ proc: "17000" }, { proc: "11102", mod: "59" }], "11102"), "APPEAL:2026-12-15", "97: 11102 with 59 bundled into 17000 (second row for 11102, indicator 1) → appeal");
eq(B([{ proc: "17110" }, { proc: "11102", mod: "59" }], "11102"), "APPEAL:2026-12-15", "97: 11102 with 59 under 17110 → appeal");
eq(B([{ proc: "17000" }, { proc: "11102" }], "11102"), "WRITE_OFF:95.00", "97: no modifier 59 → write off");
eq(B([{ proc: "17110" }, { proc: "11200", mod: "59" }], "11200"), "WRITE_OFF:95.00", "97: indicator 0 pair → write off even with 59");
eq(B([{ proc: "99396" }, { proc: "11102", mod: "59" }], "11102"), "WRITE_OFF:95.00", "97: column 1 code not billed → write off");

// priority and denied amount
eq(C({ service: SVC, rems: [{ trace: "C1", date: "Aug 17, 2026", type: "Payment", lines: [{ proc: "20610", billed: "$80.00", adj: ["CO-22 $80.00"], paid: "$0.00" }, { proc: "99396", billed: "$50.00", adj: ["CO-16 $50.00"], remarks: "N290", paid: "$0.00" }] }], notes: [] }), "CONTACT_PATIENT", "priority: 22 before 16");
eq(C({ dos: "Jun 1, 2026", dosISO: "2026-06-01", service: SVC, subs: [{ sent: "Sep 1, 2026", result: "Accepted by payer", rdate: "Sep 3, 2026" }], rems: [{ trace: "C1", date: "Aug 17, 2026", type: "Payment", lines: [{ proc: "20610", billed: "$190.00", adj: ["CO-197 $190.00"], paid: "$0.00" }, { proc: "99396", billed: "$1,250.50", adj: ["CO-29 $1,250.50"], paid: "$0.00" }] }], auths: A("Jan 1, 2026", "Dec 31, 2026") }), "WRITE_OFF:1250.50", "priority: 29 before 197; write-off is the reason-29 amount only");
eq(C({ service: SVC, rems: [{ trace: "C1", date: "Aug 17, 2026", type: "Payment", lines: [{ proc: "20610", billed: "$190.00", adj: ["CO-197 $100.00", "CO-45 $40.00", "PR-1 $50.00"], paid: "$0.00" }] }] }), "WRITE_OFF:100.00", "denied amount excludes CO-45 and PR on the same line");

// ════════ (d) page variants ════════
section("page variants");
const swapCols = (d: Document, sel: string, i: number, j: number) => { for (const tr of d.querySelectorAll(`${sel} tr`)) { const c = [...tr.children]; if (c.length > Math.max(i, j)) { const a = c[i], b = c[j]; const an = a.nextSibling; b.replaceWith(a); tr.insertBefore(b, an); } } };
{
  const d = dom(CLAIM_HTML); swapCols(d, "section[aria-label=Remittances] table", 7, 9);
  eq(run(d, FM_ID, "2026-07-14"), "BILL_PATIENT:34.12", "remittance columns reordered (Adjustments ↔ Paid) → same answer");
}
{
  const d = dom(CLAIM_HTML);
  for (const tr of d.querySelectorAll("section[aria-label=Remittances] tr")) { const x = d.createElement(tr.querySelector("th") ? "th" : "td"); x.textContent = tr.querySelector("th") ? "Group" : "A1"; tr.insertBefore(x, tr.children[2]); }
  eq(run(d, FM_ID, "2026-07-14"), "BILL_PATIENT:34.12", "extra column → same answer");
}
{
  const d = dom(CLAIM_HTML);
  for (const th of d.querySelectorAll("section[aria-label=Remittances] th")) if (th.textContent === "Adjustments") th.textContent = "Adjustment codes";
  for (const th of d.querySelectorAll("section[aria-label=Remittances] th")) if (th.textContent === "Remark codes") th.textContent = "Remarks";
  eq(run(d, FM_ID, "2026-07-14"), "BILL_PATIENT:34.12", "renamed headers (synonyms) → same answer");
}
{
  const d = dom(CLAIM_HTML);
  for (const th of d.querySelectorAll("section[aria-label=Remittances] th")) if (th.textContent === "Adjustments") th.textContent = "Notes";
  ok(run(d, FM_ID, "2026-07-14").startsWith("DECLINE"), "adjustments column missing → decline");
}
{
  const d = dom(CLAIM_HTML); d.querySelector("section[aria-label=Authorizations]")!.innerHTML = "<h2>Authorizations</h2><div>Loading…</div>";
  ok(run(d, FM_ID, "2026-07-14").startsWith("DECLINE"), "authorizations panel neither table nor empty-state → decline");
}
{
  const d = dom(CLAIM_HTML); d.querySelector("section[aria-label=Remittances]")!.innerHTML = "<h2>Remittances</h2>";
  ok(run(d, FM_ID, "2026-07-14").startsWith("DECLINE"), "remittances panel empty without an empty-state text → decline (not AWAIT_PAYER)");
}
{
  const d = dom(CLAIM_HTML); const g = d.querySelector("section[aria-label=Remittances] [role=group] table")!; g.remove();
  ok(run(d, FM_ID, "2026-07-14").startsWith("DECLINE"), "remittance block without lines and without a scanned marker → decline");
}
{
  const d = claimDoc({ dos: "07/14/2026", rems: [paid("E1", "08/20/2026")] });
  eq(run(d, FM_ID, "2026-07-14"), "BILL_PATIENT:20.00", "US-format dates → same answer");
}
{
  // a remittance table that also lists another claim's lines (Claim column): only this claim's lines count
  const d = dom(CLAIM_HTML);
  const t = d.querySelector("section[aria-label=Remittances] table")!;
  for (const tr of t.querySelectorAll("tr")) { const x = d.createElement(tr.querySelector("th") ? "th" : "td"); x.innerHTML = tr.querySelector("th") ? "Claim" : span("70988502"); tr.insertBefore(x, tr.firstChild); }
  const other = t.querySelector("tbody tr")!.cloneNode(true) as Element; other.firstElementChild!.innerHTML = span("11111111"); other.children[8].innerHTML = `<div>${span("CO-197")} $80.48</div>`; t.querySelector("tbody")!.appendChild(other);
  eq(run(d, FM_ID, "2026-07-14"), "BILL_PATIENT:34.12", "another claim's line on the same remittance is ignored");
}

section("contract page");
eq(parseContract(claimPageOf(contractDoc("<dl><dt>Claims accepted within</dt><dd>90 days</dd><dt>Appeals accepted within</dt><dd>120 days</dd></dl>")), "Senior Advantage of the Plains", {}), { appealDays: 120, filingDays: 90 }, "contract dl");
eq(parseContract(claimPageOf(contractDoc("<table><caption>Terms</caption><thead><tr><th>Effective</th><th>Claims accepted within</th><th>Appeals accepted within</th></tr></thead><tbody><tr><td>Jan 1, 2024</td><td>90 days from the date of service</td><td>120 days from the remittance date</td></tr></tbody></table>")), "Senior Advantage of the Plains", {}), { appealDays: 120, filingDays: 90 }, "contract table with anchors");
ok(isDecline(parseContract(claimPageOf(contractDoc("<dl><dt>Appeals accepted within</dt><dd>45 business days</dd></dl>")), "Senior Advantage of the Plains", {})), "business days → decline");
ok(isDecline(parseContract(claimPageOf(contractDoc("<table><thead><tr><th>Effective</th><th>Appeals accepted within</th></tr></thead><tbody><tr><td>Jan 1, 2024</td><td>90 days</td></tr><tr><td>Jan 1, 2026</td><td>120 days</td></tr></tbody></table>")), "Senior Advantage of the Plains", {})), "two appeal windows → decline");
ok(isDecline(parseContract(claimPageOf(contractDoc("<dl><dt>Appeals accepted within</dt><dd>120 days</dd></dl>")), "Tallgrass Health Plan", {})), "contract of another payer → decline");

section("contract terms (live wrapper): an unreadable contract is no terms, cached — never a decline of the whole claim");
{
  // Fake crawler: navTo counts navigations, evalApp returns the PPage of the "current" document.
  const fake = (doc: Document | null) => { const f = { navs: 0, navTo: async () => { f.navs++; return true; }, evalApp: async () => (doc ? claimPageOf(doc) : null),
    familyDigitMaps: async () => ({}), digitState: async () => null }; return f; };
  resetClaimCaches();
  const good = fake(contractDoc("<dl><dt>Claims accepted within</dt><dd>90 days</dd><dt>Appeals accepted within</dt><dd>120 days</dd></dl>"));
  eq(await contractTerms(good as any, "Senior Advantage of the Plains", "/claims/payers/x", () => {}, 200), { appealDays: 120, filingDays: 90 }, "readable contract → its terms");
  eq(await contractTerms(good as any, "Senior Advantage of the Plains", "/claims/payers/x", () => {}, 200), { appealDays: 120, filingDays: 90 }, "cached");
  eq(good.navs, 1, "second claim of the same payer: no navigation");
  // A contract page in a layout we never saw (no appeal/within/days text) → no terms, cached (no 2nd wait).
  const odd = fake(dom(`<body><h1>Tallgrass Health Plan</h1><section aria-label="Terms"><p>See attached PDF.</p></section></body>`));
  const logs: any[] = [];
  eq(await contractTerms(odd as any, "Tallgrass Health Plan", "/claims/payers/y", (r) => logs.push(r), 200), { appealDays: null, filingDays: null }, "unreadable contract → no terms");
  ok(/did not load/.test(logs[0]?.decline ?? ""), "the failure is logged with its reason");
  eq(await contractTerms(odd as any, "Tallgrass Health Plan", "/claims/payers/y", () => {}, 200), { appealDays: null, filingDays: null }, "failure cached");
  eq(odd.navs, 1, "failure cached: no second navigation / wait");
  eq(await contractTerms(fake(null) as any, "Union Workers Health Fund", null, () => {}, 200), { appealDays: null, filingDays: null }, "no contract link → no terms");
  resetClaimCaches();
  // The engine with NO terms: answers that don't need them stand, the ones that do decline.
  const NT = { appealDays: null, filingDays: null };
  eq(run(dom(CLAIM_HTML), FM_ID, "2026-07-14", P0, { contract: NT }), "BILL_PATIENT:34.12", "no terms: García paid claim still BILL_PATIENT:34.12");
  ok(C({ service: SVC, rems: [deny(197, "$190.00")], auths: A("Jan 1, 2026", "Dec 31, 2026") }, P0, { contract: NT }).startsWith("DECLINE"), "no terms: a covered 197 (appeal) declines — it needs the appeal window");
  eq(C({ service: SVC, rems: [deny(197, "$190.00")], auths: A("Jan 1, 2025", "Dec 31, 2025") }, P0, { contract: NT }), "WRITE_OFF:190.00", "no terms: an uncovered 197 is still WRITE_OFF:190.00 (no window needed)");
}

section("claims list");
eq(findClaim([{ dos: "2026-07-14", href: "/claims/a", text: "" }, { dos: "2026-06-17", href: "/claims/b", text: "" }], "2026-07-14"), "/claims/a", "one claim with the DOS");
ok(isDecline(findClaim([{ dos: "2026-07-14", href: "/claims/a", text: "" }, { dos: "2026-07-14", href: "/claims/b", text: "" }], "2026-07-14")), "two claims on the DOS → decline");
ok(isDecline(findClaim([{ dos: "2026-06-17", href: "/claims/b", text: "" }], "2026-07-14")), "no claim on the DOS → decline");

section("note classifier");
eq(classifyNote("Patient updated the mailing address. No change to insurance.", "2026-07-14", PLANS), { kind: "unrelated" }, "address note unrelated");
eq(classifyNote("Called patient re: balance. Will pay next week.", "2026-07-14", PLANS), { kind: "unrelated" }, "payment note unrelated");
eq(classifyNote("Patient's wife carries Silver 3500 from Tallgrass Health Plan.", "2026-07-14", PLANS).kind, "unclear", "spouse's plan without saying the patient is covered → unclear");
eq(classifyNote("Patient is covered as a dependent on her husband's Gold 1000 from Tallgrass Health Plan.", "2026-07-14", PLANS), { kind: "plan", plan: "Gold 1000", covers: true }, "dependent on spouse's plan → covers");
eq(classifyNote("New secondary coverage Silver 3500 from Tallgrass Health Plan starting 2026-08-01.", "2026-07-14", PLANS), { kind: "plan", plan: "Silver 3500", covers: false }, "plan starting after the DOS → doesn't cover");
eq(classifyNote("Patient has silver 3500 from Tallgrass.", "2026-07-14", PLANS), { kind: "plan", plan: "silver 3500", covers: true }, "plan name as the note writes it");

// ════════ (e) routing ════════
section("routing: paraphrases + hard negatives");
const routes = (t: string) => familyMatch(t);
for (const [t, want] of [
  ["What's the next step on Linda Coleman's claim for the 2026-07-06 date of service?", { name: "Linda Coleman", dos: "2026-07-06" }],
  ["Claim for Coleman, Linda, born 09/16/1958, service date July 6, 2026: what do we do next?", { name: "Coleman, Linda", dob: "1958-09-16", dos: "2026-07-06" }],
  ["Where does the claim for Linda Coleman's visit on 2026-07-06 go now that the remittance is back?", { name: "Linda Coleman", dos: "2026-07-06" }],
  ["Linda Coleman (DOB 1958-09-16), DOS 07/06/2026: next action on the claim?", { name: "Linda Coleman", dob: "1958-09-16", dos: "2026-07-06" }],
  ["Please tell me the next step for the claim with date of service Jul 6, 2026 for Linda Coleman.", { name: "Linda Coleman", dos: "2026-07-06" }],
  ["How should we work the claim for Linda Coleman, date of service 2026-07-06?", { name: "Linda Coleman", dos: "2026-07-06" }],
] as const) {
  const m = routes(t);
  eq([m?.family, m?.slots], ["claim-next-step", want], "paraphrase routes: " + t.slice(0, 60));
}
for (const t of [
  "What's the filing deadline for Linda Coleman's 2026-07-06 claim?",
  "Linda Coleman, DOB 1958-09-16, date of service 2026-07-06. We haven't billed this one yet. What's the deadline to file?",
  "How much did the payer pay on Linda Coleman's claim for 2026-07-06?",
  "When was the claim for Linda Coleman's 2026-07-06 visit submitted?",
  "What's the last day to appeal Linda Coleman's claim for 2026-07-06?",
  "How much does Linda Coleman still owe on invoice 448812 (service date 2026-07-06)?",
  "What is the status of the claim for Linda Coleman, date of service 2026-07-06?",
  "Which payer was the claim for Linda Coleman on 2026-07-06 billed to?",
]) eq(routes(t)?.family === "claim-next-step", false, "hard negative does not route to claim-next-step: " + t.slice(0, 60));
// run 164: the three account-note declines (full note text now logged)
{
  const PL = [...PLANS, { payer: "Northfield Life and Health", plan: "Individual" }];
  const COLE = "Spoke with the patient about other insurance. The patient has a second plan, Individual from Northfield Life and Health, and it was active on the date of service, March 18, 2026.";
  eq(classifyNote(COLE, "2026-03-18", PL), { kind: "plan", plan: "Individual", covers: true }, "run-164 note: second plan active on the date of service (the DOS) → bill that plan");
  eq(classifyNote(COLE, "2026-03-19", PL).kind, "unclear", "same note, a different claim DOS → unclear");
  const GOLD = "Spoke with the patient about other insurance. The patient has a second plan, Gold 1000 from Tallgrass Health Plan, and it was active on the date of service, April 27, 2026.";
  eq(classifyNote(GOLD, "2026-04-27", PLANS), { kind: "plan", plan: "Gold 1000", covers: true }, "run-164 note: Gold 1000 active on the DOS");
  eq(classifyNote("Patient called about a letter from the payer. Told the patient billing is reviewing the claim.", "2026-04-27", PLANS), { kind: "unrelated" }, "run-164 note: a letter from the claim's payer is not about other insurance");
  eq(classifyNote("The payer says the patient has other coverage.", "2026-04-27", PLANS).kind, "unclear", "payer + 'other coverage' still talks about other insurance");
}
// Set 1 n=216 (skipped in the 278 run): "was covered by it on <DOS>" is an affirmative statement about the DOS itself
{
  const PL = [...PLANS, { payer: "Copper Mesa Health", plan: "Open Access" }];
  const N = (s: string) => `Coordination of benefits call completed. ${s} Copy of the card requested.`;
  const OA = N("The patient is covered by Open Access, Copper Mesa Health, and was covered by it on 2025-12-24.");
  eq(classifyNote(OA, "2025-12-24", PL), { kind: "plan", plan: "Open Access", covers: true }, "n=216 note: covered on the DOS → bill that plan");
  eq(classifyNote(OA, "2025-12-23", PL).kind, "unclear", "same note, another DOS → the date says nothing about the DOS → unclear");
  eq(classifyNote(N("The patient is covered by Open Access, Copper Mesa Health, and was covered by it on December 24, 2025."), "2025-12-24", PL), { kind: "plan", plan: "Open Access", covers: true }, "written date");
  for (const neg of [
    "The patient is covered by Open Access, Copper Mesa Health, but was not covered by it on 2025-12-24.",
    "The patient is covered by Open Access, Copper Mesa Health, but wasn't covered by it on 2025-12-24.",
    "The patient is covered by Open Access, Copper Mesa Health, and was never covered by it on 2025-12-24.",
    "The patient was no longer covered by Open Access, Copper Mesa Health, on 2025-12-24.",
    "The patient is covered by Open Access, Copper Mesa Health, and was covered by it on 2025-12-24, but the plan lapsed.",
    "The patient is covered by Open Access, Copper Mesa Health, and was covered by it on 2025-12-24. Coverage ended 2025-12-01.",
    "The patient might be covered by Open Access, Copper Mesa Health, and was covered by it on 2025-12-24, to be confirmed.",
    "The patient's spouse is covered by Open Access, Copper Mesa Health, and was covered by it on 2025-12-24.",
  ]) { const r = classifyNote(N(neg), "2025-12-24", PL); eq(r.kind === "plan" && r.covers, false, "must not bill: " + neg.slice(0, 90)); }
}
// Set 1 wording still routes by the exact pattern
eq(routes("Next step on claim: Coleman, Linda, DOB 1958-09-16, service date 2026-07-06")?.slots, { name: "Coleman, Linda", dob: "1958-09-16", dos: "2026-07-06" }, "Set 1 pattern");

console.log(fails ? `✗ claimReader.test: ${passes} passed, ${fails} failed` : `✓ claimReader.test: ${passes} passed, 0 failed`);
process.exit(fails ? 1 : 0);
