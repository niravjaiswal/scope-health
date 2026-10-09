/**
 * vaccine-lot-recall reader (recallReader.ts):  npx tsx src/wrenfield/recallReader.test.ts
 *
 * (a) the rule from the Set 1 governing message (n=76) + amendment guard over the later Set 1 messages;
 * (b) the CAPTURED lot detail page (run-146 skip_probe, lot U26B21K, empty chart entries) → [];
 * (c) the lot list built from the captured probe (caption, headers, the 25 rows of page 1, pager text),
 *     also with lot digits drawn in a scrambled font (decoded per family) and as a filtered-empty list;
 * (d) chart entries injected into the REAL detail markup and note cards built in the real card layout (the captured
 *     pages themselves are read in recallEntries.test.ts / recallNotes.test.ts; these check the label reading and
 *     that every surprise declines);
 * (e) the count rule hand-worked; record-identity guard;
 * (f) solver plumbing with the real message store; (g) REPLAY over the run-146 Set 1 recall skips.
 */
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { claimPageOf, type FamMaps } from "./claimReader.js";
import { isDecline } from "./familyReaders.js";
import { recallPageOf, parseRecallPolicy, isRecallPolicy, recallAmendmentBlocks, lotRowsOf, lotEntriesOf, noteResultsOf, recallAnswer, type EntryRow, type NoteRow } from "./recallReader.js";
import { familyMatch } from "./families.js";

let pass = 0, fail = 0;
const ok = (c: unknown, m: string) => { if (c) pass++; else { fail++; console.error("✗ " + m); } };
const eq = (g: unknown, w: unknown, m: string) => ok(JSON.stringify(g) === JSON.stringify(w), `${m}: got ${JSON.stringify(g)}, want ${JSON.stringify(w)}`);
const here = (p: string) => new URL(p, import.meta.url);
const items = readFileSync(here("../../fixtures/set1-items.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const log = readFileSync(here("../../fixtures/set1/run-146-set1.log"), "utf8").split("\n").filter((l) => l.startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const dom = (h: string) => new JSDOM(`<!doctype html><html><head><style>.scr{font-family:Scr}</style></head>${h}</html>`).window.document;
const pageOf = (h: string) => recallPageOf(dom(h));   // what the live reader evaluates
const NOFONT: FamMaps = {};

// ── (a) policy ──
const MSG = items.find((i: any) => i.kind === "message" && /immunization coordinator/.test(i.text)).text as string;
ok(isRecallPolicy(MSG), "Set 1 message n=76 is the recall policy");
eq(parseRecallPolicy(MSG), { unknownToken: "UNKNOWN_LOT" }, "UNKNOWN_LOT token from the message");
ok(isDecline(parseRecallPolicy(MSG.replace(/merged/g, "joined"))), "a message without the merged-record rule → decline");
ok(isDecline(parseRecallPolicy(MSG.replace(/`UNKNOWN_LOT`/g, "nothing"))), "no unknown-lot answer → decline");
eq(parseRecallPolicy(MSG.replace(/UNKNOWN_LOT/g, "NO_SUCH_LOT")), { unknownToken: "NO_SUCH_LOT" }, "token taken from the message, not a constant");
const msgs = items.filter((i: any) => i.kind === "message").map((i: any) => i.text as string);
const k = msgs.findIndex((t: string) => isRecallPolicy(t));
eq(recallAmendmentBlocks(msgs.slice(k + 1)), null, "no later Set 1 message changes the recall rule");
ok(!!recallAmendmentBlocks(["Heads up: for lot M81X24L, count letters handed out at the front desk only once logged in Wrenfield."]), "a later recall note blocks");
ok(!recallAmendmentBlocks(["Flu clinic Saturday at Northgate; bring the cooler."]), "unrelated later message does not block");

// ── (b) captured lot detail page ──
const detailProbe = log.find((d: any) => d.event === "skip_probe" && d.family === "vaccine-lot-recall" && /Chart entries with this lot/.test(d.html));
ok(!!detailProbe, "run-146 captured a lot detail page");
const DETAIL = detailProbe.html as string;
eq(lotEntriesOf(pageOf(DETAIL), NOFONT), [], "captured empty lot (U26B21K): 'No chart entry names this lot' → no entries");
// the captured lot heading is drawn raw as U35B31K; the decoded probe text said U26B21K → digits ARE scrambled
const lotProbe = log.find((d: any) => d.event === "probe" && d.page === "vaccine-lot-detail");
ok(lotProbe.shape.h.includes("Lot U35B31K") && /Lot U26B21K/.test(lotProbe.text), "lot numbers are drawn in the scrambled digit font (raw ≠ decoded)");

// ── (c) lot list from the captured probe ──
const listProbe = log.find((d: any) => d.event === "probe" && d.page === "vaccines");
const listLines = (listProbe.text as string).split("\n");
const hi = listLines.findIndex((l) => l.startsWith("Lot number\tVaccine"));
const HEAD = listLines[hi].split("\t");
const ROWS = listLines.slice(hi + 1).filter((l) => l.includes("\t")).map((l) => l.split("\t"));
eq(HEAD, listProbe.shape.tables[0].headers, "probe headers");
eq(ROWS.length, 25, "25 rows on page 1");
// scramble: real digit d drawn as SCR[d]; the page's family map takes drawn → real
const SCR: Record<string, string> = { "0": "7", "1": "3", "2": "9", "3": "0", "4": "8", "5": "1", "6": "5", "7": "2", "8": "6", "9": "4" };
const UNSCR: Record<string, string> = Object.fromEntries(Object.entries(SCR).map(([a, b]) => [b, a]));
const scr = (s: string) => s.replace(/\d/g, (d) => SCR[d]);
const listHtml = (rows: string[][], opts: { scramble?: boolean; footer?: string; empty?: string; headers?: string[] } = {}) => `<body><div><header><h1>Vaccines</h1></header>
  <nav aria-label="Vaccines"><a href="/vaccines" aria-current="page">Lots</a><a href="/vaccines/storage">Storage</a><a href="/vaccines/notes">Note search</a></nav>
  <form><label>Lot number <input name="lot" value=""></label><label>Vaccine <select name="vaccine"><option value="">All vaccines</option><option>Tdap (Boostrix)</option></select></label><button type="submit">Apply</button></form>
  <section>${rows.length || !opts.empty ? `<table><caption>Vaccine lots, newest first</caption><thead><tr>${(opts.headers ?? HEAD).map((h) => `<th scope="col">${h}</th>`).join("")}</tr></thead><tbody>${rows.map((r, i) => `<tr>${r.map((c, j) => j === 0 ? `<td><a href="/vaccines/lots/l${i}">${opts.scramble ? `<span class="scr">${scr(c)}</span>` : c}</a></td>` : `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>` : `<p>${opts.empty}</p>`}
  <p>${opts.footer ?? ""}</p></section></div></body>`;
const L1 = lotRowsOf(pageOf(listHtml(ROWS, { footer: "Showing 1 to 25 of 1,000+ lots" })), NOFONT);
ok(!isDecline(L1) && L1.rows.length === 25 && L1.rows[0].lot === "U26B21K" && L1.rows[0].location === "Prairie View" && L1.rows[0].href === "/vaccines/lots/l0", "list rows by label");
ok(!isDecline(L1) && L1.pager?.plus === true && L1.pager.to === 25, "pager '1,000+' read as incomplete");
const L2 = lotRowsOf(pageOf(listHtml(ROWS, { scramble: true })), { Scr: UNSCR });
ok(!isDecline(L2) && L2.rows.map((r) => r.lot).join() === ROWS.map((r) => r[0]).join(), "scrambled lot digits decoded per font family");
ok(isDecline(lotRowsOf(pageOf(listHtml(ROWS, { scramble: true })), { Scr: null })), "an unplaceable lot font → decline");
const reord = ROWS.map((r) => [r[2], r[0], r[1], r[3], r[4], r[5]]);
const L3 = lotRowsOf(pageOf(listHtml(reord, { headers: [HEAD[2], HEAD[0], HEAD[1], HEAD[3], HEAD[4], HEAD[5]] })), NOFONT);
ok(!isDecline(L3) && L3.rows[3].lot === "T35Z03G" && L3.rows[3].location === "Eastside", "reordered columns read by label");
const L4 = lotRowsOf(pageOf(listHtml([], { empty: "No lots match these filters." })), NOFONT);
ok(!isDecline(L4) && !L4.table && L4.rows.length === 0, "filtered-empty list: no table");
ok(isDecline(lotRowsOf(pageOf(listHtml(ROWS) + `<div role="status">Wrenfield is not responding. Try again in a moment.</div>`), NOFONT)), "visible not-responding banner → decline");
ok(!isDecline(lotRowsOf(pageOf(listHtml(ROWS).replace("</body>", `<div role="status" hidden>Wrenfield is not responding. Try again in a moment.</div></body>`)), NOFONT)), "hidden banner (as captured) is ignored");

// ── (d) chart entries + note results in the real detail markup ──
const EMPTY_BLOCK = DETAIL.match(/<div class="cd2g5x87"[\s\S]*?No chart entry names this lot<\/p><\/div><\/div>/)![0];
const withEntries = (headers: string[], rows: string[][]) => DETAIL.replace(EMPTY_BLOCK, `<div><table><thead><tr>${headers.map((h) => `<th scope="col">${h}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table><p>${rows.length} ${rows.length === 1 ? "entry" : "entries"}</p></div>`);
const pat = (id: string, name: string, badge = "") => `<a href="/patients/${id}">${name}</a>${badge ? `<span>${badge}</span>` : ""}`;
const EH = ["Patient", "Given", "Location", "Status"];
const E1 = lotEntriesOf(pageOf(withEntries(EH, [
  [pat("p1", "Ames, Ann"), "Oct 14, 2026", "Prairie View", "Active"],
  [pat("p2", "Bell, Bo", "Restricted"), "Oct 15, 2026", "Prairie View", "Active"],
  [pat("p3", "Cole, Cy"), "Oct 15, 2026", "Prairie View", "Entered in error"],
  [pat("p4", "Test, Patient", "Test record"), "Oct 16, 2026", "Prairie View", "Active"],
])), NOFONT);
eq(E1, [
  { patientId: "/patients/p1", name: "Ames, Ann", status: "Active", testRecord: false },
  { patientId: "/patients/p2", name: "Bell, Bo", status: "Active", testRecord: false },
  { patientId: "/patients/p3", name: "Cole, Cy", status: "Entered in error", testRecord: false },
  { patientId: "/patients/p4", name: "Test, Patient", status: "Active", testRecord: true },
], "chart entries read by label (restricted kept, test flagged)");
ok(isDecline(lotEntriesOf(pageOf(withEntries(EH, [[pat("p1", "Ames, Ann", "Merged"), "Oct 14, 2026", "PV", "Active"]])), NOFONT)), "unknown badge (Merged) → decline");
ok(isDecline(lotEntriesOf(pageOf(withEntries(["Who", "Given", "State of play"], [[pat("p1", "Ames, Ann"), "x", "Active"]])), NOFONT)), "unknown columns → decline");
ok(isDecline(lotEntriesOf(pageOf(withEntries(EH, [["Ames, Ann", "Oct 14, 2026", "PV", "Active"]])), NOFONT)), "patient without chart link → decline");
ok(isDecline(lotEntriesOf(pageOf(withEntries(EH, [[pat("p1", "Ames, Ann"), "Oct 14, 2026", "PV", "Active"]]).replace("<p>1 entry</p>", "<p>Showing 1 to 25 of 40 entries</p><button>Next</button>")), NOFONT)), "entries on several pages → decline");
ok(isDecline(lotEntriesOf(pageOf(withEntries(EH, [[pat("p1", "Ames, Ann", "Archived"), "Oct 14, 2026", "PV", "Active"]])), NOFONT)), "any other badge → decline");
ok(isDecline(lotEntriesOf(pageOf(DETAIL.replace("No chart entry names this lot", "Loading")), NOFONT)), "no table and no empty statement → decline");

const LOT = "C482FU1";
// note-search cards in the REAL layout (fixtures/recall/note-search-*.html, run 265; recallNotes.test.ts reads the captured pages)
const card = (id: string, name: string, iso: string, body: string, kind = "Message", badge = "") => `<li><article><header><span>${kind}</span><span><a href="/patients/${id}">${name}</a>${badge ? ` <span>${badge}</span>` : ""}</span><span>born <span>01/02/1990</span>, MRN <span role="img" aria-label="MRN"></span></span><span>Nurse Nan</span><time datetime="${iso}">Oct 20</time> <span>MDT</span></header><p>${body}</p></article></li>`;
const notesHtml = (cards: string[], footer = `${cards.length} notes`) => `<body><h1>Vaccines</h1><nav><a href="/vaccines/notes">Note search</a></nav><section aria-label="Search"><form><label for="w">Text in the note</label><input id="w" value="${LOT}"><button type="submit">Search notes</button></form></section>
  <div><ul aria-label="Notes found, newest first">${cards.join("")}</ul><div><p aria-live="polite">${footer}</p><div></div></div></div></body>`;
const N1 = noteResultsOf(pageOf(notesHtml([
  card("p1", "Ames, Ann", "2026-10-20T15:00:00Z", `Recall letter for lot ${LOT} mailed to the patient.`, "Message"),
  card("p9", "Dunn, Di", "2026-10-18T17:30:00Z", `Influenza (Fluzone) given today in the left deltoid, lot number ${LOT}.`, "Chart note"),
])), NOFONT, LOT);
ok(!isDecline(N1) && N1.length === 2 && N1[0].dateISO === "2026-10-20" && N1[0].time === "15:00:00" && N1[1].patientId === "/patients/p9", "note cards read");
const one = (extra = "") => notesHtml([card("p1", "Ames, Ann", "2026-10-20T15:00:00Z", `Recall letter for lot ${LOT} mailed to the patient.${extra}`)]);
ok(isDecline(noteResultsOf(pageOf(notesHtml([card("p1", "Ames, Ann", "2026-10-20T15:00:00Z", `Recall letter for lot ${LOT} mailed…`)])), NOFONT, LOT)), "truncated note text → decline");
ok(isDecline(noteResultsOf(pageOf(notesHtml([card("p1", "Ames, Ann", "2026-10-20T15:00:00Z", "Flu shot discussed.")])), NOFONT, LOT)), "a result without the lot (search not applied) → decline");
ok(isDecline(noteResultsOf(pageOf(notesHtml([card("p1", "Ames, Ann", "2026-10-20 15:00", `lot ${LOT}`)])), NOFONT, LOT)), "a time that is not a UTC stamp → decline");
ok(isDecline(noteResultsOf(pageOf(notesHtml([card("p1", "Ames, Ann", "2026-10-20T15:00:00+02:00", `lot ${LOT}`)])), NOFONT, LOT)), "a time with an offset → decline (order across notes unproven)");
ok(isDecline(noteResultsOf(pageOf(notesHtml([card("p1", "Ames, Ann", "2026-10-20T15:00:00Z", `lot ${LOT}`, "Message", "Merged")])), NOFONT, LOT)), "an unknown badge on a note's patient → decline");
const N0 = noteResultsOf(pageOf(`<body><h1>Vaccines</h1><form><label>Text in the note <input value="${LOT}"></label><button>Search notes</button></form><div><p aria-live="polite">No notes found.</p></div></body>`), NOFONT, LOT);
eq(N0, [], "explicit empty note search → no notes");
ok(!isDecline(noteResultsOf(pageOf(one()), NOFONT, LOT)), "note results with a '1 notes' footer read");
ok(isDecline(noteResultsOf(pageOf(one().replace("<p aria-live=\"polite\">1 notes</p>", "")), NOFONT, LOT)), "note results without a footer → decline (a cap is unprovable)");
ok(isDecline(noteResultsOf(pageOf(notesHtml([card("p1", "Ames, Ann", "2026-10-20T15:00:00Z", `lot ${LOT} mailed`)], "Showing 1 to 1 of 50 notes")), NOFONT, LOT)), "note results with more pages → decline in the single-page read");
ok(isDecline(noteResultsOf(pageOf(notesHtml([card("p1", "Ames, Ann", "2026-10-20T15:00:00Z", `lot ${LOT} mailed`)], "Showing 1 to 1 of 50+ notes")), NOFONT, LOT)), "note results capped (50+) → decline");
ok(isDecline(noteResultsOf(pageOf(notesHtml([card("p1", "Ames, Ann", "2026-10-20T15:00:00Z", `lot ${LOT} mailed`)], "2 notes")), NOFONT, LOT)), "note footer total ≠ rows → decline");

// ── (e) the count, hand-worked ──
// dosed: p1, p2 (Active entries; p2 restricted counts), p9 (dose only in a note); p3 entered in error, p4 test record → out.
// notified: p1 (letter mailed). p2: mailed then returned later → not notified. Left: p2, p9 = 2.
const notes: NoteRow[] = [
  ...(N1 as NoteRow[]),
  { patientId: "/patients/p2", name: "Bell, Bo", dateISO: "2026-10-20", body: `Recall notice for lot ${LOT} sent through the patient portal.`, testRecord: false },
  { patientId: "/patients/p2", name: "Bell, Bo", dateISO: "2026-10-25", body: `Recall letter for lot ${LOT} came back undeliverable.`, testRecord: false },
];
eq(recallAnswer(E1 as EntryRow[], notes, LOT), "2", "hand-worked count: dosed p1 p2 p9, notified p1 → 2");
const swapped = notes.map((n) => n.patientId === "/patients/p2" ? { ...n, dateISO: n.dateISO === "2026-10-20" ? "2026-10-26" : n.dateISO } : n);
eq(recallAnswer(E1 as EntryRow[], swapped, LOT), "1", "returned then re-sent later → notified → 1");
ok(isDecline(recallAnswer([...(E1 as EntryRow[]), { patientId: "/patients/p7", name: "Ames, Ann", status: "Active", testRecord: false }], notes, LOT)), "same name on two record ids (merged duplicate?) → decline");
ok(isDecline(recallAnswer(E1 as EntryRow[], [...notes, { patientId: "/patients/p5", name: "Eve, Ed", dateISO: "2026-10-01", body: `Patient asked if the recall of lot ${LOT} affects them; their dose was lot ZZ11223.`, testRecord: false }], LOT)), "a note naming another lot → decline (not guessed)");

// ── (c2) the REAL lots page (run-164 skip probes, all 13 recall skips "the lots table did not appear") ──
// The table sits in plain <div>s (the page's only <section> is "Filters"): CLAIM_JS never saw it; RECALL_JS does.
const log164 = readFileSync(here("../../fixtures/set1/run-164-set1.log"), "utf8").split("\n").filter((l) => l.startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const lots164 = log164.filter((d: any) => d.event === "skip_probe" && d.family === "vaccine-lot-recall" && /the lots table did not appear/.test(d.why));
ok(lots164.length >= 4, `run-164 captured the lots page (${lots164.length})`);
for (const d of lots164) {
  ok(lotRowsOf(claimPageOf(dom(d.html)), NOFONT) && !(lotRowsOf(claimPageOf(dom(d.html)), NOFONT) as any).table, "regression: CLAIM_JS alone finds no lot table on the real page");
  const r = lotRowsOf(pageOf(d.html), NOFONT);
  ok(!isDecline(r) && r.table && r.rows.length === 25 && new Set(r.rows.map((x) => x.location)).size >= 2 && r.rows.every((x) => /^\/vaccines\/lots\/\w+$/.test(x.href ?? "")), "real lots page: 25 rows, several locations, detail links");
  ok(!isDecline(r) && r.pager?.plus === true && r.pager.to === 25, "real lots page: pager 1 to 25 of 1,000+");
}
eq(log164.filter((d: any) => d.event === "item" && d.family === "vaccine-lot-recall" && /the lots table did not appear/.test(d.why)).length, 13, "13 run-164 recall skips had this cause");
// the captured detail page still reads the same through RECALL_JS (its storage table is inside a section)
eq(lotEntriesOf(pageOf(DETAIL), NOFONT), [], "detail page via RECALL_JS → no entries");

// ── (f)+(g) solver plumbing and replay over the run-146 skips ──
(async () => {
  const { MessageStore } = await import("./inference.js");
  const { compiler } = await import("./run.js");
  const { solveFamily } = await import("./solvers.js");
  const store = new MessageStore(compiler);
  for (const it of items.filter((x: any) => x.kind === "message")) await store.ingest(it.text);
  const asked: string[] = [];
  let reply: string | null = "UNKNOWN_LOT";
  const index: any = { providers: new Map(), appointments: [], byDate: () => [], findPatient: () => null,
    recallLeft: async (lot: string, pol: any) => { asked.push(`${lot}|${pol.unknownToken}`); return reply; } };
  eq(await solveFamily(familyMatch("Recall, lot 5NF133C: patients left to notify?")!, index, store), "UNKNOWN_LOT", "solver passes the reader's UNKNOWN_LOT");
  eq(asked, ["5NF133C|UNKNOWN_LOT"], "solver gives the reader the lot + the message's token");
  reply = "3"; eq(await solveFamily(familyMatch("How many patients are left to notify about the recall of lot C482FU1?")!, index, store), "3", "a whole number passes");
  reply = "three"; eq(await solveFamily(familyMatch("How many patients are left to notify about the recall of lot C482FU1?")!, index, store), null, "an answer outside the set → skip");

  // REPLAY: the run-146 recall skips against everything the run captured.
  const skips = log.filter((d: any) => d.event === "item" && d.family === "vaccine-lot-recall");
  eq(skips.length, 13, "13 recall skips in run-146");
  const listed = new Set(ROWS.map((r) => r[0]));
  const lines: string[] = [];
  for (const s of skips) {
    const m = familyMatch(s.text); const lot = m?.slots.lot as string;
    ok(m?.family === "vaccine-lot-recall" && /^[A-Z0-9]{7}$/.test(lot), `routes + lot slot: ${s.text}`);
    const onPage1 = listed.has(lot), detail = lot === "U26B21K";
    lines.push(`  n=${s.n} lot ${lot}: page-1 list ${onPage1 ? "HAS it" : "no"}; detail captured ${detail ? "yes" : "no"} → ${onPage1 || detail ? "stocked" : "needs the live Lot number filter (not decidable offline)"}`);
  }
  console.log("replay (run-146 captures):\n" + lines.join("\n"));
  console.log(`${fail ? "✗" : "✓"} recallReader: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
