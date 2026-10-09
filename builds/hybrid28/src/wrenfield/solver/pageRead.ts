/**
 * One structural reading of a Wrenfield page, by labels only (never class names — they are random per
 * session — and never column positions). Same pattern as operate.ts: `PAGE_READ_LIB` is plain browser JS;
 * the live crawler runs it in the app iframe (Crawler.evalApp) and tests/the site-model builder run it on
 * jsdom documents of the recon dumps.
 *
 * Output (`PageRead`): the page heading, every visible table with its caption / aria-label / nearest
 * heading, header labels and cell text + links; every <dl> as label → value pairs; the count footers
 * ("Showing a to b of N …", "20 claims", "No more results"); the pager (Next present/disabled) and
 * Show-more controls; tabs; labelled filter controls; gates; image documents (img / canvas / embed /
 * iframe / object / links to the /v/ viewer).
 *
 * Notes, messages and other free text are NOT interpreted here: callers get the cell text only.
 */
import { OPERATE_LIB } from "../operate.js";

export const PAGE_READ_LIB = String.raw`
function pageRead(doc){
  const view=doc.defaultView||window;
  const STD=/^(Atkinson|ui-|system-ui|-apple-system|monospace|sans-serif|serif|Arial|Helvetica|Inter|Roboto|Segoe|Times|Georgia|Courier)/i;
  const famOf=el=>{ try{ return (view.getComputedStyle(el).fontFamily||'').split(',')[0].replace(/["']/g,'').trim(); }catch(e){ return ''; } };
  const baseFam=doc.body?famOf(doc.body):''; const fams={};
  // digits drawn in a custom (possibly scrambled) font: the text segments with their family, else null
  const segsOf=el=>{ const out=[]; let custom=false; const w=doc.createTreeWalker(el,4); for(let n=w.nextNode();n;n=w.nextNode()){ const t=n.nodeValue; if(!t) continue; const p=n.parentElement; if(p&&hidden(p)) continue; const f=p?famOf(p):''; const c=(/[0-9]/.test(t)&&f&&f!==baseFam&&!STD.test(f))?f:null; if(c){ custom=true; fams[c]=1; } out.push([t,c]); } return custom?out:undefined; };
  const main=doc.querySelector('main')||doc.body;
  const HS=[...main.querySelectorAll('h1,h2,h3,h4')].filter(h=>!hidden(h));
  const H=e=>{ let best=''; for(const h of HS){ if(h.compareDocumentPosition(e)&4) best=TX(h); else break; } return best; };
  const regionOf=e=>{ const r=e.closest('section[aria-label],[role=region][aria-label],section[aria-labelledby],[role=region][aria-labelledby],[role=group][aria-label]'); return r?accName(r):''; };
  const NOUN='(?:claims?|remittances?|appointments?|documents?|invoices?|patients?|entry|entries|results?|notes?|immunizations?|lots?|records?|items?|payers?|plans?|encounters?|orders?|problems?|events?|rows?|visits?|vaccines?|statements?|referrals?|reports?|changes?|providers?|closures?|allergies|allergy|authorizations?|submissions?|lines?|dates?)';
  const re1=new RegExp('Showing\\s+[\\d,]+\\s*(?:to|–|-)\\s*[\\d,]+\\s+of\\s+(?:about\\s+)?[\\d,]+\\+?\\s*'+NOUN+'|Showing\\s+[\\d,]+\\s+of\\s+(?:about\\s+)?[\\d,]+\\+?\\s*'+NOUN+'|No more results|No [a-z ]+? (?:found|yet|on file|on record|recorded|in this chart|on this account)(?: for this [a-z]+)?','gi');
  const re2=new RegExp('(?<![\\d,.$])(?:about\\s+)?\\d[\\d,]*\\s+'+NOUN+'(?![a-z])','g');
  const isFoot=t=>t.length<90&&(new RegExp('^(?:'+re1.source+')$','i').test(t)||new RegExp('^(?:'+re2.source+')$').test(t));
  const near=(t)=>{ let foot='',next=null,more=null; for(let a=t.parentElement,k=0;a&&k<4&&a!==doc.body;a=a.parentElement,k++){
      if(a.querySelectorAll('table').length>1) break;
      if(!foot){ for(const e of a.querySelectorAll('p,[aria-live],[role=status],span,div')){ if(hidden(e)||!(t.compareDocumentPosition(e)&4)||e.querySelector('table,p,div')) continue; const x=TX(e); if(isFoot(x)){ foot=x; break; } } }
      for(const bt of a.querySelectorAll('button,a[role=button]')){ if(hidden(bt)||bt.closest('form')) continue; const nm=accName(bt);
        if(!next&&(/^next(\s+page)?$/i.test(nm))) next={present:true,disabled:!!bt.disabled||bt.getAttribute('aria-disabled')==='true'};
        if(!more&&/^(show|load|see|view) (more|all)\b/i.test(nm)) more={present:true,disabled:!!bt.disabled||bt.getAttribute('aria-disabled')==='true',name:nm}; }
    } return {foot,next:next||{present:false,disabled:false},more:more||{present:false,disabled:false,name:''}}; };
  const tables=[...main.querySelectorAll('table')].filter(t=>!hidden(t)).map(t=>{
    const hr=t.querySelector('thead tr')||[...t.querySelectorAll('tr')].find(r=>r.querySelector('th'));
    const headers=hr?[...hr.children].map(c=>TX(c).replace(/\s*,\s*(newest|oldest|largest|smallest|earliest|latest)[^]*$/i,'').trim()):[];
    const trs=[...t.querySelectorAll('tr')].filter(r=>r!==hr&&!hidden(r)&&!(r.parentElement&&r.parentElement.tagName==='THEAD'));
    const rows=trs.map(tr=>[...tr.children].map(td=>({text:TX(td),segs:segsOf(td),links:[...td.querySelectorAll('a[href]')].map(a=>({href:a.getAttribute('href')||'',text:TX(a),label:a.getAttribute('aria-label')||''}))})));
    return {caption:TX(t.querySelector('caption')),label:accName(t)||t.getAttribute('aria-label')||'',heading:H(t),region:regionOf(t),headers,rows,...near(t)};
  });
  const dls=[...main.querySelectorAll('dl')].filter(d=>!hidden(d)).map(d=>{ const pairs=[]; let k=null; for(const c of d.querySelectorAll('dt,dd')){ if(c.tagName==='DT') k=TX(c); else if(k!=null){ const sg=segsOf(c); pairs.push(sg?[k,TX(c),sg]:[k,TX(c)]); } } return {heading:H(d),region:regionOf(d),pairs}; });
  const body=TX(main);
  const footers=[]; let m;
  while((m=re1.exec(body))&&footers.length<20) footers.push(m[0].trim());
  const sh=footers.join(' ');
  while((m=re2.exec(body))&&footers.length<24){ const f=m[0].trim(); if(!sh.includes(f)) footers.push(f); }
  const btns=[...main.querySelectorAll('button,a[role=button]')].filter(b=>!hidden(b));
  const nb=btns.find(b=>/^next(\s+page)?$/i.test(TX(b))||/^next page$/i.test(b.getAttribute('aria-label')||''));
  const mb=btns.filter(b=>/^(show|load|see|view) (more|all)\b/i.test(accName(b)));
  const inv=inventory(doc);
  const images=[];
  for(const i of main.querySelectorAll('img')) if(!hidden(i)) images.push({kind:'img',src:(i.getAttribute('src')||'').slice(0,80),alt:i.getAttribute('alt')||''});
  for(const i of main.querySelectorAll('canvas,embed,object,iframe')) if(!hidden(i)) images.push({kind:i.tagName.toLowerCase(),src:(i.getAttribute('src')||i.getAttribute('data')||'').slice(0,80),alt:accName(i)});
  for(const a of main.querySelectorAll('a[href^="/v/"]')) images.push({kind:'viewer-link',src:a.getAttribute('href'),alt:TX(a)});
  return {h1:TX(main.querySelector('h1'))||inv.h1,headings:[...main.querySelectorAll('h1,h2,h3,h4')].filter(h=>!hidden(h)).map(TX).slice(0,40),
    tables,dls,footers,next:{present:!!nb,disabled:!!nb&&(nb.disabled||nb.getAttribute('aria-disabled')==='true')},
    more:mb.map(b=>({name:accName(b),disabled:!!b.disabled||b.getAttribute('aria-disabled')==='true'})),
    pager:inv.pager,tabs:inv.tabs,forms:inv.forms,fields:inv.fields,gates:inv.gates,images,
    families:Object.keys(fams),noMore:/No more results/i.test(body),loading:/Loading Wrenfield|Loading…|Loading\.\.\./i.test(body)};
}`;

/** segs: present only when digits in the cell are drawn in a custom font: [text, family|null] pieces to decode */
export type Seg = [string, string | null];
export type Cell = { text: string; segs?: Seg[]; links: Array<{ href: string; text: string; label: string }> };
export type TableRead = { caption: string; label: string; heading: string; region: string; headers: string[]; rows: Cell[][];
  /** the count footer and pager controls that belong to THIS table (same container, after it) */
  foot: string; next: { present: boolean; disabled: boolean }; more: { present: boolean; disabled: boolean; name: string } };
export type DlRead = { heading: string; region: string; pairs: Array<[string, string] | [string, string, Seg[]]> };
export type FormRead = { name: string; method: string; action: string; fields: Array<{ label: string; kind: string; name?: string; options?: string[] }>; submit: string[] };
export type PageRead = {
  h1: string; headings: string[]; tables: TableRead[]; dls: DlRead[]; footers: string[];
  next: { present: boolean; disabled: boolean }; more: Array<{ name: string; disabled: boolean }>;
  pager: { from: number; to: number; total: number; approx: boolean } | null;
  tabs: Array<{ name: string; selected: string | null; href?: string }>;
  forms: FormRead[]; fields: Array<{ label: string; kind: string; options?: string[] }>;
  gates: string[]; images: Array<{ kind: string; src: string; alt: string }>; noMore: boolean; loading: boolean;
  /** custom font families that draw digits on this page (decode with Crawler.familyDigitMaps or decline) */
  families: string[];
};

/** Browser body for Crawler.evalApp (`doc` = the app document). */
export const PAGE_READ_JS = `${OPERATE_LIB}\n${PAGE_READ_LIB}\nreturn pageRead(doc);`;

/** Same reading on a jsdom (or any DOM) document. */
export function pageReadOn(doc: Document): PageRead {
  // eslint-disable-next-line no-new-func
  return new Function("doc", `${OPERATE_LIB}\n${PAGE_READ_LIB}\nreturn pageRead(doc);`)(doc) as PageRead;
}

/** Recon-dump sections (same split as bench/fixture-inventory.ts): head line, nav url, captured HTML. */
export function dumpSections(raw: string): Array<{ head: string; url: string; html: string; truncated: boolean }> {
  const out: Array<{ head: string; url: string; html: string; truncated: boolean }> = [];
  for (const p of raw.split(/^(?=@@@@ |==== )/m)) {
    const head = p.split("\n")[0].replace(/@@@@/g, "").replace(/^====\s*/, "").replace(/\s*====\s*$/, "").trim();
    const i = p.indexOf("---- HTML ----"); if (i < 0) continue;
    let html = p.slice(i + 15); const j = html.search(/^---- [A-Z]/m); if (j > 0) html = html.slice(0, j);
    const url = (head.match(/(?:nav|::)\s+(\/[^\s()]*)/) || head.match(/(\/[^\s()]+)/) || ["", ""])[1];
    // recon dumps cap a page's HTML at 14,000 characters: a capped page proves nothing about paging/footers
    out.push({ head, url, html, truncated: !/<\/body>/i.test(html) });
  }
  return out;
}
