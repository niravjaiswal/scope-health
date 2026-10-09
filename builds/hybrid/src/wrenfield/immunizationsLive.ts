/**
 * [immunizations] LIVE reader for tetanus-wound on top of the Crawler's primitives.
 * Chart tabs are found by their link TEXT in the chart's own navigation (URL suffix only as a
 * fallback); lists are read on EVERY page and checked against the page's own count; notes are read
 * per list item (article / list child) so one note's body can never run into the next. All parsing
 * and the decision live in immunizations.ts (pure, tested offline).
 */
import type { Crawler } from "./crawl.js";
import { why } from "./why.js";
import {
  type Note, type ImmEntry, type Doc, type PageInfo, type Skip, type TetanusRule, type TetanusCtx, isSkip, pageInfo,
  parseNoteChunk, parseNotesText, combinePages, parseImmunizations, parseDocuments, buildTetanusContext, normText,
} from "./immunizations.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const GATE = /chart is restricted|Give a reason to open it/i;
/** Arrival = the list's own cue, or the restricted-chart gate (opened next by ungate). */
const arrived = (cue: RegExp) => new RegExp(`${cue.source}|${GATE.source}`, "i");
const NOTE_NOUNS = "notes?";
const IMM_NOUNS = "entr(?:y|ies)|immuni[sz]ations?|doses?|vaccines?|records?";
const DOC_NOUNS = "documents?|files?";

async function waitFor(c: Crawler, pred: (t: string) => boolean, ms = 4000): Promise<string | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const t = await c.appText().catch(() => ""); if (pred(t)) return c.decodedText().catch(() => t); await sleep(80); }
  return null;
}
async function ungate(c: Crawler): Promise<boolean> { if (!GATE.test(await c.appText().catch(() => ""))) return true; return c.breakGlass().catch(() => false); }

/** The chart tab whose link text matches `label` (chart navigation), else `${chart}${fallback}`. */
async function chartTab(c: Crawler, chart: string, label: RegExp, fallback: string): Promise<string> {
  const here = await c.evalApp<string>(`return location.pathname`).catch(() => "");
  if (!here.startsWith(chart)) await c.navTo(chart, /./, 6000).catch(() => false);
  const hrefs = await c.evalApp<Array<{ t: string; h: string }>>(`return [...doc.querySelectorAll('nav a[href]')].filter(a=>!a.closest('[aria-hidden="true"],[hidden]')).map(a=>({t:(a.innerText||a.textContent||'').trim(),h:a.getAttribute('href')||''}))`).catch(() => [] as Array<{ t: string; h: string }>);
  const hit = hrefs.filter((x) => label.test(x.t) && x.h.startsWith(chart));
  return hit.length === 1 ? hit[0].h : `${chart}${fallback}`;
}

/** Switch a list to its largest "per page" size (if it has one). */
async function largestPage(c: Crawler): Promise<boolean> {
  return c.evalApp<boolean>(`const s=[...doc.querySelectorAll('select')].find(x=>[...x.options].some(o=>/per page|rows|show \\d+/i.test(o.text+' '+(x.getAttribute('aria-label')||'')))); if(!s) return false;
    const best=[...s.options].reduce((a,o)=>(parseInt(o.text)||0)>(parseInt(a.text)||0)?o:a); if(s.value===best.value) return true;
    const d=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set; d.call(s,best.value); s.dispatchEvent(new Event('input',{bubbles:true})); s.dispatchEvent(new Event('change',{bubbles:true})); return true;`).catch(() => false);
}
async function clickNext(c: Crawler): Promise<boolean> {
  return c.evalApp<boolean>(`const b=[...doc.querySelectorAll('button,a')].filter(x=>!x.closest('[aria-hidden="true"],[hidden]')).find(x=>/^\\s*Next(?: page)?\\s*[›>»]?\\s*$/i.test(x.textContent||'')||/^next page$/i.test(x.getAttribute('aria-label')||'')); if(b&&!b.disabled&&b.getAttribute('aria-disabled')!=='true'){b.click();return true;} return false;`).catch(() => false);
}

/** Every page of a list. `parse(text)` reads one page → items + that page's range. The items of each
 *  page must equal its range, ranges must be contiguous, and the sum must equal the total. */
async function readAllPages<T>(c: Crawler, nouns: string, parse: (text: string) => Promise<{ items: T[]; page: PageInfo } | Skip>, label: string): Promise<T[] | null> {
  const has = (t: string) => !!pageInfo(t, nouns);
  let text = await waitFor(c, has); if (!text) { why(`${label}: no count on the page`); return null; }
  let pi = pageInfo(text, nouns)!;
  if (pi.to < pi.total && (await largestPage(c))) {
    const before = pi.to;
    const t2 = await waitFor(c, (t) => { const p = pageInfo(t, nouns); return !!p && p.to !== before; }, 3000);
    if (t2) { text = t2; pi = pageInfo(text, nouns)!; }
  }
  const pages: Array<{ items: T[]; page: PageInfo }> = [];
  for (let page = 0; page < 40; page++) {
    await sleep(60);
    const r = await parse(text);
    if (isSkip(r)) { why(`${label}: page ${page + 1}: ${r.skip}`); return null; }
    if (r.page.from !== pi.from || r.page.to !== pi.to || r.page.total !== pi.total) { why(`${label}: page count changed while reading`); return null; }
    const want = pi.total ? pi.to - pi.from + 1 : 0;
    if (r.items.length !== want) { why(`${label}: page shows ${pi.from}-${pi.to} of ${pi.total} but ${r.items.length} rows were read`); return null; }
    pages.push({ items: r.items, page: r.page });
    if (pi.to >= pi.total) break;
    const marker = `${pi.from}|${pi.to}|${pi.total}`;
    if (!(await clickNext(c))) { why(`${label}: no Next control at ${pi.to}/${pi.total}`); return null; }
    const t2 = await waitFor(c, (t) => { const p = pageInfo(t, nouns); return !!p && `${p.from}|${p.to}|${p.total}` !== marker; }, 4000);
    if (!t2) { why(`${label}: next page never rendered`); return null; }
    const p2 = pageInfo(t2, nouns)!;
    if (p2.from !== pi.to + 1 || p2.total !== pi.total) { why(`${label}: page range jumped ${pi.from}-${pi.to} → ${p2.from}-${p2.to}`); return null; }
    text = t2; pi = p2;
  }
  const all = combinePages(pages);
  if (isSkip(all)) { why(`${label}: ${all.skip}`); return null; }
  return all;
}

/** In-page script (`doc`, `map`): each visible note element's text. A note's <header> items (type, author,
 *  <time>, zone) are put one per line FROM THE MARKUP: the line breaks innerText gives depend on the site's
 *  CSS (Set 1 lays them out as blocks; rendered inline, "Chart noteDr. StoneJun 22, 2026, 12:28 PM MDT" ran
 *  together and every note was declined — Set 1 replica run). Obfuscated digits decoded with `map` (as before). */
export const NOTE_CHUNKS_JS = String.raw`
    const view=doc.defaultView||window;
    const txt=(e)=>((e.innerText!=null?e.innerText:e.textContent)||'');
    const isCustom=(el)=>{let f='';try{f=(view.getComputedStyle(el).fontFamily||'').split(',')[0].replace(/["']/g,'').trim();}catch(e){}return !!f&&!/^(Atkinson|ui-|system-ui|monospace|sans-serif|serif)/i.test(f);};
    const dec=(root,t)=>{ if(!map) return t; for(const el of root.querySelectorAll('*')){ if(el.children.length===0){ const raw=(el.textContent||'').trim(); if(raw&&/[0-9]/.test(raw)&&isCustom(el)){ const d=raw.replace(/[0-9]/g,ch=>map[ch]??ch); if(d!==raw) t=t.split(raw).join(d); } } } return t; };
    const own=(root)=>{ const h=root.querySelector('header'); if(!h) return txt(root);
      const head=[...h.childNodes].map(n=>n.nodeType===3?n.nodeValue:txt(n)).map(s=>(s||'').replace(/\s+/g,' ').trim()).filter(Boolean);
      const body=root.cloneNode(true); for(const x of [...body.querySelectorAll('header')]) x.remove();
      return head.join('\n')+'\n'+txt(body).trim(); };
    const vis=(e)=>!e.closest('[aria-hidden="true"],[hidden]')&&txt(e).trim().length>0;
    let items=[...doc.querySelectorAll('article,[role=article]')].filter(vis);
    if(!items.length){ const list=[...doc.querySelectorAll('ul,ol,[role=list]')].find(u=>/notes/i.test(u.getAttribute('aria-label')||'')); if(list) items=[...list.children].filter(vis); }
    return items.map((e)=>dec(e,own(e)));`;
/** Each visible note element's text with obfuscated digits decoded (same map decodedText uses). */
async function noteChunks(c: Crawler): Promise<string[]> {
  const map = await c.currentDigitMap().catch(() => null);
  return c.evalApp<string[]>(`const map=${JSON.stringify(map ?? null)};${NOTE_CHUNKS_JS}`).catch(() => [] as string[]);
}

export async function readAllNotes(c: Crawler, chart: string): Promise<Note[] | null> {
  const href = await chartTab(c, chart, /^notes$/i, "/notes");
  if (!(await c.navTo(href, arrived(/Showing \d+\s*(?:to|-|–)\s*\d+ of \d+|\b\d+ notes?\b|No notes/), 8000))) { why("tetanus: notes tab did not load"); return null; }
  if (!(await ungate(c))) { why("tetanus: restricted chart did not open"); return null; }
  return readAllPages<Note>(c, NOTE_NOUNS, async (text) => {
    const page = pageInfo(text, NOTE_NOUNS); if (!page) return { skip: "no notes count" };
    if (page.total === 0) return { items: [], page };
    const chunks = await noteChunks(c);
    if (!chunks.length) return { skip: "notes list has no per-note elements" };
    const notes: Note[] = [];
    for (const ch of chunks) { const n = parseNoteChunk(ch); if (isSkip(n)) return n; notes.push(n); }
    // cross-check with the whole-page text: same dates in the same order, bodies start alike
    const flat = parseNotesText(text);
    if (flat.length === notes.length && flat.some((f, i) => f.dateISO !== notes[i].dateISO || normText(f.body).slice(0, 24) !== normText(notes[i].body).slice(0, 24))) return { skip: "note elements and page text disagree" };
    return { items: notes, page };
  }, "notes");
}

export async function readAllImmunizations(c: Crawler, chart: string): Promise<ImmEntry[] | null> {
  const href = await chartTab(c, chart, /^immuni[sz]ations?$|^vaccines?$|^shots$/i, "/immunizations");
  if (!(await c.navTo(href, arrived(new RegExp(`Showing \\d+\\s*(?:to|-|–)\\s*\\d+ of \\d+|\\b\\d+ (?:${IMM_NOUNS})\\b|No (?:${IMM_NOUNS})`)), 8000))) { why("tetanus: immunizations tab did not load"); return null; }
  if (!(await ungate(c))) return null;
  return readAllPages<ImmEntry>(c, IMM_NOUNS, async (text) => { const r = parseImmunizations(text); return isSkip(r) ? r : { items: r.entries, page: r.page }; }, "immunizations");
}

/** In-page: each visible table body row's text and its links (to find a document's viewer by its title). */
export const DOC_ROW_LINKS_JS = `return [...doc.querySelectorAll('tbody tr')].filter(tr=>!tr.closest('[aria-hidden="true"],[hidden]')).map(tr=>({t:(tr.innerText||tr.textContent||'').replace(/\\s+/g,' ').trim(),h:[...tr.querySelectorAll('a[href]')].map(a=>a.getAttribute('href')||'')}))`;
export async function readAllDocuments(c: Crawler, chart: string, links?: Array<{ t: string; h: string[] }>): Promise<Doc[] | null> {
  const href = await chartTab(c, chart, /^documents?$|^files$/i, "/files");
  if (!(await c.navTo(href, arrived(new RegExp(`Showing \\d+\\s*(?:to|-|–)\\s*\\d+ of \\d+|\\b\\d+ (?:${DOC_NOUNS})\\b|No (?:${DOC_NOUNS})`)), 8000))) { why("tetanus: documents tab did not load"); return null; }
  if (!(await ungate(c))) return null;
  return readAllPages<Doc>(c, DOC_NOUNS, async (text) => {
    const r = parseDocuments(text); if (isSkip(r)) return r;
    if (links) links.push(...(await c.evalApp<Array<{ t: string; h: string[] }>>(DOC_ROW_LINKS_JS).catch(() => [])));
    return { items: r.docs, page: r.page };
  }, "documents");
}

export function tetanusReader(crawler: Crawler, patientFor: (n: string, d?: string) => Promise<{ id: string; name: string } | null>) {
  return async (name: string, dob: string | undefined, visitISO: string, rule: TetanusRule): Promise<TetanusCtx | null> => {
    // The shared resolver (patientResolve.ts via index-builder's patientFor): DOB search, or for a name
    // only exactly one chart with that name across every page of the sorted list (else skip + why).
    const p = await patientFor(name, dob); if (!p) return null;
    const notes = await readAllNotes(crawler, p.id); if (!notes) return null;
    const pre = buildTetanusContext({ visitISO, notes, notesComplete: true, imms: null, immsComplete: false, docs: null, docsComplete: false }, rule);
    if (!isSkip(pre)) return pre;                                     // NO_WOUND_VISIT: complete notes read
    if (pre.skip !== "need-more") { why("tetanus: " + pre.skip); return null; }
    const links: Array<{ t: string; h: string[] }> = [];
    const docs = await readAllDocuments(crawler, p.id, links); if (!docs) return null;
    let outsideDoses: string[][] | undefined;
    if (docs.some(isOutside)) { outsideDoses = (await readOutside(crawler, docs, links, rule)) ?? undefined; if (!outsideDoses) return null; }
    const imms = await readAllImmunizations(crawler, p.id); if (!imms) return null;
    const ctx = buildTetanusContext({ visitISO, notes, notesComplete: true, imms, immsComplete: true, docs, docsComplete: true, outsideDoses }, rule);
    if (isSkip(ctx)) { why("tetanus: " + ctx.skip); return null; }
    return ctx;
  };
}

const isOutside = (d: Doc) => /immuni[sz]ation record/i.test(d.kind) || /^immuni[sz]ation record/i.test(d.title);
/** Each outside Immunization record's viewer href, by its title in the documents table rows (one row per
 *  document; a title filed twice must give as many distinct hrefs). null → can't tie rows to links. */
export function outsideHrefs(docs: Doc[], links: Array<{ t: string; h: string[] }>): string[] | null {
  const out: string[] = [];
  const outs = docs.filter(isOutside);
  for (const title of [...new Set(outs.map((d) => d.title))]) {
    const want = outs.filter((d) => d.title === title).length;
    const hs = [...new Set(links.filter((l) => l.t.includes(title)).flatMap((l) => l.h.length === 1 ? l.h : []))];
    if (hs.length !== want || links.filter((l) => l.t.includes(title)).length !== want) return null;
    out.push(...hs);
  }
  return out.length === outs.length ? out : null;
}
/** Read every outside Immunization record (image → tesseract ∥ model, outsideImmRead.ts). Logs a
 *  doc_probe line per record (viewer text, image, every reader's output) so the run log carries the
 *  real documents. AGENT_TETANUS_OUTSIDE=0 → capture only, then decline as before. */
let docProbes = 0;
async function readOutside(c: Crawler, docs: Doc[], links: Array<{ t: string; h: string[] }>, rule: TetanusRule): Promise<string[][] | null> {
  const hrefs = outsideHrefs(docs, links);
  if (!hrefs) { why("tetanus: outside Immunization record: viewer link not tied to its row"); return null; }
  const { readOutsideRecord } = await import("./outsideImmRead.js");
  const all: string[][] = [];
  for (const href of hrefs) {
    const png = (await c.fetchDocImage(href).catch(() => null)) || (await c.captureDoc(href).catch(() => null));
    const viewer = (await c.decodedText().catch(() => "")).slice(0, 3000);
    const html = (await c.evalApp<string>(`return (doc.body&&doc.body.outerHTML)||''`).catch(() => "")).slice(0, 20000);
    const trace: Record<string, unknown> = {};
    const multi = viewer.match(/Page\s+\d+\s+of\s+(\d+)/i);
    let res: string[] | { skip: string } = { skip: "image not captured" };
    if (png && multi && +multi[1] > 1) res = { skip: `record has ${multi[1]} pages` };
    else if (png && process.env.AGENT_TETANUS_OUTSIDE !== "0") res = await readOutsideRecord(png, rule, {}, trace);
    else if (png) res = { skip: "outside-record reading disabled (AGENT_TETANUS_OUTSIDE=0)" };
    // capture capped: page HTML + image only for the first DOC_PROBE_MAX (6) records, image < 600 kB, none when behind
    const { pacer } = await import("./pacer.js");
    const full = docProbes < Number(process.env.DOC_PROBE_MAX ?? 6) && pacer.probeOk(); if (full) docProbes++;
    try { process.stdout.write(JSON.stringify({ event: "doc_probe", family: "tetanus-wound", href, viewer: viewer.slice(0, full ? 3000 : 600), html: full ? html : "", png: full && png && png.length < 600_000 ? png : null, pngLen: png?.length ?? 0, result: res, trace }) + "\n"); } catch {}
    if (isSkip(res)) { why("tetanus: outside Immunization record: " + res.skip); return null; }
    all.push(res);
  }
  return all;
}

/** Vaccine-lot recall has no reader yet: no capture of the clinic's lots/inventory page exists (the
 *  Set 1 sitemap lists /vaccines, no recon dumped it). On the FIRST recall task of a shift, dump that
 *  section's structure (decoded text, table captions/headers, form labels, links; one lot-detail
 *  exemplar) to stdout so the run log carries the layout a reader needs. Read-only; always null (skip). */
let probed = false;
export async function probeVaccines(c: Crawler): Promise<null> {
  if (probed) { why("recall: no vaccine-lot reader yet (layout probe already logged this shift)"); return null; }
  probed = true;
  const dump = async (tag: string) => {
    const shape = await c.evalApp<any>(`const T=e=>((e&&e.innerText)||'').trim().replace(/\\s+/g,' ');
      return { url: location.pathname+location.search, h: [...doc.querySelectorAll('h1,h2,h3')].map(T).slice(0,12),
        tables: [...doc.querySelectorAll('table')].map(t=>({cap:T(t.querySelector('caption')), headers:[...t.querySelectorAll('thead th')].map(T), rows:t.querySelectorAll('tbody tr').length})),
        labels: [...doc.querySelectorAll('label')].map(T).slice(0,20), links: [...doc.querySelectorAll('a[href^="/"]')].map(a=>a.getAttribute('href')).filter(h=>!/^\\/patients\\//.test(h||'')).slice(0,40) }`).catch(() => null);
    const text = (await c.decodedText().catch(() => "")).slice(0, 3500);
    try { process.stdout.write(JSON.stringify({ event: "probe", page: tag, shape, text }) + "\n"); } catch {}
    return shape;
  };
  // the section is found by its navigation label; the sitemap's /vaccines is the fallback
  const nav = await c.evalApp<string>(`const a=[...doc.querySelectorAll('nav a[href],aside a[href]')].find(x=>/vaccin|immuni[sz]ation|inventory|\\blots?\\b/i.test(x.textContent||'')&&!/\\/patients\\//.test(x.getAttribute('href')||'')); return a?a.getAttribute('href'):''`).catch(() => "");
  for (const href of [...new Set([nav, "/vaccines"].filter(Boolean))]) {
    if (!(await c.navTo(href, /lot|vaccin|inventory/i, 6000).catch(() => false))) continue;
    const shape = await dump("vaccines");
    const lotLink = ((shape?.links ?? []) as string[]).find((h) => /lot|vaccin/i.test(h) && h !== href && /\d/.test(h));
    if (lotLink && (await c.navTo(lotLink, /lot/i, 6000).catch(() => false))) await dump("vaccine-lot-detail");
    break;
  }
  why("recall: no vaccine-lot reader yet (layout probe logged)");
  return null;
}
