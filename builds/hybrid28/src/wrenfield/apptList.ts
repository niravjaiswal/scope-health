/**
 * Appointment-list reader: the AggSource behind aggregate.ts. Reads the clinic's appointment list
 * (Schedule → Appointment list) for one filter, page by page, and PROVES the read is complete:
 *
 *  - filters are set by the form's own control names and option values found by LABEL ("From", "To",
 *    "Location", "Provider", "Status"), put in the URL the app reads; the rendered controls must show
 *    exactly those values afterwards (else the form is filled and submitted; else decline);
 *  - columns are found by header text (synonyms, any order, extra columns tolerated), never by index
 *    or class name (class names are random per session);
 *  - pages are walked with the pager's "Next" button (`?page=` is ignored by the app); every page's
 *    "Showing a to b of N" must continue the previous one, the rows on it must number b−a+1, and the
 *    walk ends only when "Next" is gone/disabled with b equal to an exact N (or past an "N+" bound);
 *  - "Rows per page" is raised to its largest option first (25 → 100 on practice: 4× fewer pages).
 *
 * The pacer gives each read a budget from the queue's `seconds_left` (setShiftDeadline): after the
 * first page it projects the remaining pages (from the exact total, or from how far into the date
 * range the rows have got) and declines early rather than eat the time later items need.
 *
 * Read-only: navigation by URL, the list's own filter/pager/page-size controls, and patient charts
 * that are NOT marked Restricted (a restricted chart is never opened: that is break-the-glass).
 * Notes and free text are never read (chart notes carry planted instructions).
 *
 * The page → rows interpretation is the pure `parseListPage`, unit-tested on recon DOM via jsdom.
 */
import type { Crawler } from "./crawl.js";
import { KNOWN_FLAGS, STATUSES, normName, stripCred, validISO, type AggSource, type ApptRow, type Flag, type ReadFilter, type ResolvedRecord, type Status } from "./aggregate.js";
import { listFooter, isComplete, endSealed, approxTol } from "./listFooter.js";
import { pacer } from "./pacer.js";
import { paceList, noteLat, noteLoad, noteBusyPage, projectedWaitMs } from "./siteBudget.js";
export { approxTol };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const addDay = (iso: string) => new Date(Date.parse(iso + "T00:00:00Z") + 86400000).toISOString().slice(0, 10);

// ── pacer ──
let shiftDeadline = Infinity;
/** Called by the shift loop with the queue's clock before each item (Date.now() + seconds_left·1000). */
export function setShiftDeadline(epochMs: number) { if (Number.isFinite(epochMs)) shiftDeadline = epochMs; }
/** Milliseconds one aggregate task may spend: capped per task, and never into the time later items need. The reserve is
 *  the pacer's own projection of the rest of the set (pacer.extraSlackS: seconds left minus the projected rest minus a
 *  margin) — not a fixed 240 s, which left late items (Set 1 items 225 and 236) with 0 s on a shift that had ~150 s to
 *  spare. A hard guard keeps AGG_END_GUARD_S (20 s) of the shift. */
export function taskBudgetMs(now = Date.now()): number {
  const guard = Number(process.env.AGG_END_GUARD_S ?? 20) * 1000;
  const cap = Number(process.env.AGG_TASK_BUDGET_S ?? 90) * 1000;
  const floor = Number(process.env.AGG_FLOOR_S ?? 15) * 1000; // a read that fits this is always worth trying
  const slack = Math.min(pacer.extraSlackS(), 1e6) * 1000;
  return Math.max(0, Math.min(cap, shiftDeadline - now - guard, Math.max(floor, slack)));
}

// ── browser-side extraction (plain JS run inside the app document; also runnable under jsdom) ──
const T_FN = `const T=e=>((e&&(e.innerText!=null?e.innerText:e.textContent))||'').replace(/\\s+/g,' ').trim();`;
export const FORM_EXTRACT = `${T_FN}
  const vis=e=>!e.closest('[aria-hidden="true"]');
  const labelOf=e=>{ let l=''; if(e.id){ const x=[...doc.querySelectorAll('label')].find(z=>z.getAttribute('for')===e.id); if(x) l=T(x); }
    if(!l){ const x=e.closest('label'); if(x){ l=T(x); const own=T(e); if(own&&l.endsWith(own)) l=l.slice(0,l.length-own.length).trim(); } }
    if(!l) l=e.getAttribute('aria-label')||''; return l; };
  const controls=[...doc.querySelectorAll('input,select')].filter(e=>vis(e)&&e.type!=='hidden').map(e=>({
    label:labelOf(e), name:e.name||'', id:e.id||'', tag:e.tagName.toLowerCase(), type:(e.type||'').toLowerCase(), value:e.value||'', inForm:!!e.closest('form'),
    options: e.tagName==='SELECT'?[...e.options].map(o=>({value:o.value, text:T(o), group:(o.parentElement&&o.parentElement.tagName==='OPTGROUP')?(o.parentElement.label||''):''})):[] }));
  return { controls };`;

export const PAGE_EXTRACT = `${T_FN}
  const vis=e=>!e.closest('[aria-hidden="true"]');
  const body=T(doc.body);
  const heads=[...doc.querySelectorAll('h1,h2,h3')].filter(vis).map(T);
  const tables=[...doc.querySelectorAll('table')].filter(vis).map(t=>{
    const hr=t.querySelector('thead tr')||t.querySelector('tr'); const headers=hr?[...hr.children].map(T):[];
    const trs=[...t.querySelectorAll('tbody tr')].filter(tr=>tr!==hr);
    return { caption: T(t.querySelector('caption')), headers,
      rows: trs.map(tr=>[...tr.children].map(td=>({ text:T(td), links:[...td.querySelectorAll('a[href]')].map(a=>({href:a.getAttribute('href')||'', text:T(a)})) }))) }; });
  const btns=[...doc.querySelectorAll('button,a[role=button]')].filter(b=>vis(b)&&!b.closest('form')&&b.getAttribute('tabindex')!=='-1');
  const nb=btns.find(b=>/^next(\\s+page)?$/i.test(T(b))||/^next page$/i.test(b.getAttribute('aria-label')||''));
  const mb=btns.find(b=>/^(show|load|see) more\\b/i.test(T(b))||/^(show|load) more\\b/i.test(b.getAttribute('aria-label')||''));
  const showing=(body.match(/Showing\\s+[\\d,]+\\s*(?:to|–|-)\\s*[\\d,]+\\s+of\\s+(?:about\\s+)?[\\d,]+\\+?\\s+\\w+/i)||body.match(/Showing\\s+[\\d,]+\\s+of\\s+(?:about\\s+)?[\\d,]+\\+?\\s+\\w+/i)||[''])[0];
  const count=/\\babout\\s+[\\d,]+\\s+appointments?\\b/i.test(body)?'':(body.match(/(?:^|\\s)([\\d,]+)\\s+appointments?(?:\\s|$)/i)||['',''])[1];
  const aboutEnd=[...doc.querySelectorAll('[aria-live],p')].filter(vis).map(e=>(T(e).match(/^about\\s+([\\d,]+)\\s+appointments?$/i)||['',''])[1]).find(Boolean)||'';
  const nr=[...doc.querySelectorAll('[role=status],[role=alert]')].find(e=>/not responding/i.test(e.textContent||'')&&!e.hidden&&!e.closest('[hidden]')&&!e.closest('[aria-hidden="true"]'));
  const busy=[...doc.querySelectorAll('[role=status],[role=alert],p')].some(e=>/\\bis busy\\b|fewer rows than usual|open it again/i.test(e.textContent||'')&&!e.hidden&&!e.closest('[hidden]')&&!e.closest('[aria-hidden="true"]'));
  return { heads, tables, footer: showing || (count?count+' appointments':'') || (aboutEnd?'about '+aboutEnd+' appointments':'') || ((body.match(/No appointments[^.]*/i)||[''])[0]),
    next: { present: !!nb, disabled: !!nb && (nb.disabled||nb.getAttribute('aria-disabled')==='true') },
    more: { present: !!mb, disabled: !!mb && (mb.disabled||mb.getAttribute('aria-disabled')==='true') },
    loading: /Loading Wrenfield|Loading…|Loading\\.\\.\\./i.test(body), notResponding: !!nr, busy, empty: /No more results/i.test(body) };`;

/** A few bytes that change when a press has done anything: rows in the table, the footer line(s), whether Show more is live, any visible status line. */
const LIGHT_SIG = `const t=doc.querySelector('tbody'); const ft=[...doc.querySelectorAll('p[aria-live]')].map(x=>x.textContent||'').join('|');
  const b=[...doc.querySelectorAll('button')].some(x=>/^(show|load|see) more\\b/i.test((x.textContent||'').trim())&&!x.disabled&&!x.closest('[aria-hidden="true"]'));
  const st=[...doc.querySelectorAll('[role=status],[role=alert]')].filter(e=>!e.hidden&&!e.closest('[hidden]')).map(e=>e.textContent||'').join('|');
  return (t?t.rows.length:-1)+'/'+ft+'/'+b+'/'+st;`;
const PRESS_GUESS_MS = 300;
/** Time kept for opening the few records that tell merged / near-named patients apart after the list is read. */
const RESOLVE_RESERVE_MS = 4000;
/** Tabs reading date chunks at once (this one plus parallelTabs() - 1 spawned): AGG_TABS, default 1 = off. Run 265 (3 tabs): the
 *  site answered the burst with a latency ramp (65 → 800 ms a load), an nginx 503, dozens of "busy" lists and then "This account is
 *  suspended" (items 125-127 and 210-240: 22 answers of run 278 lost). The account's request budget is shared by the tabs, so tabs
 *  only get to the wall sooner; every run without them (146-278) was never suspended. */
export const parallelTabs = () => Math.max(1, Number(process.env.AGG_TABS ?? 1) | 0);
/** Requests (page loads + Show-more presses) one aggregate list read may make: AGG_MAX_REQ, default 17. Set 1 runs: 13-15 presses in a row were
 *  never refused (items 83, run 164/r4/278 first parts), the 19th-20th since the last quiet moment was "busy" in 3 of 3 reads that went on
 *  (the 300-row cut + its onward part), and the ctx reads of 265 (17-22 loads in 8 s). A list needing more is declined from its first page. */
const aggMaxReq = () => Math.max(1, Number(process.env.AGG_MAX_REQ ?? 17) | 0);
/** After a busy / 503 / unsettled list no aggregate read starts for AGG_BUSY_COOLDOWN_S (default 20) and the failed read is not repeated
 *  (AGG_BUSY_RETRIES, default 0): run 265 re-read busy lists 3x per chunk on 3 tabs and was suspended; run 278 gave up at the first busy
 *  page (2 busy pages in the run, items 130 and 195) and never was. Shared by every tab (the account is what the site counts).
 *  Run s3a (one tab, 60 s): all 33 busy pages came from the name-only context reads, and the cooldown then declined 9 aggregates
 *  2-60 s later (items 83, 108, 130, 134, 151, 195, 225, 236) — 8 of which run 278 had read or sized without a busy page. The budget
 *  refills in ~8 s (siteBudget: 700 ms of latency at 90 ms/s), and the governor now waits that out before any list request. */
let busyUntil = 0;
const busyCooldownMs = () => Number(process.env.AGG_BUSY_COOLDOWN_S ?? 20) * 1000;
const busyRetries = () => Math.max(0, Number(process.env.AGG_BUSY_RETRIES ?? 0) | 0);
/** Test hook: forget the cooldown. */
export function resetBusy() { busyUntil = 0; }
/** Pause before each Show-more press after the first BURST_PRESSES of a read (AGG_PRESS_GAP_MS, default 0 = none): an experiment lever for lists
 *  over AGG_MAX_REQ (ponytail: a fixed gap, not feedback — the site's refill rate is not measured yet; read `lat` in the aggregate-read log). */
const pressGapMs = () => Number(process.env.AGG_PRESS_GAP_MS ?? 0);
const BURST_PRESSES = 12;
/** Lists the site says hold fewer rows than this are read in one go; rows per chunk the day chunks aim at (the site cuts a list at 300). */
const PARALLEL_MIN_ROWS = 320, CHUNK_ROWS = 200;
/** A range this long or shorter whose finished list ends on an estimate ("about 250 appointments") is re-read one day at a time: a
 *  Set 1 list under 100 rows ends on its EXACT count ("84 appointments", run 278: 81 such footers, probe-278-appts-northgate-exact89),
 *  so each day proves itself. Longer ranges decline (a month by day is ~30 loads: the task budget would not fit it anyway). */
export const BY_DAY_MAX_DAYS = Number(process.env.AGG_BY_DAY_MAX_DAYS ?? 7);
export type RawControl = { label: string; name: string; id: string; tag: string; type: string; value: string; inForm: boolean; options: Array<{ value: string; text: string; group: string }> };
export type RawCell = { text: string; links: Array<{ href: string; text: string }> };
export type RawPage = { heads: string[]; tables: Array<{ caption: string; headers: string[]; rows: RawCell[][] }>; footer: string; next: { present: boolean; disabled: boolean }; more?: { present: boolean; disabled: boolean }; loading: boolean; notResponding: boolean; /** "Wrenfield is busy, so this list shows fewer rows than usual. Open it again in a moment": a degraded list */ busy?: boolean; empty?: boolean };

// ── pure interpretation ──
const COLS: Array<[keyof Cols, RegExp]> = [
  ["date", /^(?:date|day|appointment date|visit date|service date)\b/i],
  ["time", /^(?:time|start time|start|when|appointment time)\b/i],
  ["patient", /^(?:patient|patient name|name)\b/i],
  ["provider", /^(?:provider|clinician|practitioner|doctor|seen by|with)\b/i],
  ["location", /^(?:location|site|clinic|office)\b/i],
  ["type", /^(?:visit type|type|service|appointment type|reason)\b/i],
  ["status", /^(?:status|state)\b/i],
];
type Cols = { date: number; time: number; patient: number; provider: number; location: number; type: number; status: number };
/** Column index per field by header label; null when a needed column is missing or matched twice.
 *  The Location column may be absent: the practice list drops it when the list is filtered to one
 *  location. Rows then carry location "" and the reader fills in the filtered location (read()), or
 *  declines when the read was not filtered by location. */
export function columnsOf(headers: string[]): { cols: Cols } | { problem: string } {
  const cols: Partial<Cols> = {};
  const twice = new Set<string>();
  headers.forEach((h, i) => { for (const [k, re] of COLS) if (re.test(h.trim())) { if (cols[k] !== undefined) twice.add(k); else cols[k] = i; break; } });
  for (const k of ["date", "time", "patient", "provider", "location", "status"] as const) {
    if (twice.has(k)) return { problem: `two ${k} columns (headers: ${headers.join(" | ")})` };
    if (cols[k] === undefined && k !== "location") return { problem: `no ${k} column (headers: ${headers.join(" | ")})` };
  }
  if (twice.has("type")) cols.type = -1; // as before: an ambiguous visit-type column is just not read
  return { cols: { type: -1, location: -1, ...cols } as Cols };
}
const MON: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
export function dateISOof(s: string): string | undefined {
  let m = s.match(/\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/); if (m && MON[m[1].toLowerCase()]) return `${m[3]}-${String(MON[m[1].toLowerCase()]).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  m = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/); if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return undefined;
}
const clock = (h: string, mi: string, ap?: string) => { const H = +h, M = +mi; if (M > 59) return undefined; if (ap) { if (H < 1 || H > 12) return undefined; return (H % 12 + (/p/i.test(ap) ? 12 : 0)) * 60 + M; } return H > 23 ? undefined : H * 60 + M; };
/** "9:20 AM to 10:20 AM CDT Recurring" → {start,end,tz,rest}. */
export function timeOf(s: string): { start: number; end: number; tz: string; rest: string } | undefined {
  const m = s.match(/^\s*(\d{1,2}):(\d{2})\s*([AaPp]\.?[Mm]\.?)?\s*(?:to|–|—|-)\s*(\d{1,2}):(\d{2})\s*([AaPp]\.?[Mm]\.?)?\s*(?:\b([A-Z]{2,4})\b)?(.*)$/);
  if (!m) return undefined;
  const a = clock(m[1], m[2], m[3]), b = clock(m[4], m[5], m[6] ?? m[3]);
  if (a === undefined || b === undefined) return undefined;
  return { start: a, end: b, tz: m[7] ?? "", rest: (m[8] ?? "").trim() };
}
const STATUS_ALIASES: Record<string, Status> = { scheduled: "Scheduled", completed: "Completed", cancelled: "Cancelled", canceled: "Cancelled", "late cancel": "Late cancel", "late cancellation": "Late cancel", "late cancelled": "Late cancel", "no-show": "No-show", "no show": "No-show", noshow: "No-show" };
export const statusOf = (s: string): string => STATUS_ALIASES[s.trim().toLowerCase()] ?? s.trim();
const FLAG_RE: Array<[RegExp, Flag]> = KNOWN_FLAGS.map((f) => [new RegExp(`\\b${f.replace(" ", "\\s+")}\\b`, "i"), f]);
export function badgesOf(rest: string): { flags: Flag[]; unknown?: string } {
  let left = rest; const flags: Flag[] = [];
  for (const [re, f] of FLAG_RE) if (re.test(left)) { flags.push(f); left = left.replace(new RegExp(re.source, "gi"), " "); }
  left = left.replace(/[\s·,|•]+/g, " ").trim();
  return { flags, unknown: left || undefined };
}
/** A list footer (listFooter's grammar). `approx`: the total is an estimate ("of about 1,000"); `plus`: a lower bound
 *  ("200+") — neither ever proves an end (listFooter.isComplete). `cumulative`: a "Show more" list ("Showing 40 of …":
 *  rows 1..b are all on the page). `end`: the Set 1 Show-more list's footer once nothing more is offered: "about 250
 *  appointments" (no "Showing"; b is the rows on the page). Run 164 Cedar Hollow 2026-07-26..28: 12 presses loaded the
 *  whole list and the footer took this form. A list cut by the site keeps "Showing 300 of about N". */
export type Range = { a: number; b: number; total: number; plus: boolean; approx?: boolean; cumulative?: boolean; end?: boolean };
export function rangeOf(footer: string): Range | undefined {
  const f = listFooter(footer); if (!f || f.page !== undefined) return undefined;
  if (f.none) return { a: 0, b: 0, total: 0, plus: false };
  // "89 appointments" (a finished Show-more list under 100 rows states its exact count, run 278 item 127): an end footer,
  // so a Show-more walk that ends on it is not a "pager form change" (b is the rows on the page, set in parseListPage)
  if (f.end && f.kind === "exact") return { a: f.from, b: f.to, total: f.total, plus: false, end: true };
  if (f.end) return { a: 1, b: -1, total: f.total, plus: f.kind === "plus", approx: f.kind === "approx", cumulative: true, end: true };
  return { a: f.from, b: f.to, total: f.total, plus: f.kind === "plus", approx: f.kind === "approx", ...(f.cumulative ? { cumulative: true } : {}) };
}
/** Set 1's Show-more lists are cut by the site at this many rows: "Showing 300 of about N" and the button goes away. */
export const SHOW_MORE_CAP = 300;
/** The site states list sizes as estimates on the 25-row grid ("about 750", "about 16,950", "about 125"). Used only as a SANITY check on
 *  rows that were each proven complete another way (readParallel: the chunks' sum vs the whole range's estimate; readOnward's parts) —
 *  never as a proof. */
const EST_BELOW = 12, EST_ABOVE = 24;
/** Is a FINISHED Show-more list ("about 250 appointments", no "Showing", nothing more offered) complete? NO — never. An "about N"
 *  footer is an estimate, and an estimate is not a completeness proof (LESSONS.md §C.4, §B "about N totals never prove the end";
 *  listFooter.isComplete never accepts one). s2 integration and s3 integration (runs 265 and 304) accepted it under a conjunction of
 *  plausibility checks (same estimate on the first page, 25-row grid, rows within [N-12, N+24], no busy notice); each of those runs
 *  had exactly one wrong Set 3 answer, most likely a list that passed those checks short of its rows (a load-shed page), which no
 *  estimate can tell from a complete one. Run 304's Set 1 log answered 0 tasks on this rule (every aggregate declined on busy /
 *  AGG_MAX_REQ), so refusing it costs Set 1 nothing. The function stays so every caller and test states the rule in one place: the
 *  answer is always "no", with the reason. A finished list that ends on an estimate is re-read in exact pieces instead
 *  (readSeq0 → readByDay, ranges up to BY_DAY_MAX_DAYS). */
export function endFormProof(rows: number, first: Range | undefined, end: Range): { ok: false; why: string } {
  const what = end.plus ? `"${end.total}+"` : end.approx ? `"about ${end.total}"` : `${end.total}`;
  void first;
  return { ok: false, why: `${rows} rows read of ${what}: an estimate or a bound never proves a list complete (only an exact total the rows reach does)` };
}
export type ParsedPage = { rows: ApptRow[]; range?: Range; problems: string[]; heading?: { from?: string; to?: string } };
/** One rendered list page → typed rows + its "Showing a to b of N" range. Any doubt is a problem. */
export function parseListPage(raw: RawPage): ParsedPage {
  const problems: string[] = [];
  const heading = (() => { const h = raw.heads.find((x) => /\bfrom\b.*\bto\b/i.test(x) && /appointment/i.test(x)); if (!h) return undefined; const m = h.match(/from\s+(.+?)\s+to\s+(.+)$/i); return m ? { from: dateISOof(m[1]), to: dateISOof(m[2]) } : undefined; })();
  const range = rangeOf(raw.footer);
  const cands = raw.tables.filter((t) => !("problem" in columnsOf(t.headers)));
  if (cands.length > 1) problems.push(`${cands.length} appointment tables on the page`);
  const tbl = cands[0];
  if (!tbl) {
    if (range && range.total === 0 && !raw.tables.some((t) => t.rows.length)) return { rows: [], range, problems, heading };
    problems.push(raw.tables.length ? (columnsOf(raw.tables[0].headers) as { problem: string }).problem : "no appointment table");
    return { rows: [], range, problems, heading };
  }
  const { cols } = columnsOf(tbl.headers) as { cols: Cols };
  const rows: ApptRow[] = [];
  for (const cells of tbl.rows) {
    if (cells.length === 1 && /no appointments/i.test(cells[0].text)) continue;
    if (cells.length !== tbl.headers.length) { problems.push(`row with ${cells.length} cells for ${tbl.headers.length} columns: ${cells.map((c) => c.text).join(" | ").slice(0, 80)}`); continue; }
    const dateISO = dateISOof(cells[cols.date].text);
    const tm = timeOf(cells[cols.time].text);
    const pc = cells[cols.patient];
    const pl = pc.links.find((l) => /^\/patients\/[^/?#]+$/.test(l.href));
    if (!dateISO || !validISO(dateISO)) { problems.push(`unreadable date "${cells[cols.date].text}"`); continue; }
    if (!tm) { problems.push(`unreadable time "${cells[cols.time].text}"`); continue; }
    if (!pl) { problems.push(`row without a patient link: ${pc.text.slice(0, 40)}`); continue; }
    const tb = badgesOf(tm.rest); // time cell may carry "Recurring"
    const pb = badgesOf(pc.text.replace(pl.text, " "));
    const otherLink = cells.flatMap((c) => c.links).find((l) => l.href !== pl.href && /^\/patients\//.test(l.href))?.href ?? "";
    const unknown = [pb.unknown].filter(Boolean).join(" ") || undefined;
    if (tb.unknown && !/^recurring$/i.test(tb.unknown)) problems.push(`unknown text in time cell "${tb.unknown}"`);
    rows.push({
      key: `${otherLink}|${dateISO}|${tm.start}|${pl.href}`, dateISO, start: tm.start, end: tm.end, tz: tm.tz,
      patientName: pl.text.trim(), patientId: pl.href.split("/")[2], flags: pb.flags, unknownBadge: unknown,
      provider: cells[cols.provider].text.trim(), location: cols.location >= 0 ? cells[cols.location].text.trim() : "",
      visitType: cols.type >= 0 ? cells[cols.type].text.trim() : "", status: statusOf(cells[cols.status].text),
    });
  }
  if (range?.end) { range.b = rows.length; range.a = rows.length ? 1 : 0; }
  if (range && range.total > 0 && rows.length !== range.b - range.a + 1) problems.push(`page shows ${rows.length} rows for "Showing ${range.a} to ${range.b}"`);
  return { rows, range, problems, heading };
}

/** Which form control is which, by label. */
export type FormMap = { from?: RawControl; to?: RawControl; status?: RawControl; location?: RawControl; provider?: RawControl; perPage?: RawControl; type?: RawControl };
export function mapForm(controls: RawControl[]): FormMap {
  const one = (pred: (c: RawControl) => boolean) => { const h = controls.filter(pred); return h.length === 1 ? h[0] : undefined; };
  const L = (c: RawControl) => c.label.replace(/\s+/g, " ").trim();
  return {
    from: one((c) => c.tag === "input" && /^(?:from|start(?: date)?|from date|date from|begin(?:ning)?)$/i.test(L(c))),
    to: one((c) => c.tag === "input" && /^(?:to|end(?: date)?|to date|date to|through|until)$/i.test(L(c))),
    status: one((c) => c.tag === "select" && /^status$/i.test(L(c))),
    location: one((c) => c.tag === "select" && c.inForm && /^(?:location|site|clinic|office)$/i.test(L(c))),
    provider: one((c) => c.tag === "select" && /^(?:provider|clinician|practitioner)$/i.test(L(c))),
    perPage: one((c) => c.tag === "select" && /per page|page size|rows/i.test(L(c))),
    type: one((c) => c.tag === "select" && c.inForm && /^(?:visit type|appointment type|type of visit)$/i.test(L(c))),
  };
}
const optFor = (c: RawControl | undefined, want: string, norm = (s: string) => normName(s)) => { if (!c) return undefined; const h = c.options.filter((o) => o.value !== "" && norm(o.text) === norm(want)); return h.length === 1 ? h[0] : undefined; };

// ── live reader ──
/** What identifies a settled list state: its footer range, its rows and whether it still offers more. A press that
 *  only takes the button away (run 164: the 15th press at 300 rows of "about 1,000") is a new state, not "no load". */
const pageKey = (page: ParsedPage, raw: RawPage) => JSON.stringify([page.range, page.rows.map((r) => r.key), !!raw.more?.present && !raw.more.disabled, !!raw.next.present && !raw.next.disabled]);
export type ReadStats = { pages: number; rows: number; ms: number; perPageMs: number; pageSize: number; via: string };
export class ApptList implements AggSource {
  private form: { path: string; map: FormMap; controls: RawControl[] } | null = null;
  lastStats: ReadStats | null = null;
  /** ms the request governor (siteBudget) waited during the current read */
  private pacedMs = 0;
  /** inside a by-day re-read of an aggregate range: every day must end on an exact count (no finished-list estimate footer) */
  private exactOnly = false;
  private deadline = Infinity;
  private endEstimate = false;
  private gate?: (estS: number) => boolean;
  private gateAsked = false;
  /** Extra browser tabs (same login) for reading date chunks of a big list in parallel; spawned on first use and kept for the shift. */
  private pool: ApptList[] = [];
  constructor(private c: Crawler, private log: (rec: Record<string, unknown>) => void = () => {}, private spawn?: () => Promise<Crawler | null>) {}
  /** Start a task: reads and record opens stop at this budget. `endEstimate`: accept a finished Show-more list whose footer is the
   *  estimate form when endFormProof holds (the aggregate engine only: the visit-day contexts keep declining it). `gate(estS)`:
   *  asked once per task when the first page has told how long the whole read will take; false → "pacer" decline before any press. */
  begin(budgetMs: number, opts: { endEstimate?: boolean; gate?: (estS: number) => boolean } = {}) {
    this.deadline = Date.now() + budgetMs; this.lastStats = null; this.endEstimate = !!opts.endEstimate; this.gate = opts.gate; this.gateAsked = false; this.formWhy = "";
  }
  todayISO() { return this.c.today || ""; }

  private async extract<T>(js: string): Promise<T | null> { return this.c.evalApp<T>(js).catch(() => null); }
  /** Open the list page and learn its form (once per shift). */
  private formWhy = "";
  private async loadForm(): Promise<typeof this.form> {
    if (this.form) return this.form;
    if (this.formWhy) return null; // this task already tried (run 265 item 127: two tries of ~17 s each on a suspended account)
    const tryPath = async (path: string) => {
      if (!(await this.c.navTo(path, /Appointments? from|Show appointments|Filter appointments|Appointment list/i, 9000).catch(() => false))) return null;
      for (let i = 0; i < 40; i++) {
        const f = await this.extract<{ controls: RawControl[] }>(FORM_EXTRACT);
        const map = f ? mapForm(f.controls) : {};
        if (f && map.from && map.to && map.status) return { path, map, controls: f.controls };
        await sleep(100);
      }
      return null;
    };
    let f = await tryPath("/schedule/appointments");
    if (!f && await this.c.evalApp<boolean>(`return /account is suspended/i.test((doc.body&&doc.body.textContent)||'')`).catch(() => false)) {
      this.formWhy = "the site says this account is suspended (try again later)"; return null; // the schedule link below would only wait again
    }
    if (!f) { // find the list by its link label from the schedule
      await this.c.navTo("/schedule", /Schedule|Today|Provider/i, 8000).catch(() => false);
      const href = await this.c.evalApp<string>(`const a=[...doc.querySelectorAll('a[href]')].find(x=>/appointment list|all appointments/i.test(x.textContent||'')); return a?a.getAttribute('href').split('?')[0]:''`).catch(() => "");
      if (href) f = await tryPath(href);
    }
    this.form = f;
    if (!f) this.formWhy = "appointment list / filter form not found";
    return f;
  }
  async locations(): Promise<string[] | null> {
    const f = await this.loadForm(); if (!f?.map.location) return null;
    return f.map.location.options.filter((o) => o.value !== "" && !/^all\b/i.test(o.text)).map((o) => o.text);
  }
  /** The visit types the list's filter offers (option labels), or null when the form has no single "Visit type" select. */
  async visitTypes(): Promise<string[] | null> {
    const f = await this.loadForm(); if (!f?.map.type) return null;
    return f.map.type.options.filter((o) => o.value !== "" && !/^all\b/i.test(o.text)).map((o) => o.text.trim());
  }
  async roster(): Promise<Array<{ label: string; active: boolean | null }> | null> {
    const f = await this.loadForm(); if (!f?.map.provider) return null;
    return f.map.provider.options.filter((o) => o.value !== "" && !/^all\b/i.test(o.text))
      .map((o) => ({ label: o.text, active: /^active$/i.test(o.group) ? true : /^inactive$/i.test(o.group) ? false : null }));
  }

  /** Read the page until it is settled on these filter values: the controls show them and two reads agree.
   *  `fast` (Show-more loads): poll every 40 ms and skip the form read (a press does not touch the filters; the
   *  heading's dates are still checked and the form is checked once when the walk ends). */
  private async settled(want: Record<string, string>, fromISO: string, toISO: string, timeoutMs: number, prevKey = "", fast = false): Promise<{ page: ParsedPage; raw: RawPage; capped?: boolean } | null> {
    const t0 = Date.now(); let last = ""; let raw: RawPage | null = null;
    while (Date.now() - t0 < timeoutMs) {
      raw = await this.extract<RawPage>(PAGE_EXTRACT);
      const f = fast ? { controls: [] as RawControl[] } : await this.extract<{ controls: RawControl[] }>(FORM_EXTRACT);
      // After Next: an empty "No more results" page (practice caps the list at 500 rows): the read can't be complete.
      if (raw && prevKey && raw.empty && !raw.tables.some((t) => t.rows.length)) return { page: parseListPage(raw), raw, capped: true };
      if (raw && f && !raw.loading) {
        const byName = new Map(f.controls.filter((c) => c.name).map((c) => [c.name, c.value]));
        const ok = fast || Object.entries(want).every(([k, v]) => (byName.get(k) ?? "") === v);
        const page = parseListPage(raw);
        const hOk = !page.heading || (page.heading.from === fromISO && page.heading.to === toISO);
        if (ok && hOk && page.range) {
          const k = pageKey(page, raw);
          if (k === last && k !== prevKey) return { page, raw };
          last = k;
        } else last = "";
      }
      await sleep(fast ? 40 : 80);
    }
    this.lastRaw = raw;
    return null;
  }
  private lastRaw: RawPage | null = null;
  /** The site's own refusal, if the page says one: its nginx "503 Service Temporarily Unavailable" or the app's "This account is suspended" (run 265). */
  private async refusal(): Promise<string> {
    const top = await this.c.evalTop<string>("document.body ? document.body.innerText.slice(0, 400) : ''").catch(() => "");
    const app = await this.extract<string>("return (doc.body ? (doc.body.innerText || doc.body.textContent || '') : '').slice(0, 400)");
    return `${top ?? ""} ${app ?? ""}`.match(/503 Service Temporarily Unavailable|This account is suspended|Try again later/i)?.[0] ?? "";
  }
  /** The form still shows the filters (checked once at the end of a Show-more walk). */
  private async formShows(want: Record<string, string>): Promise<boolean> {
    const f = await this.extract<{ controls: RawControl[] }>(FORM_EXTRACT); if (!f) return false;
    const byName = new Map(f.controls.filter((c) => c.name).map((c) => [c.name, c.value]));
    return Object.entries(want).every(([k, v]) => (byName.get(k) ?? "") === v);
  }

  /** One retry, on a fresh load, when the walk was cut by the app reloading itself (practice: the page's session
   *  expires a few seconds after a load; the next click reloads the list on page 1 with 25 rows) or a page never
   *  rendered. A list that is cut short by the site (an empty "No more results" page, or a "Show more" list that
   *  stops well short of its "about N" estimate) is read again one day at a time (each day's list is short), and
   *  the days' rows must add up to the whole range's estimate. Every other failure — and a second one — is final. */
  async read(filter: ReadFilter): Promise<{ rows: ApptRow[] } | { fail: string }> {
    if (this.endEstimate && this.spawn && parallelTabs() > 1) {
      const p = await this.readParallel(filter).catch((e) => ({ fail: `parallel read threw ${String(e).slice(0, 100)}` }));
      if (p) return p;
    }
    return this.readSeq(filter);
  }

  /** A long Show-more list read as date chunks on several tabs at once (the site serves ~20 rows per press, ~0.25 s a press: a
   *  month at a busy location is 50-110 presses in a row). A first page of the whole range states its size ("about N"); the range is
   *  cut into contiguous day chunks of ~CHUNK_ROWS rows each (the site cuts a list at 300), every chunk is read by the ordinary
   *  sequential read (its own proofs: endFormProof, onward parts, busy retries) on whichever tab is free, and the chunks must cover
   *  the range exactly and add up to the whole range's size. null = not a list for this (a short one, no tabs): read it in one go. */
  private async readParallel(filter: ReadFilter): Promise<{ rows: ApptRow[] } | { fail: string } | null> {
    const days: string[] = []; for (let d = filter.from; d <= filter.to; d = addDay(d)) { days.push(d); if (days.length > 70) return null; }
    if (days.length < 6) return null;
    const t0 = Date.now();
    const pr = await this.readOnce1(filter, true);
    if ("fail" in pr || !pr.est || !pr.est.cumulative || !pr.est.approx || pr.est.plus || pr.est.end || pr.est.total <= PARALLEL_MIN_ROWS) return null;
    const whole = pr.est;
    const need = Math.ceil(whole.total / 20) + 1; // the same request budget as the sequential read (the chunks' own loads come on top)
    if (need > aggMaxReq()) return { fail: `pacer: about ${whole.total} rows need ~${need} requests, over the ${aggMaxReq()} the site takes at once (AGG_MAX_REQ)` };
    const dens = whole.total / days.length;
    if (dens > SHOW_MORE_CAP - 40) return { fail: `parallel: about ${Math.round(dens)} rows a day on average — a day's list would be cut at ${SHOW_MORE_CAP} rows` };
    const dChunk = Math.max(1, Math.floor(CHUNK_ROWS / dens));
    const chunks: Array<{ from: string; to: string }> = [];
    for (let i = 0; i < days.length; i += dChunk) chunks.push({ from: days[i], to: days[Math.min(days.length, i + dChunk) - 1] });
    const workers = Math.min(parallelTabs(), chunks.length);
    const estS = ((whole.total / 20) * PRESS_GUESS_MS * 1.15 + chunks.length * 700) / workers / 1000 + 3 + RESOLVE_RESERVE_MS / 1000;
    this.gateAsked = true;
    if (Date.now() + estS * 1000 > this.deadline) return { fail: `pacer: about ${whole.total} rows in ${chunks.length} chunks on ${workers} tabs need ~${Math.round(estS)} s, over the task budget` };
    if (this.gate && !this.gate(estS)) return { fail: `pacer: no slack for ~${Math.round(estS)} s of parallel reading (about ${whole.total} rows)` };
    const tabs = await this.acquireTabs(workers);
    if (tabs.length < 2) { this.gateAsked = false; return null; } // no second tab opened: the ordinary sequential read (fewer page loads than chunks), gated on its own estimate
    const out: Array<{ rows: ApptRow[] } | { fail: string } | undefined> = await this.runOn(tabs, chunks.length, (w, i) => w.readSeq({ ...filter, ...chunks[i] }));
    // a chunk that failed on a tab (a busy site, a slow load) gets one more go here, alone
    for (let i = 0; i < chunks.length; i++) if (out[i] && "fail" in out[i]! && Date.now() + 3000 < this.deadline) out[i] = await this.readSeq({ ...filter, ...chunks[i] });
    const rows: ApptRow[] = []; const seen = new Set<string>();
    for (let i = 0; i < chunks.length; i++) {
      const r = out[i]; if (!r || "fail" in r) return { fail: `parallel chunk ${chunks[i].from}..${chunks[i].to}: ${r ? r.fail : "not read"}` };
      for (const x of r.rows) {
        if (x.dateISO < chunks[i].from || x.dateISO > chunks[i].to) return { fail: `parallel chunk ${chunks[i].from}..${chunks[i].to}: a row dated ${x.dateISO}` };
        if (seen.has(x.key)) return { fail: `parallel: a row is listed twice (${x.key})` }; seen.add(x.key); rows.push(x);
      }
    }
    // the chunks are an exact partition of the range, each proven on its own; together they must match the whole range's estimate
    if (rows.length < whole.total - EST_BELOW || rows.length > whole.total + EST_ABOVE) return { fail: `parallel: ${rows.length} rows in ${chunks.length} chunks, the whole range says about ${whole.total}` };
    const ms = Date.now() - t0;
    this.lastStats = { pages: chunks.length, rows: rows.length, ms, perPageMs: Math.round(ms / chunks.length), pageSize: 0, via: `parallel×${tabs.length}` };
    this.log({ event: "aggregate-read", filter, ok: true, ...this.lastStats, estimate: whole.total });
    return { rows };
  }

  /** This tab plus up to `want - 1` more (spawned once, kept). Fewer when tabs can't be opened. */
  private async acquireTabs(want: number): Promise<ApptList[]> {
    const tabs: ApptList[] = [this];
    while (tabs.length < want && this.spawn) {
      if (this.pool.length < tabs.length) { const t = await this.spawn().catch(() => null); if (!t) break; this.pool.push(new ApptList(t, this.log)); }
      tabs.push(this.pool[tabs.length - 1]);
    }
    return tabs;
  }
  /** fn(tab, i) for i < n, the tabs pulling indices from one counter; a thrown error is a fail for that index. Other tabs get this task's deadline. */
  private async runOn<T extends { fail?: string } | object>(tabs: ApptList[], n: number, fn: (w: ApptList, i: number) => Promise<T>): Promise<Array<T | { fail: string }>> {
    const out = new Array<T | { fail: string }>(n); let next = 0;
    await Promise.all(tabs.map(async (w) => {
      if (w !== this) w.begin(Math.max(1000, this.deadline - Date.now()), { endEstimate: true });
      for (;;) { const i = next++; if (i >= n) return; out[i] = await fn(w, i).catch((e) => ({ fail: `threw ${String(e).slice(0, 80)}` })); }
    }));
    return out;
  }

  /** The list size each filter states, from its first page only ("Showing 20 of about 750" → {total: 750, exact: false}), several at once on the
   *  tabs. Used by top-providers (aggregate.topByEstimate); asks the time gate once for the whole batch. */
  async estimates(filters: ReadFilter[]): Promise<Array<{ total: number; exact: boolean } | { fail: string }>> {
    if (!this.endEstimate) return filters.map(() => ({ fail: "list sizes are only used where finished-list estimates are accepted (begin({endEstimate}))" }));
    const tabs = await this.acquireTabs(filters.length > 1 ? parallelTabs() : 1);
    if (filters.length > 1) {
      const estS = (filters.length * 0.9 + 10 * 3.5) / tabs.length + 3;
      if (Date.now() + estS * 1000 > this.deadline) return filters.map(() => ({ fail: `pacer: ${filters.length} list sizes and a few reads need ~${Math.round(estS)} s, over the task budget` }));
      this.gateAsked = true;
      if (this.gate && !this.gate(estS)) return filters.map(() => ({ fail: `pacer: no slack for ~${Math.round(estS)} s of per-provider lists` }));
    }
    const res = await this.runOn(tabs, filters.length, async (w, i) => {
      const r = await w.readOnce(filters[i], true);
      if ("fail" in r) return { fail: r.fail };
      const e = r.est; if (!e) return { fail: "the list states no size" };
      if (e.plus) return { fail: `the list's size is only a lower bound (${e.total}+)` };
      return { total: e.total, exact: !e.approx };
    });
    return res as Array<{ total: number; exact: boolean } | { fail: string }>;
  }
  /** Several proven-complete reads at once on the tabs. */
  async readMany(filters: ReadFilter[]): Promise<Array<{ rows: ApptRow[] } | { fail: string }>> {
    const tabs = await this.acquireTabs(Math.min(parallelTabs(), filters.length));
    return this.runOn(tabs, filters.length, (w, i) => w.readSeq(filters[i]));
  }

  /** readSeq0, and for a typed read every row must show the asked visit type (the filter really applied). */
  private async readSeq(filter: ReadFilter): Promise<{ rows: ApptRow[] } | { fail: string }> {
    const r = await this.readSeq0(filter);
    if ("fail" in r || !filter.visitType) return r;
    const want = normName(filter.visitType);
    const off = r.rows.find((x) => normName(x.visitType) !== want);
    return off ? { fail: off.visitType ? `visit-type filter not applied (a row of type "${off.visitType}")` : "the list shows no Visit type column to check the filter against" } : r;
  }
  private async readSeq0(filter: ReadFilter): Promise<{ rows: ApptRow[] } | { fail: string }> {
    let r1 = await this.readOnce(filter);
    if ("fail" in r1 && /starts at 1, expected|did not render|did not settle/.test(r1.fail) && Date.now() < this.deadline && !(this.endEstimate && Date.now() < busyUntil)) {
      this.c.trace({ act: "retry", what: "appointment list read", value: r1.fail });
      await this.c.navTo("/schedule", /Schedule|Today/i, 6000).catch(() => false);
      const r2 = await this.readOnce(filter);
      r1 = "fail" in r2 ? { fail: `${r2.fail} (after a retry: ${r1.fail})`, split: r2.split, est: r2.est, rows: r2.rows } : r2;
    }
    // By day, every day on its EXACT footer — one reader for two triggers (s4 merges s3's re-read and s3-skips' paced read):
    //  (a) estEnd: the whole list loaded and ended on an estimate ("about 250 appointments"): no proof (endFormProof always refuses);
    //      a short range (≤ BY_DAY_MAX_DAYS) is re-read one day at a time;
    //  (b) a range over the one-burst request cap (AGG_MAX_REQ: "about 425 rows need ~23 requests, over the 17 …") on an aggregate.
    // A Set 1 day list under 100 rows ends on its EXACT count ("89 appointments": run 278, 81 such footers; probe-278-appts-northgate-
    // exact89), so every day proves itself; a day of 100+ rows ends on "about N" and fails the whole read (`exactOnly`; endFormProof
    // refuses every estimate anyway). The cost is projected first from the site's refill rate (siteBudget), capped by AGG_BY_DAY_MAX_S,
    // and asked of the pacer once.
    const estEnd = "fail" in r1 && !!r1.estEnd;
    const overCap = "fail" in r1 && this.endEstimate && /over the \d+ the site takes at once/.test(r1.fail) && filter.from < filter.to && !!r1.est && r1.est.total > 0;
    if ("fail" in r1 && !this.exactOnly && (estEnd || overCap)) {
      let days = 0; for (let d = filter.from; d <= filter.to && days <= 62; d = addDay(d)) days++;
      if (estEnd) {
        if (days < 2) return { fail: `${r1.fail} (a single day: nothing smaller to read)` };
        if (days > BY_DAY_MAX_DAYS) return { fail: `${r1.fail} (${days} days: over the ${BY_DAY_MAX_DAYS}-day daywise re-read limit)` };
      }
      if (days > 62) return { fail: `${r1.fail}; ${days}+ days: too long to read by day` };
      const total = r1.est && r1.est.total > 0 ? r1.est.total : (r1.rows?.length ?? 0);
      const presses = Math.ceil(total / 20), req = days + presses;
      // paced, a request takes max(its own round trip, the refill period 0.72 s): ~0.4 s for the ~15 the burst allows, 0.72 s each after,
      // + 15 % (byDay.test on the fitted bucket: a 425-row month 15 s, a 625-row one 28 s; the projection must stay above the real cost)
      const needMs = Math.round((Math.min(req, 15) * 400 + Math.max(0, req - 15) * 720) * 1.15) + Math.min(projectedWaitMs(1), 5000);
      const capMs = Number(process.env.AGG_BY_DAY_MAX_S ?? 50) * 1000; // one aggregate never reads by day for longer than this, whatever the budget
      if (needMs > capMs) return { fail: `${r1.fail}; by day: ${days} day loads + ~${presses} presses need ~${Math.round(needMs / 1000)} s (paced), over the ${capMs / 1000} s by-day cap (AGG_BY_DAY_MAX_S)` };
      if (Date.now() + needMs + RESOLVE_RESERVE_MS > this.deadline) return { fail: `${r1.fail}; pacer: by day: ${days} day loads + ~${presses} presses need ~${Math.round(needMs / 1000)} s (paced), over the task budget` };
      if (this.gate && !this.gateAsked) { this.gateAsked = true; if (!this.gate(needMs / 1000 + RESOLVE_RESERVE_MS / 1000)) return { fail: `pacer: no slack for ~${Math.round(needMs / 1000)} s of day reads (about ${total} rows in ${days} days)` }; }
      this.c.trace({ act: "split", what: `appointment list by day (exact day footers, paced; ${estEnd ? "finished list ended on an estimate" : "over the request cap"})`, value: `${days} days, ~${req} requests, ~${Math.round(needMs / 1000)} s (${r1.fail})` });
      this.exactOnly = true;
      try { return await this.readByDay(filter, r1); } finally { this.exactOnly = false; }
    }
    if (!("fail" in r1) || !r1.split) return "fail" in r1 ? { fail: r1.fail } : r1;
    if (r1.rows?.length) return this.readOnward(filter, r1 as { fail: string; rows: ApptRow[]; est?: Range });
    if (filter.from >= filter.to) return { fail: r1.fail };
    return this.readByDay(filter, r1);
  }

  /** A Show-more list the site cut short (run 164: the button goes away at 300 rows, "Showing 300 of about 1,000"):
   *  the rows shown are the list's first rows in date order, so every day before the last day shown is complete.
   *  Keep those, and read on from that last day (it is read again whole) to the end of the range. Each part must be
   *  in date order inside its range; the parts' rows must add up to the whole range's estimate. One day longer than
   *  the cut declines. Each part's Show-more walk keeps the task budget (its estimate is the rest of the range). */
  private async readOnward(filter: ReadFilter, first: { fail: string; rows: ApptRow[]; est?: Range }): Promise<{ rows: ApptRow[] } | { fail: string }> {
    const t0 = Date.now(); const out: ApptRow[] = []; const seen = new Set<string>();
    let cur = filter.from; let part: { rows: ApptRow[]; fail?: string; est?: Range } = first; let parts = 1;
    const whole = first.est;
    this.c.trace({ act: "split", what: "appointment list onward by date", value: `${first.rows.length} rows (${first.fail})` });
    for (;;) {
      const rows = part.rows;
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].dateISO < cur || rows[i].dateISO > filter.to) return { fail: `onward: a row dated ${rows[i].dateISO} outside ${cur}..${filter.to} (whole range: ${first.fail})` };
        if (i && rows[i].dateISO < rows[i - 1].dateISO) return { fail: `onward: rows not in date order (${rows[i - 1].dateISO} then ${rows[i].dateISO})` };
      }
      const keep = part.fail === undefined ? rows : (() => { const last = rows[rows.length - 1]?.dateISO; return last && last > cur ? rows.filter((r) => r.dateISO < last) : null; })();
      if (!keep) return { fail: `onward: one day (${cur}) holds more rows than the list shows (${rows.length}; ${part.fail})` };
      for (const r of keep) { if (seen.has(r.key)) return { fail: `onward: a row is listed twice (${r.key})` }; seen.add(r.key); out.push(r); }
      if (part.fail === undefined) break;
      const next = rows[rows.length - 1].dateISO;
      // the part read from `next` must account for the rest of what the previous part's estimate promised
      if (++parts > 60) return { fail: "onward: more than 60 parts" };
      cur = next;
      const r = await this.readOnce({ ...filter, from: cur });
      if ("fail" in r && !(r.split && r.rows?.length)) return { fail: `onward from ${cur}: ${r.fail} (whole range: ${first.fail})` };
      const prevEst = part.est; part = "fail" in r ? { rows: r.rows!, fail: r.fail, est: r.est } : { rows: r.rows, est: r.est };
      if (prevEst && part.est && !prevEst.plus && !part.est.plus) {
        const kept = keep.length; const tol = approxTol(prevEst.total);
        if (Math.abs(kept + part.est.total - prevEst.total) > tol + approxTol(part.est.total)) return { fail: `onward from ${cur}: ${kept} rows kept + about ${part.est.total} left ≠ about ${prevEst.total}` };
      }
    }
    if (this.endEstimate && whole?.approx && !whole.plus && (out.length < whole.total - EST_BELOW || out.length > whole.total + EST_ABOVE))
      return { fail: `onward: ${out.length} rows in ${parts} parts, but the whole range says about ${whole.total} (a finished list's rows are within ${EST_BELOW} below / ${EST_ABOVE} above its estimate)` };
    if (whole && whole.total > 0 && (whole.plus ? out.length < whole.total : Math.abs(out.length - whole.total) > approxTol(whole.total)))
      return { fail: `onward: ${out.length} rows in ${parts} parts, but the whole range shows ${whole.approx ? "about " : ""}${whole.total}${whole.plus ? "+" : ""}` };
    this.lastStats = { pages: parts, rows: out.length, ms: Date.now() - t0, perPageMs: Math.round((Date.now() - t0) / parts), pageSize: 0, via: "onward" };
    this.log({ event: "aggregate-read", filter, ok: true, ...this.lastStats });
    return { rows: out };
  }

  /** The range read one day at a time (contiguous days partition the range, whatever calendar the filter uses).
   *  Each day must be proven complete on its own; the sum must match the whole range's estimate. */
  private async readByDay(filter: ReadFilter, whole: { fail: string; est?: Range }): Promise<{ rows: ApptRow[] } | { fail: string }> {
    const t0 = Date.now();
    const days: string[] = []; for (let d = filter.from; d <= filter.to; d = addDay(d)) { days.push(d); if (days.length > 62) return { fail: `${whole.fail}; range too long to read by day` }; }
    this.c.trace({ act: "split", what: "appointment list by day", value: `${days.length} days (${whole.fail})` });
    const rows: ApptRow[] = [];
    for (let i = 0; i < days.length; i++) {
      const r = await this.readOnce({ ...filter, from: days[i], to: days[i] });
      if ("fail" in r) return { fail: `by day: ${days[i]}: ${r.fail} (whole range: ${whole.fail})` };
      rows.push(...r.rows);
      const per = (Date.now() - t0) / (i + 1);
      if (i + 1 < days.length && Date.now() + per * (days.length - i - 1) * 1.1 > this.deadline)
        return { fail: `pacer: by day, ~${days.length - i - 1} more days at ${Math.round(per)} ms exceed the task budget (whole range: ${whole.fail})` };
    }
    const est = whole.est;
    if (est && est.total > 0 && (est.plus ? rows.length < est.total : Math.abs(rows.length - est.total) > approxTol(est.total)))
      return { fail: `by day: ${rows.length} rows, but the whole range shows ${est.approx ? "about " : ""}${est.total}${est.plus ? "+" : ""}` };
    this.lastStats = { pages: days.length, rows: rows.length, ms: Date.now() - t0, perPageMs: Math.round((Date.now() - t0) / days.length), pageSize: 0, via: this.exactOnly ? "by-day-exact" : "by-day" };
    this.log({ event: "aggregate-read", filter, ok: true, ...this.lastStats, ...(this.exactOnly ? { exact: true } : {}) });
    return { rows };
  }

  /** The first page's footer for a filter, nothing walked: the list's own size statement (contextResolve cross-checks
   *  that the locations' rows add up to the all-locations estimate). */
  async peek(filter: ReadFilter): Promise<{ est: Range } | { fail: string }> {
    const r = await this.readOnce(filter, true);
    return "fail" in r || !r.est ? { fail: "fail" in r ? r.fail : "the first page states no size" } : { est: r.est };
  }
  /** One read, again from a fresh load when the site answered with its degraded "Wrenfield is busy … fewer rows than usual" list
   *  (run 278: items 130 and 195 died on "Show more 4 added no rows" on exactly such a page). Rows of a busy page are never kept. */
  private async readOnce(filter: ReadFilter, probeOnly = false): Promise<{ rows: ApptRow[]; est?: Range } | { fail: string; split?: boolean; est?: Range; rows?: ApptRow[]; busy?: boolean; estEnd?: boolean }> {
    const retries = this.endEstimate ? busyRetries() : 2; // aggregates: a busy list is a stop sign (busyUntil), not a reason to load it again
    for (let i = 0; ; i++) {
      const r = await this.readOnce1(filter, probeOnly);
      if ("fail" in r && r.busy) pacer.noteBusy();
      // v2: no second and third try of a busy page (run 265: all 14 retries met the same busy page, and the site suspended the account after them)
      if (!("fail" in r) || !r.busy || i >= retries || pacer.v2 || Date.now() + 5000 > this.deadline) return r;
      // run s3a: the 1.5 s / 3 s pauses were too short (568, 623, 681 ms → busy again on the first retry, 3 of 3 times); the governor
      // waits until the predicted latency is back under its target (~3.3 s from the wall) before the fresh load
      this.c.trace({ act: "retry", what: "appointment list read (site busy)", value: String(i + 1), waitMs: await paceList(this.deadline) });
      await this.c.navTo("/schedule", /Schedule|Today/i, 6000).catch(() => false); // a fresh list starts on page 1
    }
  }
  private async readOnce1(filter: ReadFilter, probeOnly = false): Promise<{ rows: ApptRow[]; est?: Range } | { fail: string; split?: boolean; est?: Range; rows?: ApptRow[]; busy?: boolean; estEnd?: boolean }> {
    const t0 = Date.now(); let est: Range | undefined; let lat: number[] | undefined;
    this.pacedMs = 0; let loadMs = 0;
    const fail = (why: string, split = false, rows?: ApptRow[], busy = false, estEnd = false) => {
      if (busy) { busyUntil = Date.now() + busyCooldownMs(); noteBusyPage(); }
      this.log({ event: "aggregate-read", filter, ok: false, why, ms: Date.now() - t0, ...(rows ? { rowsRead: rows.length } : {}), ...(lat?.length ? { lat } : {}), ...(busy ? { busy } : {}), ...(this.pacedMs ? { paced: this.pacedMs } : {}), ...(loadMs ? { loadMs } : {}) });
      return { fail: why, split, est, rows, ...(busy ? { busy } : {}), ...(estEnd ? { estEnd } : {}) };
    };
    if (Date.now() >= this.deadline) return fail("no time budget left for a list read (pacer)");
    if (this.endEstimate && Date.now() < busyUntil) return fail(`the site was busy ${Math.round((busyCooldownMs() - (busyUntil - Date.now())) / 1000)} s ago: no aggregate list is read for ${Math.round(busyCooldownMs() / 1000)} s after a busy page (AGG_BUSY_COOLDOWN_S)`);
    const f = await this.loadForm(); if (!f) return fail(this.formWhy || "appointment list / filter form not found");
    const m = f.map;
    const st = filter.status === "any" ? m.status!.options.find((o) => o.value === "" && /^all\b/i.test(o.text)) : optFor(m.status, filter.status, (s) => statusOf(s).toLowerCase());
    if (!st) return fail(filter.status === "any" ? "no 'All statuses' choice in the list filter" : `status "${filter.status}" not offered by the list filter`);
    const want: Record<string, string> = { [m.from!.name]: filter.from, [m.to!.name]: filter.to, [m.status!.name]: st.value };
    if (filter.location) { const o = optFor(m.location, filter.location); if (!o) return fail(`location "${filter.location}" not offered by the list filter`); want[m.location!.name] = o.value; }
    else if (m.location) { const all = m.location.options.find((o) => o.value === "" && /^all\b/i.test(o.text)); if (!all) return fail("no 'All locations' choice in the list filter"); want[m.location.name] = ""; }
    if (filter.provider) { const o = optFor(m.provider, filter.provider, (s) => normName(stripCred(s))); if (!o) return fail(`provider "${filter.provider}" not offered by the list filter`); want[m.provider!.name] = o.value; }
    else if (m.provider) want[m.provider.name] = "";
    if (filter.visitType) { // context reads (a wound visit's list): the type is set by option label and every row read back is checked in readSeq
      const o = optFor(m.type, filter.visitType); if (!o) return fail(`visit type "${filter.visitType}" not offered by the list filter`);
      want[m.type!.name] = o.value;
    }
    if (Object.keys(want).some((k) => !k)) return fail("a filter control has no name");
    // Every list read depends on the session's location picker (a practice run with the picker stuck on one
    // location read other locations' filtered lists as empty and answered "0"): it must say All locations.
    if (!(await this.c.ensureAllLocations())) return fail(`session location picker is "${(await this.c.pickerLabel()).slice(0, 40)}", not All locations`);
    const qs = Object.entries(want).filter(([, v]) => v !== "").map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
    const here = await this.c.evalTop<string>("location.pathname+location.search").catch(() => "");
    if (here === `${f.path}?${qs}`) await this.c.navTo("/schedule", /Schedule|Today/i, 6000).catch(() => false); // a fresh list starts on page 1
    this.pacedMs += await paceList(this.deadline); // the site's list-request budget (siteBudget): wait for the latency to decay before the load
    const tLoad = Date.now();
    await this.c.navTo(`${f.path}?${qs}`, /Appointments? from|Showing|No appointments|appointments?/i, 9000).catch(() => false);
    loadMs = Date.now() - tLoad; // the navigation alone (the settle's polling is not the site's time)
    let s = await this.settled(want, filter.from, filter.to, 6000);
    if (s) noteLoad(loadMs);
    let via = "url";
    if (!s && this.endEstimate) { // the site refusing us (run 265: nginx 503, then "This account is suspended") is not a filter the app ignored: stop, don't submit the form for 8 s more
      const why = await this.refusal();
      if (why) { busyUntil = Date.now() + busyCooldownMs(); return fail(`the site refuses the list: "${why}"`, false, undefined, true); }
    }
    if (!s) { // the app didn't take the URL: fill the form by label and submit it
      via = "form";
      await this.c.evalApp(`const want=${JSON.stringify(want)}; const form=[...doc.querySelectorAll('form')].find(fm=>Object.keys(want).every(n=>fm.querySelector('[name="'+n+'"]')));
        if(!form) return false; for(const [n,v] of Object.entries(want)){ const e=form.querySelector('[name="'+n+'"]'); e.value=v; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); }
        const b=[...form.querySelectorAll('button[type=submit],button:not([type])')].find(x=>/show|search|apply|filter|go/i.test(x.textContent||'')); if(!b) return false; b.click(); return true;`).catch(() => false);
      this.c.trace({ act: "submit", what: "appointment list filter", value: qs });
      s = await this.settled(want, filter.from, filter.to, 8000);
    }
    if (!s) { busyUntil = Date.now() + busyCooldownMs(); return fail("list did not settle on the requested filters"); } // run 265: a 503 page, then the account-suspended page
    if (s.raw.busy) return fail("list busy: Wrenfield says it is busy and shows fewer rows than usual", false, undefined, true);
    // a fresh tab has no picker to check before its first load (ensureAllLocations passes on an empty label): check once the list is up
    { const pl = await this.c.pickerLabel().catch(() => ""); if (pl && !/all locations/i.test(pl)) return fail(`session location picker is "${pl.slice(0, 40)}", not All locations (after the list loaded)`); }
    est = s.page.range;
    if (probeOnly) return { rows: [], est };
    // the request budget: the loads/presses this list needs, from its first page's size, against what the site has been seen to take (aggMaxReq)
    const overReq = (perRequest: number) => {
      const need = est && est.total > 0 ? Math.ceil(est.total / Math.max(1, perRequest)) + 1 : 0;
      return this.endEstimate && need > aggMaxReq() ? `pacer: about ${est!.total}${est!.plus ? "+" : ""} rows need ~${need} requests, over the ${aggMaxReq()} the site takes at once (AGG_MAX_REQ)` : "";
    };
    if (s.page.range?.cumulative) { // "Showing 20 of about 1,000" + Show more: rows are appended to the same table
      const over = overReq(s.page.rows.length); if (over) return fail(over);
      lat = [];
      const w = await this.walkMore(s, want, filter, t0, lat);
      if ("fail" in w) return fail(w.fail, !!w.split, w.split && w.rows?.length && (await this.formShows(want)) ? w.rows : undefined, !!w.busy, !!w.estEnd);
      if (!(await this.formShows(want))) return fail("the filter form changed during the Show-more walk");
      const ms = Date.now() - t0;
      this.lastStats = { pages: w.clicks + 1, rows: w.rows.length, ms, perPageMs: Math.round(ms / (w.clicks + 1)), pageSize: w.step, via: via + (w.viaEnd ? "+more~" : "+more") };
      this.log({ event: "aggregate-read", filter, ok: true, ...this.lastStats, ...(lat?.length ? { lat } : {}), ...(this.pacedMs ? { paced: this.pacedMs } : {}), ...(loadMs ? { loadMs } : {}) });
      return { rows: w.rows, est };
    }
    // Biggest page size the list offers (a page-size choice is a view setting, not a change to data).
    let pageSize = s.page.range!.b - s.page.range!.a + 1;
    const pp = (await this.extract<{ controls: RawControl[] }>(FORM_EXTRACT).then((x) => x ? mapForm(x.controls).perPage : undefined));
    if (pp && s.page.range!.total > pageSize) {
      const opts = pp.options.map((o) => ({ v: o.value, n: Number((o.text.match(/\d+/) || [""])[0]) })).filter((o) => o.n > 0).sort((a, b) => b.n - a.n);
      if (opts.length && opts[0].n > pageSize && opts[0].v !== pp.value) {
        const ok = await this.c.evalApp<boolean>(`const s=[...doc.querySelectorAll('select')].find(e=>${JSON.stringify(pp.name)}?e.name===${JSON.stringify(pp.name)}:(e.closest('label')&&/per page|rows/i.test(e.closest('label').textContent||''))); if(!s) return false; s.value=${JSON.stringify(opts[0].v)}; s.dispatchEvent(new Event('input',{bubbles:true})); s.dispatchEvent(new Event('change',{bubbles:true})); return true;`).catch(() => false);
        this.c.trace({ act: "select", what: "Rows per page", value: String(opts[0].n) });
        if (ok) {
          const big = await this.settled(want, filter.from, filter.to, 6000, pageKey(s.page, s.raw));
          if (big && big.page.range && big.page.range.a === 1 && big.page.rows.length > pageSize) { s = big; pageSize = opts[0].n; }
        }
      }
    }
    { const over = overReq(pageSize); if (over) return fail(over); }
    // walk the pages
    const rows: ApptRow[] = []; let page = s.page, raw = s.raw, pages = 0; const pageMs: number[] = []; let tp = Date.now();
    const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
    for (;;) {
      pages++;
      if (page.problems.length) return fail(`page ${pages}: ${page.problems.slice(0, 2).join("; ")}`);
      const r = page.range!;
      if (r.total === 0) { if (rows.length || page.rows.length) return fail("empty footer after rows"); break; }
      if (r.a !== rows.length + 1) return fail(`page ${pages} starts at ${r.a}, expected ${rows.length + 1}`);
      // No Location column: the list was filtered to one location (the controls were verified to show it).
      if (page.rows.some((x) => !x.location)) {
        if (!filter.location) return fail(`page ${pages}: no location column on an all-locations read`);
        for (const x of page.rows) if (!x.location) x.location = filter.location;
      }
      rows.push(...page.rows);
      const exact = !r.plus && !r.approx;
      if (exact && r.b > r.total) return fail(`page ${pages} ends past the total`);
      const lastPage = !raw.next.present || raw.next.disabled;
      if (lastPage) {
        if (raw.empty) return fail(`list capped: "No more results" after ${rows.length} rows`, true);
        // the end is proven only by an exact total the rows reach (listFooter.isComplete); a "+" bound or an "about"
        // estimate never is — such a list may be capped, so it is re-read in exact pieces (by day) or declined
        const v = isComplete(rows.length, listFooter(raw.footer), { next: raw.next.present ? "disabled" : "none" });
        if (!v.complete) return fail(`no next page: ${v.why}${v.capped ? " (list may be capped)" : ""}`, v.capped);
        break;
      }
      if (exact && r.b === r.total) return fail("total reached but the pager still offers Next");
      // pacer: project the rest from the exact total, or from how far into the date range we are
      pageMs.push(Date.now() - tp); tp = Date.now();
      const per = pageMs.reduce((a, b) => a + b, 0) / pageMs.length;
      const lastDate = rows[rows.length - 1].dateISO;
      const frac = Math.min(1, Math.max(0.02, (days(filter.from, lastDate) + 1) / (days(filter.from, filter.to) + 1)));
      const estRows = r.plus ? Math.max(r.total, rows.length / frac) : r.approx ? Math.max(r.total, rows.length) : r.total;
      const left = Math.ceil(Math.max(0, estRows - rows.length) / Math.max(1, pageSize));
      if (Date.now() + left * per * 1.15 > this.deadline) return fail(`pacer: ~${left} more pages at ${Math.round(per)} ms exceed the task budget (read ${rows.length} rows in ${pages} pages)`);
      if (pages > 1500) return fail("more than 1500 pages");
      const clicked = await this.c.evalApp<boolean>(`${T_FN} const b=[...doc.querySelectorAll('button,a[role=button]')].filter(b=>!b.closest('[aria-hidden="true"]')&&!b.closest('form')&&b.getAttribute('tabindex')!=='-1').find(b=>/^next(\\s+page)?$/i.test(T(b))||/^next page$/i.test(b.getAttribute('aria-label')||'')); if(!b||b.disabled) return false; b.click(); return true;`).catch(() => false);
      if (!clicked) return fail(`could not press Next on page ${pages}`);
      const prevKey = pageKey(page, raw);
      const nx = await this.settled(want, filter.from, filter.to, 9000, prevKey);
      if (!nx) return fail(`page ${pages + 1} did not render`);
      if (nx.capped) return fail(`list capped: an empty "No more results" page after ${rows.length} rows`, true);
      page = nx.page; raw = nx.raw;
    }
    const ms = Date.now() - t0;
    this.lastStats = { pages, rows: rows.length, ms, perPageMs: Math.round(ms / pages), pageSize, via };
    this.log({ event: "aggregate-read", filter, ok: true, ...this.lastStats });
    return { rows };
  }

  /** A "Show more" list: press it until the list stops offering more, checking every load only APPENDS rows
   *  (the rows already read are unchanged, in order) and the footer counts exactly the rows on the page. The end
   *  is proven by an exact total reached (listFooter.isComplete); "Showing b of about N" with the control gone is an
   *  estimate and proves nothing — the site takes the control away at its cap too (run 164: the 15th press at 300 of
   *  "about 1,000"). A list cut short ("Showing 300 of about 1,000" and no button, "300+", or "No more results") is
   *  returned with split=true and the rows read so far (a prefix) for the onward / by-day re-read. The finished-list
   *  footer ("about 250 appointments", no "Showing", nothing more offered) completes the read only where the caller opted in
   *  (begin({endEstimate})) and endFormProof holds; otherwise it is a plain failure. A page that says the site is busy
   *  (fewer rows than usual) fails the walk as `busy` — the caller reads the list again from a fresh load. */
  private async walkMore(s0: { page: ParsedPage; raw: RawPage }, want: Record<string, string>, filter: ReadFilter, t0: number, clickMs: number[] = []): Promise<{ rows: ApptRow[]; clicks: number; step: number; viaEnd?: boolean } | { fail: string; split?: boolean; rows?: ApptRow[]; busy?: boolean; estEnd?: boolean }> {
    // clickMs: ms each press took (press → settled), the caller logs it as `lat` — the data for fitting the site's request budget
    let page = s0.page, raw = s0.raw, clicks = 0, step = Math.max(1, page.rows.length); let tp = Date.now();
    let prev: string[] = []; let busy = 0;
    for (;;) {
      if (raw.busy) return { fail: `list busy after ${clicks} Show more: Wrenfield says it shows fewer rows than usual`, busy: true };
      if (page.problems.length) return { fail: `after ${clicks} Show more: ${page.problems.slice(0, 2).join("; ")}` };
      const r = page.range!;
      if (!r.cumulative && !r.end) return { fail: "list changed its pager form after Show more" };
      const keys = page.rows.map((x) => x.key);
      if (prev.some((k, i) => keys[i] !== k)) return { fail: `rows already read changed after Show more ${clicks}` };
      if (new Set(keys).size !== keys.length) return { fail: "a row is listed twice" };
      if (page.rows.some((x) => !x.location)) {
        if (!filter.location) return { fail: "no location column on an all-locations read" };
        for (const x of page.rows) if (!x.location) x.location = filter.location;
      }
      if (raw.empty) return { fail: `list capped: "No more results" after ${page.rows.length} rows`, split: true };
      // A time-bounded read (good-faith context): the list is in start-time order, so once a row starts after the asked time every
      // row at or before it is already on the page. The order is proven on the rows read (every adjacent pair), never assumed.
      if (filter.upToStart !== undefined && page.rows.length && page.rows[page.rows.length - 1].start > filter.upToStart) {
        const bad = page.rows.findIndex((x, i) => i > 0 && (x.dateISO < page.rows[i - 1].dateISO || (x.dateISO === page.rows[i - 1].dateISO && x.start < page.rows[i - 1].start)));
        if (bad >= 0) return { fail: `rows not in start-time order (row ${bad + 1} after row ${bad}): a time-bounded read needs a time-ordered list` };
        return { rows: page.rows, clicks, step };
      }
      const exact = !r.plus && !r.approx;
      if (exact && r.b > r.total) return { fail: `${r.b} rows shown for a total of ${r.total}` };
      const more = !!raw.more?.present && !raw.more.disabled;
      if (!more) {
        const st = { more: raw.more?.present ? "disabled" : "none" } as const;
        let v = isComplete(page.rows.length, listFooter(raw.footer), st);
        // context reads (ReadFilter.sealed, contextResolve) also accept the bare end footer of a finished list (listFooter.endSealed)
        if (!v.complete && filter.sealed) v = endSealed(page.rows.length, listFooter(raw.footer), { ...st, empty: raw.empty });
        if (v.complete) return { rows: page.rows, clicks, step };
        // the finished-list estimate footer: never a proof (endFormProof); the caller may re-read a short range by day (readSeq0)
        const estEnd = !!r.end && !!r.approx && !r.plus;
        const endWhy = estEnd ? ` (${endFormProof(page.rows.length, s0.page.range, r).why})` : "";
        // cut (rows missing for sure: a bound, or fewer rows than the total) → the prefix read so far is reusable
        const cut = r.plus || (!r.end && r.b < r.total);
        return { fail: `no Show more: ${v.why}${cut ? " (list cut)" : ""}${endWhy}`, split: cut, rows: cut ? page.rows : undefined, ...(estEnd ? { estEnd } : {}) };
      }
      if (r.end) return { fail: "end footer but the list still offers Show more" };
      if (exact && r.b === r.total) return { fail: "total reached but the list still offers Show more" };
      if (clicks > 1500) return { fail: "more than 1500 Show more presses" };
      // The site cuts a Show-more list at SHOW_MORE_CAP rows (5 of 5 cut lists in the Set 1 logs stopped at exactly 300 and the
      // press at 300 only took the button away): don't pay for that press (~0.5 s with its re-check) — it is a cut, read onward.
      if (this.endEstimate && !exact && page.rows.length >= SHOW_MORE_CAP && (r.plus || r.total > page.rows.length)) return { fail: `no Show more press past the site's ${SHOW_MORE_CAP}-row cut: ${r.b} rows shown of ${r.approx ? "about " : ""}${r.total} (list cut)`, split: true, rows: page.rows };
      // pacer: the rest projected from the (estimated) total at the rows each press has added. Before two presses are
      // measured a press costs PRESS_GUESS_MS (Set 1: 220–290 ms; the 278 run's first-load time, nav included, was 600+).
      if (clicks) { clickMs.push(Date.now() - tp); step = Math.max(1, Math.round((page.rows.length - s0.page.rows.length) / clicks)); }
      tp = Date.now();
      const per = clickMs.length >= 2 ? clickMs.reduce((a, b) => a + b, 0) / clickMs.length : Math.max(PRESS_GUESS_MS, clickMs[0] ?? 0);
      const left = Math.ceil(Math.max(0, (r.plus ? r.total * 1.5 : r.total) - r.b) / step);
      // (a context read opens no records afterwards: it keeps no resolve reserve). The governor's waits for the presses still to come
      // (siteBudget.projectedWaitMs) are part of the projection: a long list is priced at the site's refill rate, not at its burst rate.
      const waitLeft = projectedWaitMs(Math.min(left, 400));
      if (Date.now() + left * per * 1.15 + waitLeft > this.deadline - (filter.sealed ? 0 : RESOLVE_RESERVE_MS)) return { fail: `pacer: ~${left} more Show more presses at ${Math.round(per)} ms${waitLeft ? ` + ${Math.round(waitLeft / 1000)} s of request pacing` : ""} exceed the task budget (read ${r.b} of ${r.approx ? "about " : ""}${r.total})` };
      if (!this.gateAsked && this.gate) { // once per task, from the first page: does the shift have slack for the whole read?
        this.gateAsked = true;
        const estS = (left * per * 1.15 + waitLeft + Math.ceil(r.total / (SHOW_MORE_CAP - 40)) * 700 + RESOLVE_RESERVE_MS) / 1000;
        if (!this.gate(estS)) return { fail: `pacer: no slack for ~${Math.round(estS)} s of Show more (${left} presses for about ${r.total} rows)` };
      }
      prev = keys;
      const press = () => this.c.evalApp<boolean>(`${T_FN} const b=[...doc.querySelectorAll('button,a[role=button]')].filter(b=>!b.closest('[aria-hidden="true"]')&&!b.closest('form')&&b.getAttribute('tabindex')!=='-1').find(b=>/^(show|load|see) more\\b/i.test(T(b))||/^(show|load) more\\b/i.test(b.getAttribute('aria-label')||'')); if(!b||b.disabled||b.getAttribute('aria-disabled')==='true') return false; b.click(); return true;`).catch(() => false);
      if (clicks >= BURST_PRESSES && pressGapMs()) await sleep(pressGapMs()); // counted in `per`: tp was taken above
      this.pacedMs += await paceList(this.deadline); // the site's budget: wait for the latency to decay (counted in `per` too)
      const sig = await this.extract<string>(LIGHT_SIG);
      const tPress = Date.now();
      if (!(await press())) return { fail: `could not press Show more after ${page.rows.length} rows` };
      clicks++;
      const key = pageKey(page, raw);
      // wait cheaply for the page to change (rows, footer, button or a status line), then run the full read once
      if (sig !== null) for (const t1 = Date.now(); Date.now() - t1 < 2500;) { const now = await this.extract<string>(LIGHT_SIG); if (now !== null && now !== sig) break; await sleep(15); }
      let nx = await this.settled(want, filter.from, filter.to, 9000, key, true);
      if (nx) noteLat(Date.now() - tPress); // the press's round trip (press → settled): the governor's measurement
      // "Wrenfield is not responding. Try again in a moment.": the load failed; wait and press again (twice per read)
      while (!nx && this.lastRaw?.notResponding && busy < 2 && Date.now() + 1500 < this.deadline) {
        busy++; this.c.trace({ act: "retry", what: "Show more (not responding)", value: String(clicks) });
        await sleep(700);
        const cur = await this.extract<RawPage>(PAGE_EXTRACT);
        if (cur && cur.more?.present && !cur.more.disabled && pageKey(parseListPage(cur), cur) === key) await press();
        nx = await this.settled(want, filter.from, filter.to, 6000, key, true);
      }
      if (!nx) return this.lastRaw?.busy ? { fail: `list busy at Show more ${clicks}`, busy: true } : { fail: `Show more ${clicks} did not load${this.lastRaw?.notResponding ? " (site not responding)" : ""}` };
      if (nx.raw.busy) return { fail: `list busy at Show more ${clicks}: Wrenfield says it shows fewer rows than usual`, busy: true };
      if (nx.raw.empty) return { fail: `list capped: "No more results" after ${page.rows.length} rows`, split: true, rows: page.rows };
      let nmore = !!nx.raw.more?.present && !nx.raw.more.disabled;
      if (!nmore && nx.page.rows.length === page.rows.length) { // the press only took the button away: a cut, unless it comes back (a slow load)
        await sleep(350);
        const again = await this.settled(want, filter.from, filter.to, 3000, "", true);
        if (!again) return { fail: `Show more ${clicks}: the list did not settle after the button went away` };
        nx = again; nmore = !!nx.raw.more?.present && !nx.raw.more.disabled;
        if (nx.raw.busy) return { fail: `list busy at Show more ${clicks}: Wrenfield says it shows fewer rows than usual`, busy: true };
        if (nmore && nx.page.rows.length === page.rows.length) return { fail: `Show more ${clicks} added no rows` };
      }
      if (nx.page.rows.length <= page.rows.length && !nx.page.problems.length && nmore) return { fail: `Show more ${clicks} added no rows` };
      if (nx.page.rows.length < page.rows.length && !nx.page.problems.length) return { fail: `Show more ${clicks} lost rows (${page.rows.length} → ${nx.page.rows.length})` };
      page = nx.page; raw = nx.raw;
    }
  }

  /** Open a (non-restricted) patient record: which record it shows (a merged-away id opens the surviving
   *  chart), its badges and date of birth. Never presses anything on a restricted-chart gate. */
  async resolve(patientId: string): Promise<ResolvedRecord | null> {
    if (Date.now() >= this.deadline) return null;
    // A merged-away id opens the same surviving chart we may have just read: identical page text would look
    // like "nothing loaded yet" to navTo's stale-page check. Tag the page we are leaving so the next one differs.
    await this.c.evalApp(`if(doc.body) doc.body.appendChild(doc.createTextNode(' [left]')); return true;`).catch(() => false);
    if (!(await this.c.navTo(`/patients/${patientId}`, /Date of birth|This chart is restricted|MRN/i, 8000).catch(() => false))) return null;
    const r = await this.extract<{ gated: boolean; nav: string[]; header: string; merged: boolean; dob: string; name: string }>(`${T_FN}
      const body=T(doc.body); const h1=doc.querySelector('h1'); const hdr=h1?(h1.closest('header')||h1.parentElement):null;
      const dt=[...doc.querySelectorAll('dt')].find(d=>/^date of birth$/i.test(T(d))); const dd=dt?dt.nextElementSibling:null;
      const nav=[...doc.querySelectorAll('nav a[href^="/patients/"]')].map(a=>a.getAttribute('href'));
      const nm=h1?[...h1.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join(' ').replace(/\\s+/g,' ').trim():'';
      return { gated:/This chart is restricted/i.test(body), nav, header: hdr?T(hdr).slice(0,300):'', merged:/was merged into this record/i.test(body), dob: dd?T(dd):'', name: nm };`);
    if (!r) return null;
    if (r.gated) return { canonicalId: patientId, flags: ["Restricted"], gated: true };
    const ids = [...new Set(r.nav.map((h) => h.split("/")[2]).filter(Boolean))];
    if (ids.length !== 1) return null; // chart sections must all belong to one record
    const head = r.header.replace(/Date of birth.*$/i, "");
    const flags = KNOWN_FLAGS.filter((f) => new RegExp(`\\b${f.replace(" ", "\\s+")}\\b`, "i").test(head));
    const dm = r.dob.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    const dobISO = dm ? `${dm[3]}-${dm[1].padStart(2, "0")}-${dm[2].padStart(2, "0")}` : undefined;
    return { canonicalId: ids[0], name: r.name || undefined, flags, dobISO, mergedBanner: r.merged };
  }
}

export { STATUSES };
