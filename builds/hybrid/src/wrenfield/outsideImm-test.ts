/**
 * Outside immunization records (tetanus-wound): resolver + agreement + wiring, and a replay over the
 * Set 1 skip_probe captures (fixtures/set1/run-146-set1.log).
 *   npx tsx src/wrenfield/outsideImm-test.ts
 */
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { type TetanusRule, type Doc, type Note, isSkip, parseTetanusRule, buildTetanusContext } from "./immunizations.js";
import { datesWritten, resolveRow, tetanusDoses, parseOutsideText, fromModelJson, agree } from "./outsideImm.js";
import { readOutsideRecord } from "./outsideImmRead.js";
import { DOC_ROW_LINKS_JS, outsideHrefs } from "./immunizationsLive.js";

let pass = 0, fail = 0;
const eq = (got: unknown, want: unknown, m: string) => { if (JSON.stringify(got) === JSON.stringify(want)) pass++; else { fail++; console.error(`✗ ${m}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); } };
const skips = (x: unknown, m: string) => { if (isSkip(x)) pass++; else { fail++; console.error(`✗ ${m}: expected a skip, got ${JSON.stringify(x)}`); } };

const items = readFileSync(new URL("../../fixtures/set1-items.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const RULE = parseTetanusRule(items.find((x: any) => x.kind === "message" && /tetanus checks for wound visits/.test(x.text)).text) as TetanusRule;

// ── the message's own statements ──
eq(resolveRow(["03/14/2019", "05/16", "11/02", "01/15"], "MDY"), ["2019-03-14", "2019-05-16", "2019-11-02", "2020-01-15"], "message example: yearless grid row");
eq(resolveRow(["14.03.2019", "16.05.", "02.11.", "15.01."], "DMY"), ["2019-03-14", "2019-05-16", "2019-11-02", "2020-01-15"], "same row, DD.MM.YYYY");
eq(resolveRow(["14 Mar 2019", "16 May", "2 Nov", "15 Jan"], "DMONY"), ["2019-03-14", "2019-05-16", "2019-11-02", "2020-01-15"], "same row, day month year");
eq(resolveRow(["2019-03-14", "2019-05-16"], "YMD"), ["2019-03-14", "2019-05-16"], "ISO row");
eq(resolveRow(["03/14/2019", "03/14"], "MDY"), ["2019-03-14", "2020-03-14"], "same month/day → next year (strictly after)");
eq(resolveRow(["03/01/2019", "02/29"], "MDY"), ["2019-03-01", "2020-02-29"], "Feb 29 → first year that has it after");
skips(resolveRow(["05/16", "11/02"], "MDY"), "first date without a year");
skips(resolveRow(["14.03.2019"], "MDY"), "date not in the stated format");
skips(resolveRow(["13/14/2019"], "MDY"), "impossible date");
eq(datesWritten("Sex: F\nDates written: MM/DD/YYYY"), "MDY", "format line MDY");
eq(datesWritten("Dates written DD.MM.YYYY"), "DMY", "format line DMY");
eq(datesWritten("Dates written: day month year (14 Mar 2021)"), "DMONY", "format line day month year");
eq(datesWritten("Dates written: YYYY-MM-DD"), "YMD", "format line ISO");
eq(datesWritten("Sex: F"), null, "no format line");

// ── tesseract-like text ──
const GRID = `St. Brendan's Children's Clinic\nImmunization record\nPatient: Hollis, Sofia\nDate of birth: 10/15/1993\nSex: F\nDates written: MM/DD/YYYY\nVaccine Dose 1 Dose 2 Dose 3 Dose 4\nPentacel 12/15/1993 02/14 04/16\nHib (ActHIB) 12/15/1993 02/14\nIPV (IPOL) 12/15/1993 02/14 04/16\nDaptacel 10/20/1995\nPrinted 01/20/2022`;
const g = parseOutsideText(GRID, RULE);
eq(isSkip(g) ? g : tetanusDoses(g, RULE), ["1993-12-15", "1994-02-14", "1994-04-16", "1995-10-20"], "grid: tetanus rows only, yearless dates resolved, DOB/print dates ignored");
const ROWS = `Ridgeway Community Clinic\nSex: M\nDates written: DD.MM.YYYY\nVaccine Date given\nTd 05.06.1990\nMMR 05.06.1990\nTdap (Boostrix) 21.08.2009\nInfluenza (Fluzone) 01.10.2020`;
const r = parseOutsideText(ROWS, RULE);
eq(isSkip(r) ? r : tetanusDoses(r, RULE), ["1990-06-05", "2009-08-21"], "one dose per row, DMY");
skips(((x) => isSkip(x) ? x : tetanusDoses(x, RULE))(parseOutsideText(ROWS.replace("Td 05.06.1990", "Td 05.06.1990 05.06.2000"), RULE)), "two dates on a one-dose row → skip");
skips(parseOutsideText(GRID.replace("Dates written: MM/DD/YYYY\n", ""), RULE), "no Dates written line → skip");
skips(((x) => isSkip(x) ? x : tetanusDoses(x, RULE))(parseOutsideText(GRID.replace("Daptacel", "Quadracel"), RULE)), "tetanus-looking name not in the list → skip");
{ const x = parseOutsideText(GRID.replace("Daptacel", "Dapt4cel"), RULE); eq(isSkip(x) ? x : tetanusDoses(x, RULE), ["1993-12-15", "1994-02-14", "1994-04-16"], "OCR-garbled name dropped by tesseract (the model read then disagrees → tiebreak)"); }

// ── model JSON ──
const mj = fromModelJson({ dates_written: "MM/DD/YYYY", layout: "grid", rows: [{ vaccine: "Pentacel", dates: ["12/15/1993", "02/14", "04/16"] }, { vaccine: "Hib (ActHIB)", dates: ["12/15/1993"] }, { vaccine: "Daptacel", dates: ["10/20/1995"] }] });
eq(isSkip(mj) ? mj : tetanusDoses(mj, RULE), ["1993-12-15", "1994-02-14", "1994-04-16", "1995-10-20"], "model JSON → same doses");
skips(fromModelJson({ dates_written: null, rows: [] }), "model without the format → skip");

// ── agreement (lab pattern) ──
const A = ["2001-01-01"], B = ["2001-01-02"];
eq(agree(A, A), A, "tess = model → accepted");
skips(agree(A, B), "disagree → need tiebreak");
eq(agree(A, B, B), B, "tiebreak sides with the model");
skips(agree(A, B, ["2001-01-03"]), "three different → decline");
skips(agree({ skip: "x" }, A, { skip: "y" }), "one reader only → decline");
(async () => {
  const fake = (tess: string[] | null, m1: string[] | null, m2: string[] | null) => ({
    tess: async () => (tess ? { doses: tess, text: "" } : null),
    model: async (_p: string, model: string) => { const d = model === "M1" ? m1 : m2; return d ? { doses: d, json: {} } : null; },
    primary: "M1", tiebreak: "M2",
  });
  eq(await readOutsideRecord("x", RULE, fake(A, A, null)), A, "readOutsideRecord: agree, no tiebreak");
  skips(await readOutsideRecord("x", RULE, fake(A, B, null)), "readOutsideRecord: disagree + tiebreak fails → skip");
  eq(await readOutsideRecord("x", RULE, fake(null, A, A)), A, "readOutsideRecord: tesseract down, model + tiebreak agree");

  // ── context: outside doses join the count; missing reads still decline ──
  const notes: Note[] = [{ dateISO: "2025-09-17", time: "", head: [], body: "Triage: Laceration to the left palm from a kitchen knife." }];
  const docs: Doc[] = [{ title: "Immunization record: Ridgeway Community Clinic", kind: "Immunization record", receivedISO: "2022-02-16" }];
  const base = { visitISO: "2025-09-17", notes, notesComplete: true, imms: [], immsComplete: true, docs, docsComplete: true };
  skips(buildTetanusContext(base, RULE), "outside record without a read → decline (unchanged)");
  eq((buildTetanusContext({ ...base, outsideDoses: [["1990-06-05", "2009-08-21", "2025-09-17"]] }, RULE) as any).doseDatesISO, ["1990-06-05", "2009-08-21"], "outside doses counted, visit-day dose not");

  // ── replay over the REAL Set 1 captures: the documents tab of the 3 charts that skipped ──
  const log = readFileSync(new URL("../../fixtures/set1/run-146-set1.log", import.meta.url), "utf8").split("\n");
  const probes = log.filter((l) => l.includes('"skip_probe"') && l.includes("outside Immunization record")).map((l) => JSON.parse(l));
  eq(probes.length, 3, "three Set 1 outside-record skip probes");
  for (const p of probes) {
    const d = new JSDOM(`<!doctype html><html>${p.html}</html>`).window.document;
    const links = new Function("doc", DOC_ROW_LINKS_JS)(d) as Array<{ t: string; h: string[] }>;
    const rows = [...d.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => (td.textContent || "").trim()));
    const docs2: Doc[] = rows.map((c) => ({ title: c[0], kind: c[1], receivedISO: "" }));
    const hrefs = outsideHrefs(docs2, links);
    const want = [...d.querySelectorAll("a[aria-label^='View Immunization record']")].map((a) => a.getAttribute("href"));
    eq(hrefs, want, `replay ${p.url}: outside record viewer href found by its row title`);
    console.log(`replay ${p.url}: outside record(s) ${JSON.stringify(hrefs)} — no image in the capture; the run will now fetch + read + log a doc_probe`);
  }
  console.log(`outsideImm-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
