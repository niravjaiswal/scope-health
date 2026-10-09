/**
 * Extra HELD-OUT cases for wfEval.ts, built from the hand-verified fixtures the deterministic readers are tested on
 * (familyReaders.test.ts: filing deadlines on the recon insurance/payer pages; immunizations-test.ts: tetanus on the
 * captured García notes/immunizations text; good-faith on the recon insurance page + a complete notes list). Every
 * expected answer is the one worked by hand in those tests (comments there); "SKIP" = only a skip is right. The pages
 * are handed to the executor as text, as the live gather would render them (tables as " | " rows, notes one per line).
 * No family runs: these are leave-one-workflow-out by construction.
 */
import { readFileSync, existsSync } from "node:fs";
import { JSDOM } from "jsdom";
import { pageText } from "./pageText.js";

export type ExtraCase = { id: string; source: string; workflow: string; msg: number; later: number[]; request: string; pages: Array<{ name: string; text: string }>; expected: string; why: string };

const here = (p: string) => new URL(p, import.meta.url);
const recon = readFileSync(here("../../fixtures/set1/recon-158.txt"), "utf8");
const lines = recon.split("\n");
/** The captured HTML of a page template ("@@@@ <tpl> ::" … "---- HTML ----" …). */
function html(header: string): string {
  const i = lines.findIndex((l) => l.startsWith(header)); if (i < 0) throw new Error("no page " + header);
  let j = i + 1; while (j < lines.length && lines[j] !== "---- HTML ----") j++;
  const out: string[] = [];
  for (let k = j + 1; k < lines.length && !/^(@@@@|====|####|# EXPLORED|\{"event")/.test(lines[k]); k++) out.push(lines[k]);
  return out.join("\n").trim();
}
/** The decoded TEXT block of a captured section. */
function text(header: string): string {
  const i = lines.findIndex((l) => l.startsWith(header)); if (i < 0) throw new Error("no section " + header);
  const s = lines.indexOf("---- TEXT (decoded) ----", i), e = lines.indexOf("---- HTML ----", s);
  return lines.slice(s + 1, e).join("\n");
}
const dom = (h: string): Document => new JSDOM(`<!doctype html><html>${h}</html>`).window.document;
const txt = (d: Document) => pageText(d);
/** A chart tab's own content (the chart header with its mis-decoded DOB is not part of the tab). */
const tabOnly = (t: string, from: string) => { const i = t.indexOf(from); return i >= 0 ? t.slice(i) : t; };

export function extraCases(): ExtraCase[] {
  const out: ExtraCase[] = [];
  // ── filing deadline (msg 150; later Set 1 messages 164, 176, 198 as in the replica cases) ──
  {
    const ins = dom(html("@@@@ /patients/{id}/insurance ::"));
    const sec = [...ins.querySelectorAll("h2")].find((h) => /Claims not yet filed/.test(h.textContent || ""))!.closest("section")!;
    [...sec.children].forEach((c) => { if (c.tagName !== "H2") c.remove(); });
    const HEAD = ["Claim", "Date of service", "Type", "Billed to", "Primary or original remittance"];
    const ROWS = [["87827990", "Aug 31, 2026", "Original", "Tallgrass Health Plan", "—"], ["87827991", "Jun 4, 2026", "Secondary", "Tallgrass Health Plan", "Received Sep 10, 2026"], ["87827992", "Jul 31, 2026", "Secondary", "Tallgrass Health Plan", "Not received"], ["87827993", "Jan 9, 2026", "Corrected", "Tallgrass Health Plan", "Received Jan 20, 2026"], ["87827994", "Mar 18, 2026", "Original", "Tallgrass Health Plan", "—"], ["87827995", "Jun 29, 2026", "Original", "Tallgrass Health Plan", "—"], ["87827996", "Mar 1, 2022", "Original", "Tallgrass Health Plan", "—"]];
    const box = ins.createElement("div"); box.innerHTML = `<table><caption>Claims not yet filed</caption><thead><tr>${HEAD.map((h) => `<th scope="col">${h}</th>`).join("")}</tr></thead><tbody>${ROWS.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`; sec.appendChild(box);
    const pages = [{ name: "Chart of Johnson, Elena (demographics)", text: txt(dom(html("@@@@ /patients/{id} ::"))) }, { name: "Chart of Johnson, Elena — Insurance tab [single page: coverage, authorizations, claims not yet filed]", text: txt(ins) }, { name: "Page /payers (Payers)", text: txt(dom(html("@@@@ /payers ::"))) }, { name: "Page /payers/2hl10z2zf2 (Tallgrass Health Plan)", text: txt(dom(html("@@@@ /payers/{id} ::"))) }];
    // familyReaders.test.ts FILING_CASES (working in its comments): terms effective 2022-07-01, Original 150 d / Secondary 90 d / Corrected 365 d; office holidays from the message
    const CASES: Array<[string, string, string]> = [["2026-08-31", "2027-01-28", "Original +150 days"], ["2026-06-04", "2026-12-09", "Secondary +90 days from the primary remittance"], ["2026-07-31", "AWAITING_PRIMARY", "Secondary, primary remittance not received"], ["2026-01-09", "2027-01-20", "Corrected +365 days from the original remittance"], ["2026-03-18", "EXPIRED:61", "Original, deadline passed, Saturday rolled back"], ["2026-06-29", "2026-11-25", "Original landing on an office holiday rolls back"], ["2022-03-01", "NO_FILING_TERMS", "no terms in effect on the DOS"], ["2026-02-02", "SKIP", "no not-yet-filed claim on that date"]];
    CASES.forEach(([dos, expected, why], i) => out.push({ id: `fx-filing-${i}`, source: "fixtures", workflow: "filing-deadline", msg: 150, later: [164, 176, 198], request: `Johnson, Elena, DOB 2000-10-02, date of service ${dos}. We haven't billed this one yet. What's the deadline to file?`, pages, expected, why }));
  }
  // ── tetanus (msg 30): the captured García notes / immunizations text (immunizations-test.ts, hand-verified) ──
  {
    const NOTES = tabOnly(text("==== POPULATED notes"), "Written from"), IMM = tabOnly(text("==== POPULATED immunizations"), "Immunizations, newest first");
    const DOCS = "Documents in this chart, newest first\nTitle\tType\tReceived\t\nActions\n\nLab report: Lipid panel\tLab report\tNov 1, 2025\tView\n\n1 document";
    const DOCS_OUT = "Documents in this chart, newest first\nTitle\tType\tReceived\t\nActions\n\nImmunization record: Ridgeway Community Clinic\tImmunization record\tJan 5, 2026\tView\nLab report: Lipid panel\tLab report\tNov 1, 2025\tView\n\n2 documents";
    const EMPTY_DOCS = "Documents in this chart, newest first\nTitle\tType\tReceived\t\nActions\n\nNo documents";
    const withNote = (body: string) => NOTES.replace("8 notes", "9 notes").replace("Chart note\nDr. Espinoza", `Chart note\nRN Patel\nMar 2, 2026, 9:05 AM\nMST\n\n${body}\n\nChart note\nDr. Espinoza`);
    const MONS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const md = (iso: string) => `${MONS[+iso.slice(5, 7) - 1]} ${+iso.slice(8)}, ${iso.slice(0, 4)}`;
    const notesPage = (ns: Array<[string, string, string]>) => ["Written from", "Written to", "Apply", "Clear", ...ns.flatMap(([iso, type, body]) => [type, "Nurse Ortiz", `${md(iso)}, 10:15 AM`, "MDT", "", body, ""]), `${ns.length} notes`].join("\n");
    const immPage = (rows: string[][]) => ["Immunizations, newest first", ["Vaccine", "Date given", "Lot", "Site", "Given by", "Recorded as"].join("\t"), ...rows.map((r) => r.join("\t")), "", `${rows.length} ${rows.length === 1 ? "entry" : "entries"}`].join("\n");
    const G = (notes: string, imm: string, docs: string) => [{ name: "Chart of García, Abigail — Notes tab [every page read]", text: notes }, { name: "Chart of García, Abigail — Immunizations tab [single page]", text: imm }, { name: "Chart of García, Abigail — Documents tab [single page]", text: docs }];
    const req = (d: string) => `Tetanus for Abigail García (DOB 1952-04-03) on ${d}: vaccine, vaccine and TIG, or nothing?`;
    const T: Array<[string, string, Array<{ name: string; text: string }>, string, string]> = [
      ["no-wound", req("2026-02-08"), G(NOTES, IMM, DOCS), "NO_WOUND_VISIT", "the only 2026-02-08 note is a routine review; no note starts with 'Triage:'"],
      ["clean", req("2026-03-02"), G(withNote("Triage: Laceration to the left palm from a kitchen knife. No dirt, soil, or saliva in the wound."), IMM, DOCS), "VACCINE:1:1952-06-07", "clean wound; doses before the visit: DTaP (Daptacel) 1952-06-07 only (the Influenza rows are not tetanus) → 1 ≤ 2 → VACCINE"],
      ["bite", req("2026-03-02"), G(withNote("Triage: Bite from the neighbor's dog to the right forearm."), IMM, DOCS), "VACCINE_AND_TIG:1:1952-06-07", "a bite has saliva → other wound; 1 dose → VACCINE_AND_TIG"],
      ["outside-record", req("2026-03-02"), G(withNote("Triage: Laceration to the left palm from a kitchen knife."), IMM, DOCS_OUT), "SKIP", "an outside Immunization record is in Documents and its doses were not read → the count is unproven"],
      ["dose-note", "What should Dana Reyes have gotten for tetanus when they came in with a wound on 2026-05-05?", [{ name: "Chart of Reyes, Dana — Notes tab [every page read]", text: notesPage([["2026-05-05", "Chart note", "Triage: Cut on the thumb from a kitchen knife."], ["2026-05-05", "Chart note", "Td (Tenivac) given today in the left deltoid, lot number TK4471D."], ["2019-03-02", "Chart note", "Tdap (Adacel) given today in the right deltoid, lot number AD2201X."]]) }, { name: "Chart of Reyes, Dana — Immunizations tab", text: immPage([]) }, { name: "Chart of Reyes, Dana — Documents tab", text: EMPTY_DOCS }], "VACCINE:1:2019-03-02", "a dose note before the visit counts; the visit-day dose does not; clean wound, 1 dose"],
      ["unclear-dose-note", "What should Dana Reyes have gotten for tetanus when they came in with a wound on 2026-05-05?", [{ name: "Chart of Reyes, Dana — Notes tab [every page read]", text: notesPage([["2026-05-05", "Chart note", "Triage: Cut on the thumb from a kitchen knife."], ["2020-01-10", "Chart note", "Patient asked about Td. Given today, lot pending."]]) }, { name: "Chart of Reyes, Dana — Immunizations tab", text: immPage([]) }, { name: "Chart of Reyes, Dana — Documents tab", text: EMPTY_DOCS }], "VACCINE:0:NONE|SKIP", "the family declines ('Given today, lot pending' is unclear); by the message's letter a note without its lot number is not a documented dose → VACCINE:0:NONE is also right"],
      ["phone-triage", "What should Dana Reyes have gotten for tetanus when they came in with a wound on 2026-05-05?", [{ name: "Chart of Reyes, Dana — Notes tab [every page read]", text: notesPage([["2026-05-05", "Phone call", "Spoke with the triage nurse about a rash."]]) }, { name: "Chart of Reyes, Dana — Immunizations tab", text: immPage([]) }, { name: "Chart of Reyes, Dana — Documents tab", text: EMPTY_DOCS }], "NO_WOUND_VISIT", "a phone-call note mentioning the triage nurse is not a triage note"],
      ["triage-mid-note", "What should Dana Reyes have gotten for tetanus when they came in with a wound on 2026-05-05?", [{ name: "Chart of Reyes, Dana — Notes tab [every page read]", text: notesPage([["2026-05-05", "Chart note", "Seen today. Triage: cut on the hand."]]) }, { name: "Chart of Reyes, Dana — Immunizations tab", text: immPage([]) }, { name: "Chart of Reyes, Dana — Documents tab", text: EMPTY_DOCS }], "NO_WOUND_VISIT|SKIP", "the note does not START with 'Triage:': by the message's letter there was no wound visit; the family declines rather than decide"],
    ];
    T.forEach(([k, request, pages, expected, why]) => out.push({ id: `fx-tetanus-${k}`, source: "fixtures", workflow: "tetanus-wound", msg: 30, later: [], request, pages, expected, why }));
  }
  // ── good faith (msg 198): insured chart + a complete notes list ──
  {
    const ins = txt(dom(html("@@@@ /patients/{id}/insurance ::")));
    const routine = Array.from({ length: 33 }, (_, i) => `2025-${String(1 + (i % 12)).padStart(2, "0")}-10 10:15 | Chart note · Amy Fuller | Routine follow-up note ${i + 1}. No changes.`);
    const notes = (extra: string[]) => `Notes of Johnson, Elena (all ${routine.length + extra.length} notes, every page read; one line per note: date time | type · author | text)\n` + [...routine, ...extra].join("\n");
    const req = "Good faith estimate question: Johnson, Elena, born 2000-10-02, 09:30 on 2026-01-14. Is one required, and if so, when's it due?";
    out.push({ id: "fx-gfe-insured", source: "fixtures", workflow: "good-faith-estimate", msg: 198, later: [], request: req, pages: [{ name: "Chart of Johnson, Elena — Insurance tab [single page]", text: ins }, { name: "Notes of Johnson, Elena [33 notes, pager walked to the stated total]", text: notes([]) }], expected: "NOT_REQUIRED:INSURED", why: "Primary insurance Tallgrass Health Plan / Bronze 6000 / member ID; no note about paying for 2026-01-14" });
    out.push({ id: "fx-gfe-unclear-note", source: "fixtures", workflow: "good-faith-estimate", msg: 198, later: [], request: req, pages: [{ name: "Chart of Johnson, Elena — Insurance tab [single page]", text: ins }, { name: "Notes of Johnson, Elena [33 notes, pager walked to the stated total]", text: notes(["2026-01-02 14:00 | Phone call · Amy Fuller | Patient may self-pay for the 2026-01-14 visit; check with billing."]) }], expected: "NOT_REQUIRED:INSURED|SKIP", why: "a note names the date but is conditional ('may self-pay … check with billing'); the family declines, and by the message's letter (no note says the patient CHOSE to pay) insured is also right" });
  }
  return out;
}
export const extraAvailable = () => existsSync(here("../../fixtures/set1/recon-158.txt"));
