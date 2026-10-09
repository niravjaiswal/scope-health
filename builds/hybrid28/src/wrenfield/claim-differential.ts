/**
 * Claim next-step DIFFERENTIAL: the same claim pages through both implementations.
 *   LIVE   = claimReader.parseClaimPage + parseContract + claimNextStep.decideClaim (policy parsed from n=120 + later)
 *   BASELINE = claimOracle: the  DOM walker (one page digit map) + assembleClaim + the  engine,
 *            contract windows read the way his reader does (originalFilingDays(parseFilingTerms) + parseAppealDays
 *            over the contract page text), Northfield via the compiler fact appeal_window_days (as in his solver).
 *   BASELINE-ENGINE = his assembly + engine handed the right contract numbers (filing 90, appeal 120): isolates the
 *            engine/assembly from his contract reading.
 * Inputs: the captured García claim page, the policy's worked example, and the synthetic claims of
 * claimReader.test.ts (built from the real markup) for every rule branch. Each case carries a VERDICT worked
 * by hand from the policy text (n=120, amendments n=132 / n=164); "SKIP" = the right move is to decline.
 *   npx tsx src/wrenfield/claim-differential.ts         (exit 1 if LIVE is ever wrong: answers ≠ verdict)
 */
import { claimPageOf, parseClaimPage, parseContract, type FamMaps } from "./claimReader.js";
import { decideClaim, parseClaimPolicy, type ClaimContext, type ClaimPolicy } from "./claimNextStep.js";
import * as O from "./claimOracle.js";
import { isDecline } from "./familyReaders.js";
import { msg, CLAIM_HTML, dom, PLANS, claimDoc, paid, deny, SVC, A, contractDoc, type Claim } from "./claimFixtures.js";

export const P0 = parseClaimPolicy(msg(120), []) as ClaimPolicy;
export const P132 = parseClaimPolicy(msg(120), [msg(132)]) as ClaimPolicy;
export const P164 = parseClaimPolicy(msg(120), [msg(132), msg(150), msg(164), msg(176), msg(198)]) as ClaimPolicy;
const NF = "Northfield Life and Health";
export const CONTRACT_BODY = (appeal = 120) => `<dl><dt>Claims accepted within</dt><dd>90 days</dd><dt>Appeals accepted within</dt><dd>${appeal} days</dd></dl>`;

type Opt = { pol?: ClaimPolicy; appeal?: number; fm?: FamMaps; baselineMap?: Record<string, string>; fact?: number; extra?: Partial<ClaimContext> };
export type Case = { name: string; doc: () => Document; dos: string; payer?: string; verdict: string; why: string; o?: Opt };

export function live(c: Case): string {
  const o = c.o ?? {};
  const f = parseClaimPage(claimPageOf(c.doc()), o.fm ?? { Scr: "identity" }, c.dos);
  if (isDecline(f)) return "SKIP";
  const k = parseContract(claimPageOf(contractDoc(CONTRACT_BODY(o.appeal), f.payer)), f.payer, {});
  if (isDecline(k)) return "SKIP";
  const ctx: ClaimContext = { serviceDateISO: c.dos, payer: f.payer, plan: f.plan, contract: k, remittances: f.remittances, billedLines: f.billedLines, submissions: f.submissions, authorizations: f.authorizations, notes: f.notes, knownPlans: PLANS, mergedRecord: f.merged, ...(o.extra ?? {}) };
  const v = decideClaim(ctx, o.pol ?? P0);
  return "decline" in v ? "SKIP" : v.answer;
}
function baseline(c: Case, engineOnly: boolean): string {
  const o = c.o ?? {};
  const d = c.doc();
  const view = d.defaultView!;
  let ex: O.ClaimExtract | null = null;
  try { ex = new Function("doc", "getComputedStyle", O.baselineClaimWalkJS(o.baselineMap ?? {}))(d, (el: Element) => view.getComputedStyle(el)); } catch { return "SKIP"; }
  if (!ex) return "SKIP";
  if (!ex.remittances.length) return "SKIP";                       // his reader: "claim: no remittances on the claim"
  let filingDays: number | null, appealDays: number | null;
  if (engineOnly) { filingDays = 90; appealDays = o.appeal ?? 120; }
  else {
    const ctext = claimPageOf(contractDoc(CONTRACT_BODY(o.appeal), ex.payer)).text;
    filingDays = O.originalFilingDays(O.parseFilingTerms(ctext), c.dos);
    appealDays = O.parseAppealDays(ctext);
  }
  const ctx = O.assembleClaim(ex, { todayISO: "2026-10-14", serviceDateISO: c.dos, payer: ex.payer, filingDays, appealDays });
  if (!ctx) return "SKIP";
  if (o.fact !== undefined && ex.payer === NF) ctx.appealDays = o.fact; // store.factsFor([payer]) appeal_window_days
  return O.decideClaim(ctx) ?? "SKIP";
}

const G = (c: Claim) => () => claimDoc(c);
const R29 = (rdate: string, result = "Accepted by payer"): Claim => ({ dos: "Jun 1, 2026", dosISO: "2026-06-01", service: SVC, rems: [deny(29, "$120.00")], subs: [{ sent: "Aug 1, 2026", result, rdate }] });
const N22 = (notes: Array<{ at: string; text: string }>): Claim => ({ service: SVC, rems: [deny(22, "$80.00")], notes });
const B = (svc: Array<{ proc: string; mod?: string }>, deniedProc: string): Claim => ({ service: svc, rems: [{ trace: "C1", date: "Aug 17, 2026", type: "Payment", lines: [{ proc: deniedProc, billed: "$95.00", adj: ["CO-97 $95.00"], paid: "$0.00", line: svc.findIndex((s) => s.proc === deniedProc) + 1 }] }] });
const SVCD = [{ proc: "99396", desc: "Preventive visit, established patient, age 40 to 64" }, { proc: "20610", desc: "Joint injection" }];
const AR = (service: string, from = "Jan 1, 2026", to = "Dec 31, 2026") => [{ payer: "Senior Advantage of the Plains", service, from, to }];
const D7 = "2026-07-14";
const sigma: Record<string, string> = { "0": "3", "1": "7", "2": "0", "3": "9", "4": "1", "5": "8", "6": "2", "7": "5", "8": "6", "9": "4" };
const inv: Record<string, string> = Object.fromEntries(Object.entries(sigma).map(([a, b]) => [b, a]));
const scrambled = () => { const d = dom(CLAIM_HTML); for (const s of d.querySelectorAll(".wvwjwgvc")) for (const n of [...s.childNodes]) if (n.nodeType === 3) n.nodeValue = n.nodeValue!.replace(/\d/g, (c) => sigma[c]); for (const g of d.querySelectorAll("[aria-label^='Remittance ']")) g.setAttribute("aria-label", g.getAttribute("aria-label")!.replace(/\d/g, (c) => sigma[c])); return d; };
const dumpMap: Record<string, string> = { "0": "0", "1": "1", "2": "6", "3": "7", "4": "3", "5": "8", "6": "9", "7": "5", "8": "2", "9": "4" };

export const CASES: Case[] = [
  { name: "García 2026-07-14 (captured page)", doc: () => dom(CLAIM_HTML), dos: D7, verdict: "BILL_PATIENT:34.12", why: "only remittance EFT541736844 is a payment; CO-45 only (not a denial); PR-1 12.44 + 21.68" },
  { name: "García, digits in a font we can't map (live: no family map / baseline: map {} = raw)", doc: () => dom(CLAIM_HTML), dos: D7, verdict: "BILL_PATIENT:34.12|SKIP", why: "identity font here, so raw digits happen to be right; with no map the reader can't know that, so declining is right too", o: { fm: {} } },
  { name: "García drawn in a scrambled font, exact map", doc: scrambled, dos: D7, verdict: "BILL_PATIENT:34.12", why: "same page, digits permuted; decoded with σ⁻¹", o: { fm: { Scr: inv }, baselineMap: inv } },
  { name: "García scrambled, map unavailable (baseline applies {} → reads scrambled digits raw)", doc: scrambled, dos: D7, verdict: "SKIP", why: "the codes/amounts on screen are not the codepoints; reading them raw can only be a guess", o: { fm: {}, baselineMap: {} } },
  { name: "García with the dump's wrong page map (CO-45→CO-38)", doc: () => dom(CLAIM_HTML), dos: D7, verdict: "BILL_PATIENT:34.12|SKIP", why: "truth is 34.12; the dump's single page map mis-decodes the codes (CO-45→CO-38, an unknown reason) — baseline lands on 34.12 only because the amounts aren't in the obfuscated spans", o: { fm: { Scr: dumpMap }, baselineMap: dumpMap } },
  { name: "worked example (Coleman): 197, auth covers, reversed payment + its reversal before", doc: G({ service: SVC, rems: [{ trace: "EFT1", date: "Jul 20, 2026", type: "Payment", lines: [{ proc: "20610", billed: "$190.00", adj: ["PR-2 $190.00"], paid: "$0.00" }] }, { trace: "EFT2", date: "Aug 1, 2026", type: "Reversal of EFT1", lines: [] }, deny(197, "$190.00")], auths: A("Jan 1, 2026", "Dec 31, 2026") }), dos: D7, verdict: "APPEAL:2026-12-15", why: "current = CHK4578491 (2026-08-17); 197 covered; 2026-08-17 + 120 = 2026-12-15 ≥ today" },
  { name: "no remittance", doc: G({ rems: [] }), dos: D7, verdict: "AWAIT_PAYER", why: "\"If no remittance has been received … AWAIT_PAYER\"" },
  { name: "only payment reversed", doc: G({ rems: [paid("EFT1"), { trace: "EFT2", date: "Sep 1, 2026", type: "Reversal of EFT1", lines: [] }] }), dos: D7, verdict: "AWAIT_PAYER", why: "every payment reversed" },
  { name: "later payment reversed → earlier payment current", doc: G({ service: SVC, rems: [deny(197, "$190.00", {}, "CHK7", "Jul 23, 2026"), paid("EFT1"), { trace: "EFT2", date: "Sep 1, 2026", type: "Reversal of EFT1", lines: [] }] }), dos: D7, verdict: "WRITE_OFF:190.00", why: "CHK7 is the latest unreversed payment; 197 with no auth" },
  { name: "earlier remittances play no part", doc: G({ rems: [deny(197, "$190.00", {}, "CHK7", "Jul 23, 2026"), paid("EFT1")] }), dos: D7, verdict: "BILL_PATIENT:20.00", why: "latest payment EFT1: PR-2 20.00" },
  { name: "reversal naming no payment", doc: G({ rems: [paid("EFT1"), { trace: "EFT2", date: "Sep 1, 2026", type: "Reversal", lines: [] }] }), dos: D7, verdict: "SKIP", why: "can't tell which payment was taken back" },
  { name: "two unreversed payments on the same latest date", doc: G({ rems: [paid("EFT1"), paid("EFT2")] }), dos: D7, verdict: "BILL_PATIENT:20.00|SKIP", why: "\"the one with the latest payment date\" is not unique; both carry the same lines here, so either gives 20.00" },
  { name: "current remittance scanned (not keyed)", doc: G({ rems: [{ trace: "CHK9", date: "Aug 20, 2026", type: "Payment", scanned: true }] }), dos: D7, verdict: "SKIP", why: "scanned lines count, but we can't read them (no image reader)" },
  { name: "earlier scanned remittance", doc: G({ rems: [{ trace: "CHK9", date: "Jul 30, 2026", type: "Payment", scanned: true }, paid("EFT1")] }), dos: D7, verdict: "BILL_PATIENT:20.00", why: "current = EFT1" },
  { name: "CO-45 only", doc: G({ rems: [{ trace: "E1", date: "Aug 20, 2026", type: "Payment", lines: [{ proc: "99396", billed: "$230.00", adj: ["CO-45 $80.48"], paid: "$149.52" }] }] }), dos: D7, verdict: "NO_ACTION", why: "paid, PR total 0" },
  { name: "thousands + cents", doc: G({ rems: [{ trace: "E1", date: "Aug 20, 2026", type: "Payment", lines: [{ proc: "99396", billed: "$2,500.00", adj: ["CO-45 $1,249.49", "PR-1 $1,000.00", "PR-3 $0.01"], paid: "$250.50" }] }] }), dos: D7, verdict: "BILL_PATIENT:1000.01", why: "PR-1 1000.00 + PR-3 0.01" },
  { name: "unknown reason code CO-38", doc: G({ rems: [{ trace: "E1", date: "Aug 20, 2026", type: "Payment", lines: [{ proc: "99396", billed: "$230.00", adj: ["CO-38 $80.48"], paid: "$149.52" }] }] }), dos: D7, verdict: "NO_ACTION|SKIP", why: "by the letter CO-38 is not a denial → NO_ACTION; a code outside the table is more likely a misread, so declining is right too" },
  { name: "line doesn't balance", doc: G({ rems: [{ trace: "E1", date: "Aug 20, 2026", type: "Payment", lines: [{ proc: "99396", billed: "$230.00", adj: ["CO-45 $80.00"], paid: "$149.52" }] }] }), dos: D7, verdict: "NO_ACTION|SKIP", why: "NO_ACTION by the letter; billed − adjustments ≠ paid signals a misread, so declining is right too" },
  { name: "OA group", doc: G({ rems: [{ trace: "E1", date: "Aug 20, 2026", type: "Payment", lines: [{ proc: "99396", billed: "$230.00", adj: ["OA-23 $80.48"], paid: "$149.52" }] }] }), dos: D7, verdict: "NO_ACTION|SKIP", why: "OA is neither a denial nor PR → NO_ACTION by the letter; the message defines only CO and PR, so declining is right too" },
  { name: "197 covered", doc: G({ service: SVC, rems: [deny(197, "$190.00")], auths: A("Jan 1, 2026", "Dec 31, 2026") }), dos: D7, verdict: "APPEAL:2026-12-15", why: "worked example" },
  { name: "197 auth = DOS only (bounds inclusive)", doc: G({ service: SVC, rems: [deny(197, "$190.00")], auths: A("Jul 14, 2026", "Jul 14, 2026") }), dos: D7, verdict: "APPEAL:2026-12-15", why: "first and last valid days both count" },
  { name: "197 auth ended day before", doc: G({ service: SVC, rems: [deny(197, "$190.00")], auths: A("Jan 1, 2026", "Jul 13, 2026") }), dos: D7, verdict: "WRITE_OFF:190.00", why: "not covered" },
  { name: "197 other payer's auth", doc: G({ service: SVC, rems: [deny(197, "$190.00")], auths: A("Jan 1, 2026", "Dec 31, 2026", "Tallgrass Health Plan") }), dos: D7, verdict: "WRITE_OFF:190.00", why: "payer must be the claim's" },
  { name: "197 other procedure's auth", doc: G({ service: SVC, rems: [deny(197, "$190.00")], auths: A("Jan 1, 2026", "Dec 31, 2026", "Senior Advantage of the Plains", "20605") }), dos: D7, verdict: "WRITE_OFF:190.00", why: "procedure must be the line's" },
  { name: "197 real auth table, Service = line description", doc: G({ service: SVCD, rems: [deny(197, "$190.00")], authsReal: AR("Joint injection") }), dos: D7, verdict: "APPEAL:2026-12-15", why: "Service maps to 20610 by the claim's own description" },
  { name: "197 real auth table, unmappable Service valid on DOS", doc: G({ service: SVCD, rems: [deny(197, "$190.00")], authsReal: AR("Wound care") }), dos: D7, verdict: "SKIP", why: "can't tell which code 'Wound care' authorizes; WRITE_OFF could be wrong" },
  { name: "197 real auth table, auth = DOS only", doc: G({ service: SVCD, rems: [deny(197, "$190.00")], authsReal: AR("Joint injection", "Jul 14, 2026", "Jul 14, 2026") }), dos: D7, verdict: "APPEAL:2026-12-15", why: "bounds inclusive (real layout)" },
  { name: "Northfield n=132 pending note, real auth table", doc: G({ payer: NF, service: SVCD, rems: [deny(197, "$190.00")], authsReal: [{ payer: NF, service: "Joint injection", from: "Jan 1, 2026", to: "Dec 31, 2026" }] }), dos: D7, verdict: "APPEAL:2027-02-13", why: "go by the note: 2026-08-17 + 180 (real layout)", o: { pol: P132, fact: 180 } },
  { name: "Northfield n=164 + contract still 120, real auth table", doc: G({ payer: NF, service: SVCD, rems: [deny(197, "$190.00")], authsReal: [{ payer: NF, service: "Joint injection", from: "Jan 1, 2026", to: "Dec 31, 2026" }] }), dos: D7, verdict: "APPEAL:2027-02-13|SKIP", why: "note says 180 is live, site disagrees", o: { pol: P164, fact: 180 } },
  { name: "Northfield n=132, compiler fact mis-spelt, real auth table", doc: G({ payer: NF, service: SVCD, rems: [deny(197, "$190.00")], authsReal: [{ payer: NF, service: "Joint injection", from: "Jan 1, 2026", to: "Dec 31, 2026" }] }), dos: D7, verdict: "APPEAL:2027-02-13", why: "pending note → 180; Baseline solver needs predicate appeal_window_days exactly (run 151 compiled n=164 as appeals_window_days)", o: { pol: P132 } },
  { name: "appeal last day = today", doc: G({ dos: "Jun 1, 2026", dosISO: "2026-06-01", service: SVC, rems: [deny(197, "$190.00", {}, "C1", "Jun 16, 2026")], auths: A("Jan 1, 2026", "Dec 31, 2026") }), dos: "2026-06-01", verdict: "APPEAL:2026-10-14", why: "\"today or later\"" },
  { name: "appeal last day = yesterday", doc: G({ dos: "Jun 1, 2026", dosISO: "2026-06-01", service: SVC, rems: [deny(197, "$190.00", {}, "C1", "Jun 15, 2026")], auths: A("Jan 1, 2026", "Dec 31, 2026") }), dos: "2026-06-01", verdict: "WRITE_OFF:190.00", why: "passed → write off" },
  { name: "Northfield, n=132 pending note (contract 120)", doc: G({ payer: NF, service: SVC, rems: [deny(197, "$190.00")], auths: A("Jan 1, 2026", "Dec 31, 2026", NF) }), dos: D7, verdict: "APPEAL:2027-02-13", why: "go by the note: 2026-08-17 + 180", o: { pol: P132, fact: 180 } },
  { name: "Northfield before the note", doc: G({ payer: NF, service: SVC, rems: [deny(197, "$190.00")], auths: A("Jan 1, 2026", "Dec 31, 2026", NF) }), dos: D7, verdict: "APPEAL:2026-12-15", why: "site's 120 days" },
  { name: "Northfield, n=164 'in Wrenfield now', contract shows 180", doc: G({ payer: NF, service: SVC, rems: [deny(197, "$190.00")], auths: A("Jan 1, 2026", "Dec 31, 2026", NF) }), dos: D7, verdict: "APPEAL:2027-02-13", why: "note and site agree on 180", o: { pol: P164, fact: 180, appeal: 180 } },
  { name: "Northfield, n=164 'in Wrenfield now', contract still shows 120", doc: G({ payer: NF, service: SVC, rems: [deny(197, "$190.00")], auths: A("Jan 1, 2026", "Dec 31, 2026", NF) }), dos: D7, verdict: "APPEAL:2027-02-13|SKIP", why: "the note says 180 is live but the site disagrees: 180 is the message's intent; declining is also safe", o: { pol: P164, fact: 180 } },
  { name: "Northfield n=164 with the compiler's other predicate spelling (run 151: appeals_window_days)", doc: G({ payer: NF, service: SVC, rems: [deny(197, "$190.00")], auths: A("Jan 1, 2026", "Dec 31, 2026", NF) }), dos: D7, verdict: "APPEAL:2027-02-13", why: "pending note n=132 → 180; Baseline solver only sees the exact predicate, so with a mis-spelt fact it falls back to the contract", o: { pol: P132 } },
  { name: "29 accepted on the last day to file", doc: G(R29("Aug 30, 2026")), dos: "2026-06-01", verdict: "APPEAL:2026-12-15", why: "DOS + 90 = 2026-08-30; proof; 2026-08-17 + 120" },
  { name: "29 accepted a day late", doc: G(R29("Aug 31, 2026")), dos: "2026-06-01", verdict: "WRITE_OFF:120.00", why: "no proof" },
  { name: "29 clearinghouse rejection", doc: G(R29("Jul 1, 2026", "Rejected by clearinghouse")), dos: "2026-06-01", verdict: "WRITE_OFF:120.00", why: "a rejected submission never counts" },
  { name: "29 'Accepted by clearinghouse'", doc: G(R29("Jul 1, 2026", "Accepted by clearinghouse")), dos: "2026-06-01", verdict: "WRITE_OFF:120.00|SKIP", why: "only payer acceptance proves timely filing → write off; declining is safe" },
  { name: "22 plan covering on DOS", doc: G(N22([{ at: "2026-08-01T15:00:00Z", text: "Patient reports secondary coverage: Silver 3500 from Tallgrass Health Plan, effective 2026-01-01." }])), dos: D7, verdict: "BILL_OTHER:Silver 3500", why: "latest insurance note names a covering plan" },
  { name: "22 newer note says none", doc: G(N22([{ at: "2026-08-01T15:00:00Z", text: "Patient reports secondary coverage: Silver 3500 from Tallgrass Health Plan." }, { at: "2026-08-05T15:00:00Z", text: "Patient says she has no other insurance." }])), dos: D7, verdict: "CONTACT_PATIENT", why: "most recent insurance note replaces earlier" },
  { name: "22 newer unrelated note", doc: G(N22([{ at: "2026-08-01T15:00:00Z", text: "Patient has Silver 3500 from Tallgrass Health Plan." }, { at: "2026-08-09T15:00:00Z", text: "Patient updated the mailing address. No change to insurance." }])), dos: D7, verdict: "BILL_OTHER:Silver 3500", why: "address note says nothing about other insurance" },
  { name: "22 spouse's plan not covering", doc: G(N22([{ at: "2026-08-01T15:00:00Z", text: "Spouse has Gold 1000 from Tallgrass Health Plan; the patient is not covered under it." }])), dos: D7, verdict: "CONTACT_PATIENT", why: "plan belongs to someone else" },
  { name: "22 plan ended before DOS", doc: G(N22([{ at: "2026-08-01T15:00:00Z", text: "Patient had Bronze 6000 from Tallgrass Health Plan; coverage ended 2026-06-30." }])), dos: D7, verdict: "CONTACT_PATIENT", why: "ended before DOS" },
  { name: "22 no notes", doc: G(N22([])), dos: D7, verdict: "CONTACT_PATIENT", why: "no note about other insurance" },
  { name: "16 N382 before M51", doc: G({ service: SVC, rems: [deny(16, "$50.00", { remarks: "M51 N382" })] }), dos: D7, verdict: "RESUBMIT:MEMBER_ID", why: "table order" },
  { name: "16 MA130 only", doc: G({ service: SVC, rems: [deny(16, "$50.00", { remarks: "MA130" })] }), dos: D7, verdict: "CALL_PAYER", why: "MA130 not in the table" },
  { name: "16 remark on a non-16 line", doc: G({ service: SVC, rems: [{ trace: "C1", date: "Aug 17, 2026", type: "Payment", lines: [{ proc: "20610", billed: "$50.00", adj: ["CO-16 $50.00"], remarks: "MA130", paid: "$0.00" }, { proc: "99396", billed: "$100.00", adj: ["CO-45 $20.00"], remarks: "N290", paid: "$80.00" }] }] }), dos: D7, verdict: "CALL_PAYER", why: "only remarks on the reason-16 lines count" },
  { name: "16 undefined remark N999", doc: G({ service: SVC, rems: [deny(16, "$50.00", { remarks: "N999" })] }), dos: D7, verdict: "CALL_PAYER|SKIP", why: "not in the table → CALL_PAYER by the letter; an undefined code may be a misread → declining is safe" },
  { name: "97 11102-59 under 17000", doc: G(B([{ proc: "17000" }, { proc: "11102", mod: "59" }], "11102")), dos: D7, verdict: "APPEAL:2026-12-15", why: "indicator 1, col1 billed, modifier 59" },
  { name: "97 no modifier 59", doc: G(B([{ proc: "17000" }, { proc: "11102" }], "11102")), dos: D7, verdict: "WRITE_OFF:95.00", why: "no 59" },
  { name: "97 indicator 0", doc: G(B([{ proc: "17110" }, { proc: "11200", mod: "59" }], "11200")), dos: D7, verdict: "WRITE_OFF:95.00", why: "never paid separately" },
  { name: "97 col1 not billed", doc: G(B([{ proc: "99396" }, { proc: "11102", mod: "59" }], "11102")), dos: D7, verdict: "WRITE_OFF:95.00", why: "no column-1 line" },
  { name: "priority 22 before 16", doc: G({ service: SVC, rems: [{ trace: "C1", date: "Aug 17, 2026", type: "Payment", lines: [{ proc: "20610", billed: "$80.00", adj: ["CO-22 $80.00"], paid: "$0.00" }, { proc: "99396", billed: "$50.00", adj: ["CO-16 $50.00"], remarks: "N290", paid: "$0.00" }] }], notes: [] }), dos: D7, verdict: "CONTACT_PATIENT", why: "work 22 only; no note" },
  { name: "priority 29 before 197", doc: G({ dos: "Jun 1, 2026", dosISO: "2026-06-01", service: SVC, subs: [{ sent: "Sep 1, 2026", result: "Accepted by payer", rdate: "Sep 3, 2026" }], rems: [{ trace: "C1", date: "Aug 17, 2026", type: "Payment", lines: [{ proc: "20610", billed: "$190.00", adj: ["CO-197 $190.00"], paid: "$0.00" }, { proc: "99396", billed: "$1,250.50", adj: ["CO-29 $1,250.50"], paid: "$0.00" }] }], auths: A("Jan 1, 2026", "Dec 31, 2026") }), dos: "2026-06-01", verdict: "WRITE_OFF:1250.50", why: "29 first; accepted 09-03 > 08-30; reason-29 amount only" },
  { name: "denied amount excludes CO-45/PR", doc: G({ service: SVC, rems: [{ trace: "C1", date: "Aug 17, 2026", type: "Payment", lines: [{ proc: "20610", billed: "$190.00", adj: ["CO-197 $100.00", "CO-45 $40.00", "PR-1 $50.00"], paid: "$0.00" }] }] }), dos: D7, verdict: "WRITE_OFF:100.00", why: "write-off = CO-197 total" },
];

export const ok = (got: string, verdict: string) => verdict.split("|").includes(got);
const grade = (got: string, verdict: string) => ok(got, verdict) ? (got === "SKIP" ? "skip(ok)" : "RIGHT") : got === "SKIP" ? "skip(lost)" : "WRONG";
// Run as a script only: workflowExec-bench.ts imports CASES (the same cases through the LLM workflow executor).
if (process.argv[1]?.endsWith("claim-differential.ts")) {
const rows = CASES.map((c) => { const L = live(c), Au = baseline(c, false), Ae = baseline(c, true); return { c, L, Au, Ae, gL: grade(L, c.verdict), gA: grade(Au, c.verdict), gE: grade(Ae, c.verdict) }; });
const tally = (k: "gL" | "gA" | "gE") => { const t: Record<string, number> = {}; for (const r of rows) t[r[k]] = (t[r[k]] ?? 0) + 1; return JSON.stringify(t); };
const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
console.log(`${pad("case", 62)} ${pad("verdict", 22)} ${pad("LIVE", 22)} ${pad("BASELINE", 22)} BASELINE-ENGINE`);
for (const r of rows) {
  const mark = r.L === r.Au && r.L === r.Ae ? " " : "≠";
  console.log(`${mark}${pad(r.c.name, 61)} ${pad(r.c.verdict, 22)} ${pad(r.L + (r.gL === "RIGHT" || r.gL === "skip(ok)" ? "" : " [" + r.gL + "]"), 22)} ${pad(r.Au + (r.gA === "RIGHT" || r.gA === "skip(ok)" ? "" : " [" + r.gA + "]"), 22)} ${r.Ae}${r.gE === "RIGHT" || r.gE === "skip(ok)" ? "" : " [" + r.gE + "]"}`);
}
console.log(`\ncases ${rows.length}; disagreements ${rows.filter((r) => !(r.L === r.Au && r.L === r.Ae)).length}`);
console.log(`LIVE          ${tally("gL")}\nBASELINE        ${tally("gA")}\nBASELINE-ENGINE ${tally("gE")}`);
const liveWrong = rows.filter((r) => r.gL === "WRONG");
if (liveWrong.length) { console.error(`✗ claim-differential: LIVE wrong on ${liveWrong.map((r) => r.c.name).join("; ")}`); process.exit(1); }
console.log("✓ claim-differential: LIVE never wrong");
}
