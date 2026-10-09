/**
 * Filing-deadline decision engine (family `filing-deadline`). PURE over a FilingContext a live reader
 * supplies; returns the exact answer string or null (→ skip). Fully specified by the billing office
 * lead's governing message. Proven offline: `npx tsx src/wrenfield/filingDeadline.ts`.
 *
 * Never-wrong: the reader must identify the not-yet-filed claim (type, billed payer, the relevant
 * remittance dates) and the payer's filing-terms sets. If any of those can't be read confidently the
 * reader returns null BEFORE calling this.
 */

export interface FilingTerms {
  effectiveISO: string;                 // when this set took effect
  originalDays?: number;                // Original limit, in days …
  originalMonths?: number;              // … or in months (exactly one of the two)
  secondaryDays?: number;
  correctedDays?: number;
}
export interface FilingContext {
  todayISO: string;
  type: "Original" | "Secondary" | "Corrected";
  serviceDateISO: string;
  primaryRemitISO: string | null;       // Secondary: date primary payer's remittance arrived (null = not received)
  originalRemitISO: string | null;      // Corrected: date the original claim's remittance arrived
  termsSets: FilingTerms[];             // all filing-terms sets for the billed payer
  /** Billing-office closures from the governing message ("Use this list, not the clinic calendar").
   *  The live path always passes them; the constant below is only the self-check default. */
  officeClosedISO?: string[];
  payer?: string;                       // billed payer (diagnostics / amendment checks)
}

// Self-check default only: the Set 1 message's billing-office holidays. Live answers use ctx.officeClosedISO.
const HOLIDAYS = new Set([
  "2025-11-27", "2025-11-28", "2025-12-25", "2026-01-01", "2026-05-25", "2026-07-03", "2026-09-07",
  "2026-11-26", "2026-11-27", "2026-12-24", "2026-12-25", "2027-01-01", "2027-05-31", "2027-07-05",
  "2027-09-06", "2027-11-25", "2027-11-26", "2027-12-24",
]);

const toUTC = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const iso = (d: Date) => d.toISOString().slice(0, 10);
function addDays(s: string, n: number): string { const d = toUTC(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); }
export function addMonths(s: string, n: number): string {
  const d = toUTC(s); const day = d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay)); return iso(d);
}
const closedOn = (holidays: Set<string>) => (s: string) => { const dow = toUTC(s).getUTCDay(); return dow === 0 || dow === 6 || holidays.has(s); };
function rollBackToOpen(s: string, isClosed: (d: string) => boolean): string { let d = s; for (let i = 0; i < 3650 && isClosed(d); i++) d = addDays(d, -1); return d; }
function daysBetween(a: string, b: string): number { return Math.round((toUTC(b).getTime() - toUTC(a).getTime()) / 86400000); }

/** The filing-terms set in effect on the date of service: the latest effective date on/before it. */
export function termsInEffect(sets: FilingTerms[], dosISO: string): FilingTerms | null {
  const elig = sets.filter((t) => t.effectiveISO <= dosISO).sort((a, b) => (a.effectiveISO < b.effectiveISO ? 1 : -1));
  return elig[0] ?? null;
}

export function decideFiling(c: FilingContext): string | null {
  // Check this first: no terms in effect on the DOS → NO_FILING_TERMS, whatever the type.
  const set = termsInEffect(c.termsSets, c.serviceDateISO);
  if (!set) return "NO_FILING_TERMS";

  let start: string | null;
  let raw: string;
  if (c.type === "Original") {
    start = c.serviceDateISO;
    if (set.originalMonths != null) raw = addMonths(start, set.originalMonths);
    else if (set.originalDays != null) raw = addDays(start, set.originalDays);
    else return null;                               // terms missing the Original limit → skip
  } else if (c.type === "Secondary") {
    if (!c.primaryRemitISO) return "AWAITING_PRIMARY";
    if (set.secondaryDays == null) return null;
    start = c.primaryRemitISO; raw = addDays(start, set.secondaryDays);
  } else { // Corrected
    if (!c.originalRemitISO) return null;            // corrected needs the original claim's remittance date
    if (set.correctedDays == null) return null;
    start = c.originalRemitISO; raw = addDays(start, set.correctedDays);
  }

  const last = rollBackToOpen(raw, closedOn(c.officeClosedISO ? new Set(c.officeClosedISO) : HOLIDAYS)); // earlier open day; never later
  if (last >= c.todayISO) return last;
  return `EXPIRED:${daysBetween(last, c.todayISO)}`;
}

// ── self-check ──
if (process.argv[1]?.endsWith("filingDeadline.ts")) {
  const assert = (got: string | null, want: string | null, m: string) => { if (got !== want) { console.error(`✗ ${m}: got ${got}, want ${want}`); process.exit(1); } console.log("✓ " + m); };
  const base = (o: Partial<FilingContext>): FilingContext => ({ todayISO: "2026-10-14", type: "Original", serviceDateISO: "2026-05-07", primaryRemitISO: null, originalRemitISO: null, termsSets: [{ effectiveISO: "2024-01-01", originalDays: 365, secondaryDays: 90, correctedDays: 180 }], ...o });

  // worked example: Original, DOS 2026-05-07, 365 days → 2027-05-07, open that day
  assert(decideFiling(base({})), "2027-05-07", "worked example: original 365 days");
  // month arithmetic (from the message, before any weekend rollback)
  assert(addMonths("2025-08-31", 6), "2026-02-28", "month clamp: 6mo from Aug 31 → Feb 28");
  assert(addMonths("2025-11-03", 12), "2026-11-03", "month same-day: 12mo");
  // …and the full decision rolls that Feb 28 (a Saturday) back to the open Friday
  assert(decideFiling(base({ serviceDateISO: "2025-08-31", todayISO: "2025-09-01", termsSets: [{ effectiveISO: "2020-01-01", originalMonths: 6 }] })), "2026-02-27", "months result on a Saturday → roll back to Friday");
  // weekend+holiday rollback: 90 days from 2026-04-05 = 2026-07-04 (Sat) → 07-03 is a holiday → 07-02 (Thu)
  assert(decideFiling(base({ serviceDateISO: "2026-04-05", todayISO: "2026-06-01", termsSets: [{ effectiveISO: "2024-01-01", originalDays: 90 }] })), "2026-07-02", "roll back over Sat + holiday");
  // expired: 8 days from 2024-10-01 = 2024-10-09 (open), 735 days before today 2026-10-14
  assert(decideFiling(base({ serviceDateISO: "2024-10-01", termsSets: [{ effectiveISO: "2020-01-01", originalDays: 8 }] })), "EXPIRED:735", "expired → days to today");
  // no terms in effect on DOS
  assert(decideFiling(base({ serviceDateISO: "2023-01-01", termsSets: [{ effectiveISO: "2024-01-01", originalDays: 365 }] })), "NO_FILING_TERMS", "no terms in effect on DOS");
  // pick the set in effect on DOS (latest effective ≤ DOS), not the newest
  assert(decideFiling(base({ serviceDateISO: "2026-05-07", termsSets: [{ effectiveISO: "2024-01-01", originalDays: 365 }, { effectiveISO: "2026-09-01", originalDays: 180 }] })), "2027-05-07", "use the set effective on DOS, not a later one");
  // secondary awaiting primary
  assert(decideFiling(base({ type: "Secondary", primaryRemitISO: null })), "AWAITING_PRIMARY", "secondary with no primary remittance");
  // secondary counted from primary remittance date
  assert(decideFiling(base({ type: "Secondary", primaryRemitISO: "2026-09-10", todayISO: "2026-09-11" })), "2026-12-09", "secondary: 90 days from primary remittance");
  // corrected counted from original remittance date
  assert(decideFiling(base({ type: "Corrected", originalRemitISO: "2026-08-03", todayISO: "2026-08-04" })), "2027-01-29", "corrected: 180 days from original remittance (Sat → Fri)");
  console.log("ALL PASS");
}
