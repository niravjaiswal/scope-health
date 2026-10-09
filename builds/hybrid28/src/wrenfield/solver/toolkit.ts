/**
 * The capability toolkit: one uniform, read-only API over the proven components, for plan executors.
 * Every primitive returns `{ ok: true, value, proof }` or `{ ok: false, why }` — never a partial answer.
 *
 *   getPatient(name, dob?)                     patientResolve.resolvePatient (DOB search / sorted name list)
 *   listEntities(entity, scope, filters, ctx)  clinic appointments → apptList.ApptList (proven walk);
 *                                              everything else → label route + labelled filters (operate.ts)
 *                                              + listJudge (pager / Show-more / count proofs)
 *   getFields(entity, href, fields)            a detail page's label → value blocks (pageRead), by label
 *   rowFields(entity, row, fields)             a listed row's cells, by header label
 *   readImageDoc('lab' | 'remit', …)           labRead / remitRead: two independent readers must agree
 *   dates / money / business days              ./dates.ts      message tables: ./lookup.ts
 *
 * Proof strength: "page" = the site itself states the count/end (safe for absence answers: 0, "none");
 * "model" = complete by the site model (a table never seen paged; an "about N" list that ended within tolerance).
 */
import type { Crawler } from "../crawl.js";
import { Operator, OPERATE_LIB } from "../operate.js";
import { resolvePatient, type FoundRow } from "../patientResolve.js";
import { ApptList, type RawControl } from "../apptList.js";
import type { ReadFilter, Status } from "../aggregate.js";
import { readLab, type LabNeed, type LabMeta } from "../labRead.js";
import { readRemit, type RemitExpect } from "../remitRead.js";
import { PAGE_READ_JS, type PageRead, type TableRead, type Cell, type Seg } from "./pageRead.js";
import { famMapsFor, type FamMaps } from "../claimReader.js";
import { applyDigitMap } from "../fontDecode.js";
import { judge, newJudge, type ListProof } from "./listJudge.js";
import { ENTITIES, listFor, resolveLabel, seenTable, type Entity, type ListSpec } from "./siteModel.js";
import { parseDate, within } from "./dates.js";

export type Proof = { how: string; strength: "page" | "model"; source: string; pages?: number; rows?: number; total?: number };
export type Ok<T> = { ok: true; value: T; proof: Proof };
export type Decline = { ok: false; why: string };
export type Result<T> = Ok<T> | Decline;
export const decline = (why: string): Decline => ({ ok: false, why });

/** A listed row: header label → cell text, plus the row's links (detail pages). */
export type Row = { cells: Record<string, string>; links: Array<{ href: string; text: string }> };
export type Filters = Record<string, string>;

// ── pure helpers (unit-tested on captured Set 1 HTML) ──

const norm = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toLowerCase();

/** The ONE table of `read` that serves `spec`: title pattern + every required header (or a synonym of it). */
export function pickTable(read: PageRead, spec: ListSpec, entity: Entity): { table: TableRead } | { why: string } {
  const fields = ENTITIES[entity].fields;
  const hasHeader = (t: TableRead, h: string) => t.headers.includes(h) || Object.values(fields).some((re) => re.test(h) && t.headers.filter((x) => re.test(x)).length === 1);
  const cands = read.tables.filter((t) => spec.table.test(t.caption || t.label || t.heading) && spec.requiredHeaders.every((h) => hasHeader(t, h)));
  if (cands.length === 1) return { table: cands[0] };
  return { why: cands.length ? `${cands.length} tables match ${spec.table}` : `no table matching ${spec.table} with headers ${spec.requiredHeaders.join(", ")} (tables: ${read.tables.map((t) => `${t.caption || t.label || t.heading} [${t.headers.join("|")}]`).join("; ") || "none"})` };
}
export function rowsOf(headers: string[], cells: Cell[][]): Row[] {
  return cells.map((r) => ({ cells: Object.fromEntries(headers.map((h, i) => [h, r[i]?.text ?? ""]).filter(([h]) => h)), links: r.flatMap((c) => c.links.map((l) => ({ href: l.href, text: l.text }))) }));
}
/** Fields of one listed row by header label (canonical names or the page's own labels). */
export function rowFields(entity: Entity, row: Row, fields: string[]): Result<Record<string, string>> {
  const labels = Object.keys(row.cells); const out: Record<string, string> = {};
  for (const f of fields) { const r = resolveLabel(entity, f, labels); if ("why" in r) return decline(r.why); out[f] = row.cells[r.label]; }
  return { ok: true, value: out, proof: { how: "row cells by header label", strength: "page", source: "row" } };
}
/** Fields of a detail page by label, across its label → value blocks ("Block.Label" narrows to one block). The
 *  same label in two blocks with different values is a decline. */
export function fieldsFromRead(entity: Entity, read: PageRead, fields: string[]): Result<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const [blk, lab] = f.includes(".") ? [f.slice(0, f.indexOf(".")), f.slice(f.indexOf(".") + 1)] : ["", f];
    const dls = read.dls.filter((d) => !blk || norm(d.heading) === norm(blk) || norm(d.region) === norm(blk));
    if (blk && !dls.length) return decline(`no block "${blk}" (blocks: ${read.dls.map((d) => d.heading).join(" | ")})`);
    const labels = [...new Set(dls.flatMap((d) => d.pairs.map((p) => p[0])))];
    const r = resolveLabel(entity, lab, labels); if ("why" in r) return decline(r.why);
    const vals = [...new Set(dls.flatMap((d) => d.pairs.filter((p) => p[0] === r.label).map((p) => p[1])))];
    if (vals.length !== 1) return decline(`label "${r.label}" shows ${vals.length} different values`);
    out[f] = vals[0];
  }
  return { ok: true, value: out, proof: { how: "detail page label → value blocks", strength: "page", source: "detail" } };
}
/** Client-side re-check: every row must satisfy the filters that map to a column (the list's own filter is
 *  never trusted alone). Returns the problem, or "" when every checkable filter holds. */
export function recheck(entity: Entity, spec: ListSpec, rows: Row[], filters: Filters): string {
  if (!rows.length) return "";
  const labels = Object.keys(rows[0].cells);
  const dateCol = (() => { for (const f of ["date", "received", "serviceDate", "datetime", "dateGiven", "time", "written", "issued"]) { const r = resolveLabel(entity, f, labels); if (!("why" in r)) return r.label; } return ""; })();
  for (const [k, v] of Object.entries(filters)) {
    if (/^(from|to)$|(from|to)$/i.test(k)) {
      const d = parseDate(v); if (!d) return `filter ${k}: "${v}" is not a date`;
      const col = /^(serviceFrom|serviceTo)$/.test(k) ? "Service date" : /^(issuedFrom|issuedTo)$/.test(k) ? "Issued" : dateCol;
      if (!col || !labels.includes(col)) continue;
      for (const r of rows) { const rd = parseDate(r.cells[col]); if (!rd) return `row date "${r.cells[col]}" unreadable`; if (/from$/i.test(k) ? rd < d : rd > d) return `row dated ${rd} outside ${k}=${d}: the list filter did not hold`; }
      continue;
    }
    const lab = resolveLabel(entity, k, labels); if ("why" in lab) continue; // not a column: the control's own state was verified
    if (/^(all|any|every)\b/i.test(v)) continue;
    const bad = rows.find((r) => norm(r.cells[lab.label]).replace(/\s*(recurring|test record|restricted|deleted|merged)\b.*$/, "") !== norm(v) && !norm(r.cells[lab.label]).startsWith(norm(v) + " "));
    if (bad) return `row ${lab.label}="${bad.cells[lab.label]}" does not equal filter ${k}="${v}"`;
  }
  return "";
}

/** Decode digits drawn in custom fonts (per family: identity or an exact codepoint map). A digit in a family
 *  that can't be placed → decline: scrambled codepoints are never returned as data. */
export function decodeRead(read: PageRead, fm: FamMaps): PageRead | { why: string } {
  if (!read.families?.length) return read;
  let bad = "";
  const dec = (segs: Seg[]): string => {
    let out = "";
    for (const [t, f] of segs) { if (!f) { out += t; continue; } const m = fm[f]; if (m === "identity") out += t; else if (m) out += applyDigitMap(t, m); else { bad = f; out += t; } }
    return out.replace(/\s+/g, " ").trim();
  };
  const tables = read.tables.map((t) => ({ ...t, rows: t.rows.map((r) => r.map((c) => (c.segs ? { ...c, text: dec(c.segs) } : c))) }));
  const dls = read.dls.map((d) => ({ ...d, pairs: d.pairs.map((p) => (p.length === 3 ? [p[0], dec(p[2])] as [string, string] : p)) }));
  if (bad) return { why: `digits drawn in font "${bad}" could not be decoded` };
  return { ...read, tables, dls };
}

/** The page's own "nothing here" statement for THIS entity: "No documents in this chart", "No invoices on this
 *  account", "No conditions recorded". Exactly "No <entity noun> <where>": a qualified statement ("No single
 *  appointments on record" — recurring series may still exist) is not proof of an empty list. */
const EMPTY_NOUNS: Partial<Record<Entity, string>> = { appointment: "appointments", document: "documents", invoice: "invoices", claim: "claims", remittance: "remittances",
  immunization: "immunizations|vaccines|vaccinations", note: "notes", problem: "problems|conditions", allergy: "allergies|known allergies", order: "orders", coverage: "insurance|coverage",
  authorization: "authorizations", activity: "activity|entries", language: "entries" };
export function emptyStatement(entity: Entity, footers: string[]): string | undefined {
  const nouns = EMPTY_NOUNS[entity]; if (!nouns) return undefined;
  const re = new RegExp(`^No (?:${nouns}) (?:found|yet|on file|on record|recorded|in this chart|on this account)(?: for this (?:patient|chart|account))?\\.?$`, "i");
  const hits = footers.filter((f) => re.test(f.trim()));
  return hits.length === 1 ? hits[0] : undefined;
}

// ── live toolkit ──

export class FontDecline extends Error {}

export class Toolkit {
  private op: Operator;
  constructor(public c: Crawler, private log: (rec: Record<string, unknown>) => void = () => {}) { this.op = new Operator(c); }
  /** Wait until the page has rendered content (a table, a label block, a form or a gate), is not loading,
   *  and two consecutive readings agree; then return it (decoded). */
  async settled(ms = 10000): Promise<PageRead> {
    const t0 = Date.now(); let prev = "";
    while (Date.now() - t0 < ms) {
      const r = await this.c.evalApp<PageRead>(PAGE_READ_JS).catch(() => null);
      if (r && r.tables && !r.loading && (r.tables.length || r.dls.length || r.forms.length || r.gates.length || r.footers.length)) {
        const sig = JSON.stringify([r.h1, r.tables.map((t) => [t.caption, t.headers, t.rows.length, t.foot]), r.dls.map((d) => d.pairs.length), r.gates]);
        if (sig === prev) break;
        prev = sig;
      }
      await new Promise((res) => setTimeout(res, 250));
    }
    return this.read();
  }
  /** The current page, digits decoded (throws a Decline-shaped error when a font can't be placed). */
  async read(): Promise<PageRead> {
    const r = await this.c.evalApp<PageRead>(PAGE_READ_JS);
    if (!r || !r.tables) throw new Error("page not readable (navigating)");
    if (!r.families?.length) return r;
    const fm = await famMapsFor(this.c, { families: r.families } as any);
    if ("decline" in fm) throw new FontDecline(String((fm as any).decline));
    const d = decodeRead(r, fm as FamMaps);
    if ("why" in d) throw new FontDecline(d.why);
    return d;
  }

  /** The one patient a task names (DOB optional). Several same-named charts without a DOB → decline (the
   *  caller may narrow them with contextResolve.pickByContext). */
  async getPatient(name: string, dob?: string): Promise<Result<FoundRow>> {
    const dobISO = dob ? parseDate(dob) : undefined; if (dob && !dobISO) return decline(`DOB "${dob}" is not a date`);
    const r = await resolvePatient(this.c as any, name, dobISO);
    if (!r.chosen) return decline(`patient: ${r.why}`);
    return { ok: true, value: r.chosen, proof: { how: r.via === "dob" ? `DOB search ${dobISO}: one row carries every word of "${name}"` : `sorted name list read past "${name}" (${r.pages} page(s), terms ${r.terms.join("/")}): exactly one row`, strength: "page", source: "patientResolve" } };
  }

  /** Navigate to the page that lists (entity, scope). */
  private async route(spec: ListSpec, ctx: { patientHref?: string; parentUrl?: string }): Promise<string | null> {
    const go = async (u: string) => { if (!(await this.c.navTo(u, /\S{3}/, 12000, true).catch(() => false))) return null; await this.settled(); return u; };
    const findLink = (label: string) => this.c.evalApp<string[]>(`const N=s=>(s||'').replace(/\\s+/g,' ').trim().toLowerCase(); return [...doc.querySelectorAll('a[href^="/"]')].filter(a=>N(a.textContent)===N(${JSON.stringify(label)})||N(a.getAttribute('aria-label'))===N(${JSON.stringify(label)})).map(a=>a.getAttribute('href'))`).catch(() => [] as string[]);
    if (spec.scope === "patient") {
      if (!ctx.patientHref) return null;
      const pid = ctx.patientHref.replace(/^.*\/patients\//, "").split(/[/?]/)[0];
      if (spec.tab) {
        await go(`/patients/${pid}`);
        const hs = [...new Set(await findLink(spec.tab))];
        if (hs.length === 1) return go(hs[0]);
      }
      for (const u of [spec.url, ...(spec.alt ?? [])]) { const r = await go(u.replace("{patient}", pid)); if (r && !(await this.read().catch(() => null))?.h1.match(/not found|isn.t working/i)) return r; }
      return null;
    }
    if (spec.scope === "parent") return ctx.parentUrl ? go(ctx.parentUrl) : null;
    if (spec.nav) { await go("/"); const hs = [...new Set((await findLink(spec.nav)).map((h) => h.split("?")[0]))]; if (hs.length === 1) return go(hs[0]); }
    for (const u of [spec.url, ...(spec.alt ?? [])]) { if (await go(u)) { const r = await this.read().catch(() => null); if (r && r.tables.length) return u; } }
    return null;
  }

  /** Every row of (entity, scope) matching `filters`, proven complete — or a decline.
   *  Filters use the list's plan keys (siteModel ListSpec.filters, e.g. frto/type/status/location) with the
   *  value as the page writes it (option text) or ISO dates for date controls. */
  async listEntities(...a: Parameters<Toolkit["listEntitiesRaw"]>): ReturnType<Toolkit["listEntitiesRaw"]> {
    try { return await this.listEntitiesRaw(...a); } catch (e) { if (e instanceof FontDecline) return decline(`${a[0]}: ${e.message}`); return decline(`${a[0]}: ${String(e).slice(0, 160)}`); }
  }
  async listEntitiesRaw(entity: Entity, scope: "clinic" | "patient" | "parent", filters: Filters = {}, ctx: { patientHref?: string; parentUrl?: string; budgetMs?: number } = {}): Promise<Result<{ rows: Row[]; headers: string[] }>> {
    const spec = listFor(entity, scope); if ("why" in spec) return decline(spec.why);
    const deadline = Date.now() + (ctx.budgetMs ?? 45000);
    if (entity === "appointment" && scope === "clinic") return this.clinicAppointments(filters, ctx.budgetMs ?? 45000);
    if (spec.allLocations && !(await this.c.ensureAllLocations())) return decline("session location picker is not All locations");
    const at = await this.route(spec, ctx); if (!at) return decline(`${entity}/${scope}: list page not reachable (tab "${spec.tab ?? ""}", nav "${spec.nav ?? ""}", ${spec.url})`);
    let r = await this.settled();
    if (r.gates.length) return decline(`${entity}: the chart is restricted (gate not opened by the toolkit)`);
    // filters by label
    const unknown = Object.keys(filters).filter((k) => !(spec.filters ?? {})[k]);
    if (unknown.length) return decline(`${entity}/${scope}: no filter control for ${unknown.join(", ")} (model filters: ${Object.keys(spec.filters ?? {}).join(", ") || "none"})`);
    const setLabels: Array<[string, string]> = [];
    for (const [k, v] of Object.entries(filters)) {
      const label = spec.filters![k];
      const ctl = (await this.controls()).filter((x) => norm(x.label) === norm(label));
      if (ctl.length !== 1) return decline(`filter "${label}": ${ctl.length} controls carry this label`);
      const val = ctl[0].type === "date" ? (parseDate(v) ?? "") : v; if (!val) return decline(`filter ${k}: "${v}" is not a date`);
      const s = await this.op.set(label, val); if (!s.ok) return decline(`filter ${k}: ${s.why}`);
      setLabels.push([label, val]);
    }
    if (setLabels.length) {
      const sub = await this.op.submit(setLabels[0][0], spec.apply);
      if (!sub.ok) { // a filter that applies on change (no submit button) is fine when the page already changed
        await new Promise((res) => setTimeout(res, 1200));
      }
      await this.settled();
      const after = await this.controls();
      for (const [label, val] of setLabels) {
        const c = after.filter((x) => norm(x.label) === norm(label));
        const shown = c.length === 1 ? (c[0].tag === "select" ? (c[0].options.find((o) => o.value === c[0].value)?.text ?? "") : c[0].value) : "";
        if (norm(shown) !== norm(val) && !(c[0]?.type === "date" && parseDate(shown) === parseDate(val))) return decline(`filter "${label}" shows "${shown}" after applying "${val}"`);
      }
      r = await this.read();
    }
    // biggest page size (a view setting)
    const rpp = (await this.controls()).filter((x) => /rows per page/i.test(x.label));
    if (rpp.length === 1 && rpp[0].options.length) {
      const best = rpp[0].options.map((o) => ({ o, n: Number((o.text.match(/\d+/) || ["0"])[0]) })).sort((a, b) => b.n - a.n)[0];
      if (best.n && best.o.value !== rpp[0].value) { const before = JSON.stringify(r.tables.map((t) => t.foot)); await this.op.set(rpp[0].label, best.o.text);
        for (let i = 0; i < 40; i++) { await new Promise((res) => setTimeout(res, 150)); r = await this.read(); if (JSON.stringify(r.tables.map((t) => t.foot)) !== before) break; } }
    }
    const tm = seenTable(spec);
    const modelSingle = !!tm && tm.fullObs > 0 && tm.paged.length === 0 && tm.foots.length === 0;
    const st = newJudge(); let headers: string[] = [];
    for (;;) {
      const pick = pickTable(r, spec, entity);
      if ("why" in pick) {
        // an empty list may render no table at all, only its "No … on file" statement
        const none = st.pages === 0 ? emptyStatement(entity, r.footers) : undefined;
        if (st.pages === 0 && none) return { ok: true, value: { rows: [], headers: [] }, proof: { how: `the page states "${none}"`, strength: "page", source: at } };
        return decline(`${entity}: ${pick.why}`);
      }
      headers = pick.table.headers;
      const v = judge(st, pick.table, { noMore: r.noMore, modelSingle });
      if (v.kind === "decline") return decline(`${entity}/${scope}: ${v.why}`);
      if (v.kind === "done") {
        const rows = rowsOf(headers, st.rows);
        const bad = recheck(entity, spec, rows, filters); if (bad) return decline(`${entity}/${scope}: ${bad}`);
        this.log({ event: "toolkit-list", entity, scope, rows: rows.length, how: v.proof.how });
        return { ok: true, value: { rows, headers }, proof: { how: v.proof.how, strength: v.proof.strength, source: at, pages: v.proof.pages, rows: rows.length, total: v.proof.total } };
      }
      if (Date.now() > deadline) return decline(`${entity}/${scope}: budget spent after ${st.rows.length} rows`);
      const pr = await this.op.press(v.action === "next" ? "Next" : (pick.table.more.name || "Show more"), { exact: true, timeoutMs: 9000 });
      if (!pr.ok) return decline(`${entity}/${scope}: ${pr.why}`);
      r = await this.settled();
    }
  }
  /** Visible controls with their ACCESSIBLE names (operate.ts accName: aria-label, label[for], wrapping label…). */
  private async controls(): Promise<RawControl[]> {
    return this.c.evalApp<RawControl[]>(`${OPERATE_LIB}\nreturn [...doc.querySelectorAll('input,select,textarea')].filter(e=>e.type!=='hidden'&&!hidden(e)).map(e=>({label:accName(e),name:e.name||'',id:e.id||'',tag:e.tagName.toLowerCase(),type:(e.type||'').toLowerCase(),value:e.value||'',inForm:!!e.closest('form'),options:e.tagName==='SELECT'?[...e.options].map(o=>({value:o.value,text:TX(o),group:''})):[]}));`).catch(() => [] as RawControl[]);
  }

  private async clinicAppointments(filters: Filters, budgetMs: number): Promise<Result<{ rows: Row[]; headers: string[] }>> {
    const from = parseDate(filters.from ?? ""), to = parseDate(filters.to ?? from ?? "");
    if (!from || !to) return decline("appointment list: frto dates required");
    const extra = Object.keys(filters).filter((k) => !["from", "to", "status", "location", "provider"].includes(k));
    if (extra.length) return decline(`appointment list: filter ${extra.join(", ")} not supported by apptList (filter the rows instead)`);
    const al = new ApptList(this.c, this.log); al.begin(budgetMs);
    const f: ReadFilter = { from, to, status: (filters.status ? filters.status : "any") as Status | "any", location: filters.location, provider: filters.provider };
    const res = await al.read(f);
    if ("fail" in res) return decline(`appointment list: ${res.fail}`);
    const headers = ["Date", "Start", "End", "Patient", "Provider", "Location", "Visit type", "Status", "Flags"];
    const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    const rows: Row[] = res.rows.filter((x) => within(x.dateISO, from, to)).map((x) => ({ cells: { Date: x.dateISO, Start: hm(x.start), End: hm(x.end), Patient: x.patientName, Provider: x.provider, Location: x.location, "Visit type": x.visitType, Status: x.status, Flags: x.flags.join(" ") }, links: x.patientId ? [{ href: `/patients/${x.patientId}`, text: x.patientName }] : [] }));
    const st = al.lastStats;
    return { ok: true, value: { rows, headers }, proof: { how: `apptList: ${st?.pages ?? "?"} page(s) via ${st?.via ?? "?"}, ranges/totals checked`, strength: "page", source: "/schedule/appointments", pages: st?.pages, rows: rows.length } };
  }

  /** Label → value fields of a detail page (an href from a listed row). */
  async getFields(entity: Entity, href: string, fields: string[]): Promise<Result<Record<string, string>>> {
    try { return await this.getFieldsRaw(entity, href, fields); } catch (e) { return decline(`${entity}: ${e instanceof FontDecline ? e.message : String(e).slice(0, 160)}`); }
  }
  private async getFieldsRaw(entity: Entity, href: string, fields: string[]): Promise<Result<Record<string, string>>> {
    if (!(await this.c.navTo(href, /\S{3}/, 12000, true).catch(() => false))) return decline(`${href} did not load`);
    const r = await this.settled();
    if (r.gates.length) return decline(`${entity}: restricted chart (gate not opened by the toolkit)`);
    const out = fieldsFromRead(entity, r, fields);
    return out.ok ? { ...out, proof: { ...out.proof, source: href } } : out;
  }

  /** A scanned document read by two independent readers that must agree (labRead / remitRead).
   *  lab: `need` = tests (closed vocabulary from the governing message) + meta fields; every needed field must
   *  come back agreed, else decline. remit: `expect` = the claim the remittance is read for. */
  async readImageDoc(kind: "lab", docHref: string, args: { need: LabNeed; vocab: string[] }): Promise<Result<{ values: Record<string, number>; meta: Partial<Record<LabMeta, string>> }>>;
  async readImageDoc(kind: "remit", docHref: string, args: { expect: RemitExpect }): Promise<Result<{ lines: unknown[] }>>;
  async readImageDoc(kind: "lab" | "remit", docHref: string, args: any): Promise<Result<any>> {
    const png = (await this.c.fetchDocImage(docHref).catch(() => null)) ?? (await this.c.captureDoc(docHref).catch(() => null));
    if (!png) return decline(`no image captured at ${docHref}`);
    if (kind === "lab") {
      const { read, trace } = await readLab(png, args.need, args.vocab);
      if (trace.unknown.length) return decline(`lab read: no agreed value for ${trace.unknown.join(", ")}`);
      const meta: Partial<Record<LabMeta, string>> = {}; for (const m of args.need.meta as LabMeta[]) meta[m] = (read as any)[m];
      return { ok: true, value: { values: read.values, meta }, proof: { how: `tesseract ∥ model agreed${trace.tiebreak ? " (+tiebreak)" : ""}`, strength: "page", source: docHref } };
    }
    const { lines, trace } = await readRemit(png, args.expect);
    if (typeof lines === "string") return decline(lines);
    return { ok: true, value: { lines }, proof: { how: `remittance image: readers agreed on every field (${trace.models.join(", ")})`, strength: "page", source: docHref } };
  }
}

export type { ListProof };
