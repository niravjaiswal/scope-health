/**
 * Operate a page's controls by their accessible names (never by class names or positions — classes are
 * randomised per session). Generic infrastructure for "next-state blockers": data reachable only by pressing
 * a button, setting a filter, expanding "Show more", opening a tab or passing a gate.
 *
 * One implementation, two hosts: `OPERATE_LIB` is plain browser JS defining functions over `doc`; the live
 * crawler runs it inside the app iframe (Crawler.evalApp) and the tests run it against jsdom documents.
 *
 * Safety rules (every one ends in a refusal with a `why`, never a guess):
 *  - A control is found by its accessible name (aria-label, aria-labelledby, <label>, text, title); 0 or ≥ 2
 *    matches is a refusal.
 *  - Controls whose name says they CHANGE the clinic's records (save, delete, cancel, submit claim, send, pay,
 *    sign, merge, void, write off, mark …) are refused unless the caller names them in `allowWrite`.
 *    Gates ("Request access", "Break the glass") are refused here: unlocking goes through Crawler.breakGlass
 *    (AGENT_BREAK_GLASS policy, glassPolicy.ts) and nowhere else.
 *  - A select option is chosen by exact (normalised) visible text or value; no fuzzy option picking.
 *  - "Show more" expansion is complete only when the rows read equal a stated total, or the control is gone
 *    AND a total was stated and matches. Anything else is reported as unproven.
 */
import type { Crawler } from "./crawl.js";
import { LIST_FOOTER_JS, type FooterKind } from "./listFooter.js";

// The list-footer grammar is the shared one (listFooter.ts): the same source the TypeScript readers run.
export const OPERATE_LIB = LIST_FOOTER_JS + String.raw`
const N=s=>String(s||'').normalize('NFKD').replace(/[̀-ͯ]/g,'').replace(/\s+/g,' ').trim().toLowerCase();
const TX=e=>String((e&&(e.innerText!=null&&e.innerText!==''?e.innerText:e.textContent))||'').replace(/\s+/g,' ').trim();
const hidden=e=>{ for(let x=e;x&&x.nodeType===1;x=x.parentElement){ if(x.hidden||x.getAttribute('aria-hidden')==='true'||x.inert) return true; if(x.tagName==='DETAILS'&&!x.open&&x!==e&&!(e.tagName==='SUMMARY'&&e.parentElement===x)) return true; } return false; };
const accName=e=>{
  const al=e.getAttribute('aria-label'); if(al&&al.trim()) return al.trim();
  const lb=e.getAttribute('aria-labelledby'); if(lb){ const t=lb.split(/\s+/).map(id=>e.ownerDocument.getElementById(id)).filter(Boolean).map(TX).join(' ').trim(); if(t) return t; }
  if(e.id){ const l=e.ownerDocument.querySelector('label[for="'+e.id.replace(/"/g,'\\"')+'"]'); if(l&&TX(l)) return TX(l); }
  const wrap=e.closest&&e.closest('label'); if(wrap){ const c=wrap.cloneNode(true); c.querySelectorAll('input,select,textarea').forEach(x=>x.remove()); if(TX(c)) return TX(c); }
  if(/^(BUTTON|A|SUMMARY)$/.test(e.tagName)||/^(button|tab|link|menuitem)$/.test(e.getAttribute('role')||'')){ const t=TX(e); if(t) return t; }
  if(e.tagName==='INPUT'&&/^(submit|button|reset)$/i.test(e.type)&&e.value) return e.value;
  return (e.getAttribute('title')||e.getAttribute('placeholder')||e.getAttribute('name')||'').trim();
};
const WRITE=/\b(save|delete|remove|cancel|submit claim|resubmit|send|pay|post|sign|merge|void|write[- ]?off|archive|mark|approve|deny|reschedule|book|check[- ]?in|check[- ]?out|discharge|upload|import|reset|log ?out|sign ?out|confirm|update|edit|create|add|new)\b/i;
const GATE=/\b(request access|break (the )?glass|emergency access|override)\b/i;
const CLICKABLE='button,[role=button],[role=tab],summary,input[type=submit],input[type=button],a[role=button],[aria-expanded]';
function findByName(doc,sel,name,exact){
  const want=N(name); const all=[...doc.querySelectorAll(sel)].filter(e=>!hidden(e));
  let hits=all.filter(e=>N(accName(e))===want);
  if(!hits.length&&!exact) hits=all.filter(e=>{ const n=N(accName(e)); return n&&(n.startsWith(want+' ')||n.endsWith(' '+want)); });
  return hits;
}
function rowsOf(doc){ return [...doc.querySelectorAll('table tbody tr,[role=row]')].filter(r=>!hidden(r)&&!r.querySelector('th')).length; }
function pagerOf(doc){
  // listFooter (shared grammar) over the page text; approx is true for a bound ("500+") as well as an estimate ("about N"):
  // neither total can be reached, so neither proves an end
  const f=listFooter(TX(doc.body)); if(!f||f.none||f.page!==undefined) return null;
  return {from:f.from,to:f.to<0?0:f.to,total:f.total,approx:f.kind!=='exact',kind:f.kind,cumulative:f.cumulative,text:f.text};
}
function inventory(doc){
  const out={title:doc.title||'',h1:TX(doc.querySelector('main h1,h1,h2')).slice(0,80),buttons:[],forms:[],fields:[],details:[],dialogs:[],tabs:[],toggles:[],pager:pagerOf(doc),more:[],gates:[],links:[]};
  const main=doc.querySelector('main')||doc.body;
  for(const b of main.querySelectorAll('button,[role=button],input[type=submit],input[type=button]')){ if(hidden(b)) continue; const nm=accName(b); out.buttons.push({name:nm.slice(0,60),form:!!b.closest('form'),expanded:b.getAttribute('aria-expanded'),controls:b.getAttribute('aria-controls')||undefined,disabled:!!b.disabled||b.getAttribute('aria-disabled')==='true',write:WRITE.test(nm)||undefined,gate:GATE.test(nm)||undefined}); if(/\b(show|load|view) (more|all)\b|\bmore results\b/i.test(nm)) out.more.push(nm); }
  for(const f of main.querySelectorAll('form')){ if(hidden(f)) continue; out.forms.push({name:(f.getAttribute('aria-label')||TX(f.querySelector('legend,h2,h3'))||'').slice(0,60),method:(f.getAttribute('method')||'get').toLowerCase(),action:f.getAttribute('action')||'',fields:[...f.querySelectorAll('input,select,textarea')].filter(e=>e.type!=='hidden'&&!hidden(e)).map(e=>({label:accName(e).slice(0,50),kind:e.tagName==='SELECT'?'select':(e.type||e.tagName.toLowerCase()),name:e.name||undefined,options:e.tagName==='SELECT'?[...e.options].map(o=>TX(o)).slice(0,25):undefined})),submit:[...f.querySelectorAll('button,input[type=submit]')].map(accName).slice(0,6)}); }
  for(const e of main.querySelectorAll('input,select,textarea')){ if(e.type==='hidden'||hidden(e)||e.closest('form')) continue; out.fields.push({label:accName(e).slice(0,50),kind:e.tagName==='SELECT'?'select':(e.type||'text'),options:e.tagName==='SELECT'?[...e.options].map(o=>TX(o)).slice(0,25):undefined}); }
  for(const d of main.querySelectorAll('details')) out.details.push({summary:TX(d.querySelector('summary')).slice(0,60),open:d.open});
  for(const d of doc.querySelectorAll('dialog,[role=dialog],[role=alertdialog]')) out.dialogs.push({name:accName(d).slice(0,60),open:d.tagName==='DIALOG'?d.open:!hidden(d)});
  for(const t of main.querySelectorAll('[role=tab]')) out.tabs.push({name:accName(t).slice(0,40),selected:t.getAttribute('aria-selected'),href:t.getAttribute('href')||undefined});
  for(const t of main.querySelectorAll('[aria-expanded]')) if(!/^BUTTON$/.test(t.tagName)) out.toggles.push({name:accName(t).slice(0,50),expanded:t.getAttribute('aria-expanded')});
  const body=TX(main); const g=body.match(/this chart is restricted|give a reason to open it|break the glass/i); if(g) out.gates.push(g[0]);
  const nav=[...main.querySelectorAll('nav[aria-label*=agin i],[aria-label*=pagination i]')]; if(nav.length) out.pagerNav=nav.map(TX).map(s=>s.slice(0,80));
  out.links=[...doc.querySelectorAll('a[href]')].map(a=>a.getAttribute('href')).filter(h=>h&&h.startsWith('/'));
  return out;
}
function press(doc,name,opts){
  opts=opts||{};
  const hits=findByName(doc,CLICKABLE,name,!!opts.exact);
  if(hits.length!==1) return {ok:false,why:hits.length?('"'+name+'": '+hits.length+' controls carry this name ('+hits.map(accName).slice(0,4).join(' | ')+')'):('"'+name+'": no visible control with this name')};
  const el=hits[0]; const nm=accName(el);
  if(GATE.test(nm)) return {ok:false,why:'"'+nm+'" opens an access gate: only Crawler.breakGlass may press it (AGENT_BREAK_GLASS)'};
  if(WRITE.test(nm)&&!(opts.allowWrite||[]).some(a=>N(a)===N(nm))) return {ok:false,why:'"'+nm+'" may change the clinic\'s records; not pressed'};
  if(el.disabled||el.getAttribute('aria-disabled')==='true') return {ok:false,why:'"'+nm+'" is disabled'};
  if(el.tagName==='SUMMARY'){ el.parentElement.open=true; return {ok:true,name:nm,kind:'details'}; }
  el.click(); return {ok:true,name:nm,kind:el.getAttribute('role')||el.tagName.toLowerCase()};
}
function setField(doc,label,value){
  const hits=findByName(doc,'input:not([type=hidden]),select,textarea',label,true);
  if(hits.length!==1) return {ok:false,why:'field "'+label+'": '+(hits.length?hits.length+' fields carry this label':'no visible field with this label')};
  const el=hits[0]; const W=(doc.defaultView||window);
  if(el.tagName==='SELECT'){
    const opt=[...el.options].filter(o=>N(TX(o))===N(value)||N(o.value)===N(value));
    if(opt.length!==1) return {ok:false,why:'field "'+label+'": '+(opt.length?'several options':'no option')+' "'+value+'" (options: '+[...el.options].map(o=>TX(o)).slice(0,12).join(' | ')+')'};
    Object.getOwnPropertyDescriptor(W.HTMLSelectElement.prototype,'value').set.call(el,opt[0].value);
  } else if(/^(checkbox|radio)$/i.test(el.type)){
    const want=/^(1|true|yes|on|checked)$/i.test(String(value)); if(el.checked!==want) el.click(); return {ok:true,label:accName(el),value:String(el.checked)};
  } else {
    const proto=el.tagName==='TEXTAREA'?W.HTMLTextAreaElement.prototype:W.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto,'value').set.call(el,String(value));
  }
  el.dispatchEvent(new W.Event('input',{bubbles:true})); el.dispatchEvent(new W.Event('change',{bubbles:true}));
  return {ok:true,label:accName(el),value:el.value};
}
function submitNear(doc,label,name){
  const hits=findByName(doc,'input:not([type=hidden]),select,textarea',label,true);
  if(hits.length!==1) return {ok:false,why:'field "'+label+'" not unique'};
  const f=hits[0].closest('form'); if(!f) return {ok:false,why:'field "'+label+'" is not in a form'};
  if((f.getAttribute('method')||'get').toLowerCase()!=='get') return {ok:false,why:'form of "'+label+'" is method='+f.getAttribute('method')+' (may write)'};
  const btns=[...f.querySelectorAll('button,input[type=submit]')].filter(b=>!hidden(b)&&(!name||N(accName(b))===N(name)));
  if(btns.length!==1) return {ok:false,why:'form of "'+label+'": '+btns.length+' submit controls'+(name?' named "'+name+'"':'')};
  const nm=accName(btns[0]); if(GATE.test(nm)) return {ok:false,why:'"'+nm+'" opens an access gate'};
  btns[0].click(); return {ok:true,name:nm};
}
`;

/** Runs `call` (an expression over OPERATE_LIB's functions and `doc`) against a document (jsdom in tests). */
export function runOn<T>(doc: Document, call: string): T {
  // eslint-disable-next-line no-new-func
  return new Function("doc", `${OPERATE_LIB}\nreturn (${call});`)(doc) as T;
}
/** The control inventory as an evalApp body (Crawler.evalApp wraps it with `doc` = the app document). */
export const CONTROL_INVENTORY_JS = `${OPERATE_LIB}\nreturn inventory(doc);`;

export type Pressed = { ok: true; name: string; kind: string } | { ok: false; why: string };
export type Pager = { from: number; to: number; total: number; approx: boolean; kind: FooterKind; cumulative: boolean; text: string } | null;

/** Live wrapper: operate controls on the crawler's current page and wait for the page to change. */
export class Operator {
  constructor(private c: Crawler) {}
  private lib<T>(call: string) { return this.c.evalApp<T>(`${OPERATE_LIB}\nreturn (${call});`); }
  inventory() { return this.lib<any>("inventory(doc)"); }
  pager() { return this.lib<Pager>("pagerOf(doc)"); }
  rows() { return this.lib<number>("rowsOf(doc)"); }
  /** Wait until the app text differs from `before` (or `until` matches), up to `ms`. */
  private async changed(before: string, ms: number, until?: RegExp): Promise<boolean> {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const t = await this.c.appText().catch(() => ""); if (t && (until ? until.test(t) : t !== before)) return true; await new Promise((r) => setTimeout(r, 60)); }
    return false;
  }
  /** Press the one visible control with this accessible name; ok only when the page then changed. */
  async press(name: string, opts: { exact?: boolean; allowWrite?: string[]; until?: RegExp; timeoutMs?: number } = {}): Promise<Pressed> {
    const before = await this.c.appText().catch(() => "");
    const r = await this.lib<Pressed>(`press(doc, ${JSON.stringify(name)}, ${JSON.stringify({ exact: opts.exact, allowWrite: opts.allowWrite })})`).catch((e) => ({ ok: false as const, why: String(e).slice(0, 120) }));
    this.c.trace({ act: r.ok ? "press" : "refuse", what: name, ...(r.ok ? {} : { why: r.why }) });
    if (!r.ok) return r;
    return (await this.changed(before, opts.timeoutMs ?? 5000, opts.until)) ? r : { ok: false, why: `"${name}" pressed but the page did not change` };
  }
  /** Set a filter/field by its label (select: exact option text or value). */
  async set(label: string, value: string): Promise<{ ok: boolean; why?: string }> {
    const r = await this.lib<{ ok: boolean; why?: string }>(`setField(doc, ${JSON.stringify(label)}, ${JSON.stringify(value)})`).catch((e) => ({ ok: false, why: String(e).slice(0, 120) }));
    this.c.trace({ act: r.ok ? "set" : "refuse", what: label, value, ...(r.ok ? {} : { why: r.why }) });
    return r;
  }
  /** Submit the GET form that holds `label` (never a POST form) and wait for the page to change. */
  async submit(label: string, button?: string, timeoutMs = 6000): Promise<{ ok: boolean; why?: string }> {
    const before = await this.c.appText().catch(() => "");
    const r = await this.lib<{ ok: boolean; why?: string }>(`submitNear(doc, ${JSON.stringify(label)}, ${JSON.stringify(button ?? "")})`).catch((e) => ({ ok: false, why: String(e).slice(0, 120) }));
    if (!r.ok) return r;
    return (await this.changed(before, timeoutMs)) ? r : { ok: false, why: `form of "${label}" submitted but the page did not change` };
  }
  /** Open a gated chart only through the crawler's policy-checked unlock. */
  async openGate(): Promise<{ ok: boolean; why?: string }> {
    if (!(await this.c.gatedNow())) return { ok: true };
    return (await this.c.breakGlass()) ? { ok: true } : { ok: false, why: "gate not opened (AGENT_BREAK_GLASS policy or unlock failed)" };
  }
  /** Press "Show more" (by name) until the stated total is reached. Complete only when a total is stated and
   *  the rows read equal it; `maxPresses` and `deadline` bound the work. */
  async expandAll(name = "Show more", maxPresses = 40, deadline = Date.now() + 20000): Promise<{ complete: boolean; rows: number; total: number | null; presses: number; why?: string }> {
    let presses = 0;
    for (;;) {
      const [p, rows] = [await this.pager(), await this.rows()];
      const total = p && !p.approx ? p.total : null;
      if (total != null && rows === total) return { complete: true, rows, total, presses };
      if (total != null && rows > total) return { complete: false, rows, total, presses, why: `read ${rows} rows but the page states ${total}` };
      if (presses >= maxPresses || Date.now() > deadline) return { complete: false, rows, total, presses, why: "press budget / deadline reached" };
      const r = await this.press(name, { exact: true, until: undefined, timeoutMs: 5000 });
      if (!r.ok) return { complete: false, rows, total, presses, why: total == null ? `no stated total (${p?.approx ? "approximate" : "none"}); ${r.why}` : r.why };
      presses++;
    }
  }
}
