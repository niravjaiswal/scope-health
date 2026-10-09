/**
 * Good-faith-estimate due-date engine (family `good-faith-estimate`). PURE over a GoodFaithContext a
 * live reader supplies; returns the due date `YYYY-MM-DD`, `NOT_REQUIRED:INSURED`,
 * `NOT_REQUIRED:SHORT_NOTICE`, or null (→ skip). Business-day rule per the front-desk supervisor's
 * message. Proven offline: `npx tsx src/wrenfield/goodFaith.ts`.
 *
 * Never-wrong: the reader decides `owedEstimate` (Insurance section "No insurance on file", or a
 * self-pay note naming THIS appointment's date), the scheduling date (Booking panel booked date, or
 * the most recent "Start time moved" in History), and the appointment's location closures (clinic
 * calendar Active entries for all/this location). Any of those unreadable → it returns null first.
 */

export interface GoodFaithContext {
  owedEstimate: boolean;        // true = uninsured or self-pay for this visit; false = insured
  schedulingDateISO: string;    // booking date, or most-recent start-time-move date
  apptDateISO: string;
  closuresISO: string[];        // dates the appointment's location is closed (Active, all/this location)
  /** Business-day bands from the governing message (parseGoodFaithPolicy). Default = the Set 1 rule. */
  bands?: Array<{ min: number; max: number; due: "short" | number }>;
}
const DEFAULT_BANDS: NonNullable<GoodFaithContext["bands"]> = [{ min: 0, max: 2, due: "short" }, { min: 3, max: 9, due: 1 }, { min: 10, max: Infinity, due: 3 }];

const toUTC = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const isoOf = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => { const d = toUTC(iso); d.setUTCDate(d.getUTCDate() + n); return isoOf(d); };

export function decideGoodFaith(c: GoodFaithContext): string | null {
  if (!c.owedEstimate) return "NOT_REQUIRED:INSURED";
  const closed = new Set(c.closuresISO);
  const isBusiness = (iso: string) => { const dow = toUTC(iso).getUTCDay(); return dow >= 1 && dow <= 5 && !closed.has(iso); };

  // Business days AFTER the scheduling date, up to and including the appointment date.
  let count = 0;
  for (let d = addDays(c.schedulingDateISO, 1); d <= c.apptDateISO; d = addDays(d, 1)) if (isBusiness(d)) count++;
  const band = (c.bands ?? DEFAULT_BANDS).find((b) => count >= b.min && count <= b.max);
  if (!band) return null;
  if (band.due === "short") return "NOT_REQUIRED:SHORT_NOTICE";

  // nth business day strictly after the scheduling date (Set 1: 3–9 bd → 1st; 10+ bd → 3rd).
  const nth = band.due;
  if (nth > count) return null;
  let seen = 0;
  for (let d = addDays(c.schedulingDateISO, 1); ; d = addDays(d, 1)) {
    if (isBusiness(d)) { seen++; if (seen === nth) return d; }
    if (d > c.apptDateISO) return null; // safety: shouldn't happen given count≥3
  }
}

// ── self-check ──
if (process.argv[1]?.endsWith("goodFaith.ts")) {
  const assert = (got: string | null, want: string | null, m: string) => { if (got !== want) { console.error(`✗ ${m}: got ${got}, want ${want}`); process.exit(1); } console.log("✓ " + m); };
  const base = (o: Partial<GoodFaithContext>): GoodFaithContext => ({ owedEstimate: true, schedulingDateISO: "2026-03-02", apptDateISO: "2026-03-05", closuresISO: [], ...o });

  assert(decideGoodFaith(base({ owedEstimate: false })), "NOT_REQUIRED:INSURED", "insured → not required");
  // booked Mon 03-02 for Thu 03-05, no closures: 3 bd → first business day after = Tue 03-03
  assert(decideGoodFaith(base({})), "2026-03-03", "3 bd → first business day after scheduling date");
  // same but Tue 03-03 is an Active closure: 2 bd → short notice
  assert(decideGoodFaith(base({ closuresISO: ["2026-03-03"] })), "NOT_REQUIRED:SHORT_NOTICE", "closure drops it to 2 bd → short notice");
  // booked Fri 03-06 for Fri 03-20, no closures: 10 bd → third business day after = Wed 03-11
  assert(decideGoodFaith(base({ schedulingDateISO: "2026-03-06", apptDateISO: "2026-03-20" })), "2026-03-11", "10 bd → third business day after");
  // the message's main example: booked 2025-03-14 for 2025-04-04, 15 bd → third bd after = 2025-03-19
  assert(decideGoodFaith(base({ schedulingDateISO: "2025-03-14", apptDateISO: "2025-04-04" })), "2025-03-19", "worked example → 2025-03-19");
  // 0 business days (appt is the next day, a weekend) → short notice
  assert(decideGoodFaith(base({ schedulingDateISO: "2026-03-06", apptDateISO: "2026-03-07" })), "NOT_REQUIRED:SHORT_NOTICE", "Fri→Sat only → 0 bd → short notice");
  // first business day after must skip a closure: booked Fri 03-06, Tue 03-10 is the 3rd bd but if Mon 03-09 closed, 1st bd = Tue 03-10
  assert(decideGoodFaith(base({ schedulingDateISO: "2026-03-06", apptDateISO: "2026-03-13", closuresISO: ["2026-03-09"] })), "2026-03-10", "first business day after skips a Monday closure");
  console.log("ALL PASS");
}
