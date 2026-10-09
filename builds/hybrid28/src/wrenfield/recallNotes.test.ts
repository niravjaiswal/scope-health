/**
 * vaccine-lot-recall: the NOTE SEARCH read from the 4 pages Set 1 run 265 captured (fixtures/recall/note-search-*.html, the
 * recall_probe events; markup verbatim) and the count they give with the lot-detail pages of run 278:  npx tsx src/wrenfield/recallNotes.test.ts
 *
 * Layout (real): Vaccines > Note search = one form (label "Text in the note", button "Search notes") and, after a search, a list
 * "Notes found, newest first" of cards (article: header = kind, patient link, born / MRN, author, <time datetime=UTC>; p = the
 * note) followed by the footer "16 notes" (empty pager div). It is NOT a table: the run-265 reader declined 7 lots with
 * "note search shows neither a results table nor an empty statement".
 *
 * Hand-worked (message n=76; patient = chart link; dosed = Active entry not in error, not a test record, or a "given here" note;
 * notified = a note that the notice/letter for this lot was mailed / sent through the portal / given in person; asked-about-the-
 * recall notes with "did not receive a dose" and "No letter is needed" are neither):
 *   C482FU1  12 Active entries + Hamilton, Priya (dose only in a note: "Procedure note … Lot C482FU1") = 13 dosed; 13 notices
 *            (all 12 entry patients + Hamilton); White, Patricia asked and was not dosed                       → 0
 *   5NF133C  13 entry patients (Pérez twice-entered, one in error; Garcia twice; Crawford a Test record) + Murphy, Larry and
 *            Alvarez, Billy (dose only in notes) = 15 dosed; 15 notices; Ward, Emma / Johnson, Bryan asked, not dosed → 0
 *   71KM95J  3 entry patients, 3 notices (Ramos, Nancy asked, not dosed)                                       → 0
 *   63XF12L  entries 25 of 27 captured: 24 patients; its 3 notes are dose notes of patients who already have an entry; no notice
 *            → between 24 and 26 (entries 26-27 not captured; the live reader walks them)
 * Ground truth for the validation of the entry side: key.json (Set 1 judged 0 wrong) says 97 Y910RG0 → 9, 109 0PZ245B → 0,
 * 110 N909SJ1 → 0 (their note searches were empty: the run-265 reader answered them), 177 22UP75G → 14 (no capture).
 * SYNTHETIC (marked): the empty note-search page, the pre-search form, mutations of the captured cards.
 */
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { isDecline } from "./familyReaders.js";
import type { FamMaps } from "./claimReader.js";
import { recallPageOf, noteResultsOf, notePageOf, lotEntriesOf, recallAnswer, searchNotes, type EntryRow, type NoteRow } from "./recallReader.js";
import { classifyRecallNote, recallCount, isSkip } from "./immunizations.js";

let pass = 0, fail = 0;
const ok = (c: unknown, m: string) => { if (c) pass++; else { fail++; console.error("✗ " + m); } };
const eq = (g: unknown, w: unknown, m: string) => ok(JSON.stringify(g) === JSON.stringify(w), `${m}: got ${JSON.stringify(g)}, want ${JSON.stringify(w)}`);
const dir = new URL("../../fixtures/recall/", import.meta.url);
const rd = (f: string) => readFileSync(new URL(f, dir), "utf8");
const NS: Record<string, string> = {}, DT: Record<string, string> = {};
for (const lot of ["C482FU1", "5NF133C", "71KM95J", "63XF12L", "Y910RG0", "0PZ245B", "N909SJ1"]) {
  if (lot !== "Y910RG0" && lot !== "0PZ245B" && lot !== "N909SJ1") NS[lot] = rd(`note-search-${lot}.html`);
}
for (const [lot, f] of Object.entries({ C482FU1: "07", "5NF133C": "09", "71KM95J": "12", "63XF12L": "14", Y910RG0: "17", "0PZ245B": "19", N909SJ1: "20" })) DT[lot] = rd(`${f}-recall_probe-lot-detail-${lot}.html`);
const NOFONT: FamMaps = {};
const docOf = (h: string) => new JSDOM(`<!doctype html><html><head></head>${h}</html>`).window.document;
const pageOf = (h: string) => recallPageOf(docOf(h));
const notesOf = (lot: string, h = NS[lot]) => noteResultsOf(pageOf(h), NOFONT, lot);
const entriesOf = (lot: string) => lotEntriesOf(pageOf(DT[lot]), NOFONT);

// ── the captured pages read as cards ──
const HAND: Record<string, { notes: number; kinds: Record<string, number>; noteOnly: string[]; answer: string | null }> = {
  C482FU1: { notes: 16, kinds: { notified: 13, "no-dose": 1, dose: 2 }, noteOnly: ["Hamilton, Priya"], answer: "0" },
  "5NF133C": { notes: 20, kinds: { notified: 15, "no-dose": 2, dose: 3 }, noteOnly: ["Alvarez, Billy", "Murphy, Larry"], answer: "0" },
  "71KM95J": { notes: 4, kinds: { notified: 3, "no-dose": 1 }, noteOnly: [], answer: "0" },
  "63XF12L": { notes: 3, kinds: { dose: 3 }, noteOnly: [], answer: null },
};
for (const [lot, h] of Object.entries(HAND)) {
  const pg = pageOf(NS[lot]);
  eq(pg.cards?.length, h.notes, `${lot}: ${h.notes} cards found outside any <section>`);
  ok(/\n\d+ notes$/.test(pg.outside ?? ""), `${lot}: the footer line sits outside the cards`);
  const n = notesOf(lot);
  ok(!isDecline(n) && n.length === h.notes, `${lot}: ${h.notes} notes read, footer "${h.notes} notes" proves the list complete (${isDecline(n) ? n.decline : n.length})`);
  if (isDecline(n)) continue;
  const kinds: Record<string, number> = {};
  for (const r of n) { const k = classifyRecallNote(r.body, lot); kinds[k] = (kinds[k] ?? 0) + 1; }
  eq(Object.entries(kinds).sort(), Object.entries(h.kinds).sort(), `${lot}: hand-labelled note kinds`);
  ok(n.every((r) => /^\/patients\/\w+$/.test(r.patientId) && /^\d{4}-\d\d-\d\d$/.test(r.dateISO) && /^\d\d:\d\d:\d\d$/.test(r.time ?? "") && !r.testRecord), `${lot}: patient ids, UTC dates and times read`);
  const e = entriesOf(lot);
  if (isDecline(e)) { ok(lot === "63XF12L", `${lot}: entries read (${e.decline})`); continue; }
  const ids = new Set(e.map((x) => x.patientId));
  eq(n.filter((r) => classifyRecallNote(r.body, lot) === "dose" && !ids.has(r.patientId)).map((r) => r.name).sort(), h.noteOnly, `${lot}: patients dosed only in a note`);
  eq(recallAnswer(e, n, lot), h.answer, `${lot}: hand-worked count`);
}
{   // 63XF12L: only page 1 of the entries was captured, so the count is a floor the live walk completes
  const e = entriesOf("63XF12L");
  ok(isDecline(e) && /not proven complete/.test(e.decline), "63XF12L: page 1 of 27 entries alone is not a complete read");
  const n = notesOf("63XF12L") as NoteRow[];
  ok(n.length === 3 && n.every((r) => classifyRecallNote(r.body, "63XF12L") === "dose"), "63XF12L: three dose notes, no notice at all");
}

// ── the entry side reproduces the judged answers of the lots whose note search was empty (run 265: 97 → 9, 109 → 0, 110 → 0) ──
{
  const EMPTY = `<body><div><header><h1>Vaccines</h1></header><nav aria-label="Vaccines"><a href="/vaccines/notes" aria-current="page">Note search</a></nav>
    <section aria-label="Search"><form aria-label="Search notes"><label for="words">Text in the note</label><input id="words" name="words" type="text" value=""><button type="submit">Search notes</button></form></section>
    <div><div><p aria-live="polite">No notes found.</p><div></div></div></div></div></body>`;   // SYNTHETIC wording: only the explicit empty statement matters
  for (const [lot, want] of [["Y910RG0", "9"], ["0PZ245B", "0"], ["N909SJ1", "0"]] as const) {
    const n = notesOf(lot, EMPTY), e = entriesOf(lot);
    ok(Array.isArray(n) && n.length === 0 && !isDecline(e), `${lot}: empty note search + entries read`);
    if (!isDecline(n) && !isDecline(e)) eq(recallAnswer(e, n, lot), want, `${lot}: judged answer (key.json) reproduced`);
  }
  eq(notesOf("Y910RG0", EMPTY.replace("No notes found.", "0 notes")), [], "an explicit '0 notes' footer is an empty list too");
  eq(notesOf("Y910RG0", EMPTY.replace('<p aria-live="polite">No notes found.</p>', "<article><p>No notes found.</p></article>")), [], "an empty-state box drawn as an <article> without a note header is not a note");
  ok(isDecline(notesOf("Y910RG0", EMPTY.replace("No notes found.", ""))), "no cards, no empty statement, no footer → decline");
  ok(isDecline(notesOf("Y910RG0", EMPTY.replace("No notes found.", "Wrenfield is not responding. Try again in a moment."))), "a visible not-responding message is not an empty list");
  ok(isDecline(notesOf("Y910RG0", EMPTY.replace("No notes found.", "12 notes"))), "a footer that counts notes but shows none → decline");
}

// ── mutations of the captured cards (SYNTHETIC edits of the real markup) ──
const C = "C482FU1";
const mut = (from: string | RegExp, to: string, lot = C) => { const h = NS[lot]; ok(typeof from === "string" ? h.includes(from) : from.test(h), `fixture has ${String(from).slice(0, 50)}`); return h.replace(from, to); };
const ansWith = (h: string, lot = C) => { const n = notesOf(lot, h), e = entriesOf(lot); return isDecline(n) ? n : isDecline(e) ? e : recallAnswer(e, n, lot); };
eq(ansWith(NS[C]), "0", "baseline C482FU1 → 0");
eq(ansWith(mut("Recall notice for Td (Tenivac) lot C482FU1 mailed to Shirley at the address on file.", "Recall notice for Td (Tenivac) lot C482FU1 came back undeliverable.")), "1", "Shirley's only notice came back → left to notify (1)");
ok(isDecline(ansWith(mut("Recall notice for Td (Tenivac) lot C482FU1 mailed to Shirley at the address on file.", "Recall notice for Td (Tenivac) lot C482FU1 will be mailed to Shirley."))), "a notice that WILL be mailed → unclear → decline, never 'notified'");
{
  // drop the first card of a named patient: remove the <li> that contains the text
  const dropCard = (h: string, text: string) => { const d = docOf(h); const li = [...d.querySelectorAll("li")].find((x) => x.textContent!.includes(text))!; li.remove(); const p = [...d.querySelectorAll("p")].find((x) => /^\d+ notes$/.test(x.textContent!.trim()))!; p.textContent = `${d.querySelectorAll("li").length} notes`; return d.body.outerHTML; };
  eq(ansWith(dropCard(NS[C], "mailed to Shirley")), "1", "Shirley's notice removed → she is left (1)");
  eq(ansWith(dropCard(NS[C], "mailed to Priya")), "1", "Priya (dose only in a note) has no notice → left (1)");
  eq(ansWith(dropCard(dropCard(NS[C], "mailed to Priya"), "Procedure note: Td (Tenivac) administered")), "0", "no Priya notice and no Priya dose note → she was never dosed (0)");
  eq(ansWith(dropCard(NS[C], "Patricia asked about the recall")), "0", "the 'asked, not dosed' note changes nothing");
  const base = pageOf(NS[C]).cards!.length;
  eq(base, 16, "16 cards before the edits");
}
ok(isDecline(ansWith(mut("</a>   </span>", "</a> <span>Merged</span></span>"))), "an unknown badge beside a patient link → decline");
{
  const d = docOf(NS[C]); const a = d.querySelector("article a")!; (a.closest("span") as Element).insertAdjacentHTML("beforeend", `<span>Test record</span>`);
  eq(ansWith(d.body.outerHTML), "1", "a note on a TEST record is not a notification (Sanders' notice ignored → 1)");
}
ok(isDecline(ansWith(mut(/<a href="\/patients\/2nh6hd42gg"[^>]*>Sanders, Shirley<\/a>/, "Sanders, Shirley"))), "a card without a patient link → decline");
ok(isDecline(ansWith(mut("</a>   </span>", "</a> <a href=\"/patients/zzzz\">x</a></span>"))), "a card with two links in its header → decline");
ok(isDecline(ansWith(mut(/<time datetime="2023-10-22T16:43:07Z">/, '<time datetime="2023-10-22 10:43">'))), "a card whose time is not a UTC stamp → decline");
ok(isDecline(ansWith(mut(/<time datetime="2023-10-22T16:43:07Z">/, '<time>'))), "a card without a time → decline");
ok(isDecline(ansWith(mut("mailed to Shirley at the address on file.", "mailed to Shirley at the address on…"))), "a note cut short → decline");
ok(isDecline(ansWith(mut("Recall notice for Td (Tenivac) lot C482FU1 mailed to Shirley at the address on file.", "Recall notice for Td (Tenivac) mailed to Shirley at the address on file."))), "a result that does not name the lot (search not applied) → decline");
ok(isDecline(ansWith(mut("16 notes", "17 notes"))), "footer total above the rows → decline");
ok(isDecline(ansWith(mut("16 notes", "15 notes"))), "footer total below the rows → decline");
ok(isDecline(ansWith(mut("16 notes", "16+ notes"))), "a capped total (16+) → decline");
ok(isDecline(ansWith(mut("16 notes", "about 16 notes"))), "an estimated total → decline");
ok(isDecline(ansWith(mut("16 notes", ""))), "no footer → decline (a cap is unprovable)");
ok(isDecline(ansWith(mut("16 notes", "Showing 1 to 16 of 40 notes"))), "a pager that says more pages exist → decline in the single-page read");
ok(isDecline(ansWith(NS[C].replace("</body>", `<div role="status">Wrenfield is not responding. Try again in a moment.</div></body>`))), "a visible not-responding banner → decline");
ok(!isDecline(ansWith(NS[C].replace("</body>", `<div role="status" hidden>Wrenfield is not responding. Try again in a moment.</div></body>`))), "the hidden banner the app always carries is ignored");
{   // two record ids with one name: identity unproven
  const h = mut('href="/patients/3f242d7wpk"', 'href="/patients/zzzzzzzzzz"');   // Hamilton, Priya's two other cards keep the real id
  ok(isDecline(ansWith(h)), "one name on two record ids → decline");
}
{   // a note naming ANOTHER lot is never guessed
  ok(isDecline(ansWith(mut("Patricia did not receive a dose from that lot.", "Patricia did not receive a dose from that lot (chart: lot ZZ99001)."))), "an asked-note naming another lot, outside the closed templates → decline");
}

// ── note classification: the captured templates, then the distractors the message names ──
const K = (b: string, lot = "L1X2Y3Z") => classifyRecallNote(b, lot);
eq(K("Recall notice for Td (Tenivac) lot L1X2Y3Z mailed to Shirley at the address on file."), "notified", "captured: mailed");
eq(K("Letter about the recall of vaccine lot L1X2Y3Z sent to Anthony through the patient portal."), "notified", "captured: portal");
eq(K("Recall letter for lot L1X2Y3Z given to Ruth in person at the front desk."), "notified", "captured: in person");
eq(K("Patricia asked about the recall of lot L1X2Y3Z. Patricia did not receive a dose from that lot. No recall letter was sent."), "no-dose", "captured: asked, not dosed");
eq(K("Emma called to ask whether the vaccine given here was from recalled lot L1X2Y3Z. It was not: the chart shows lot 8KC109X. No letter is needed."), "no-dose", "captured: asked, chart shows another lot");
eq(K("Emma called to ask whether the vaccine given here was from recalled lot 8KC109X. It was not: the chart shows lot L1X2Y3Z. No letter is needed."), "no-dose", "SYNTHETIC mirror: a note about another lot's recall that shows this lot only as the chart's lot");
eq(K("Emma called to ask whether the vaccine given here was from recalled lot 8KC109X. It was not: the chart shows lot 7AA222B. No letter is needed."), "irrelevant", "a note without this lot is not about it");
eq(K("Procedure note: Td (Tenivac) 0.5 mL given IM in the left deltoid. Lot L1X2Y3Z, expires 2024-12-26. Vaccine information statement given. No reaction after 15 minutes."), "dose", "captured dose: procedure note");
eq(K("Td (Tenivac) given today in the left deltoid, lot number L1X2Y3Z. Billy tolerated the injection well."), "dose", "captured dose: given today");
eq(K("Procedure note: Influenza (Fluzone) administered at this visit, right deltoid. Lot L1X2Y3Z. No immediate reaction."), "dose", "captured dose: administered at this visit");
eq(K("Nurse visit. Gave Td (Tenivac) in the left deltoid (lot L1X2Y3Z). Doris left in good condition."), "dose", "captured dose: nurse visit");
eq(K("Recall letter for lot L1X2Y3Z came back undeliverable."), "returned", "SYNTHETIC: returned");
eq(K("Recall letter for lot L1X2Y3Z was returned by the post office."), "returned", "SYNTHETIC: returned by the post office");
eq(K("No recall letter is needed for lot L1X2Y3Z."), "not-notification", "SYNTHETIC: no letter needed");
eq(K("No recall letter was mailed for lot L1X2Y3Z."), "not-notification", "SYNTHETIC: 'no letter was mailed' is not a notification");
eq(K("Recall letter for lot L1X2Y3Z was not given to Ann in person."), "not-notification", "SYNTHETIC: 'not given in person'");
eq(K("Recall notice for lot L1X2Y3Z could not be sent through the portal."), "unclear", "SYNTHETIC: a failed send is not guessed");
eq(K("Td given at the pharmacy, lot L1X2Y3Z, per the patient's pharmacy record."), "outside-dose", "SYNTHETIC: a pharmacy's dose with the same lot");
eq(K("Td given at another clinic today, lot number L1X2Y3Z."), "outside-dose", "SYNTHETIC: another clinic's dose");
// run s3a item 112 (captured from the note search page of lot TF0252R, the one note the run could not classify)
eq(K("William brought a receipt from Dunmore Urgent Care for MenACWY (Menveo) given there on 2025-11-19 (lot TF0252R). This clinic did not give the dose.", "TF0252R"), "outside-dose", "s3a 112 captured: an urgent care's dose with the same lot, receipt brought in");
eq(K("Receipt from Riverside Pharmacy for MenACWY (Menveo) given there on 2025-11-19 (lot TF0252R).", "TF0252R"), "outside-dose", "s3a 112 paraphrase: a pharmacy receipt");
eq(K("MenACWY (Menveo) given at the county health department on 2025-11-19, lot TF0252R, per the record the patient brought.", "TF0252R"), "outside-dose", "s3a 112 paraphrase: health department");
eq(K("Nurse visit. Gave MenACWY (Menveo) in the right deltoid (lot TF0252R). William left in good condition.", "TF0252R"), "dose", "s3a 112 mutation: the same lot given HERE is a dose");
eq(K("William brought a receipt from Dunmore Urgent Care for MenACWY (Menveo) given there on 2025-11-19 (lot 9ET897B). This clinic did not give the dose.", "TF0252R"), "irrelevant", "s3a 112 mutation: another lot's outside dose is not about this lot");
eq(K("William asked whether the MenACWY (Menveo) given there on 2025-11-19 (lot TF0252R) at Dunmore Urgent Care is recalled.", "TF0252R"), "unclear", "s3a 112 mutation: a question about an outside dose is not guessed (asked, no closed template)");
eq(K("Td given today in the left deltoid, lot number L1X2Y3Z. Patient declined the second dose."), "unclear", "SYNTHETIC: a declined dose is not guessed");
eq(K("Recall notice for lot L1X2Y3Z will be mailed to Shirley."), "unclear", "SYNTHETIC: future tense");
eq(K("Recall notice for lot L1X2Y3Z to be mailed next week."), "unclear", "SYNTHETIC: planned");
eq(K("Recall notice for lot L1X2Y3Z: patient reached by phone."), "unclear", "SYNTHETIC: a notice in no listed form");
eq(K("Patricia asked about the recall of lot L1X2Y3Z."), "unclear", "an inquiry outside the closed templates");
eq(K("Patricia asked about the recall of lot L1X2Y3Z. She got her dose here. No recall letter was sent."), "unclear", "an inquiry that does not say 'not from the lot'");
eq(K("Recall of lot ZZ11223A; chart shows lot L1X2Y3Z."), "unclear", "another lot named outside the closed templates");
eq(K("Recall notice for lot L1X2Y3Z mailed to Shirley; her chart shows lot ZZ11223A."), "unclear", "a notice naming a second lot");
{
  const r = recallCount([{ patientId: "/patients/a", status: "Active", testRecord: false }], [{ patientId: "/patients/a", dateISO: "2026-01-01", time: "10:00:00", body: "Recall letter for lot L1X2Y3Z will be mailed.", testRecord: false }], "L1X2Y3Z");
  ok(isSkip(r), "an unclassifiable note skips the count");
  const two = (t1: string, b1: string, t2: string, b2: string) => recallCount([{ patientId: "/patients/a", status: "Active", testRecord: false }], [
    { patientId: "/patients/a", dateISO: "2026-01-01", time: t1, body: b1, testRecord: false }, { patientId: "/patients/a", dateISO: "2026-01-01", time: t2, body: b2, testRecord: false }], "L1X2Y3Z");
  const SENT = "Recall letter for lot L1X2Y3Z given to Ann in person at the front desk.", BACK = "Recall letter for lot L1X2Y3Z came back undeliverable.";
  eq(two("09:00:00", SENT, "09:00:05", BACK), "1", "sent, then returned five seconds later → the later note wins → 1 left");
  eq(two("09:00:05", SENT, "09:00:00", BACK), "0", "returned, then sent five seconds later → notified → 0");
  ok(isSkip(two("09:00:00", SENT, "09:00:00", BACK)), "sent and returned at the same instant → skip");
}

// ── live: searchNotes through the real form and the captured results (jsdom stand-in for the app) ──
(async () => {
  const sim = (lot: string, results: string) => {
    const full = docOf(results), win = full.defaultView!;
    const list = full.querySelector("ul")!.parentElement!.parentElement!;   // the results container (cards + footer)
    const resultsHtml = list.outerHTML;
    list.remove();                                                          // SYNTHETIC pre-search form: the captured page without its results
    const d = full;
    const wire = () => { const f = d.querySelector("form")!; f.addEventListener("submit", (e) => { e.preventDefault(); const typed = (d.querySelector("input") as HTMLInputElement).value; if (typed !== lot) return; d.querySelector("div div")!.insertAdjacentHTML("beforeend", resultsHtml); }); };
    wire();
    const log: string[] = [];
    const crawler: any = {
      evalApp: async (code: string) => new Function("doc", "window", "Event", code)(d, win, win.Event),   // the browser's own Event class
      navTo: async (href: string, _m: unknown, _ms?: number, fresh?: boolean) => { log.push("nav " + href + (fresh ? " fresh" : "")); return true; },
    };
    return { crawler, log, d };
  };
  const out = process.stdout.write.bind(process.stdout); let probes = 0;     // recall_probe events the reader logs
  process.stdout.write = ((x: any) => { if (String(x).includes('"event":"recall_probe"')) { probes++; return true; } return out(x); }) as any;
  for (const lot of ["C482FU1", "5NF133C", "71KM95J", "63XF12L"]) {
    const s = sim(lot, NS[lot]); const t0 = Date.now();
    const r = await searchNotes(s.crawler, lot);
    ok(!isDecline(r) && r.length === HAND[lot].notes, `live ${lot}: typed into "Text in the note", submitted, ${HAND[lot].notes} cards walked (${isDecline(r) ? r.decline : r.length}) in ${Date.now() - t0} ms`);
    ok(s.log.length === 1 && s.log[0] === "nav /vaccines/notes fresh", `live ${lot}: one navigation to the Note search link`);
  }
  eq(probes, 0, "a page the reader understands is not logged as a probe (no cost on the answered path)");
  {   // SYNTHETIC paging: a lot with more than 25 notes. The pager slot of the captured footer (the empty div after "16 notes") is where the
      // app's list component draws "Showing 1 to 25 of 30 notes" + Rows per page + Previous/1/2/Next, as it does for the chart entries.
    const lot = "5NF133C";
    const paged = (opts: { size: boolean; next: boolean }) => {
      const d = docOf(NS["5NF133C"]), win = d.defaultView!;
      const ul = d.querySelector("ul")!, box = ul.parentElement!.parentElement!, foot = box.querySelector("p[aria-live]")!;
      const base = [...ul.querySelectorAll("li")], all: Element[] = [...base];
      for (let i = 0; all.length < 30; i++) { const c = base[i].cloneNode(true) as Element; const a = c.querySelector("a")!; a.setAttribute("href", "/patients/clone" + i); a.textContent = "Clone, Person " + i; all.push(c); }
      const show = (rows: Element[], text: string) => { ul.innerHTML = ""; rows.forEach((r) => ul.appendChild(r)); foot.textContent = text; };
      show(all.slice(0, 25), "Showing 1 to 25 of 30 notes");
      foot.nextElementSibling!.innerHTML = `<label><span>Rows per page</span><select name="size"><option value="25" selected>25 per page</option><option value="50">50 per page</option><option value="100">100 per page</option></select></label><button type="button" disabled>Previous</button><button type="button" aria-current="page">1</button><button type="button">2</button><button type="button"${opts.next ? "" : " disabled"}>Next</button>`;
      const pg = foot.nextElementSibling!;
      if (!opts.size) pg.querySelector("label")!.remove(); else pg.querySelector("select")!.addEventListener("change", () => show(all, "Showing 1 to 30 of 30 notes"));
      [...pg.querySelectorAll("button")].find((b) => b.textContent === "Next")!.addEventListener("click", () => show(all.slice(25), "Showing 26 to 30 of 30 notes"));
      box.remove();
      d.querySelector("form")!.addEventListener("submit", (e) => { e.preventDefault(); d.querySelector("div div")!.appendChild(box); });
      return { evalApp: async (code: string) => new Function("doc", "window", "Event", code)(d, win, win.Event), navTo: async () => true } as any;
    };
    const a = await searchNotes(paged({ size: true, next: true }), lot);
    ok(!isDecline(a) && a.length === 30 && a[29].name === "Clone, Person 9", `live: 30 notes with Rows per page raised (${isDecline(a) ? a.decline : a.length})`);
    const b = await searchNotes(paged({ size: false, next: true }), lot);
    ok(!isDecline(b) && b.length === 30 && !isDecline(a) && b[25].patientId === a[25].patientId, `live: 30 notes by Next, page 2 starts at note 26 (${isDecline(b) ? b.decline : b.length})`);
    const c = await searchNotes(paged({ size: false, next: false }), lot);
    ok(isDecline(c), "live: 25 of 30 notes and no way to the rest → decline");
    eq(probes, 1, "(the declined walk logs its page once)");
    probes = 0;
  }
  {   // END TO END: recallReader() over a jsdom stand-in of the app. Real markup: the lots page (run-164 probe), each lot's captured detail page
      // (run 278), the captured note search; SYNTHETIC: the filter (keeps the typed lot's row) and the pre-search note form.
    const { recallReader, resetRecall } = await import("./recallReader.js");
    const d164 = readFileSync(new URL("../../fixtures/set1/run-164-set1.log", import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("{"))
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((x: any) => x && x.event === "skip_probe" && x.family === "vaccine-lot-recall" && /the lots table did not appear/.test(x.why));
    const LOTS = d164.html as string;
    const answer = async (lot: string, stocked: boolean, notes: string | null) => {
      let d = docOf(LOTS), win = d.defaultView!;
      const load = (h: string) => { d = docOf(h); win = d.defaultView!; };
      const wireLots = () => d.querySelector("form")!.addEventListener("submit", (e) => {
        e.preventDefault();
        const v = (d.querySelector("#lot") as HTMLInputElement).value.trim().toUpperCase();
        const tbody = d.querySelector("tbody")!, rows: Element[] = [...tbody.querySelectorAll("tr")];
        let keep = rows.filter((r) => r.querySelector("a")!.textContent!.trim().toUpperCase() === v);
        if (!keep.length && stocked && v === lot) { const c = rows[0].cloneNode(true) as Element; c.querySelector("a")!.setAttribute("href", "/vaccines/lots/detail-" + lot); c.querySelector("a span")!.textContent = lot; keep = [c]; }
        tbody.innerHTML = ""; keep.forEach((r) => tbody.appendChild(r));
        d.querySelector("p[aria-live]")!.textContent = `Showing 1 to ${keep.length} of ${keep.length} lots`;
      });
      const wireNotes = () => {
        const box = d.querySelector("ul")?.parentElement?.parentElement; if (!box) return;
        box.remove();
        d.querySelector("form")!.addEventListener("submit", (e) => { e.preventDefault(); d.querySelector("div div")!.appendChild(box); });
      };
      const c: any = {
        evalApp: async (code: string) => new Function("doc", "window", "Event", code)(d, win, win.Event),
        navTo: async (href: string) => {
          if (href === "/vaccines") { load(LOTS); wireLots(); return true; }
          if (href === "/vaccines/lots/detail-" + lot && stocked) { load(DT[lot]); return true; }
          if (href === "/vaccines/notes" && notes) { load(notes); wireNotes(); return true; }
          return false;
        },
      };
      resetRecall();
      return recallReader(c)(lot, { unknownToken: "UNKNOWN_LOT" });
    };
    eq(await answer("C482FU1", true, NS["C482FU1"]), "0", "end to end C482FU1 → 0 (12 entries + 16 notes)");
    eq(await answer("5NF133C", true, NS["5NF133C"]), "0", "end to end 5NF133C → 0");
    eq(await answer("71KM95J", true, NS["71KM95J"]), "0", "end to end 71KM95J → 0");
    eq(await answer("NOSUCH1", false, null), "UNKNOWN_LOT", "end to end: a lot the proven filter does not find → UNKNOWN_LOT");
    eq(await answer("C482FU1", true, NS["C482FU1"].replace("mailed to Shirley at the address on file", "will be mailed to Shirley")), null, "end to end: an unclassifiable note → skip, not a count");
    eq(await answer("63XF12L", true, NS["63XF12L"]), null, "end to end 63XF12L: entries 26-27 not in the capture → skip (never a partial count)");
    probes = 0;
  }
  {   // a search that is never applied (the typed text does not match): the page does not change → decline, not an empty list
    const s = sim("OTHER12", NS["C482FU1"]);
    const r = await searchNotes(s.crawler, "C482FU1");
    ok(isDecline(r), "live: a results page that never arrives → decline");
    eq(probes, 1, "the declined page is logged once as a recall_probe");
  }
  process.stdout.write = out;
  console.log(`${fail ? "✗" : "✓"} recallNotes: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
