/**
 * Builds `siteModel.data.json`: for every page template seen (Set 1 recon dumps + the practice-site crawl
 * captured by `siteCrawl-live.ts`), the tables (caption, headers, value shape per column), label → value
 * blocks (<dl>), labelled filter controls with their options, pagers / Show-more, tabs, gates and image
 * documents. Sources are merged per template (union), each fact tagged with where it was seen.
 *
 *   npx tsx src/wrenfield/solver/buildSiteModel.ts [practice-crawl.jsonl]
 *
 * No record data is stored: only labels, option lists of filter controls, and value SHAPES (date, money…).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { JSDOM } from "jsdom";
import { dumpSections, pageReadOn, type PageRead } from "./pageRead.js";
import { templateKey } from "./siteModel.js";

export type Shape = "date" | "datetime" | "time-range" | "money" | "int" | "percent" | "code" | "person" | "empty" | "text";
export function shapeOf(v: string): Shape {
  const s = v.trim();
  if (!s || /^(none|—|-)$/i.test(s)) return "empty";
  if (/^\$-?[\d,]+\.\d{2}$/.test(s) || /^-?\$[\d,]+\.\d{2}$/.test(s)) return "money";
  if (/^\d+(\.\d+)?%$/.test(s)) return "percent";
  if (/^(?:[A-Z][a-z]{2},\s+)?[A-Z][a-z]{2,8}\.? \d{1,2}, \d{4},? \d{1,2}:\d{2}\s*[AP]M/.test(s)) return "datetime";
  if (/^(?:[A-Z][a-z]{2},\s+)?[A-Z][a-z]{2,8}\.? \d{1,2}, \d{4}$/.test(s) || /^\d{4}-\d{2}-\d{2}$/.test(s) || /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) return "date";
  if (/^\d{1,2}:\d{2}\s*[AP]M\s+to\s+/i.test(s)) return "time-range";
  if (/^-?[\d,]+$/.test(s)) return "int";
  if (/^[A-Z0-9][A-Z0-9-]{2,}$/.test(s) && /\d/.test(s)) return "code";
  if (/^[A-Z][A-Za-zÀ-ÿ'’ -]+, [A-Z][A-Za-zÀ-ÿ'’. -]+$/.test(s)) return "person";
  return "text";
}

export type TableModel = { title: string; region: string; headers: string[]; shapes: Record<string, Shape[]>; rowsSeen: number; seen: string[];
  /** count footers seen under this table (numbers → N), and whether a Next / Show more was ever offered for it */
  foots: string[]; paged: Array<"next" | "show-more">; maxRows: number;
  /** observations from complete (untruncated) pages — only these may show a table is never paged */
  fullObs: number };
export type DlModel = { heading: string; labels: string[]; seen: string[] };
export type ControlModel = { label: string; kind: string; form: string; method?: string; options?: string[]; seen: string[] };
export type TemplateModel = {
  template: string; examples: string[]; h1s: string[];
  tables: TableModel[]; dls: DlModel[]; controls: ControlModel[];
  footers: string[]; pager: { next: boolean; showMore: string[]; rowsPerPage?: string[] };
  tabs: string[]; gates: string[]; images: string[]; seen: string[];
};

const uniq = <T>(a: T[]) => [...new Set(a)];
export function addPage(model: Map<string, TemplateModel>, url: string, r: PageRead, source: string, truncated = false) {
  const template = templateKey(url);
  const m = model.get(template) ?? { template, examples: [], h1s: [], tables: [], dls: [], controls: [], footers: [], pager: { next: false, showMore: [] }, tabs: [], gates: [], images: [], seen: [] };
  model.set(template, m);
  m.seen = uniq([...m.seen, source]);
  if (m.examples.length < 3 && !m.examples.includes(url)) m.examples.push(url.replace(/\/[a-z0-9]{10,}(?=\/|$|\?)/g, "/{id}"));
  m.examples = uniq(m.examples);
  if (r.h1 && !/^(This page isn|Loading)/.test(r.h1)) m.h1s = uniq([...m.h1s, /^[A-Z][^,]+, [A-Z]/.test(r.h1) ? "{patient name}" : r.h1.replace(/\d{5,}/g, "{n}")]).slice(0, 6);
  for (const t of r.tables) {
    if (!t.headers.length) continue;
    const title = (t.caption || t.label || t.heading).replace(/\b(of|for) (?!this\b)(the )?[A-Z][^,]*$/, "$1 $2{name}").replace(/\b\d{4}\b/g, "{year}").replace(/\b[A-Z]{3}\d{6,}\b/g, "{trace}");
    let tm = m.tables.find((x) => x.title === title && x.headers.join("|") === t.headers.join("|"));
    if (!tm) { tm = { title, region: t.region, headers: t.headers, shapes: {}, rowsSeen: 0, seen: [], foots: [], paged: [], maxRows: 0, fullObs: 0 }; m.tables.push(tm); }
    if (t.foot) tm.foots = uniq([...tm.foots, t.foot.replace(/\d[\d,]*/g, "N")]);
    if (t.next?.present) tm.paged = uniq([...tm.paged, "next" as const]);
    if (t.more?.present) tm.paged = uniq([...tm.paged, "show-more" as const]);
    tm.maxRows = Math.max(tm.maxRows, t.rows.length);
    if (!truncated) tm.fullObs++;
    tm.seen = uniq([...tm.seen, source]); tm.rowsSeen += t.rows.length;
    t.rows.forEach((row) => t.headers.forEach((h, i) => { if (!h || !row[i]) return; const sh = shapeOf(row[i].text); tm!.shapes[h] = uniq([...(tm!.shapes[h] ?? []), sh]); }));
  }
  for (const d of r.dls) {
    const heading = /^[A-Z][^,]+, [A-Z]/.test(d.heading) ? "{patient name}" : d.heading;
    let dm = m.dls.find((x) => x.heading === heading);
    if (!dm) { dm = { heading, labels: [], seen: [] }; m.dls.push(dm); }
    dm.labels = uniq([...dm.labels, ...d.pairs.map((p) => p[0])]); dm.seen = uniq([...dm.seen, source]);
  }
  const addCtl = (c: { label: string; kind: string; options?: string[] }, form: string, method?: string) => {
    if (!c.label) return;
    let cm = m.controls.find((x) => x.label === c.label && x.form === form);
    if (!cm) { cm = { label: c.label, kind: c.kind, form, method, options: c.options, seen: [] }; m.controls.push(cm); }
    if (c.options) cm.options = uniq([...(cm.options ?? []), ...c.options]).slice(0, 40);
    cm.seen = uniq([...cm.seen, source]);
  };
  for (const f of r.forms) for (const c of f.fields) addCtl(c, f.name || "(form)", f.method);
  for (const c of r.fields) addCtl(c, "(page)");
  m.footers = uniq([...m.footers, ...r.footers.map((f) => f.replace(/\d[\d,]*/g, "N"))]).slice(0, 8);
  m.pager.next ||= r.next.present;
  m.pager.showMore = uniq([...m.pager.showMore, ...r.more.map((x) => x.name)]);
  const rpp = r.fields.find((f) => /rows per page/i.test(f.label));
  if (rpp?.options) m.pager.rowsPerPage = rpp.options;
  m.tabs = uniq([...m.tabs, ...r.tabs.map((t) => t.name)]);
  m.gates = uniq([...m.gates, ...r.gates]);
  m.images = uniq([...m.images, ...r.images.map((i) => i.kind + (i.alt ? `:${i.alt.slice(0, 30)}` : ""))]).slice(0, 8);
}

export function buildFromDumps(files: string[], crawl?: string): TemplateModel[] {
  const model = new Map<string, TemplateModel>();
  for (const f of files) {
    if (!existsSync(f)) continue;
    const src = f.split("/").pop()!.replace(/\.txt$/, "");
    for (const s of dumpSections(readFileSync(f, "utf8"))) {
      if (!s.url) continue;
      const r = pageReadOn(new JSDOM(s.html).window.document);
      if (/This page isn’t working|^$/.test(r.h1) && !r.tables.length && !r.forms.length && !r.dls.length) continue;
      addPage(model, s.url, r, `set1:${src}`, s.truncated);
    }
  }
  if (crawl && existsSync(crawl)) for (const line of readFileSync(crawl, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const { url, read } = JSON.parse(line) as { url: string; read: PageRead };
    if (read) addPage(model, url, read, "practice");
  }
  return [...model.values()].sort((a, b) => a.template.localeCompare(b.template));
}

if (process.argv[1]?.endsWith("buildSiteModel.ts")) {
  const here = new URL(".", import.meta.url).pathname;
  const root = here + "../../../";
  const dumps = [root + "fixtures/set1/recon-158.txt", root + "fixtures/set1/claim-dump-baseline.txt", root + "../anotherDOMdump.txt", "/app/anotherDOMdump.txt"];
  const crawl = process.argv[2] ?? here + "practice-crawl.jsonl";
  const out = buildFromDumps(dumps, crawl);
  writeFileSync(here + "siteModel.data.json", JSON.stringify({ built: "buildSiteModel.ts", templates: out }, null, 1) + "\n");
  console.log(`siteModel.data.json: ${out.length} templates, ${out.reduce((n, t) => n + t.tables.length, 0)} tables, ${out.reduce((n, t) => n + t.controls.length, 0)} controls`);
}
