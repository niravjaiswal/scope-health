import { listFooter, isComplete, endSealed, type ListFooter } from "./listFooter.js";
/**
 * Name-only patients resolved from the TASK'S OWN CONTEXT when the patient search can't settle them.
 *
 * The clinic's patient search takes a last name or a DOB only, and on Set 1 a sound-alike last-name list
 * stops at ~160 rows ("about 600 patients" … "No more results."): run 164 skipped 16 name-only tasks with
 * "search list not read past <name>" (and one with "2 patients named …"). Each of those tasks names
 * something that pins the patient down on a much shorter list:
 *
 *  - lab triage: "the <panel> lab report received on <date>" → Documents filtered to Type = Lab report and
 *    Received frto = that date (filters set by LABEL, every row read back must show that date and type);
 *  - filing deadline / good-faith estimate / tetanus / claim next step: the visit date → the appointment
 *    list for that day, every status, one location at a time (apptList.ts: filters by label, proven-complete
 *    reads; Set 1 lists stop at ~300 rows, a day at all locations is ~900).
 *
 * Never-guess rules (pickByContext):
 *  - a row is THE patient only when its name has exactly the asked name's words (any order, accents
 *    folded); a row that merely contains them ("Li, Barbara Ann") or any other namesake on the list makes
 *    it ambiguous → decline;
 *  - exactly one distinct chart among the exact matches, else decline;
 *  - a badge on the row (Merged, Test record, Deleted, Restricted or anything unknown) → decline;
 *  - when the search had found several namesakes, the context's patient must be one of them;
 *  - the context list must be read completely (exact total reached, or the "about N" end the list reader
 *    already proves), every row on it must carry the filter's date (the filter really applied), and an
 *    empty list proves nothing → decline.
 * The chart is then read by the normal path (demographics, restricted-chart gate, family reader).
 */
import * as NR from "./nameResolve.js";
import type { FoundRow } from "./patientResolve.js";
import type { Crawler } from "./crawl.js";
import { FORM_EXTRACT, dateISOof, type RawControl } from "./apptList.js";
import type { AggSource, ApptRow, ReadFilter } from "./aggregate.js";
import { paceList, noteLat, noteLoad, noteBusyPage } from "./siteBudget.js";

export type CtxRow = { name: string; href: string; badge?: string; start?: number };
export type CtxRead = { rows: CtxRow[]; what: string; /** already the widest list there is (a narrowing was asked for and not possible): a wider read would read the same */ wide?: boolean } | { fail: string };
export type CtxPick = { chosen: FoundRow; why?: undefined } | { chosen: null; why: string };

const exactSame = (rowName: string, asked: string) => {
  const a = NR.nameTokens(asked).sort().join(" "), r = NR.nameTokens(rowName).sort().join(" ");
  return a.length > 0 && a === r && NR.nameTokens(asked).filter((w) => w.length >= 2).length >= 2;
};

/** Exactly one chart whose row has exactly the asked name, and no other namesake on the list. */
export function pickByContext(rows: CtxRow[], asked: string, opts: { among?: string[]; start?: number; what?: string } = {}): CtxPick {
  const what = opts.what ?? "the context list";
  const loose = new Map<string, CtxRow[]>();
  for (const r of rows) if (NR.rowMatches(r.name, asked) || exactSame(r.name, asked)) { const l = loose.get(r.href) ?? []; l.push(r); loose.set(r.href, l); }
  if (loose.size === 0) return { chosen: null, why: `no ${asked} on ${what}` };
  if (loose.size > 1) return { chosen: null, why: `${loose.size} patients named like ${asked} on ${what}` };
  const [href, mine] = [...loose.entries()][0];
  if (!mine.every((r) => exactSame(r.name, asked))) return { chosen: null, why: `the ${asked} row on ${what} reads "${mine[0].name}" (not exactly the name)` };
  const badge = mine.map((r) => r.badge).find(Boolean);
  if (badge) return { chosen: null, why: `the ${asked} row on ${what} carries "${badge}"` };
  if (opts.start !== undefined && !mine.some((r) => r.start === opts.start)) return { chosen: null, why: `${asked} on ${what} is not at the asked time` };
  if (opts.among && !opts.among.includes(href)) return { chosen: null, why: `${asked} on ${what} is none of the namesakes the search listed` };
  if (!/^\/patients\/[^/?#]+$/.test(href)) return { chosen: null, why: `unexpected chart link ${href}` };
  return { chosen: { name: mine[0].name, href } };
}

/** One context list to read. `part` names it in the log / cache key ("" the narrow list, ":invoice", ":whole"). `onFail`: the next
 *  stage is also read when this one FAILED (a cheap narrowing whose list could not be proven: the surer, dearer read follows);
 *  without it a failed read ends the resolution (the old rule) and only a clean miss ("no <name> on …") goes on. */
export type CtxStage = { part: string; read: (name: string) => Promise<CtxRead>; onFail?: boolean };
export type CtxSource = { locate: () => Promise<CtxRead>; start?: number;
  /** A wider read for when the narrow list just does not name the patient (see index-builder.PatientCtx). */
  fallback?: () => Promise<CtxRead>;
  /** Several lists in order (replaces locate / fallback when given): each is tried while the one before missed cleanly, or failed with `onFail`. */
  stages?: CtxStage[] };
export type CtxReadLog = { part: string; rows?: number; what?: string; chosen: boolean; why?: string; near?: string[]; ms: number };
/** Read the task's context and pick the patient from it. The narrow read (`locate`) decides; only when its list does not name the
 *  patient AT ALL ("no <name> on …", not an ambiguity and not a failed read) is the wider one (`fallback`) read and tried the same
 *  way. `part` is "" or ":whole" — which list named the patient. `near` (a miss only): the list's rows that share the asked last
 *  name, so the next run's log shows whether a name FORM kept the patient off the list. With `stages`, the same walk over them. */
export async function pickFromContext(ctx0: CtxSource, name: string, among?: string[]): Promise<{ pick: CtxPick; part: string; reads: CtxReadLog[] }> {
  let ctx = ctx0;
  const lastWord = NR.nameTokens(name).slice(-1)[0] ?? "";
  let pick: CtxPick = { chosen: null, why: "" }; let part = ""; const reads: CtxReadLog[] = [];
  const stages: CtxStage[] = ctx.stages ?? [{ part: "", read: ctx.locate }, ...(ctx.fallback ? [{ part: ":whole", read: ctx.fallback }] : [])];
  let wideSeen = false, prevFailed = false;
  for (let i = 0; i < stages.length; i++) {
    const st = stages[i];
    if (i > 0) {
      if (wideSeen) break; // (an earlier narrow read was the whole day already)
      // a failed read whose reason is an empty list ("no Wound care appointments listed on D") is a clean miss, as before
      if (prevFailed ? !(stages[i - 1].onFail || /^no .+ on /.test(pick.why)) : !/^no .+ on /.test(pick.why)) break;
    }
    const t0 = Date.now();
    const cr: CtxRead = await st.read(name).catch((e) => ({ fail: "context read threw " + String(e).slice(0, 80) }));
    pick = "fail" in cr ? { chosen: null, why: cr.fail } : pickByContext(cr.rows, name, { among, start: ctx.start, what: cr.what });
    prevFailed = "fail" in cr;
    const near = "rows" in cr && !pick.chosen ? cr.rows.filter((r) => NR.nameTokens(r.name).includes(lastWord)).slice(0, 4).map((r) => r.name) : [];
    if ("rows" in cr && cr.wide) wideSeen = true;
    reads.push({ part: st.part, rows: "rows" in cr ? cr.rows.length : undefined, what: "rows" in cr ? cr.what : undefined, chosen: !!pick.chosen, why: pick.why || undefined, near: near.length ? near : undefined, ms: Date.now() - t0 });
    if (pick.chosen) { part = st.part; break; }
  }
  // the last stage's verdict stands; an earlier stage's clean miss is kept in the log only
  return { pick, part, reads };
}

/** "08:20", "8:20 AM", "1:00 pm" → minutes after midnight. */
export function minutesOf(t: string | undefined): number | undefined {
  const m = (t || "").trim().match(/^(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?$/i); if (!m) return undefined;
  let h = Number(m[1]); const mi = Number(m[2]); if (h > 23 || mi > 59) return undefined;
  if (m[3]) { if (h < 1 || h > 12) return undefined; const pm = /^p/i.test(m[3]); h = (h % 12) + (pm ? 12 : 0); }
  return h * 60 + mi;
}

// ── lab: Documents filtered by type + received date ──

/** Browser-side read of the documents list: tables by header label, the footer, the Show more / Next controls. */
export const DOCS_EXTRACT = `const T=e=>((e&&(e.innerText!=null?e.innerText:e.textContent))||'').replace(/\\s+/g,' ').trim();
  const vis=e=>!e.closest('[aria-hidden="true"]')&&!e.closest('[hidden]');
  const body=T(doc.body);
  const tables=[...doc.querySelectorAll('table')].filter(vis).map(t=>{ const hr=t.querySelector('thead tr')||t.querySelector('tr');
    return { headers: hr?[...hr.children].map(h=>T(h).replace(/\\s*,.*$/,'')):[], rows:[...t.querySelectorAll('tbody tr')].filter(tr=>tr!==hr).map(tr=>[...tr.children].map(td=>({text:T(td),links:[...td.querySelectorAll('a[href]')].map(a=>({href:a.getAttribute('href')||'',text:T(a)}))})))}; });
  const btns=[...doc.querySelectorAll('button,a[role=button]')].filter(b=>vis(b)&&!b.closest('form'));
  const st=b=>b?{present:true,disabled:!!(b.disabled||b.getAttribute('aria-disabled')==='true')}:{present:false,disabled:false};
  const nr=[...doc.querySelectorAll('[role=status],[role=alert]')].some(e=>/not responding/i.test(e.textContent||'')&&vis(e)&&!e.hidden);
  return { tables, footer:(body.match(/Showing\\s+[\\d,]+(?:\\s*(?:to|–|-)\\s*[\\d,]+)?\\s+of\\s+(?:about\\s+)?[\\d,]+\\+?\\s+documents?/i)||body.match(/(?:^|\\s)(?:about\\s+)?[\\d,]+\\s+documents?(?=\\s|$)/i)||body.match(/No documents[^.]*/i)||[''])[0].trim(),
    more: st(btns.find(b=>/^(show|load|see) more\\b/i.test(T(b)))), next: st(btns.find(b=>/^next(\\s+page)?$/i.test(T(b))||/^next page$/i.test(b.getAttribute('aria-label')||''))),
    noMore: /No more results/i.test(body), notResponding: nr };`;
export type DocsRaw = { tables: Array<{ headers: string[]; rows: Array<Array<{ text: string; links: Array<{ href: string; text: string }> }>> }>; footer: string; more: { present: boolean; disabled: boolean }; next: { present: boolean; disabled: boolean }; noMore: boolean; notResponding: boolean };
export type DocRow = { receivedISO: string; type: string; title: string; patient: string; href: string; badge?: string; docHref: string };
/** The documents list's footer (listFooter's grammar). `approx` ("about N") and `plus` ("N+") totals never prove an end
 *  (listFooter.isComplete over `footer` decides); `shown = -1` when the footer is a count with no range ("4 documents"). */
export type DocFooter = { shown: number; total: number; approx: boolean; plus: boolean; cumulative: boolean; a: number; footer: ListFooter } | { shown: 0; total: 0; approx: false; plus: false; cumulative: false; a: 0; none: true; footer: ListFooter };

export function docFooter(f: string): DocFooter | undefined {
  const x = listFooter(f); if (!x || x.page !== undefined) return undefined;
  if (x.none) return { a: 0, shown: 0, total: 0, approx: false, plus: false, cumulative: false, none: true, footer: x };
  return { a: x.end ? 1 : x.from, shown: x.end ? -1 : x.to, total: x.total, approx: x.kind === "approx", plus: x.kind === "plus", cumulative: x.cumulative || x.end, footer: x };
}

/** Rows of the documents table by header label (Received, Type, Title, Patient; View link = the document). */
export function docRows(raw: DocsRaw): { rows: DocRow[] } | { problem: string } {
  const H: Record<string, RegExp> = { received: /^(?:received|date received|received on|date)$/i, type: /^(?:type|document type|kind)$/i, title: /^(?:title|document|name|description)$/i, patient: /^(?:patient|patient name)$/i };
  const tabs = raw.tables.filter((t) => Object.values(H).every((re) => t.headers.filter((h) => re.test(h)).length === 1));
  if (tabs.length !== 1) return { problem: tabs.length ? `${tabs.length} document tables` : "no documents table with Received / Type / Title / Patient columns" };
  const t = tabs[0]; const ix = Object.fromEntries(Object.entries(H).map(([k, re]) => [k, t.headers.findIndex((h) => re.test(h))]));
  const rows: DocRow[] = [];
  for (const cells of t.rows) {
    if (cells.length === 1 && /no documents/i.test(cells[0].text)) continue;
    if (cells.length !== t.headers.length) return { problem: `row with ${cells.length} cells for ${t.headers.length} columns` };
    const pc = cells[ix.patient]; const pl = pc.links.filter((l) => /^\/patients\/[^/?#]+$/.test(l.href));
    if (pl.length !== 1) return { problem: `document row without exactly one patient link: ${pc.text.slice(0, 40)}` };
    const rec = dateISOof(cells[ix.received].text); if (!rec) return { problem: `unreadable received date "${cells[ix.received].text}"` };
    const doc = cells.flatMap((c) => c.links).find((l) => /\/documents\/[^/?#]+$/.test(l.href));
    const badge = pc.text.replace(pl[0].text, " ").replace(/[\s·,|•]+/g, " ").trim();
    rows.push({ receivedISO: rec, type: cells[ix.type].text, title: cells[ix.title].text, patient: pl[0].text, href: pl[0].href, badge: badge || undefined, docHref: doc?.href ?? "" });
  }
  return { rows };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pnl = (s: string) => (s || "").toLowerCase().replace(/[^a-z]/g, "");

/** The lab reports received on one date, read completely, as context rows (patient name → chart) for the panel. */
export async function labDocContext(c: Crawler, receivedISO: string, panel: string, budgetMs = 20000): Promise<CtxRead> {
  const t0 = Date.now(); const over = () => Date.now() - t0 > budgetMs;
  // The documents list is scoped by the session's location picker like every list (practice: one location shows a
  // fraction of the day's reports): it must say All locations, or a namesake elsewhere goes unseen.
  if (!(await c.ensureAllLocations().catch(() => false))) return { fail: "session location picker is not All locations" };
  if (!(await c.navTo("/documents", /Documents|Received/i, 10000).catch(() => false))) return { fail: "documents page did not load" };
  let form: { controls: RawControl[] } | null = null;
  for (let i = 0; i < 30 && !form; i++) { const f = await c.evalApp<{ controls: RawControl[] }>(FORM_EXTRACT).catch(() => null); if (f && f.controls.some((x) => /^type$/i.test(x.label.trim()))) form = f; else await sleep(100); }
  if (!form) return { fail: "documents filter form not found" };
  const one = (re: RegExp, tag: string) => { const h = form!.controls.filter((x) => x.tag === tag && re.test(x.label.replace(/\s+/g, " ").trim())); return h.length === 1 ? h[0] : undefined; };
  const type = one(/^(?:type|document type)$/i, "select"), from = one(/^(?:received from|from)$/i, "input"), to = one(/^(?:received to|to)$/i, "input");
  if (!type || !from || !to || !type.name || !from.name || !to.name) return { fail: "documents filter: Type / Received from / Received to not found by label" };
  const opt = type.options.filter((o) => /^lab reports?$/i.test(o.text.trim()));
  if (opt.length !== 1 || !opt[0].value) return { fail: "documents filter: no single 'Lab report' type" };
  const want: Record<string, string> = { [type.name]: opt[0].value, [from.name]: receivedISO, [to.name]: receivedISO };
  const qs = Object.entries(want).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  await c.navTo(`/documents?${qs}`, /documents?\b/i, 10000, true).catch(() => false);
  // settled: the controls show the filter and two reads agree
  const settle = async (prev = "", ms = 7000): Promise<{ raw: DocsRaw; rows: DocRow[]; f: DocFooter } | { fail: string }> => {
    const s0 = Date.now(); let last = ""; let lastWhy = "did not settle";
    while (Date.now() - s0 < ms) {
      const [raw, f] = [await c.evalApp<DocsRaw>(DOCS_EXTRACT).catch(() => null), await c.evalApp<{ controls: RawControl[] }>(FORM_EXTRACT).catch(() => null)];
      if (raw && f && !raw.notResponding) {
        const by = new Map(f.controls.filter((x) => x.name).map((x) => [x.name, x.value]));
        const ok = Object.entries(want).every(([k, v]) => (by.get(k) ?? "") === v);
        const ft = docFooter(raw.footer); const r = docRows(raw);
        if (!ok) lastWhy = "the filter controls do not show the requested type/date";
        else if (!ft) lastWhy = `unreadable footer "${raw.footer.slice(0, 60)}"`;
        else if ("problem" in r) lastWhy = r.problem;
        else { const k = JSON.stringify([raw.footer, r.rows.map((x) => x.docHref + x.href)]); if (k === last && k !== prev) return { raw, rows: r.rows, f: ft }; last = k; }
      }
      await sleep(80);
    }
    return { fail: `documents list ${lastWhy}` };
  };
  let s = await settle();
  if ("fail" in s) return s;
  const all: DocRow[] = [...s.rows];
  for (let presses = 0; ; presses++) {
    if (over()) return { fail: "documents list: time budget" };
    if (s.raw.noMore) return { fail: "documents list: 'No more results' (capped)" };
    const f = s.f;
    if ("none" in f) return { fail: `no lab reports listed as received ${receivedISO}` };
    if (f.cumulative) {
      if (s.raw.more.present && !s.raw.more.disabled) {
        if (presses > 30) return { fail: "documents list: too many Show more presses" };
        const prev = JSON.stringify([s.raw.footer, s.rows.map((x) => x.docHref + x.href)]);
        const ok = await c.evalApp<boolean>(`const T=e=>(e.innerText||e.textContent||'').trim(); const b=[...doc.querySelectorAll('button,a[role=button]')].filter(b=>!b.closest('form')&&!b.closest('[aria-hidden="true"]')).find(b=>/^(show|load|see) more\\b/i.test(T(b))); if(!b||b.disabled) return false; b.click(); return true;`).catch(() => false);
        if (!ok) return { fail: "documents list: could not press Show more" };
        const n = await settle(prev, 9000); if ("fail" in n) return n;
        if (n.rows.length <= s.rows.length || s.rows.some((r, i) => n.rows[i]?.docHref !== r.docHref)) return { fail: "documents list: Show more did not append rows" };
        s = n; all.length = 0; all.push(...n.rows); continue;
      }
      // nothing more offered: complete only on an exact total the rows reach — an "about N" footer never proves it
      // (the bare "about N documents" end of a finished list is sealed by listFooter.endSealed: a day's lab reports are ~100)
      const st = { more: s.raw.more.present ? "disabled" : "none", empty: s.raw.noMore } as const;
      const v = isComplete(all.length, f.footer, st);
      if (!v.complete && !endSealed(all.length, f.footer, st).complete) return { fail: `documents list: ${v.why}` };
      break;
    }
    // paged list
    if (f.a !== all.length - s.rows.length + 1 || f.shown - f.a + 1 !== s.rows.length) return { fail: `documents list: page ${f.a}-${f.shown} does not continue the read (${all.length} rows)` };
    const last = !s.raw.next.present || s.raw.next.disabled;
    if (last) { const v = isComplete(all.length, f.footer, { next: s.raw.next.present ? "disabled" : "none", empty: s.raw.noMore }); if (!v.complete) return { fail: `documents list: no next page: ${v.why}` }; break; }
    if (presses > 30) return { fail: "documents list: too many pages" };
    const prev = JSON.stringify([s.raw.footer, s.rows.map((x) => x.docHref + x.href)]);
    const ok = await c.evalApp<boolean>(`const T=e=>(e.innerText||e.textContent||'').trim(); const b=[...doc.querySelectorAll('button,a[role=button]')].filter(b=>!b.closest('form')&&!b.closest('[aria-hidden="true"]')).find(b=>/^next(\\s+page)?$/i.test(T(b))||/^next page$/i.test(b.getAttribute('aria-label')||'')); if(!b||b.disabled) return false; b.click(); return true;`).catch(() => false);
    if (!ok) return { fail: "documents list: could not press Next" };
    const n = await settle(prev, 9000); if ("fail" in n) return n;
    s = n; all.push(...n.rows);
  }
  return labRowsToContext(all, receivedISO, panel);
}

/** Every row must show the filter (date + Lab report: the filter really applied); the panel's rows become context. */
export function labRowsToContext(all: DocRow[], receivedISO: string, panel: string): CtxRead {
  if (!all.length) return { fail: `no lab reports listed as received ${receivedISO}` };
  const off = all.find((r) => r.receivedISO !== receivedISO || !/^lab reports?$/i.test(r.type.trim()));
  if (off) return { fail: `documents filter not applied (a row received ${off.receivedISO}, type ${off.type})` };
  const rows = all.filter((r) => pnl(r.title.replace(/^\s*lab report\s*[:\-–—]?\s*/i, "")) === pnl(panel)).map((r) => ({ name: r.patient, href: r.href, badge: r.badge }));
  if (!rows.length) return { fail: `no ${panel} lab report listed as received ${receivedISO}` };
  return { rows, what: `the ${panel} lab reports received ${receivedISO}` };
}

// ── visits: the appointment list for one day, every status ──

/** What the task's own facts let the day read narrow (each is a filter the site applies, proven on the rows read back):
 *  - `type`: the visit is a kind of visit ("Wound care" for a tetanus question): the list's Visit type filter, the one option whose
 *    label matches. No single matching option (or no filter) → the whole day is read instead.
 *  - `startMin`: the visit is booked at a time (good-faith estimate): the day's list is in start-time order, so each location is read
 *    only until a row starts after it, and only the rows AT that time are returned (a namesake booked at another time is not the
 *    asked visit). A list not in time order declines. */
export type DayOpts = { type?: RegExp; startMin?: number };
export type DayLists = AggSource & { begin?: (ms: number) => void; peek?: (f: ReadFilter) => Promise<{ est: { total: number; plus: boolean } } | { fail: string }> };
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** The appointment list for one day, read so that one name on it can be told from its namesakes: ALL locations (a namesake at
 *  another location is still a namesake) — one location at a time, on the extra tabs when the source has them (readMany) — or,
 *  with `opts`, only the part of the day the task's own facts name. */
export async function apptDayContext(al: DayLists, dateISO: string, budgetMs = 40000, opts: DayOpts = {}): Promise<CtxRead> {
  al.begin?.(budgetMs);
  const locs = await al.locations().catch(() => null);
  const rows: ApptRow[] = [];
  // sealed: a location's day is ~100 rows and Set 1 only ever says "about N" for that (listFooter.endSealed)
  const day: ReadFilter = { from: dateISO, to: dateISO, status: "any", sealed: true };
  let typed: string | undefined;
  if (opts.type && al.visitTypes) {
    const hits = ((await al.visitTypes().catch(() => null)) ?? []).filter((t) => opts.type!.test(t));
    if (hits.length === 1) typed = hits[0];
  }
  const timed = opts.startMin !== undefined && locs && locs.length ? opts.startMin : undefined;
  if (typed) {
    // A kind of visit is a small slice of the day (wound care ~ 2 %): the all-locations list is short enough for the site not to cut it
    // and states its own size, so ONE read covers every location; a cut or unsure list declines.
    const r = await al.read({ ...day, visitType: typed });
    if ("fail" in r) return { fail: `${typed} appointments ${dateISO}: ${r.fail}` };
    rows.push(...r.rows);
  } else if (locs && locs.length) {
    // The all-locations list is ~900 rows a day (cut at the site's 300), so the day is read one location at a time —
    // EVERY location the filter offers: a namesake at another location is still a namesake.
    const filters = locs.map((loc): ReadFilter => ({ ...day, location: loc, ...(timed !== undefined ? { upToStart: timed } : {}) }));
    const many = filters.length > 1 && al.readMany && process.env.CTX_PARALLEL !== "0" ? await al.readMany(filters) : null;
    for (let i = 0; i < filters.length; i++) {
      const r = many ? many[i] : await al.read(filters[i]);
      if ("fail" in r) return { fail: `appointment list ${dateISO} at ${locs[i]}: ${r.fail}` };
      rows.push(...r.rows);
    }
    // The locations must add up to the all-locations list's own (estimated, rounded to 25) size: a location the filter did
    // not offer, or a list that came back thinner than the site states, shows as MISSING rows. Only that direction is
    // checked (extra rows cannot hide a namesake) and loosely (8 %, at least 50): the estimate is a statement, not a count.
    // (A time-bounded read holds a prefix of each list: there is nothing to add up.)
    const all = timed !== undefined ? null : await al.peek?.({ from: dateISO, to: dateISO, status: "any" }).catch(() => null);
    if (all && "est" in all && !all.est.plus && all.est.total - rows.length > Math.max(50, Math.ceil(all.est.total * 0.08)))
      return { fail: `appointments ${dateISO}: only ${rows.length} rows at ${locs.length} locations, but the all-locations list says about ${all.est.total}` };
  } else {
    const r = await al.read({ ...day });
    if ("fail" in r) return { fail: `appointment list ${dateISO}: ${r.fail}` };
    rows.push(...r.rows);
  }
  if (!rows.length) return { fail: `no ${typed ? typed + " " : ""}appointments listed on ${dateISO}` };
  const off = rows.find((r) => r.dateISO !== dateISO);
  if (off) return { fail: `appointment list filter not applied (a row on ${off.dateISO})` };
  const at = timed !== undefined ? rows.filter((r) => r.start === timed) : rows;
  if (!at.length) return { fail: `no appointment at ${hhmm(timed!)} on ${dateISO}` };
  const where = timed !== undefined ? ` at ${hhmm(timed)}` : "";
  return { wide: !!opts.type && !typed, rows: at.map((r) => ({ name: r.patientName, href: `/patients/${r.patientId}`, badge: [...r.flags, r.unknownBadge].filter(Boolean).join(" ") || undefined, start: r.start })), what: `the ${typed ? typed + " " : ""}appointments on ${dateISO}${where}${!typed && locs && locs.length ? ` at ${locs.length} locations` : ""}` };
}

// ── visits that were billed: the invoice list filtered by patient + service date ──

/** Browser-side read of the billing page's invoice list: the table by header label, the footer, the pager, the notices. A row's Patient
 *  cell is a name span (no link) plus badges ("Restricted"): the first span is the name, the rest the badge. */
export const INVOICES_EXTRACT = `const T=e=>((e&&(e.innerText!=null?e.innerText:e.textContent))||'').replace(/\\s+/g,' ').trim();
  const vis=e=>!e.closest('[aria-hidden="true"]')&&!e.closest('[hidden]');
  const body=T(doc.body);
  const tables=[...doc.querySelectorAll('table')].filter(vis).map(t=>{ const hr=t.querySelector('thead tr')||t.querySelector('tr');
    return { caption:T(t.querySelector('caption')), headers: hr?[...hr.children].map(h=>T(h)):[], rows:[...t.querySelectorAll('tbody tr')].filter(tr=>tr!==hr).map(tr=>[...tr.children].map(td=>({text:T(td),first:T(td.querySelector('span,a')),links:[...td.querySelectorAll('a[href]')].map(a=>({href:a.getAttribute('href')||'',text:T(a)}))})))}; });
  const btns=[...doc.querySelectorAll('button,a[role=button]')].filter(b=>vis(b)&&!b.closest('form'));
  const st=b=>b?{present:true,disabled:!!(b.disabled||b.getAttribute('aria-disabled')==='true')}:{present:false,disabled:false};
  const nr=[...doc.querySelectorAll('[role=status],[role=alert]')].some(e=>/not responding/i.test(e.textContent||'')&&vis(e)&&!e.hidden);
  const busy=[...doc.querySelectorAll('[role=status],[role=alert],p')].some(e=>/\\bis busy\\b|fewer rows than usual|open it again/i.test(e.textContent||'')&&vis(e)&&!e.hidden);
  return { tables, footer:(body.match(/Showing\\s+[\\d,]+(?:\\s*(?:to|–|-)\\s*[\\d,]+)?\\s+of\\s+(?:about\\s+)?[\\d,]+\\+?\\s+invoices?/i)||body.match(/(?:^|\\s)(?:about\\s+)?[\\d,]+\\s+invoices?(?=\\s|$)/i)||body.match(/No invoices[^.]*/i)||[''])[0].trim(),
    next: st(btns.find(b=>/^next(\\s+page)?$/i.test(T(b))||/^next page$/i.test(b.getAttribute('aria-label')||''))), noMore: /No more results/i.test(body), notResponding: nr, busy };`;
export type InvoicesRaw = { tables: Array<{ caption: string; headers: string[]; rows: Array<Array<{ text: string; first: string; links: Array<{ href: string; text: string }> }>> }>; footer: string; next: { present: boolean; disabled: boolean }; noMore: boolean; notResponding: boolean; busy: boolean };
export type InvoiceRow = { invoiceHref: string; number: string; patient: string; badge?: string; location: string; serviceISO: string; status: string };
/** Rows of the invoice table by header label (Invoice, Patient, Location, Service date, Status). */
export function invoiceRows(raw: InvoicesRaw): { rows: InvoiceRow[] } | { problem: string } {
  const H: Record<string, RegExp> = { invoice: /^(?:invoice|invoice (?:number|no\.?|#)|number)$/i, patient: /^(?:patient|patient name)$/i, location: /^location$/i, service: /^(?:service date|date of service|service)$/i, status: /^status$/i };
  const tabs = raw.tables.filter((t) => Object.values(H).every((re) => t.headers.filter((h) => re.test(h)).length === 1));
  if (tabs.length !== 1) return { problem: tabs.length ? `${tabs.length} invoice tables` : "no invoice table with Invoice / Patient / Location / Service date / Status columns" };
  const t = tabs[0]; const ix = Object.fromEntries(Object.entries(H).map(([k, re]) => [k, t.headers.findIndex((h) => re.test(h))]));
  const rows: InvoiceRow[] = [];
  for (const cells of t.rows) {
    if (cells.length === 1 && /no invoices/i.test(cells[0].text)) continue;
    if (cells.length !== t.headers.length) return { problem: `row with ${cells.length} cells for ${t.headers.length} columns` };
    const inv = cells[ix.invoice].links.filter((l) => /^\/billing\/invoices\/[^/?#]+$/.test(l.href));
    if (inv.length !== 1) return { problem: `invoice row without exactly one invoice link: ${cells[ix.invoice].text.slice(0, 30)}` };
    const pc = cells[ix.patient]; const name = pc.first || pc.text; if (!name) return { problem: "invoice row without a patient name" };
    const badge = pc.text.startsWith(name) ? pc.text.slice(name.length).replace(/[\s·,|•]+/g, " ").trim() : "";
    const svc = dateISOof(cells[ix.service].text); if (!svc) return { problem: `unreadable service date "${cells[ix.service].text}"` };
    rows.push({ invoiceHref: inv[0].href, number: inv[0].text, patient: name, badge: badge || undefined, location: cells[ix.location].text, serviceISO: svc, status: cells[ix.status].text });
  }
  return { rows };
}
/** Browser-side read of one invoice page: the header line ("Garcia, Peter · Cedar Hollow · Service on Oct 14, 2026") and the chart link. */
export const INVOICE_PAGE_EXTRACT = `const T=e=>((e&&(e.innerText!=null?e.innerText:e.textContent))||'').replace(/\\s+/g,' ').trim();
  const h=doc.querySelector('h1'); const hd=h?(h.closest('header')||h.parentElement):null;
  const sub=hd?[...hd.querySelectorAll('p')].map(T).find(x=>/service on/i.test(x))||'':'';
  const links=[...(hd||doc.body).querySelectorAll('a[href^="/patients/"]')].filter(a=>!a.closest('[aria-hidden="true"]')).map(a=>({href:a.getAttribute('href')||'',text:T(a)}));
  return { title:T(h), sub, links };`;
export type InvoicePageRaw = { title: string; sub: string; links: Array<{ href: string; text: string }> };
/** The invoice page's patient (header line) and chart link, checked against the row it was opened from. */
export function invoicePagePatient(raw: InvoicePageRaw, number: string, serviceISO: string): { name: string; href: string } | { problem: string } {
  const num = number.replace(/[^\w]/g, "");
  if (!num || !new RegExp(`(^|\\D)${num}(\\D|$)`).test(raw.title)) return { problem: `invoice page title "${raw.title.slice(0, 40)}" is not invoice ${number}` };
  const parts = raw.sub.split(/\s[·|•]\s/); if (parts.length < 2) return { problem: `invoice header line not understood: "${raw.sub.slice(0, 60)}"` };
  const svc = dateISOof(parts[parts.length - 1]); if (svc !== serviceISO) return { problem: `invoice page service date ${svc ?? "?"} ≠ ${serviceISO}` };
  const chart = raw.links.filter((l) => /^\/patients\/[^/?#]+$/.test(l.href) && /open chart|chart/i.test(l.text));
  const any = chart.length ? chart : raw.links.filter((l) => /^\/patients\/[^/?#]+$/.test(l.href));
  if (new Set(any.map((l) => l.href)).size !== 1) return { problem: any.length ? "the invoice page links several charts" : "no chart link on the invoice page" };
  return { name: parts[0].trim(), href: any[0].href };
}

/** The invoices with the asked last name and the task's service date (the DOS of a claim / filing question, the visit day of a wound
 *  question): on Set 1 every completed visit is invoiced (the billing page says "about 200,200 invoices" ≈ 16,950 completed visits a
 *  month × 12), the list takes a Patient text filter and a Service date range (recon-158: form `patient`, `serviceFrom`, `serviceTo`,
 *  found by label), and a row's invoice page names the patient and links the chart ("Open chart"). 2-4 requests against the ~45 of a
 *  ten-location day read (run s3a: 31-35 s each, 6 of 6 ended on a busy page). Proof: the filter controls echo the request, the list is
 *  COMPLETE on an exact total (an "about N" list = the filter was not applied → fail, the day read follows), every row carries the service
 *  date, the rows whose name is exactly the asked name are opened and their invoice pages must name the same patient and date; the rows
 *  returned are those charts. An empty list is a clean miss ("no <name> on …": a visit never invoiced), never a decline on its own. */
export async function invoiceContext(c: Crawler, name: string, serviceISO: string, budgetMs = 15000, maxOpen = 3): Promise<CtxRead> {
  const t0 = Date.now(); const over = () => Date.now() - t0 > budgetMs;
  const split = NR.splitName(name); if (!split) return { fail: `invoice list: "${name}" is not a first + last name` };
  const term = split.last;
  const what = `the invoices with service date ${serviceISO} for "${term}"`;
  if (!(await c.ensureAllLocations().catch(() => false))) return { fail: "session location picker is not All locations" };
  if (!(await c.navTo("/billing", /Find invoice|Invoices|Billing/i, 10000).catch(() => false))) return { fail: "billing page did not load" };
  let form: { controls: RawControl[] } | null = null;
  for (let i = 0; i < 30 && !form; i++) { const f = await c.evalApp<{ controls: RawControl[] }>(FORM_EXTRACT).catch(() => null); if (f && f.controls.some((x) => /service date fri.test(x.label))) form = f; else await sleep(100); }
  if (!form) return { fail: "invoice filter form not found" };
  const one = (re: RegExp, tag: string, type?: RegExp) => { const h = form!.controls.filter((x) => x.tag === tag && re.test(x.label.replace(/\s+/g, " ").trim()) && (!type || type.test(x.type))); return h.length === 1 ? h[0] : undefined; };
  const pat = one(/^patient$/i, "input", /^(text|search|)$/), from = one(/^service date from$/i, "input"), to = one(/^service date to$/i, "input");
  if (!pat || !from || !to || !pat.name || !from.name || !to.name) return { fail: "invoice filter: Patient / Service date from / Service date to not found by label" };
  const want: Record<string, string> = { [pat.name]: term, [from.name]: serviceISO, [to.name]: serviceISO };
  const qs = Object.entries(want).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  await paceList(t0 + budgetMs);
  const tLoad = Date.now();
  await c.navTo(`/billing?${qs}`, /invoices?\b/i, 10000, true).catch(() => false);
  const loadMs = Date.now() - tLoad;
  const settle = async (prev = "", ms = 7000): Promise<{ raw: InvoicesRaw; rows: InvoiceRow[]; f: ListFooter } | { fail: string }> => {
    const s0 = Date.now(); let last = ""; let lastWhy = "did not settle";
    while (Date.now() - s0 < ms) {
      const [raw, f] = [await c.evalApp<InvoicesRaw>(INVOICES_EXTRACT).catch(() => null), await c.evalApp<{ controls: RawControl[] }>(FORM_EXTRACT).catch(() => null)];
      if (raw && f && !raw.notResponding) {
        if (raw.busy) { noteBusyPage(); return { fail: "invoice list busy: Wrenfield says it shows fewer rows than usual" }; }
        const by = new Map(f.controls.filter((x) => x.name).map((x) => [x.name, x.value]));
        const ok = Object.entries(want).every(([k, v]) => (by.get(k) ?? "").trim().toLowerCase() === v.toLowerCase());
        const ft = listFooter(raw.footer, /invoices?/i); const r = invoiceRows(raw);
        if (!ok) lastWhy = "the filter controls do not show the requested patient / service dates";
        else if (!ft) lastWhy = `unreadable footer "${raw.footer.slice(0, 60)}"`;
        else if ("problem" in r) lastWhy = r.problem;
        else { const k = JSON.stringify([raw.footer, r.rows.map((x) => x.invoiceHref)]); if (k === last && k !== prev) return { raw, rows: r.rows, f: ft }; last = k; }
      }
      await sleep(80);
    }
    return { fail: `invoice list ${lastWhy}` };
  };
  let s = await settle();
  if ("fail" in s) return s;
  noteLoad(loadMs);
  const all: InvoiceRow[] = [...s.rows];
  for (let pages = 1; ; pages++) {
    if (over()) return { fail: "invoice list: time budget" };
    if (s.raw.noMore) return { fail: "invoice list: 'No more results' (capped)" };
    const last = !s.raw.next.present || s.raw.next.disabled;
    const v = isComplete(all.length, s.f, { next: s.raw.next.present ? (last ? "disabled" : "enabled") : "none", empty: s.raw.noMore });
    if (v.complete) break;
    if (last) return { fail: `invoice list: ${v.why}` }; // an "about N" total, or rows short of the total: the filter was not applied, nothing is proven
    if (pages >= 4) return { fail: "invoice list: more than 4 pages for one patient on one day (the filter was not applied)" };
    const prev = JSON.stringify([s.raw.footer, s.rows.map((x) => x.invoiceHref)]);
    await paceList(t0 + budgetMs);
    const tClick = Date.now();
    const ok = await c.evalApp<boolean>(`const T=e=>(e.innerText||e.textContent||'').trim(); const b=[...doc.querySelectorAll('button,a[role=button]')].filter(b=>!b.closest('form')&&!b.closest('[aria-hidden="true"]')).find(b=>/^next(\\s+page)?$/i.test(T(b))||/^next page$/i.test(b.getAttribute('aria-label')||'')); if(!b||b.disabled) return false; b.click(); return true;`).catch(() => false);
    if (!ok) return { fail: "invoice list: could not press Next" };
    const n = await settle(prev, 9000); if ("fail" in n) return n;
    noteLat(Date.now() - tClick);
    s = n; all.push(...n.rows);
  }
  if (!all.length) return { rows: [], what };
  const off = all.find((r) => r.serviceISO !== serviceISO);
  if (off) return { fail: `invoice filter not applied (a row with service date ${off.serviceISO})` };
  const foreign = all.find((r) => !NR.nameTokens(r.patient).includes(NR.fold(term)));
  if (foreign) return { fail: `invoice filter not applied (a row for "${foreign.patient}")` };
  // the rows that could be the patient (the same loose rule pickByContext applies) are opened: each invoice page names its patient
  // and links the chart, so the context rows carry chart links like a day list's
  const mine = all.filter((r) => NR.rowMatches(r.patient, name) || NR.nameTokens(r.patient).sort().join(" ") === NR.nameTokens(name).sort().join(" "));
  if (mine.length > maxOpen) return { fail: `invoice list: ${mine.length} invoices for "${name}" on ${serviceISO} (more than ${maxOpen} to open)` };
  const rows: CtxRow[] = [];
  for (const r of mine) {
    if (over()) return { fail: "invoice list: time budget (opening invoices)" };
    await paceList(t0 + budgetMs);
    if (!(await c.navTo(r.invoiceHref, /Invoice/i, 8000).catch(() => false))) return { fail: `invoice ${r.number} did not open` };
    let got: InvoicePageRaw | null = null;
    for (let i = 0; i < 30 && !(got && got.sub); i++) { got = await c.evalApp<InvoicePageRaw>(INVOICE_PAGE_EXTRACT).catch(() => null); if (!(got && got.sub)) await sleep(100); }
    if (!got) return { fail: `invoice ${r.number}: page not read` };
    const p = invoicePagePatient(got, r.number, serviceISO);
    if ("problem" in p) return { fail: `invoice ${r.number}: ${p.problem}` };
    if (NR.nameTokens(p.name).sort().join(" ") !== NR.nameTokens(r.patient).sort().join(" ")) return { fail: `invoice ${r.number} names "${p.name}", the list row "${r.patient}"` };
    rows.push({ name: p.name, href: p.href, badge: r.badge });
  }
  // the other rows (names that merely contain the asked words) stay as rows without a chart: pickByContext sees them as namesakes
  for (const r of all) if (!mine.includes(r)) rows.push({ name: r.patient, href: `/billing/invoices/${r.number}`, badge: r.badge });
  return { rows, what };
}
