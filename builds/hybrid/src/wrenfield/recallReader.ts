/**
 * vaccine-lot-recall reader: Vaccines → Lots (filter "Lot number") → each lot's detail page ("Chart entries
 * with this lot") → Vaccines → Note search (the lot) → the message's count (immunizations.recallCount).
 *
 * What the captured Set 1 pages PROVE (run-146 probes): the lot list (/vaccines: table "Vaccine lots, newest
 * first", headers Lot number | Vaccine | Location | Received | Expires | Doses received, every location of the
 * group, a "Lot number" filter + Apply, "Showing 1 to 25 of 1,000+ lots") and an EMPTY lot detail page
 * (sections Lot / Storage / "Chart entries with this lot": "No chart entry names this lot"). Lot numbers are
 * drawn in the per-session scrambled digit font (the raw heading read U35B31K for lot U26B21K), so every cell
 * is decoded per font family (claimReader.famMapsFor) — and the filter is proven on a lot read off the list
 * (positive control, once per shift) before an empty result is taken as UNKNOWN_LOT.
 *
 * The chart-entry table WAS captured in Set 1 run 278 (fixtures/recall/*.html; recallEntries.test.ts): headers Date given |
 * Patient | Date of birth | MRN | Given by | Entry (Active / Entered in error), a Test record / Restricted badge in the Patient
 * cell, and the footer "N entries" or "Showing 1 to 25 of 27 entries" (+ Rows per page, Previous/1/2/Next). It is read by
 * header label against a closed set of known columns and walked with walkList: the page size is raised, then Next, until
 * an EXACT total (listFooter/isComplete) is reached by the rows read; "N+", "about N", a missing footer or a page that
 * does not continue the last declines.
 *
 * The note search WAS captured in Set 1 run 265 (fixtures/recall/note-search-*.html; recallNotes.test.ts): not a table but a
 * list "Notes found, newest first" of cards (article: header = kind, patient link + badges, born / MRN, author, <time
 * datetime=UTC>; p = the note) and the footer "16 notes" outside the cards. Cards are read by structure (RECALL_JS `cards`),
 * the footer is proven by the same completeness rule (an exact total the cards reach); every note is sorted by
 * immunizations.classifyRecallNote into the message's kinds and any shape outside the captured/closed templates declines.
 * Pages are logged as {"event":"recall_probe"} only when the reader declines them. Counts can be turned off with
 * RECALL_COUNTS=0 (UNKNOWN_LOT answers stay on).
 */
import type { Crawler } from "./crawl.js";
import { why } from "./why.js";
import { CLAIM_JS, famMapsFor, textOf, rawOf, type FamMaps, type PPage, type PCell, type PTable, type PSection } from "./claimReader.js";
import { isDecline, type Decline } from "./familyReaders.js";
import { norm } from "./pageSnapshot.js";
import { listFooter, isComplete, type ListFooter } from "./listFooter.js";
import { recallCount, isSkip, type LotDoseRow, type LotNote } from "./immunizations.js";

const D = (w: string): Decline => ({ decline: "recall: " + w });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BAD_PAGE = /not responding|try again in a moment|something went wrong|error loading|account is suspended/i;

// ════════════════════════════ policy (governing message) ════════════════════════════

export type RecallPolicy = { unknownToken: string };
export const isRecallPolicy = (raw: string) => /\brecall/i.test(raw) && /\blot\b/i.test(raw) && /\bnotif/i.test(raw) && /\binventory\b/i.test(raw) && /\bentered in error\b/i.test(raw);
/** The answer token for a lot no location stocks, and the pieces of the rule the engine implements; a
 *  message that drops one of them is not the rule this reader knows → decline. */
/** The recall rule field by field: `unknownToken` (the answer for a lot no location stocks) and
 *  `countRules` (every rule a patient count relies on). UNKNOWN_LOT needs only the token; a count needs
 *  the rules. */
export function parseRecallFields(raw: string): { fields: { unknownToken?: string; countRules?: boolean }; why: string[] } {
  const why: string[] = []; const f: { unknownToken?: string; countRules?: boolean } = {};
  const tok = raw.match(/no location[^.]*inventory[^.]*answer\s+`([A-Z_]+)`/i) ?? raw.match(/answer\s+`([A-Z][A-Z_]*LOT[A-Z_]*)`/);
  if (tok) f.unknownToken = tok[1]; else why.push("message gives no answer for a lot not in inventory");
  const miss = ([[/\bActive chart entr/i, "Active entries"], [/\bentered in error\b/i, "entered in error"], [/\btest record/i, "test records"],
    [/\bmerged\b/i, "merged records"], [/\bundeliverable|returned\b/i, "returned letters"], [/\blater note\b/i, "latest note wins"], [/\bwhole number\b/i, "number format"]] as Array<[RegExp, string]>)
    .filter(([re]) => !re.test(raw)).map(([, w]) => w);
  if (miss.length) why.push(`message no longer states the ${miss.join(", ")} rule`); else f.countRules = true;
  return { fields: f, why };
}
export function parseRecallPolicy(raw: string): RecallPolicy | Decline {
  const { fields, why } = parseRecallFields(raw);
  if (why.length) return D(why[0]);
  return { unknownToken: fields.unknownToken! };
}
/** A later message about recalls/lots/notification changes the rule → decline (not modelled). */
export function recallAmendmentBlocks(later: string[]): string | null {
  for (const m of later) if (/\brecall|\bvaccine lots?\b|\blot (?:number|[A-Z0-9]{5,})/i.test(m) && /\b(?:notif|letter|notice|count|lot)/i.test(m)) return "a later message changes the recall rule: " + m.slice(0, 80);
  return null;
}

// ════════════════════════════ pure page parsers (tested on captured markup) ════════════════════════════

/** A note-search result card (RECALL_JS): the patient cell (link + badges), the number of links in the header, its <time datetime>
 *  values, and the card's text outside the header. */
export type PCard = { patient: PCell | null; links: number; times: string[]; body: PCell };
/** The page as RECALL_JS reads it: cards (every visible <article>) and the page text outside them (where a list's footer is). */
export type RPage = PPage & { cards?: PCard[]; outside?: string };

const colOf = (headers: string[], want: RegExp): number => { const h = headers.map((x, i) => [norm(x), i] as const).filter(([x]) => want.test(x)); return h.length === 1 ? h[0][1] : h.length ? -2 : -1; };
export type LotRow = { lot: string; location: string; vaccine: string; href: string | null };
/** The lot list's table: columns by label; lot numbers decoded. */
export function lotRowsOf(p: PPage, fm: FamMaps): { rows: LotRow[]; table: boolean; pager: { to: number; total: number; plus: boolean } | null } | Decline {
  if (BAD_PAGE.test(p.text)) return D("the lots page says the app is not responding");
  const all = uniqTables(p);
  const cand = all.filter((t) => colOf(t.headers, /^lot(?: number| no| #)?$/) >= 0 && colOf(t.headers, /^(?:location|site|clinic)$/) >= 0);
  const pg = p.text.match(/Showing\s+(\d[\d,]*)\s+to\s+(\d[\d,]*)\s+of\s+(\d[\d,]*)(\+?)\s+lots?/i);
  const pager = pg ? { to: +pg[2].replace(/,/g, ""), total: +pg[3].replace(/,/g, ""), plus: pg[4] === "+" } : null;
  if (!cand.length) return { rows: [], table: false, pager };
  if (cand.length > 1) return D("two lot tables on the lots page");
  const t = cand[0];
  const iL = colOf(t.headers, /^lot(?: number| no| #)?$/), iLoc = colOf(t.headers, /^(?:location|site|clinic)$/), iV = colOf(t.headers, /^vaccine$|^product$/);
  const rows: LotRow[] = [];
  for (const r of t.rows) {
    const lot = textOf(r[iL], fm), loc = textOf(r[iLoc], fm);
    if (lot == null || loc == null) return D("a lot number is drawn in a font that could not be decoded");
    if (!/^[A-Z0-9-]{3,16}$/i.test(lot.trim())) return D(`lot cell "${lot.slice(0, 30)}" is not a lot number`);
    rows.push({ lot: lot.trim().toUpperCase(), location: loc.trim(), vaccine: iV >= 0 ? (textOf(r[iV], fm) ?? "").trim() : "", href: r[iL]?.href ?? r.map((c) => c.href).find((h) => !!h && /lot/i.test(h)) ?? null });
  }
  return { rows, table: true, pager };
}
function uniqTables(p: PPage): PTable[] {
  const seen = new Set<string>(); const out: PTable[] = [];
  for (const s of p.sections) for (const t of s.tables) { const k = JSON.stringify(t); if (!seen.has(k)) { seen.add(k); out.push(t); } }
  return out;
}

export type EntryRow = LotDoseRow & { name: string; dob?: string };
const PATIENT_HREF = /^\/patients\/([^/?#]+)/;
/** Badges a patient cell may carry besides the name; anything else (Merged, Deleted, Duplicate…) declines. */
const TEST_BADGE = /^test(?: record| patient)?$/i;
function patientOf(cell: PCell, fm: FamMaps): { href: string; name: string; test: boolean } | Decline {
  const m = (cell.href ?? "").match(PATIENT_HREF);
  if (!m) return D("a row's patient has no chart link");
  const full = textOf(cell, fm); if (full == null) return D("a patient cell is drawn in an undecodable font");
  const name = (cell.atext ?? "").replace(/\s+/g, " ").trim();
  if (!name) return D("a patient link has no name");
  if (/merged|duplicate|deleted/i.test(full)) return D("a merged/duplicate/deleted record in the list");
  const flat = full.replace(/\s+/g, " ").trim();
  if (!flat.startsWith(name)) return D("patient cell text does not start with the linked name");
  // what follows the name: known badges only (as separate words or glued spans)
  let left = flat.slice(name.length).trim(); const rest: string[] = [];
  for (let g = 0; left && g < 4; g++) { const m = left.match(/^(test record|test patient|restricted|test)\b\s*/i); if (!m) break; rest.push(m[1]); left = left.slice(m[0].length); }
  if (left) return D(`patient badge "${left.slice(0, 30)}" not understood`);
  return { href: `/patients/${m[1]}`, name, test: rest.some((b) => TEST_BADGE.test(b)) };
}

// ── list pages: one grammar, one completeness rule (listFooter.ts) ──
/** One page of a list: its rows, the size statement it makes, and its header labels. `empty`: the page's explicit empty
 *  statement (no table). */
export type PageList<T> = { rows: T[]; footer: ListFooter | null; headers: string[]; empty: boolean };
/** The lines of a section/page text that state a list size ("12 entries", "Showing 1 to 25 of 27 entries", "No notes"),
 *  parsed with the shared grammar. Only count-like lines are offered, so table rows can't be mistaken for a footer. */
const COUNT_LINE = /^(?:showing\b|[\d,]+\s*(?:to|-|–|—|through)\s*[\d,]+\s+of\b|(?:about|approx\.?|approximately|around|roughly|~)\s*[\d,]|[\d,]+\+?\s+[a-z]|no\s+[a-z]|nothing\b|page\s+\d)/i;
export function footerOf(text: string, nounRe: RegExp): ListFooter | null {
  const lines = text.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter((l) => COUNT_LINE.test(l));
  return listFooter(lines.join("\n"), nounRe);
}

/** The columns a lot's chart-entry table may have (by label; reordered or missing ones are fine). A header outside this
 *  set declines: an unknown column could carry a meaning the rule cares about (a status, a merge, a test flag). */
const ENTRY_COLS: Array<[string, RegExp]> = [
  ["patient", /^(?:patient|patient name|name)$/],
  ["status", /^(?:status|entry status|entry state|record status|state|entry)$/],
  ["date", /^(?:date given|given|date|date administered|administered|given on)$/],
  ["dob", /^(?:date of birth|dob|birth date|birthdate|born)$/],
  ["mrn", /^(?:mrn|record number|record no|record|medical record number)$/],
  ["by", /^(?:given by|administered by|clinician|provider|vaccinator|recorded by)$/],
  ["vaccine", /^(?:vaccine|product)$/],
  ["location", /^(?:location|site|clinic)$/],
];
/** Header label → column kinds; null when a header is unknown or a kind occurs twice. */
function entryColumns(headers: string[]): Record<string, number> | null {
  const at: Record<string, number> = {};
  for (let i = 0; i < headers.length; i++) {
    const k = ENTRY_COLS.filter(([, re]) => re.test(norm(headers[i]))).map(([n]) => n);
    if (k.length !== 1 || k[0] in at) return null;
    at[k[0]] = i;
  }
  return "patient" in at && "status" in at ? at : null;
}
/** One page of "Chart entries with this lot" on a lot detail page. rows [] + empty only on the page's explicit empty
 *  statement. The footer is what the page says about its own size (completeness is decided by walkList). */
export function entryPageOf(p: PPage, fm: FamMaps): PageList<EntryRow> | Decline {
  if (BAD_PAGE.test(p.text)) return D("the lot page says the app is not responding");
  const secs = p.sections.filter((s) => /chart entr/.test(norm(s.heading)) || /chart entr/.test(norm(s.label)));
  const inner = secs.filter((s) => !secs.some((o) => o !== s && s.text.includes(o.text) && o.text.length < s.text.length));
  if (inner.length !== 1) return D(inner.length ? "several chart-entry sections" : "no \"Chart entries with this lot\" section");
  const s: PSection = inner[0];
  const footer = footerOf(s.text, /^entr/i);
  if (!s.tables.length) {
    if (/\bno chart entr(?:y|ies)\b/i.test(s.text) && !s.links.some((l) => PATIENT_HREF.test(l.href))) return { rows: [], footer, headers: [], empty: true };
    return D("chart-entry section has neither a table nor the empty statement");
  }
  if (s.tables.length > 1) return D("chart-entry section has several tables");
  const t = s.tables[0];
  const at = entryColumns(t.headers);
  if (!at) return D(`chart-entry columns not understood (${t.headers.join(" | ")})`);
  const iP = at.patient, iS = at.status;
  const out: EntryRow[] = [];
  for (const r of t.rows) {
    if (r.length !== t.headers.length) return D("a chart-entry row does not have one cell per column");
    const pt = patientOf(r[iP], fm); if (isDecline(pt)) return pt;
    const st = (textOf(r[iS], fm) ?? "").replace(/\s+/g, " ").trim();
    const other = r.filter((_, i) => i !== iP && i !== iS).map((c) => rawOf(c)).join(" ");
    const test = pt.test || /\btest record\b/i.test(other);
    out.push({ patientId: pt.href, name: pt.name, status: st, testRecord: test, ...(at.dob !== undefined ? { dob: textOf(r[at.dob], fm) ?? "" } : {}) });
  }
  if (!out.length) return D("chart-entry table has no rows");
  return { rows: out, footer, headers: t.headers, empty: false };
}
/** A lot's chart entries when ONE page proves itself complete (its own footer states an exact total the rows reach);
 *  anything else (a pager with more pages, a capped or estimated total, no footer) declines. The live reader walks the
 *  pages with walkList; this is the single-page form. */
export function lotEntriesOf(p: PPage, fm: FamMaps): EntryRow[] | Decline {
  const pg = entryPageOf(p, fm); if (isDecline(pg)) return pg;
  if (pg.empty) return [];
  const v = isComplete(pg.rows.length, pg.footer);
  return v.complete ? pg.rows : D(`chart entries not proven complete: ${v.why}`);
}

/** The IO a list walk needs (live: the Crawler; tests: a fake site). */
export type ListIO = {
  /** The current page, settled, with its font maps. */
  read(): Promise<{ page: PPage; fm: FamMaps } | Decline>;
  /** Set "Rows per page" to its largest option; false when there is no such control or it was already largest. */
  raise(): Promise<boolean>;
  /** Press Next; resolves once the page shows a range starting at `from`. */
  next(from: number): Promise<boolean>;
};
/** Read a whole list: raise the page size, then Next until an EXACT total is reached by the rows read. A "+" or "about"
 *  total, a page whose range does not continue the last one, a changed header or a footer that is missing declines. */
export async function walkList<T>(io: ListIO, parse: (p: PPage, fm: FamMaps) => PageList<T> | Decline, maxPages = 12): Promise<T[] | Decline> {
  const take = async (): Promise<PageList<T> | Decline> => { const r = await io.read(); if (isDecline(r)) return r; return parse(r.page, r.fm); };
  let pg = await take(); if (isDecline(pg)) return pg;
  if (pg.empty) return [];
  const f0 = pg.footer;
  if (!f0) return D("list page states no size, so its end is unproven");
  if (f0.kind !== "exact") { const v = isComplete(pg.rows.length, f0); return D(v.complete ? "" : v.why); }
  if (!f0.cumulative && !f0.end && f0.to < f0.total && (await io.raise().catch(() => false))) {
    const big = await take(); if (isDecline(big)) return big;
    if (!big.footer || big.footer.kind !== "exact" || big.footer.total !== f0.total || big.footer.from !== 1) return D("the list changed when Rows per page was raised");
    if (big.headers.join("|") !== pg.headers.join("|")) return D("list columns changed when Rows per page was raised");
    pg = big;
  }
  const rows: T[] = [...pg.rows]; let f = pg.footer!; const headers = pg.headers;
  const sane = (q: PageList<T>) => !!q.footer && q.footer.kind === "exact" && q.footer.to >= 0 && q.footer.to - q.footer.from + 1 === q.rows.length;
  if (!sane(pg)) return D("a page's rows do not match its own range");
  for (let guard = 0; guard < maxPages; guard++) {
    const v = isComplete(rows.length, f);
    if (v.complete) return rows;
    if (f.kind !== "exact" || f.cumulative || f.end || f.page !== undefined || f.to >= f.total) return D(v.complete ? "" : v.why);
    const from = f.to + 1;
    if (!(await io.next(from).catch(() => false))) return D(`the list has more pages (${f.text}) but Next did not advance`);
    const nx = await take(); if (isDecline(nx)) return nx;
    if (nx.headers.join("|") !== headers.join("|")) return D("list columns changed between pages");
    const g = nx.footer;
    if (!g || g.kind !== "exact" || g.cumulative || g.end || g.from !== from || g.total !== f.total || g.to < g.from) return D(`page after "${f.text}" does not continue it ("${g?.text ?? "no footer"}")`);
    if (!sane(nx)) return D("a page's rows do not match its own range");
    rows.push(...nx.rows); f = g;
  }
  return D("the list has more pages than the walk allows");
}

export type NoteRow = LotNote & { name: string };
const NOTE_NOUN = /^(?:notes?|results?|matches|matching|entr)/i;
/** One page of note-search results. The real layout (Set 1 run 265, fixtures/recall/note-search-*.html): a list "Notes found,
 *  newest first" of cards (article: header = kind, patient link + badges, born / MRN, author, <time datetime=UTC>; p = the note's
 *  text) and a footer line "16 notes" (outside the cards). Decline on a card without exactly one patient link, an unknown badge,
 *  a time that is not a UTC stamp, text that is cut short or does not contain the lot (search not applied). */
export function notePageOf(p: RPage, fm: FamMaps, lot: string): PageList<NoteRow> | Decline {
  if (BAD_PAGE.test(p.text)) return D("the note search says the app is not responding");
  const footer = footerOf(p.outside ?? p.text, NOTE_NOUN);
  const cards = (p.cards ?? []).filter((c) => c.patient || c.links || c.times.length);   // an <article> without a note header is not a note (an empty-state box)
  if (!cards.length) {
    if (/\bno (?:notes?|results?|matches|matching notes?)\b/i.test(p.text) || footer?.none || (footer?.kind === "exact" && footer.total === 0)) return { rows: [], footer, headers: [], empty: true };
    return D("note search shows neither a list of notes nor an empty statement");
  }
  const out: NoteRow[] = [];
  for (const c of cards) {
    if (!c.patient || c.links !== 1) return D("a note has no single patient link");
    const pt = patientOf(c.patient, fm); if (isDecline(pt)) return pt;
    const at = (c.times.length === 1 ? c.times[0] : "").match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?Z$/);
    if (!at) return D("a note's time is not a single UTC stamp");
    const body = (textOf(c.body, fm) ?? "").replace(/\s+/g, " ").trim();
    if (!body) return D("a note result has no text (undecodable or empty)");
    if (/(?:…|\.\.\.)\s*$/.test(body)) return D("note text is cut short in the results");
    if (!body.toUpperCase().includes(lot)) return D("a note result does not contain the lot (search not applied?)");
    out.push({ patientId: pt.href, name: pt.name, dateISO: at[1], time: at[2], body, testRecord: pt.test });
  }
  return { rows: out, footer, headers: [], empty: false };
}
/** Note-search results when ONE page proves itself complete (exact total reached); the live reader walks pages. */
export function noteResultsOf(p: RPage, fm: FamMaps, lot: string): NoteRow[] | Decline {
  const pg = notePageOf(p, fm, lot); if (isDecline(pg)) return pg;
  if (pg.empty) return [];
  const v = isComplete(pg.rows.length, pg.footer);
  return v.complete ? pg.rows : D(`note results not proven complete: ${v.why}`);
}

/** a and b differ by at most one inserted, deleted or replaced character. */
function editWithin1(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i === a.length && i === b.length) return true;
  const ra = a.slice(i + 1), rb = b.slice(i + 1);
  return ra === rb || a.slice(i) === rb || ra === b.slice(i);
}
/** The count, with the identity guards the message's "one record number" rule needs. */
export function recallAnswer(entries: EntryRow[], notes: NoteRow[], lot: string): string | Decline {
  const names = new Map<string, string>();
  for (const r of [...entries, ...notes]) if (!r.testRecord) names.set(r.patientId, norm(r.name));
  const byName = new Map<string, string>();
  for (const [id, n] of names) { const o = byName.get(n); if (o && o !== id) return D(`two records named "${n}" (merged duplicate or namesake) — record identity unproven`); byName.set(n, id); }
  // near-twin records: the same birth date (as drawn on this page) and a name one edit apart — a misspelled duplicate
  // of one patient would otherwise be counted twice
  const dobs = new Map<string, Array<{ id: string; n: string }>>();
  for (const e of entries) if (!e.testRecord && e.dob) { const a = dobs.get(e.dob) ?? []; if (!a.some((x) => x.id === e.patientId)) a.push({ id: e.patientId, n: norm(e.name) }); dobs.set(e.dob, a); }
  for (const a of dobs.values()) for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) if (editWithin1(a[i].n, a[j].n)) return D(`records "${a[i].n}" and "${a[j].n}" share a birth date and nearly a name — possible duplicate`);
  const r = recallCount(entries, notes, lot);
  return isSkip(r) ? D(r.skip) : r;
}

// ════════════════════════════ live ════════════════════════════

/** CLAIM_JS collects tables only inside <section>/[role=region]; the real Set 1 lots list (run-164 skip probes,
 *  13 skips "the lots table did not appear") sits in plain <div>s — its only <section> is "Filters". RECALL_JS
 *  also takes every table outside all sections as its own pseudo-section (its nearest parent). */
const SEC_FALLBACK = "if (!secEls.length) secEls = [].slice.call(doc.querySelectorAll('h2')).map(function (h) { return h.parentElement; });";
if (!CLAIM_JS.includes(SEC_FALLBACK)) throw new Error("recallReader: CLAIM_JS section collection changed");
const RETURN_PAGE = "return { h1: h1 ? plain(h1) : '', sub: sub, text: plain(doc.body), sections: sections, families: Object.keys(fams) };";
if (!CLAIM_JS.includes(RETURN_PAGE)) throw new Error("recallReader: CLAIM_JS result changed");
/** The note search lists its results as cards (<article> outside any <section>), which CLAIM_JS does not return: RECALL_JS adds
 *  `cards` (header parts, body segments with their font families) and `outside` (the page text without the cards = the footer). */
export const RECALL_JS = CLAIM_JS.replace(SEC_FALLBACK, SEC_FALLBACK + `
  [].slice.call(doc.querySelectorAll('table')).forEach(function (t) {
    if (secEls.some(function (s) { return s && s.contains(t); })) return;
    var w = t.parentElement || t; if (secEls.indexOf(w) < 0) secEls.push(w);
  });`).replace(RETURN_PAGE, String.raw`
  var inHeader = function (n) { return n.tagName === 'HEADER'; };
  var cards = [].slice.call(doc.querySelectorAll('article')).filter(function (a) { return !hidden(a) && !a.querySelector('article') && !a.closest('[hidden],[aria-hidden="true"]'); }).map(function (a) {
    var hd = a.querySelector('header'), pa = hd ? hd.querySelector('a[href]') : null;
    return { patient: pa ? cellOf(pa.parentElement !== hd ? pa.parentElement : pa) : null,
      links: hd ? hd.querySelectorAll('a[href]').length : 0, times: hd ? [].slice.call(hd.querySelectorAll('time[datetime]')).map(function (t) { return t.getAttribute('datetime'); }) : [],
      body: { segs: segsOf(a, inHeader), href: null, atext: '', aria: '', times: [], imgs: 0 } };
  });
  var outside = segsOf(doc.body, function (n) { return n.tagName === 'ARTICLE'; }).map(function (x) { return x[0]; }).join('').replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
  return { h1: h1 ? plain(h1) : '', sub: sub, text: plain(doc.body), sections: sections, families: Object.keys(fams), cards: cards, outside: outside };`);
/** RECALL_JS against a document (jsdom in tests). */
export function recallPageOf(doc: any): RPage {
  // eslint-disable-next-line no-new-func
  return new Function("doc", "window", RECALL_JS)(doc, doc.defaultView) as RPage;
}
const page = (c: Crawler) => c.evalApp<RPage>(RECALL_JS);
async function waitPage(c: Crawler, ok: (p: PPage) => boolean, ms = 8000): Promise<PPage | null> {
  const t0 = Date.now(); let last = "";
  while (Date.now() - t0 < ms) {
    const p = await page(c).catch(() => null);
    if (p && ok(p)) { if (p.text === last) return p; last = p.text; await sleep(150); continue; } // settled: two equal reads
    last = ""; await sleep(150);
  }
  return null;
}
/** Fill the one text input whose label matches and submit its form (Apply/Search). */
async function fillAndSubmit(c: Crawler, label: string, value: string): Promise<string> {
  return c.evalApp<string>(`
    const T=e=>((e&&(e.innerText!=null?e.innerText:e.textContent))||'').replace(/\\s+/g,' ').trim();
    const labelOf=e=>{ let l=''; if(e.id){ const x=[...doc.querySelectorAll('label')].find(z=>z.getAttribute('for')===e.id); if(x) l=T(x); }
      if(!l){ const x=e.closest('label'); if(x) l=T(x); } if(!l) l=e.getAttribute('aria-label')||e.getAttribute('placeholder')||''; return l; };
    const re=new RegExp(${JSON.stringify(label)},'i');
    const ins=[...doc.querySelectorAll('input')].filter(e=>!e.closest('[aria-hidden="true"],[hidden]')&&/^(text|search|)$/.test((e.type||'').toLowerCase())&&re.test(labelOf(e)));
    if(ins.length!==1) return 'inputs:'+ins.length;
    const el=ins[0]; const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; set.call(el,${JSON.stringify(value)});
    el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
    const f=el.closest('form'); const scope=f||doc;
    const bs=[...scope.querySelectorAll('button,input[type=submit]')].filter(b=>/^(apply|search|filter|find|go|show)$/i.test(T(b)||b.value||''));
    if(bs.length===1){ bs[0].click(); return 'clicked'; }
    if(f&&f.requestSubmit){ f.requestSubmit(); return 'submitted'; }
    return 'nosubmit';`);
}
const inputValue = (c: Crawler, label: string) => c.evalApp<string>(`
  const T=e=>((e&&(e.innerText!=null?e.innerText:e.textContent))||'').replace(/\\s+/g,' ').trim();
  const re=new RegExp(${JSON.stringify(label)},'i');
  const el=[...doc.querySelectorAll('input')].find(e=>{ let l=''; if(e.id){const x=[...doc.querySelectorAll('label')].find(z=>z.getAttribute('for')===e.id); if(x) l=T(x);} if(!l){const x=e.closest('label'); if(x) l=T(x);} if(!l) l=e.getAttribute('aria-label')||e.getAttribute('placeholder')||''; return re.test(l); });
  return el?el.value:'';`).catch(() => "");
/** Every <select> on the page must sit on its "All …" option (no vaccine/location narrowing). */
const narrowed = (c: Crawler) => c.evalApp<string>(`
  const s=[...doc.querySelectorAll('select')].filter(x=>!x.closest('[aria-hidden="true"],[hidden]'));
  for(const x of s){ const o=x.options[x.selectedIndex]; const t=((o&&o.textContent)||'').trim(); if(/per page|rows/i.test(t)) continue; if(!/^all\\b/i.test(t)&&t!=='') return t; }
  return '';`).catch(() => "?");

async function lotsPage(c: Crawler): Promise<PPage | Decline> {
  const nav = await c.evalApp<string>(`const a=[...doc.querySelectorAll('nav a[href],aside a[href],header a[href]')].find(x=>/^\\s*vaccines?\\s*$/i.test(x.textContent||'')&&!/\\/patients\\//.test(x.getAttribute('href')||'')); return a?a.getAttribute('href'):''`).catch(() => "");
  const href = nav && !/^https?:/.test(nav) ? nav : "/vaccines";
  if (!(await c.navTo(href, /lot number/i, 8000, true).catch(() => false))) {
    // run 265 item 126: the app showed "This account is suspended" (an outage that also failed the neighbouring tasks), not a reader fault
    const bad = await page(c).catch(() => null);
    return D(bad && /account is suspended/i.test(bad.text) ? "the app says this account is suspended (outage)" : "the vaccine lots page did not load");
  }
  const p = await waitPage(c, (x) => uniqTables(x).some((t) => colOf(t.headers, /^lot(?: number| no| #)?$/) >= 0) && /lots?\b/i.test(x.text));
  return p ?? D("the lots table did not appear");
}
type Filtered = { rows: LotRow[]; fm: FamMaps };
async function filterLots(c: Crawler, lot: string): Promise<Filtered | Decline> {
  const first = await lotsPage(c); if (isDecline(first)) return first;
  const before = first.text;
  const r = await fillAndSubmit(c, "^\\s*lot(?: number| no\\.?| #)?\\s*$", lot).catch((e) => "threw " + String(e).slice(0, 40));
  if (!/clicked|submitted/.test(r)) return D(`could not use the Lot number filter (${r})`);
  const p = await waitPage(c, (x) => x.text !== before && !/loading/i.test(x.text.slice(0, 400)), 8000);
  if (!p) return D("the filtered lot list did not load");
  if ((await inputValue(c, "^\\s*lot(?: number| no\\.?| #)?\\s*$")).trim().toUpperCase() !== lot) return D("the Lot number filter does not show the asked lot after Apply");
  const n = await narrowed(c); if (n) return D(`the lot list is narrowed to "${n.slice(0, 30)}"`);
  const fm = await famMapsFor(c, p); if (isDecline(fm)) return D(fm.decline);
  const rs = lotRowsOf(p, fm); if (isDecline(rs)) return rs;
  if (rs.pager && (rs.pager.plus || rs.pager.to < rs.pager.total)) return D(`the filtered list has more than one page (${rs.pager.to} of ${rs.pager.total}${rs.pager.plus ? "+" : ""})`);
  if (!rs.table && !/\bno (?:lots?|results?|matches|matching)\b/i.test(p.text)) return D("filtered lot list shows neither rows nor an empty statement");
  return { rows: rs.rows, fm };
}

let control: true | string | null = null;     // the filter proven on a listed lot (once per shift)
let probes = 0; const probesBy: Record<string, number> = {};
export function resetRecall() { control = null; probes = 0; for (const k of Object.keys(probesBy)) delete probesBy[k]; }
async function proveFilter(c: Crawler, asked: string): Promise<true | string> {
  if (control) return control;
  const p = await lotsPage(c); if (isDecline(p)) return p.decline;
  const fm = await famMapsFor(c, p); if (isDecline(fm)) return fm.decline;
  const rs = lotRowsOf(p, fm); if (isDecline(rs)) return rs.decline;
  if (new Set(rs.rows.map((r) => r.location)).size < 2) return (control = "recall: the unfiltered lot list does not show several locations");
  const known = rs.rows.find((r) => r.lot !== asked);
  if (!known) return "recall: no listed lot to prove the filter on";
  const f = await filterLots(c, known.lot);
  if (isDecline(f)) return f.decline;                    // not cached: may be transient
  control = f.rows.some((r) => r.lot === known.lot) ? true : `recall: filter control failed (lot ${known.lot} from the list not found by the filter)`;
  return control;
}
async function logProbe(c: Crawler, tag: string, lot: string) {
  // capped: 8 per shift, 2 s per read, 40 kB; off when the pacer is behind
  const { pacer, capped } = await import("./pacer.js");
  // per tag: both populated layouts are captured (lot detail: Set 1 run 278; note search: run 265), so only a decline logs a page
  const cap = ({ "lot-detail": 2, "note-search-form": 2, "note-search-results": 2, "note-search-after": 2 } as Record<string, number>)[tag] ?? 1;
  if (probes >= 8 || (probesBy[tag] ?? 0) >= cap || !pacer.probeOk()) return; probes++; probesBy[tag] = (probesBy[tag] ?? 0) + 1;
  const html = (await capped(c.evalApp<string>(`const b=doc.body?doc.body.cloneNode(true):null; if(!b) return ''; b.querySelectorAll('script,style,svg').forEach(e=>e.remove()); const h=b.outerHTML; return h.length<=40000?h:h.slice(0,28000)+'<!-- cut -->'+h.slice(-12000);`), 2000)) ?? "";
  const url = (await capped(c.evalApp<string>(`return location.pathname+location.search`), 2000)) ?? "";
  try { process.stdout.write(JSON.stringify({ event: "recall_probe", page: tag, lot, url, html }) + "\n"); } catch {}
}

/** The live reader: lot → answer string, or null with why(). */
export function recallReader(c: Crawler) {
  return async (lot: string, policy: RecallPolicy): Promise<string | null> => {
    lot = lot.toUpperCase();
    const ctl = await proveFilter(c, lot);
    if (ctl !== true) { why(ctl); return null; }
    const f = await filterLots(c, lot);
    if (isDecline(f)) { why(f.decline); return null; }
    const hits = f.rows.filter((r) => r.lot === lot);
    if (!hits.length) return policy.unknownToken;        // proven filter, complete list, no lot with that number
    if (process.env.RECALL_COUNTS === "0") { why("recall: lot is stocked; counts are off (RECALL_COUNTS=0)"); return null; }
    if (hits.some((h) => !h.href || !/^\//.test(h.href))) { why("recall: a matching lot row has no detail link"); return null; }
    const entries: EntryRow[] = [];
    for (const h of hits) {
      if (!(await c.navTo(h.href!, /chart entr/i, 8000).catch(() => false))) { why("recall: lot detail page did not load"); return null; }
      const io = liveIO(c, (x) => x.sections.some((s) => /chart entr/.test(norm(s.heading))), entryFooterOf);
      const e = await walkList(io, entryPageOf);
      if (isDecline(e)) { await logProbe(c, "lot-detail", lot); why(e.decline); return null; }
      entries.push(...e);
    }
    const notes = await searchNotes(c, lot);
    if (isDecline(notes)) { why(notes.decline); return null; }
    const a = recallAnswer(entries, notes, lot);
    if (isDecline(a)) { why(a.decline); return null; }
    return a;
  };
}
export async function searchNotes(c: Crawler, lot: string): Promise<NoteRow[] | Decline> {
  const nav = await c.evalApp<string>(`const a=[...doc.querySelectorAll('nav a[href]')].find(x=>/^\\s*note search\\s*$/i.test(x.textContent||'')); return a?a.getAttribute('href'):''`).catch(() => "");
  const href = nav && nav.startsWith("/") ? nav : "/vaccines/notes";
  if (!(await c.navTo(href, /note/i, 8000, true).catch(() => false))) return D("note search did not load");
  const before = await waitPage(c, (x) => /note/i.test(x.text), 5000);
  if (!before) return D("note search page did not render");
  const r = await fillAndSubmit(c, "search|words|text|contains|lot|keyword|find|term", lot).catch((e) => "threw " + String(e).slice(0, 40));
  if (!/clicked|submitted/.test(r)) { await logProbe(c, "note-search-form", lot); return D(`could not use the note search (${r})`); }
  const p = await waitPage(c, (x) => x.text !== before.text && !/loading/i.test(x.text.slice(0, 400)), 8000);
  if (!p) { await logProbe(c, "note-search-results", lot); return D("note search results did not load"); }
  const n = await narrowed(c); if (n) return D(`the note search is narrowed to "${n.slice(0, 30)}"`);
  const rows = await walkList(liveIO(c, (x) => x.text !== before.text && !/loading/i.test(x.text.slice(0, 400)), (x) => footerOf((x as RPage).outside ?? x.text, NOTE_NOUN)),
    (pp, fm) => notePageOf(pp, fm, lot));
  if (isDecline(rows)) await logProbe(c, "note-search-after", lot);   // the layout is captured (run 265): only a page the reader declines is logged
  return rows;
}
export const entryFooterOf = (p: PPage) => {
  const secs = p.sections.filter((s) => /chart entr/.test(norm(s.heading)) || /chart entr/.test(norm(s.label)));
  const inner = secs.filter((s) => !secs.some((o) => o !== s && s.text.includes(o.text) && o.text.length < s.text.length));
  return inner.length === 1 ? footerOf(inner[0].text, /^entr/i) : null;
};
/** The live ListIO: pages read from the app (settled, fonts placed), "Rows per page" raised by its label, Next pressed
 *  by its label (exactly one enabled match). */
export function liveIO(c: Crawler, ok: (p: PPage) => boolean, footer: (p: PPage) => ListFooter | null): ListIO {
  return {
    async read() {
      const page = await waitPage(c, ok, 6000); if (!page) return D("the list page did not render");
      const fm = await famMapsFor(c, page); if (isDecline(fm)) return D(fm.decline);
      return { page, fm };
    },
    async raise() {
      const before = footer((await page(c).catch(() => null)) ?? ({ text: "", sections: [] } as unknown as PPage));
      const r = await c.evalApp<string>(`
        const sels=[...doc.querySelectorAll('select')].filter(s=>!s.closest('[aria-hidden="true"],[hidden]')&&s.options.length>1&&[...s.options].every(o=>/^\\d+$/.test(o.value))&&[...s.options].some(o=>/per page|rows/i.test(o.textContent||'')));
        if(sels.length!==1) return 'selects:'+sels.length;
        const s=sels[0]; const best=[...s.options].reduce((a,o)=>(+o.value>+a.value?o:a)); if(s.value===best.value) return 'largest';
        const d=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set; d.call(s,best.value);
        s.dispatchEvent(new Event('input',{bubbles:true})); s.dispatchEvent(new Event('change',{bubbles:true})); return 'set';`).catch(() => "threw");
      if (r !== "set") return false;
      const t0 = Date.now();
      while (Date.now() - t0 < 4000) { const f = footer((await page(c).catch(() => null)) ?? ({ text: "", sections: [] } as unknown as PPage)); if (f && before && f.to !== before.to) return true; await sleep(150); }
      return true;   // unchanged: walkList re-reads and judges the page it finds
    },
    async next(from: number) {
      const r = await c.evalApp<string>(`
        const bs=[...doc.querySelectorAll('button,a')].filter(x=>/^\\s*Next\\s*$/i.test(x.textContent||'')&&!x.disabled&&x.getAttribute('aria-disabled')!=='true');
        if(bs.length!==1) return 'nexts:'+bs.length; bs[0].click(); return 'clicked';`).catch(() => "threw");
      if (r !== "clicked") return false;
      return !!(await waitPage(c, (x) => ok(x) && footer(x)?.from === from, 6000));
    },
  };
}
