/**
 * Exact numbers (bigint rationals) and calendar arithmetic for the solver executor. Leaf module.
 * Dates are ISO `YYYY-MM-DD` strings, computed in UTC (no time zones, no DST).
 */
export class Q {
  constructor(readonly n: bigint, readonly d: bigint = 1n) {
    if (d === 0n) throw new Error("division by zero");
    if (d < 0n) { this.n = -n; this.d = -d; }
    const g = gcd(this.n < 0n ? -this.n : this.n, this.d);
    if (g > 1n) { this.n /= g; this.d /= g; }
  }
  static parse(x: unknown): Q | null {
    if (x instanceof Q) return x;
    if (typeof x === "number") { if (!Number.isFinite(x)) return null; x = String(x); }
    if (typeof x === "bigint") return new Q(x);
    if (typeof x !== "string") return null;
    const s = x.trim().replace(/^\$/, "").replace(/,(?=\d{3}\b)/g, "");
    const m = s.match(/^([+-])?(\d*)(?:\.(\d+))?$/); if (!m || (!m[2] && !m[3])) return null;
    const frac = m[3] ?? ""; const n = BigInt((m[2] || "0") + frac) * (m[1] === "-" ? -1n : 1n);
    return new Q(n, 10n ** BigInt(frac.length));
  }
  add(o: Q) { return new Q(this.n * o.d + o.n * this.d, this.d * o.d); }
  sub(o: Q) { return new Q(this.n * o.d - o.n * this.d, this.d * o.d); }
  mul(o: Q) { return new Q(this.n * o.n, this.d * o.d); }
  div(o: Q) { if (o.n === 0n) throw new Error("division by zero"); return new Q(this.n * o.d, this.d * o.n); }
  abs() { return this.n < 0n ? new Q(-this.n, this.d) : this; }
  cmp(o: Q) { const l = this.n * o.d, r = o.n * this.d; return l < r ? -1 : l > r ? 1 : 0; }
  isInt() { return this.d === 1n; }
  /** Exact fixed-point string; null when it isn't exactly representable with `dp` places. */
  fixed(dp: number): string | null {
    const scale = 10n ** BigInt(dp); const num = this.n * scale;
    if (num % this.d !== 0n) return null;
    let v = num / this.d; const neg = v < 0n; if (neg) v = -v;
    let s = v.toString().padStart(dp + 1, "0");
    if (dp) s = s.slice(0, -dp) + "." + s.slice(-dp);
    return (neg ? "-" : "") + s;
  }
  toString() { for (let dp = 0; dp <= 12; dp++) { const f = this.fixed(dp); if (f !== null) return f; } return `${this.n}/${this.d}`; }
}
function gcd(a: bigint, b: bigint): bigint { while (b) [a, b] = [b, a % b]; return a || 1n; }

export const isISO = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z")) && new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s;
const toD = (s: string) => { if (!isISO(s)) throw new Error("not a date: " + s); return new Date(s + "T00:00:00Z"); };
const iso = (d: Date) => d.toISOString().slice(0, 10);
const dim = (y: number, m0: number) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();

export function addDays(s: string, n: number): string { const d = toD(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); }
/** Same day n months later; a missing day → that month's last day. */
export function addMonths(s: string, n: number): string {
  const d = toD(s); const t = d.getUTCMonth() + n; const y = d.getUTCFullYear() + Math.floor(t / 12); const m = ((t % 12) + 12) % 12;
  return iso(new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), dim(y, m)))));
}
/** n years later (n may be negative); Feb 29 in a non-leap target → Feb 28 (default) or Mar 1. */
export function addYears(s: string, n: number, feb29: "feb28" | "mar1" = "feb28"): string {
  const d = toD(s); const y = d.getUTCFullYear() + n, m = d.getUTCMonth(), day = d.getUTCDate();
  if (m === 1 && day === 29 && dim(y, 1) === 28) return feb29 === "mar1" ? `${y}-03-01` : `${y}-02-28`;
  return iso(new Date(Date.UTC(y, m, day)));
}
export function daysBetween(a: string, b: string): number { return Math.round((toD(b).getTime() - toD(a).getTime()) / 86400000); }
/** Whole years on `on`; a Feb 29 birthday ages on Mar 1 in common years. */
export function ageOn(dob: string, on: string): number {
  const b = toD(dob), o = toD(on); let a = o.getUTCFullYear() - b.getUTCFullYear();
  const bm = b.getUTCMonth(), bd = b.getUTCDate(), om = o.getUTCMonth(), od = o.getUTCDate();
  if (om < bm || (om === bm && od < bd)) a--;
  return a;
}
/** 1 = Monday … 7 = Sunday. */
export function weekday(s: string): number { const w = toD(s).getUTCDay(); return w === 0 ? 7 : w; }
export function isOpen(s: string, closed: Iterable<string>, weekends = true): boolean {
  if (weekends && weekday(s) >= 6) return false;
  for (const c of closed) if (c === s) return false;
  return true;
}
/** Open days in (after, through]. */
export function businessDaysBetween(after: string, through: string, closed: string[]): number {
  let n = 0; for (let d = addDays(after, 1); d <= through; d = addDays(d, 1)) if (isOpen(d, closed)) n++;
  return n;
}
/** The n-th open day after `s` (n ≥ 1), or `s` itself moved to the next open day for n = 0. */
export function addBusinessDays(s: string, n: number, closed: string[]): string {
  let d = s, k = 0; if (n <= 0) { while (!isOpen(d, closed)) d = addDays(d, 1); return d; }
  for (let i = 0; i < 4000; i++) { d = addDays(d, 1); if (isOpen(d, closed) && ++k === n) return d; }
  throw new Error("addBusinessDays: no open day");
}
/** The open day on or before `s`. */
export function prevOpenDay(s: string, closed: string[]): string {
  let d = s; for (let i = 0; i < 4000; i++) { if (isOpen(d, closed)) return d; d = addDays(d, -1); }
  throw new Error("prevOpenDay: no open day");
}
