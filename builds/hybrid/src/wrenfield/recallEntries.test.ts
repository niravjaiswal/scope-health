/**
 * vaccine-lot-recall: the chart-entry table read by header label and walked across pages
 * (recallReader.entryPageOf / lotEntriesOf / walkList / recallAnswer):  npx tsx src/wrenfield/recallEntries.test.ts
 *
 * Fixtures: the 8 POPULATED lot-detail pages Set 1 run 278 captured (fixtures/recall/*.html, the recall_probe events;
 * markup verbatim). They hold the "Chart entries with this lot" table (Date given | Patient | Date of birth | MRN |
 * Given by | Entry) and its footer ("12 entries" or "Showing 1 to 25 of 27 entries" + Rows per page + Previous/1/2/Next).
 * No verdict below includes notes (the note-search pages are read in recallNotes.test.ts): each count is "dosed from the
 * chart entries", hand-worked from the page (Active entry, not Entered in error, not Test record; one record = one chart link).
 * Page 2 of the 27-entry lot was not captured: the second page and the 100-per-page page are built from page 1's markup
 * (the footer wording is the captured one with the numbers changed) and marked SYNTHETIC.
 */
import { readFileSync, readdirSync } from "node:fs";
import { JSDOM } from "jsdom";
import { isDecline } from "./familyReaders.js";
import type { FamMaps } from "./claimReader.js";
import { recallPageOf, entryPageOf, lotEntriesOf, walkList, recallAnswer, type EntryRow, type ListIO } from "./recallReader.js";
import type { PPage } from "./claimReader.js";

let pass = 0, fail = 0;
const ok = (c: unknown, m: string) => { if (c) pass++; else { fail++; console.error("✗ " + m); } };
const eq = (g: unknown, w: unknown, m: string) => ok(JSON.stringify(g) === JSON.stringify(w), `${m}: got ${JSON.stringify(g)}, want ${JSON.stringify(w)}`);
const dir = new URL("../../fixtures/recall/", import.meta.url);
const FX: Record<string, string> = {};
for (const f of readdirSync(dir).filter((x) => /detail-\w+\.html$/.test(x))) FX[f.match(/detail-(\w+)\.html$/)![1]] = readFileSync(new URL(f, dir), "utf8");
const NOFONT: FamMaps = {};
const docOf = (h: string) => new JSDOM(`<!doctype html><html><head></head>${h}</html>`).window.document;
const pageOf = (h: string): PPage => recallPageOf(docOf(h));
const rowsOf = (lot: string) => lotEntriesOf(pageOf(FX[lot]), NOFONT);

// ── hand-worked, per captured lot: dosed patients from the chart entries alone ──
// C482FU1: 12 rows, 12 patients, all Active → 12.
// 5NF133C: 16 rows = 14 chart links; Pérez, Eric has an Active entry (Dec 21) and an Entered-in-error one (Mar 11) → still
//          dosed; Garcia, Sophia has two Active entries (one record); Crawford, James is a Test record → out → 13.
// 71KM95J: 3 rows, 3 patients → 3.
// 82JG29H: 8 rows; Training, Sample is a Test record → out → 7.
// Y910RG0: 10 rows = 9 chart links (Carroll, Colleen twice) → 9. Vasquez, Jason and Garcia, Noëlle share a birth date but
//          are different names → two patients.
// 0PZ245B: its one entry is Entered in error → 0.   N909SJ1: both entries Entered in error → 0.
// 63XF12L: "Showing 1 to 25 of 27 entries" — page 1 has 24 patients (Stewart, Michael twice); entries 26-27 not captured.
const HAND: Record<string, { rows: number; dosed: string }> = {
  C482FU1: { rows: 12, dosed: "12" }, "5NF133C": { rows: 16, dosed: "13" }, "71KM95J": { rows: 3, dosed: "3" }, "82JG29H": { rows: 8, dosed: "7" },
  Y910RG0: { rows: 10, dosed: "9" }, "0PZ245B": { rows: 1, dosed: "0" }, N909SJ1: { rows: 2, dosed: "0" },
};
for (const [lot, h] of Object.entries(HAND)) {
  const e = rowsOf(lot);
  ok(!isDecline(e) && e.length === h.rows, `${lot}: ${h.rows} chart entries read by label (got ${isDecline(e) ? e.decline : e.length})`);
  if (!isDecline(e)) eq(recallAnswer(e, [], lot), h.dosed, `${lot}: dosed from chart entries (no notes) hand-worked`);
}
{
  const e = rowsOf("5NF133C") as EntryRow[];
  eq(e.filter((r) => r.testRecord).map((r) => r.name), ["Crawford, James"], "5NF133C: the Test record badge is read");
  eq(e.filter((r) => /error/i.test(r.status)).map((r) => r.name), ["Pérez, Eric"], "5NF133C: Entered in error read as the entry status");
  const r2 = rowsOf("63XF12L") as EntryRow[] | { decline: string };
  ok(isDecline(r2) && /not proven complete/.test(r2.decline), "63XF12L: page 1 of 27 alone is not a complete read → decline");
  const w = (rowsOf("63XF12L"), entryPageOf(pageOf(FX["63XF12L"]), NOFONT));
  ok(!isDecline(w) && w.rows.length === 25 && w.footer?.total === 27 && w.footer.to === 25 && w.footer.kind === "exact", "63XF12L: the page's own footer is read (1 to 25 of 27 entries)");
  ok(!isDecline(w) && w.rows.some((r) => r.name === "Wilson, Joan") && !w.rows.find((r) => r.name === "Wilson, Joan")!.testRecord, "63XF12L: a Restricted patient is kept (counts like any other)");
}

// ── reordered / re-labelled columns read by label ──
const CELLS = (lot: string) => { const d = docOf(FX[lot]); const t = [...d.querySelectorAll("table")].find((x) => /Patient/.test(x.textContent!))!; return { d, t }; };
function reorder(lot: string, order: number[], rename?: Record<number, string>) {
  const { d, t } = CELLS(lot);
  for (const tr of t.querySelectorAll("tr")) { const cs = [...tr.children]; for (const c of cs) tr.removeChild(c); for (const i of order) tr.appendChild(cs[i]); }
  if (rename) [...t.querySelectorAll("th")].forEach((th, i) => { if (rename[i] !== undefined) th.textContent = rename[i]; });
  return recallPageOf(d);
}
{
  const base = rowsOf("C482FU1") as EntryRow[];
  const rv = entryPageOf(reorder("C482FU1", [5, 4, 1, 0, 3, 2]), NOFONT);   // Entry | Given by | Patient | Date given | MRN | Date of birth
  ok(!isDecline(rv) && JSON.stringify(rv.rows.map((r) => [r.patientId, r.status])) === JSON.stringify(base.map((r) => [r.patientId, r.status])), "reordered columns: same patients and statuses");
  const fewer = entryPageOf(reorder("C482FU1", [1, 5, 0]), NOFONT);           // only Patient | Entry | Date given
  ok(!isDecline(fewer) && fewer.rows.length === 12, "missing optional columns (MRN, DOB, Given by) are fine");
  const renamed = entryPageOf(reorder("C482FU1", [0, 1, 2, 3, 4, 5], { 5: "Status", 2: "DOB" }), NOFONT);
  ok(!isDecline(renamed) && renamed.rows.length === 12, "Status / DOB synonyms read");
  ok(isDecline(entryPageOf(reorder("C482FU1", [0, 1, 2, 3, 4, 5], { 4: "Lot status" }), NOFONT)), "an extra unknown column → decline");
  ok(isDecline(entryPageOf(reorder("C482FU1", [0, 1, 2, 3, 4, 5], { 5: "Disposition" }), NOFONT)), "no status column by a known label → decline");
  ok(isDecline(entryPageOf(reorder("C482FU1", [0, 1, 2, 3, 4, 5], { 0: "Patient" }), NOFONT)), "two Patient columns → decline");
}

// ── footer / badge / value negatives on the captured markup ──
const footerSwap = (lot: string, from: string, to: string) => { const h = FX[lot]; ok(h.includes(from), `fixture ${lot} has "${from}"`); return h.replace(from, to); };
ok(isDecline(lotEntriesOf(pageOf(footerSwap("C482FU1", "12 entries", "12+ entries")), NOFONT)), "capped total (12+) never proves the end");
ok(isDecline(lotEntriesOf(pageOf(footerSwap("C482FU1", "12 entries", "about 12 entries")), NOFONT)), "estimated total never proves the end");
ok(isDecline(lotEntriesOf(pageOf(footerSwap("C482FU1", "12 entries", "13 entries")), NOFONT)), "footer total ≠ rows read → decline");
ok(isDecline(lotEntriesOf(pageOf(footerSwap("C482FU1", "12 entries", "")), NOFONT)), "no footer at all → decline");
ok(isDecline(lotEntriesOf(pageOf(footerSwap("71KM95J", "3 entries", "Showing 1 to 3 of 500+ entries")), NOFONT)), "capped pager 'of 500+' → decline");
ok(isDecline(lotEntriesOf(pageOf(footerSwap("71KM95J", "3 entries", "Showing 1 to 3 of about 500 entries")), NOFONT)), "estimated pager → decline");
ok(isDecline(lotEntriesOf(pageOf(footerSwap("71KM95J", "3 entries", "Showing 1 to 3 of 30 entries")), NOFONT)), "pager that says more exist → decline");
ok(isDecline(lotEntriesOf(pageOf(FX["71KM95J"].replace(">Active<", ">Merged<")), NOFONT)) || recallAnswer(lotEntriesOf(pageOf(FX["71KM95J"].replace(">Active<", ">Merged<")), NOFONT) as EntryRow[], [], "71KM95J") !== "3", "an unknown entry status never counts as a dose");
ok(isDecline(recallAnswer(lotEntriesOf(pageOf(FX["71KM95J"].replace(">Active<", ">On hold<")), NOFONT) as EntryRow[], [], "71KM95J")), "unknown entry status value → decline at the count");
ok(isDecline(lotEntriesOf(pageOf(FX["71KM95J"].replace(">Nguyen, Elizabeth</a>", ">Nguyen, Elizabeth</a><span> Merged</span>")), NOFONT)), "an unknown badge (Merged) on a patient → decline");
ok(isDecline(lotEntriesOf(pageOf(FX["71KM95J"].replace(/<a href="\/patients\/6nn6bts4vj"[^>]*>Nguyen, Elizabeth<\/a>/, "Nguyen, Elizabeth")), NOFONT)), "a patient without a chart link → decline");
{
  // a patient listed under two record ids with one name (merged duplicate / namesake) must not be counted twice or once blindly
  const dup = FX["71KM95J"].replace("/patients/1tgb02jj1t", "/patients/6nn6bts4vj");   // Perry, Donna now shares Nguyen's record id
  const e = lotEntriesOf(pageOf(dup), NOFONT) as EntryRow[];
  eq(recallAnswer(e, [], "71KM95J"), "2", "two names on one record id count once (record number = chart link)");
  const twin = FX["71KM95J"].replace(">Perry, Donna<", ">Nguyen, Elizabet<").replace("/patients/1tgb02jj1t", "/patients/zzzzzzzzzz");
  const et = lotEntriesOf(pageOf(twin), NOFONT) as EntryRow[];
  ok(!isDecline(et), "namesake fixture reads");
  // same name, two record ids
  const same = FX["71KM95J"].replace(">Perry, Donna<", ">Nguyen, Elizabeth<");
  ok(isDecline(recallAnswer(lotEntriesOf(pageOf(same), NOFONT) as EntryRow[], [], "71KM95J")), "same name on two record ids → decline");
  // near-twin: same birth date + a name one edit apart
  const rows: EntryRow[] = [
    { patientId: "/patients/a", name: "Nguyen, Elizabeth", status: "Active", testRecord: false, dob: "11/01/2010" },
    { patientId: "/patients/b", name: "Nguyen, Elizabet", status: "Active", testRecord: false, dob: "11/01/2010" }];
  ok(isDecline(recallAnswer(rows, [], "X")), "same birth date + name one edit apart (misspelled duplicate) → decline");
  eq(recallAnswer([rows[0], { ...rows[1], name: "Vasquez, Jason" }], [], "X"), "2", "same birth date, different people → both counted (Y910RG0's Vasquez / Garcia)");
}

// ── the walk: 27 entries at 25 per page (63XF12L). Page 2 and the 100-per-page page are SYNTHETIC (see header). ──
const P1 = FX["63XF12L"];
const tbodyRows = (h: string) => [...docOf(h).querySelectorAll("table")].find((x) => /Patient/.test(x.textContent!))!.querySelectorAll("tbody tr").length;
eq(tbodyRows(P1), 25, "63XF12L fixture page 1 has 25 rows");
const page = (rows: number, footer: string, extra?: (tr: Element[]) => void) => {
  const d = docOf(P1);
  const t = [...d.querySelectorAll("table")].find((x) => /Patient/.test(x.textContent!))!;
  const body = t.querySelector("tbody")!; const trs = [...body.querySelectorAll("tr")];
  const keep: Element[] = [];
  for (let i = 0; i < rows; i++) { const src = trs[i % trs.length].cloneNode(true) as Element; keep.push(src); }
  extra?.(keep);
  body.innerHTML = ""; keep.forEach((r) => body.appendChild(r));
  [...d.querySelectorAll("p")].find((p) => /^Showing 1 to 25 of 27 entries$/.test(p.textContent!.trim()))!.textContent = footer;
  return recallPageOf(d);
};
// page 2: two entries — a new patient and Phillips, Brenda again with Entered in error (still dosed via her page-1 Active entry)
const page2 = (footer = "Showing 26 to 27 of 27 entries") => page(2, footer, (keep) => {
  const setPatient = (tr: Element, id: string, name: string, status: string) => { const a = tr.querySelector("a")!; a.setAttribute("href", "/patients/" + id); a.textContent = name; tr.lastElementChild!.textContent = status; };
  setPatient(keep[0], "newpatient1", "Zed, Zoe", "Active");
  setPatient(keep[1], "350bjht8zx", "Phillips, Brenda", "Entered in error");
});
// raised: all 27 on one page (rows 26-27 from page 2)
const all27 = () => page(27, "Showing 1 to 27 of 27 entries", (keep) => {
  const setPatient = (tr: Element, id: string, name: string, status: string) => { const a = tr.querySelector("a")!; a.setAttribute("href", "/patients/" + id); a.textContent = name; tr.lastElementChild!.textContent = status; };
  setPatient(keep[25], "newpatient1", "Zed, Zoe", "Active");
  setPatient(keep[26], "350bjht8zx", "Phillips, Brenda", "Entered in error");
});
// 24 patients on page 1 (Stewart twice) + Zed, Zoe = 25 dosed; Phillips' error entry changes nothing.
const WALK_ANSWER = "25";
type Site = { first: PPage; raised?: PPage; second?: PPage; nextWorks?: boolean; log: string[] };
function io(s: Site, opts: { raiseFails?: boolean } = {}): ListIO {
  let cur = s.first;
  return {
    async read() { return { page: cur, fm: NOFONT }; },
    async raise() { s.log.push("raise"); if (opts.raiseFails || !s.raised) return false; cur = s.raised; return true; },
    async next(from) { s.log.push("next" + from); if (s.nextWorks === false || !s.second) return false; cur = s.second; return true; },
  };
}
(async () => {
  {
    const s: Site = { first: pageOf(P1), raised: all27(), second: page2(), log: [] };
    const r = await walkList(io(s), entryPageOf);
    ok(!isDecline(r) && r.length === 27, `walk with Rows per page raised: 27 entries (${isDecline(r) ? r.decline : r.length})`);
    eq(s.log, ["raise"], "walk: raised once, no Next needed");
    if (!isDecline(r)) eq(recallAnswer(r, [], "63XF12L"), WALK_ANSWER, "63XF12L: dosed from chart entries, hand-worked 24 + 1");
  }
  {
    const s: Site = { first: pageOf(P1), second: page2(), log: [] };
    const r = await walkList(io(s, { raiseFails: true }), entryPageOf);
    ok(!isDecline(r) && r.length === 27, `walk by Next (no size control): 25 + 2 (${isDecline(r) ? r.decline : r.length})`);
    eq(s.log, ["raise", "next26"], "walk: asked for the page starting at entry 26");
    if (!isDecline(r)) eq(recallAnswer(r, [], "63XF12L"), WALK_ANSWER, "same answer by the two routes");
  }
  {   // negatives
    const dec = async (name: string, s: Site, o = {}) => { const r = await walkList(io(s, o), entryPageOf); ok(isDecline(r), `walk declines: ${name} (${isDecline(r) ? r.decline.slice(0, 70) : "answered"})`); return r; };
    await dec("Next does not work", { first: pageOf(P1), second: page2(), nextWorks: false, log: [] }, { raiseFails: true });
    await dec("no second page", { first: pageOf(P1), log: [] }, { raiseFails: true });
    await dec("page 2 starts at the wrong row", { first: pageOf(P1), second: page2("Showing 25 to 26 of 27 entries"), log: [] }, { raiseFails: true });
    await dec("page 2 states another total", { first: pageOf(P1), second: page2("Showing 26 to 27 of 28 entries"), log: [] }, { raiseFails: true });
    await dec("page 2 only an estimate", { first: pageOf(P1), second: page2("Showing 26 to 27 of about 27 entries"), log: [] }, { raiseFails: true });
    await dec("page 2 ends short of the total", { first: pageOf(P1), second: page2("Showing 26 to 26 of 27 entries"), log: [] }, { raiseFails: true });
    await dec("page 2 repeats page 1's range", { first: pageOf(P1), second: pageOf(P1), log: [] }, { raiseFails: true });
    const capped = pageOf(P1.replace("Showing 1 to 25 of 27 entries", "Showing 1 to 25 of 27+ entries"));
    const sc: Site = { first: capped, second: page2(), log: [] };
    await dec("total is only a lower bound (27+)", sc, { raiseFails: true });
    ok(!sc.log.includes("next26"), "capped pager: no Next pressed, nothing walked");
    await dec("total is an estimate", { first: pageOf(P1.replace("Showing 1 to 25 of 27 entries", "Showing 1 to 25 of about 27 entries")), second: page2(), log: [] });
    // the raised page changes shape
    await dec("raised page lists a different total", { first: pageOf(P1), raised: page(27, "Showing 1 to 27 of 40 entries"), log: [] });
    await dec("raised page rows disagree with its own range", { first: pageOf(P1), raised: page(26, "Showing 1 to 27 of 27 entries"), log: [] });
    const reh = page2(); (reh.sections.find((x) => /chart entr/i.test(x.heading))!.tables[0].headers)[2] = "Date of death";
    await dec("columns change between pages", { first: pageOf(P1), second: reh, log: [] }, { raiseFails: true });
    const emptyThenData = await walkList(io({ first: pageOf(FX["0PZ245B"]), log: [] }), entryPageOf);
    ok(!isDecline(emptyThenData) && emptyThenData.length === 1, "a single-page lot walks without raise or Next");
  }
  {   // a page that is the captured EMPTY statement still reads as []
    const d = docOf(FX["C482FU1"]); const sec = [...d.querySelectorAll("section")].find((x) => /Chart entries with this lot/.test(x.textContent!))!;
    sec.innerHTML = `<h2><span>Chart entries with this lot</span></h2><p>No chart entry names this lot</p>`;
    const r = await walkList(io({ first: recallPageOf(d), log: [] }), entryPageOf);
    eq(r, [], "explicit empty statement → no entries");
  }
  {   // the LIVE IO (liveIO: select by label, Next by label, settle) against a jsdom stand-in for the app, markup = the captured page
    const { liveIO, entryFooterOf } = await import("./recallReader.js");
    const sim = (opts: { size: boolean; next: boolean }) => {
      const d = docOf(P1); const win = d.defaultView!;
      const tbody = [...d.querySelectorAll("table")].find((x) => /Patient/.test(x.textContent!))!.querySelector("tbody")!;
      const orig = [...tbody.querySelectorAll("tr")];
      const extra = [orig[0], orig[1]].map((tr, i) => { const c = tr.cloneNode(true) as Element; const a = c.querySelector("a")!; a.setAttribute("href", "/patients/extra" + i); a.textContent = "Extra, Person " + i; return c; });
      const all = [...orig, ...extra];
      const foot = [...d.querySelectorAll("p")].find((p) => /^Showing 1 to 25/.test(p.textContent!.trim()))!;
      const show = (rows: Element[], text: string) => { tbody.innerHTML = ""; rows.forEach((r) => tbody.appendChild(r)); foot.textContent = text; };
      const sel = d.querySelector("select")!;
      if (!opts.size) sel.closest("label")!.remove(); else sel.addEventListener("change", () => show(all, `Showing 1 to ${all.length} of 27 entries`));
      const nextBtn = [...d.querySelectorAll("button")].find((b) => b.textContent === "Next")!;
      if (!opts.next) nextBtn.setAttribute("disabled", ""); else nextBtn.addEventListener("click", () => show(extra, "Showing 26 to 27 of 27 entries"));
      const crawler: any = { evalApp: async (code: string) => new Function("doc", "window", code)(d, win) };
      return crawler;
    };
    const runLive = async (c: any) => walkList(liveIO(c, (x: PPage) => x.sections.some((s) => /chart entr/i.test(s.heading)), entryFooterOf), entryPageOf);
    const a = await runLive(sim({ size: true, next: true }));
    ok(!isDecline(a) && a.length === 27, `live IO: Rows per page raised through the real select (${isDecline(a) ? a.decline : a.length})`);
    const b = await runLive(sim({ size: false, next: true }));
    ok(!isDecline(b) && b.length === 27 && b[26].name === "Extra, Person 1", `live IO: Next pressed through the real button (${isDecline(b) ? b.decline : b.length})`);
    const n = await runLive(sim({ size: false, next: false }));
    ok(isDecline(n), "live IO: no size control and a disabled Next → decline");
  }
  console.log(`${fail ? "✗" : "✓"} recallEntries: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
