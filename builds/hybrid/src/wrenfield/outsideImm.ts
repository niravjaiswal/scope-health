/**
 * Outside immunization records (tetanus-wound): scanned documents printed by another clinic, filed with
 * the type "Immunization record". The governing tetanus message says how to read them:
 *  - "Dates written" (near the top, under Sex) names the date format: YYYY-MM-DD, MM/DD/YYYY, DD.MM.YYYY
 *    or day month year ("14 Mar 2021");
 *  - one dose per row, OR a grid (a row per vaccine, doses side by side under Dose 1, Dose 2, ...) where
 *    later dates in a row may omit the year: such a date is the first date with that month/day AFTER
 *    the date before it in the same row;
 *  - every date printed for a tetanus vaccine is a dose (vaccine names: the message's closed list).
 *
 * Reading = the lab pipeline (labRead.ts): tesseract ∥ one vision model transcribe AS PRINTED; both go
 * through the same pure resolver below; the tetanus dose-date lists must be identical, else ONE
 * tiebreak model must equal one of them, else decline. Anything unexpected (no "Dates written" line, a
 * date not in the stated format, a tetanus-looking name not in the list, a one-dose row with two
 * dates) → Skip. The readers only transcribe; the message's rules decide.
 */
import { type TetanusRule, type Skip, isSkip, isTetanusName } from "./immunizations.js";

export type DateFmt = "YMD" | "MDY" | "DMY" | "DMONY";
export type OutsideRow = { vaccine: string; dates: string[] };
export type OutsideRead = { fmt: DateFmt; grid: boolean; rows: OutsideRow[] };

const MON: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const MON_RE = "Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?";
const pad = (n: number) => String(n).padStart(2, "0");
const okYMD = (y: number, m: number, d: number) => y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();

/** The format the "Dates written" line names; null when there is no such line or it names none/two. */
export function datesWritten(text: string): DateFmt | null {
  const m = text.match(/Dates?\s+written\s*[:\-]?\s*([^\n]{0,60})/i);
  if (!m) return null;
  const v = m[1];
  const hits: DateFmt[] = [];
  if (/Y{4}\s*-\s*M{2}\s*-\s*D{2}/i.test(v)) hits.push("YMD");
  if (/M{2}\s*\/\s*D{2}\s*\/\s*Y{4}/i.test(v)) hits.push("MDY");
  if (/D{2}\s*\.\s*M{2}\s*\.\s*Y{4}/i.test(v)) hits.push("DMY");
  if (/day\s+month\s+year/i.test(v) || /^\s*\d{1,2}\s+(?:[A-Z][a-z]{2,8})\s+\d{4}\b/.test(v) || /D{1,2}\s+M{3}\s+Y{4}/i.test(v)) hits.push("DMONY");
  return hits.length === 1 ? hits[0] : null;
}

/** Date tokens of one format (full or yearless), in order, from a line. */
export function dateTokens(line: string, fmt: DateFmt): string[] {
  const re = fmt === "YMD" ? /\b\d{4}-\d{2}-\d{2}\b|(?<![\d-])\d{2}-\d{2}(?![\d-])/g
    : fmt === "MDY" ? /(?<![\d/])\d{1,2}\/\d{1,2}(?:\/\d{4})?(?![\d/])/g
    : fmt === "DMY" ? /(?<![\d.])\d{1,2}\.\d{1,2}\.(?:\d{4}(?![\d.]))?/g
    : new RegExp(`\\b\\d{1,2}\\s+(?:${MON_RE})\\.?(?:\\s+\\d{4})?\\b`, "gi");
  return line.match(re) ?? [];
}

/** One printed date → {y?, m, d}; null when it is not in the stated format. */
function parts(tok: string, fmt: DateFmt): { y?: number; m: number; d: number } | null {
  const t = tok.trim(); let m: RegExpMatchArray | null;
  if (fmt === "YMD") { if ((m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/))) return { y: +m[1], m: +m[2], d: +m[3] }; if ((m = t.match(/^(\d{2})-(\d{2})$/))) return { m: +m[1], d: +m[2] }; return null; }
  if (fmt === "MDY") { if ((m = t.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/))) return { y: m[3] ? +m[3] : undefined, m: +m[1], d: +m[2] }; return null; }
  if (fmt === "DMY") { if ((m = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})?$/))) return { y: m[3] ? +m[3] : undefined, m: +m[2], d: +m[1] }; return null; }
  if ((m = t.match(new RegExp(`^(\\d{1,2})\\s+(${MON_RE})\\.?(?:\\s+(\\d{4}))?$`, "i")))) return { y: m[3] ? +m[3] : undefined, m: MON[m[2].slice(0, 3).toLowerCase()] ?? MON[m[2].slice(0, 4).toLowerCase()], d: +m[1] };
  return null;
}

/** A row's printed dates → ISO, per the message: a yearless date = the first date with that month/day
 *  after the date before it. The first date must carry its year. */
export function resolveRow(dates: string[], fmt: DateFmt): string[] | Skip {
  const out: string[] = []; let prev: { y: number; m: number; d: number } | null = null;
  for (const tok of dates) {
    const p = parts(tok, fmt); if (!p) return { skip: `date "${tok}" is not in the record's stated format` };
    let y: number | undefined = p.y;
    if (y === undefined) {
      if (!prev) return { skip: `first date of a row has no year ("${tok}")` };
      const after = (yy: number) => yy > prev!.y || (yy === prev!.y && (p.m > prev!.m || (p.m === prev!.m && p.d > prev!.d)));
      let yy: number = prev.y; while (yy <= prev.y + 8 && !(after(yy) && okYMD(yy, p.m, p.d))) yy++;
      if (yy > prev.y + 8) return { skip: `yearless date "${tok}" cannot be placed` };
      y = yy;
    }
    if (y === undefined || !okYMD(y, p.m, p.d)) return { skip: `impossible date "${tok}"` };
    const cur: { y: number; m: number; d: number } = { y, m: p.m, d: p.d };
    out.push(`${cur.y}-${pad(cur.m)}-${pad(cur.d)}`); prev = cur;
  }
  return out;
}

/** Tetanus dose dates (ISO, unique, sorted) of a read record; Skip on anything the rule can't place. */
export function tetanusDoses(r: OutsideRead, rule: TetanusRule): string[] | Skip {
  const out = new Set<string>();
  for (const row of r.rows) {
    const t = isTetanusName(row.vaccine, rule);
    if (t === null) return { skip: `outside record names a vaccine not in the message's list: "${row.vaccine}"` };
    if (!r.grid && row.dates.length > 1) return { skip: `a one-dose-per-row record has a row with ${row.dates.length} dates` };
    const iso = resolveRow(row.dates, r.fmt); if (isSkip(iso)) return iso;
    if (t) for (const d of iso) out.add(d);
  }
  return [...out].sort();
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Tesseract text → rows. A row = a line holding exactly one vaccine name from the message's lists
 *  (longest names first) and at least one date in the stated format. A line with dates and a
 *  tetanus-looking word but no listed name → Skip. */
export function parseOutsideText(text: string, rule: TetanusRule): OutsideRead | Skip {
  const fmt = datesWritten(text); if (!fmt) return { skip: "no readable \"Dates written\" line" };
  const grid = /\bDose\s*1\b[\s\S]{0,80}\bDose\s*2\b/i.test(text);
  const names = [...new Set([...rule.tetanusNames, ...rule.notTetanus])].sort((a, b) => b.length - a.length);
  const rows: OutsideRow[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/[|]/g, " ").replace(/\s+/g, " ").trim();
    if (!line || /Dates?\s+written/i.test(line)) continue;
    const dates = dateTokens(line, fmt);
    if (!dates.length) continue;
    let rest = line; for (const d of dates) rest = rest.replace(d, " ");
    const found: string[] = [];
    for (const n of names) {
      const re = new RegExp(`(?<![A-Za-z0-9-])${esc(n)}(?![A-Za-z0-9-])`, "i");
      if (re.test(rest)) { found.push(n); rest = rest.replace(re, " "); }
    }
    if (found.length === 0) {
      if (isTetanusName(rest, rule) === null) return { skip: `unreadable vaccine name on a dated line: "${line.slice(0, 60)}"` };
      continue; // birth date, print date, ...
    }
    // the same vaccine under two names ("DTaP (Infanrix)") is fine; a tetanus and a non-tetanus name together is not
    const tet = new Set(found.map((f) => isTetanusName(f, rule)));
    if (tet.size > 1) return { skip: `tetanus and other vaccine names on one line: ${found.join(", ")}` };
    rows.push({ vaccine: found[0], dates });
  }
  if (!rows.length) return { skip: "no vaccine rows read" };
  return { fmt, grid, rows };
}

/** The model's JSON (as printed) → OutsideRead. */
export function fromModelJson(o: any): OutsideRead | Skip {
  if (!o || typeof o !== "object" || !Array.isArray(o.rows) || o.rows.length > 80) return { skip: "model: bad shape" };
  const fmt = datesWritten(`Dates written: ${String(o.dates_written ?? "")}`); if (!fmt) return { skip: "model: no \"Dates written\" format" };
  const rows: OutsideRow[] = [];
  for (const r of o.rows) {
    if (!r || typeof r.vaccine !== "string" || !Array.isArray(r.dates)) return { skip: "model: bad row" };
    const dates = r.dates.map((d: unknown) => String(d ?? "").trim()).filter(Boolean);
    if (dates.length) rows.push({ vaccine: r.vaccine.trim(), dates });
  }
  return { fmt, grid: o.layout === "grid", rows };
}

export const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Agreement over the tetanus dose lists of up to three reads (tesseract, model, tiebreak). */
export function agree(tess: string[] | Skip | null, m1: string[] | Skip | null, m2?: string[] | Skip | null): string[] | Skip {
  const ok = (x: string[] | Skip | null | undefined): x is string[] => Array.isArray(x);
  if (ok(tess) && ok(m1) && sameList(tess, m1)) return tess;
  if (m2 === undefined) return { skip: "need-tiebreak" };
  if (ok(m2) && ((ok(tess) && sameList(m2, tess)) || (ok(m1) && sameList(m2, m1)))) return m2;
  return { skip: "outside record: readers disagree on its tetanus doses" };
}
