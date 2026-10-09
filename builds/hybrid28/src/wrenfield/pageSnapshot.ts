/**
 * Label-based page snapshot for the family readers (filing deadline, good-faith estimate).
 *
 * One in-page script (SNAPSHOT_JS) turns the rendered app page into plain data: every section by its
 * heading (h1–h4 / caption), its label→value pairs (dt/dd), its tables (header texts + cell texts +
 * links + <time datetime>), its list items, and any "Showing a to b of n" pager. Readers then find
 * what they need by HEADING and COLUMN LABEL (with synonyms), never by class name (randomised per
 * session) or column index. The same script runs in the live browser (Crawler.evalApp) and in jsdom
 * over the captured recon HTML (familyReaders.test.ts), so the parsers are tested on real markup.
 *
 * Digits drawn in a per-session scrambled font are flagged (`obf`), not decoded: a value we compute
 * with must come from plain text or a <time datetime> attribute, or the reader declines.
 */

import { listFooter, type FooterKind, type ListFooter } from "./listFooter.js";

export type Cell = { text: string; href: string | null; times: string[]; obf: boolean };
export type Table = { caption: string; headers: string[]; rows: Cell[][] };
export type Section = { heading: string; level: number; text: string; dl: Array<[string, string, boolean]>; tables: Table[]; items: string[] };
export type Snapshot = { h1: string; text: string; sections: Section[]; pagers: string[]; links: Array<{ text: string; href: string; nav: boolean }>; selects: Array<{ name: string; label: string; options: Array<{ value: string; text: string; selected: boolean }> }> };

/** In-page script body: `doc` is the app document. Returns a Snapshot. Plain JS (no TS helpers), so it
 *  can be shipped to the browser as a string and run by `new Function('doc', SNAPSHOT_JS)` in jsdom. */
export const SNAPSHOT_JS = String.raw`
  // innerText in the browser; a block-aware text walk where it is missing (jsdom in the tests).
  var BLOCK = /^(DIV|P|SECTION|ARTICLE|HEADER|FOOTER|NAV|ASIDE|MAIN|H[1-6]|UL|OL|LI|DL|DT|DD|TABLE|THEAD|TBODY|TFOOT|TR|CAPTION|FORM|FIELDSET|BR|SELECT|OPTION)$/;
  var walk = function (n) { if (n.nodeType === 3) return n.nodeValue; if (n.nodeType !== 1 || n.tagName === 'SCRIPT' || n.tagName === 'STYLE') return ''; var s = ''; for (var c = n.firstChild; c; c = c.nextSibling) s += walk(c); if (n.tagName === 'TD' || n.tagName === 'TH') return s + '\t'; return BLOCK.test(n.tagName) ? '\n' + s + '\n' : s; };
  var T = function (e) { return ((e && (e.innerText != null ? e.innerText : walk(e))) || '').replace(/[ \t\u00a0]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim(); };
  var STD = /^(Atkinson|ui-|system-ui|-apple-system|monospace|sans-serif|serif|Arial|Helvetica|Inter|Roboto|Segoe|Times|Georgia|Courier)/i;
  var view = doc.defaultView || window;
  var famOf = function (el) { try { return (view.getComputedStyle(el).fontFamily || '').split(',')[0].replace(/["']/g, '').trim(); } catch (e) { return ''; } };
  var baseFam = doc.body ? famOf(doc.body) : '';
  var obfOf = function (el) {
    var leaves = [el].concat([].slice.call(el.querySelectorAll('*')));
    for (var i = 0; i < leaves.length; i++) {
      var l = leaves[i]; var own = '';
      for (var c = l.firstChild; c; c = c.nextSibling) if (c.nodeType === 3) own += c.nodeValue;
      if (!/[0-9]/.test(own)) continue;
      // drawn in a font other than the page's own and not a standard one → per-session scrambled digits
      var fam = famOf(l);
      if (fam && fam !== baseFam && !STD.test(fam)) return true;
      if (l.getAttribute && (l.getAttribute('role') === 'img')) return true;
    }
    return false;
  };
  var cellOf = function (td) {
    var a = td.querySelector('a[href]');
    return { text: T(td), href: a ? a.getAttribute('href') : null, times: [].slice.call(td.querySelectorAll('time[datetime]')).map(function (t) { return t.getAttribute('datetime'); }), obf: obfOf(td) };
  };
  var tableOf = function (t) {
    var cap = t.querySelector('caption');
    var heads = [].slice.call(t.querySelectorAll('thead th'));
    if (!heads.length) { var fr = t.querySelector('tr'); if (fr && fr.querySelector('th')) heads = [].slice.call(fr.querySelectorAll('th')); }
    var rows = [].slice.call(t.querySelectorAll('tbody tr')).filter(function (tr) { return tr.querySelector('td'); })
      .map(function (tr) { return [].slice.call(tr.querySelectorAll('td,th')).filter(function (c) { return !(c.tagName === 'TH' && c.getAttribute('scope') === 'col'); }).map(cellOf); });
    return { caption: T(cap), headers: heads.map(T), rows: rows };
  };
  // a list item's own content: a note's <header> (type, author, written time) is not its body
  var itemText = function (li) { var c = li.cloneNode(true); [].slice.call(c.querySelectorAll('header')).forEach(function (h) { h.parentNode.removeChild(h); }); return T(c); };
  var hs = [].slice.call(doc.querySelectorAll('h1,h2,h3,h4'));
  var used = [];
  var sections = hs.map(function (h) {
    var box = h.closest('section') || h.parentElement;
    // a heading's own box: the nearest ancestor that does not also hold another heading of the same or higher level
    var lvl = +h.tagName.slice(1);
    while (box && box.parentElement && box !== doc.body) {
      var others = [].slice.call(box.querySelectorAll('h1,h2,h3,h4')).filter(function (x) { return x !== h && +x.tagName.slice(1) <= lvl; });
      if (others.length) break;
      if (box.tagName === 'SECTION' || box.querySelector('table,dl,ul,ol,p')) break;
      box = box.parentElement;
    }
    var dl = [];
    [].slice.call(box.querySelectorAll('dt')).forEach(function (dt) { var dd = dt.nextElementSibling; if (dd && dd.tagName === 'DD') dl.push([T(dt), T(dd), obfOf(dd)]); });
    return { heading: T(h), level: lvl, text: T(box), dl: dl, tables: [].slice.call(box.querySelectorAll('table')).map(tableOf), items: [].slice.call(box.querySelectorAll('li')).map(itemText) };
  });
  // tables not under any heading box (captioned only)
  [].slice.call(doc.querySelectorAll('table')).forEach(function (t) {
    var cap = T(t.querySelector('caption'));
    if (!sections.some(function (s) { return s.tables.some(function (x) { return x.caption === cap && cap; }); })) sections.push({ heading: cap, level: 5, text: T(t), dl: [], tables: [tableOf(t)], items: [] });
  });
  // lists labelled by aria-label (e.g. "Notes, newest first")
  [].slice.call(doc.querySelectorAll('ul[aria-label],ol[aria-label]')).forEach(function (u) {
    sections.push({ heading: u.getAttribute('aria-label'), level: 5, text: T(u), dl: [], tables: [], items: [].slice.call(u.children).map(itemText) });
  });
  var bodyText = T(doc.body);
  // every footer form listFooter reads: "Showing a to b of N", "Showing N of about M", "N+ …", "about N notes", "8 notes"
  var pagers = (bodyText.match(/Showing \d[\d,]*( to \d[\d,]*)? of (about )?\d[\d,]*\+?[^\n]*/gi) || []).concat((bodyText.match(/(^|\n)(about )?\d[\d,]*\+? (entr(?:y|ies)|notes|appointments|claims|rows|results|records)\b/gi) || []).map(function (s) { return s.trim(); }));
  var links = [].slice.call(doc.querySelectorAll('a[href]')).map(function (a) { return { text: T(a), href: a.getAttribute('href'), nav: !!a.closest('nav,aside,[role=navigation]') }; });
  var selects = [].slice.call(doc.querySelectorAll('select')).map(function (s) {
    var lab = s.id ? doc.querySelector('label[for="' + s.id + '"]') : null; if (!lab) lab = s.closest('label');
    return { name: s.name || s.id || '', label: T(lab), options: [].slice.call(s.options).map(function (o) { return { value: o.value, text: T(o), selected: o.selected }; }) };
  });
  var h1 = doc.querySelector('h1');
  return { h1: T(h1), text: bodyText, sections: sections, pagers: pagers, links: links, selects: selects };
`;

/** Run SNAPSHOT_JS against a document (jsdom in tests). */
export function snapshotOf(doc: any): Snapshot {
  // eslint-disable-next-line no-new-func
  return new Function("doc", "window", SNAPSHOT_JS)(doc, doc.defaultView) as Snapshot;
}

// ── label helpers ──
export const norm = (s: string) => (s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/** Column index by header label. `want` are synonyms (regexes over the normalised label). Returns -1
 *  when absent, -2 when more than one column matches (ambiguous → caller declines). `avoid` excludes. */
export function col(headers: string[], want: RegExp[], avoid: RegExp[] = []): number {
  const hits = headers.map((h, i) => [norm(h), i] as const).filter(([h]) => want.some((re) => re.test(h)) && !avoid.some((re) => re.test(h))).map(([, i]) => i);
  return hits.length === 1 ? hits[0] : hits.length === 0 ? -1 : -2;
}

/** The section whose heading (or table caption) matches. Several → the first; callers that care check. */
export function sectionsBy(s: Snapshot, re: RegExp): Section[] { return s.sections.filter((x) => re.test(norm(x.heading)) || x.tables.some((t) => re.test(norm(t.caption)))); }
/** Tables that belong to a heading/caption: captioned tables first; else the tables of the most
 *  specific (deepest) matching headed sections. Deduplicated (a page-level section repeats its children). */
export function tablesUnder(s: Snapshot, re: RegExp): Table[] {
  const uniq = (ts: Table[]) => { const seen = new Set<string>(); return ts.filter((t) => { const k = JSON.stringify(t); if (seen.has(k)) return false; seen.add(k); return true; }); };
  const cap = uniq(s.sections.flatMap((x) => x.tables).filter((t) => re.test(norm(t.caption))));
  if (cap.length) return cap;
  const secs = s.sections.filter((x) => re.test(norm(x.heading)) && x.tables.length);
  if (!secs.length) return [];
  const deepest = Math.max(...secs.map((x) => x.level));
  return uniq(secs.filter((x) => x.level === deepest).flatMap((x) => x.tables));
}
export function tableBy(s: Snapshot, re: RegExp): Table | null {
  for (const sec of s.sections) for (const t of sec.tables) if (re.test(norm(t.caption))) return t;
  for (const sec of s.sections) if (re.test(norm(sec.heading)) && sec.tables.length === 1) return sec.tables[0];
  return null;
}
export function dlValue(sec: Section | undefined, re: RegExp): { value: string; obf: boolean } | null {
  if (!sec) return null;
  const hits = sec.dl.filter(([k]) => re.test(norm(k)));
  return hits.length ? { value: hits[0][1], obf: hits[0][2] } : null;
}

/** The list's pager statement whose line matches `noun` (listFooter's grammar): "Showing 1 to 10 of 33 notes" → {from, to,
 *  total}; "Showing 15 of 148 appointments" (a "Show more" list) → cumulative; plain "8 notes" → the whole list. `kind`
 *  says what the total is — exact, a lower bound ("500+", `plus`) or an estimate ("about 500", `approx`); only an exact
 *  total can prove an end (listFooter.isComplete over `footer`), so every walk checks `kind` before trusting `to`/`total`. */
export type Pager = { from: number; to: number; total: number; cumulative?: true; kind: FooterKind; plus?: true; approx?: true; footer: ListFooter };
export function pagerOf(s: Snapshot, noun: RegExp): Pager | null {
  for (const p of s.pagers) {
    if (!noun.test(p)) continue;
    const f = listFooter(p); if (!f || f.none || f.page !== undefined) continue;
    return { from: f.from, to: f.to < 0 ? 0 : f.to, total: f.total, ...(f.cumulative && !f.end ? { cumulative: true as const } : {}), kind: f.kind, ...(f.kind === "plus" ? { plus: true as const } : {}), ...(f.kind === "approx" ? { approx: true as const } : {}), footer: f };
  }
  return null;
}

// ── dates and times ──
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n: number) => String(n).padStart(2, "0");
const valid = (y: number, m: number, d: number) => m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate() && y >= 1900 && y <= 2100;
const iso = (y: number, m: number, d: number) => (valid(y, m, d) ? `${y}-${pad(m)}-${pad(d)}` : null);
const monthNo = (w: string) => { const i = MONTHS.indexOf(w.slice(0, 3).toLowerCase()); return i >= 0 && (w.length === 3 || /^(january|february|march|april|may|june|july|august|september|sept|october|november|december)$/i.test(w)) ? i + 1 : 0; };

/** Every full date in a string, in order: ISO 2026-05-07, US 5/7/2026 (month first — US clinic),
 *  "May 7, 2026", "Thu, May 7, 2026", "May 7th 2026", "7 May 2026". Ambiguous/invalid tokens are dropped. */
export function datesIn(s: string): string[] { return dateSpans(s).map((d) => d.iso); }
/** Full dates with their positions (start, end) in the string. */
export function dateSpans(s: string): Array<{ iso: string; start: number; end: number }> {
  const out: Array<{ iso: string; start: number; end: number }> = [];
  const t = s || "";
  const add = (m: RegExpMatchArray, v: string | null) => { if (v) out.push({ iso: v, start: m.index!, end: m.index! + m[0].length }); };
  for (const m of t.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) add(m, iso(+m[1], +m[2], +m[3]));
  for (const m of t.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) add(m, iso(+m[3], +m[1], +m[2]));
  for (const m of t.matchAll(/\b(?:(?:Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun)[a-z]*\.?,?\s+)?([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/g)) { const mo = monthNo(m[1]); add(m, mo ? iso(+m[3], mo, +m[2]) : null); }
  for (const m of t.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/g)) { const mo = monthNo(m[2]); add(m, mo ? iso(+m[3], mo, +m[1]) : null); }
  return out.sort((a, b) => a.start - b.start).filter((d, i, a) => i === 0 || d.start >= a[i - 1].end);
}
/** The single date a cell/string holds; null when none or several different ones. */
export function oneDate(s: string): string | null { const d = [...new Set(datesIn(s))]; return d.length === 1 ? d[0] : null; }

/** "2:45 PM" / "14:45" (first time in the string) → "14:45". */
export function timeIn(s: string): string | null {
  const a = (s || "").match(/\b(\d{1,2}):(\d{2})\s*([AaPp])\.?\s*[Mm]\.?/);
  if (a) { let h = +a[1]; if (h < 1 || h > 12 || +a[2] > 59) return null; h = h % 12 + (/p/i.test(a[3]) ? 12 : 0); return `${pad(h)}:${a[2]}`; }
  const b = (s || "").match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  return b ? `${pad(+b[1])}:${b[2]}` : null;
}
/** US time-zone abbreviation → zone family (standard and daylight share one). */
export function tzFamily(s: string): string | null {
  const m = (s || "").match(/\b(E|C|M|P|AK|H)(S|D)T\b|\bHST\b/);
  if (!m) return null;
  return m[0] === "HST" ? "H" : m[1];
}
/** Month/day mentions without a year ("Oct 27", "October 27th", "27 Oct", "10/27") → "MM-DD". */
export function monthDaysIn(s: string): string[] {
  const out = new Set<string>(); const t = s || "";
  for (const m of t.matchAll(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/g)) { const mo = monthNo(m[1]); if (mo && +m[2] >= 1 && +m[2] <= 31) out.add(`${pad(mo)}-${pad(+m[2])}`); }
  for (const m of t.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([A-Za-z]{3,9})\b/g)) { const mo = monthNo(m[2]); if (mo && +m[1] >= 1 && +m[1] <= 31) out.add(`${pad(mo)}-${pad(+m[1])}`); }
  for (const m of t.matchAll(/\b(\d{1,2})\/(\d{1,2})\b(?!\/)/g)) if (+m[1] >= 1 && +m[1] <= 12 && +m[2] >= 1 && +m[2] <= 31) out.add(`${pad(+m[1])}-${pad(+m[2])}`);
  for (const d of datesIn(t)) out.add(d.slice(5));
  return [...out];
}
export const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
