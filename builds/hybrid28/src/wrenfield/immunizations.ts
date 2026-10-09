/**
 * [immunizations] PURE readers + rule parsers for the two immunization families:
 *   tetanus-wound       (the chart's Notes / Immunizations / Documents → TetanusContext)
 *   vaccine-lot-recall  (lot dose rows + lot notes → patients left to notify)
 *
 * Everything works on DECODED page text (or typed rows), so it is checked offline against the Set 1
 * recon dumps (immunizations-test.ts). Rules for the generalisation contract (NEXT.md):
 *   - tables are found by HEADER LABEL (synonyms, any order, extra columns tolerated), never by index;
 *   - the vaccine list, the decision table and the wound list come from the GOVERNING MESSAGE;
 *   - anything unexpected returns `{ skip: why }`, never a guess;
 *   - absence answers (no wound visit, no dose) require a COMPLETE read (counts match the page's own
 *     "N entries" / "Showing a to b of N" footer on every page).
 * Note text is DATA: it is pattern-matched, never followed.
 */

export type Skip = { skip: string };
import { tablesIn, colIdx } from "./policyText.js";
import { listFooter, type FooterKind } from "./listFooter.js";
export const isSkip = (x: unknown): x is Skip => !!x && typeof x === "object" && "skip" in (x as any);
export const normText = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();

// ───────────────────────────── Dates ─────────────────────────────
const MON: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n: number) => String(n).padStart(2, "0");
const MONTHS_RE = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
function valid(y: number, m: number, d: number): string | null {
  if (!(y >= 1850 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
}
export type NumOrder = "MDY" | "DMY";
/** One date written alone (the whole string, ignoring a trailing time/zone): ISO, "Jun 7, 1952",
 *  "June 7 1952", "7 Jun 1952", "06/07/1952" (needs `order` unless unambiguous), "07.06.1952" (DMY).
 *  Returns ISO or null; "ambiguous" for an all-numeric date whose order can't be told. */
export function parseDate(s: string, order?: NumOrder): string | null | "ambiguous" {
  const t = s.trim().replace(/\s+/g, " ");
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = t.match(new RegExp(`^(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,? )?(${MONTHS_RE})\\.? (\\d{1,2}),? (\\d{4})\\b`, "i"));
  if (m) return valid(+m[3], MON[m[1].slice(0, 3).toLowerCase()], +m[2]);
  m = t.match(new RegExp(`^(\\d{1,2}) (${MONTHS_RE})\\.?,? (\\d{4})\\b`, "i"));
  if (m) return valid(+m[3], MON[m[2].slice(0, 3).toLowerCase()], +m[1]);
  m = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})\b/);
  if (m) return valid(+m[3], +m[2], +m[1]);
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (m) {
    const a = +m[1], b = +m[2];
    const o: NumOrder | null = order ?? (a > 12 && b <= 12 ? "DMY" : b > 12 && a <= 12 ? "MDY" : a === b ? "MDY" : null);
    if (!o) return "ambiguous";
    return o === "MDY" ? valid(+m[3], a, b) : valid(+m[3], b, a);
  }
  return null;
}
/** The numeric order a column of slash dates must be in, from its own values (a day > 12 proves it);
 *  null when the column has no slash dates, "conflict" when values prove both orders. */
export function columnOrder(cells: string[]): NumOrder | null | "conflict" {
  let mdy = false, dmy = false;
  for (const c of cells) { const m = c.trim().match(/^(\d{1,2})\/(\d{1,2})\/\d{4}/); if (!m) continue; if (+m[1] > 12) dmy = true; if (+m[2] > 12) mdy = true; }
  return mdy && dmy ? "conflict" : mdy ? "MDY" : dmy ? "DMY" : null;
}

// ───────────────────────────── Page counts ─────────────────────────────
/** `kind` is set only when the total is NOT exact: "plus" ("500+", a lower bound) or "approx" ("about 500") — such a
 *  list's end can never be proven (listFooter.isComplete), and combinePages declines it. */
export type PageInfo = { from: number; to: number; total: number; kind?: FooterKind };
/** "Showing 1 to 10 of 33 notes" / "Showing 1–10 of 33" / "8 notes" / "No notes" → range + total (listFooter's grammar,
 *  the first line of `text` that states a size). `nouns` is a regex fragment for the list's noun ("notes?",
 *  "entr(?:y|ies)"); a footer naming another list's noun is skipped, a footer without a noun passes. */
export function pageInfo(text: string, nouns: string): PageInfo | null {
  const f = listFooter(text, new RegExp(`^(?:${nouns})$`, "i"));
  if (!f || f.page !== undefined) return null;
  if (f.none) return { from: 0, to: 0, total: 0 };
  return { from: f.from, to: f.to < 0 ? 0 : f.to, total: f.total, ...(f.kind !== "exact" ? { kind: f.kind } : {}) };
}

/** A list read page by page is complete only if each page holds exactly its range, the ranges are
 *  contiguous from 1, every page agrees on the total, and the pages add up to it. */
export function combinePages<T>(pages: Array<{ items: T[]; page: PageInfo }>): T[] | Skip {
  if (!pages.length) return { skip: "no page read" };
  const inexact = pages.find((p) => p.page.kind);
  if (inexact) return { skip: `the list's total is ${inexact.page.kind === "plus" ? "a lower bound" : "an estimate"} (${inexact.page.total}): its end is never proven` };
  const total = pages[0].page.total; const out: T[] = []; let next = total ? 1 : 0;
  for (const { items, page } of pages) {
    if (page.total !== total) return { skip: `pages disagree on the total (${page.total} vs ${total})` };
    if (total === 0) { if (items.length) return { skip: "an empty list with rows" }; continue; }
    if (page.from !== next) return { skip: `page starts at ${page.from}, expected ${next}` };
    if (items.length !== page.to - page.from + 1) return { skip: `page ${page.from}-${page.to} has ${items.length} rows` };
    out.push(...items); next = page.to + 1;
  }
  if (out.length !== total) return { skip: `read ${out.length} of ${total}` };
  return out;
}

// ───────────────────────────── Tables by header label ─────────────────────────────
export type Table = { headers: string[]; col: Record<string, number>; rows: string[][] };
/** Find THE table in decoded page text whose header line has a cell matching every `required` label
 *  (each label → exactly one header cell). Rows are the tab-separated lines that follow (blank lines
 *  and tab-less lines between the header and the first row are header furniture, e.g. a hidden
 *  "Actions" label). Every row must have the header's cell count. Two candidate header lines → skip. */
export function findTable(text: string, spec: Record<string, RegExp>, required: string[]): Table | Skip {
  const lines = text.split("\n");
  const cands: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes("\t")) continue;
    const cells = lines[i].split("\t").map((c) => c.trim());
    if (required.every((k) => cells.filter((c) => c && spec[k].test(c)).length === 1)) cands.push(i);
  }
  if (!cands.length) return { skip: `no table with columns ${required.join(", ")}` };
  if (cands.length > 1) return { skip: `${cands.length} tables with columns ${required.join(", ")}` };
  const h = cands[0];
  const headers = lines[h].split("\t").map((c) => c.trim());
  const col: Record<string, number> = {};
  for (const [k, re] of Object.entries(spec)) {
    const hits = headers.map((c, i) => (c && re.test(c) ? i : -1)).filter((i) => i >= 0);
    if (hits.length > 1) return { skip: `column "${k}" matches ${hits.length} headers: ${hits.map((i) => headers[i]).join(" | ")}` };
    if (hits.length === 1) col[k] = hits[0];
  }
  const rows: string[][] = [];
  let j = h + 1;
  while (j < lines.length && !lines[j].includes("\t") && j - h <= 3) j++;   // header furniture
  for (; j < lines.length; j++) {
    const l = lines[j];
    if (!l.includes("\t")) {
      // a badge rendered as a block drops the row's last cell onto its own line ("…\t$85.00\t" / "Paid")
      const prev = rows[rows.length - 1];
      if (prev && prev[prev.length - 1] === "" && l.trim() && j + 1 < lines.length && (lines[j + 1].includes("\t") || !lines[j + 1].trim())) { prev[prev.length - 1] = l.trim(); continue; }
      break;
    }
    const cells = l.split("\t").map((c) => c.trim());
    if (cells.length !== headers.length) return { skip: `row has ${cells.length} cells, header ${headers.length}: "${l.slice(0, 80)}"` };
    rows.push(cells);
  }
  return { headers, col, rows };
}

// ───────────────────────────── Immunizations tab ─────────────────────────────
export type ImmEntry = { vaccine: string; dateISO: string; lot: string; recordedAs: string; enteredInError: boolean; cells: string[] };
export const IMM_COLS: Record<string, RegExp> = {
  vaccine: /^(?:vaccine|immuni[sz]ation|product|vaccine name)$/i,
  date: /^(?:date given|given on|date administered|administered(?: on)?|date|given)$/i,
  lot: /^(?:lot|lot number|lot no\.?|lot #)$/i,
  recorded: /^(?:recorded as|source|status|record(?:ed)? type|entry)$/i,
};
/** One page of the chart's Immunizations table. Date order for slash dates is taken from the
 *  column's own values; a column that can't prove its order → skip. */
export function parseImmunizations(text: string): { entries: ImmEntry[]; page: PageInfo } | Skip {
  const page = pageInfo(text, "entr(?:y|ies)|immuni[sz]ations?|doses?|vaccines?|records?");
  const t = findTable(text, IMM_COLS, ["vaccine", "date"]);
  if (isSkip(t)) {
    if (page && page.total === 0) return { entries: [], page };
    return { skip: "immunizations: " + t.skip };
  }
  if (t.col.recorded === undefined) return { skip: "immunizations: no Recorded-as/Status column (cannot see 'Entered in error')" };
  if (!page) return { skip: "immunizations: no entry count on the page" };
  const order = columnOrder(t.rows.map((r) => r[t.col.date]));
  if (order === "conflict") return { skip: "immunizations: date column mixes day-first and month-first" };
  const entries: ImmEntry[] = [];
  for (const r of t.rows) {
    const d = parseDate(r[t.col.date], order ?? undefined);
    if (!d || d === "ambiguous") return { skip: `immunizations: unreadable date "${r[t.col.date]}"` };
    const eie = r.some((c) => /entered in error/i.test(c));
    entries.push({ vaccine: r[t.col.vaccine].replace(/\s*[-–·(]?\s*entered in error\)?\s*$/i, "").trim(), dateISO: d, lot: t.col.lot !== undefined ? r[t.col.lot] : "", recordedAs: r[t.col.recorded], enteredInError: eie, cells: r });
  }
  return { entries, page };
}

// ───────────────────────────── Documents tab ─────────────────────────────
export type Doc = { title: string; kind: string; receivedISO: string };
export const DOC_COLS: Record<string, RegExp> = { title: /^(?:title|document|name|description)$/i, kind: /^(?:type|kind|category|document type)$/i, received: /^(?:received|date received|received on|date|filed)$/i };
export function parseDocuments(text: string): { docs: Doc[]; page: PageInfo } | Skip {
  const page = pageInfo(text, "documents?|files?");
  const t = findTable(text, DOC_COLS, ["title", "received"]);
  if (isSkip(t)) { if (page && page.total === 0) return { docs: [], page }; return { skip: "documents: " + t.skip }; }
  if (!page) return { skip: "documents: no document count on the page" };
  const order = columnOrder(t.rows.map((r) => r[t.col.received]));
  if (order === "conflict") return { skip: "documents: date column mixes orders" };
  const docs: Doc[] = [];
  for (const r of t.rows) {
    const d = parseDate(r[t.col.received], order ?? undefined);
    if (!d || d === "ambiguous") return { skip: `documents: unreadable received date "${r[t.col.received]}"` };
    docs.push({ title: r[t.col.title], kind: t.col.kind !== undefined ? r[t.col.kind] : "", receivedISO: d });
  }
  return { docs, page };
}

// ───────────────────────────── Notes tab ─────────────────────────────
export type Note = { dateISO: string; time: string; head: string[]; body: string };
const TIME_TAIL = /^(?:,?\s*(?:at\s+)?\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]\.?M\.?)?)?(?:\s+[A-Z]{2,5})?\s*$/i;
/** A note's date line: a date (any written form), optionally followed by a time and a zone. */
export function noteDateLine(line: string, order?: NumOrder): string | null {
  const l = line.trim(); if (!l || l.length > 48) return null;
  const m = l.match(new RegExp(`^((?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,? )?(?:\\d{4}-\\d{2}-\\d{2}|(?:${MONTHS_RE})\\.? \\d{1,2},? \\d{4}|\\d{1,2} (?:${MONTHS_RE})\\.?,? \\d{4}|\\d{1,2}[/.]\\d{1,2}[/.]\\d{4}))(.*)$`, "i"));
  if (!m || !TIME_TAIL.test(m[2])) return null;
  const d = parseDate(m[1], order);
  return d && d !== "ambiguous" ? d : null;
}
const TZ_LINE = /^(?:[A-Z]{2,5}|UTC[+-]\d{1,2}(?::\d{2})?|GMT[+-]\d{1,2})$/;
/** One note's own text (its list item / article): header lines (type, author…), ONE date line, an
 *  optional zone line, then the body. More or fewer than one date line → skip. */
export function parseNoteChunk(chunk: string, order?: NumOrder): Note | Skip {
  const lines = chunk.split("\n").map((l) => l.trim());
  const i = lines.findIndex((l) => !!noteDateLine(l, order));
  if (i < 0) return { skip: `a note without a date line: "${chunk.slice(0, 60)}"` };
  if (i > 4) return { skip: `note date line not in the header: "${chunk.slice(0, 60)}"` };
  let b = i + 1; if (b < lines.length && TZ_LINE.test(lines[b])) b++;
  const body = lines.slice(b).join("\n").trim();
  if (!body) return { skip: "a note with an empty body" };
  return { dateISO: noteDateLine(lines[i], order)!, time: lines[i], head: lines.slice(0, i).filter(Boolean), body };
}
/** The Notes list from the whole page's decoded text (no per-note elements): every date line with a
 *  type + author line above it starts a note. Used to cross-check the per-note chunks live, and on its
 *  own in offline tests. The count must match the page footer (caller). */
export function parseNotesText(text: string): Note[] {
  const lines = text.split("\n");
  const heads: number[] = [];
  for (let i = 2; i < lines.length; i++) if (noteDateLine(lines[i]) && lines[i - 1].trim() && lines[i - 2].trim() && lines[i - 1].trim().length < 60 && lines[i - 2].trim().length < 40) heads.push(i);
  const out: Note[] = [];
  for (let k = 0; k < heads.length; k++) {
    const i = heads[k];
    const end = k + 1 < heads.length ? heads[k + 1] - 2 : lines.length;
    let b = i + 1; if (b < lines.length && TZ_LINE.test(lines[b].trim())) b++;
    let bodyLines = lines.slice(b, end);
    const stop = bodyLines.findIndex((l) => /^\s*(?:Showing \d+\s*(?:to|-|–)\s*\d+ of \d+|\d+ notes?|Rows per page|Previous|Next)\b/i.test(l));
    if (stop >= 0) bodyLines = bodyLines.slice(0, stop);
    out.push({ dateISO: noteDateLine(lines[i])!, time: lines[i].trim(), head: [lines[i - 2].trim(), lines[i - 1].trim()], body: bodyLines.join("\n").trim() });
  }
  return out;
}

// ───────────────────────────── Tetanus rule (from the governing message) ─────────────────────────────
export type TetanusRule = {
  tetanusNames: string[];          // chart names + outside-record names (closed list)
  notTetanus: string[];            // names the message lists as NOT tetanus (incl. unbranded forms)
  lowMax: number;                  // "0, 1, or 2" → 2
  cleanYears: number; otherYears: number;
  triggers: string[];              // canonical wound words the message lists (subset of TRIGGER_FORMS keys)
};
/** Canonical trigger → the inflections we accept as "the note says so in plain words". */
const TRIGGER_FORMS: Record<string, string[]> = {
  contaminated: ["contaminated", "contamination"], dirt: ["dirt", "dirty"], soil: ["soil", "soiled"], feces: ["feces", "fecal", "faeces"],
  saliva: ["saliva"], bite: ["bite", "bites", "bitten"], puncture: ["puncture", "punctures", "punctured"], avulsion: ["avulsion", "avulsed"],
  "torn away": ["torn away", "torn off"], missile: ["missile"], bullet: ["bullet", "bullets"], pellet: ["pellet", "pellets"], shrapnel: ["shrapnel"],
  crush: ["crush", "crushed", "crushing"], burn: ["burn", "burns", "burned", "burnt"], frostbite: ["frostbite", "frostbitten"],
};
/** Words a bullet may use around the triggers (explanations), which are not triggers themselves. */
const BULLET_FILLER = new Set("a an the with from or and is it in its has have that this where which skin away wound wounds injury injuries person animal any kind of such as by be are was were someone torn".split(" "));
const NAME_KEY = (s: string) => s.replace(/[‐-―]/g, "-").replace(/\s+/g, " ").trim().toLowerCase();

export const TETANUS_FIELDS = ["tetanusNames", "notTetanus", "lowMax", "cleanYears", "otherYears", "triggers", "tokens"] as const;
const TET_TOKENS = ["VACCINE_AND_TIG", "VACCINE", "NONE", "NO_WOUND_VISIT"];
/** The tetanus rule field by field. Tables are found by their column labels (markdown or bullet rows);
 *  a field that is not stated clearly is absent and `why` says why (the solver declines only the
 *  answers whose path reads it). */
export function parseTetanusFields(raw: string): { fields: Partial<TetanusRule> & { tokens?: string[] }; why: string[] } {
  const why: string[] = []; const f: Partial<TetanusRule> & { tokens?: string[] } = {};
  const toks = TET_TOKENS.filter((t) => new RegExp(`\`${t}\``).test(raw) || new RegExp(`\\b${t}\\b`).test(raw));
  if (toks.length === TET_TOKENS.length) f.tokens = toks; else why.push("answer tokens not all in the message");
  const lines = raw.split("\n");
  // 1. the vaccine table: the one whose headers name the chart and the outside record
  const vt = tablesIn(raw).filter((t) => t.headers.some((h) => /chart/i.test(h)) && t.headers.some((h) => /outside/i.test(h)));
  const closed = /No other vaccine is a tetanus vaccine/i.test(raw);
  if (vt.length !== 1) why.push(vt.length ? "two vaccine-name tables" : "no vaccine-name table");
  else if (!closed) why.push("the vaccine list is not stated as closed");
  else {
    const names = vt[0].rows.flat().map((c) => c.replace(/`/g, "").trim()).filter(Boolean);
    if (names.length < 4) why.push("vaccine table too short"); else f.tetanusNames = names;
  }
  // 2. the closed list + named exclusions
  if (closed) {
    const not: string[] = [];
    const ex = raw.match(/No other vaccine is a tetanus vaccine\.?\s*(?:That includes|This includes|Including)\s+([^\n]+?)\.\s*(?:\n|$)/i);
    if (ex) {
      const unbranded = /without a brand name/i.test(ex[1]);
      for (let p of ex[1].split(/,\s*|\s+and\s+/)) {
        p = p.replace(/^and\s+/i, "").trim(); if (!p || /same vaccines|without a brand/i.test(p)) continue;
        not.push(p); if (unbranded) { const b = p.replace(/\s*\([^)]*\)\s*$/, "").trim(); if (b !== p) not.push(b); }
      }
    }
    f.notTetanus = not;
  }
  // 3. the decision table: low-count row ("0, 1, or 2") and high row ("3 or more"), clean | other columns
  const dts = tablesIn(raw).filter((t) => colIdx(t, /clean/i) >= 0 && colIdx(t, /other/i) >= 0);
  if (dts.length !== 1) why.push(dts.length ? "two decision tables" : "no decision table");
  else {
    const t = dts[0]; const ci = colIdx(t, /clean/i), oi = colIdx(t, /other/i); const ni = t.headers.findIndex((_, i) => i !== ci && i !== oi);
    let lowMax = -1, highMin = -1, cleanYears = -1, otherYears = -1, bad = "";
    for (const c of t.rows) {
      if (c.length !== t.headers.length || ni < 0) { bad = "decision row not understood"; continue; }
      const nums = (c[ni].match(/\d+/g) ?? []).map(Number);
      if (/or more/i.test(c[ni]) && nums.length === 1) {
        highMin = nums[0];
        const yc = c[ci].match(/(\d+) or more years/i), yo = c[oi].match(/(\d+) or more years/i);
        if (!yc || !yo || !/VACCINE/.test(c[ci]) || !/NONE/.test(c[ci]) || !/VACCINE/.test(c[oi]) || !/NONE/.test(c[oi]) || /TIG/.test(c[ci] + c[oi])) bad = "high-count row not understood";
        else { cleanYears = +yc[1]; otherYears = +yo[1]; }
      } else if (nums.length >= 1 && nums[0] === 0) {
        lowMax = Math.max(...nums);
        if (!/^`?VACCINE`?$/.test(c[ci].trim()) || !/^`?VACCINE_AND_TIG`?$/.test(c[oi].trim())) bad = "low-count row not understood";
      } else bad = `decision row "${c[ni]}" not understood`;
    }
    if (bad) why.push(bad);
    else if (lowMax < 0 || highMin !== lowMax + 1 || cleanYears < 1 || otherYears < 1) why.push("decision table incomplete");
    else Object.assign(f, { lowMax, cleanYears, otherYears });
  }
  // 4. the wound list: the bullets after "…unless the note says the wound … is:"
  const wi = lines.findIndex((l) => /unless the note says/i.test(l));
  if (wi < 0) why.push("no wound list");
  else {
    const bullets: string[] = [];
    for (let i = wi + 1; i < lines.length; i++) { const l = lines[i]; if (/^\s*[-*]\s+/.test(l)) bullets.push(l.replace(/^\s*[-*]\s+/, "")); else if (bullets.length && l.trim()) break; }
    if (!bullets.length) why.push("wound list empty");
    else {
      const triggers = new Set<string>(); let unknown = "";
      for (const b of bullets) {
        let low = " " + b.toLowerCase().replace(/[^a-z ]+/g, " ") + " ";
        for (const [canon, forms] of Object.entries(TRIGGER_FORMS)) for (const fm of forms) if (low.includes(` ${fm} `)) { triggers.add(canon); low = low.split(` ${fm} `).join(" "); }
        const left = low.split(/\s+/).filter((w) => w && !BULLET_FILLER.has(w));
        if (left.length) { unknown = left.join(", "); break; }
      }
      if (unknown) why.push(`wound list has words we don't decide on: ${unknown}`); else f.triggers = [...triggers];
    }
  }
  return { fields: f, why };
}
/** Parse the tetanus workflow message: the whole rule, or a skip naming the first field not understood. */
export function parseTetanusRule(raw: string): TetanusRule | Skip {
  const { fields, why } = parseTetanusFields(raw);
  if (why.length) return { skip: "tetanus message: " + why[0] };
  const { tokens, ...rule } = fields; return rule as TetanusRule;
}

/** true / false for a vaccine name under the rule; null when the name is neither listed nor clearly
 *  some other vaccine (it reads like a tetanus product we don't know) → the caller skips. */
export function isTetanusName(name: string, rule: TetanusRule): boolean | null {
  const k = NAME_KEY(name);
  if (rule.tetanusNames.some((n) => NAME_KEY(n) === k)) return true;
  if (rule.notTetanus.some((n) => NAME_KEY(n) === k)) return false;
  if (/\b(?:td|tdap|dtap|dt|tt|tetanus|diphtheria|tig)\b/i.test(name) || TET_BRANDS.test(name)) return null;
  return false; // the message's list is closed: any other vaccine is not a tetanus vaccine
}
const TET_BRANDS = /\b(?:tenivac|boostrix|adacel|daptacel|infanrix|pediarix|pentacel|vaxelis|kinrix|tdvax|quadracel)\b/i;

// ───────────────────────────── Wound class ─────────────────────────────
/** Words a wound description could use that are not the message's plain words: we can't decide → skip. */
const WEAK = /\b(?:bit|mud|muddy|gravel|debris|rust|rusty|nail|needle|thorn|splinter|fishhook|barbed|animal|dog|cat|horse|flap|degloving|road rash|foreign body|embedded|grime|sewage|manure|stool|compost|garden|farm|barn|stepped on|impaled|blast|explosion|firework|chemical|electrical|scald|scalded|gunshot|fang|teeth|tooth|claw|scratch(?:ed)?|infected|pus|tetanus-prone|filthy)\b/gi;
const NEGATOR = /\b(?:no|not|without|denies|negative for|free of|nor|neither)\b/gi;
const LIST_FILLER = /^(?:[\s,]|or|and|not|nor|a|an|any|the|in|into|to|of|wound|signs?|evidence|visible|is|was|it|this|from|by|either|neither)*$/i;
// Someone else is the one WOUNDED ("her son was bitten", "his brother's burn") — not merely the cause
// ("a bite from the neighbor's dog" is this patient's wound).
const PERSON = "brother|sister|mother|father|mom|dad|son|daughter|wife|husband|child|friend|partner|sibling|cousin|roommate|coworker|neighbou?r|family member|spouse|grand(?:mother|father|son|daughter)|another (?:person|patient)";
const THIRD = new RegExp(`\\b(?:${PERSON})\\s+(?:\\w+\\s+){0,2}(?:was|were|got|had|has|is)\\b|\\b(?:${PERSON})['’]s\\s+(?:\\w+\\s+)?(?:wound|cut|bite|burn|injury|laceration|scrape|hand|arm|leg|foot|finger)s?\\b`, "i");
const HEALED = /\b(?:healed|healing well|old (?:wound|scar|injury|bite|burn)|previous (?:wound|injury|bite|burn|cut)|prior (?:wound|injury|bite|burn|cut)|earlier (?:wound|injury|bite|burn|cut)|last (?:year|month|summer|winter|spring|fall)|years? ago|months? ago|scar)\b/i;
const THIS_WOUND = /\b(?:today|this (?:wound|visit|injury|cut|laceration)|current|presents? with|came in with)\b/i;
const WOUND_WORDS = /\b(?:cut|cuts|laceration|lacerated|scrape|scraped|abrasion|wound|slice|sliced|nick|gash|skin tear|incision|injury|injured)\b/i;

function triggerRe(rule: TetanusRule): RegExp {
  const forms = rule.triggers.flatMap((t) => TRIGGER_FORMS[t] ?? [t]).sort((a, b) => b.length - a.length).map((f) => f.replace(/ /g, "\\s+"));
  return new RegExp(`\\b(?:${forms.join("|")})\\b`, "gi");
}
function negatedAt(clause: string, idx: number, strong: RegExp): boolean {
  const before = clause.slice(0, idx);
  let m: RegExpExecArray | null, last = -1, len = 0; NEGATOR.lastIndex = 0;
  while ((m = NEGATOR.exec(before))) { last = m.index; len = m[0].length; }
  if (last < 0) return false;
  const between = before.slice(last + len).replace(strong, " ").replace(WEAK, " ");
  return LIST_FILLER.test(between);
}
/** Clean-and-minor vs any-other, from the triage note, per the message's list. Skips on wording the
 *  list doesn't cover, on a clause mixing this wound with another person's / a healed one, and on a
 *  note that doesn't describe a wound at all. */
export function woundClass(note: string, rule: TetanusRule): "clean" | "other" | Skip {
  const text = note.replace(/^\s*Triage:\s*/i, "");
  const strong = triggerRe(rule);
  const clauses = text.split(/(?<=[.!?;])\s+|\s*;\s*|\s+but\s+|\s+however,?\s+|\s+although\s+|\s+though\s+/i).map((c) => c.trim()).filter(Boolean);
  let other = false; let weak: Skip | null = null;
  for (const c of clauses) {
    const hits: Array<{ w: string; i: number; strong: boolean }> = [];
    for (const re of [strong, WEAK]) { re.lastIndex = 0; let m: RegExpExecArray | null; while ((m = re.exec(c))) hits.push({ w: m[0], i: m.index, strong: re === strong }); }
    if (!hits.length) continue;
    if (THIRD.test(c) || HEALED.test(c)) {
      if (THIS_WOUND.test(c) || /\b(?:patient|pt)\b/i.test(c)) return { skip: `wound clause mixes this wound with another: "${c.slice(0, 70)}"` };
      continue; // about someone else's or a healed wound: ignored, as the message says
    }
    for (const h of hits) {
      if (negatedAt(c, h.i, strong)) continue;
      if (!h.strong) { weak = weak ?? { skip: `wound wording not on the message's list: "${h.w}" in "${c.slice(0, 70)}"` }; continue; }
      other = true;
    }
  }
  if (other) return "other";        // a listed kind said plainly decides it; other wording can't undo that
  if (weak) return weak;
  if (!WOUND_WORDS.test(text)) return { skip: "triage note does not describe a cut/scrape/wound" };
  return "clean";
}

// ───────────────────────────── Tetanus dose notes ─────────────────────────────
const NOT_A_DOSE = /\b(?:offer(?:ed|s)?|discuss(?:ed)?|declin(?:ed|es)|refus(?:ed|es)|order(?:ed)?|not given|wasn'?t given|was not|deferr?ed|postponed|elsewhere|another clinic|other clinic|outside|pharmacy|health department|urgent care|hospital|ER|says|said|thinks|reports?|reported|believes|states|stated|recalls?|recalled|letter|mailed|notice|portal|due|will (?:get|return|come)|next visit|records? (?:request|sent)|unsure|unknown|about \d+ years?|up to date|plan(?:ned)?|schedule[ds]?|reminder|consent|VIS|information sheet)\b/i;
const DOSE_HERE = /\b(?:given|administered)\b[^.]*\b(?:today|here|this visit|in clinic)\b|\b(?:given|administered) (?:today|here|in the (?:left|right) (?:deltoid|thigh|arm))\b/i;
const LOT_IN = /\b[Ll]ot(?: [Nn]umber| [Nn]o\.?| #)?:?\s*#?\s*(?=[A-Z0-9]*\d)([A-Z0-9]{4,})\b/;
/** Our own note of a tetanus dose given here ("Td (Tenivac) given today in the left deltoid, lot number
 *  TK4471D."). A note naming a tetanus product that is neither clearly that nor clearly not-a-dose → unclear. */
export function classifyDoseNote(body: string, rule: TetanusRule): "dose" | "not-dose" | "unclear" | "irrelevant" {
  const names = rule.tetanusNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).sort((a, b) => b.length - a.length);
  const nameRe = new RegExp(`(?:^|[^A-Za-z])(?:${names.join("|")})(?![A-Za-z])`);
  const named = nameRe.test(body) || TET_BRANDS.test(body);
  const tet = named || /\btetanus\b/i.test(body);
  if (!tet) return "irrelevant";
  const pos = DOSE_HERE.test(body) && LOT_IN.test(body);
  const neg = NOT_A_DOSE.test(body);
  if (pos && !neg && named) return "dose";
  if (!pos && neg) return "not-dose";
  if (!pos && !/\b(?:given|administered|gave|vaccinated|injection|shot|dose)\b/i.test(body)) return "not-dose"; // e.g. "tetanus status reviewed" with no administration words
  return "unclear";
}

// ───────────────────────────── Tetanus context ─────────────────────────────
export type TetanusInputs = {
  visitISO: string;
  notes: Note[] | null; notesComplete: boolean;
  imms: ImmEntry[] | null; immsComplete: boolean;
  docs: Doc[] | null; docsComplete: boolean;
  /** tetanus dose dates read from each outside Immunization record (outsideImm.ts), one list per record */
  outsideDoses?: string[][];
};
export type TetanusCtx = { visitDateISO: string; woundVisit: boolean; woundClass: "clean" | "other"; doseDatesISO: string[] };
/** The engine context, or why not. Order matters: NO_WOUND_VISIT needs only a complete notes read
 *  (call with imms/docs null first to avoid opening tabs the answer doesn't need). */
export function buildTetanusContext(x: TetanusInputs, rule: TetanusRule): TetanusCtx | Skip {
  if (!x.notes || !x.notesComplete) return { skip: "notes not completely read" };
  const sameDay = x.notes.filter((n) => n.dateISO === x.visitISO);
  const triage = sameDay.filter((n) => /^Triage:/.test(n.body.trim()));
  if (!triage.length) {
    if (sameDay.some((n) => /Triage:/.test(n.body))) return { skip: "a same-day note contains 'Triage:' but not at its start" };
    return { visitDateISO: x.visitISO, woundVisit: false, woundClass: "clean", doseDatesISO: [] };
  }
  const classes = triage.map((n) => woundClass(n.body, rule));
  const bad = classes.find(isSkip); if (bad) return bad as Skip;
  if (new Set(classes).size !== 1) return { skip: "two triage notes that day disagree on the wound class" };
  const wc = classes[0] as "clean" | "other";
  if (x.imms === null || x.docs === null) return { skip: "need-more" };
  if (!x.immsComplete) return { skip: "immunizations not completely read" };
  if (!x.docsComplete) return { skip: "documents not completely read" };
  const outside = x.docs.filter((d) => /immuni[sz]ation record/i.test(d.kind) || /^immuni[sz]ation record/i.test(d.title));
  if (outside.length && (!x.outsideDoses || x.outsideDoses.length !== outside.length)) return { skip: `chart has ${outside.length} outside Immunization record(s) (scanned; their dose dates need a vision read we don't trust)` };
  const doses: string[] = [];
  for (const rec of x.outsideDoses ?? []) for (const d of rec) if (d < x.visitISO) doses.push(d);
  for (const e of x.imms) {
    if (e.enteredInError) continue;
    const t = isTetanusName(e.vaccine, rule);
    if (t === null) return { skip: `vaccine name not in the message's list: "${e.vaccine}"` };
    if (!/^Given (?:at |elsewhere)/i.test(e.recordedAs)) return { skip: `immunization entry recorded as "${e.recordedAs}"` };
    if (t && e.dateISO < x.visitISO) doses.push(e.dateISO);
  }
  for (const n of x.notes) {
    if (n.dateISO >= x.visitISO) continue;               // only doses before the visit count
    const k = classifyDoseNote(n.body, rule);
    if (k === "unclear") return { skip: `cannot tell whether a ${n.dateISO} note records a tetanus dose given here` };
    if (k === "dose") doses.push(n.dateISO);
  }
  return { visitDateISO: x.visitISO, woundVisit: true, woundClass: wc, doseDatesISO: [...new Set(doses)].sort() };
}

/** The governing tetanus message (field by field): the LATEST tetanus message that states the rule (its
 *  answer tokens or one of its tables). A later tetanus message that reads like a change we can't
 *  parse → skip. */
export function tetanusFieldsFrom(raws: string[]): { raw: string; fields: Partial<TetanusRule> & { tokens?: string[] }; why: string[] } | Skip {
  let gov: { raw: string; fields: Partial<TetanusRule> & { tokens?: string[] }; why: string[] } | null = null;
  for (const r of raws) {
    if (!/\btetanus\b/i.test(r)) continue;
    const p = parseTetanusFields(r);
    if (Object.keys(p.fields).length && (/VACCINE_AND_TIG/.test(r) || p.fields.lowMax !== undefined || p.fields.tetanusNames)) { gov = { raw: r, ...p }; continue; }
    if (gov && /\b(?:instead|change[sd]?|update[sd]?|from now|no longer|going forward|correction|amend\w*|count only|do(?:es)? not count|don'?t count|also count|starting|effective)\b/i.test(r)) return { skip: "a later message about tetanus changes the rule in a way we can't apply" };
  }
  return gov ?? { skip: "no tetanus message received" };
}
/** The governing tetanus message among the stored messages: the LATEST one whose rule parses. A later
 *  message about tetanus that doesn't parse (an amendment we can't apply) → skip. */
export function tetanusRuleFrom(raws: string[]): TetanusRule | Skip {
  let rule: TetanusRule | Skip = { skip: "no tetanus message received" };
  for (const r of raws) {
    if (!/\btetanus\b/i.test(r)) continue;
    const p = parseTetanusRule(r);
    if (!isSkip(p)) { rule = p; continue; }
    // a later tetanus message that reads like a change we can't parse → don't apply a stale rule
    if (!isSkip(rule) && /\b(?:instead|change[sd]?|update[sd]?|from now|no longer|going forward|correction|amend\w*|count only|do(?:es)? not count|don'?t count|also count|starting|effective)\b/i.test(r)) return { skip: "a later message about tetanus changes the rule in a way we can't apply" };
  }
  return rule;
}

// ───────────────────────────── Routing / slots (paraphrase-robust) ─────────────────────────────
const DATE_TOKEN = new RegExp(`\\b(?:\\d{4}-\\d{2}-\\d{2}|\\d{1,2}/\\d{1,2}/\\d{4}|(?:${MONTHS_RE})\\.? \\d{1,2}(?:st|nd|rd|th)?,? \\d{4}|\\d{1,2} (?:${MONTHS_RE})\\.?,? \\d{4})\\b`, "gi");
const DOB_CUE = /\b(?:born(?: on)?|DOB|D\.O\.B\.|date of birth|birthdate|birthday|b\.)\s*:?\s*$/i;
function datesIn(text: string): Array<{ iso: string; dob: boolean; at: number }> | null {
  const out: Array<{ iso: string; dob: boolean; at: number }> = [];
  for (const m of text.matchAll(DATE_TOKEN)) {
    const raw = m[0].replace(/(\d)(?:st|nd|rd|th)/i, "$1");
    const d = parseDate(raw, "MDY");                     // US site: a bare slash date is month-first
    if (!d || d === "ambiguous") return null;
    out.push({ iso: d, dob: DOB_CUE.test(text.slice(Math.max(0, m.index! - 22), m.index!).replace(/[(\[,]\s*$/, "")), at: m.index! });
  }
  return out;
}
const NAME_STOP = new Set("tetanus what doing i want the for on in at was were is are did does do should could would can may please patient pt chart review wound wounds visit visits dob born seen came vaccine vaccines tig and or nothing due came recall lot how many our we who which when where why td tdap dtap hi hey quick question check checking need needed needs got gotten get".split(" "));
const MONTH_WORD = new RegExp(`^(?:${MONTHS_RE})$`, "i");
/** The one person name in a request: "First Last", "First Middle Last", or "Last, First". null when
 *  there is not exactly one candidate. */
export function personName(text: string): string | null {
  const t = text.replace(DATE_TOKEN, " # ").replace(/(\p{Ll}{2,})\.(?=\s|$)/gu, "$1 ;"); // "Douglas. What" → "Douglas ; What"
  const W = "[A-ZÀ-Ý][\\p{L}'’.-]*";
  const cands = new Set<string>();
  const re = new RegExp(`(${W}(?:\\s+${W}){0,3})(?:,\\s+(${W}(?:\\s+${W})?))?`, "gu");
  for (const m of t.matchAll(re)) {
    const pick = (s: string) => s.split(/\s+/).map((w) => w.replace(/['’]s$/, "")).filter((w) => !NAME_STOP.has(w.toLowerCase().replace(/[.'’]+$/g, "")) && !MONTH_WORD.test(w)); // "Walker's" → "Walker"
    let a = pick(m[1]);
    const b = m[2] ? pick(m[2]) : [];
    // "Last, First" only when both halves are single/double name words; else the comma is a clause break
    if (b.length && a.length === 1 && b.length <= 2 && m[2]!.split(/\s+/).length === b.length) { cands.add(`${a[0]}, ${b.join(" ")}`); continue; }
    if (a.length >= 2) cands.add(a.join(" "));
    if (b.length >= 2) cands.add(b.join(" "));
  }
  return cands.size === 1 ? [...cands][0] : null;
}
/** Tetanus-wound request → {name, dob?, visit}. Requires the meaning (what was due/indicated for
 *  tetanus at a wound visit), not Set 1's wording. Questions ABOUT doses (last shot, how many, lot)
 *  don't route. */
export function tetanusSlots(text: string): { name: string; dob?: string; visit: string } | null {
  if (!/\btetanus\b|\bTIG\b|immune globulin/i.test(text)) return null;
  const about = /\b(?:wound|laceration|cut|bite|bitten|injur(?:y|ed)|puncture|burn|came in|seen|visit|urgent care|ER)\b/i.test(text);
  const due = /\b(?:due|should(?: have)?|gotten|owed|indicated|need(?:ed)?|warranted|recommend(?:ed|ation)?|right|call(?:ed)? for|correct|decision|prophylaxis)\b/i.test(text);
  const options = /\bvaccine(?:,)?\s*(?:and|\+|plus|with)\s*(?:TIG|immune globulin)\b/i.test(text);   // the answer's own options
  // A choice among the answer's options ("a shot, a shot plus immune globulin, or nothing") is not a yes/no question.
  const choice = /\b(?:TIG|immune globulin)\b/i.test(text) && /,?\s+or\s+(?:nothing|neither|none)\b/i.test(text);
  const off = /\b(?:when was|last (?:tetanus )?(?:shot|dose|booster)|how many (?:tetanus )?(?:shots|doses)|which lot|what lot|lot number|recall|phone|address|invoice|claim|insurance|appointment (?:time|count))\b/i.test(text)
    || (!choice && /^\s*(?:was|were|did|has|have|is|does)\b/i.test(text));                     // yes/no questions about what happened
  if (!(options || choice || (about && due)) || off) return null;
  const ds = datesIn(text); if (!ds) return null;
  const dob = ds.filter((d) => d.dob), visit = ds.filter((d) => !d.dob);
  if (dob.length > 1 || visit.length !== 1) return null;
  const name = personName(text); if (!name) return null;
  return { name, ...(dob.length ? { dob: dob[0].iso } : {}), visit: visit[0].iso };
}
const LOT_RE = /\blot(?:\s+(?:number|no\.?|#))?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{3,13})\b/i;
/** "the C482FU1 vaccine lot" / "the C482FU1 lot": the id written before the word lot (letters AND digits, upper case). */
const LOT_BEFORE_RE = /\b((?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z])[A-Z0-9][A-Z0-9-]{3,13})\s+(?:vaccine\s+)?lot\b/;
/** Recall request → {lot}. Requires recall + a count of patients still to notify. */
export function recallSlots(text: string): { lot: string } | null {
  if (!/\brecall(?:ed|s|ing)?\b/i.test(text)) return null;
  const notify = /\b(?:notif(?:y|ied|ications?)|un-?notified|told|tell|contact(?:ed)?|letters?|notices?|reach(?:ed)?|inform(?:ed)?|alert(?:ed)?)\b/i.test(text);
  const left = /\b(?:left|still|remain(?:s|ing)?|outstanding|not yet|haven'?t|have not|yet to|pending|need(?:s)? to|un-?notified)\b/i.test(text);
  const count = /\b(?:how many|count|number of|patients? left|total)\b/i.test(text)
    || /\b(?:outstanding|pending) notifications?\b|\bpatients? (?:pending|still|not yet|remaining|outstanding)\b|\bun-?notified patients\b/i.test(text);
  if (!notify || !left || !count) return null;
  if (/^\s*(?:is|are|was|were|has|have|did|does|do)\b/i.test(text)) return null;          // yes/no question
  if (/(?:^|[.?!:]\s+)(?:when|which|who|what (?:date|day|time|vaccine|location))\b/i.test(text)) return null; // asks something else
  const ids = new Set<string>();
  for (const m of text.matchAll(new RegExp(LOT_RE.source, "gi"))) if (/\d/.test(m[1])) ids.add(m[1].toUpperCase()); // "lot recall": not an id
  for (const m of text.matchAll(new RegExp(LOT_BEFORE_RE.source, "g"))) ids.add(m[1].toUpperCase());
  if (ids.size !== 1) return null;
  const lot = [...ids][0];
  if (!/\d/.test(lot) || !/[A-Z]/.test(lot)) return null;
  return { lot };
}

// ───────────────────────────── Recall (pure count; reader still unverified) ─────────────────────────────
export type LotDoseRow = { patientId: string; status: string; testRecord: boolean };
export type LotNote = { patientId: string; dateISO: string; time?: string; body: string; testRecord: boolean };
export type RecallNoteKind = "dose" | "notified" | "returned" | "not-notification" | "no-dose" | "outside-dose" | "irrelevant" | "unclear";
const LOT_TOKEN = /\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{6,10}\b/g;
const ASKED = /\b(?:asked|called|calling|wrote in|question|concerned|wondering)\b/i;
const DELIVERED = "(?:sent|mailed|delivered|handed|given)";
const NO_LETTER = new RegExp(`\\bno (?:recall )?(?:letter|notice)\\b[^.]{0,20}\\b(?:needed|required|${DELIVERED})\\b|\\b(?:not|never|wasn'?t|hasn'?t been|has not been|was not) (?:been )?(?:needed|required|${DELIVERED})\\b|\\bno need\\b`, "i");
const NEGATED = /\b(?:not|never|no|unable|failed|couldn'?t|could not|wasn'?t|didn'?t|did not)\b/i;
/** A note that names the lot, sorted into the message's kinds; anything else → unclear (skip the task).
 *  Templates seen in Set 1 (run 265 note search, fixtures/recall/note-search-*.html): "Recall notice for <vaccine> lot L mailed to
 *  <first> at the address on file." / "Letter about the recall of vaccine lot L sent to <first> through the patient portal." /
 *  "Recall letter for lot L given to <first> in person at the front desk." (notified); "<first> asked about the recall of lot L.
 *  <first> did not receive a dose from that lot. No recall letter was sent." and "<first> called to ask whether the vaccine given
 *  here was from recalled lot R. It was not: the chart shows lot C. No letter is needed." (no dose; L is R or C); dose notes
 *  "Procedure note: <vaccine> … Lot L, expires …", "<vaccine> given today …, lot number L", "Procedure note: … administered at
 *  this visit …. Lot L", "Nurse visit. Gave <vaccine> … (lot L)". Anything outside these shapes stays unclear. */
export function classifyRecallNote(body: string, lot: string): RecallNoteKind {
  const L = lot.toUpperCase(), U = body.toUpperCase();
  if (!new RegExp(`\\b${L}\\b`).test(U)) return "irrelevant";
  const others = new Set([...U.matchAll(LOT_TOKEN)].map((m) => m[0]).filter((t) => t !== L));
  // a patient's question about the recall: only the closed templates (dose not from the recalled lot, no letter owed)
  if (ASKED.test(body)) {
    if (!NO_LETTER.test(body)) return "unclear";
    if (/\bdid not receive a dose from (?:that|the|this) lot\b/i.test(body) && !others.size) return "no-dose";
    const m = body.match(/\brecalled lot\s+([A-Z0-9-]+)\s*\.\s*it was not:?\s*the chart shows lot\s+([A-Z0-9-]+)\s*\./i);
    const [r, c] = m ? [m[1].toUpperCase(), m[2].toUpperCase()] : ["", ""];
    if (m && r !== c && (r === L || c === L) && others.size === 1 && others.has(r === L ? c : r)) return "no-dose";
    return "unclear";
  }
  if (others.size) return "unclear"; // another lot named too
  if (/\b(?:will|to be|going to|plans? to|planned|needs? to|should|pending|scheduled|tomorrow|next week)\b/i.test(body)) return "unclear";
  const recallish = /\b(?:recall|recalled|notice|letter|notif(?:y|ied|ication))\b/i.test(body);
  if (recallish) {
    if (/\b(?:undeliverable|returned|came back|return to sender|bounced)\b/i.test(body)) return "returned";
    if (NO_LETTER.test(body)) return "not-notification";
    if (!NEGATED.test(body) && /\b(?:mailed|sent|handed|hand-delivered|delivered|portal|in person)\b/i.test(body)) return "notified";
    return "unclear";
  }
  if (/\b(?:given|gave|administered)\b/i.test(body) && new RegExp(`\\blot(?: number| no\\.?| #)?:?\\s*${L}\\b`, "i").test(body)) {
    // run s3a item 112 (captured): "William brought a receipt from Dunmore Urgent Care for MenACWY (Menveo) given there on 2025-11-19
    // (lot TF0252R). This clinic did not give the dose." = the message's "a dose that another clinic … gave, even if it has the same lot number"
    if (/\b(?:pharmacy|another clinic|other clinic|health department|elsewhere|outside|urgent care|given there|this clinic did not give|receipt from|(?:another|other|outside) (?:clinic|office|practice|provider|facility))\b/i.test(body)) return "outside-dose";
    if (/\b(?:procedure note|nurse visit|today|here|this visit)\b/i.test(body) && !/\b(?:declin|refus|offer|not given|ordered|says|reports?|reported|thinks|history|previous|prior|due)\w*/i.test(body)) return "dose";
  }
  return "unclear";
}
/** Patients dosed from the lot (Active entries + our own dose notes), minus those whose latest notice
 *  note says it was sent. Record identity = the chart link (merged duplicates open the main chart). */
export function recallCount(rows: LotDoseRow[], notes: LotNote[], lot: string): string | Skip {
  const dosed = new Set<string>();
  for (const r of rows) {
    if (r.testRecord) continue;
    if (/entered in error/i.test(r.status)) continue;
    if (!/^active$/i.test(r.status.trim())) return { skip: `lot entry status "${r.status}" not understood` };
    dosed.add(r.patientId);
  }
  const events = new Map<string, Array<{ at: string; sent: boolean }>>();
  for (const n of notes) {
    if (n.testRecord) continue;
    const k = classifyRecallNote(n.body, lot);
    if (k === "unclear") return { skip: `cannot classify a ${n.dateISO} note about lot ${lot}` };
    if (k === "dose") dosed.add(n.patientId);
    if (k === "notified" || k === "returned") { const a = events.get(n.patientId) ?? []; a.push({ at: `${n.dateISO} ${n.time ?? ""}`, sent: k === "notified" }); events.set(n.patientId, a); }
  }
  let left = 0;
  for (const p of dosed) {
    const ev = (events.get(p) ?? []).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    if (ev.length >= 2 && ev[ev.length - 1].at === ev[ev.length - 2].at && ev[ev.length - 1].sent !== ev[ev.length - 2].sent) return { skip: "sent and returned notes at the same time" };
    if (!(ev.length && ev[ev.length - 1].sent)) left++;
  }
  return String(left);
}
