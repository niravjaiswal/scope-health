/**
 * Replay check: claim-next-step skips of run 146 (baseline) re-run on the claim pages the run
 * captured ({"event":"skip_probe"} lines of fixtures/set1/run-146-set1.log). For every captured CLAIM page
 * (h1 "Claim …") the current parser + engine run again; the line says whether the task would now be
 * answered. Hand-worked verdicts below; exits 1 if any replayed answer differs from its verdict.
 *   npx tsx src/wrenfield/claim-replay-146.ts
 */
import { readFileSync } from "fs";
import { claimPageOf, parseClaimPage } from "./claimReader.js";
import { decideClaim, parseClaimPolicy, type ClaimContext, type ClaimPolicy } from "./claimNextStep.js";
import { isDecline } from "./familyReaders.js";
import { dom, msg, PLANS } from "./claimFixtures.js";

// Worked by hand from the captured page + n=120:
//  140 Kim, Gary 2026-03-03: only remittance EFT290081973 (2026-03-30), line 99213 CO-22 140.00 → reason 22.
//      Latest note about other insurance (Apr 4): "had Senior Basic … until August 31, 2025, before the date
//      of service. No other insurance was active on 3/3/2026." → plan ended before the DOS → CONTACT_PATIENT.
//  133 Lee, Elena: current remittance EFT258624683 is a scanned paper remittance → still a skip (no image reader).
const VERDICT: Record<string, string> = { "Claim 82773585": "CONTACT_PATIENT", "Claim 37922012": "SKIP" };
const DOS: Record<string, string> = { "Claim 82773585": "2026-03-03", "Claim 37922012": "2026-08-28" };

const P = parseClaimPolicy(msg(120), []) as ClaimPolicy;
let bad = 0, seen = 0;
for (const line of readFileSync("fixtures/set1/run-146-set1.log", "utf8").split("\n")) {
  if (!line.includes('"skip_probe"')) continue;
  const j = JSON.parse(line);
  if (j.family !== "claim-next-step") continue;
  const d = dom(String(j.html).replace(/^<body[^>]*>|<\/body>$/g, ""));
  const p = claimPageOf(d);
  const key = (p.h1 || "").replace(/\s+/g, " ").trim();
  if (!/^claim \d+/i.test(key)) { console.log(`-- not a claim page (${key || "?"}): ${j.why.slice(0, 70)}`); continue; }
  seen++;
  const dos = DOS[key];
  const f = parseClaimPage(p, {}, dos);
  let got: string;
  if (isDecline(f)) got = "SKIP (" + f.decline + ")";
  else {
    const ctx: ClaimContext = { serviceDateISO: dos, payer: f.payer, plan: f.plan, contract: { appealDays: 180, filingDays: 180 }, remittances: f.remittances, billedLines: f.billedLines, submissions: f.submissions, authorizations: f.authorizations, notes: f.notes, knownPlans: PLANS, mergedRecord: f.merged };
    const v = decideClaim(ctx, P);
    got = "decline" in v ? "SKIP (" + v.decline + ")" : v.answer;
  }
  const want = VERDICT[key];
  const okk = want === "SKIP" ? got.startsWith("SKIP") : got === want;
  if (!okk) bad++;
  console.log(`${okk ? "ok" : "✗ "} ${key}: was skipped ("${j.why.slice(0, 60)}") → now ${got}; hand verdict ${want}`);
}
console.log(`${seen} claim pages replayed, ${bad} differ from the hand verdict`);
process.exit(bad || seen < 2 ? 1 : 0);
