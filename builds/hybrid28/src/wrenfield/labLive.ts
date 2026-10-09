/**
 * lab-report-triage live reader: chart context + report values for labTriage.triageLab. Reads numbers
 * only; the engine decides. Anything not corroborated → null + why (the solver skips; never-wrong).
 *
 * Speed (the 158 run spent ~16.5 s per answered lab task, 90 % of it waiting on 3 sequential vision
 * calls per report):
 *  - one report = tesseract (local) ∥ ONE gemini call; a haiku tiebreak only for fields that disagree
 *    (labRead.ts);
 *  - while the model call is in flight the main tab reads the problem list and the side tab downloads
 *    the other same-panel reports, whose tesseract runs locally (no proxy slot);
 *  - the previous report is read only when it can change the answer: the engine is run with the
 *    previous "unknown" first — a critical result, a panel without change-rule tests, or every
 *    change-rule test already out of range gives the final answer without it. Candidates whose
 *    RECEIVED date is before the change-rule window are provably outside it (collected ≤ received)
 *    and are not read. A needed candidate is asked only for the change-rule tests + collected /
 *    report / record numbers.
 *  - the misfiled-report check (the asked report prints a record number that every other report in
 *    the chart disagrees with) uses the other reports' record numbers: tesseract's reading when it
 *    equals the asked report's corroborated number, else a corroborated (tesseract + model) read.
 */
import type { LabRule, LabPatient, CandidateReport } from "./labTriage.js";
import { readLab as readLabReal, tesseractLab as tessReal, type LabRead, type LabNeed } from "./labRead.js";
import { why } from "./why.js";

export interface LabDoc { title?: string; kind?: string; receivedISO?: string; docHref?: string }
export interface LabPatientRec { id: string; dobISO: string; demographics?: any; documents: LabDoc[]; /** the chart's record number (MRN), when the chart shows one */ mrn?: string }
export interface LabLiveDeps {
  /** resolved patient (after ensurePatient) or null, plus the resolver's decline reason */
  patient: (name: string, dob?: string, about?: { panel: string; receivedISO: string }) => Promise<{ pat: LabPatientRec | null; resolveWhy?: string }>;
  /** report image (base64 PNG) on the main tab / the side tab (side may fall back to main) */
  image: (href: string, tab: "main" | "side") => Promise<string | null>;
  /** problem-list condition names (complete read) → T2DM, or "unknown" */
  t2dm: (patId: string) => Promise<boolean | "unknown">;
  readLab?: typeof readLabReal;
  tesseractLab?: typeof tessReal;
  diag?: (rec: Record<string, unknown>) => void;
  /** Start the model read of every other same-panel report that is certainly inside the change-rule window while the
   *  asked report's own read is in flight (the same call, with the same fields, the later step would make), instead of
   *  after it: a needed previous report then costs ~0.3 s instead of a second model round trip (~2.2 s; 25 of Set 1's 45
   *  lab tasks in run 265). Cost: one extra ~$0.0006 call when the asked report alone decides the answer. */
  speculate?: boolean;
}
export type LabCtx = { report: { panel: string; values: Record<string, number> }; patient: LabPatient; prev: Record<string, number> | "none" | "unknown" };

const pnl = (s: string) => (s || "").toLowerCase().replace(/[^a-z]/g, "");
const nrm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const MAX_OTHERS = 6; // more same-panel reports than this → previous "unknown" (never silently drop one)

export function labLive(deps: LabLiveDeps) {
  const readLab = deps.readLab ?? readLabReal, tesseractLab = deps.tesseractLab ?? tessReal;
  const diag = deps.diag ?? (() => {});
  return async (name: string, dob: string | undefined, panel: string, receivedISO: string, rule?: LabRule): Promise<LabCtx | null> => {
    const L = await import("./labTriage.js");
    const t0 = Date.now(); const ms: Record<string, number> = {};
    if (!rule) { why("lab: no limits table passed to the reader"); return null; }
    const pr = rule.panels.get(nrm(panel));
    if (!pr) { why(`lab: no limits table for "${panel}"`); return null; }
    const vocab = [...new Set([...rule.panels.values()].flatMap((p) => p.tests.map((t) => t.test)))];
    const panelTests = pr.tests.map((t) => t.test);
    const changeTests = pr.tests.filter((t) => t.changePct !== undefined).map((t) => t.test);

    const { pat, resolveWhy } = await deps.patient(name, dob, { panel, receivedISO });
    if (!pat) { why(`lab: patient not resolved${resolveWhy ? ` (${resolveWhy})` : ""}`); return null; }
    ms.patient = Date.now() - t0;
    // Reports of THIS panel: the title is the panel (after a "Lab report:" lead), not merely contains it.
    const sameP = (pat.documents || []).filter((d) => /lab report/i.test(d.kind || "") && d.docHref && pnl((d.title || "").replace(/^\s*lab report\s*[:\-–—]?\s*/i, "")) === pnl(panel));
    const askedAll = sameP.filter((d) => d.receivedISO === receivedISO);
    if (askedAll.length !== 1) { why(askedAll.length ? `lab: ${askedAll.length} ${panel} reports received that date` : "lab: report document not found for that received date"); return null; }
    const asked = askedAll[0];
    const others = sameP.filter((d) => d !== asked);

    let t1 = Date.now();
    const png = await deps.image(asked.docHref!, "main");
    ms.image = Date.now() - t1;
    if (!png) { why("lab: report image not captured"); return null; }

    // ── overlapped work while the asked report's model call is in flight ──
    // side tab: download the other same-panel reports one by one; their tesseract runs after the asked
    // report's (one OCR process at a time keeps the CPU for the asked read and Chrome).
    const askedTess = tesseractLab(png, vocab).catch(() => null);
    const otherImg = new Map<LabDoc, Promise<string | null>>();
    const otherTess = new Map<LabDoc, Promise<(LabRead & { ms: number }) | null>>();
    if (others.length <= MAX_OTHERS) {
      let chainImg: Promise<unknown> = Promise.resolve();
      let chainTess: Promise<unknown> = askedTess;
      for (const o of others) {
        const ip = chainImg.then(() => deps.image(o.docHref!, "side")).catch(() => null);
        chainImg = ip; otherImg.set(o, ip);
        const tp = Promise.all([ip, chainTess]).then(([b]) => (b ? tesseractLab(b, vocab) : null)).catch(() => null);
        chainTess = tp; otherTess.set(o, tp);
      }
    }
    const readCandidate = async (o: LabDoc, need: LabNeed): Promise<LabRead | null> => {
      const b = await (otherImg.get(o) ?? deps.image(o.docHref!, "side")); if (!b) return null;
      const r = await readLab(b, need, vocab, { tess: otherTess.get(o) ?? tesseractLab(b, vocab).catch(() => null) });
      return r.read;
    };
    const candNeed: LabNeed = { tests: changeTests, meta: ["collected", "report", "record"] };
    /** a candidate read started now; its failure is raised where it is awaited, never as an unhandled rejection */
    const begin = (o: LabDoc, need: LabNeed) => { const p = readCandidate(o, need); p.catch(() => {}); return p; };
    // Speculative reads (deps.speculate): a report received on/after the window start of the day the asked report was
    // received is inside the window whatever its collected date is (collected ≤ received, windowStart is monotone), so the
    // later step will read exactly this one, with exactly these fields — start it now, beside the asked report's own read.
    const spec = new Map<LabDoc, Promise<LabRead | null>>();
    if (deps.speculate && changeTests.length && others.length <= MAX_OTHERS) {
      const sure = L.windowStart(receivedISO);
      for (const o of others) if (!/^\d{4}-\d{2}-\d{2}$/.test(o.receivedISO || "") || o.receivedISO! >= sure) spec.set(o, begin(o, candNeed));
    }
    // every exit waits for the side-tab work, so none of it runs into the next task's page reads
    try {
    t1 = Date.now();
    const [askedR, hasT2DM] = await Promise.all([
      readLab(png, { tests: panelTests, meta: ["collected", "report", "record"], allRows: true }, vocab, { tess: askedTess }),
      deps.t2dm(pat.id).catch(() => "unknown" as const),
    ]);
    ms.read = Date.now() - t1;
    const read = askedR.read;
    const missing = panelTests.filter((t) => read.values[t] === undefined);
    if (missing.length) { why(`lab: report values not corroborated (${missing.join(", ")})`); diag({ step: "lab", ms, trace: askedR.trace }); return null; }
    // Age is on the COLLECTED date printed on the report — never substitute the received date.
    if (!read.collected) { why("lab: collected date not read from the report"); return null; }
    if (read.collected > receivedISO) { why(`lab: report collected ${read.collected} after received ${receivedISO}`); return null; }
    const collected = read.collected;
    // Misfiled: the policy uses only reports printing THIS chart's record number. When the chart shows its
    // number and the report's (corroborated) number differs, the asked report is ignored → nothing to answer.
    const chartRec = (pat.mrn || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const repRec = (read.record || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (chartRec && repRec && chartRec !== repRec) { why(`lab: the report prints record ${read.record}, the chart is ${pat.mrn} (misfiled)`); return null; }
    const sexRaw = String(pat.demographics?.sex || "").trim();
    // Neither Female nor Male on the chart → "Other" (either range). Unread → "Unknown" (skip if it matters).
    const sex: LabPatient["sex"] = /^female$/i.test(sexRaw) ? "Female" : /^male$/i.test(sexRaw) ? "Male" : /^[A-Za-z][A-Za-z -]{0,30}$/.test(sexRaw) ? "Other" : "Unknown";
    const age = L.ageOn(pat.dobISO, collected);
    if (age === undefined) { why("lab: could not compute age at collection"); return null; }
    const patient: LabPatient = { sex, ageAtCollection: age, hasT2DM };
    const report = { panel, values: read.values };

    // ── corroborated record numbers of the other reports (misfiled check) ──
    const full = new Map<LabDoc, LabRead | null>(); // full candidate reads, shared with the previous-report step
    const mine = read.record;
    let recordChecked = false;
    const misfiled = async (): Promise<boolean> => {
      recordChecked = true;
      if (others.length < 2 || others.length > MAX_OTHERS || !mine) return false;
      const recs: Array<string | undefined> = [];
      for (const o of others) {
        const tr = await (otherTess.get(o) ?? Promise.resolve(null));
        if (tr?.record && tr.record === mine) { recs.push(mine); continue; }      // tesseract reads the asked number
        const f = full.get(o) ?? await (spec.get(o) ?? readCandidate(o, { tests: [], meta: ["record"] }));
        recs.push(f?.record);
      }
      const set = new Set(recs.filter(Boolean));
      return recs.every(Boolean) && set.size === 1 && !set.has(mine);
    };

    // ── the previous report, only if it can change the answer ──
    // Not needed → "unknown": the engine already gave an answer with "unknown", which no previous
    // report can change (and were that ever not so, the engine would skip, not guess).
    let prev: LabCtx["prev"] = "unknown"; let prevNote = "not needed";
    const without = L.triageLab(rule, report, patient, "unknown");
    if (without === null && !others.length) { prev = "none"; prevNote = "needed: no other report"; }
    else if (without === null) {
      const start = L.windowStart(collected);
      // collected ≤ received, so a report RECEIVED before the window start was collected before it too
      const inWin = others.filter((o) => !/^\d{4}-\d{2}-\d{2}$/.test(o.receivedISO || "") || o.receivedISO! >= start);
      prevNote = `needed: ${inWin.length}/${others.length} in window`;
      if (!inWin.length) prev = "none";
      else if (inWin.length > MAX_OTHERS) prev = "unknown";
      else {
        const cand: CandidateReport[] = []; let failed = false;
        // with speculation every candidate read is started at once (the sure ones already are), in window order
        const pending = deps.speculate ? inWin.map((o) => spec.get(o) ?? begin(o, candNeed)) : [];
        for (const [i, o] of inWin.entries()) {
          const r = await (pending[i] ?? readCandidate(o, candNeed));
          full.set(o, r);
          if (!r) { failed = true; break; }
          cand.push({ collected: r.collected, report: r.report, record: r.record, values: r.values });
        }
        if (!failed) {
          if (await misfiled()) { why("lab: the asked report prints a record number no other report in the chart has"); return null; }
          prev = L.pickPrevious({ collected, report: read.report, record: read.record }, cand, chartRec || undefined);
        }
      }
    }
    if (!recordChecked && await misfiled()) { why("lab: the asked report prints a record number no other report in the chart has"); return null; }
    ms.total = Date.now() - t0;
    diag({ step: "lab", ms, record: read.record ?? null, chartRecord: pat.mrn ?? null, others: others.length, prev: typeof prev === "string" ? prev : "values", prevNote, tiebreak: askedR.trace.tiebreak, open: askedR.trace.disagreed.length || undefined, modelMs: askedR.trace.modelMs, tessMs: askedR.trace.tessMs, agreed1: askedR.trace.agreed1, agreedTb: askedR.trace.agreedTb, primary: askedR.trace.primary, retries: askedR.trace.retries });
    return { report, patient, prev };
    } finally { await Promise.all([...otherTess.values()]).catch(() => {}); }
  };
}

/** Problem list by LABEL: the condition-name column of the problem table (raw text; the code
 *  column's digits are in the obfuscation font). Row count must match the "N conditions" footer. */
export async function readT2DM(crawler: { navTo(p: string, m: RegExp, t?: number): Promise<boolean>; evalApp<T>(e: string): Promise<T> }, patId: string): Promise<boolean | "unknown"> {
  const L = await import("./labTriage.js");
  try {
    if (await crawler.navTo(`${patId}/problems`, /problem list|Condition|No (?:problems|conditions)/i, 7000)) {
      const pl = await crawler.evalApp<{ rows: string[] | null; text: string }>(`const t=[...doc.querySelectorAll('table')].find(x=>[...x.querySelectorAll('th')].some(h=>/condition|problem|diagnos/i.test(h.innerText||''))); const txt=(doc.body&&doc.body.innerText)||''; if(!t) return {rows:null,text:txt}; const hs=[...t.querySelectorAll('th')].map(h=>(h.innerText||'').trim()); const ci=hs.findIndex(h=>/condition|problem|diagnos/i.test(h)); return {rows:[...t.querySelectorAll('tbody tr')].map(tr=>{const c=[...tr.querySelectorAll('td,th')]; return ((c[ci]||{}).innerText||'').trim();}), text:txt};`);
      const count = pl.text.match(/(\d+)\s+(?:conditions?|problems?)\b/i);
      if (pl.rows && count && Number(count[1]) === pl.rows.length) return L.problemListHasT2DM(pl.rows);
      if (!pl.rows && /No (?:problems|conditions|active problems)/i.test(pl.text)) return false;
    }
  } catch {}
  return "unknown";
}
