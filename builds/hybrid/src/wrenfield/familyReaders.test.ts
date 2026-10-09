/**
 * Tests for the filing-deadline and good-faith-estimate readers (familyReaders.ts), routing
 * (familySlots.ts) and the rule parsing from the governing messages.
 *
 *   npx tsx src/wrenfield/familyReaders.test.ts
 *
 * (a) hand-verified cases on the Set 1 recon pages (real markup, run through the same SNAPSHOT_JS the
 *     live reader uses, in jsdom) — the working is in the comments;
 * (b) paraphrases (not Set 1 text) per family + hard negatives that must not route;
 * (c) page variants (reordered / renamed / extra columns, US vs ISO dates, empty tables, unknown
 *     values) that must give the SAME answer or decline — never a different answer;
 * (d) end-to-end through readFiling / readGoodFaith with a fake crawler serving those pages
 *     (pagination, page-size select, year select, Show more).
 */
import { readFileSync, existsSync } from "node:fs";
import { JSDOM } from "jsdom";
import { snapshotOf, SNAPSHOT_JS, type Snapshot } from "./pageSnapshot.js";
import * as R from "./familyReaders.js";
import { decideFiling, type FilingContext } from "./filingDeadline.js";
import { decideGoodFaith } from "./goodFaith.js";
import { familyMatch, FAMILY_PATTERNS } from "./families.js";
import { looseFiling, looseGoodFaith } from "./familySlots.js";
import { MessageStore, type ClinicIndex } from "./inference.js";
import { compiler } from "./run.js";
import { solveFamily } from "./solvers.js";

let passes = 0, fails = 0;
const ok = (c: unknown, m: string) => { if (c) passes++; else { fails++; console.error("✗ " + m); } };
const eq = (got: unknown, want: unknown, m: string) => ok(JSON.stringify(got) === JSON.stringify(want), `${m}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const declines = (x: unknown, m: string) => ok(R.isDecline(x), `${m}: expected a decline, got ${JSON.stringify(x)?.slice(0, 160)}`);
const section = (name: string) => console.log(`── ${name}`);

// ── fixtures ──
const here = (p: string) => new URL(p, import.meta.url);
const recon = readFileSync(here("../../fixtures/set1/recon-158.txt"), "utf8");
const dumpPath = [here("../../anotherDOMdump.txt"), here("../../../anotherDOMdump.txt")].find((u) => existsSync(u));
const dump = dumpPath ? readFileSync(dumpPath, "utf8") : "";
const items = readFileSync(here("../../fixtures/set1-items.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { n: number; kind: string; text: string });
const msg = (n: number) => items.find((i) => i.n === n)!.text;
const FILING_MSG = msg(150), GFE_MSG = msg(198);

/** The HTML captured for a page template in a recon dump ("@@@@ <tpl> ::" … "---- HTML ----" …). */
function html(src: string, header: string): string {
  const lines = src.split("\n"); const i = lines.findIndex((l) => l.startsWith(header));
  if (i < 0) throw new Error("no page " + header);
  let j = i + 1; while (j < lines.length && lines[j] !== "---- HTML ----") j++;
  const out: string[] = [];
  for (let k = j + 1; k < lines.length && !/^(@@@@|====|####|# EXPLORED|\{"event")/.test(lines[k]); k++) out.push(lines[k]);
  const h = out.join("\n").trim(); if (!h) throw new Error("empty HTML for " + header);
  return h;
}
const dom = (h: string): Document => new JSDOM(`<!doctype html><html>${h}</html>`).window.document;
const page = (src: string, tpl: string) => dom(html(src, `@@@@ ${tpl} ::`));
const snapOf = (d: Document): Snapshot => snapshotOf(d);
const clone = (d: Document) => dom(d.documentElement.innerHTML);
const h2 = (d: Document, text: RegExp) => [...d.querySelectorAll("h2")].find((h) => text.test(h.textContent || ""))!;

// ════════ (a) policies from the governing messages ════════
section("policies");
const fp = R.parseFilingPolicy(FILING_MSG);
ok(!R.isDecline(fp), "filing policy parses");
if (!R.isDecline(fp)) {
  eq(fp.todayISO, "2026-10-14", "filing policy: today from 'Today is 2026-10-14'");
  eq(fp.closedISO.length, 18, "filing policy: 18 office holidays listed");
  ok(fp.closedISO.includes("2026-11-26") && fp.closedISO.includes("2027-12-24") && !fp.closedISO.includes("2026-10-14"), "filing policy: holiday list is the message's list");
}
declines(R.parseFilingPolicy(FILING_MSG.replace(/Today is 2026-10-14[.,]/g, "")), "filing policy without a 'today'");
declines(R.parseFilingPolicy(FILING_MSG.replace(/Today is 2026-10-14\./, "Today is 2026-10-15.")), "filing policy whose two 'today' dates disagree");
declines(R.parseFilingPolicy(FILING_MSG.replace("never moves later", "moves to the next open day").replace("nearest earlier day", "next day")), "filing policy that rolls forward");
declines(R.parseFilingPolicy(FILING_MSG.replace(/AWAITING_PRIMARY/g, "WAIT")), "filing policy with a different answer token");
const gp = R.parseGoodFaithPolicy(GFE_MSG);
ok(!R.isDecline(gp), "good-faith policy parses");
if (!R.isDecline(gp)) eq(gp.bands, [{ min: 0, max: 2, due: "short" }, { min: 3, max: 9, due: 1 }, { min: 10, max: null, due: 3 }], "good-faith bands 0–2 short / 3–9 first / 10+ third"); // Infinity serialises as null
// A rule change in the message must change the bands (rules from the message, not constants).
const gp2 = R.parseGoodFaithPolicy(GFE_MSG.replace("0 to 2 business days", "0 to 4 business days").replace("3 to 9 business days", "5 to 11 business days").replace("10 or more business days: it's due on the third", "12 or more business days: it's due on the second"));
ok(!R.isDecline(gp2) && JSON.stringify(gp2.bands) === JSON.stringify([{ min: 0, max: 4, due: "short" }, { min: 5, max: 11, due: 1 }, { min: 12, max: null, due: 2 }]), "good-faith: amended bands are taken from the message");
declines(R.parseGoodFaithPolicy(GFE_MSG.replace("3 to 9 business days", "4 to 9 business days")), "good-faith bands with a gap");
ok(R.goodFaithAmendmentBlocks(["Second-floor copier is working again."]) === null && R.goodFaithAmendmentBlocks(["Eastside is closed on 2026-10-20 for a water leak."]) !== null, "good-faith: a later closure note blocks, noise does not");
ok(R.filingAmendmentBlocks(["Northfield Life and Health accepts appeals within 180 days of the remittance date."], "Tallgrass Health Plan") === null, "filing: an appeals note for another payer does not block");
// Set 1: nothing after the filing rule (n=150) or the good-faith rule (n=198) amends them.
const after = (n: number) => items.filter((i) => i.kind === "message" && i.n > n).map((i) => i.text);
for (const p of ["Tallgrass Health Plan", "Northfield Life and Health", "Medicare", "Union Workers Health Fund"]) ok(R.filingAmendmentBlocks(after(150), p) === null, `Set 1 messages after the filing rule do not block ${p}: ${R.filingAmendmentBlocks(after(150), p)}`);
ok(R.goodFaithAmendmentBlocks(after(198)) === null, "Set 1 messages after the good-faith rule do not block");
ok(R.filingAmendmentBlocks(["Copper Mesa Health now accepts claims within 120 days of the date of service. This isn't in Wrenfield yet."], "Tallgrass Health Plan") === null, "filing: another payer's limit note does not block");
ok(R.filingAmendmentBlocks(["The billing office is closed on 2026-12-31 for inventory."], "Tallgrass Health Plan") !== null, "filing: a billing-office closure note blocks");
ok(R.filingAmendmentBlocks(["Tallgrass Health Plan now accepts original claims within 180 days. Go by this note."], "Tallgrass Health Plan") !== null, "filing: a filing-limit note for the billed payer blocks");

// ════════ (a) hand-verified: payer claim-filing terms (recon /payers/{id} = Tallgrass) ════════
section("payer filing terms (recon)");
const payerDoc = page(recon, "/payers/{id}");
// Page shows: Effective Jul 1, 2022 | 150 days from the date of service | 90 days from the primary
// payer's remittance date | 365 days from the remittance date of the original claim.
const TALLGRASS = [{ effectiveISO: "2022-07-01", originalDays: 150, secondaryDays: 90, correctedDays: 365 }];
eq(R.parseFilingTermsPage(snapOf(payerDoc), "Tallgrass Health Plan"), TALLGRASS, "Tallgrass terms from the recon page");
if (dump) eq(R.parseFilingTermsPage(snapOf(page(dump, "/payers/{id}")), "Tallgrass Health Plan"), TALLGRASS, "same terms from the second dump (different class names)");
declines(R.parseFilingTermsPage(snapOf(payerDoc), "Copper Mesa Health"), "payer page for a different payer");

// ════════ (a) hand-verified: not-yet-filed claims → deadlines ════════
// The Set 1 recon only captured an EMPTY not-yet-filed list ("No claims waiting to be filed"), so the
// rows below are injected into the real insurance page in the shape the governing message describes
// (type, billed payer, remittance date or "not received").
section("not-yet-filed + engine (hand-verified)");
const insDoc = page(recon, "/patients/{id}/insurance");
declines(R.parseNotYetFiled(snapOf(insDoc), "2026-08-31"), "real recon page: empty not-yet-filed list");
type Row = [string, string, string, string, string];
const NYF_HEAD = ["Claim", "Date of service", "Type", "Billed to", "Primary or original remittance"];
const NYF_ROWS: Row[] = [
  ["87827990", "Aug 31, 2026", "Original", "Tallgrass Health Plan", "—"],
  ["87827991", "Jun 4, 2026", "Secondary", "Tallgrass Health Plan", "Received Sep 10, 2026"],
  ["87827992", "Jul 31, 2026", "Secondary", "Tallgrass Health Plan", "Not received"],
  ["87827993", "Jan 9, 2026", "Corrected", "Tallgrass Health Plan", "Received Jan 20, 2026"],
  ["87827994", "Mar 18, 2026", "Original", "Tallgrass Health Plan", "—"],
  ["87827995", "Jun 29, 2026", "Original", "Tallgrass Health Plan", "—"],
  ["87827996", "Mar 1, 2022", "Original", "Tallgrass Health Plan", "—"],
];
function withNotYetFiled(base: Document, head: string[], rows: string[][], opts: { emptyState?: boolean } = {}): Document {
  const d = clone(base); const sec = h2(d, /Claims not yet filed/).closest("section")!;
  [...sec.children].forEach((c) => { if (c.tagName !== "H2") c.remove(); });
  const box = d.createElement("div");
  box.innerHTML = opts.emptyState ? `<p>No claims waiting to be filed</p>` : `<table><caption>Claims not yet filed</caption><thead><tr>${head.map((h) => `<th scope="col">${h}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  sec.appendChild(box); return d;
}
const nyfDoc = withNotYetFiled(insDoc, NYF_HEAD, NYF_ROWS);
const policy = R.isDecline(fp) ? null : fp;
const answerFiling = (s: Snapshot, dos: string): string => {
  const c = R.parseNotYetFiled(s, dos); if (R.isDecline(c)) return "DECLINE";
  const ctx: FilingContext = { todayISO: policy!.todayISO, officeClosedISO: policy!.closedISO, type: c.type, serviceDateISO: dos, primaryRemitISO: c.type === "Secondary" ? c.remitISO : null, originalRemitISO: c.type === "Corrected" ? c.remitISO : null, termsSets: TALLGRASS };
  return decideFiling(ctx) ?? "DECLINE";
};
const FILING_CASES: Array<[string, string, string]> = [
  // Original, 150 days from DOS 2026-08-31: Sep 30 (+30), Oct 31 (+61), Nov 30 (+91), Dec 31 (+122), Jan 28 (+150).
  // 2027-01-01 is a Friday → Jan 28 is a Thursday, not on the holiday list → 2027-01-28 (after today).
  ["2026-08-31", "2027-01-28", "Original +150 days"],
  // Secondary, 90 days from the primary remittance 2026-09-10: Sep 30 (+20), Oct 31 (+51), Nov 30 (+81), Dec 9 (+90).
  // 2026-12-09 is a Wednesday, open → 2026-12-09.
  ["2026-06-04", "2026-12-09", "Secondary +90 days from the primary remittance"],
  // Secondary whose primary remittance has not been received → AWAITING_PRIMARY (terms exist on the DOS).
  ["2026-07-31", "AWAITING_PRIMARY", "Secondary, primary remittance not received"],
  // Corrected, 365 days from the original claim's remittance 2026-01-20 → 2027-01-20 (2026 is not a leap year);
  // 2027-01-20 is a Wednesday (Jan 1 2027 Fri + 19 days) → 2027-01-20.
  ["2026-01-09", "2027-01-20", "Corrected +365 days from the original remittance"],
  // Original, DOS 2026-03-18 + 150: Mar 31 (+13), Apr 30 (+43), May 31 (+74), Jun 30 (+104), Jul 31 (+135), Aug 15 (+150).
  // Aug 15 2026 is a Saturday (day 227 of a year starting Thursday) → back to Fri Aug 14. Passed: Aug 14 → Sep 14 (31)
  // → Oct 14 (30) = 61 days → EXPIRED:61.
  ["2026-03-18", "EXPIRED:61", "Original, deadline passed, Saturday rolled back"],
  // Original, DOS 2026-06-29 + 150: Jul 1 (+2), Aug 1 (+33), Sep 1 (+64), Oct 1 (+94), Nov 1 (+125), Nov 26 (+150).
  // 2026-11-26 is Thanksgiving on the MESSAGE's office-holiday list → nearest earlier open day Wed 2026-11-25.
  ["2026-06-29", "2026-11-25", "Original landing on an office holiday rolls back"],
  // DOS 2022-03-01 is before the only terms set (effective 2022-07-01) → NO_FILING_TERMS.
  ["2022-03-01", "NO_FILING_TERMS", "no terms in effect on the DOS"],
];
for (const [dos, want, m] of FILING_CASES) eq(answerFiling(snapOf(nyfDoc), dos), want, `filing ${dos}: ${m}`);
eq(answerFiling(snapOf(nyfDoc), "2026-02-02"), "DECLINE", "filing: no not-yet-filed claim on that date → decline");

// ════════ (c) page variants: same answer or decline ════════
section("not-yet-filed variants");
const permute = <T,>(r: T[], p: number[]) => p.map((i) => r[i]);
const usDate = (s: string) => s.replace(/([A-Z][a-z]{2}) (\d{1,2}), (\d{4})/g, (_, mo, d, y) => `${String(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(mo) + 1).padStart(2, "0")}/${d.padStart(2, "0")}/${y}`);
const isoDate = (s: string) => usDate(s).replace(/(\d{2})\/(\d{2})\/(\d{4})/g, "$3-$1-$2");
const VARIANTS: Array<[string, string[], string[][], "same" | "decline"]> = [
  ["reordered columns", permute(NYF_HEAD, [2, 3, 0, 4, 1]), NYF_ROWS.map((r) => permute(r, [2, 3, 0, 4, 1])), "same"],
  ["renamed headers", ["Claim #", "DOS", "Claim type", "Payer", "Remittance date"], NYF_ROWS, "same"],
  ["extra columns (Created date, Amount)", [...NYF_HEAD, "Created", "Amount"], NYF_ROWS.map((r) => [...r, "Oct 1, 2026", "$125.00"]), "same"],
  ["US dates", NYF_HEAD, NYF_ROWS.map((r) => r.map(usDate)), "same"],
  ["ISO dates", NYF_HEAD, NYF_ROWS.map((r) => r.map(isoDate)), "same"],
  ["payer with plan suffix", NYF_HEAD, NYF_ROWS.map((r) => [r[0], r[1], r[2], r[3] + " · Bronze 6000", r[4]]), "same"],
  ["no Type column", ["Claim", "Date of service", "Billed to", "Remittance"], NYF_ROWS.map((r) => [r[0], r[1], r[3], r[4]]), "decline"],
  ["no headers", [], NYF_ROWS, "decline"],
  ["empty table", NYF_HEAD, [], "decline"],
  ["unknown claim type", NYF_HEAD, NYF_ROWS.map((r) => [r[0], r[1], "Replacement", r[3], r[4]]), "decline"],
  ["two claims on each date, different payers", NYF_HEAD, NYF_ROWS.flatMap((r) => [r, [r[0] + "1", r[1], r[2], "Medicare", r[4]]]), "decline"],
  ["remittance cell unreadable", NYF_HEAD, NYF_ROWS.map((r) => [r[0], r[1], r[2], r[3], r[2] === "Original" ? r[4] : "see attached EOB"]), "decline"],
];
for (const [name, head, rows, expect] of VARIANTS) {
  const s = snapOf(withNotYetFiled(insDoc, head, rows));
  for (const [dos, want] of FILING_CASES) {
    const got = answerFiling(s, dos);
    if (expect === "same") eq(got, want, `variant "${name}" ${dos}`);
    else ok(got === "DECLINE" || (name === "unknown claim type" && false) || (name === "remittance cell unreadable" && got === want), `variant "${name}" ${dos}: got ${got}, want decline${name === "remittance cell unreadable" ? " (or the Original answer)" : ""}`);
  }
}
declines(R.parseNotYetFiled(snapOf(withNotYetFiled(insDoc, [], [], { emptyState: true })), "2026-08-31"), "empty-state list");

section("payer terms variants");
function payerVariant(mut: (t: HTMLTableElement, d: Document) => void): Document {
  const d = clone(payerDoc); const t = [...d.querySelectorAll("table")].find((x) => /Claim filing/.test(x.querySelector("caption")?.textContent || "")) as HTMLTableElement; mut(t, d); return d;
}
const reorderTable = (t: HTMLTableElement, p: number[]) => { for (const tr of t.querySelectorAll("tr")) { const cs = [...tr.children]; cs.forEach((c) => c.remove()); p.forEach((i) => tr.appendChild(cs[i])); } };
const terms = (d: Document) => R.parseFilingTermsPage(snapOf(d), "Tallgrass Health Plan");
eq(terms(payerVariant((t) => reorderTable(t, [3, 1, 0, 2]))), TALLGRASS, "terms: reordered columns");
eq(terms(payerVariant((t) => { const th = t.querySelectorAll("th"); th[0].textContent = "Effective date"; th[1].textContent = "Original"; th[2].textContent = "Secondary"; th[3].textContent = "Corrected"; })), TALLGRASS, "terms: renamed headers");
eq(terms(payerVariant((t) => { t.querySelector("thead tr")!.insertAdjacentHTML("beforeend", "<th>Notes</th>"); t.querySelector("tbody tr")!.insertAdjacentHTML("beforeend", "<td>Per 2022 contract</td>"); })), TALLGRASS, "terms: extra column");
eq(terms(payerVariant((t) => { t.querySelector("tbody td")!.textContent = "07/01/2022"; })), TALLGRASS, "terms: US effective date");
declines(terms(payerVariant((t) => { t.querySelectorAll("tbody td")[1].textContent = "150 business days from the date of service"; })), "terms: business days");
declines(terms(payerVariant((t) => { t.querySelector("thead tr")!.insertAdjacentHTML("beforeend", "<th>Ended</th>"); t.querySelector("tbody tr")!.insertAdjacentHTML("beforeend", "<td>Dec 31, 2025</td>"); })), "terms: a set with an end date");
declines(terms(payerVariant((t) => { t.querySelectorAll("tbody td")[1].textContent = "1 year from the date of service"; })), "terms: limit in years");
declines(terms(payerVariant((t) => { t.querySelector("thead th")!.textContent = "Status"; })), "terms: no Effective column");
eq(terms(payerVariant((t) => { t.querySelectorAll("tbody td")[1].textContent = "12 months from the date of service"; })), [{ effectiveISO: "2022-07-01", originalMonths: 12, secondaryDays: 90, correctedDays: 365 }], "terms: Original limit in months");
eq(terms(payerVariant((t, d) => { const box = t.parentElement!; t.remove(); box.innerHTML = "<p>No claim filing terms on file</p>"; })), [], "terms: explicit empty-state → no terms (→ NO_FILING_TERMS)");


// ════════ run 146: the REAL Set 1 not-yet-filed header row ════════
// Captured verbatim in run-146-set1.log (11 filing skips): "Claim number | Date of service | Visit | Claim type |
// Bill to | Charge | Primary payer remittance | Original claim remittance". "Date of service" and "Visit" both
// matched the DOS synonyms (col → -2), and the two remittance columns are per type (message n=150: Secondary
// counts from the PRIMARY payer's remittance, Corrected from the ORIGINAL claim's remittance).
section("not-yet-filed: Set 1 header row (run 146)");
const SET1_NYF_HEAD = ["Claim number", "Date of service", "Visit", "Claim type", "Bill to", "Charge", "Primary payer remittance", "Original claim remittance"];
const set1Row = (r: Row, opts: { swap?: boolean; visit?: string } = {}): string[] => {
  const prim = r[2] === "Secondary" ? r[4] : "—", orig = r[2] === "Corrected" ? r[4] : "—";
  return [r[0], r[1], opts.visit ?? "Office visit", r[2], r[3], "$125.00", opts.swap ? orig : prim, opts.swap ? prim : orig];
};
const set1Doc = withNotYetFiled(insDoc, SET1_NYF_HEAD, NYF_ROWS.map((r) => set1Row(r)));
for (const [dos, want, m] of FILING_CASES) eq(answerFiling(snapOf(set1Doc), dos), want, `Set 1 headers ${dos}: ${m}`);
// the Visit column carrying a (different) date never replaces Date of service
for (const [dos, want, m] of FILING_CASES) eq(answerFiling(snapOf(withNotYetFiled(insDoc, SET1_NYF_HEAD, NYF_ROWS.map((r) => set1Row(r, { visit: "Jan 2, 2020" })))), dos), want, `Set 1 headers, dated Visit column ${dos}: ${m}`);
// reordered Set 1 columns
const P8 = [7, 3, 1, 0, 6, 4, 2, 5];
for (const [dos, want, m] of FILING_CASES) eq(answerFiling(snapOf(withNotYetFiled(insDoc, permute(SET1_NYF_HEAD, P8), NYF_ROWS.map((r) => permute(set1Row(r), P8)))), dos), want, `Set 1 headers reordered ${dos}: ${m}`);
// remittance dates in the WRONG type's column: a Secondary/Corrected claim must not borrow the other anchor's date
for (const [dos, want] of FILING_CASES) {
  const got = answerFiling(snapOf(withNotYetFiled(insDoc, SET1_NYF_HEAD, NYF_ROWS.map((r) => set1Row(r, { swap: true })))), dos);
  const type = NYF_ROWS.find((r) => isoDate(r[1]) === dos)?.[2];
  if (type === "Original" || dos === "2022-03-01") eq(got, want, `swapped remittance columns, Original ${dos} unaffected`);
  else eq(got, "DECLINE", `swapped remittance columns, ${type} ${dos} → decline (its own column says —)`);
}
// only a Primary-remittance column, Corrected claim → decline (the original claim's remittance is not shown)
eq(answerFiling(snapOf(withNotYetFiled(insDoc, SET1_NYF_HEAD.slice(0, 7), NYF_ROWS.map((r) => set1Row(r).slice(0, 7)))), "2026-01-09"), "DECLINE", "Corrected claim without an original-remittance column → decline");
// two Date-of-service-like columns → decline
eq(answerFiling(snapOf(withNotYetFiled(insDoc, [...SET1_NYF_HEAD, "Service date"], NYF_ROWS.map((r) => [...set1Row(r), r[1]]))), "2026-08-31"), "DECLINE", "Date of service + Service date → decline");

// ════════ (a) hand-verified: good faith ════════
section("good-faith pages (recon)");
// Insurance: Primary insurance = Tallgrass Health Plan / Bronze 6000 / member ID → insured.
eq(R.parseInsuranceStatus(snapOf(insDoc)), { insured: true, payer: "Tallgrass Health Plan" }, "recon insurance page → insured");
if (dump) eq(R.parseInsuranceStatus(snapOf(page(dump, "/patients/{id}/insurance"))), { insured: true, payer: "Tallgrass Health Plan" }, "second dump insurance page → insured");
const uninsured = (() => { const d = clone(insDoc); const sec = h2(d, /Primary insurance/).closest("section")!; sec.querySelector("div")!.innerHTML = "<p>No insurance on file</p>"; return d; })();
eq(R.parseInsuranceStatus(snapOf(uninsured)), { insured: false }, "'No insurance on file' with coverage rows still listed → uninsured (the chart's own registration decides)");
declines(R.parseInsuranceStatus(snapOf((() => { const d = clone(insDoc); h2(d, /Primary insurance/).closest("section")!.insertAdjacentHTML("beforeend", "<p>No insurance on file</p>"); return d; })())), "payer AND 'no insurance' → decline");
eq(R.parseInsuranceStatus(snapOf((() => { const d = clone(insDoc); h2(d, /Primary insurance/).querySelector("span")!.textContent = "Insurance on file"; return d; })())), { insured: true, payer: "Tallgrass Health Plan" }, "renamed heading 'Insurance on file' → insured");

// Notes (recon page 1: 10 of 33 notes, none about paying) → bodies without the header line.
const notesDoc = page(recon, "/patients/{id}/notes");
const nb = R.noteBodies(snapOf(notesDoc));
ok(!R.isDecline(nb) && nb.length === 10 && nb[0].startsWith("Annual review completed") && !/Amy Fuller|3:50 PM/.test(nb[0]), "notes: 10 bodies, header (author/time) stripped");
eq(snapOf(notesDoc).pagers.find((p) => /notes/.test(p)), "Showing 1 to 10 of 33 notes", "notes pager read");
if (!R.isDecline(nb)) eq(R.notesDecision(nb, "2026-10-27"), "insured", "routine notes → insured");
const ND: Array<[string, "insured" | "decline", string]> = [
  ["Patient chose to pay for the 2026-10-27 visit herself; do not bill insurance.", "decline", "self-pay naming the date (ISO)"],
  ["Pt will self-pay for her October 27 appointment.", "decline", "self-pay naming the date (written, no year)"],
  ["Self-pay for 10/27, insurance not to be billed.", "decline", "self-pay naming the date (m/d)"],
  ["Asked about the self-pay price for the 2026-11-03 visit, decided to use insurance.", "insured", "look-alike: different date"],
  ["Mother will self-pay for her own visit on 2026-09-02.", "insured", "look-alike: someone else, different date"],
  ["Patient wants to pay cash for this visit.", "decline", "self-pay with no date (vague) → decline"],
  ["Called about directions to the clinic.", "insured", "unrelated note"],
  ["Patient was self-pay last year; insurance is billed now.", "insured", "used to be self-pay, no date named"],
];
for (const [body, want, m] of ND) { const r = R.notesDecision([body], "2026-10-27"); ok(want === "insured" ? r === "insured" : R.isDecline(r), `notes decision: ${m}`); }


// ════════ run 146: "No insurance on file" outside a recognised section (5 skips) ════════
section("insurance: registration empty-state (run 146)");
const noPrimary = (fill: (d: Document, box: Element) => void) => { const d = clone(insDoc); const sec = h2(d, /Primary insurance/).closest("section")!; const box = sec.parentElement!; sec.remove(); fill(d, box); return d; };
eq(R.parseInsuranceStatus(snapOf(noPrimary((d, box) => box.insertAdjacentHTML("afterbegin", `<div><svg aria-hidden="true"></svg><p>No insurance on file</p></div>`)))), { insured: false }, "headingless empty-state, coverage rows still listed → uninsured");
eq(R.parseInsuranceStatus(snapOf(noPrimary((d) => d.querySelector("header dl")!.insertAdjacentHTML("beforeend", `<div><dt>Insurance</dt><dd>No insurance on file</dd></div>`)))), { insured: false }, "chart header 'Insurance: No insurance on file' → uninsured");
eq(R.parseInsuranceStatus(snapOf(noPrimary((d, box) => box.insertAdjacentHTML("afterbegin", `<section><h2>Insurance</h2><div><p>No insurance on file</p></div></section>`)))), { insured: false }, "heading 'Insurance' → uninsured (already recognised)");
declines(R.parseInsuranceStatus(snapOf(noPrimary((d, box) => box.insertAdjacentHTML("afterbegin", `<section><h2>Secondary insurance</h2><div><p>No insurance on file</p></div></section>`)))), "empty-state under Secondary insurance → decline");
declines(R.parseInsuranceStatus(snapOf(noPrimary((d) => { const c = h2(d, /^Coverage$/).closest("section")!; c.insertAdjacentHTML("beforeend", `<p>No insurance on file</p>`); }))), "empty-state inside Coverage → decline");
declines(R.parseInsuranceStatus(snapOf(noPrimary((d) => { d.querySelector("table tbody td")!.textContent = "No insurance on file"; }))), "phrase as a table cell → decline");
declines(R.parseInsuranceStatus(snapOf(noPrimary((d, box) => box.insertAdjacentHTML("afterbegin", `<div><p>No insurance on file</p></div><div><p>No insurance on file</p></div>`)))), "phrase twice → decline");
declines(R.parseInsuranceStatus(snapOf(noPrimary((d, box) => box.insertAdjacentHTML("afterbegin", `<div><p>No insurance on file</p><dl><dt>Member ID</dt><dd>MQY483571043</dd></dl></div>`)))), "phrase next to a member ID → decline");
declines(R.parseInsuranceStatus(snapOf(noPrimary((d, box) => box.insertAdjacentHTML("afterbegin", `<section><h2>Previous insurance</h2><p>No insurance on file</p></section>`)))), "under Previous insurance → decline");
declines(R.parseInsuranceStatus(snapOf(noPrimary((d, box) => box.insertAdjacentHTML("afterbegin", `<div><p>No coverage on file</p></div>`)))), "'No coverage on file' alone (not the registration wording) → decline");

// ════════ run 146: notes naming the appointment's date (215, 222, 233) ════════
section("notes naming the date (run 146)");
const DN: Array<[string, string, "insured" | "selfpay" | "decline", string]> = [
  // 215 / 233 openings (captured) — the message's look-alike "The patient won't self-pay" → insured
  ["Emma will not self-pay for the visit on 5/7/2026. Insurance is to be billed.", "2026-05-07", "insured", "215: will not self-pay (US date)"],
  ["Megan will not self-pay for the visit on December 10, 2024. Insurance is to be billed.", "2024-12-10", "insured", "233: will not self-pay (written date)"],
  ["Patient won't self-pay for the 2026-03-04 appointment; bill insurance as usual.", "2026-03-04", "insured", "won't self-pay, ISO, paraphrase"],
  // 222 opening (captured) — a plain self-pay for this visit → the estimate is owed
  ["Self-pay for the 1/6/2025 appointment at the patient's request. Do not bill insurance.", "2025-01-06", "selfpay", "222: self-pay at the patient's request"],
  ["Patient chose to pay out of pocket for the 2026-03-04 visit. Insurance is not to be billed for this visit.", "2026-03-04", "selfpay", "chose to pay out of pocket, paraphrase"],
  ["Self-pay for the 3/4/2026 visit.", "2026-03-04", "selfpay", "self-pay only"],
  // run s3a item 220 (captured, Madison López): the date inside the clause, and "does not want insurance billed" in the same sentence
  ["Patient chose to pay for the visit on 1/9/2026 out of pocket and does not want insurance billed for it.", "2026-01-09", "selfpay", "s3a 220: pay for the visit on <date> out of pocket, and insurance not billed"],
  ["Patient chose to pay for the visit on January 9, 2026 out of pocket and doesn't want insurance billed.", "2026-01-09", "selfpay", "s3a 220 paraphrase: written date, doesn't want"],
  ["Pt decided to pay for the appointment on 2026-01-09 themselves. Insurance is not to be billed for the visit.", "2026-01-09", "selfpay", "s3a 220 paraphrase: ISO date, two sentences"],
  // hard negatives / ambiguous → decline (never a guess)
  ["Patient chose to pay for the visit on 1/9/2026 out of pocket and does want insurance billed for it.", "2026-01-09", "decline", "s3a 220 mutation: 'does want insurance billed' is not a recognised clause"],
  ["Patient chose to pay for the visit on 1/9/2026 out of pocket but later decided to use insurance.", "2026-01-09", "decline", "s3a 220 mutation: changed mind"],
  ["Patient chose to pay for the visit on 1/9/2026 out of pocket and will use insurance for it.", "2026-01-09", "decline", "s3a 220 mutation: second clause says insurance"],
  ["Patient chose to pay for the visit on 1/9/2026 out of pocket and does not want insurance billed for the 1/16/2026 visit.", "2026-01-09", "decline", "s3a 220 mutation: another date"],
  ["Self-pay for the 1/6/2025 appointment at the patient's request. Do not bill Tallgrass.", "2025-01-06", "decline", "unrecognised second sentence"],
  ["Daughter will self-pay for her visit on 1/6/2025.", "2025-01-06", "decline", "someone else's self-pay"],
  ["Asked about the self-pay price for the 1/6/2025 visit, decided to use insurance.", "2025-01-06", "decline", "price question (look-alike) → decline, not a guess"],
  ["Self-pay for the 1/6/2025 appointment. Insurance is to be billed.", "2025-01-06", "decline", "self-pay AND insurance billed → mixed"],
  ["Emma will not self-pay for the visit on 5/7/2026 but will self-pay on 5/21/2026.", "2026-05-07", "decline", "another date named"],
  ["Was self-pay for the 1/6/2025 visit until insurance started; insurance is billed now.", "2025-01-06", "decline", "used to be self-pay"],
  ["Emma will not self-pay for the visit on 5/7/2026 and her mother will.", "2026-05-07", "decline", "family member mentioned"],
];
for (const [body, date, want, m] of DN) { const r = R.notesDecision([body], date); ok(want === "decline" ? R.isDecline(r) : r === want, `dated note: ${m}: got ${JSON.stringify(r)}`); }
ok(R.isDecline(R.notesDecision(["Self-pay for the 1/6/2025 appointment.", "Patient will not self-pay for the visit on 1/6/2025. Insurance is to be billed."], "2025-01-06")), "two dated notes disagree → decline");

// Appointment detail (recon): Visit Oct 14, 2026 9:30 AM CDT at Riverbend; Booked on Oct 1, 2026; History:
// "Start time moved …" on Oct 6, 2026 → scheduling date = the most recent move = 2026-10-06.
const detDoc = page(recon, "/patients/{id}/appointments/{id}");
eq(R.parseAppointmentDetail(snapOf(detDoc), "2026-10-14", "09:30"), { location: "Riverbend", schedulingISO: "2026-10-06" }, "recon appointment detail → Riverbend, scheduled 2026-10-06 (moved)");
if (dump) eq(R.parseAppointmentDetail(snapOf(page(dump, "/patients/{id}/appointments/{id}")), "2026-10-14", "09:30"), { location: "Riverbend", schedulingISO: "2026-10-06" }, "second dump appointment detail");
declines(R.parseAppointmentDetail(snapOf(detDoc), "2026-10-14", "13:30"), "detail: different time asked");
declines(R.parseAppointmentDetail(snapOf(detDoc), "2026-10-11", "09:30"), "detail: different date asked");
const detVariant = (f: (d: Document) => void) => { const d = clone(detDoc); f(d); return snapOf(d); };
// the history's own "2 entries" count must follow a variant's row count (listFooter.isComplete declines a disagreement)
const setEntries = (d: Document, n: number) => { const e = [...d.querySelectorAll("*")].find((x) => x.children.length === 0 && /^2 entries$/.test((x.textContent || "").trim())); if (e) e.textContent = `${n} ${n === 1 ? "entry" : "entries"}`; };
declines(R.parseAppointmentDetail(detVariant((d) => { d.querySelectorAll("dd").forEach((dd) => { if (/Oct 1, 2026, 6:03 PM/.test(dd.textContent || "")) dd.innerHTML = dd.innerHTML.replace(/CDT/, "MDT"); }); }), "2026-10-14", "09:30"), "detail: booking shown in another time zone");
declines(R.parseAppointmentDetail(detVariant((d) => { const td = [...d.querySelectorAll("td")].find((x) => /Booked/.test(x.textContent || ""))!; td.textContent = "Time zone changed"; }), "2026-10-14", "09:30"), "detail: unknown history entry that may change the time");
eq(R.parseAppointmentDetail(detVariant((d) => { const tr = [...d.querySelectorAll("tbody tr")].find((x) => /moved/.test(x.textContent || ""))!; tr.remove(); setEntries(d, 1); }), "2026-10-14", "09:30"), { location: "Riverbend", schedulingISO: "2026-10-01" }, "detail without a move → booked date 2026-10-01");
declines(R.parseAppointmentDetail(detVariant((d) => { const tr = [...d.querySelectorAll("tbody tr")].find((x) => /moved/.test(x.textContent || ""))!; tr.remove(); }), "2026-10-14", "09:30"), "detail: history says 2 entries but shows 1 row → not a complete history");
eq(R.parseAppointmentDetail(detVariant((d) => { const tr = [...d.querySelectorAll("tbody tr")].find((x) => /Booked/.test(x.textContent || ""))!; tr.insertAdjacentHTML("afterend", `<tr><td>Oct 3, 2026, 9:00 AM CDT</td><td>cray</td><td>Status changed from Scheduled to Confirmed</td></tr>`); setEntries(d, 3); }), "2026-10-14", "09:30"), { location: "Riverbend", schedulingISO: "2026-10-06" }, "detail: a status change does not move the scheduling date");
const hist = (d: Document) => [...d.querySelectorAll("table")].find((t) => /History/.test(t.querySelector("caption")?.textContent || ""))!;
eq(R.parseAppointmentDetail(detVariant((d) => reorderTable(hist(d) as HTMLTableElement, [2, 0, 1])), "2026-10-14", "09:30"), { location: "Riverbend", schedulingISO: "2026-10-06" }, "detail: history columns reordered");

// Clinic calendar (recon /settings: 2026, page 1 of 4 = Jan 1 … May 18).
section("clinic calendar (recon)");
const calDoc = page(recon, "/settings");
const calTable = (d: Document) => snapOf(d).sections.flatMap((s) => s.tables).find((t) => /Closure dates/.test(t.caption))!;
const cal1 = R.parseCalendarTable(calTable(calDoc));
ok(!R.isDecline(cal1) && cal1.length === 25, "calendar page 1: 25 rows");
const KNOWN = ["Northgate", "Front Range", "Eastside", "Stonebrook", "Lakeside", "Riverbend", "Highline", "Prairie View", "Cedar Hollow", "Willow Creek"];
// Riverbend on page 1: Jan 1 (All locations, Active), Jan 2 (Riverbend, Active), Apr 29 (Riverbend, WITHDRAWN →
// not a closure), May 18 (Riverbend, Active). Front Range's Withdrawn Jan 1 and other locations' rows don't count.
if (!R.isDecline(cal1)) {
  eq(R.closuresFor(cal1, "Riverbend", KNOWN), ["2026-01-01", "2026-01-02", "2026-05-18"], "Riverbend closures (Withdrawn Apr 29 excluded)");
  eq(R.closuresFor(cal1, "Northgate", KNOWN), ["2026-01-01", "2026-01-08", "2026-05-06"], "Northgate closures");
  declines(R.closuresFor(cal1, "Downtown", KNOWN), "a location not on the calendar's list");
  // Hand case 1 — uninsured, scheduled Wed 2025-12-31, appointment Wed 2026-01-14 at Riverbend:
  // after Dec 31: Jan 1 Thu (All locations, closed), Jan 2 Fri (Riverbend closed), Jan 5 6 7 8 9 (Jan 8 is
  // Northgate's closure, open here), Jan 12 13 14 → 8 business days → 3–9 band → first business day after
  // the scheduling date = Mon 2026-01-05.
  const gf = (loc: string, sched: string, appt: string) => { const cl = R.closuresFor(cal1, loc, KNOWN); return R.isDecline(cl) ? "DECLINE" : decideGoodFaith({ owedEstimate: true, schedulingDateISO: sched, apptDateISO: appt, closuresISO: cl, bands: R.isDecline(gp) ? undefined : gp.bands }); };
  eq(gf("Riverbend", "2025-12-31", "2026-01-14"), "2026-01-05", "hand case: Riverbend, Jan 1 + Jan 2 closed → 2026-01-05");
  // Same dates at Northgate: Jan 1 closed, Jan 2 open, Jan 8 closed → Jan 2,5,6,7,9,12,13,14 = 8 → first = Fri 2026-01-02.
  eq(gf("Northgate", "2025-12-31", "2026-01-14"), "2026-01-02", "hand case: Northgate → 2026-01-02 (Riverbend-only closure ignored)");
  // Hand case 2 — scheduled Fri 2026-04-24, appointment Mon 2026-05-11 at Riverbend: Apr 27 28 29 (the Apr 29
  // closure is Withdrawn → open) 30, May 1, 4 5 6 (Northgate's closure) 7 8 11 → 11 business days → 10+ band →
  // third business day after = Wed 2026-04-29.
  eq(gf("Riverbend", "2026-04-24", "2026-05-11"), "2026-04-29", "hand case: Withdrawn closure counts as open → 2026-04-29");
  // Hand case 3 — scheduled Thu 2026-05-14 for Tue 2026-05-19 at Riverbend: May 15 (Fri), May 18 (Riverbend
  // closed), May 19 → 2 business days → NOT_REQUIRED:SHORT_NOTICE.
  eq(gf("Riverbend", "2026-05-14", "2026-05-19"), "NOT_REQUIRED:SHORT_NOTICE", "hand case: closure drops it to 2 → short notice");
}
section("calendar variants");
const calVariant = (f: (t: HTMLTableElement) => void) => { const d = clone(calDoc); const t = [...d.querySelectorAll("table")].find((x) => /Closure dates/.test(x.querySelector("caption")?.textContent || "")) as HTMLTableElement; f(t); const r = R.parseCalendarTable(calTable(d)); return R.isDecline(r) ? r : R.closuresFor(r, "Riverbend", KNOWN); };
const RIVER = ["2026-01-01", "2026-01-02", "2026-05-18"];
eq(calVariant((t) => reorderTable(t, [3, 2, 1, 0])), RIVER, "calendar: reordered columns");
eq(calVariant((t) => { const th = t.querySelectorAll("th"); th[2].textContent = "Location"; th[3].textContent = "State"; }), RIVER, "calendar: renamed headers");
eq(calVariant((t) => { t.querySelector("thead tr")!.insertAdjacentHTML("beforeend", "<th>Notes</th>"); t.querySelectorAll("tbody tr").forEach((tr) => tr.insertAdjacentHTML("beforeend", "<td>—</td>")); }), RIVER, "calendar: extra column");
eq(calVariant((t) => t.querySelectorAll("tbody tr").forEach((tr) => { const td = tr.querySelector("td")!; td.textContent = usDate(td.textContent || ""); })), RIVER, "calendar: US dates");
eq(calVariant((t) => t.querySelectorAll("tbody tr").forEach((tr) => { const td = tr.querySelector("td")!; td.textContent = isoDate(td.textContent || ""); })), RIVER, "calendar: ISO dates");
eq(calVariant((t) => t.querySelectorAll("tbody tr").forEach((tr) => tr.remove())), [], "calendar: empty table → no closures (page complete)");
declines(calVariant((t) => { t.querySelectorAll("tbody tr")[0].querySelectorAll("td")[3].textContent = "Pending"; }), "calendar: unknown status");
declines(calVariant((t) => { t.querySelectorAll("tbody tr")[2].querySelectorAll("td")[2].textContent = "Riverbend Annex"; }), "calendar: applies to an unknown location");
declines(calVariant((t) => { t.querySelector("thead th")!.textContent = "Reason"; }), "calendar: no date column");

// ════════ (d) end-to-end with a fake crawler ════════
section("end-to-end (fake crawler)");
type St = { idx: number; sized: boolean; year: string | null; more: number };
type Route = (st: St) => Document | null;
class FakeCrawler {
  st: St = { idx: 0, sized: false, year: null, more: 0 }; route: Route | null = null; doc: Document = dom("<body></body>");
  constructor(public routes: Record<string, Route>, start: string) { this.go(start); }
  private go(path: string) { const p = path.split("?")[0]; this.route = this.routes[p] ?? null; this.st = { idx: 0, sized: false, year: null, more: 0 }; this.doc = this.route?.(this.st) ?? dom("<body><h1>Not found</h1></body>"); return !!this.route; }
  async navTo(path: string) { return this.go(path); }
  async breakGlass() { return true; }
  async evalApp<T>(expr: string): Promise<T> {
    if (expr === SNAPSHOT_JS) return snapshotOf(this.doc) as T;
    const refresh = () => { const d = this.route?.(this.st); if (!d) return false; this.doc = d; return true; };
    if (expr.includes("HTMLSelectElement")) {
      const name = JSON.parse(expr.match(/===("(?:[^"\\]|\\.)*")/)![1]), value = JSON.parse(expr.match(/d\.call\(s,("(?:[^"\\]|\\.)*")\)/)![1]);
      if (name === "size") { this.st.sized = true; this.st.idx = 0; } else if (name === "year") { this.st = { idx: 0, sized: false, year: value, more: 0 }; }
      return refresh() as T;
    }
    if (/more\\\\b|more\\b/.test(expr) && /show\|load/.test(expr)) { this.st.more++; if (!refresh()) { this.st.more--; return false as T; } return true as T; }
    if (/Next/.test(expr)) { this.st.idx++; if (!refresh()) { this.st.idx--; return false as T; } return true as T; }
    throw new Error("fake crawler: unexpected script " + expr.slice(0, 80));
  }
}
const P = "/patients/73284k4465";
const demoDoc = page(recon, "/patients/{id}");
const payersDoc = page(recon, "/payers");

// Filing end-to-end: chart → Insurance tab (by its nav label) → not-yet-filed row → Payers list → Tallgrass → terms.
R.resetFamilyCaches();
const fakeF = new FakeCrawler({ [P]: () => demoDoc, [`${P}/insurance`]: () => nyfDoc, "/payers": () => payersDoc, "/payers/2hl10z2zf2": () => payerDoc }, P);
(async () => {
  for (const [dos, want, m] of FILING_CASES) {
    const r = await R.readFiling(fakeF as any, P, dos);
    if (R.isDecline(r)) { ok(false, `e2e filing ${dos}: declined ${r.decline}`); continue; }
    const v = decideFiling({ todayISO: policy!.todayISO, officeClosedISO: policy!.closedISO, type: r.type, serviceDateISO: dos, primaryRemitISO: r.type === "Secondary" ? r.remitISO : null, originalRemitISO: r.type === "Corrected" ? r.remitISO : null, termsSets: r.terms });
    eq(v, want, `e2e filing ${dos}: ${m}`);
  }
  // Through the solver, with the Set 1 queue's messages: today/holidays/answer set come from message 150.
  const store = new MessageStore(compiler);
  for (const it of items) if (it.kind === "message") await store.ingest(it.text);
  R.resetFamilyCaches();
  const idxF: ClinicIndex = { findPatient: () => null, appointments: [], providers: new Map(), byDate: () => [],
    filingContext: async (_n, _d, dos) => { const r = await R.readFiling(fakeF as any, P, dos); return R.isDecline(r) ? null : { todayISO: "", type: r.type, serviceDateISO: dos, primaryRemitISO: r.type === "Secondary" ? r.remitISO : null, originalRemitISO: r.type === "Corrected" ? r.remitISO : null, termsSets: r.terms, payer: r.payer }; } };
  for (const [dos, want] of FILING_CASES) { const m = familyMatch(`Filing deadline for Elena Johnson, DOS ${dos}?`)!; eq(await solveFamily(m, idxF, store), want, `solver filing ${dos}`); }
  eq(await solveFamily(familyMatch("Filing deadline for Elena Johnson, DOS 2026-10-20?")!, idxF, store), null, "solver filing: DOS after today → skip");
  const noRule = new MessageStore(compiler);
  eq(await solveFamily(familyMatch("Filing deadline for Elena Johnson, DOS 2026-08-31?")!, idxF, noRule), null, "solver filing: no governing message → skip");
  R.resetFamilyCaches();
  const fakeNoPayer = new FakeCrawler({ [P]: () => demoDoc, [`${P}/insurance`]: () => withNotYetFiled(insDoc, NYF_HEAD, NYF_ROWS.map((r) => [r[0], r[1], r[2], "Acme Mutual", r[4]])), "/payers": () => payersDoc }, P);
  declines(await R.readFiling(fakeNoPayer as any, P, "2026-08-31"), "e2e filing: billed payer not on the payers list");

  // Good faith, uninsured: appointments tab ("Showing 15 of 17" + Show more) → detail → calendar 2025 + 2026.
  const apptsBase = dump ? page(dump, "/patients/{id}/appointments") : null;
  if (!apptsBase) { console.log("  (second dump not mounted: skipping the appointments-tab end-to-end)"); }
  else {
    const apptRow = (iso: string, disp: string, loc: string, href: string) => `<tr><td><a href="${href}"><time datetime="${iso}">${disp}</time></a> <span>CST</span></td><td>Office visit</td><td>Diana Diaz, DO</td><td>${loc}</td><td><span>Scheduled</span></td></tr>`;
    let endFooter: { text: string; keepMore?: boolean; dropRow?: boolean } | null = null;
    const appts = (n: number) => { const d = clone(apptsBase); const tb = d.querySelector("tbody")!; [...tb.children].slice(0, 15).forEach(() => {});
      if (n === 17) { tb.insertAdjacentHTML("beforeend", apptRow("2026-01-14T15:30:00Z", "Jan 14, 2026, 9:30 AM", "Riverbend", `${P}/appointments/target`)); tb.insertAdjacentHTML("beforeend", apptRow("2026-01-14T19:00:00Z", "Jan 14, 2026, 1:00 PM", "Riverbend", `${P}/appointments/other`)); }
      const p = [...d.querySelectorAll("p")].find((x) => /Showing 15 of 148/.test(x.textContent || ""))!; p.textContent = `Showing ${n} of 17 appointments`;
      if (n === 17 && endFooter) { p.textContent = endFooter.text; if (endFooter.dropRow) tb.lastElementChild!.remove(); }  // Set 1 n=219: the finished list says "20 appointments"
      if (n === 17 && !(endFooter && endFooter.keepMore)) d.querySelectorAll("button").forEach((b) => { if (/Show more/.test(b.textContent || "")) b.remove(); });
      return d; };
    const rows15 = apptsBase.querySelectorAll("tbody tr").length;
    ok(rows15 === 15, `second dump appointments tab has 15 rows (${rows15})`);
    // detail: the recon detail moved to Jan 14, 2026 9:30 AM CST, booked Dec 31, 2025 (no move).
    const det = clone(detDoc);
    det.querySelectorAll("dd").forEach((dd) => { dd.innerHTML = dd.innerHTML.replace("Oct 14, 2026", "Jan 14, 2026").replace(/9:30 AM to 10:15 AM <span([^>]*)>CDT/, "9:30 AM to 10:15 AM <span$1>CST").replace(/Oct 1, 2026, 6:03 PM<\/time> <span([^>]*)>CDT/, "Dec 31, 2025, 6:03 PM</time> <span$1>CST").replace(/Oct 6, 2026, 5:12 PM<\/time> <span([^>]*)>CDT/, "Dec 31, 2025, 6:03 PM</time> <span$1>CST"); });
    // the "moved" entry becomes a status change (not removed: the page's "2 entries" count must still equal its rows —
    // listFooter.isComplete declines a history whose count and rows disagree)
    [...det.querySelectorAll("tbody tr")].forEach((tr) => { if (/moved/.test(tr.textContent || "")) tr.querySelectorAll("td")[2].textContent = "Status changed from Scheduled to Confirmed"; else if (/Booked/.test(tr.textContent || "")) tr.querySelector("td")!.innerHTML = "<time>Dec 31, 2025, 6:03 PM</time> <span>CST</span>"; });
    const calYear = (year: string, rows: string[][], from: number, total: number, pageSize: number): Document => {
      const d = clone(calDoc); const t = [...d.querySelectorAll("table")].find((x) => /Closure dates/.test(x.querySelector("caption")?.textContent || ""))!;
      t.querySelector("caption")!.textContent = `Closure dates of ${year}, in date order`;
      t.querySelector("tbody")!.innerHTML = rows.slice(from, from + pageSize).map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("");
      const p = [...d.querySelectorAll("p")].find((x) => /Showing/.test(x.textContent || ""))!; p.textContent = total ? `Showing ${from + 1} to ${Math.min(from + pageSize, total)} of ${total} entries` : "No entries";
      d.querySelectorAll("#year option").forEach((o) => ((o as HTMLOptionElement).selected = o.textContent === year));
      return d; };
    const realRows2026 = [...calDoc.querySelectorAll("table tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent || ""));
    // Synthetic rest of 2026 (pages 2–4 were not captured): other locations only, plus one Riverbend
    // WITHDRAWN entry — they must not change the answer.
    const synth2026 = Array.from({ length: 73 }, (_, i) => { const m = 6 + Math.floor(i / 11), d = 1 + (i % 11) * 2; const dt = new Date(Date.UTC(2026, m - 1, d)); return [dt.toUTCString().slice(0, 3) + ", " + ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1] + ` ${d}, 2026`, "Staff training day", i === 5 ? "Riverbend" : "Highline", i === 5 ? "Withdrawn" : "Active"]; });
    const rows2026 = [...realRows2026, ...synth2026];
    const rows2025 = [["Thu, Dec 25, 2025", "Christmas Day", "All locations", "Active"], ["Wed, Dec 31, 2025", "Inventory", "Riverbend", "Active"]];
    const calRoute = (sizeWorks: boolean): Route => (st) => {
      const y = st.year ?? "2026"; const rows = y === "2026" ? rows2026 : y === "2025" ? rows2025 : [];
      const size = st.sized && sizeWorks ? 100 : 25; const from = st.idx * size;
      if (from > 0 && from >= rows.length) return null;
      return calYear(y, rows, from, rows.length, size);
    };
    const gfeRoutes = (o: { insurance: Document; sizeWorks?: boolean; notes?: Route }) => ({ [P]: () => demoDoc, [`${P}/insurance`]: () => o.insurance, [`${P}/appointments`]: ((st: St) => appts(st.more ? 17 : 15)) as Route, [`${P}/appointments/target`]: () => det, "/settings/clinic-calendar": calRoute(o.sizeWorks ?? true), "/settings": calRoute(o.sizeWorks ?? true), ...(o.notes ? { [`${P}/notes`]: o.notes } : {}) });
    // Expected: scheduling 2025-12-31 at Riverbend → closures Jan 1 (All), Jan 2 (Riverbend) → 8 business days → 2026-01-05.
    for (const sizeWorks of [true, false]) {
      R.resetFamilyCaches();
      const f = new FakeCrawler(gfeRoutes({ insurance: uninsured, sizeWorks }), P);
      const r = await R.readGoodFaith(f as any, P, "2026-01-14", "09:30");
      if (R.isDecline(r)) { ok(false, `e2e good-faith (page size ${sizeWorks ? "100" : "25 + Next"}): declined ${r.decline}`); continue; }
      ok(!r.insured && r.schedulingISO === "2025-12-31" && JSON.stringify(r.closuresISO) === JSON.stringify(["2025-12-25", "2025-12-31", "2026-01-01", "2026-01-02", "2026-05-18"]), `e2e good-faith reads (page size ${sizeWorks ? "100" : "25 + Next"}): ${JSON.stringify(r)}`);
      if (!r.insured) eq(decideGoodFaith({ owedEstimate: true, schedulingDateISO: r.schedulingISO, apptDateISO: "2026-01-14", closuresISO: r.closuresISO, bands: R.isDecline(gp) ? undefined : gp.bands }), "2026-01-05", "e2e good-faith answer");
    }
    // Set 1 n=219: after Show more the footer becomes the finished list's own count ("17 appointments").
    for (const [ef, want, m] of [
      [{ text: "17 appointments" }, "ok", "end-form footer with the exact total we were loading toward"],
      [{ text: "16 appointments" }, "decline", "end-form total differs from the Showing N of 17 total"],
      [{ text: "18 appointments" }, "decline", "end-form total larger than the one we loaded toward"],
      [{ text: "about 17 appointments" }, "decline", "end-form estimate never proves an end"],
      [{ text: "17+ appointments" }, "decline", "end-form lower bound never proves an end"],
      [{ text: "17 appointments", dropRow: true }, "decline", "end-form total not matched by the rows read (16 rows)"],
      [{ text: "17 appointments", keepMore: true }, "decline", "end-form footer but a Show more control is still on the page"],
      [{ text: "No appointments" }, "decline", "list claims to be empty after Show more"],
    ] as Array<[{ text: string; keepMore?: boolean; dropRow?: boolean }, string, string]>) {
      endFooter = ef; R.resetFamilyCaches();
      const r = await R.readGoodFaith(new FakeCrawler(gfeRoutes({ insurance: uninsured }), P) as any, P, "2026-01-14", "09:30");
      if (want === "ok") ok(!R.isDecline(r) && !r.insured && r.schedulingISO === "2025-12-31", `e2e good-faith: ${m}: ${JSON.stringify(r).slice(0, 100)}`);
      else ok(R.isDecline(r), `e2e good-faith must decline: ${m}: ${JSON.stringify(r).slice(0, 100)}`);
    }
    endFooter = null;
    R.resetFamilyCaches();
    declines(await R.readGoodFaith(new FakeCrawler(gfeRoutes({ insurance: uninsured }), P) as any, P, "2026-01-14", "10:00"), "e2e good-faith: no appointment at that time");
    R.resetFamilyCaches();
    const fakeG = new FakeCrawler(gfeRoutes({ insurance: uninsured }), P);
    const idxG: ClinicIndex = { findPatient: () => null, appointments: [], providers: new Map(), byDate: () => [],
      goodFaithContext: async (_n, _d, date, time) => { const r = await R.readGoodFaith(fakeG as any, P, date, time); return R.isDecline(r) ? null : r.insured ? { owedEstimate: false, schedulingDateISO: date, apptDateISO: date, closuresISO: [] } : { owedEstimate: true, schedulingDateISO: r.schedulingISO, apptDateISO: date, closuresISO: r.closuresISO }; } };
    eq(await solveFamily(familyMatch("Good faith estimate question: Johnson, Elena, born 2000-10-02, 09:30 on 2026-01-14. Is one required, and if so, when's it due?")!, idxG, store), "2026-01-05", "solver good-faith (Set 1 phrasing, 24-hour time)");
    eq(await solveFamily(familyMatch("When's the GFE due for Elena Johnson's 9:30 AM appointment on 01/14/2026?")!, idxG, store), "2026-01-05", "solver good-faith (paraphrase, AM/PM time, US date)");
    // Insured: every note page is read (10 → 25 per page → Next), and a self-pay note on the LAST page decides.
    const notesPage = (bodies: string[], from: number, total: number) => { const d = clone(notesDoc); const ul = d.querySelector("ul[aria-label]")!; const tmpl = ul.querySelector("li")!.outerHTML;
      ul.innerHTML = bodies.map((b) => tmpl.replace(/<p([^>]*)>[^<]*<\/p>/, `<p$1>${b}</p>`)).join("");
      const p = [...d.querySelectorAll("p")].find((x) => /Showing/.test(x.textContent || ""))!; p.textContent = `Showing ${from + 1} to ${from + bodies.length} of ${total} notes`; return d; };
    const routine = Array.from({ length: 33 }, (_, i) => `Routine follow-up note ${i + 1}. No changes.`);
    const notesRoute = (all: string[]): Route => (st) => { const size = st.sized ? 25 : 10; const from = st.idx * size; if (from > 0 && from >= all.length) return null; return notesPage(all.slice(from, from + size), from, all.length); };
    R.resetFamilyCaches();
    eq(await R.readGoodFaith(new FakeCrawler(gfeRoutes({ insurance: insDoc, notes: notesRoute(routine) }), P) as any, P, "2026-01-14", "09:30"), { insured: true }, "e2e insured: all 33 notes read, none self-pay → insured");
    R.resetFamilyCaches();
    // the note makes THIS visit self-pay (message n=198) → the estimate is owed: same reads as the uninsured case above
    { const r = await R.readGoodFaith(new FakeCrawler(gfeRoutes({ insurance: insDoc, notes: notesRoute([...routine.slice(0, 32), "Patient chose to self-pay for the 2026-01-14 visit; do not bill insurance."]) }), P) as any, P, "2026-01-14", "09:30");
      ok(!R.isDecline(r) && !r.insured && r.schedulingISO === "2025-12-31", `e2e insured + self-pay note on the last page (note 33) is seen → estimate owed (the 151 reader read page 1 only): ${JSON.stringify(r).slice(0, 120)}`); }
    declines(await R.readGoodFaith(new FakeCrawler(gfeRoutes({ insurance: insDoc, notes: notesRoute([...routine.slice(0, 32), "Patient may self-pay for the 2026-01-14 visit; check with billing."]) }), P) as any, P, "2026-01-14", "09:30"), "e2e insured: unclear self-pay note on the last page → decline");
  }

  // ════════ (b) routing: paraphrases + hard negatives ════════
  section("routing");
  const FILING_PARA: Array<[string, Record<string, string>]> = [
    ["What's the last day we can submit the claim for Maria Gonzalez (DOB 03/14/1982) for her visit on 07/02/2026?", { name: "Maria Gonzalez", dob: "1982-03-14", dos: "2026-07-02" }],
    ["Deadline to file the claim for Okafor, Chidi, born March 3, 1990, service on 2026-04-15.", { name: "Okafor, Chidi", dob: "1990-03-03", dos: "2026-04-15" }],
    ["How long do we have to bill Tallgrass for Priya Natarajan's 2026-09-01 visit? It hasn't been sent yet.", { name: "Priya Natarajan", dos: "2026-09-01" }],
    ["Hi, the 5/20/2026 encounter for Ruiz, Daniel (DOB 1975-11-30) is still on the not-yet-filed list. By when does it need to go out?", { name: "Ruiz, Daniel", dob: "1975-11-30", dos: "2026-05-20" }],
    ["Until when can we still file for Wei Chen's appointment on October 2, 2026?", { name: "Wei Chen", dos: "2026-10-02" }],
    ["Timely filing cutoff for patient Abigail Turner, date of service 2026-08-19?", { name: "Abigail Turner", dos: "2026-08-19" }],
  ];
  for (const [q, slots] of FILING_PARA) { const m = familyMatch(q); eq(m && { family: m.family, slots: m.slots }, { family: "filing-deadline", slots }, `filing paraphrase: ${q.slice(0, 60)}`); }
  const GFE_PARA: Array<[string, Record<string, string>]> = [
    ["Do we need to give Jamal Brooks a good faith estimate for his 3:15 PM visit on 2026-11-04, and if so by what date?", { name: "Jamal Brooks", date: "2026-11-04", time: "15:15" }],
    ["GFE due date for Thompson, Rachel (DOB 09/09/1988), appointment 12/01/2026 at 10:40?", { name: "Thompson, Rachel", dob: "1988-09-09", date: "2026-12-01", time: "10:40" }],
    ["When does the good-faith estimate have to go out for Luis Ortega, born 1961-02-17? He's booked 2026-10-29 at 08:00.", { name: "Luis Ortega", dob: "1961-02-17", date: "2026-10-29", time: "08:00" }],
    ["Is a good faith estimate required for Nora Fitzgerald's appointment on Jan 12, 2027 at 1:30 pm?", { name: "Nora Fitzgerald", date: "2027-01-12", time: "13:30" }],
    ["Front desk: Patel, Arjun, DOB 2001-07-07, 16:45 on 2026-12-15. By when must the good faith estimate be given?", { name: "Patel, Arjun", dob: "2001-07-07", date: "2026-12-15", time: "16:45" }],
  ];
  for (const [q, slots] of GFE_PARA) { const m = familyMatch(q); eq(m && { family: m.family, slots: m.slots }, { family: "good-faith-estimate", slots }, `good-faith paraphrase: ${q.slice(0, 60)}`); }
  const NEG = [
    "When was the claim for Maria Gonzalez's 2026-07-02 visit filed?",
    "What's the appeal deadline for the claim for Okafor, Chidi, DOS 2026-04-15?",
    "Next step on the claim for Wei Chen, service date 2026-10-02, the remittance came back denied.",
    "Did we send the good faith estimate to Jamal Brooks for 2026-11-04?",
    "How much was the good faith estimate for Luis Ortega's 2026-10-29 visit?",
    "What's still owed on invoice 12345678 for Priya Natarajan, service date 2026-09-01?",
    "Can we still file a complaint about the 2026-10-02 visit for Wei Chen?",
    "When is Wei Chen's next appointment after 2026-10-02?",
    "Was the claim for Abigail Turner's 2026-08-19 visit paid?",
  ];
  for (const q of NEG) { const f = familyMatch(q)?.family; ok(f !== "filing-deadline" && f !== "good-faith-estimate", `hard negative routed to ${f}: ${q}`); }
  // Every Set 1 task routes exactly as the exact patterns route it (no Set 1 change), and the loose
  // routers alone also recognise every Set 1 filing / good-faith text with the same slots.
  const exactOnly = (t: string) => { for (const [f, ps] of FAMILY_PATTERNS) for (const p of ps) if (p.test(t.trim())) return f; return null; };
  let same = 0, looseSame = 0, looseN = 0;
  for (const it of items.filter((i) => i.kind === "task")) {
    const ex = exactOnly(it.text), now = familyMatch(it.text)?.family ?? null;
    if (ex === now) same++; else ok(false, `Set 1 routing changed: ${ex} → ${now}: ${it.text.slice(0, 80)}`);
    if (ex === "filing-deadline" || ex === "good-faith-estimate") {
      looseN++;
      const l = ex === "filing-deadline" ? looseFiling(it.text) : looseGoodFaith(it.text);
      const want = familyMatch(it.text)!.slots;
      const norm = (o: Record<string, string> | undefined) => o && JSON.stringify(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, k === "name" ? v.toLowerCase().replace(/,/g, "").split(" ").sort().join(" ") : v]).sort()));
      if (l && l.family === ex && norm(l.slots) === norm(want)) looseSame++; else ok(false, `loose router on Set 1 text: ${JSON.stringify(l)} vs ${JSON.stringify(want)}: ${it.text}`);
    } else {
      const l = looseFiling(it.text) ?? looseGoodFaith(it.text);
      ok(!l, `loose router claims a Set 1 ${ex} task: ${it.text.slice(0, 80)}`);
    }
  }
  console.log(`  Set 1 routing unchanged on ${same} tasks; loose routers match ${looseSame}/${looseN} Set 1 filing/good-faith texts`);

  console.log(`\n${fails ? "✗" : "✓"} familyReaders: ${passes} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
})();
