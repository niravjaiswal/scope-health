/**
 * Clinic-wide list reader (Documents, Billing): the ListSource behind listQuery.ts. Same proofs as the appointment
 * list reader (apptList.ts), for any list described by a ListSpec:
 *
 *  - the filter form is found by LABELS (Type / Status / Location / "Received from" / "Issued date from" …); the
 *    filter values go into the URL by the controls' own names; the rendered controls must show exactly those values
 *    (else the form is filled by label and its GET submit pressed; else decline);
 *  - columns are found by header text (synonyms, any order, extra columns tolerated), never by index or class name;
 *  - "Rows per page" is set to its largest option in the same URL;
 *  - pages: "Showing a to b of N" must continue the previous page, the rows on it must number b−a+1, and the walk
 *    ends only when Next is gone/disabled with b equal to an exact N. A "Show more" list must only APPEND rows and
 *    end with the rows equal to an exact total (or the estimate within its tolerance once nothing more is offered,
 *    as apptList.walkMore). Anything else is a failure with a why.
 *
 * Read-only: URL navigation, the list's own filters, page size, pager and Show more. Nothing is opened or pressed
 * outside the list (no row, no chart, no gate). The page → rows interpretation is the pure `parseRows`.
 */
import type { Crawler } from "./crawl.js";
import { FORM_EXTRACT, PAGE_EXTRACT as APPT_PAGE_EXTRACT, rangeOf, approxTol, dateISOof, type RawControl, type RawPage, type Range } from "./apptList.js";
import { KNOWN_FLAGS } from "./aggregate.js";
import type { ListKind, ListRow, ListOptions, ListFilter, ListSource, DateField, ListFlag } from "./listQuery.js";
import { normText } from "./listQuery.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The appointment list's page extractor, with the list's own nouns in its count footers ("31 invoices", "53 documents",
 *  "about 250 documents", "No documents"). */
export const PAGE_EXTRACT = APPT_PAGE_EXTRACT.replace(/appointments\?/g, "(?:documents?|invoices?|entries)").replace(/No appointments/g, "No (?:documents|invoices|entries)");

export type ColKey = "received" | "issued" | "service" | "type" | "title" | "patient" | "location" | "status" | "invoice" | "total";
export interface ListSpec {
  kind: ListKind;
  paths: string[];
  /** a nav link to the list, by its visible text */
  navLabel: RegExp;
  marker: RegExp;
  cols: Array<[ColKey, RegExp]>;
  required: ColKey[];
  /** filter controls by label → which ListFilter part they carry */
  controls: Array<{ key: "type" | "status" | "location" | "from" | "to"; field?: DateField; tag: "select" | "input"; label: RegExp }>;
  dateCols: DateField[];
}
export const SPECS: Record<ListKind, ListSpec> = {
  documents: {
    kind: "documents", paths: ["/documents"], navLabel: /^documents$/i, marker: /Documents|Showing|No documents/i,
    cols: [["received", /^(?:received|date received|received on|received date)\b/i], ["type", /^(?:type|document type|kind)$/i], ["title", /^(?:title|document|name|description)$/i], ["patient", /^(?:patient|patient name)$/i]],
    required: ["received", "type", "patient"],
    controls: [
      { key: "type", tag: "select", label: /^(?:type|document type|kind)$/i },
      { key: "from", field: "received", tag: "input", label: /^(?:received )?from$|^received(?: date)?,? from$|^from date$|^received after$/i },
      { key: "to", field: "received", tag: "input", label: /^(?:received )?to$|^received(?: date)?,? to$|^to date$|^received before$/i },
    ],
    dateCols: ["received"],
  },
  invoices: {
    kind: "invoices", paths: ["/billing", "/billing/invoices"], navLabel: /^(?:billing|invoices)$/i, marker: /Invoices|Billing|Showing/i,
    cols: [["invoice", /^(?:invoice|invoice number|invoice #|number)$/i], ["patient", /^(?:patient|patient name)$/i], ["location", /^(?:location|site|clinic|office)$/i],
      ["service", /^(?:service date|date of service|dos|service)$/i], ["issued", /^(?:issued|issue date|issued on|date issued|invoice date)$/i], ["total", /^(?:total|amount|billed)$/i], ["status", /^status$/i]],
    required: ["invoice", "patient", "issued", "service", "status"],
    controls: [
      { key: "location", tag: "select", label: /^(?:location|site|clinic|office)$/i },
      { key: "status", tag: "select", label: /^status$/i },
      { key: "from", field: "issued", tag: "input", label: /^issued?(?: date)?,? from$|^issued after$/i },
      { key: "to", field: "issued", tag: "input", label: /^issued?(?: date)?,? to$|^issued before$/i },
      { key: "from", field: "service", tag: "input", label: /^service date,? from$|^date of service,? from$/i },
      { key: "to", field: "service", tag: "input", label: /^service date,? to$|^date of service,? to$/i },
    ],
    dateCols: ["issued", "service"],
  },
};

// ── pure interpretation ──
const L = (c: RawControl) => c.label.replace(/\s+/g, " ").trim();
export type ListForm = { byKey: Partial<Record<string, RawControl>>; perPage?: RawControl; problems: string[] };
/** Which control is which, by label (exactly one each; a control that matches twice is a problem). */
export function mapListForm(spec: ListSpec, controls: RawControl[]): ListForm {
  const byKey: ListForm["byKey"] = {}; const problems: string[] = [];
  for (const k of spec.controls) {
    const id = k.field ? `${k.key}:${k.field}` : k.key;
    const h = controls.filter((c) => c.tag === k.tag && c.inForm && k.label.test(L(c)));
    if (h.length === 1) byKey[id] = h[0]; else if (h.length > 1) problems.push(`${h.length} controls labelled like ${id}`);
  }
  const pp = controls.filter((c) => c.tag === "select" && /per page|page size|^rows\b|^show$/i.test(L(c)) || (c.tag === "select" && c.options.length > 1 && c.options.every((o) => /^\d+\s+per page$/i.test(o.text))));
  return { byKey, perPage: pp.length === 1 ? pp[0] : undefined, problems };
}
export function listOptions(spec: ListSpec, f: ListForm): ListOptions {
  const real = (c?: RawControl) => c ? c.options.filter((o) => o.value !== "" && !/^all\b/i.test(o.text)).map((o) => o.text) : undefined;
  return spec.kind === "documents" ? { type: real(f.byKey.type) } : { status: real(f.byKey.status), location: real(f.byKey.location) };
}
export function colsOf(spec: ListSpec, headers: string[]): { cols: Partial<Record<ColKey, number>> } | { problem: string } {
  const cols: Partial<Record<ColKey, number>> = {}; const twice = new Set<string>();
  headers.forEach((h0, i) => { const h = h0.replace(/,\s*(?:newest|oldest) first.*$/i, "").replace(/\s+/g, " ").trim(); for (const [k, re] of spec.cols) if (re.test(h)) { if (cols[k] !== undefined) twice.add(k); else cols[k] = i; break; } });
  for (const k of spec.required) { if (twice.has(k)) return { problem: `two ${k} columns (${headers.join(" | ")})` }; if (cols[k] === undefined) return { problem: `no ${k} column (${headers.join(" | ")})` }; }
  for (const k of twice) delete cols[k as ColKey];
  return { cols };
}
const FLAG_RE: Array<[RegExp, ListFlag]> = KNOWN_FLAGS.map((f) => [new RegExp(`\\b${f.replace(" ", "\\s+")}\\b`, "i"), f as ListFlag]);
/** The patient cell: the name (the patient link's text, else "Last, First") and the badges after it. */
export function patientCell(cell: { text: string; links: Array<{ href: string; text: string }> }): { name: string; flags: ListFlag[]; unknown?: string } {
  const link = cell.links.find((l) => /^\/patients\/[^/?#]+$/.test(l.href));
  let rest = cell.text;
  let name = "";
  if (link && link.text.trim()) { name = link.text.trim(); rest = rest.replace(link.text, " "); }
  else { const m = rest.match(/^\s*([\p{L}'’. -]+,\s*[\p{L}'’.-]+(?:\s+[\p{L}'’.-]+)*?)(?=\s+(?:Restricted|Test record|Deleted|Merged)\b|\s*$)/u); if (m) { name = m[1].trim(); rest = rest.slice(m[0].length); } }
  const flags: ListFlag[] = [];
  for (const [re, f] of FLAG_RE) if (re.test(rest)) { flags.push(f); rest = rest.replace(new RegExp(re.source, "gi"), " "); }
  rest = rest.replace(/[\s·,|•()]+/g, " ").trim();
  return { name, flags, unknown: rest || undefined };
}
export type ParsedList = { rows: ListRow[]; range?: Range; problems: string[] };
export function parseRows(spec: ListSpec, raw: RawPage): ParsedList {
  const problems: string[] = [];
  const range = rangeOf(raw.footer.replace(/\b(documents?|invoices?|entries|results|rows|items)\b/i, "appointments")) ?? undefined;
  const cands = raw.tables.filter((t) => !("problem" in colsOf(spec, t.headers)));
  if (cands.length > 1) problems.push(`${cands.length} ${spec.kind} tables on the page`);
  const tbl = cands[0];
  if (!tbl) {
    if (range && range.total === 0 && !raw.tables.some((t) => t.rows.length)) return { rows: [], range, problems };
    problems.push(raw.tables.length ? (colsOf(spec, raw.tables[0].headers) as { problem: string }).problem : `no ${spec.kind} table`);
    return { rows: [], range, problems };
  }
  const { cols } = colsOf(spec, tbl.headers) as { cols: Partial<Record<ColKey, number>> };
  const rows: ListRow[] = [];
  for (const cells of tbl.rows) {
    if (cells.length === 1 && /^no\b/i.test(cells[0].text)) continue;
    if (cells.length !== tbl.headers.length) { problems.push(`row with ${cells.length} cells for ${tbl.headers.length} columns`); continue; }
    const txt = (k: ColKey) => (cols[k] !== undefined ? cells[cols[k]!].text.trim() : undefined);
    const date: ListRow["date"] = {};
    for (const f of spec.dateCols) { const s = txt(f as ColKey); if (s === undefined) continue; const d = dateISOof(s); if (!d) { problems.push(`unreadable ${f} date "${s.slice(0, 30)}"`); continue; } date[f] = d; }
    const pc = cols.patient !== undefined ? patientCell(cells[cols.patient]) : { name: "", flags: [] as ListFlag[] };
    const key = [txt("invoice"), ...cells.map((c) => c.links.map((l) => l.href).join(",")), cells.map((c) => c.text).join("|")].join("#");
    rows.push({ key, date, type: txt("type"), status: txt("status"), location: txt("location"), flags: pc.flags, unknownBadge: (pc as any).unknown });
  }
  if (range?.end) { range.b = rows.length; range.a = rows.length ? 1 : 0; }
  if (range && range.total > 0 && rows.length !== range.b - range.a + 1) problems.push(`page shows ${rows.length} rows for "Showing ${range.a} to ${range.b}"`);
  return { rows, range, problems };
}

// ── live reader ──
const pageKey = (p: ParsedList, raw: RawPage) => JSON.stringify([p.range, p.rows.map((r) => r.key), !!raw.more?.present && !raw.more.disabled, !!raw.next.present && !raw.next.disabled]);
export class ListReader implements ListSource {
  private forms = new Map<ListKind, { path: string; form: ListForm; controls: RawControl[] } | null>();
  private deadline = Infinity;
  /** whether the list takes its filters from the URL (Documents on practice: yes; Billing: no → the form) */
  private urlTaken = new Map<ListKind, boolean>();
  lastStats: Record<string, unknown> | null = null;
  constructor(private c: Crawler, private log: (rec: Record<string, unknown>) => void = () => {}) {}
  begin(budgetMs: number) { this.deadline = Date.now() + budgetMs; this.lastStats = null; }
  todayISO() { return this.c.today || ""; }
  private ex<T>(js: string) { return this.c.evalApp<T>(js).catch(() => null); }

  private async loadForm(kind: ListKind) {
    if (this.forms.has(kind)) return this.forms.get(kind)!;
    const spec = SPECS[kind];
    const tryPath = async (path: string) => {
      if (!(await this.c.navTo(path, spec.marker, 9000).catch(() => false))) return null;
      for (let i = 0; i < 30; i++) {
        const f = await this.ex<{ controls: RawControl[] }>(FORM_EXTRACT);
        if (f) { const form = mapListForm(spec, f.controls); const need = kind === "documents" ? ["type", "from:received", "to:received"] : ["status", "location", "from:issued", "to:issued"]; if (need.every((k) => form.byKey[k])) return { path, form, controls: f.controls }; }
        await sleep(100);
      }
      return null;
    };
    let got = null as Awaited<ReturnType<typeof tryPath>>;
    for (const p of spec.paths) { got = await tryPath(p); if (got) break; }
    if (!got) { // by the nav link's label
      await this.c.navTo("/", /Dashboard|Wrenfield/i, 8000).catch(() => false);
      const href = await this.c.evalApp<string>(`const a=[...doc.querySelectorAll('nav a[href],a[href]')].find(x=>${spec.navLabel}.test((x.textContent||'').trim())); return a?a.getAttribute('href').split('?')[0]:''`).catch(() => "");
      if (href) got = await tryPath(href);
    }
    this.forms.set(kind, got);
    return got;
  }
  async options(kind: ListKind): Promise<ListOptions | { fail: string }> {
    const f = await this.loadForm(kind); if (!f) return { fail: `${kind} list / filter form not found by its labels` };
    if (f.form.problems.length) return { fail: f.form.problems.join("; ") };
    return listOptions(SPECS[kind], f.form);
  }

  private async settled(spec: ListSpec, want: Record<string, string>, timeoutMs: number, prevKey = "", fast = false): Promise<{ p: ParsedList; raw: RawPage; capped?: boolean } | null> {
    const t0 = Date.now(); let last = "";
    while (Date.now() - t0 < timeoutMs) {
      const raw = await this.ex<RawPage>(PAGE_EXTRACT);
      const f = fast ? { controls: [] as RawControl[] } : await this.ex<{ controls: RawControl[] }>(FORM_EXTRACT);
      if (raw && prevKey && raw.empty && !raw.tables.some((t) => t.rows.length)) return { p: parseRows(spec, raw), raw, capped: true };
      if (raw && f && !raw.loading) {
        const byName = new Map(f.controls.filter((c) => c.name).map((c) => [c.name, c.value]));
        const ok = fast || Object.entries(want).every(([k, v]) => (byName.get(k) ?? "") === v);
        const p = parseRows(spec, raw);
        if (ok && p.range) { const k = pageKey(p, raw); if (k === last && k !== prevKey) return { p, raw }; last = k; } else last = "";
      }
      await sleep(fast ? 40 : 80);
    }
    return null;
  }

  /** Up to two retries, each from a fresh load, when the read was cut by the app itself (practice: a page left open a
   *  few seconds reloads on the next click, back on page 1 with its filters cleared). Each attempt proves itself. */
  async read(filter: ListFilter): Promise<{ rows: ListRow[]; proof: string } | { fail: string }> {
    let r = await this.readOnce(filter); const fails: string[] = [];
    for (let i = 0; i < 2 && "fail" in r && /starts at|did not render|did not settle|lost rows|changed after|not submitted|could not press/.test(r.fail) && Date.now() < this.deadline; i++) {
      fails.push(r.fail);
      this.c.trace({ act: "retry", what: `${filter.list} list read`, value: r.fail });
      await this.c.navTo("/", /Dashboard|Wrenfield/i, 6000, true).catch(() => false);
      r = await this.readOnce(filter);
    }
    return "fail" in r && fails.length ? { fail: `${r.fail} (after ${fails.length} retr${fails.length > 1 ? "ies" : "y"}: ${fails.join(" | ").slice(0, 200)})` } : r;
  }

  private async readOnce(filter: ListFilter): Promise<{ rows: ListRow[]; proof: string } | { fail: string }> {
    const t0 = Date.now(); const spec = SPECS[filter.list];
    const fail = (why: string) => { this.log({ event: "list-read", filter, ok: false, why, ms: Date.now() - t0 }); return { fail: why }; };
    if (Date.now() >= this.deadline) return fail("no time budget left for a list read (pacer)");
    const lf = await this.loadForm(filter.list); if (!lf) return fail(`${filter.list} list / filter form not found`);
    const m = lf.form.byKey;
    const want: Record<string, string> = {};
    const sel = (c: RawControl | undefined, text: string | undefined, what: string): string | null => {
      if (!c) return text ? null : "";
      if (!text) { const all = c.options.find((o) => o.value === "" && /^all\b/i.test(o.text)); if (!all) return null; want[c.name] = ""; return ""; }
      const h = c.options.filter((o) => o.value !== "" && normText(o.text) === normText(text)); if (h.length !== 1) return null; want[c.name] = h[0].value; return h[0].value;
    };
    if (sel(m.type, filter.type, "type") === null) return fail(`type "${filter.type}" not one option of the list's Type filter`);
    if (sel(m.status, filter.status, "status") === null) return fail(`status "${filter.status}" not one option of the Status filter`);
    if (sel(m.location, filter.location, "location") === null) return fail(`location "${filter.location}" not one option of the Location filter (or no "All locations")`);
    const from = m[`from:${filter.dateField}`], to = m[`to:${filter.dateField}`];
    if (!from || !to) return fail(`no ${filter.dateField} date filter (from / to) on the ${filter.list} list`);
    want[from.name] = filter.from; want[to.name] = filter.to;
    // the other date field's filter must be empty (not left over from an earlier read)
    for (const k of Object.keys(m)) if (/^(from|to):/.test(k) && !k.endsWith(":" + filter.dateField)) want[m[k]!.name] = "";
    if (Object.keys(want).some((k) => !k)) return fail("a filter control has no name");
    const pp = lf.form.perPage;
    const big = pp ? pp.options.map((o) => ({ v: o.value, n: Number((o.text.match(/\d+/) || [""])[0]) })).filter((o) => o.n > 0).sort((a, b) => b.n - a.n)[0] : undefined;
    if (pp?.name && big) want[pp.name] = big.v;
    // Every list is scoped by the session's location picker (practice run: the picker stuck on Northgate turned the
    // Documents list's 15 lab reports of a day into 2, answered as "2"): it must say All locations before AND after the read.
    if (!(await this.c.ensureAllLocations())) return fail(`session location picker is "${(await this.c.pickerLabel()).slice(0, 40)}", not All locations`);
    const qs = Object.entries(want).filter(([, v]) => v !== "").map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
    const here = await this.c.evalTop<string>("location.pathname+location.search").catch(() => "");
    if (here === `${lf.path}?${qs}`) await this.c.navTo("/", /Dashboard|Wrenfield/i, 6000).catch(() => false);
    const wantSet = Object.fromEntries(Object.entries(want).filter(([k]) => !pp || k !== pp.name)); // page size is a view setting: not required
    const urlOk = this.urlTaken.get(filter.list) !== false;
    await this.c.navTo(urlOk ? `${lf.path}?${qs}` : lf.path, spec.marker, 9000, !urlOk).catch(() => false); // the form path starts from a fresh load (practice: a page left open a few seconds reloads itself on the next click)
    let s = urlOk ? await this.settled(spec, wantSet, this.urlTaken.get(filter.list) ? 6000 : 4000) : null;
    if (urlOk) this.urlTaken.set(filter.list, !!s);
    let via = "url";
    if (!s) {
      via = "form";
      // wait for the (fresh) page's filter form to hold every control before filling it
      for (let i = 0; i < 50; i++) { const ok = await this.c.evalApp<boolean>(`const want=${JSON.stringify(Object.keys(wantSet))}; return [...doc.querySelectorAll('form')].some(fm=>want.every(n=>fm.querySelector('[name="'+n+'"]')));`).catch(() => false); if (ok) break; await sleep(100); }
      const cur = await this.ex<RawPage>(PAGE_EXTRACT); const beforeKey = cur ? pageKey(parseRows(spec, cur), cur) : "";
      const sub = await this.c.evalApp<string>(`const want=${JSON.stringify(wantSet)}; const form=[...doc.querySelectorAll('form')].find(fm=>Object.keys(want).every(n=>fm.querySelector('[name="'+n+'"]')));
        if(!form) return 'no form holds every filter control'; if((form.getAttribute('method')||'get').toLowerCase()!=='get') return 'the filter form is not a GET form';
        for(const [n,v] of Object.entries(want)){ const e=form.querySelector('[name="'+n+'"]'); const W=doc.defaultView; const pr=e.tagName==='SELECT'?W.HTMLSelectElement.prototype:W.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(pr,'value').set.call(e,v); e.dispatchEvent(new W.Event('input',{bubbles:true})); e.dispatchEvent(new W.Event('change',{bubbles:true})); }
        const b=[...form.querySelectorAll('button[type=submit],button:not([type]),input[type=submit]')]; if(b.length!==1) return b.length+' submit buttons'; b[0].click(); return 'ok';`).catch((e) => "threw " + String(e).slice(0, 60));
      this.c.trace({ act: "submit", what: `${filter.list} list filter`, value: qs });
      if (sub !== "ok") return fail(`filter form not submitted: ${sub}`);
      s = await this.settled(spec, wantSet, 8000, beforeKey); // the list must change: the controls show our values at once, the rows only after the app applied them
    }
    if (!s) { const raw = await this.ex<RawPage>(PAGE_EXTRACT); const f = await this.ex<{ controls: RawControl[] }>(FORM_EXTRACT); const shown = Object.keys(wantSet).map((k) => `${k}=${f?.controls.find((c) => c.name === k)?.value ?? "?"}`).join(" "); return fail(`list did not settle on the requested filters (${via}; footer "${raw?.footer ?? "?"}"; controls ${shown})`); }
    if (s.p.range?.cumulative) return this.walkMore(spec, s, filter, t0, via);
    // the biggest page size (a view setting, not a filter): set by the select's own change event when the URL didn't take
    const shown = s.p.range ? s.p.range.b - s.p.range.a + 1 : 0;
    if (pp && big && s.p.range && s.p.range.total > shown && big.n > shown) {
      const okSet = await this.c.evalApp<boolean>(`const s=[...doc.querySelectorAll('select')].find(e=>e.name===${JSON.stringify(pp.name)}); if(!s) return false; const W=doc.defaultView; Object.getOwnPropertyDescriptor(W.HTMLSelectElement.prototype,'value').set.call(s,${JSON.stringify(big.v)}); s.dispatchEvent(new W.Event('input',{bubbles:true})); s.dispatchEvent(new W.Event('change',{bubbles:true})); return true;`).catch(() => false);
      this.c.trace({ act: "select", what: "Rows per page", value: String(big.n) });
      if (okSet) { const b2 = await this.settled(spec, wantSet, 6000, pageKey(s.p, s.raw)); if (b2 && b2.p.range && b2.p.range.a === 1 && b2.p.rows.length > s.p.rows.length) s = b2; }
    }
    const rows: ListRow[] = []; let p = s.p, raw = s.raw, pages = 0;
    const pageSize = s.p.range ? s.p.range.b - s.p.range.a + 1 : 0; let plusEnd = false;
    for (;;) {
      pages++;
      if (p.problems.length) return fail(`page ${pages}: ${p.problems.slice(0, 2).join("; ")}`);
      const r = p.range!;
      if (r.total === 0) { if (rows.length || p.rows.length) return fail("empty footer after rows"); break; }
      if (r.a !== rows.length + 1) return fail(`page ${pages} starts at ${r.a}, expected ${rows.length + 1}`);
      rows.push(...p.rows);
      const exact = !r.plus && !r.approx;
      const last = !raw.next.present || raw.next.disabled;
      if (last) {
        if (raw.empty) return fail(`list capped: "No more results" after ${rows.length} rows`);
        // "Showing 201 to 285 of 200+": the bound was passed and the last page is short of a full page → the list ended
        // (a list cut by the site ends on a full page, or on an empty "No more results" page, both refused)
        if (r.plus && r.b > r.total && p.rows.length < pageSize && pages > 1) { plusEnd = true; break; }
        if (!exact) return fail(`no next page at ${r.b} of ${r.approx ? "about " : ""}${r.total}${r.plus ? "+" : ""} (an estimate proves no end)`);
        if (r.b !== r.total) return fail(`no next page but only ${r.b} of ${r.total} read`);
        break;
      }
      if (exact && r.b >= r.total) return fail("total reached but the pager still offers Next");
      if (pages > 200) return fail("more than 200 pages");
      if (Date.now() > this.deadline) return fail(`pacer: task budget spent after ${pages} pages`);
      const clicked = await this.c.evalApp<boolean>(`const T=e=>((e&&(e.innerText!=null?e.innerText:e.textContent))||'').replace(/\\s+/g,' ').trim(); const b=[...doc.querySelectorAll('button,a[role=button]')].filter(b=>!b.closest('[aria-hidden="true"]')&&!b.closest('form')&&b.getAttribute('tabindex')!=='-1').find(b=>/^next(\\s+page)?$/i.test(T(b))||/^next page$/i.test(b.getAttribute('aria-label')||'')); if(!b||b.disabled) return false; b.click(); return true;`).catch(() => false);
      if (!clicked) return fail(`could not press Next on page ${pages}`);
      const nx = await this.settled(spec, wantSet, 9000, pageKey(p, raw));
      if (!nx) return fail(`page ${pages + 1} did not render`);
      if (nx.capped) return fail(`list capped after ${rows.length} rows`);
      p = nx.p; raw = nx.raw;
    }
    if (new Set(rows.map((x) => x.key)).size !== rows.length) return fail("a row is listed twice");
    if (!/all locations/i.test(await this.c.pickerLabel().catch(() => ""))) return fail("the session location picker left All locations during the read");
    const proof = `${via}: ${pages} page(s), ${rows.length} rows ${plusEnd ? "past the \"N+\" bound, short last page" : "= exact total"}`;
    this.lastStats = { pages, rows: rows.length, ms: Date.now() - t0, via };
    this.log({ event: "list-read", filter, ok: true, ...this.lastStats });
    return { rows, proof };
  }

  private async walkMore(spec: ListSpec, s0: { p: ParsedList; raw: RawPage }, filter: ListFilter, t0: number, via: string): Promise<{ rows: ListRow[]; proof: string } | { fail: string }> {
    const fail = (why: string) => { this.log({ event: "list-read", filter, ok: false, why, ms: Date.now() - t0 }); return { fail: why }; };
    let p = s0.p, raw = s0.raw, clicks = 0; let prev: string[] = [];
    for (;;) {
      if (p.problems.length) return fail(`after ${clicks} Show more: ${p.problems.slice(0, 2).join("; ")}`);
      const r = p.range!;
      if (!r.cumulative) return fail("list changed its pager form after Show more");
      const keys = p.rows.map((x) => x.key);
      if (prev.some((k, i) => keys[i] !== k)) return fail(`rows already read changed after Show more ${clicks}`);
      if (new Set(keys).size !== keys.length) return fail("a row is listed twice");
      if (raw.empty) return fail(`list capped: "No more results" after ${p.rows.length} rows`);
      const exact = !r.plus && !r.approx;
      const more = !!raw.more?.present && !raw.more.disabled;
      if (!more) {
        if (exact) { if (r.b !== r.total) return fail(`no Show more but only ${r.b} of ${r.total} read`); break; }
        // the list's own end form ("about 60 documents", nothing more offered): the rows must be the estimate within its rounding
        if (r.end) { if (Math.abs(r.b - r.total) > approxTol(r.total)) return fail(`list ended at ${r.b} rows, but says about ${r.total}`); break; }
        if (r.plus || r.b < r.total || r.b - r.total > approxTol(r.total)) return fail(`no Show more at ${r.b} rows, ${r.approx ? "about " : ""}${r.total}${r.plus ? "+" : ""} shown (list may be cut)`);
        break;
      }
      if (exact && r.b >= r.total) return fail("total reached but the list still offers Show more");
      if (r.end) return fail("end footer but the list still offers Show more");
      if (clicks > 400) return fail("more than 400 Show more presses");
      if (Date.now() > this.deadline) return fail(`pacer: task budget spent after ${clicks} Show more presses (${r.b} of ${r.total})`);
      prev = keys;
      const pressed = await this.c.evalApp<boolean>(`const T=e=>((e&&(e.innerText!=null?e.innerText:e.textContent))||'').replace(/\\s+/g,' ').trim(); const b=[...doc.querySelectorAll('button,a[role=button]')].filter(b=>!b.closest('[aria-hidden="true"]')&&!b.closest('form')&&b.getAttribute('tabindex')!=='-1').find(b=>/^(show|load|see) more\\b/i.test(T(b))||/^(show|load) more\\b/i.test(b.getAttribute('aria-label')||'')); if(!b||b.disabled||b.getAttribute('aria-disabled')==='true') return false; b.click(); return true;`).catch(() => false);
      if (!pressed) return fail(`could not press Show more after ${p.rows.length} rows`);
      clicks++;
      const nx = await this.settled(spec, {}, 9000, pageKey(p, raw), true);
      if (!nx) return fail(`Show more ${clicks} did not load`);
      if (nx.p.rows.length < p.rows.length) return fail(`Show more ${clicks} lost rows`);
      p = nx.p; raw = nx.raw;
    }
    if (!/all locations/i.test(await this.c.pickerLabel().catch(() => ""))) return fail("the session location picker left All locations during the read");
    const proof = `${via}+more: ${clicks} press(es), ${p.rows.length} rows${p.range && !p.range.approx && !p.range.plus ? " = exact total" : ` ≈ about ${p.range?.total}`}`;
    this.lastStats = { pages: clicks + 1, rows: p.rows.length, ms: Date.now() - t0, via: via + "+more" };
    this.log({ event: "list-read", filter, ok: true, ...this.lastStats });
    return { rows: p.rows, proof };
  }
}
