/**
 * Offline lab-reader benchmark on the practice lab images (real model calls through an
 * OpenAI-compatible endpoint, e.g. OpenRouter). Compares, per report:
 *   OLD  — the 158-run reader: 3 sequential claude-haiku-4.5 prompts, a value kept when ≥ 2 agree;
 *   NEW  — labRead.readLab: tesseract ∥ gemini-3.8-flash, one haiku tiebreak on disagreement.
 * Scored against fixtures/lab-vision/truth.json (gemini ∩ haiku agreement from the vision benchmark).
 *
 *   git archive -o /tmp/v.tar baseline vision ref vision-baseline/fixtures/practice/vision && tar -xf /tmp/v.tar -C /tmp
 *   LLM_BASE_URL=https://openrouter.ai/api/v1 LLM_API_KEY=… npx tsx src/wrenfield/labRead-bench.ts \
 *     --images /tmp/vision-baseline/fixtures/practice/vision [--only new|old] [--out result.json]
 * The key may instead come from --env <file> holding OPENROUTER_API_KEY=… (never printed).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { readLab, tesseractLab, decimal, ident, isoDate, type LabRead } from "./labRead.js";

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const envFile = arg("env");
if (envFile && !process.env.LLM_API_KEY) { const m = readFileSync(envFile, "utf8").match(/OPENROUTER_API_KEY=(\S+)/); if (m) { process.env.LLM_API_KEY = m[1]; process.env.LLM_BASE_URL ??= "https://openrouter.ai/api/v1"; } }
const images = arg("images")!; const only = arg("only"); const out = arg("out");
const truth = JSON.parse(readFileSync(new URL("../../fixtures/lab-vision/truth.json", import.meta.url), "utf8")).reports as Array<{ id: string; title: string; image: string; values: Record<string, string>; collected?: string; report?: string; record?: string; scanned: boolean }>;

// closed vocabulary: every test printed on the practice panels (production uses the message's table)
const VOCAB = ["White blood cell count", "Hemoglobin", "Hematocrit", "Platelet count", "Sodium", "Potassium", "Chloride", "Carbon dioxide", "Blood urea nitrogen", "Creatinine", "Glucose", "Calcium", "Thyroid stimulating hormone", "Free T4", "Total cholesterol", "LDL cholesterol", "HDL cholesterol", "Triglycerides", "Ferritin", "Serum iron", "Transferrin saturation", "25-hydroxyvitamin D", "Hemoglobin A1c", "Alanine aminotransferase", "Aspartate aminotransferase", "Alkaline phosphatase", "Total bilirubin", "Albumin", "Total iron binding capacity", "Iron"];
const nn = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const canon = (k: string) => VOCAB.find((v) => nn(v) === nn(k));

/** The 158-run reader, verbatim prompts and consensus (index-builder.ts before this branch). */
async function oldRead(png: string, panel: string): Promise<LabRead & { ms: number; calls: number }> {
  const { askDocumentJSON } = await import("./llm.js");
  const t0 = Date.now();
  const prompts = [
    `This is a ${panel} lab report. Extract EVERY test with its RESULT value, keyed by the test's full printed name. Also "collected" = specimen collected date, "report" = report number, "record" = medical record number.`,
    `Transcribe the results table of this ${panel} report: one key per test = its result number (full test names). Include collected (date), report (number), record (number).`,
    `For this ${panel} report, read the result column exactly — each test's full name mapped to its numeric result. Also collected date, report number, record number.`,
  ];
  const toNum = (s: unknown) => { const m = String(s ?? "").match(/-?\d+(?:\.\d+)?/); return m ? Number(m[0]) : undefined; };
  const digits = (s: unknown) => String(s ?? "").replace(/\D/g, "");
  const reads: Record<string, string>[] = [];
  for (const p of prompts) { const r = await askDocumentJSON(p, png).catch(() => null); if (r) reads.push(r); }
  if (process.env.DEBUG_OLD) console.log(JSON.stringify(reads));
  const res: LabRead & { ms: number; calls: number } = { values: {}, ms: 0, calls: prompts.length };
  if (reads.length >= 2) for (const k of new Set(reads.flatMap((r) => Object.keys(r)))) {
    const vs = reads.map((r) => r[k]).filter((v) => v != null); if (vs.length < 2) continue;
    if (/^(collected|report|record)$/i.test(k)) { const d = vs.map((v) => /collected/i.test(k) ? (isoDate(String(v)) ?? String(v).trim()) : digits(v)); if (d.every((x) => x === d[0]) && d[0]) (res as any)[k.toLowerCase()] = d[0]; continue; }
    const ns = vs.map(toNum); const c = canon(k); if (c && ns.every((n) => n !== undefined && n === ns[0])) res.values[c] = ns[0]!;
  }
  res.ms = Date.now() - t0; return res;
}

type Score = { right: number; wrong: number; unknown: number; wrongList: string[]; unknownList: string[] };
function score(r: LabRead, t: (typeof truth)[number], metaDigitsOnly = false): Score {
  const s: Score = { right: 0, wrong: 0, unknown: 0, wrongList: [], unknownList: [] };
  const cmp = (f: string, got: string | undefined, want: string | undefined) => { if (want === undefined) return; if (got === undefined) { s.unknown++; s.unknownList.push(f); return; } if (got === want) s.right++; else { s.wrong++; s.wrongList.push(`${f}: got ${got} want ${want}`); } };
  for (const [k, v] of Object.entries(t.values)) { const c = canon(k); if (!c) { s.unknown++; continue; } cmp(c, r.values[c] === undefined ? undefined : String(r.values[c]), String(decimal(v))); }
  cmp("collected", r.collected, isoDate(t.collected));
  const id = (x?: string) => (metaDigitsOnly ? x?.replace(/\D/g, "") : ident(x));
  cmp("report", r.report, id(t.report)); cmp("record", r.record, id(t.record));
  return s;
}

const fs = { new: [] as any[], old: [] as any[] };
const COVERED = /Complete blood count|Basic metabolic panel|Thyroid panel/i;
for (const t of truth.filter((x) => !process.argv.includes("--covered") || COVERED.test(x.title)).slice(0, Number(arg("limit", "999")))) {
  const png = readFileSync(`${images}/${t.image}`).toString("base64");
  const panel = t.title.replace(/^Lab report:\s*/i, "");
  const tests = Object.keys(t.values).map(canon).filter(Boolean) as string[];
  if (only !== "old") {
    const tess = tesseractLab(png, VOCAB);
    const r = await readLab(png, { tests, meta: ["collected", "report", "record"], allRows: true }, VOCAB, { tess });
    const tr = await tess;
    const sc = score(r.read, t);
    const tsc = tr ? score(tr, t) : null;
    fs.new.push({ id: t.id, scanned: t.scanned, ...sc, ms: r.trace.ms, trace: r.trace, tess: tsc && { right: tsc.right, wrong: tsc.wrong, unknown: tsc.unknown, wrongList: tsc.wrongList } });
    console.log(`NEW ${t.id} ${t.scanned ? "scan " : "clean"} right=${sc.right} wrong=${sc.wrong} unknown=${sc.unknown} ms=${r.trace.ms} tess=${r.trace.tessMs} model=${r.trace.modelMs} tb=${r.trace.tiebreak ? r.trace.tiebreakMs : "-"} open=[${r.trace.disagreed.join(",")}] unk=[${r.trace.unknown.join(",")}] ${sc.wrongList.join("; ")}`);
  }
  if (only !== "new") {
    const r = await oldRead(png, panel);
    const sc = score(r, t, true);
    fs.old.push({ id: t.id, scanned: t.scanned, ...sc, ms: r.ms });
    console.log(`OLD ${t.id} ${t.scanned ? "scan " : "clean"} right=${sc.right} wrong=${sc.wrong} unknown=${sc.unknown} ms=${r.ms} unk=[${sc.unknownList.join(",")}] ${sc.wrongList.join("; ")}`);
  }
}
const sum = (xs: any[]) => {
  if (!xs.length) return null;
  const ms = xs.map((x) => x.ms).sort((a, b) => a - b);
  const full = xs.filter((x) => x.unknown === 0 && x.wrong === 0).length;
  return { reports: xs.length, fieldsRight: xs.reduce((a, x) => a + x.right, 0), fieldsWrong: xs.reduce((a, x) => a + x.wrong, 0), fieldsUnknown: xs.reduce((a, x) => a + x.unknown, 0), reportsFullyRead: full, meanMs: Math.round(ms.reduce((a, b) => a + b, 0) / ms.length), medianMs: ms[ms.length >> 1], p90Ms: ms[Math.floor(ms.length * 0.9)], maxMs: ms[ms.length - 1], tiebreaks: xs.filter((x) => x.trace?.tiebreak).length };
};
const summary = { new: sum(fs.new), old: sum(fs.old), tesseractAlone: fs.new.length ? { right: fs.new.reduce((a, x) => a + (x.tess?.right ?? 0), 0), wrong: fs.new.reduce((a, x) => a + (x.tess?.wrong ?? 0), 0), unknown: fs.new.reduce((a, x) => a + (x.tess?.unknown ?? 0), 0) } : null };
console.log(JSON.stringify(summary, null, 1));
if (out) writeFileSync(out, JSON.stringify({ summary, perReport: fs }, null, 1));
