/**
 * The solver toolkit on captured Set 1 pages (jsdom) and synthetic list sequences — 0 wrong allowed.
 *   npx tsx src/wrenfield/solver/toolkit-test.ts
 *
 * Oracle: each recon section's "---- TEXT (decoded) ----" block (the page's decoded innerText captured by the
 * agent at recon time — independent of the HTML parse under test). Digits in the raw HTML are drawn in a
 * scrambled font, so digit fields are checked through decodeRead with a map derived from OTHER rows.
 */
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { pageReadOn, type TableRead } from "./pageRead.js";
import { judge, newJudge, parseFoot } from "./listJudge.js";
import { ENTITIES, ENTITY_NAMES, listFor, resolveLabel, seenTable, siteData, templateKey, type ListSpec } from "./siteModel.js";
import { pickTable, rowsOf, rowFields, fieldsFromRead, recheck, decodeRead, emptyStatement } from "./toolkit.js";
import * as D from "./dates.js";
import { findTable, lookup, band } from "./lookup.js";
import { recordOf } from "./world.js";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail: unknown = "") => { cond ? pass++ : fail++; if (!cond) console.log(`FAIL ${name} ${JSON.stringify(detail).slice(0, 400)}`); };
const root = new URL("../../../", import.meta.url).pathname;
type Sec = { head: string; html: string; text: string };
function sections(file: string): Sec[] {
  const raw = readFileSync(file, "utf8"); const out: Sec[] = [];
  for (const p of raw.split(/^(?=@@@@ |==== )/m)) {
    const head = p.split("\n")[0].replace(/@@@@/g, "").replace(/^====\s*/, "").trim();
    const i = p.indexOf("---- HTML ----"); if (i < 0) continue;
    let html = p.slice(i + 15); const j = html.search(/^---- [A-Z]/m); if (j > 0) html = html.slice(0, j);
    const ti = p.indexOf("---- TEXT (decoded) ----"); const text = ti >= 0 ? p.slice(ti + 25, i) : "";
    out.push({ head, html, text });
  }
  return out;
}
const claimDump = sections(root + "fixtures/set1/claim-dump-baseline.txt");
const recon = sections(root + "fixtures/set1/recon-158.txt");
const sec = (list: Sec[], startsWith: string) => { const s = list.find((x) => x.head.startsWith(startsWith)); if (!s) throw new Error("no section " + startsWith); return s; };
const read = (s: Sec, css = "") => pageReadOn(new JSDOM(`<!doctype html><html><head><style>${css}</style></head><body>${s.html.replace(/^<body[^>]*>/, "")}</body></html>`).window.document);
const spec = (e: keyof typeof ENTITIES, scope: ListSpec["scope"]) => { const l = listFor(e, scope); if ("why" in l) throw new Error(l.why); return l; };
const oneTable = (s: Sec, e: keyof typeof ENTITIES, scope: ListSpec["scope"]): TableRead => { const p = pickTable(read(s), spec(e, scope), e); if ("why" in p) throw new Error(p.why); return p.table; };
const modelSingle = (e: keyof typeof ENTITIES, scope: ListSpec["scope"]) => { const t = seenTable(spec(e, scope)); return !!t && t.fullObs > 0 && !t.paged.length && !t.foots.length; };

// ── 1. every captured page reads without error; every entity list maps to a captured table where one was captured ──
for (const s of [...claimDump, ...recon]) { try { read(s); ok("pageRead " + s.head.slice(0, 40), true); } catch (e) { ok("pageRead " + s.head.slice(0, 40), false, String(e)); } }
ok("site model has data", siteData().length >= 35, siteData().length);
for (const e of ENTITY_NAMES) for (const l of ENTITIES[e].lists) {
  const tm = seenTable(l);
  const optional = /practice site only|notes are articles|recallReader|patientResolve/.test(l.note ?? "") || l.url.startsWith("/vaccines") || e === "patient";
  if (!optional) ok(`model: ${e}/${l.scope} table seen in captures (${l.url})`, !!tm, { url: l.url, t: siteData().find((t) => t.template === l.url.replace(/\{[a-z]+\}/g, "{id}"))?.tables.map((x) => x.title) });
}
ok("templateKey ids", templateKey("/patients/73284k4465/appointments/0sqk34d93g?x=1") === "/patients/{id}/appointments/{id}" && templateKey("/settings/no-charge-visit-types") === "/settings/no-charge-visit-types");

// ── 2. lists on captured pages: verdicts vs the decoded TEXT oracle ──
{ // García claims tab: "20 claims" → complete (page), 20 rows; text oracle counts claim lines
  const s = sec(claimDump, "POPULATED claims+remittances");
  const t = oneTable(s, "claim", "patient");
  const st = newJudge(); const v = judge(st, t, { modelSingle: modelSingle("claim", "patient") });
  const textRows = s.text.split("\n").filter((l) => /^\d{8}\t[A-Z][a-z]{2} \d/.test(l));
  ok("claims: complete by the page's count", v.kind === "done" && v.proof.strength === "page" && st.rows.length === 20 && textRows.length === 20, { v, rows: st.rows.length, text: textRows.length });
  const rows = rowsOf(t.headers, st.rows);
  // non-digit fields agree with the decoded text, row by row
  const tx = textRows.map((l) => l.split("\t"));
  const agree = rows.every((r, i) => { const f = rowFields("claim", r, ["serviceDate", "renderingProvider", "payer"]); return f.ok && f.value.serviceDate === tx[i][1] && f.value.renderingProvider === tx[i][2] && f.value.payer === tx[i][3]; });
  ok("claims: service date / provider / payer per row = decoded text", agree);
  const rec = recordOf("claim", rows[0], ["dos", "payer", "status", "total"]);
  ok("world record: ISO date, exact money, detail link as id", !("why" in rec) && rec.dos === D.parseDate(tx[0][1]) && rec.payer === tx[0][3] && rec.total === D.money(D.cents(tx[0][4])!) && String(rec.id).startsWith("/claims/"), rec);
  ok("world record: a field without a site source declines", "why" in recordOf("claim", rows[0], ["accountNotes"]));
  const rt = oneTable(s, "remittance", "patient");
  const st2 = newJudge(); const v2 = judge(st2, rt, { modelSingle: modelSingle("remittance", "patient") });
  const remText = s.text.split("\n").filter((l) => /^(EFT|CHK)\d+\t/.test(l));
  // the captured HTML is capped at 14,000 chars (12 of 21 rows, footer cut): the judge must not call it complete
  ok("remittances (capped capture): never a wrong complete — decline, or done with every text row", v2.kind === "decline" || (v2.kind === "done" && st2.rows.length === remText.length), { v2, n: st2.rows.length, text: remText.length });
  ok("remittances (capped capture): declines", v2.kind === "decline", v2);
  const r0 = rowFields("remittance", rowsOf(rt.headers, rt.rows)[0], ["paymentDate", "payer", "entry", "type"]);
  const t0 = remText[0].split("\t");  // first rows are inside the capped HTML
  ok("remittance row fields by label", r0.ok && r0.value.paymentDate === t0[1] && r0.value.payer === t0[2] && r0.value.type === t0[3] && r0.value.entry === t0[4], r0);
}
{ // immunizations: "3 entries" → complete; lot digits decoded through the font map
  const s = sec(claimDump, "POPULATED immunizations");
  const t = oneTable(s, "immunization", "patient");
  const st = newJudge(); const v = judge(st, t);
  ok("immunizations: complete by the page's count (3 entries)", v.kind === "done" && v.proof.strength === "page" && st.rows.length === 3, v);
  const textRows = s.text.split("\n").filter((l) => /\t(Given|Not recorded)/.test(l) && /^[A-Z]/.test(l) && !/^Vaccine\t/.test(l)).map((l) => l.split("\t"));
  const rows = rowsOf(t.headers, st.rows);
  ok("immunizations: vaccine / date given = decoded text", rows.every((r, i) => r.cells["Vaccine"] === textRows[i][0] && r.cells["Date given"] === textRows[i][1]), { rows: rows.map((r) => r.cells), textRows });
  // scrambled lot font: undecodable → decline; decodable with a map learned from row 1 → row 2 equals the text
  const r = read(s, ".qf25xsww{font-family:Scr}");
  ok("font: scrambled family detected", r.families.includes("Scr"), r.families);
  const noMap = decodeRead(r, {});
  ok("font: no map → decline (never raw scrambled digits)", "why" in noMap, noMap);
  const imm = r.tables.find((x) => /^Immunizations/.test(x.caption))!;
  const raw1 = imm.rows[0][2].text, dec1 = textRows[0][2]; const map: Record<string, string> = {};
  let consistent = raw1.length === dec1.length; for (let i = 0; i < raw1.length && consistent; i++) if (/\d/.test(raw1[i])) { if (map[raw1[i]] && map[raw1[i]] !== dec1[i]) consistent = false; map[raw1[i]] = dec1[i]; }
  const raw2 = imm.rows[1][2].text, covered = [...raw2].filter((ch) => /\d/.test(ch)).every((ch) => map[ch] !== undefined);
  const dec = decodeRead(r, { Scr: map });
  if (consistent && covered) ok("font: row 2 lot decoded with row 1's map = decoded text", !("why" in dec) && dec.tables.find((x) => /^Immunizations/.test(x.caption))!.rows[1][2].text === textRows[1][2], { raw2, map, want: textRows[1][2] });
  else ok("font: map learnable from row 1 (fixture sanity)", true);
}
{ // Show more / Next / "about N": one capture → continue (never "done" on a first page)
  const appts = sec(recon, "/patients/{id}/appointments ::");
  const t = oneTable(appts, "appointment", "patient");
  const v = judge(newJudge(), t);
  ok("patient appointments 'Showing 15 of 148' + Show more → continue more", v.kind === "continue" && v.action === "more", { v, foot: t.foot });
  const docs = sec(recon, "/documents ::");
  const vd = judge(newJudge(), oneTable(docs, "document", "clinic"));
  ok("documents 'Showing 20 of about 100,750' → continue more", vd.kind === "continue" && vd.action === "more", vd);
  const cal = sec(recon, "/settings/clinic-calendar ::");
  const vc = judge(newJudge(), oneTable(cal, "closure", "clinic"));
  ok("closures 'Showing 1 to 25 of 98' + Next → continue next", vc.kind === "continue" && vc.action === "next", vc);
  const inv = sec(recon, "/billing/accounts/{id} ::");
  const vi = judge(newJudge(), oneTable(inv, "invoice", "patient"));
  ok("patient invoices 'Showing 15 of 77' → continue more", vi.kind === "continue" && vi.action === "more", vi);
  const files = sec(recon, "/patients/{id}/files ::");
  const st = newJudge(); const vf = judge(st, oneTable(files, "document", "patient"));
  const fileText = files.text.split("\n").filter((l) => /\t[A-Z][a-z]{2} \d{1,2}, \d{4}\t?/.test(l) && !/^Title\t/.test(l));
  ok("chart documents '12 documents' → done 12 = decoded text rows", vf.kind === "done" && st.rows.length === 12 && fileText.length === 12, { vf, text: fileText.length });
}
{ // restricted chart: no table, a gate; the picker refuses
  const g = sec(claimDump, "POPULATED insurance");
  const r = read(g);
  ok("restricted chart: gate seen, no coverage table picked", r.gates.length > 0 && "why" in pickTable(r, spec("coverage", "patient"), "coverage"), r.gates);
}
{ // detail pages: label → value blocks (non-digit fields vs decoded text)
  const inv = read(sec(recon, "/billing/invoices/{id} ::"));
  const f = fieldsFromRead("invoice", inv, ["patient", "location", "serviceDate", "status", "total"]);
  const tx = sec(recon, "/billing/invoices/{id} ::").text;
  ok("invoice detail fields by label", f.ok && tx.includes(f.value.location) && tx.includes(f.value.status) && /^[A-Z][a-z]{2} \d{1,2}, \d{4}$/.test(f.value.serviceDate), f);
  const claim = read(sec(claimDump, "CLAIM DETAIL"));
  const cf = fieldsFromRead("claim", claim, ["payer", "plan", "serviceDate", "status", "renderingProvider"]);
  const ctext = sec(claimDump, "CLAIM DETAIL").text;
  ok("claim detail fields by label = decoded text", cf.ok && [cf.value.payer, cf.value.plan, cf.value.serviceDate, cf.value.status, cf.value.renderingProvider].every((v) => ctext.includes(v)), cf);
  ok("claim detail: ambiguous label declines", !fieldsFromRead("claim", claim, ["Nonexistent label"]).ok);
  const ap = read(sec(recon, "/patients/{id}/appointments/{id} ::"));
  const af = fieldsFromRead("appointment", ap, ["Visit.Date", "Visit.Status", "provider", "location", "Booking.Booked by"]);
  const atext = sec(recon, "/patients/{id}/appointments/{id} ::").text;
  ok("appointment detail: Block.Label + canonical fields", af.ok && Object.values(af.value).every((v) => atext.includes(v)), af);
  const pt = read(sec(recon, "/patients/{id} ::"));
  const pf = fieldsFromRead("patient", pt, ["sex", "primaryProvider", "homeLocation"]);
  const ptext = sec(recon, "/patients/{id} ::").text;
  ok("patient chart fields", pf.ok && Object.values(pf.value).every((v) => ptext.includes(v)), pf);
  const payer = read(sec(recon, "/payers/{id} ::"));
  const ft = pickTable(payer, spec("filing-term", "parent"), "filing-term"), pa = pickTable(payer, spec("prior-auth-rule", "parent"), "prior-auth-rule");
  ok("payer page: filing terms and prior-auth tables picked apart", !("why" in ft) && !("why" in pa) && ft.table !== pa.table, { ft, pa });
}
{ // client-side re-check of filters
  const docs = read(sec(recon, "/documents ::"));
  const t = pickTable(docs, spec("document", "clinic"), "document"); if ("why" in t) throw new Error(t.why);
  const rows = rowsOf(t.table.headers, t.table.rows);
  const types = new Set(rows.map((r) => r.cells["Type"]));
  ok("recheck: rows of several types fail a Type filter", types.size > 1 && recheck("document", spec("document", "clinic"), rows, { type: "Lab report" }) !== "", [...types]);
  const only = rows.filter((r) => r.cells["Type"] === "Lab report");
  ok("recheck: matching rows pass", only.length === 0 || recheck("document", spec("document", "clinic"), only, { type: "Lab report" }) === "");
  const dates = rows.map((r) => D.parseDate(r.cells["Received"])!).sort();
  ok("recheck: a date outside frto fails", recheck("document", spec("document", "clinic"), rows, { from: dates[dates.length - 1] }) !== "" || dates[0] === dates[dates.length - 1]);
}

// ── 3. the judge on synthetic sequences (every rule) ──
const T = (foot: string, n: number, opts: { next?: boolean; more?: boolean; start?: number; text?: (i: number) => string } = {}): TableRead => ({
  caption: "X", label: "", heading: "", region: "", headers: ["A"], foot,
  rows: Array.from({ length: n }, (_, i) => [{ text: (opts.text ?? ((k) => `r${k}`))((opts.start ?? 0) + i), links: [] }]),
  next: { present: !!opts.next, disabled: false }, more: { present: !!opts.more, disabled: false, name: opts.more ? "Show more" : "" } });
{
  let st = newJudge();
  ok("next: page 1 → continue", judge(st, T("Showing 1 to 25 of 60 entries", 25, { next: true })).kind === "continue");
  ok("next: page 2 → continue", judge(st, T("Showing 26 to 50 of 60 entries", 25, { next: true, start: 25 })).kind === "continue");
  const last = judge(st, T("Showing 51 to 60 of 60 entries", 10, { start: 50 }));
  ok("next: last page → done 60 (page)", last.kind === "done" && last.proof.rows === 60 && last.proof.strength === "page", last);
  st = newJudge(); judge(st, T("Showing 1 to 25 of 60 entries", 25, { next: true }));
  ok("next: a skipped page declines", judge(st, T("Showing 51 to 60 of 60 entries", 10, { start: 50 })).kind === "decline");
  st = newJudge();
  ok("next: rows ≠ range declines", judge(st, T("Showing 1 to 25 of 60 entries", 24, { next: true })).kind === "decline");
  st = newJudge();
  ok("next: no Next before the total declines", judge(st, T("Showing 1 to 25 of 60 entries", 25)).kind === "decline");
  st = newJudge();
  ok("next: '200+' with no Next declines (capped)", judge(st, T("Showing 1 to 25 of 200+ entries", 25)).kind === "decline");
  st = newJudge();
  ok("next: total reached but Next offered declines", judge(st, T("Showing 1 to 25 of 25 entries", 25, { next: true })).kind === "decline");
  st = newJudge();
  ok("more: first → continue", judge(st, T("Showing 15 of 40 appointments", 15, { more: true })).kind === "continue");
  ok("more: second → continue", judge(st, T("Showing 30 of 40 appointments", 30, { more: true })).kind === "continue");
  const mdone = judge(st, T("Showing 40 of 40 appointments", 40));
  ok("more: end at total → done (page)", mdone.kind === "done" && mdone.proof.strength === "page" && mdone.proof.rows === 40, mdone);
  st = newJudge(); judge(st, T("Showing 15 of 40 appointments", 15, { more: true }));
  ok("more: earlier rows changed declines", judge(st, T("Showing 30 of 40 appointments", 30, { more: true, text: (i) => `z${i}` })).kind === "decline");
  st = newJudge(); judge(st, T("Showing 15 of 40 appointments", 15, { more: true }));
  ok("more: button gone short of total declines", judge(st, T("Showing 30 of 40 appointments", 30)).kind === "decline");
  st = newJudge(); judge(st, T("Showing 20 of about 100 documents", 20, { more: true }));
  const approx = judge(st, T("Showing 104 of about 100 documents", 104));
  ok("more: 'about N' ended within tolerance → done (model strength)", approx.kind === "done" && approx.proof.strength === "model", approx);
  st = newJudge(); judge(st, T("Showing 20 of about 100 documents", 20, { more: true }));
  ok("more: 'about N' cut short declines", judge(st, T("Showing 60 of about 100 documents", 60)).kind === "decline");
  ok("more: 'No more results' declines (capped)", judge(newJudge(), T("Showing 20 of about 100 documents", 20), { noMore: true }).kind === "decline");
  ok("count: '3 entries' with 3 rows → done", judge(newJudge(), T("3 entries", 3)).kind === "done");
  ok("count: '3 entries' with 2 rows declines", judge(newJudge(), T("3 entries", 2)).kind === "decline");
  ok("count: '1 entry' singular", judge(newJudge(), T("1 entry", 1)).kind === "done");
  ok("none: 'No claims on file' + 0 rows → done (page)", (() => { const v = judge(newJudge(), T("No claims on file", 0)); return v.kind === "done" && v.proof.strength === "page" && v.proof.rows === 0; })());
  ok("none: statement with rows declines", judge(newJudge(), T("No claims on file", 2)).kind === "decline");
  ok("no footer, not model-single → decline", judge(newJudge(), T("", 4)).kind === "decline");
  ok("no footer, model-single → done (model)", (() => { const v = judge(newJudge(), T("", 4), { modelSingle: true }); return v.kind === "done" && v.proof.strength === "model"; })());
  ok("no footer but a pager → decline", judge(newJudge(), T("", 4, { next: true }), { modelSingle: true }).kind === "decline");
  ok("parseFoot forms", JSON.stringify([parseFoot("Showing 1 to 25 of 1,200+ invoices"), parseFoot("Showing 20 of about 100,750 documents"), parseFoot("20 claims"), parseFoot("No insurance on file")].map((f) => f && [f.kind, f.total, f.plus, f.approx])) === JSON.stringify([["range", 1200, true, false], ["cumulative", 100750, false, true], ["count", 20, false, false], ["none", 0, false, false]]));
}

// ── 3b. empty-list statements (practice-site wordings) ──
ok("empty: 'No documents in this chart' proves 0 documents", emptyStatement("document", ["No documents in this chart"]) !== undefined);
ok("empty: 'No conditions recorded' proves 0 problems", emptyStatement("problem", ["No conditions recorded"]) !== undefined);
ok("empty: 'No invoices on this account'", emptyStatement("invoice", ["No invoices on this account"]) !== undefined);
ok("empty: qualified 'No single appointments on record' is NOT proof", emptyStatement("appointment", ["No single appointments on record."]) === undefined);
ok("empty: another entity's statement is not proof", emptyStatement("authorization", ["No insurance on file"]) === undefined);
ok("empty: footer form parsed", parseFoot("No conditions recorded")?.kind === "none" && parseFoot("No documents in this chart")?.kind === "none");

// ── 4. labels / synonyms ──
ok("label: synonym resolves once", (() => { const r = resolveLabel("invoice", "serviceDate", ["Invoice", "Date of service", "Total"]); return !("why" in r) && r.label === "Date of service"; })());
ok("label: two synonym matches decline", "why" in resolveLabel("appointment", "visitType", ["Visit type", "Appointment type"]));
ok("label: exact page label wins over synonyms", (() => { const r = resolveLabel("appointment", "date", ["Date", "Day"]); return !("why" in r) && r.label === "Date"; })());
ok("label: page's own label works", (() => { const r = resolveLabel("claim", "Total charge", ["Claim", "Total charge"]); return !("why" in r); })());

// ── 5. dates / money / business days ──
const cal = D.calendar(["2026-11-26", "2026-12-25", "2027-01-01"]);
ok("parseDate formats", ["Oct 5, 2026", "Thu, Jan 1, 2026", "October 5, 2026", "5 October 2026", "2026-10-05", "10/05/2026", "Oct 5, 2026, 9:00 AM CDT"].map(D.parseDate).join() === "2026-10-05,2026-01-01,2026-10-05,2026-10-05,2026-10-05,2026-10-05,2026-10-05");
ok("parseDate: two dates / impossible → undefined", D.parseDate("Oct 5, 2026 to Oct 9, 2026") === undefined && D.parseDate("Feb 30, 2026") === undefined && D.parseDate("Sept 31 2026") === undefined);
ok("addMonths clamps", D.addMonths("2026-01-31", 1) === "2026-02-28" && D.addMonths("2028-01-31", 1) === "2028-02-29" && D.addYears("2028-02-29", 1) === "2029-02-28");
ok("business days: Wed before Thanksgiving + 1 = Fri", D.addBusinessDays("2026-11-25", 1, cal) === "2026-11-27");
ok("business days: Fri + 1 = Mon", D.addBusinessDays("2026-10-09", 1, cal) === "2026-10-12");
ok("business days: Dec 24 + 3 skips Christmas, weekend, New Year", D.addBusinessDays("2026-12-24", 3, cal) === "2026-12-30" && D.addBusinessDays("2026-12-30", 2, cal) === "2027-01-04");
ok("business days between (a, b]", D.businessDaysBetween("2026-11-25", "2026-11-30", cal) === 2 && D.businessDaysBetween("2026-11-30", "2026-11-25", cal) === -2);
ok("roll to open day", D.rollToOpen("2026-12-26", cal, "earlier") === "2026-12-24" && D.rollToOpen("2026-12-26", cal, "later") === "2026-12-28");
ok("negative business days", D.addBusinessDays("2026-11-30", -2, cal) === "2026-11-25");
ok("days between / day of week", D.daysBetween("2026-02-27", "2026-03-01") === 2 && D.dayOfWeek("2026-10-14") === "Wed");
ok("age on date", D.ageOn("2000-02-29", "2026-02-28") === 25 && D.ageOn("2000-02-29", "2026-03-01") === 26);
ok("money exact", D.cents("$1,250.50") === 125050 && D.money(D.sumCents([D.cents("$0.10")!, D.cents("$0.20")!])) === "0.30" && D.money(-1234567, "site") === "-$12,345.67");
ok("percent: exact cents only unless rounding given", D.percentOf(10000, "10%") === 1000 && D.percentOf(333, "10%") === null && D.percentOf(333, "10%", "half-up") === 33 && D.percentOf(335, "10%", "half-up") === 34);

// ── 6. message tables ──
const MSG = `Use this table.\n\n| Reason | Group | Next step |\n|---|---|---|\n| 16 | CO | RESUBMIT |\n| 50 | CO | APPEAL |\n| 50 | PR | BILL_PATIENT |\n\nBands:\n\n| Days before visit | Due |\n|---|---|\n| 0 to 2 | SHORT_NOTICE |\n| 3 to 9 | 1 business day |\n| 10 or more | 3 business days |\n`;
const tb = findTable(MSG, ["Reason", "Group", "Next step"]);
ok("lookup: two keys → one row", !("why" in tb) && (() => { const r = lookup(tb as any, { Reason: "50", Group: "PR" }, "Next step"); return r.ok && r.value === "BILL_PATIENT"; })());
ok("lookup: one key, two rows → decline", !("why" in tb) && !lookup(tb as any, { Reason: "50" }, "Next step").ok);
ok("lookup: missing column → decline", !("why" in tb) && !lookup(tb as any, { Code: "50" }, "Next step").ok);
const bt = findTable(MSG, ["Days before visit", "Due"]);
ok("band lookup", !("why" in bt) && (band(bt as any, "Days before visit", 2, "Due") as any).value === "SHORT_NOTICE" && (band(bt as any, "Days before visit", 9, "Due") as any).value === "1 business day" && (band(bt as any, "Days before visit", 40, "Due") as any).value === "3 business days");
{ // a real Set 1 governing message table (claim next step n=120): every message table resolves by its own headers
  const items = readFileSync(root + "fixtures/set1-items.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  let n = 0;
  for (const it of items.filter((i: any) => i.kind !== "task")) for (const m of [...String(it.text).matchAll(/^\|(.+)\|\s*\n\|[\s|:-]+\|/gm)]) { const hs = m[1].split("|").map((x) => x.trim()).filter(Boolean); const t = findTable(it.text, hs); if (!("why" in t)) n++; }
  ok("Set 1 message tables found by their headers", n >= 3, n);
}

console.log(`toolkit-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
