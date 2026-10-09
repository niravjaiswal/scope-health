/**
 * Offline checks for the immunization families (tetanus-wound, vaccine-lot-recall):
 *   (a) hand-verified cases on the Set 1 recon pages (fixtures/set1/recon-158.txt) + the Set 1 message;
 *   (b) paraphrases (not Set 1 text) + hard negatives for routing/slots;
 *   (c) page variants (reordered/renamed/extra columns, date formats, empty, paginated) that must give
 *       the SAME answer or decline — never a different one.
 *   npx tsx src/wrenfield/immunizations-test.ts
 */
import { readFileSync } from "node:fs";
import {
  type Note, type TetanusRule, type ImmEntry, type Doc, isSkip, parseTetanusRule, tetanusRuleFrom, parseImmunizations, parseDocuments,
  parseNotesText, parseNoteChunk, buildTetanusContext, woundClass, classifyDoseNote, isTetanusName, tetanusSlots, recallSlots,
  findTable, combinePages, pageInfo, parseDate, recallCount, classifyRecallNote,
} from "./immunizations.js";
import { decideTetanus } from "./tetanusWound.js";
import { NOTE_CHUNKS_JS } from "./immunizationsLive.js";
import { JSDOM } from "jsdom";
/** The captured HTML of a claim-dump section (Baseline Set 1 dump; populated García pages). */
const dumpLines = readFileSync(new URL("../../fixtures/set1/claim-dump-baseline.txt", import.meta.url), "utf8").split("\n");
function htmlOf(head: string): string {
  const i = dumpLines.findIndex((l) => l.startsWith(head)); if (i < 0) throw new Error("no dump section " + head);
  let j = i + 1; while (dumpLines[j] !== "---- HTML ----") j++;
  const out: string[] = []; for (let k = j + 1; k < dumpLines.length && !/^(====|@@@@|\[nav\]|\{"event")/.test(dumpLines[k]); k++) out.push(dumpLines[k]);
  return out.join("\n");
}
import { familyMatch } from "./families.js";

let pass = 0, fail = 0;
const ok = (c: unknown, m: string) => { if (c) pass++; else { fail++; console.error("✗ " + m); } };
const eq = (got: unknown, want: unknown, m: string) => ok(JSON.stringify(got) === JSON.stringify(want), `${m}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// ── fixtures ──
const recon = readFileSync(new URL("../../fixtures/set1/recon-158.txt", import.meta.url), "utf8").split("\n");
/** The decoded TEXT block of the recon section whose header line starts with `head`. */
function page(head: string): string {
  const i = recon.findIndex((l) => l.startsWith(head)); if (i < 0) throw new Error("no recon section " + head);
  const s = recon.indexOf("---- TEXT (decoded) ----", i), e = recon.indexOf("---- HTML ----", s);
  return recon.slice(s + 1, e).join("\n");
}
const items = readFileSync(new URL("../../fixtures/set1-items.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const tetMsg: string = items.find((x: any) => x.kind === "message" && /tetanus checks for wound visits/.test(x.text)).text;
const RULE = parseTetanusRule(tetMsg) as TetanusRule;

const JOHNSON_IMM = page("@@@@ /patients/{id}/immunizations");
const JOHNSON_NOTES_P1 = page("@@@@ /patients/{id}/notes");
const JOHNSON_DOCS = page("@@@@ /patients/{id}/files");
const GARCIA_NOTES = page("==== POPULATED notes");
const GARCIA_IMM = page("==== POPULATED immunizations");
const GARCIA_CLAIMS = page("==== POPULATED claims+remittances");

/** Split a notes page into per-note chunks the way the live reader gets them (one list item each). */
function chunks(text: string): string[] {
  const ns = parseNotesText(text); const lines = text.split("\n"); const out: string[] = [];
  const heads = lines.map((l, i) => (ns.some((n) => n.time === l.trim()) && i >= 2 ? i - 2 : -1)).filter((i) => i >= 0);
  for (let k = 0; k < heads.length; k++) out.push(lines.slice(heads[k], k + 1 < heads.length ? heads[k + 1] : lines.length).join("\n").replace(/\n(?:Showing \d+ to \d+ of \d+ notes|\d+ notes?)[\s\S]*$/, ""));
  return out;
}
/** The whole tetanus pipeline over page texts (what the live reader assembles), → answer or null. */
function answer(visitISO: string, notesPages: string[], immPages: string[], docPages: string[], rule = RULE): string | null {
  const np = notesPages.map((t) => { const pi = pageInfo(t, "notes?")!; const ns = chunks(t).map((c) => parseNoteChunk(c)); return ns.some(isSkip) || !pi ? null : { items: ns as Note[], page: pi }; });
  if (np.some((x) => !x)) return null;
  const notes = combinePages(np as any); if (isSkip(notes)) return null;
  const pre = buildTetanusContext({ visitISO, notes: notes as Note[], notesComplete: true, imms: null, immsComplete: false, docs: null, docsComplete: false }, rule);
  if (!isSkip(pre)) return decideTetanus(pre, rule);
  if (pre.skip !== "need-more") return null;
  const ip = immPages.map(parseImmunizations); if (ip.some(isSkip)) return null;
  const imms = combinePages((ip as any[]).map((r) => ({ items: r.entries, page: r.page }))); if (isSkip(imms)) return null;
  const dp = docPages.map(parseDocuments); if (dp.some(isSkip)) return null;
  const docs = combinePages((dp as any[]).map((r) => ({ items: r.docs, page: r.page }))); if (isSkip(docs)) return null;
  const ctx = buildTetanusContext({ visitISO, notes: notes as Note[], notesComplete: true, imms: imms as ImmEntry[], immsComplete: true, docs: docs as Doc[], docsComplete: true }, rule);
  return isSkip(ctx) ? null : decideTetanus(ctx, rule);
}
/** A notes page in the Set 1 layout (type / author / "Mon D, YYYY, h:mm AM" / zone / body). */
const MONS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const md = (iso: string) => `${MONS[+iso.slice(5, 7) - 1]} ${+iso.slice(8)}, ${iso.slice(0, 4)}`;
function notesPage(ns: Array<[string, string, string]>, footer?: string): string {
  return ["Written from", "Written to", "Apply", "Clear", ...ns.flatMap(([iso, type, body]) => [type, "Nurse Ortiz", `${md(iso)}, 10:15 AM`, "MDT", "", body, ""]), footer ?? `${ns.length} notes`].join("\n");
}
function immPage(rows: string[][], header = ["Vaccine", "Date given", "Lot", "Site", "Given by", "Recorded as"], footer?: string): string {
  return ["Immunizations, newest first", header.join("\t"), ...rows.map((r) => r.join("\t")), "", footer ?? `${rows.length} ${rows.length === 1 ? "entry" : "entries"}`].join("\n");
}
const EMPTY_DOCS = "Documents in this chart, newest first\nTitle\tType\tReceived\t\nActions\n\nNo documents";

// ═════════════ (a) the governing message ═════════════
ok(!isSkip(RULE), "Set 1 tetanus message parses: " + (isSkip(RULE) ? (RULE as any).skip : ""));
eq([RULE.lowMax, RULE.cleanYears, RULE.otherYears], [2, 10, 5], "decision table: 0-2 doses / 10 y clean / 5 y other");
eq(RULE.tetanusNames.length, 24, "vaccine table: 12 chart names + 12 outside names");
ok(RULE.tetanusNames.includes("DTaP-IPV/Hib (Pentacel)") && RULE.tetanusNames.includes("Tenivac"), "vaccine table has chart + outside names");
ok(RULE.notTetanus.includes("Hib (ActHIB)") && RULE.notTetanus.includes("Influenza") && RULE.notTetanus.includes("MenACWY"), "exclusions incl. unbranded forms");
eq([...RULE.triggers].sort(), ["avulsion", "bite", "bullet", "burn", "contaminated", "crush", "dirt", "feces", "frostbite", "missile", "pellet", "puncture", "saliva", "shrapnel", "soil", "torn away"].sort(), "wound list → triggers");
ok(isSkip(parseTetanusRule(tetMsg.replace("- A burn.", "- A burn.\n- A sting from a jellyfish."))), "a wound kind we don't know in the list → rule skip");
ok(isSkip(parseTetanusRule(tetMsg.replace("| 3 or more |", "| 4 or more |"))), "decision rows that don't meet (0-2 then 4+) → rule skip");
{ const r = parseTetanusRule(tetMsg.replace(/10 or more years/g, "8 or more years")) as TetanusRule; eq(r.cleanYears, 8, "thresholds are read from the message, not constants"); }
ok(isSkip(tetanusRuleFrom([tetMsg, "Update on tetanus: from now on count only doses given at our locations."])), "a later tetanus amendment we can't apply → skip");
ok(!isSkip(tetanusRuleFrom(["From the front desk: parking changes.", tetMsg])), "the governing message is found among others");
eq(isTetanusName("Td (Tenivac)", RULE), true, "chart name");
eq(isTetanusName("Boostrix", RULE), true, "outside-record name");
eq(isTetanusName("Influenza (Fluzone)", RULE), false, "listed exclusion");
eq(isTetanusName("COVID-19 (Comirnaty)", RULE), false, "an unlisted non-tetanus vaccine (closed list)");
eq(isTetanusName("Tdap (TdVax)", RULE), null, "an unlisted tetanus-looking product → unknown (skip)");

// ═════════════ (a) Set 1 recon pages, hand-verified ═════════════
{
  // Johnson, Elena — Immunizations: 2 rows, "2 entries".
  //   Td (Tenivac)    Feb 17, 2010  Given elsewhere  → tetanus (chart name)
  //   DTaP (Infanrix) Dec 10, 2000  Given elsewhere  → tetanus (chart name)
  const r = parseImmunizations(JOHNSON_IMM);
  ok(!isSkip(r), "Johnson immunizations parse");
  if (!isSkip(r)) { eq(r.entries.map((e) => [e.vaccine, e.dateISO, e.recordedAs]), [["Td (Tenivac)", "2010-02-17", "Given elsewhere, from the patient's records"], ["DTaP (Infanrix)", "2000-12-10", "Given elsewhere, from the patient's records"]], "Johnson rows"); eq(r.page, { from: 1, to: 2, total: 2 }, "Johnson count"); }
  // García, Abigail — 3 rows: 2 × Influenza (not tetanus), DTaP (Daptacel) Jun 7, 1952 (tetanus). Lots decoded (X87Y94K).
  const g = parseImmunizations(GARCIA_IMM);
  ok(!isSkip(g) && g.entries.length === 3 && g.entries[0].lot === "X87Y94K" && g.entries[2].dateISO === "1952-06-07", "García rows (decoded lot, 1952 DTaP)");
  // Johnson documents: 12 rows, "12 documents", none an Immunization record.
  const d = parseDocuments(JOHNSON_DOCS);
  ok(!isSkip(d) && d.docs.length === 12 && d.page.total === 12 && !d.docs.some((x) => /immunization/i.test(x.kind)), "Johnson documents: 12, no immunization record");
  // García notes: 8 notes, "8 notes"; Feb 8, 2026 is a routine-review chart note (no "Triage:").
  const gn = parseNotesText(GARCIA_NOTES);
  eq(gn.length, 8, "García notes: 8 parsed");
  eq(chunks(GARCIA_NOTES).map((c) => (parseNoteChunk(c) as Note).dateISO), gn.map((n) => n.dateISO), "per-note chunks = page-text parse");
  // The LIVE chunker on the captured García notes MARKUP with no site CSS (jsdom: no layout, header items
  // inline): every note still has its own date line (Set 1 replica run: all 8 notes declined before).
  {
    const html = htmlOf("==== POPULATED notes");
    const live = new Function("doc", "map", NOTE_CHUNKS_JS)(new JSDOM(`<!doctype html><html>${html}</html>`).window.document, null) as string[];
    const parsed = live.map((c) => parseNoteChunk(c));
    eq(parsed.map((n) => (isSkip(n) ? n.skip : n.dateISO)), gn.map((n) => n.dateISO), "live note chunks on the real markup: one date line each");
    ok(!isSkip(parsed[0]) && (parsed[0] as Note).head.join("|") === "Chart note|Dr. Stone" && (parsed[0] as Note).body.startsWith("Patient here with a family member"), "live chunk: header items vs body");
  }
  ok(gn[2].dateISO === "2026-02-08" && gn[2].body.startsWith("Abigail seen for routine review"), "García Feb 8 note body");
  // Johnson notes page 1: "Showing 1 to 10 of 33 notes": 10 parsed; alone it is NOT complete.
  const jn = parseNotesText(JOHNSON_NOTES_P1); eq(jn.length, 10, "Johnson notes page 1: 10 parsed");
  eq(pageInfo(JOHNSON_NOTES_P1, "notes?"), { from: 1, to: 10, total: 33 }, "Johnson notes paginated 1-10 of 33");
  ok(isSkip(combinePages([{ items: jn, page: pageInfo(JOHNSON_NOTES_P1, "notes?")! }])), "page 1 of 3 alone is not a complete notes read");
  // the claims tab's status badge sits on its own line: the table still reads 20 rows ("20 claims")
  const ct = findTable(GARCIA_CLAIMS, { claim: /^claim$/i, status: /^status$/i }, ["claim", "status"]);
  ok(!isSkip(ct) && ct.rows.length === 20 && ct.rows.every((r) => r[ct.col.status] === "Paid"), "badge-on-its-own-line rows join (20 claims, all Paid)");
}
// García, visit 2026-02-08: the chart's notes that day are a routine review, none starts with
// "Triage:" → NO_WOUND_VISIT (the notes list is complete: 8 of 8).
eq(answer("2026-02-08", [GARCIA_NOTES], [], []), "NO_WOUND_VISIT", "García 2026-02-08 → NO_WOUND_VISIT (complete 8-note read)");
// Johnson page 1 only (1-10 of 33): absence is NOT proven → decline.
eq(answer("2026-10-05", [JOHNSON_NOTES_P1], [JOHNSON_IMM], [JOHNSON_DOCS]), null, "Johnson notes page 1 of 3 only → decline");
// García + a triage note on 2026-03-02 (inserted in the real list): "Laceration to the left palm from a
// kitchen knife. No dirt, soil, or saliva in the wound." → clean and minor. Doses before 2026-03-02:
// DTaP (Daptacel) 1952-06-07 only (Influenza ×2 aren't tetanus) → 1 dose ≤ 2 → VACCINE:1:1952-06-07.
const garciaWith = (body: string) => GARCIA_NOTES.replace("8 notes", "9 notes").replace("Chart note\nDr. Espinoza", `Chart note\nRN Patel\nMar 2, 2026, 9:05 AM\nMST\n\n${body}\n\nChart note\nDr. Espinoza`);
const GARCIA_DOCS = "Documents in this chart, newest first\nTitle\tType\tReceived\t\nActions\n\nLab report: Lipid panel\tLab report\tNov 1, 2025\tView\n\n1 document";
eq(answer("2026-03-02", [garciaWith("Triage: Laceration to the left palm from a kitchen knife. No dirt, soil, or saliva in the wound.")], [GARCIA_IMM], [GARCIA_DOCS]), "VACCINE:1:1952-06-07", "García + clean triage → VACCINE:1:1952-06-07");
// …same visit, "Dog bite to the right forearm" → a bite has saliva: other wound → 1 dose → VACCINE_AND_TIG:1:1952-06-07.
eq(answer("2026-03-02", [garciaWith("Triage: Bite from the neighbor's dog to the right forearm.")], [GARCIA_IMM], [GARCIA_DOCS]), "VACCINE_AND_TIG:1:1952-06-07", "García + dog bite → VACCINE_AND_TIG:1:1952-06-07");
// …but the chart holds an outside Immunization record → its doses are unread → decline.
const GARCIA_DOCS_OUTSIDE = "Documents in this chart, newest first\nTitle\tType\tReceived\t\nActions\n\nImmunization record: Ridgeway Community Clinic\tImmunization record\tJan 5, 2026\tView\nLab report: Lipid panel\tLab report\tNov 1, 2025\tView\n\n2 documents";
ok(!isSkip(parseDocuments(GARCIA_DOCS_OUTSIDE)) && (parseDocuments(GARCIA_DOCS_OUTSIDE) as any).docs.length === 2, "outside-record docs page parses (2 of 2)");
eq(answer("2026-03-02", [garciaWith("Triage: Laceration to the left palm from a kitchen knife.")], [GARCIA_IMM], [GARCIA_DOCS_OUTSIDE]), null, "outside Immunization record in Documents → decline");

// The message's worked example (Kathryn Lewis, visit 2025-02-08, feces), with the doses as chart entries:
// 1999-02-24, 1999-04-24, 1999-06-13, 2013-01-14 (+ one on the visit date, + an Entered-in-error entry,
// + a Hib dose). 4 doses before the visit; other wound; 2013-01-14 ≤ 2020-02-08 (5 y back) → VACCINE:4:2013-01-14.
const LEWIS_NOTES = notesPage([["2025-02-08", "Chart note", "Triage: Fell in a barnyard; laceration to the knee contaminated with feces."], ["2024-06-01", "Message", "Patient asked about clinic hours."]]);
const LEWIS_ROWS = [
  ["Td (Tenivac)", "Feb 8, 2025", "TK4471D", "left deltoid", "Ana Ruiz", "Given at Northgate"],
  ["Tdap (Boostrix)", "Jan 14, 2013", "None", "None", "Not recorded", "Given elsewhere, from the patient's records"],
  ["Tdap (Adacel)", "Mar 3, 2012", "AB1234C", "left deltoid", "Ana Ruiz", "Entered in error"],
  ["Hib (ActHIB)", "Jun 13, 1999", "None", "None", "Not recorded", "Given elsewhere, from the patient's records"],
  ["DTaP (Infanrix)", "Jun 13, 1999", "None", "None", "Not recorded", "Given elsewhere, from the patient's records"],
  ["DTaP (Infanrix)", "Apr 24, 1999", "None", "None", "Not recorded", "Given elsewhere, from the patient's records"],
  ["DTaP (Infanrix)", "Feb 24, 1999", "None", "None", "Not recorded", "Given elsewhere, from the patient's records"],
];
// "barnyard" is not on the message's list but "contaminated with feces" is, so the wound is "other".
eq(answer("2025-02-08", [LEWIS_NOTES], [immPage(LEWIS_ROWS)], [EMPTY_DOCS]), "VACCINE:4:2013-01-14", "worked example → VACCINE:4:2013-01-14");

// ═════════════ wound class (the message's wording) ═════════════
const wc = (s: string) => { const r = woundClass(s, RULE); return isSkip(r) ? "skip" : r; };
eq(wc("Triage: 3 cm cut from broken glass. No dirt, soil, or saliva in the wound."), "clean", "negated list → clean");
eq(wc("Triage: Superficial scrape on the shin. Not a puncture and not a bite."), "clean", "'Not a puncture and not a bite' → clean");
eq(wc("Triage: Deep laceration from a razor, 6 cm, nothing in it."), "clean", "razor cut, however deep → clean");
eq(wc("Triage: Puncture wound to the sole of the foot."), "other", "puncture → other");
eq(wc("Triage: Burn to the forearm from a stove."), "other", "burn → other");
eq(wc("Triage: Crushed fingertip in a car door."), "other", "crush → other");
eq(wc("Triage: Abrasion with soil ground into it."), "other", "soil → other");
eq(wc("Triage: Small cut on the hand. Her son was bitten by a dog last week."), "clean", "someone else's bite ignored");
eq(wc("Triage: Cut on the finger from paper. Old burn scar on the arm, healed."), "clean", "healed old burn ignored");
eq(wc("Triage: Stepped on a rusty nail."), "skip", "wording not on the list (nail/rust) → skip");
eq(wc("Triage: Patient feels unwell."), "skip", "no wound described → skip");
eq(wc("Triage: Cut on the knee; the patient's old dog bite has healed but today's cut has dirt in it."), "skip", "a clause mixing this wound with a healed one → skip");

// ═════════════ dose notes ═════════════
const dn = (s: string) => classifyDoseNote(s, RULE);
eq(dn("Td (Tenivac) given today in the left deltoid, lot number TK4471D."), "dose", "the message's example dose note");
eq(dn("Patient thinks the last tetanus shot was about 6 years ago."), "not-dose", "patient's recollection");
eq(dn("Tdap offered, patient declined."), "not-dose", "offered + declined");
eq(dn("Tdap (Boostrix) given at the pharmacy last month per patient."), "not-dose", "another provider's dose");
eq(dn("Recall letter for lot TK4471D (Td) mailed to the patient."), "not-dose", "recall letter mailed");
eq(dn("Patient asked about Td. Given today, lot pending."), "unclear", "administration words without a lot → unclear");
eq(dn("Annual review. Medication list reconciled."), "irrelevant", "unrelated note");
// a dose note given here before the visit adds a dose; one on the visit day doesn't; an unclear one declines
{
  const notes = notesPage([["2026-05-05", "Chart note", "Triage: Cut on the thumb from a kitchen knife."], ["2026-05-05", "Chart note", "Td (Tenivac) given today in the left deltoid, lot number TK4471D."], ["2019-03-02", "Chart note", "Tdap (Adacel) given today in the right deltoid, lot number AD2201X."]]);
  // 1 dose before (2019-03-02, from the note; the visit-day dose doesn't count) → clean, ≤2 → VACCINE:1:2019-03-02
  eq(answer("2026-05-05", [notes], [immPage([])], [EMPTY_DOCS]), "VACCINE:1:2019-03-02", "dose note before the visit counts; visit-day dose doesn't");
  const unclear = notesPage([["2026-05-05", "Chart note", "Triage: Cut on the thumb from a kitchen knife."], ["2020-01-10", "Chart note", "Patient asked about Td. Given today, lot pending."]]);
  eq(answer("2026-05-05", [unclear], [immPage([])], [EMPTY_DOCS]), null, "an unclear dose note → decline");
}
// a phone-call note mentioning the triage nurse is not a wound visit
eq(answer("2026-05-05", [notesPage([["2026-05-05", "Phone call", "Spoke with the triage nurse about a rash."]])], [], []), "NO_WOUND_VISIT", "phone note mentioning triage nurse ≠ wound visit");
eq(answer("2026-05-05", [notesPage([["2026-05-05", "Chart note", "Seen today. Triage: cut on the hand."]])], [], []), null, "'Triage:' mid-note → decline");

// ═════════════ (b) routing: paraphrases (not Set 1 text) + hard negatives ═════════════
const tetPara: Array<[string, Record<string, string>]> = [
  ["Ines Ferreira (DOB 03/14/1987) had a wound visit on 2025-06-02 — what tetanus prophylaxis was indicated?", { name: "Ines Ferreira", dob: "1987-03-14", visit: "2025-06-02" }],
  ["For the laceration Ortega, Luis came in with on March 9, 2026, was a tetanus shot, shot plus TIG, or nothing due?", { name: "Ortega, Luis", visit: "2026-03-09" }],
  ["Patient Hannah Kowalski, born 1979-11-30, was seen for a dog bite on 2024-12-01. Which tetanus option should she have received?", { name: "Hannah Kowalski", dob: "1979-11-30", visit: "2024-12-01" }],
  ["Quick check on tetanus: Marcus Lee came in with a cut on 7/4/2025. What should have been given — vaccine, vaccine and TIG, or none?", { name: "Marcus Lee", visit: "2025-07-04" }],
  ["Tetanus decision for Priya Nair (born 2 May 1990), wound visit 2026-01-17: vaccine, vaccine plus TIG, or neither?", { name: "Priya Nair", dob: "1990-05-02", visit: "2026-01-17" }],
  ["Chart audit, wound care: Okafor, Chidi, date of birth 1965-08-08, visit 2025-10-21. What did tetanus guidance call for?", { name: "Okafor, Chidi", dob: "1965-08-08", visit: "2025-10-21" }],
];
for (const [t, want] of tetPara) { const m = familyMatch(t); ok(m?.family === "tetanus-wound", "routes tetanus: " + t); eq(m?.slots, want, "slots: " + t.slice(0, 50)); }
const tetNeg = [
  "When was Ines Ferreira's last tetanus shot before her visit on 2025-06-02?",
  "How many tetanus doses does Marcus Lee (born 1990-01-01) have on record as of 2025-07-04?",
  "Did Hannah Kowalski get a tetanus vaccine at her appointment on 2024-12-01?",
  "Was TIG given to Priya Nair (born 1990-05-02) at the wound visit on 2026-01-17?",
  "Which lot of Td did we give Luis Ortega on 2026-03-09?",
  "What phone number do we have on file for tetanus patient Marcus Lee (born 1990-01-01)?",
  "What should Hannah Kowalski and Marcus Lee have gotten for tetanus at the wound visit on 2024-12-01?",
];
for (const t of tetNeg) { const m = familyMatch(t); ok(!m || m.family !== "tetanus-wound" || !m.slots.visit || !m.slots.name, "does not route as a tetanus decision: " + t); }
const recPara: Array<[string, string]> = [
  ["Lot RX4471Q was recalled by the manufacturer. How many patients do we still need to send a notice to?", "RX4471Q"],
  ["For the recall on vaccine lot number 9KD204P, what's the count of patients not yet notified?", "9KD204P"],
  ["How many people who got a dose from recalled lot TT31X09 haven't been contacted yet?", "TT31X09"],
  ["Recalled lot #A7Z11K2 — number of patients still waiting on a recall letter?", "A7Z11K2"],
  ["Can you tell me how many patients remain to be notified about lot 55QW12E, which was recalled?", "55QW12E"],
];
for (const [t, lot] of recPara) { const m = familyMatch(t); ok(m?.family === "vaccine-lot-recall" && m.slots.lot === lot, `routes recall (${lot}): ${t}`); }
const recNeg = [
  "How many doses of lot RX4471Q did we receive in the last delivery?",
  "Which patients got a dose from lot 9KD204P?",
  "When was lot TT31X09 recalled?",
  "Was the recall letter for lot A7Z11K2 mailed to Maria Lopez?",
  "How many patients are left to notify about the recall of lots 55QW12E and 66QW12E?",
];
for (const t of recNeg) { const m = familyMatch(t); ok(!m || m.family !== "vaccine-lot-recall" || !m.slots.lot, "does not route as a recall count: " + t); }
// every Set 1 task of the two families routes with the same slots by the strict patterns and by meaning
for (const it of items.filter((x: any) => x.kind === "task")) {
  const m = familyMatch(it.text); if (!m || !["tetanus-wound", "vaccine-lot-recall"].includes(m.family)) continue;
  const byMeaning = m.family === "tetanus-wound" ? tetanusSlots(it.text) : recallSlots(it.text);
  eq(byMeaning, m.slots, `Set 1 task routes the same by meaning: ${it.text.slice(0, 60)}`);
}

// ═════════════ (c) page variants: same answer or decline, never different ═════════════
{
  const visit = "2025-02-08";
  const base = answer(visit, [LEWIS_NOTES], [immPage(LEWIS_ROWS)], [EMPTY_DOCS]);
  const same = (v: string | null, m: string) => ok(v === base || v === null, `${m}: ${v} (base ${base})`);
  const strictSame = (v: string | null, m: string) => eq(v, base, m);
  const H = ["Vaccine", "Date given", "Lot", "Site", "Given by", "Recorded as"];
  const perm = [5, 2, 0, 4, 1, 3];
  strictSame(answer(visit, [LEWIS_NOTES], [immPage(LEWIS_ROWS.map((r) => perm.map((i) => r[i])), perm.map((i) => H[i]))], [EMPTY_DOCS]), "reordered columns");
  strictSame(answer(visit, [LEWIS_NOTES], [immPage(LEWIS_ROWS.map((r) => [...r, "—"]).map((r) => [r[0], r[1], r[2], r[3], r[4], r[5], r[6]]), ["Immunization", "Administered", "Lot number", "Site", "Given by", "Source", "Notes"])], [EMPTY_DOCS]), "renamed + extra column");
  strictSame(answer(visit, [LEWIS_NOTES], [immPage(LEWIS_ROWS.map((r) => [r[0], String(parseDate(r[1])), r[2], r[3], r[4], r[5]]))], [EMPTY_DOCS]), "ISO dates");
  // slash dates: the column proves month-first (a day > 12 appears)
  const us = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(8)}/${iso.slice(0, 4)}`;
  strictSame(answer(visit, [LEWIS_NOTES], [immPage(LEWIS_ROWS.map((r) => [r[0], us(String(parseDate(r[1]))), r[2], r[3], r[4], r[5]]))], [EMPTY_DOCS]), "MM/DD/YYYY dates (column proves the order)");
  // all-ambiguous slash dates (every day ≤ 12) → the order can't be proven → decline
  same(answer(visit, [LEWIS_NOTES], [immPage([["Td (Tenivac)", "02/03/2010", "None", "None", "Not recorded", "Given elsewhere"]])], [EMPTY_DOCS]), "ambiguous slash date");
  eq(answer(visit, [LEWIS_NOTES], [immPage([["Td (Tenivac)", "02/03/2010", "None", "None", "Not recorded", "Given elsewhere"]])], [EMPTY_DOCS]), null, "ambiguous slash date → decline");
  // paginated immunizations, read on both pages → same; one page only → decline
  const p1 = immPage(LEWIS_ROWS.slice(0, 4), undefined, "Showing 1 to 4 of 7 entries"), p2 = immPage(LEWIS_ROWS.slice(4), undefined, "Showing 5 to 7 of 7 entries");
  strictSame(answer(visit, [LEWIS_NOTES], [p1, p2], [EMPTY_DOCS]), "paginated immunizations (2 pages)");
  eq(answer(visit, [LEWIS_NOTES], [p1], [EMPTY_DOCS]), null, "first page of immunizations only → decline");
  // paginated notes (triage on page 2)
  const n1 = notesPage([["2025-03-01", "Message", "Patient asked about clinic hours."]], "Showing 1 to 1 of 2 notes");
  const n2 = notesPage([["2025-02-08", "Chart note", "Triage: Fell in a barnyard; laceration to the knee contaminated with feces."]], "Showing 2 to 2 of 2 notes");
  strictSame(answer(visit, [n1, n2], [immPage(LEWIS_ROWS)], [EMPTY_DOCS]), "paginated notes (triage on page 2)");
  eq(answer(visit, [n1], [immPage(LEWIS_ROWS)], [EMPTY_DOCS]), null, "notes page 1 of 2 only → decline (never NO_WOUND_VISIT)");
  // footer count disagrees with the rows → decline
  eq(answer(visit, [LEWIS_NOTES], [immPage(LEWIS_ROWS, undefined, "8 entries")], [EMPTY_DOCS]), null, "entry count ≠ rows → decline");
  // missing Recorded-as column → decline; missing Date column → decline
  eq(answer(visit, [LEWIS_NOTES], [immPage(LEWIS_ROWS.map((r) => r.slice(0, 5)), H.slice(0, 5))], [EMPTY_DOCS]), null, "no Recorded-as column → decline");
  eq(answer(visit, [LEWIS_NOTES], [immPage(LEWIS_ROWS.map((r) => [r[0], ...r.slice(2)]), [H[0], ...H.slice(2)])], [EMPTY_DOCS]), null, "no date column → decline");
  // an unknown recorded-as value / unknown tetanus-ish product → decline
  eq(answer(visit, [LEWIS_NOTES], [immPage([...LEWIS_ROWS, ["Td (Tenivac)", "Jan 2, 2005", "None", "None", "Not recorded", "Pending review"]])], [EMPTY_DOCS]), null, "unknown Recorded-as → decline");
  eq(answer(visit, [LEWIS_NOTES], [immPage([...LEWIS_ROWS, ["Tdap (TdVax)", "Jan 2, 2005", "None", "None", "Not recorded", "Given elsewhere"]])], [EMPTY_DOCS]), null, "unknown tetanus product → decline");
  // empty immunization list (with a footer) and no dose notes → 0 doses: other wound → VACCINE_AND_TIG:0:NONE
  eq(answer(visit, [LEWIS_NOTES], ["Immunizations, newest first\n\nNo immunizations recorded"], [EMPTY_DOCS]), "VACCINE_AND_TIG:0:NONE", "empty immunization list → 0 doses");
  eq(answer(visit, [LEWIS_NOTES], ["Immunizations, newest first\nVaccine\tDate given\tLot\tSite\tGiven by\tRecorded as\n"], [EMPTY_DOCS]), null, "a list with no count at all → decline (absence unproven)");
  // notes with ISO / written-out dates
  const isoNotes = LEWIS_NOTES.replace("Feb 8, 2025, 10:15 AM", "2025-02-08 10:15").replace("Jun 1, 2024, 10:15 AM", "2024-06-01 10:15");
  strictSame(answer(visit, [isoNotes], [immPage(LEWIS_ROWS)], [EMPTY_DOCS]), "ISO note dates");
  const longNotes = LEWIS_NOTES.replace("Feb 8, 2025, 10:15 AM", "February 8, 2025 at 10:15 AM").replace("Jun 1, 2024, 10:15 AM", "June 1, 2024 at 10:15 AM");
  strictSame(answer(visit, [longNotes], [immPage(LEWIS_ROWS)], [EMPTY_DOCS]), "written-out note dates");
  // documents: renamed columns, and an outside record identified by its title only
  strictSame(answer(visit, [LEWIS_NOTES], [immPage(LEWIS_ROWS)], ["Document\tCategory\tDate received\nLab report: CBC\tLab report\t2024-01-05\n\n1 document"]), "renamed document columns");
  eq(answer(visit, [LEWIS_NOTES], [immPage(LEWIS_ROWS)], ["Title\tType\tReceived\nImmunization record: Dunmore County Health Department\tScanned\tJan 5, 2024\n\n1 document"]), null, "outside record by title → decline");
}

// ═════════════ recall: the message's count rule (pure; the live reader is not built) ═════════════
{
  const L = "M81X24L";
  const rows = [{ patientId: "/patients/a", status: "Active", testRecord: false }, { patientId: "/patients/a", status: "Active", testRecord: false }, { patientId: "/patients/b", status: "Entered in error", testRecord: false }, { patientId: "/patients/t", status: "Active", testRecord: true }, { patientId: "/patients/c", status: "Active", testRecord: false }];
  const notes = [
    { patientId: "/patients/d", dateISO: "2026-01-02", body: `Tdap given today in the left deltoid, lot ${L}.`, testRecord: false },
    { patientId: "/patients/a", dateISO: "2026-02-01", body: `Recall letter for lot ${L} mailed to the patient.`, testRecord: false },
    { patientId: "/patients/c", dateISO: "2026-02-01", body: `Recall notice for lot ${L} sent through the patient portal.`, testRecord: false },
    { patientId: "/patients/c", dateISO: "2026-02-20", body: `Recall letter for lot ${L} came back undeliverable.`, testRecord: false },
    { patientId: "/patients/e", dateISO: "2026-02-01", body: `Recall letter for lot ${L} mailed.`, testRecord: false },
  ];
  // dosed: a, c, d (b entered in error, t a test record); notified: a (c's later note: returned; e never dosed) → 2
  eq(recallCount(rows, notes, L), "2", "recall count: dosed a,c,d − notified a = 2");
  eq(classifyRecallNote(`Patient called asking about the recall of lot ${L}.`, L), "unclear", "a patient asking → unclear");
  eq(classifyRecallNote(`Recall of lot ZZ11223; chart shows lot ${L}.`, L), "unclear", "another lot named → unclear");
  ok(isSkip(recallCount(rows, [...notes, { patientId: "/patients/f", dateISO: "2026-03-01", body: `Lot ${L} discussed.`, testRecord: false }], L)), "an unclassifiable lot note → skip");
}

ok(!isSkip(tetanusRuleFrom([tetMsg, "Employee health has Tdap and flu shots in the break room Thursday; tetanus boosters too."])), "a later noise message mentioning tetanus doesn't block the rule");

// ═════════════ solver plumbing: Set 1 message through the MessageStore → rule → reader → engine ═════════════
(async () => {
  const { MessageStore } = await import("./inference.js");
  const { compiler } = await import("./run.js");
  const { solveFamily } = await import("./solvers.js");
  const store = new MessageStore(compiler);
  for (const it of items.filter((x: any) => x.kind === "message")) await store.ingest(it.text);
  const seen: any[] = [];
  const index: any = { providers: new Map(), appointments: [], byDate: () => [], findPatient: () => null,
    tetanusContext: async (name: string, dob: string | undefined, visit: string, rule: TetanusRule) => {
      seen.push({ name, dob, visit, years: [rule.cleanYears, rule.otherYears] });
      // García's real pages + a clean triage note on the visit date (hand-verified above: VACCINE:1:1952-06-07)
      const notes = parseNotesText(garciaWith("Triage: Laceration to the left palm from a kitchen knife.").replace("Mar 2, 2026", md(visit)));
      const imms = (parseImmunizations(GARCIA_IMM) as any).entries, docs = (parseDocuments(GARCIA_DOCS) as any).docs;
      const c = buildTetanusContext({ visitISO: visit, notes, notesComplete: true, imms, immsComplete: true, docs, docsComplete: true }, rule);
      return isSkip(c) ? null : c;
    } };
  const task = items.find((x: any) => x.kind === "task" && /Mary Turner/.test(x.text)).text; // visit 2024-11-17
  const a = await solveFamily(familyMatch(task)!, index, store);
  eq(seen[0], { name: "Mary Turner", dob: "2008-09-03", visit: "2024-11-17", years: [10, 5] }, "solver passes the slots + the message's rule to the reader");
  eq(a, "VACCINE:1:1952-06-07", "solver end-to-end on fixture pages");
  const r = await solveFamily(familyMatch("Recall, lot 5NF133C: patients left to notify?")!, index, store);
  eq(r, null, "recall without a lot reader → skip (never a number)");
  console.log(`${fail ? "✗" : "✓"} immunizations: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
