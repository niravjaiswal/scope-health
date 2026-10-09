/**
 * Table lookup in a governing message (policyText.tablesIn: markdown tables and bullet "Key: value; …" runs).
 * Columns by header label, rows by exact (normalised) cell match; exactly one row or a decline.
 */
import { tablesIn, type MsgTable } from "../policyText.js";

export type Lookup = { ok: true; value: string; row: string[]; table: MsgTable } | { ok: false; why: string };
const N = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[`*_]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
const asRe = (h: string | RegExp) => (typeof h === "string" ? new RegExp(`^\\s*${h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i") : h);

/** The ONE table in `message` whose headers include every pattern. */
export function findTable(message: string, headers: Array<string | RegExp>): MsgTable | { why: string } {
  const res = headers.map(asRe);
  const hits = tablesIn(message).filter((t) => res.every((re) => t.headers.filter((h) => re.test(h)).length === 1));
  return hits.length === 1 ? hits[0] : { why: hits.length ? `${hits.length} message tables have headers ${headers.join(", ")}` : `no message table with headers ${headers.join(", ")}` };
}
/** Value of column `want` in the one row whose `where` columns equal the given values (normalised text;
 *  a cell listing several values "A, B" or "A / B" matches any of them only when `listCells` is set). */
export function lookup(table: MsgTable, where: Record<string, string>, want: string | RegExp, opts: { listCells?: boolean } = {}): Lookup {
  const col = (h: string | RegExp) => { const re = asRe(h); const i = table.headers.map((x, k) => [x, k] as const).filter(([x]) => re.test(x)); return i.length === 1 ? i[0][1] : i.length ? -2 : -1; };
  const wi = col(want); if (wi < 0) return { ok: false, why: `column ${String(want)}: ${wi === -2 ? "several" : "no"} header matches` };
  const conds: Array<[number, string]> = [];
  for (const [h, v] of Object.entries(where)) { const i = col(h); if (i < 0) return { ok: false, why: `column "${h}": ${i === -2 ? "several" : "no"} header matches` }; conds.push([i, v]); }
  const cellHas = (cell: string, v: string) => N(cell) === N(v) || (!!opts.listCells && cell.split(/\s*(?:,|\/|;|\bor\b)\s*/).some((p) => N(p) === N(v)));
  const rows = table.rows.filter((r) => conds.every(([i, v]) => cellHas(r[i] ?? "", v)));
  if (rows.length !== 1) return { ok: false, why: `${rows.length} rows match ${JSON.stringify(where)}` };
  return { ok: true, value: rows[0][wi] ?? "", row: rows[0], table };
}
/** Threshold band lookup: the one row whose [min, max] (numbers in the cells, "and up"/"or more" open) holds x. */
export function band(table: MsgTable, rangeCol: string | RegExp, x: number, want: string | RegExp): Lookup {
  const re = asRe(rangeCol); const ri = table.headers.findIndex((h) => re.test(h)); if (ri < 0) return { ok: false, why: `no range column ${String(rangeCol)}` };
  const wre = asRe(want); const wi = table.headers.findIndex((h) => wre.test(h)); if (wi < 0) return { ok: false, why: `no column ${String(want)}` };
  const hits = table.rows.filter((r) => {
    const c = (r[ri] ?? "").replace(/,/g, ""); const nums = [...c.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
    if (nums.length === 2) return x >= nums[0] && x <= nums[1];
    if (nums.length === 1 && /\b(and up|or more|\+|at least|over|more than)\b|\d\+/i.test(c)) return /more than|over/i.test(c) ? x > nums[0] : x >= nums[0];
    if (nums.length === 1 && /\b(or (less|fewer)|at most|up to|under|less than)\b/i.test(c)) return /less than|under/i.test(c) ? x < nums[0] : x <= nums[0];
    if (nums.length === 1) return x === nums[0];
    return false;
  });
  if (hits.length !== 1) return { ok: false, why: `${hits.length} bands hold ${x}` };
  return { ok: true, value: hits[0][wi] ?? "", row: hits[0], table };
}
