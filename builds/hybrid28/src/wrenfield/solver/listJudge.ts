/**
 * Completeness judge for any list (pure; the live walker in toolkit.ts feeds it one PageRead per step).
 * The same rules apptList.ts proved on appointments, generalised to every entity and footer noun:
 *
 *  - "Showing a to b of N" + Next: every page continues the last (a = rows so far + 1), carries b − a + 1
 *    rows, and the walk ends only when Next is gone/disabled with b = N exact. "N+" or "about N" at the end
 *    → decline (list may be capped), except "about N" within approxTol when the list itself ended.
 *  - "Showing k of [about] N" + Show more: rows already read never change, each press adds rows, ends when
 *    Show more is gone with k = N (exact) or k within approxTol of "about N" (k ≥ N).
 *  - "N <things>" with no pager: rows = N.
 *  - "No … on file / found / yet": 0 rows, proven by the page's own statement.
 *  - No count, no pager, no Show more: accepted only as strength "model" (the site model never saw this
 *    table paged); callers proving ABSENCE (count 0, "no dose", "no claim") must require strength "page".
 *  - "No more results" while rows were still expected → decline (capped).
 */
import type { TableRead, Cell } from "./pageRead.js";

export type Foot = { a: number; b: number; total: number; approx: boolean; plus: boolean; kind: "range" | "cumulative" | "count" | "none" };
const n = (s: string) => Number(s.replace(/,/g, ""));
export function parseFoot(s: string): Foot | undefined {
  const t = (s || "").trim();
  let m = t.match(/^Showing\s+([\d,]+)\s*(?:to|–|-)\s*([\d,]+)\s+of\s+(about\s+)?([\d,]+)(\+)?/i);
  if (m) return { a: n(m[1]), b: n(m[2]), total: n(m[4]), approx: !!m[3], plus: !!m[5], kind: "range" };
  m = t.match(/^Showing\s+([\d,]+)\s+of\s+(about\s+)?([\d,]+)(\+)?/i);
  if (m) return { a: n(m[1]) ? 1 : 0, b: n(m[1]), total: n(m[3]), approx: !!m[2], plus: !!m[4], kind: "cumulative" };
  m = t.match(/^(about\s+)?([\d,]+)\s+[a-z]+$/i);
  if (m) return { a: n(m[2]) ? 1 : 0, b: n(m[2]), total: n(m[2]), approx: !!m[1], plus: false, kind: "count" };
  if (/^No (?!more results)[a-z ]+? (found|yet|on file|on record|recorded|in this chart|on this account)\b/i.test(t)) return { a: 0, b: 0, total: 0, approx: false, plus: false, kind: "none" };
  return undefined;
}
export const approxTol = (total: number) => Math.max(25, Math.ceil(total * 0.05));

export type Strength = "page" | "model";
export type ListProof = { complete: true; strength: Strength; how: string; pages: number; rows: number; total?: number };
export type JudgeState = { rows: Cell[][]; pages: number; mode?: Foot["kind"]; presses: number; lastKeys?: string[] };
export type Verdict =
  | { kind: "continue"; action: "next" | "more" }
  | { kind: "done"; proof: ListProof }
  | { kind: "decline"; why: string };

export const newJudge = (): JudgeState => ({ rows: [], pages: 0, presses: 0 });
const keyOf = (r: string[]) => r.join("\u0001");

/** Feed one rendering of the table (after load, after Next, or after Show more). */
export function judge(st: JudgeState, t: TableRead, opts: { noMore?: boolean; modelSingle?: boolean } = {}): Verdict {
  st.pages++;
  const cells = t.rows.filter((r) => r.some((c) => c.text)); const rows = cells.map((r) => r.map((c) => c.text));
  const foot = t.foot ? parseFoot(t.foot) : undefined;
  if (t.foot && !foot) return { kind: "decline", why: `unreadable list footer "${t.foot}"` };
  const nextOn = t.next.present && !t.next.disabled, moreOn = t.more.present && !t.more.disabled;
  if (opts.noMore && rows.length === 0 && st.rows.length) return { kind: "decline", why: `list capped: "No more results" after ${st.rows.length} rows` };
  if (!foot) {
    if (nextOn || moreOn) return { kind: "decline", why: "the list offers more rows but states no count" };
    if (st.pages > 1) return { kind: "decline", why: "the count footer disappeared while paging" };
    if (!opts.modelSingle) return { kind: "decline", why: "no count footer and the site model has not seen this table unpaged" };
    st.rows = cells;
    return { kind: "done", proof: { complete: true, strength: "model", how: "single table without pager, Show more or count (site model: never paged)", pages: 1, rows: rows.length } };
  }
  if (st.mode && st.mode !== foot.kind) return { kind: "decline", why: `the footer changed form while paging ("${t.foot}")` };
  st.mode = foot.kind;
  if (foot.kind === "none") {
    if (rows.length) return { kind: "decline", why: `"${t.foot}" but ${rows.length} rows are listed` };
    return { kind: "done", proof: { complete: true, strength: "page", how: `the page states "${t.foot}"`, pages: st.pages, rows: 0, total: 0 } };
  }
  if (foot.kind === "count") {
    if (nextOn || moreOn) return { kind: "decline", why: `"${t.foot}" with a pager still offered` };
    if (foot.approx) return { kind: "decline", why: `count is approximate ("${t.foot}")` };
    if (rows.length !== foot.total) return { kind: "decline", why: `${rows.length} rows read, the page states ${foot.total}` };
    st.rows = cells;
    return { kind: "done", proof: { complete: true, strength: "page", how: `rows = the stated count "${t.foot}"`, pages: st.pages, rows: rows.length, total: foot.total } };
  }
  const exact = !foot.approx && !foot.plus;
  if (foot.kind === "range") {
    if (foot.total === 0) { if (rows.length || st.rows.length) return { kind: "decline", why: "empty footer after rows" }; return { kind: "done", proof: { complete: true, strength: "page", how: `"${t.foot}"`, pages: st.pages, rows: 0, total: 0 } }; }
    if (foot.a !== st.rows.length + 1) return { kind: "decline", why: `page ${st.pages} starts at ${foot.a}, expected ${st.rows.length + 1}` };
    if (rows.length !== foot.b - foot.a + 1) return { kind: "decline", why: `page ${st.pages} shows ${rows.length} rows for ${foot.a}–${foot.b}` };
    if (exact && foot.b > foot.total) return { kind: "decline", why: `page ${st.pages} ends past the total` };
    st.rows.push(...cells);
    if (!nextOn) {
      if (opts.noMore) return { kind: "decline", why: `list capped: "No more results" after ${st.rows.length} rows` };
      if (exact && foot.b !== foot.total) return { kind: "decline", why: `no next page but only ${foot.b} of ${foot.total} read` };
      if (foot.plus) return { kind: "decline", why: `no next page at ${foot.b} of ${foot.total}+ (list may be capped)` };
      if (foot.approx && (foot.b < foot.total || foot.b - foot.total > approxTol(foot.total))) return { kind: "decline", why: `no next page at ${foot.b} rows, about ${foot.total} shown (list may be capped)` };
      return { kind: "done", proof: { complete: true, strength: foot.approx ? "model" : "page", how: `${st.pages} page(s) walked with Next, ranges continuous, ${foot.b} of ${foot.approx ? "about " : ""}${foot.total}`, pages: st.pages, rows: st.rows.length, total: foot.total } };
    }
    if (exact && foot.b === foot.total) return { kind: "decline", why: "total reached but the pager still offers Next" };
    if (st.pages > 1500) return { kind: "decline", why: "more than 1500 pages" };
    return { kind: "continue", action: "next" };
  }
  // cumulative (Show more)
  const keys = rows.map(keyOf);
  if (st.lastKeys && st.lastKeys.some((k, i) => keys[i] !== k)) return { kind: "decline", why: `rows already read changed after Show more ${st.presses}` };
  if (st.lastKeys && moreOn && keys.length <= st.lastKeys.length) return { kind: "decline", why: `Show more ${st.presses} added no rows` };
  if (rows.length !== foot.b) return { kind: "decline", why: `${rows.length} rows listed, the footer says ${foot.b}` };
  if (exact && foot.b > foot.total) return { kind: "decline", why: `${foot.b} rows shown for a total of ${foot.total}` };
  st.lastKeys = keys; st.rows = cells;
  if (!moreOn) {
    if (opts.noMore) return { kind: "decline", why: `list capped: "No more results" after ${rows.length} rows` };
    if (exact) return foot.b === foot.total ? { kind: "done", proof: { complete: true, strength: "page", how: `Show more pressed ${st.presses}×, rows never changed, ${foot.b} of ${foot.total}`, pages: st.pages, rows: rows.length, total: foot.total } } : { kind: "decline", why: `no Show more but only ${foot.b} of ${foot.total} read` };
    if (foot.plus) return { kind: "decline", why: `no Show more at ${foot.b} of ${foot.total}+ (list may be capped)` };
    if (foot.b < foot.total || foot.b - foot.total > approxTol(foot.total)) return { kind: "decline", why: `no Show more at ${foot.b} rows, about ${foot.total} shown (list cut)` };
    return { kind: "done", proof: { complete: true, strength: "model", how: `Show more until the list ended at ${foot.b} rows (about ${foot.total})`, pages: st.pages, rows: rows.length, total: foot.total } };
  }
  if (exact && foot.b === foot.total) return { kind: "decline", why: "total reached but the list still offers Show more" };
  if (st.presses > 1500) return { kind: "decline", why: "more than 1500 Show more presses" };
  st.presses++;
  return { kind: "continue", action: "more" };
}
