/**
 * listQuery.ts + listRead.ts checks (no browser):
 *   1. parse: paraphrases route with the right {list, type, status, location, date field, window}; hard negatives
 *      (same vocabulary, another question) and unknown qualifiers decline;
 *   2. family routing: list-count never takes a task another family answers; lab triage never takes a count;
 *   3. policy: the governing count message (rules understood → policy; unknown rule / answer tokens → decline);
 *      Set 1's workflow messages never govern a list count;
 *   4. solve: re-filter, badges, Void, zero, window not over;
 *   5. Set 1 recon DOM (Documents + Billing) through the real browser extractors under jsdom: form by label, rows.
 *   npx tsx src/wrenfield/listQuery.test.ts
 */
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { parseListQuery, listPolicy, solveListQuery, optionFor, type ListRow, type ListSource, type ListQuery } from "./listQuery.js";
import { familyMatch } from "./families.js";
import { SPECS, mapListForm, listOptions, parseRows } from "./listRead.js";
import { PAGE_EXTRACT, FORM_EXTRACT, type RawPage, type RawControl } from "./apptList.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("FAIL", m); } };

// ── 1. parse ──
const YES: Array<[string, Partial<ListQuery> & { from?: string; to?: string }]> = [
  ["How many lab reports did we receive on 2026-10-09?", { list: "documents", typePhrase: "lab reports", dateField: "received", from: "2026-10-09" }],
  ["Number of referral letters received October 9, 2026?", { list: "documents", typePhrase: "referral letters", from: "2026-10-09" }],
  ["How many statements came in on 10/09/2026?", { list: "documents", typePhrase: "statements", from: "2026-10-09" }],
  ["How many documents were received on 9 October 2026?", { list: "documents", typePhrase: undefined, from: "2026-10-09" }],
  ["How many documents of type Eligibility response were received on 2026-10-09?", { list: "documents", typePhrase: "Eligibility response" }],
  ["Count the immunization records that arrived on 2026-10-07.", { list: "documents", typePhrase: "immunization records", from: "2026-10-07" }],
  ["How many eligibility responses did we get in September 2026?", { list: "documents", typePhrase: "eligibility responses", from: "2026-09-01", to: "2026-09-30" }],
  ["What's the number of court orders received on Oct 2, 2026?", { list: "documents", typePhrase: "court orders" }],
  ["How many invoices were issued on 2026-10-09?", { list: "invoices", dateField: "issued", status: undefined, location: undefined }],
  ["How many Void invoices were issued on 2026-10-09?", { list: "invoices", status: "Void" }],
  ["How many invoices did Prairie View issue on October 9, 2026?", { list: "invoices", location: "Prairie View", dateField: "issued" }],
  ["Number of partly paid invoices issued at Front Range on 10/9/2026", { list: "invoices", status: "Partly paid", location: "Front Range" }],
  ["How many invoices with status Open were issued on 2026-10-09 at Willow Creek?", { list: "invoices", status: "Open", location: "Willow Creek" }],
  ["How many invoices have a service date of 2026-10-09?", { list: "invoices", dateField: "service" }],
  ["How many paid invoices were issued by Stonebrook in September 2026? Leave out test records and deleted records.", { list: "invoices", status: "Paid", location: "Stonebrook", exclude: { test: true, deleted: true } }],
  ["For the billing report: how many invoices were issued on 2026-10-09, all locations?", { list: "invoices", location: undefined }],
  ["Could you count how many paid invoices Prairie View issued on October 9, 2026?", { list: "invoices", status: "Paid", location: "Prairie View" }],
  ["How many invoices marked Open were issued on 10/9/2026 at our Northgate office?", { list: "invoices", status: "Open", location: "Northgate" }],
  ["I need the number of invoices issued 2026-10-09 (Front Range).", { list: "invoices", location: "Front Range" }],
  ["Statements received October 9, 2026: what's the count?", { list: "documents", typePhrase: "Statements" }],
  ["I'm doing the intake tally for 10/9/2026. How many referral letters did we get?", { list: "documents", typePhrase: "referral letters", from: "2026-10-09" }],
  ["Total referral letters received on 2026-10-09?", { list: "documents", typePhrase: "referral letters" }],
];
for (const [t, want] of YES) {
  const r = parseListQuery(t);
  if (!r.q) { ok(false, `should parse: ${t} — ${r.why}`); continue; }
  const q = r.q as any;
  const bad = Object.entries(want).filter(([k, v]) => k === "from" ? q.window.from !== v : k === "to" ? q.window.to !== v : JSON.stringify(q[k]) !== JSON.stringify(v));
  ok(!bad.length, `${t} → ${JSON.stringify(q)} (wrong: ${bad.map(([k]) => k).join(",")})`);
}
const NO = [
  "How many lab reports are still unread?",
  "How many referral letters came in today?",
  "How many referral letters came in this week?",
  "How many lab reports did Maria Lopez get on 2026-10-09?",
  "How many lab reports were received for Lopez, Maria (DOB 1980-01-02) on 2026-10-09?",
  "Who received the referral letter on 2026-10-09?",
  "Which practice sent the most referral letters on 2026-10-09?",
  "How much was invoiced in total on 2026-10-09?",
  "How many invoices are overdue?",
  "How many invoices were paid on 2026-10-09?",
  "How many invoices were issued on 2026-10-09 with an amount owed over 100?",
  "How many invoices were created on 2026-10-09?",
  "How many invoices on 2026-10-09?",
  "How many invoices were issued between 2026-10-01 and 2026-10-09?",
  "How many invoices were issued on 2026-10-08 and 2026-10-09?",
  "How many lab reports were received in October?",
  "How many referrals came in on 2026-10-09?",
  "How many patients came in on 2026-10-09?",
  "How many appointments were completed on 2026-10-09?",
  "How many referral letters from Elk Bend Health Center came in on 2026-10-09?",
  "How many referral letters came in on 2026-10-09 for new patients?",
  "How many documents were received on 2026-10-09, not counting restricted charts?",
  "How many invoices were issued on 2026-10-09 including test records?",
  "How many lab reports did we receive on 2026-10-09 at Northgate?",
  "How many Open invoices issued at Northgate and Eastside on 2026-10-09?",
  "How many invoices were issued on 2026-10-09 and paid in full?",
  "How many duplicate lab reports came in on 2026-10-09?",
  "Should the lab report received on 2026-10-09 for Cheryl Lee go to a nurse?",
  "I'm doing the intake tally for 10/9/2026. How many referral letters did Elk Bend send?",
  "Total amount of invoices issued on 2026-10-09?",
  "How many invoices Dr. Lee issued on 2026-10-09?",
];
for (const t of NO) { const r = parseListQuery(t); ok(!r.q, `should decline: ${t} → ${JSON.stringify(r.q)}`); }

// ── 2. routing ──
const fam = (t: string) => familyMatch(t)?.family ?? null;
ok(fam("How many lab reports did we receive on 2026-10-09?") === "list-count", "doc count routes to list-count");
ok(fam("Count of Lab report documents received 10/12/2026.") === "list-count", "bench doc-count phrasing routes to list-count (not lab triage)");
ok(fam("Please decide what to do with the Basic metabolic panel lab report received on 2026-10-14 for Cheryl Lee.") === "lab-report-triage", "lab triage task stays lab triage");
ok(fam("What's still owed on invoice 12345678 (patient Ann Lee, service date 2026-10-01), in dollars? Still owed means the amount billed minus the payments received, and a voided invoice owes nothing.") === "invoice-balance", "invoice balance stays");
ok(fam("How many completed visits at Northgate on 2026-10-09 started before 10:00 local time? Leave out appointments of patients whose record is a test record or has been deleted.") === "location-completed-before-time", "appointment aggregate stays");
ok(fam("How many patients are left to notify about the recall of lot AB123?") === "vaccine-lot-recall", "recall stays");
{ const prev = process.env.AGENT_LIST_COUNT; process.env.AGENT_LIST_COUNT = "off"; ok(fam("How many lab reports did we receive on 2026-10-09?") === null, "AGENT_LIST_COUNT=off: not routed"); if (prev === undefined) delete process.env.AGENT_LIST_COUNT; else process.env.AGENT_LIST_COUNT = prev; }

// ── 3. policy ──
const DOC_MSG = `From health information management: counting documents received

We track how much paper comes in. You'll be asked how many documents of one type were received on one date.

Types are the ones in the Documents list (Referral letter, Lab report, Statement, and others). Count documents of restricted charts too. Answer with the number alone, for example \`12\`. If none were received, answer \`0\`.

## Example

"How many referral letters came in on 2026-10-13?" — count the Documents list rows of type Referral letter with Received Oct 13, 2026.`;
const INV_MSG = `From the billing supervisor: counting invoices

We count invoices for the daily billing report. You'll be asked how many invoices were issued on one date, sometimes only at one location or only with one status.

Count every invoice issued on that date (the Issued date, not the service date), at every location unless a location is named. Statuses are Open, Partly paid, Paid and Void; count Void ones only when the question asks about Void invoices.

Answer with the number alone, for example \`17\`. If no invoice matches, answer \`0\`.`;
{
  const d = listPolicy([DOC_MSG], "documents"); ok(!("why" in d) && d.governed && d.restricted === true && d.zero === "0", `doc message understood: ${JSON.stringify(d)}`);
  const i = listPolicy([INV_MSG], "invoices"); ok(!("why" in i) && i.governed && i.voidUnlessAsked === true && i.invoiceDate === "issued", `invoice message understood: ${JSON.stringify(i)}`);
  ok(!("why" in listPolicy([INV_MSG], "documents")) && !(listPolicy([INV_MSG], "documents") as any).governed, "invoice message does not govern documents");
  const odd = INV_MSG.replace("Answer with the number alone", "Credit memos count as Void invoices. Answer with the number alone");
  ok("why" in listPolicy([odd], "invoices"), "an unknown rule in the count message → decline");
  const exBad = DOC_MSG.replace('"How many referral letters came in on 2026-10-13?"', '"How many referral letters from Elk Bend came in on 2026-10-13?"');
  ok("why" in listPolicy([exBad], "documents"), "the message's worked example not read as a count of this list → decline");
  const tok = DOC_MSG.replace("If none were received, answer `0`.", "If none were received, answer `NONE`.");
  ok("why" in listPolicy([tok], "documents"), "an unknown answer token → decline");
  ok("why" in listPolicy([INV_MSG, "A few invoices issued yesterday were voided this morning after a double booking."], "invoices"), "a later note about invoices → decline");
  ok("why" in listPolicy([DOC_MSG, "The fax server was down yesterday; some referral letters were scanned in late and carry today's date."], "documents"), "a later note about documents → decline");
  // Set 1's workflow messages never govern a list count, and don't block one
  const set1 = readFileSync("fixtures/set1-items.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((o) => o.kind === "message").map((o) => o.text as string);
  const docs = listPolicy(set1, "documents"); ok(!("why" in docs) && !docs.governed, `Set 1 messages: documents ungoverned and unblocked (${JSON.stringify(docs)})`);
  const invs = listPolicy(set1, "invoices"); ok(!("why" in invs) && !invs.governed, "Set 1 messages: the payments-posting note does not block an invoice count by date");
  ok("why" in listPolicy(set1, "invoices", true), "Set 1 messages: the payments-posting note blocks an invoice count by status");
}

// ── 4. solve ──
const row = (o: Partial<ListRow> & { d: string }): ListRow => ({ key: Math.random().toString(36), date: { received: o.d, issued: o.d, service: o.d }, flags: [], ...o });
const src = (rows: ListRow[], opts = { type: ["Referral letter", "Lab report", "Statement"], status: ["Open", "Partly paid", "Paid", "Void"], location: ["Northgate", "Prairie View", "Front Range"] }, today = "2026-10-14"): ListSource & { last?: any; stale?: boolean } => {
  // the site applies the filter (as listRead proves on the page): rows outside it are not returned
  const inF = (f: any) => (x: ListRow) => { const d = x.date[f.dateField as "received"]!; return d >= f.from && d <= f.to && (!f.type || x.type === f.type) && (!f.status || x.status === f.status) && (!f.location || x.location === f.location); };
  const s: any = { todayISO: () => today, options: async () => opts, read: async (f: any) => { s.last = f; return { rows: s.stale ? rows : rows.filter(inF(f)), proof: "test" }; } };
  return s;
};
const q = (t: string) => { const r = parseListQuery(t); if (!r.q) throw new Error(t + ": " + r.why); return r.q; };
(async () => {
  const none = { governed: false };
  {
    const rows = [row({ d: "2026-10-09", type: "Lab report" }), row({ d: "2026-10-09", type: "Lab report", flags: ["Restricted"] }), row({ d: "2026-10-09", type: "Statement" }), row({ d: "2026-10-08", type: "Lab report" })];
    const s = src(rows); const o = await solveListQuery(q("How many lab reports did we receive on 2026-10-09?"), none, s);
    ok("answer" in o && o.answer === "2", `lab reports re-filtered by type and date, restricted counted: ${JSON.stringify(o)}`);
    ok(s.last?.type === "Lab report" && s.last.from === "2026-10-09" && s.last.to === "2026-10-09", "read filter by option text");
  }
  { const o = await solveListQuery(q("How many lab reports did we receive on 2026-10-09?"), none, src([row({ d: "2026-10-09", type: "Lab report", flags: ["Test record"] })])); ok("why" in o, "test-record row, question silent → decline"); }
  { const s = src([row({ d: "2026-10-09", type: "Lab report" }), row({ d: "2026-10-09", type: "Statement" })]); s.stale = true; const o = await solveListQuery(q("How many lab reports did we receive on 2026-10-09?"), none, s); ok("why" in o, `a page with rows outside the filter (stale / ignored filter) → decline, never a re-filtered count: ${JSON.stringify(o)}`); }
  { const o = await solveListQuery(q("How many lab reports did we receive on 2026-10-09? Leave out test records."), none, src([row({ d: "2026-10-09", type: "Lab report", flags: ["Test record"] }), row({ d: "2026-10-09", type: "Lab report" })])); ok("answer" in o && o.answer === "1", "test row left out when asked"); }
  { const o = await solveListQuery(q("How many lab reports did we receive on 2026-10-09?"), none, src([row({ d: "2026-10-09", type: "Lab report", unknownBadge: "Inactive" })])); ok("why" in o, "unknown badge → decline"); }
  { const o = await solveListQuery(q("How many lab reports did we receive on 2026-10-14?"), none, src([])); ok("why" in o, "window not over (today) → decline"); }
  { const o = await solveListQuery(q("How many lab results came in on 2026-10-09?"), none, src([])); ok("why" in o, "\"lab results\" is not a Type option → decline"); }
  { const o = await solveListQuery(q("How many Abnormal lab reports came in on 2026-10-09?"), none, src([])); ok("why" in o, "\"Abnormal lab reports\" is not a Type option → decline"); }
  { const o = await solveListQuery(q("How many lab reports did we receive on 2026-10-09?"), none, src([])); ok("answer" in o && o.answer === "0", "zero rows on a proven-complete read → 0"); }
  {
    const inv = [row({ d: "2026-10-09", status: "Paid", location: "Northgate" }), row({ d: "2026-10-09", status: "Void", location: "Northgate" }), row({ d: "2026-10-09", status: "Open", location: "Prairie View" })];
    const o1 = await solveListQuery(q("How many invoices were issued on 2026-10-09?"), none, src(inv)); ok("why" in o1, "Void among rows, no message, question silent → decline");
    const pol = listPolicy([INV_MSG], "invoices") as any;
    const o2 = await solveListQuery(q("How many invoices were issued on 2026-10-09?"), pol, src(inv)); ok("answer" in o2 && o2.answer === "2", "message: Void left out unless asked");
    const o3 = await solveListQuery(q("How many void invoices were issued on 2026-10-09?"), pol, src(inv)); ok("answer" in o3 && o3.answer === "1", "Void asked → counted");
    const o4 = await solveListQuery(q("How many invoices did Prairie View issue on 2026-10-09?"), pol, src(inv)); ok("answer" in o4 && o4.answer === "1", "location re-filter");
    const o5 = await solveListQuery(q("How many invoices have a service date of 2026-10-09?"), pol, src(inv)); ok("why" in o5, "message counts by Issued date, question by service date → decline");
  }
  ok(optionFor("eligibility responses", ["Eligibility response", "Court order"]) === "Eligibility response" && optionFor("Lab report documents", ["Lab report"]) === "Lab report" && optionFor("immunization records", ["Immunization record"]) === "Immunization record" && optionFor("reports", ["Lab report"]) === null, "type phrase → option");

  // ── 5. Set 1 recon DOM ──
  const recon = readFileSync("fixtures/set1/recon-158.txt", "utf8");
  // the recon HTML is cut at ~14 KB: keep it up to the last whole row (the footer is checked in the text dump's tests)
  const html = (u: string) => { const i = recon.indexOf(`url=${u}\n`); const j = recon.indexOf("---- HTML ----", i); const k = recon.indexOf("\n[nav]", j); let h = recon.slice(j + 15, k < 0 ? undefined : k); if (!/Showing \d/.test(h)) h = h.slice(0, h.lastIndexOf("</tr>") + 5) + "</tbody></table>"; return h; };
  const run = <T>(h: string, js: string): T => { const dom = new JSDOM(h); return new Function("doc", "Event", js)(dom.window.document, dom.window.Event) as T; };
  for (const kind of ["documents", "invoices"] as const) {
    const h = html(kind === "documents" ? "/documents" : "/billing");
    const f = run<{ controls: RawControl[] }>(h, FORM_EXTRACT);
    const form = mapListForm(SPECS[kind], f.controls);
    const opts = listOptions(SPECS[kind], form);
    if (kind === "documents") ok(!!form.byKey.type && !!form.byKey["from:received"] && !!form.byKey["to:received"] && (opts.type ?? []).includes("Eligibility response"), `Set 1 Documents form by label: ${Object.keys(form.byKey)} types=${opts.type?.length}`);
    else ok(!!form.byKey.status && !!form.byKey.location && !!form.byKey["from:issued"] && !!form.byKey["to:service"] && (opts.location ?? []).includes("Cedar Hollow") && (opts.status ?? []).includes("Partly paid"), `Set 1 Billing form by label: ${Object.keys(form.byKey)} ${form.problems}`);
    const raw = run<RawPage>(h, PAGE_EXTRACT);
    const pg = parseRows(SPECS[kind], raw);
    ok(pg.problems.length === 0 && pg.rows.length >= 10, `Set 1 ${kind} page: ${pg.rows.length} rows, range ${JSON.stringify(pg.range)} ${pg.problems.join("; ")}`);
    if (kind === "documents") ok(pg.rows[0].date.received === "2026-11-10" && pg.rows[0].type === "Immunization record" && (!pg.range || (pg.range.cumulative === true && pg.range.approx === true)), "Set 1 documents row 1 (+ Show-more footer when present)");
    else { ok(pg.rows[7].flags.includes("Restricted") && pg.rows[7].location === "Northgate" && pg.rows[7].status === "Open" && pg.rows[0].date.issued === "2026-10-14", `Set 1 invoice row with a Restricted badge: ${JSON.stringify(pg.rows[7])}`); }
  }
  console.log(`listQuery: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
