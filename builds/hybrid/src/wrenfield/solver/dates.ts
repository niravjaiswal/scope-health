/**
 * Exact date / money / business-day arithmetic for plans. All dates are ISO "YYYY-MM-DD" strings computed in
 * UTC (no time zone drift); money is integer cents (claimNextStep.parseCents); nothing is floating point.
 * Every parser returns undefined/null on anything it can't read exactly — the caller declines.
 */
import { parseCents, fmtCents } from "../claimNextStep.js";
import { addMonths as addMonthsClamped } from "../filingDeadline.js";

export { parseCents, fmtCents };
const MON: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n: number) => String(n).padStart(2, "0");
export function validISO(s: string): boolean {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/); if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}
/** Any single date the site or a message writes → ISO: "Oct 5, 2026", "Thu, Jan 1, 2026", "October 5, 2026",
 *  "5 October 2026", "2026-10-05", "10/05/2026" (US order), "Oct 5, 2026, 9:00 AM CDT" (date part).
 *  Two dates in the string, or an impossible date → undefined. */
export function parseDate(s: string): string | undefined {
  const t = String(s ?? "").trim(); if (!t) return undefined;
  const found: string[] = [];
  const push = (y: number, m: number, d: number) => { const iso = `${y}-${pad(m)}-${pad(d)}`; if (validISO(iso)) found.push(iso); else found.push("bad"); };
  for (const m of t.matchAll(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/g)) { const mo = MON[m[1].toLowerCase()] ?? MON[m[1].slice(0, 3).toLowerCase()]; if (mo && (m[1].length <= 4 || /^(january|february|march|april|may|june|july|august|september|october|november|december)$/i.test(m[1]))) push(+m[3], mo, +m[2]); }
  for (const m of t.matchAll(/\b(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/g)) { const mo = MON[m[2].toLowerCase()] ?? MON[m[2].slice(0, 3).toLowerCase()]; if (mo) push(+m[3], mo, +m[1]); }
  for (const m of t.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) push(+m[1], +m[2], +m[3]);
  for (const m of t.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) push(+m[3], +m[1], +m[2]);
  const u = [...new Set(found)];
  return u.length === 1 && u[0] !== "bad" ? u[0] : undefined;
}
const toUTC = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const out = (d: Date) => d.toISOString().slice(0, 10);
export function addDays(iso: string, n: number): string { const d = toUTC(iso); d.setUTCDate(d.getUTCDate() + n); return out(d); }
/** Calendar months; the day is clamped to the target month's last day (Jan 31 + 1 month = Feb 28/29). */
export const addMonths = (iso: string, n: number) => addMonthsClamped(iso, n);
export const addYears = (iso: string, n: number) => addMonthsClamped(iso, 12 * n);
/** b − a in days (positive when b is later). */
export function daysBetween(a: string, b: string): number { return Math.round((toUTC(b).getTime() - toUTC(a).getTime()) / 86400000); }
export const dayOfWeek = (iso: string) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][toUTC(iso).getUTCDay()];
export const isWeekend = (iso: string) => { const d = toUTC(iso).getUTCDay(); return d === 0 || d === 6; };
export function monthBounds(iso: string): { first: string; last: string } { const [y, m] = iso.split("-").map(Number); return { first: `${y}-${pad(m)}-01`, last: out(new Date(Date.UTC(y, m, 0))) }; }
export const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export const within = (iso: string, from: string, to: string) => iso >= from && iso <= to;

/** A business-day calendar: weekends closed (unless `weekendsOpen`), plus the given closed dates. The closure
 *  list must come from the governing message or the site's clinic calendar — never a built-in holiday list. */
export type Calendar = { closed: Set<string>; weekendsOpen?: boolean };
export const calendar = (closed: Iterable<string>, weekendsOpen = false): Calendar => ({ closed: new Set(closed), weekendsOpen });
export const isOpen = (iso: string, c: Calendar) => !c.closed.has(iso) && (c.weekendsOpen || !isWeekend(iso));
/** The n-th business day after `iso` (n ≥ 1; `iso` itself not counted). n = 0 → iso. Negative → before. */
export function addBusinessDays(iso: string, n: number, c: Calendar): string {
  let d = iso; const step = n < 0 ? -1 : 1;
  for (let k = 0, guard = 0; k < Math.abs(n); guard++) { if (guard > 4000) throw new Error("addBusinessDays: no open day"); d = addDays(d, step); if (isOpen(d, c)) k++; }
  return d;
}
/** Business days in (a, b] — a excluded, b included; negative when b < a. */
export function businessDaysBetween(a: string, b: string, c: Calendar): number {
  if (a === b) return 0; const s = a < b ? 1 : -1; let n = 0;
  for (let d = a; d !== b;) { d = addDays(d, s); if (isOpen(d, c)) n += s; }
  return n;
}
/** Move a date onto an open day: "earlier" (deadline rolls back) or "later" (rolls forward). */
export function rollToOpen(iso: string, c: Calendar, dir: "earlier" | "later"): string {
  let d = iso; for (let i = 0; i < 4000 && !isOpen(d, c); i++) d = addDays(d, dir === "earlier" ? -1 : 1); return d;
}
/** Age in whole years on `onISO`. */
export function ageOn(dobISO: string, onISO: string): number {
  const [y1, m1, d1] = dobISO.split("-").map(Number), [y2, m2, d2] = onISO.split("-").map(Number);
  return y2 - y1 - (m2 < m1 || (m2 === m1 && d2 < d1) ? 1 : 0);
}
/** Money: "$1,250.50" → 125050 (cents) or null. Sums stay integers. */
export const cents = (s: string) => parseCents(s);
export const sumCents = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
/** Cents → "1250.50" (no $ / commas) or with the site's form "$1,250.50". */
export function money(c: number, style: "plain" | "site" = "plain"): string {
  const p = fmtCents(c); if (style === "plain") return p;
  const [w, f] = p.replace("-", "").split("."); return `${c < 0 ? "-" : ""}$${w.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${f}`;
}
/** Exact percentage of cents (e.g. 10% coinsurance): returns cents only when the result is a whole cent,
 *  unless a rounding rule is given. */
export function percentOf(c: number, pct: string, round?: "half-up" | "down" | "up"): number | null {
  const m = pct.trim().match(/^(\d+)(?:\.(\d{1,4}))?\s*%?$/); if (!m) return null;
  const scale = 10 ** (m[2]?.length ?? 0); const num = c * (Number(m[1]) * scale + Number(m[2] ?? 0)); const den = 100 * scale;
  if (num % den === 0) return num / den;
  if (!round) return null;
  const q = Math.floor(num / den), r = num - q * den;
  return round === "down" ? q : round === "up" ? q + 1 : (2 * r >= den ? q + 1 : q);
}
