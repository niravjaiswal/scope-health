/**
 * Wording-tolerant readers for governing messages, shared by every family's policy parser:
 *   tablesIn  — markdown tables AND the same table written as bullets ("- Header: cell; Header: cell"),
 *               found by header label, never by position in the message;
 *   todayIn   — "Today is …" in its rewordings ("The current date is …", "As of today, …"), ISO or written;
 *   headingsIn— section headings in any form (## / ### / **bold line**) with their bodies.
 * A leaf module (pageSnapshot only), so family parsers can import it without cycles.
 */
import { dateSpans } from "./pageSnapshot.js";

export type MsgTable = { headers: string[]; rows: string[][]; line: number };
const cellsOf = (l: string) => l.trim().replace(/^\|/, "").replace(/\|\s*$/, "").split("|").map((x) => x.trim());
const unq = (s: string) => s.replace(/^`+|`+$/g, "").trim();

/** Every table in the message: markdown (header + separator + rows) or a run of ≥ 2 bullet lines that
 *  each read "Key: value; Key: value…" with the same keys in the same order. Cells keep their text
 *  (backticks stripped at the ends). */
export function tablesIn(raw: string): MsgTable[] {
  const lines = raw.split("\n"); const out: MsgTable[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\|/.test(lines[i]) && i + 1 < lines.length && /^\s*\|[\s|:-]+\|?\s*$/.test(lines[i + 1])) {
      const headers = cellsOf(lines[i]).map(unq); const rows: string[][] = []; let j = i + 2;
      for (; j < lines.length && /^\s*\|/.test(lines[j]); j++) rows.push(cellsOf(lines[j]).map(unq));
      out.push({ headers, rows, line: i }); i = j - 1; continue;
    }
    const kv = bulletKV(lines[i]);
    if (kv) {
      const keys = kv.map(([k]) => k.toLowerCase()); const rows: string[][] = [kv.map(([, v]) => v)]; let j = i + 1;
      for (; j < lines.length; j++) { const n = bulletKV(lines[j]); if (!n || n.map(([k]) => k.toLowerCase()).join("|") !== keys.join("|")) break; rows.push(n.map(([, v]) => v)); }
      if (rows.length >= 2) { out.push({ headers: kv.map(([k]) => k), rows, line: i }); i = j - 1; }
    }
  }
  return out;
}
function bulletKV(l: string): Array<[string, string]> | null {
  const m = l.match(/^\s*[-*•]\s+(.*)$/); if (!m) return null;
  const parts = m[1].split(/;\s+/); if (parts.length < 2) return null;
  const kv: Array<[string, string]> = [];
  for (const p of parts) { const x = p.match(/^([A-Z][^:]{0,60}?):\s*(.*)$/); if (!x) return null; kv.push([x[1].trim(), unq(x[2].trim())]); }
  return kv;
}
/** The one column whose header matches `re` (-1 none, -2 several). */
export function colIdx(t: MsgTable, re: RegExp): number { const h = t.headers.map((x, i) => [x, i] as const).filter(([x]) => re.test(x)); return h.length === 1 ? h[0][1] : h.length ? -2 : -1; }
/** The one table whose headers match every pattern, or null (none / several). */
export function tableWith(raw: string, ...res: RegExp[]): MsgTable | null {
  const ts = tablesIn(raw).filter((t) => res.every((re) => colIdx(t, re) >= 0));
  return ts.length === 1 ? ts[0] : null;
}

/** "Today is 2026-10-14" and its rewordings; every statement must name the same date. undefined = no
 *  statement, null = statements disagree or unreadable. */
export function todayIn(raw: string): string | null | undefined {
  const cues = /\b(?:today is|today'?s date is|the (?:current|present) date is|the date today is|it is now|as of today,?|today \(|for today,)\s*/gi;
  const found: Array<string | null> = [];
  for (const m of raw.matchAll(cues)) {
    const rest = raw.slice(m.index! + m[0].length, m.index! + m[0].length + 40);
    const d = dateSpans(rest).find((x) => x.start <= 1);
    found.push(d ? d.iso : null);
  }
  if (!found.length) return undefined;
  return found.every((d) => d && d === found[0]) ? found[0] : null;
}

export type Section = { heading: string; body: string };
/** Sections by heading in any form: "## X", "### X", or a line that is only "**X**". The text before
 *  the first heading is the section with heading "". */
export function headingsIn(raw: string): Section[] {
  const out: Section[] = []; let cur: Section = { heading: "", body: "" };
  for (const l of raw.split("\n")) {
    const h = l.match(/^\s*#{1,4}\s+(.+?)\s*#*\s*$/) ?? l.match(/^\s*\*\*([^*]+)\*\*\s*:?\s*$/);
    if (h) { out.push(cur); cur = { heading: h[1].trim(), body: "" }; } else cur.body += l + "\n";
  }
  out.push(cur);
  return out;
}
/** Paragraphs (blank-line separated); a paragraph ending in ":" keeps the list right after it. */
export function paragraphsIn(raw: string): string[] {
  const ps = raw.split(/\n\s*\n/); const out: string[] = [];
  for (let i = 0; i < ps.length; i++) { let p = ps[i]; while (/:\s*$/.test(p.trim()) && i + 1 < ps.length && /^\s*[-*•\d]/.test(ps[i + 1])) p += "\n" + ps[++i]; out.push(p); }
  return out;
}
