/**
 * Tetanus wound-management decision engine (family `tetanus-wound`). PURE over a TetanusContext a
 * live reader supplies; returns `<ACTION>:<count>:<last>` / `NO_WOUND_VISIT`, or null (→ skip).
 * The CDC table + "years old" boundary are exactly as the urgent-care charge nurse's message writes
 * them. Proven offline: `npx tsx src/wrenfield/tetanusWound.ts`.
 *
 * Never-wrong: the reader does the hard part (confirm a Triage: note on the visit date, classify the
 * wound from it, and count documented doses across immunization entries / outside records / given-here
 * notes). If it can't do any of that confidently it returns null BEFORE calling this — a wrong dose
 * count or wound class here is a wrong answer.
 */

export interface TetanusContext {
  visitDateISO: string;
  woundVisit: boolean;                 // a Triage: note exists on the visit date
  woundClass: "clean" | "other";       // clean-and-minor vs any-other (contaminated/puncture/avulsion/…)
  doseDatesISO: string[];              // documented tetanus dose dates (deduped), any order
}

const toUTC = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const isoOf = (d: Date) => d.toISOString().slice(0, 10);

/** The date N years before the visit, per the message: same month/day N years earlier; if the visit
 *  is Feb 29, use Mar 1 of the earlier year. A dose on this date or earlier is "N or more years old". */
export function yearsCutoff(visitISO: string, n: number): string {
  const [y, m, d] = visitISO.split("-").map(Number);
  if (m === 2 && d === 29) return `${y - n}-03-01`;
  return isoOf(new Date(Date.UTC(y - n, m - 1, d)));
}

/** Thresholds of the decision table; the defaults are the Set 1 message's. Callers pass the ones
 *  parsed from the governing message (immunizations.ts parseTetanusRule). */
export type TetanusThresholds = { lowMax: number; cleanYears: number; otherYears: number };
export function decideTetanus(c: TetanusContext, t: TetanusThresholds = { lowMax: 2, cleanYears: 10, otherYears: 5 }): string | null {
  if (!c.woundVisit) return "NO_WOUND_VISIT";
  // Count only doses strictly before the visit date; dedupe identical dates (same dose filed twice).
  const doses = [...new Set(c.doseDatesISO.filter((d) => d < c.visitDateISO))].sort();
  const count = doses.length;
  const last = count ? doses[count - 1] : null;
  const lastStr = last ?? "NONE";

  let action: "VACCINE" | "VACCINE_AND_TIG" | "NONE";
  if (count <= t.lowMax) {
    action = c.woundClass === "clean" ? "VACCINE" : "VACCINE_AND_TIG";
  } else {
    const threshold = c.woundClass === "clean" ? t.cleanYears : t.otherYears;
    const cutoff = yearsCutoff(c.visitDateISO, threshold);
    action = last! <= cutoff ? "VACCINE" : "NONE";  // last dose that old (or older) → due; otherwise none
  }
  return `${action}:${count}:${lastStr}`;
}

// ── self-check ──
if (process.argv[1]?.endsWith("tetanusWound.ts")) {
  const assert = (got: string | null, want: string | null, m: string) => { if (got !== want) { console.error(`✗ ${m}: got ${got}, want ${want}`); process.exit(1); } console.log("✓ " + m); };
  const base = (o: Partial<TetanusContext>): TetanusContext => ({ visitDateISO: "2025-02-08", woundVisit: true, woundClass: "other", doseDatesISO: [], ...o });

  // the message's worked example
  assert(decideTetanus(base({ doseDatesISO: ["1999-02-24", "1999-04-24", "1999-06-13", "2013-01-14"] })), "VACCINE:4:2013-01-14", "worked example: 4 doses, last 5+ y before, dirty → VACCINE");
  // no wound visit
  assert(decideTetanus(base({ woundVisit: false })), "NO_WOUND_VISIT", "no triage note → NO_WOUND_VISIT");
  // 0 doses: clean → VACCINE, dirty → VACCINE_AND_TIG
  assert(decideTetanus(base({ woundClass: "clean", doseDatesISO: [] })), "VACCINE:0:NONE", "0 doses clean → VACCINE:0:NONE");
  assert(decideTetanus(base({ woundClass: "other", doseDatesISO: [] })), "VACCINE_AND_TIG:0:NONE", "0 doses dirty → VACCINE_AND_TIG");
  // 2 doses dirty → VACCINE_AND_TIG (still < 3)
  assert(decideTetanus(base({ woundClass: "other", doseDatesISO: ["2020-01-01", "2021-01-01"] })), "VACCINE_AND_TIG:2:2021-01-01", "2 doses dirty → TIG");
  // 3+ doses dirty, last exactly 5 y before (boundary = still 5y old → VACCINE)
  assert(decideTetanus(base({ visitDateISO: "2026-05-10", woundClass: "other", doseDatesISO: ["2000-01-01", "2001-01-01", "2021-05-10"] })), "VACCINE:3:2021-05-10", "dirty, last exactly 5y → VACCINE");
  // 3+ doses dirty, last one day short of 5 y → NONE
  assert(decideTetanus(base({ visitDateISO: "2026-05-10", woundClass: "other", doseDatesISO: ["2000-01-01", "2001-01-01", "2021-05-11"] })), "NONE:3:2021-05-11", "dirty, last <5y → NONE");
  // 3+ doses clean, last exactly 10 y → VACCINE; 9y → NONE
  assert(decideTetanus(base({ visitDateISO: "2026-05-10", woundClass: "clean", doseDatesISO: ["2000-01-01", "2001-01-01", "2016-05-10"] })), "VACCINE:3:2016-05-10", "clean, last exactly 10y → VACCINE");
  assert(decideTetanus(base({ visitDateISO: "2026-05-10", woundClass: "clean", doseDatesISO: ["2000-01-01", "2001-01-01", "2016-05-11"] })), "NONE:3:2016-05-11", "clean, last <10y → NONE");
  // a dose ON the visit date doesn't count
  assert(decideTetanus(base({ visitDateISO: "2026-05-10", woundClass: "other", doseDatesISO: ["2021-05-10", "2026-05-10"] })), "VACCINE_AND_TIG:1:2021-05-10", "dose on visit day excluded (count 1 → <3, dirty → TIG)");
  // duplicate dates collapse to one dose
  assert(decideTetanus(base({ woundClass: "clean", doseDatesISO: ["2010-01-01", "2010-01-01"] })), "VACCINE:1:2010-01-01", "duplicate dose dates → one dose");
  // Feb 29 visit: count back to Mar 1
  assert(decideTetanus(base({ visitDateISO: "2024-02-29", woundClass: "other", doseDatesISO: ["2000-01-01", "2001-01-01", "2019-03-01"] })), "VACCINE:3:2019-03-01", "Feb 29 visit → cutoff Mar 1 (dose on cutoff → 5y → VACCINE)");
  console.log("ALL PASS");
}
