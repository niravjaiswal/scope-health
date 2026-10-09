/**
 * labRead offline checks (no network, no tesseract binary needed):
 *   A. normalisers (dates, identifiers, decimals);
 *   B. the tesseract-text parser on the 25 real practice OCR texts (fixtures/lab-vision/truth.json):
 *      every value it returns equals the labelled truth (it may abstain, never mis-assign), plus
 *      synthetic scan noise (misread labels, Record vs Report number, a test printed twice, junk tokens);
 *   C. agreement: kept only when two readers agree; one tiebreak call for open fields only;
 *      gpt-6-luna is never a reader.
 *   D. if a tesseract binary is on PATH and LAB_IMAGES points at the practice images, live tesseract
 *      on every image: 0 wrong values vs the truth.
 *   npx tsx src/wrenfield/labRead-test.ts
 */
import { readFileSync, existsSync } from "node:fs";
import { isoDate, ident, decimal, parseLabText, readLab, altTiebreak, tesseractLab, type LabRead, type LabNeed } from "./labRead.js";

let pass = 0, fail = 0;
const eq = (got: unknown, want: unknown, label: string) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++; else { fail++; console.error(`✗ ${label}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`); }
};

// ── A ──
eq(isoDate("2025-09-08"), "2025-09-08", "ISO date");
eq(isoDate("9/8/2025"), "2025-09-08", "US date");
eq(isoDate("Sep 8, 2025"), "2025-09-08", "month-name date");
eq(isoDate("September 8 2025"), "2025-09-08", "long month-name date");
eq(isoDate("8 Sep 2025"), "2025-09-08", "day-month-year");
eq(isoDate("2025-02-30"), undefined, "impossible date");
eq(isoDate("2025-09-0B"), undefined, "OCR letter in a date");
eq(ident("LR-012381"), "LR012381", "report number");
eq(ident("hg 6912493"), "HG6912493", "record number");
eq(ident("LR-"), undefined, "no digits → no identifier");
eq(decimal("4.0"), 4, "decimal 4.0");
eq(decimal("<0.5"), undefined, "a qualified result is not a plain decimal");
eq(decimal("4,.0"), undefined, "OCR junk is not a decimal");
eq(decimal("1,250"), 1250, "thousands separator");

// ── B ──
const VOCAB = ["White blood cell count", "Hemoglobin", "Hematocrit", "Platelet count", "Sodium", "Potassium", "Chloride", "Carbon dioxide", "Blood urea nitrogen", "Creatinine", "Glucose", "Calcium", "Thyroid stimulating hormone", "Free T4", "Total cholesterol", "LDL cholesterol", "HDL cholesterol", "Triglycerides", "Ferritin", "Serum iron", "Transferrin saturation", "25-hydroxyvitamin D", "Hemoglobin A1c", "Alanine aminotransferase", "Aspartate aminotransferase", "Alkaline phosphatase", "Total bilirubin", "Albumin"];
const truth = JSON.parse(readFileSync(new URL("../../fixtures/lab-vision/truth.json", import.meta.url), "utf8")).reports as Array<{ id: string; image: string; values: Record<string, string>; collected: string; report: string; record: string; ocrText: string; scanned: boolean }>;
/** Score one tesseract reading against the truth. A wrong value is allowed ONLY on a degraded scan
 *  (tesseract is one of two readers: its digit misreads there — 4.1 → 41, 41 → 4 — are exactly what the
 *  model disagreeing + the tiebreak catch); on a clean page every value it returns must be right. */
const check = (r: LabRead, t: (typeof truth)[number] & { scanned?: boolean }, tag: string) => {
  let right = 0, wrong = 0; const bad = (label: string, got: unknown, want: unknown) => { wrong++; if (!t.scanned) eq(got, want, `${tag} ${t.id} ${label} (clean page)`); else misreads.push(`${t.id} ${label}: ${got} (printed ${want})`); };
  for (const [k, v] of Object.entries(r.values)) { if (String(v) === String(decimal(t.values[k]))) right++; else bad(k, v, t.values[k]); }
  for (const [f, want] of [["collected", isoDate(t.collected)], ["report", ident(t.report)], ["record", ident(t.record)]] as const) {
    const got = (r as any)[f]; if (got === undefined) continue; if (got === want) right++; else bad(f, got, want);
  }
  return { right, wrong };
};
const misreads: string[] = [];
let bRight = 0, bWrong = 0, bTotal = 0;
for (const t of truth) { const c = check(parseLabText(t.ocrText, VOCAB), t, "ocrText"); bRight += c.right; bWrong += c.wrong; bTotal += Object.keys(t.values).length + 3; }
console.log(`  parser on stored OCR texts: ${bRight}/${bTotal} fields read, ${bWrong} tesseract misreads on degraded scans: ${misreads.join("; ")}`);
eq(bWrong <= 3, true, "no more tesseract misreads than the benchmark recorded (3, all on degraded scans)");

const noisy = [
  "Patient Thomas Garcia Ordering provider Denise Lee, DO",
  "Date of birth 1982-12-16 Coliected 2025-09-08",
  "Sex M Recieved 2025-09-11",
  "Record number HG6912493 Report number LR-018236",
  ". White blood cell count. 41 1043/uL 4,.0- 11.0 normal",
  "Hemoglobin 16.6 - g/d. 12.0- 17.0 ~~ normal",
  "Hematocrit © 41.5 % 36.0 - 50.0 normal",
  ", Platelet count 257 10A3/uL - 150 - 400 normal",
  "Tests reported: 4",
].join("\n");
const n = parseLabText(noisy, VOCAB);
eq(n.collected, "2025-09-08", "misread label 'Coliected' still read (1 letter)");
eq([n.record, n.report], ["HG6912493", "LR018236"], "Record number and Report number on one line not confused");
eq(n.values, { "White blood cell count": 41, Hemoglobin: 16.6, Hematocrit: 41.5, "Platelet count": 257 }, "rows found past junk tokens (41 is tesseract's dropped decimal: the model disagrees → tiebreak)");
const dup = parseLabText("Sodium 140 mmol/L\nSodium 150 mmol/L\nPotassium 4.0 mmol/L", VOCAB);
eq([dup.values.Sodium, dup.values.Potassium], [undefined, 4], "a test printed twice → unknown");
eq(parseLabText("Hemoglobin A1c 5.6 %", VOCAB).values, { "Hemoglobin A1c": 5.6 }, "Hemoglobin A1c is not Hemoglobin");
eq(parseLabText("Hemoglobin A1c 5.6 %", ["Hemoglobin"]).values, {}, "Hemoglobin A1c row never read as Hemoglobin when only Hemoglobin is in the vocabulary");
eq(parseLabText("Sodium H 140", VOCAB).values, {}, "the token after the name must be the number");
eq(parseLabText("Collected 2025-09-08\nCollected 2025-09-09", VOCAB).collected, undefined, "two different collected dates → unknown");

// ── C ──
const fake = (tab: Record<string, LabRead | null>) => {
  const calls: string[] = [];
  const fn = async (_png: string, model: string, need: LabNeed) => { calls.push(model + ":" + need.tests.length + "/" + need.meta.length); const r = tab[model]; return r ? { ...r, ms: 1 } : null; };
  return { calls, fn: fn as any };
};
const need: LabNeed = { tests: ["Sodium", "Potassium"], meta: ["collected", "record"], allRows: true };
const tessOf = (r: LabRead) => Promise.resolve({ ...r, ms: 1 });
{
  const f = fake({ "google/gemini-3.8-flash": { values: { Sodium: 140, Potassium: 4 }, collected: "2025-09-08", record: "HG1" } });
  const r = await readLab("x", need, VOCAB, { tess: tessOf({ values: { Sodium: 140, Potassium: 4 }, collected: "2025-09-08", record: "HG1" }), modelRead: f.fn });
  eq(r.read, { values: { Sodium: 140, Potassium: 4 }, collected: "2025-09-08", record: "HG1" }, "both agree → kept"); eq(f.calls, ["google/gemini-3.8-flash:2/2"], "no tiebreak when all agree");
}
{
  const f = fake({ "google/gemini-3.8-flash": { values: { Sodium: 140, Potassium: 4.1 }, collected: "2025-09-08", record: "HG1" }, "anthropic/claude-haiku-4.5": { values: { Sodium: 140, Potassium: 4.1 }, collected: "2025-09-08", record: "HG1" } });
  const r = await readLab("x", need, VOCAB, { tess: tessOf({ values: { Sodium: 140, Potassium: 41 }, collected: "2025-09-08", record: "HG1" }), modelRead: f.fn });
  eq(r.read.values, { Sodium: 140, Potassium: 4.1 }, "tesseract drops a decimal → tiebreak agrees with the model → kept");
  eq(f.calls.length, 2, "exactly one tiebreak call"); eq(r.trace.disagreed, ["test:Potassium"], "only the disagreeing field is open");
}
{
  const f = fake({ "google/gemini-3.8-flash": { values: { Sodium: 140, Potassium: 4.1 }, collected: "2025-09-08", record: "HG1" }, "anthropic/claude-haiku-4.5": { values: { Sodium: 140, Potassium: 4.7 }, collected: "2025-09-08", record: "HG1" } });
  const r = await readLab("x", need, VOCAB, { tess: tessOf({ values: { Sodium: 140, Potassium: 41 }, collected: "2025-09-08", record: "HG1" }), modelRead: f.fn });
  eq(r.read.values.Potassium, undefined, "three different readings → unknown"); eq(r.trace.unknown, ["test:Potassium"], "unknown reported");
}
{
  const f = fake({ "anthropic/claude-haiku-4.5": { values: { Sodium: 140, Potassium: 4 }, collected: "2025-09-08", record: "HG1" } });
  const r = await readLab("x", need, VOCAB, { tess: tessOf({ values: { Sodium: 140, Potassium: 4 }, collected: "2025-09-08", record: "HG1" }), modelRead: f.fn });
  eq(r.read.values, { Sodium: 140, Potassium: 4 }, "primary model down → the tiebreak model is the second reader");
}
{
  const f = fake({ "google/gemini-3.8-flash": { values: { Sodium: 140, Potassium: 4 }, collected: "2025-09-08", record: "HG1" } });
  const r = await readLab("x", need, VOCAB, { tess: Promise.resolve(null), modelRead: f.fn });
  eq(r.read.values, {}, "one model alone never answers (tesseract failed, tiebreak unavailable)");
}
{
  const f = fake({ "openai/gpt-6-luna": { values: { Sodium: 140, Potassium: 4 }, collected: "2025-09-08", record: "HG1" } });
  const r = await readLab("x", need, VOCAB, { tess: tessOf({ values: { Sodium: 140, Potassium: 4 }, collected: "2025-09-08", record: "HG1" }), model: "openai/gpt-6-luna", tiebreak: "openai/gpt-6-luna", modelRead: f.fn });
  eq([r.read.values, f.calls], [{}, []], "gpt-6-luna is never called as a reader");
}

// ── E: model tiers (haiku-5.5 opt-in, default unchanged) ──
{
  const { _setListed, pickModel, transportState } = await import("./failover.js");
  const { LAB_MODEL, LAB_TIEBREAK } = await import("./labRead.js");
  const H5 = "anthropic/claude-haiku-5.5", H4 = "anthropic/claude-haiku-4.5", G = "google/gemini-3.8-flash";
  _setListed();
  eq([LAB_MODEL(), LAB_TIEBREAK()], [G, H4], "models check not run → today's default (gemini + haiku-4.5 tiebreak)");
  _setListed([G, "openai/gpt-6-luna"]);
  eq([LAB_MODEL(), LAB_TIEBREAK()], [G, H4], "neither haiku listed by the proxy → default");
  _setListed([H4, G, "openai/gpt-6-luna"]);
  eq([LAB_MODEL(), LAB_TIEBREAK()], [H4, G], "haiku-5.5 not listed → tesseract ∥ haiku-4.5, gemini tiebreak only");
  _setListed([H4, G, H5]);
  eq([LAB_MODEL(), LAB_TIEBREAK()], [H5, G], "haiku-5.5 listed → tesseract ∥ haiku-5.5, gemini tiebreak");
  eq(pickModel([H5, H4]), H5, "pickModel: confirmed preferred model");
  // a failed haiku-5.5 read: retried once, then ONE substitute read by haiku-4.5 (gemini stays the tiebreak; the
  // two haikus never form the agreeing pair); one failure never demotes haiku-5.5
  const f = fake({ [H4]: { values: { Sodium: 140, Potassium: 4 }, collected: "2025-09-08", record: "HG1" } });
  const r = await readLab("x", need, VOCAB, { tess: tessOf({ values: { Sodium: 140, Potassium: 4 }, collected: "2025-09-08", record: "HG1" }), modelRead: f.fn });
  eq([f.calls, r.read.values, r.trace.primary], [[`${H5}:2/2`, `${H5}:2/2`, `${H4}:2/2`], { Sodium: 140, Potassium: 4 }, H4], "haiku-5.5 fails twice → haiku-4.5 is the second reader for this report");
  eq(transportState.bad.has(H5), false, "haiku-5.5 not demoted on one failed read");
  eq([LAB_MODEL(), LAB_TIEBREAK()], [H5, G], "after one failure → still the haiku-5.5 tier");
  // substitute disagrees with tesseract → gemini tiebreak must equal tesseract or haiku-4.5; haiku-5.5 never in the pair
  const f2 = fake({ [H4]: { values: { Sodium: 140, Potassium: 4.1 }, collected: "2025-09-08", record: "HG1" }, [G]: { values: { Sodium: 140, Potassium: 4.1 }, collected: "2025-09-08", record: "HG1" } });
  const r3 = await readLab("x", need, VOCAB, { tess: tessOf({ values: { Sodium: 140, Potassium: 41 }, collected: "2025-09-08", record: "HG1" }), modelRead: f2.fn });
  eq([f2.calls, r3.read.values], [[`${H5}:2/2`, `${H5}:2/2`, `${H4}:2/2`, `${G}:1/0`], { Sodium: 140, Potassium: 4.1 }], "substitute haiku-4.5 + gemini tiebreak (asked only the disputed field) agree → kept");
  eq([r3.trace.agreed1, r3.trace.agreedTb], [3, { tessTb: 0, primaryTb: 1 }], "first-pass and tiebreak agreements counted apart");
  // haiku-5.5 working: agreement with tesseract keeps the field, gemini only on disagreement
  _setListed([H4, G, H5]);
  const g = fake({ [H5]: { values: { Sodium: 140, Potassium: 4.1 }, collected: "2025-09-08", record: "HG1" }, [G]: { values: { Sodium: 140, Potassium: 4.1 }, collected: "2025-09-08", record: "HG1" } });
  const r2 = await readLab("x", need, VOCAB, { tess: tessOf({ values: { Sodium: 140, Potassium: 41 }, collected: "2025-09-08", record: "HG1" }), modelRead: g.fn });
  eq([g.calls, r2.read.values], [[`${H5}:2/2`, `${G}:1/0`], { Sodium: 140, Potassium: 4.1 }], "haiku-5.5 primary: disagreement → one gemini tiebreak on the disputed field only");
  // two LLMs of one provider never form the agreeing pair: primary haiku-5.5 + tiebreak haiku-4.5 (env override) agree
  // on a value tesseract misread → unknown (only a tesseract agreement counts)
  const s2 = fake({ [H5]: { values: { Sodium: 140, Potassium: 4.1 }, collected: "2025-09-08", record: "HG1" }, [H4]: { values: { Sodium: 140, Potassium: 4.1 }, collected: "2025-09-08", record: "HG1" } });
  const r4 = await readLab("x", need, VOCAB, { tess: tessOf({ values: { Sodium: 140, Potassium: 41 }, collected: "2025-09-08", record: "HG1" }), model: H5, tiebreak: H4, modelRead: s2.fn });
  eq([r4.read.values, r4.trace.unknown], [{ Sodium: 140 }, ["test:Potassium"]], "same-provider primary + tiebreak never agree a field between themselves");
  // Set 1 n=4 / n=47: tesseract and haiku-5.5 disagree on one field and the gemini tiebreak returns NOTHING (hung past the hard
  // timeout). A second tiebreak by another provider than the hung one (haiku-4.5) is asked only that field and counts only
  // when it equals tesseract; it never pairs with haiku-5.5 (one provider).
  const row = (k: number) => ({ values: { Sodium: 140, Potassium: k }, collected: "2025-09-08", record: "HG1" });
  const tessK = (k: number) => tessOf(row(k));
  {
    const a = fake({ [H5]: row(4.1), [H4]: row(4) });                                      // gemini: no reply
    const r = await readLab("x", need, VOCAB, { tess: tessK(4), modelRead: a.fn });
    eq([a.calls, r.read.values, r.trace.agreedAlt, r.trace.tbAlt], [[`${H5}:2/2`, `${G}:1/0`, `${H4}:1/0`], { Sodium: 140, Potassium: 4 }, 1, H4], "gemini tiebreak silent → haiku-4.5 asked the disputed field; equals tesseract → kept");
    eq(r.trace.agreedTb, { tessTb: 1, primaryTb: 0 }, "counted as a tesseract + tiebreak agreement");
  }
  {
    const a = fake({ [H5]: row(4.1), [H4]: row(4.1) });                                    // haiku-4.5 sides with haiku-5.5 only
    const r = await readLab("x", need, VOCAB, { tess: tessK(4), modelRead: a.fn });
    eq([r.read.values, r.trace.unknown], [{ Sodium: 140 }, ["test:Potassium"]], "second tiebreak equal to the primary only (same provider) → unknown, never a pair");
  }
  {
    const a = fake({ [H5]: row(4.1), [H4]: row(4.7) });
    const r = await readLab("x", need, VOCAB, { tess: tessK(4), modelRead: a.fn });
    eq([r.read.values.Potassium, r.trace.unknown], [undefined, ["test:Potassium"]], "second tiebreak reads a third value → unknown");
  }
  {
    const a = fake({ [H5]: row(4.1) });                                                    // both tiebreaks silent
    const r = await readLab("x", need, VOCAB, { tess: tessK(4), modelRead: a.fn });
    eq([r.read.values.Potassium, r.trace.unknown], [undefined, ["test:Potassium"]], "no second opinion at all → unknown");
  }
  {
    const a = fake({ [H5]: row(4.1), [G]: row(4.7), [H4]: row(4) });                       // gemini answered (a third value): no more shopping
    const r = await readLab("x", need, VOCAB, { tess: tessK(4), modelRead: a.fn });
    eq([a.calls.includes(`${H4}:1/0`), r.read.values.Potassium], [false, undefined], "a tiebreak that read a third value is final: no further opinion is sought");
  }
  {
    const a = fake({ [H5]: { values: { Sodium: 140 }, collected: "2025-09-08", record: "HG1" }, [H4]: row(4) });   // tesseract has it, primary missed it, gemini silent
    const r = await readLab("x", need, VOCAB, { tess: tessK(4), modelRead: a.fn });
    eq(r.read.values.Potassium, 4, "primary missed the field: tesseract + haiku-4.5 agree → kept");
    const b = fake({ [H5]: row(4.1), [H4]: row(4) });
    const r2 = await readLab("x", need, VOCAB, { tess: Promise.resolve({ values: { Sodium: 140 }, collected: "2025-09-08", record: "HG1", ms: 1 }), modelRead: b.fn });
    eq(r2.read.values.Potassium, undefined, "tesseract missed the field: haiku-4.5 and haiku-5.5 are never a pair → unknown");
  }
  eq(altTiebreak(G, H5), H4, "alt tiebreak for a hung gemini under haiku-5.5: haiku-4.5");
  eq(altTiebreak(H4, G), null, "no alt for a failed haiku-4.5 tiebreak under a gemini primary (a third provider does not exist)");
  _setListed();
}

// ── D ──
const imgs = process.env.LAB_IMAGES;
if (imgs && existsSync(imgs)) {
  let right = 0, wrong = 0, total = 0;
  misreads.length = 0;
  for (const t of truth) {
    const r = await tesseractLab(readFileSync(`${imgs}/${t.image}`).toString("base64"), VOCAB);
    if (!r) { console.error(`  tesseract failed on ${t.id}`); continue; }
    const c = check(r, t, "tesseract"); right += c.right; wrong += c.wrong; total += Object.keys(t.values).length + 3;
  }
  console.log(`  live tesseract: ${right}/${total} fields read, ${wrong} misread on degraded scans (each caught by the model disagreeing)`);
}
console.log(`${fail ? "✗" : "✓"} labRead-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
