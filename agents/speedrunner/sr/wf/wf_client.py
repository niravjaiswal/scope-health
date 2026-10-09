"""wf_client.py - fast, robust programmatic reader for the Wrenfield clinic web app (async Playwright).

Design (see .claude/docs/10-wrenfield-sitemap.md):
  * Every Wrenfield page = shell document (nav, location switcher, <main>) whose main content is loaded by an
    app POST (needs a layout fingerprint -> real browser) into an <iframe src="/v/<rand>/"> (single-use URL).
    Some pages nest a second iframe (appointment list, document viewer).
  * Fastest robust navigation: keep ONE shell page loaded and switch pages through the app's own popstate
    handler (history.pushState(path) + PopStateEvent) -> 1 POST + 1 iframe GET (~0.2 s vs ~0.4 s for goto).
  * Text extraction walks the rendered DOM of all frames (computed styles, so randomized class names don't
    matter), skips invisible / sr-only / display:none text, renders tables as ' | ' rows with link targets,
    <dl> as 'term: value', and DECODES the per-load scrambled identifier font (see wf_font.py).

Usage:
    async with WrenfieldClient(base_url, user, pw) as wf:
        print(await wf.get_text("/patients?lastName=Murphy"))
        rows = await wf.search_patients(last_name="Murphy")
        chart = await wf.open_chart(rows[0]["href"])          # {'demographics': text, 'insurance': text, ...}
        await wf.set_location("Front Range")
        await wf.click_by_text("Next")
Concurrency: `async with wf.tab() as t:` gives an extra tab (same session/cookies/location!) with the same API.
"""
from __future__ import annotations

import asyncio
import base64
import contextlib
import os
import re
import sys
import time
from typing import Any, Dict, List, Optional
from urllib.parse import quote, urljoin, urlparse

from playwright.async_api import async_playwright, Browser, BrowserContext, Page, Frame

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from .wf_font import FontDecoder  # noqa: E402

# --------------------------------------------------------------------------------------------------------
# In-page JavaScript
# --------------------------------------------------------------------------------------------------------

# true when every same-origin document (shell + nested iframes) is fully initialised and idle
READY_JS = r"""
() => {
  const loadingRe = /^\s*(loading|please wait)\b/i;
  function vis(el){ const r = el.getBoundingClientRect(); return r.width>0 && r.height>0; }
  function ok(doc){
    if(!doc || doc.readyState==='loading' || !doc.body) return false;
    if(doc.body.hasAttribute('inert') || doc.documentElement.hasAttribute('aria-busy')) return false;
    for (const s of doc.querySelectorAll('[role=status],[aria-busy=true]')) {
      if (s.getAttribute('aria-busy')==='true' && vis(s)) return false;
      if (!s.hidden && vis(s) && loadingRe.test(s.textContent||'')) return false;
    }
    for (const f of doc.querySelectorAll('iframe')) {
      let d; try { d = f.contentDocument } catch(e) { continue }
      if(!d || !f.contentWindow || f.contentWindow.location.href==='about:blank') return false;
      if(!ok(d)) return false;
    }
    return true;
  }
  return ok(document);
}
"""

# signature of the current content: URLs of all /v/ frames (they change on every content load)
FRAMESIG_JS = r"""
() => { const out=[]; (function w(doc){ for (const f of doc.querySelectorAll('iframe')) { try { out.push(f.contentWindow.location.href); w(f.contentDocument) } catch(e){} } })(document);
  const m = document.querySelector('main') || document.body; out.push(String(m ? m.innerHTML.length : 0)); return out.join(' '); }
"""

# collect @font-face (family -> url) used in all frames; fetch bytes (browser cache) of the ones not yet known
FONTS_JS = r"""
async (known) => {
  const faces = {}; const want = new Set();
  function collect(doc){
    const used = new Set();
    try { doc.body && doc.body.getBoundingClientRect(); } catch(e) {}
    try { for (const ff of doc.fonts) { if (ff.status !== 'unloaded') used.add(ff.family.replace(/^["']|["']$/g,'')); } } catch(e) {}
    for (const ss of doc.styleSheets) {
      let rules; try { rules = ss.cssRules } catch(e) { continue }
      const stack = [...rules];
      while (stack.length) {
        const r = stack.shift();
        if (r.cssRules) { stack.push(...r.cssRules); }
        if (r.type === 5 || (typeof CSSFontFaceRule!=='undefined' && r instanceof doc.defaultView.CSSFontFaceRule)) {
          const fam = (r.style.getPropertyValue('font-family')||'').trim().replace(/^["']|["']$/g,'');
          const m = /url\(\s*["']?([^"')]+)["']?\s*\)/.exec(r.style.getPropertyValue('src')||'');
          if (!fam || !m) continue;
          const url = new URL(m[1], ss.href || doc.baseURI).href;
          faces[fam] = url;
          if (used.has(fam) && !known.includes(url)) want.add(url);
        }
      }
    }
    for (const f of doc.querySelectorAll('iframe')) { try { collect(f.contentDocument) } catch(e){} }
  }
  collect(document);
  const data = {};
  await Promise.all([...want].map(async u => {
    try {
      const r = await fetch(u, {credentials:'same-origin'}); if (!r.ok) return;
      const b = new Uint8Array(await r.arrayBuffer()); let s = '';
      for (let i=0;i<b.length;i+=0x8000) s += String.fromCharCode.apply(null, b.subarray(i,i+0x8000));
      data[u] = btoa(s);
    } catch(e) {}
  }));
  return {faces, data};
}
"""

# Shared walker used by extraction and by click_by_text. Installed once per call (cheap).
WALKER_JS = r"""
function __wfMakeWalker(maps, opt){
  opt = Object.assign({maxOptions: 40, links: true, hidden: false, mainOnly: true, frames: true}, opt||{});
  const SKIP = new Set(['SCRIPT','STYLE','TEMPLATE','NOSCRIPT','META','LINK','HEAD','TITLE']);
  const BLOCKD = /^(block|flex|grid|table|list-item|flow-root|table-caption|table-row|table-row-group|table-header-group|table-footer-group)$/;
  const fam = cs => (cs.fontFamily||'').split(',')[0].trim().replace(/^["']|["']$/g,'');
  function dec(s, cs){
    let t = s;
    const tt = cs.textTransform;
    if (tt==='uppercase') t = t.toUpperCase(); else if (tt==='lowercase') t = t.toLowerCase();
    else if (tt==='capitalize') t = t.replace(/(^|\s)(\S)/g, (a,b,c)=>b+c.toUpperCase());
    const m = maps[fam(cs)];
    if (m) { let o=''; for (const ch of t) o += (m[ch]!==undefined ? m[ch] : ch); t = o; }
    if (cs.unicodeBidi==='bidi-override' && cs.direction==='rtl') t = [...t].reverse().join('');
    return t;
  }
  function hidden(el, cs){
    if (cs.display==='none') return true;
    if (parseFloat(cs.opacity)===0) return true;
    if (opt.hidden) return false;
    if (cs.position==='absolute' || cs.position==='fixed') {
      const r = el.getBoundingClientRect();
      if (r.width<=1 && r.height<=1) return true;
      if (/rect\(0px,?\s*0px,?\s*0px,?\s*0px\)/.test(cs.clip||'')) return true;
      if (r.right < -200 || r.bottom < -200) return true;
    }
    if (/inset\(50%\)/.test(cs.clipPath||'')) return true;
    if (parseFloat(cs.fontSize)===0) return true;
    return false;
  }
  function pathOf(href){ try { const u = new URL(href); if (u.origin!==location.origin) return href; return u.pathname+u.search+u.hash; } catch(e){ return href } }
  function pseudo(el, win, which){
    const ps = win.getComputedStyle(el, which); const c = ps.content;
    if (!c || c==='none' || c==='normal' || c==='""' || ps.display==='none') return '';
    let txt = '';
    const re = /"((?:[^"\\]|\\.)*)"|attr\(([^)]+)\)/g; let m;
    while ((m = re.exec(c))) { txt += m[1]!==undefined ? m[1].replace(/\\(.)/g,'$1') : (el.getAttribute(m[2].trim())||''); }
    return txt ? dec(txt, ps) : '';
  }
  function inlineText(el, win){ return walk(el, win).replace(/\s*\n\s*/g,' ').replace(/[ \t]+/g,' ').trim(); }
  function table(tb, win){
    const out = [];
    if (tb.caption) { const c = inlineText(tb.caption, win); if (c) out.push('[table: '+c+']'); }
    for (const row of tb.rows) {
      const rcs = win.getComputedStyle(row); if (hidden(row, rcs)) continue;
      const cells = [];
      for (const td of row.cells) { const ccs = win.getComputedStyle(td); if (ccs.display==='none') continue; cells.push(inlineText(td, win)); }
      if (cells.some(x=>x)) out.push(cells.join(' | '));
    }
    return '\n' + out.join('\n') + '\n';
  }
  function dl(el, win){
    const out = []; let cur = null;
    const items = [...el.querySelectorAll('dt,dd')].filter(x => x.closest('dl')===el);
    for (const it of items) {
      const cs = win.getComputedStyle(it); if (hidden(it, cs)) continue;
      const t = walk(it, win).split('\n').map(s=>s.trim()).filter(Boolean).join('\n  ');
      if (it.tagName==='DT') { cur = {k: t, v: []}; out.push(cur); }
      else { if (!cur) { cur = {k:'', v:[]}; out.push(cur); } cur.v.push(t); }
    }
    return '\n' + out.map(o => (o.k ? o.k+': ' : '') + o.v.join(' / ')).join('\n') + '\n';
  }
  function ordered(el, cs){
    let kids = [...el.childNodes];
    const win = el.ownerDocument.defaultView;
    if (/flex|grid/.test(cs.display)) {
      const ord = kids.map((k,i)=>[k, i, k.nodeType===1 ? (parseInt(win.getComputedStyle(k).order)||0) : 0]);
      if (ord.some(x=>x[2]!==0)) { ord.sort((a,b)=>a[2]-b[2] || a[1]-b[1]); kids = ord.map(x=>x[0]); }
      if (/reverse/.test(cs.flexDirection||'')) kids.reverse();
    }
    // leaf runs (e.g. one <span> per character) that are visually re-positioned: use rendered order
    const els = kids.filter(k=>k.nodeType===1);
    if (els.length >= 2 && kids.every(k => k.nodeType===1 ? k.childElementCount===0 : !(k.nodeValue||'').trim())) {
      let shifted = false, tiny = true;
      for (const k of els) {
        const kc = win.getComputedStyle(k);
        if (kc.position!=='static' || kc.transform!=='none' || kc.float!=='none' || parseFloat(kc.marginLeft)<0 || parseFloat(kc.marginRight)<0 || (kc.order && kc.order!=='0')) shifted = true;
        if ((k.textContent||'').length > 3) tiny = false;
      }
      if (shifted || tiny) {
        const pos = els.map((k,i)=>{ const r = k.getBoundingClientRect(); return {k, i, x: r.left, y: (r.top+r.bottom)/2}; });
        pos.sort((a,b)=> (Math.abs(a.y-b.y) > 4 ? a.y-b.y : a.x-b.x) || a.i-b.i);
        kids = pos.map(o=>o.k);
      }
    }
    return kids;
  }
  function walkDoc(doc){
    const win = doc.defaultView; if (!doc.body) return '';
    return walk(doc.body, win);
  }
  function walk(node, win){
    if (node.nodeType===3) {
      const p = node.parentElement; if (!p) return '';
      const cs = win.getComputedStyle(p);
      if (cs.visibility==='hidden' || cs.visibility==='collapse') return '';
      if (cs.color==='rgba(0, 0, 0, 0)' || cs.color==='transparent') return '';
      let s = node.nodeValue;
      if (!/^pre/.test(cs.whiteSpace) && cs.whiteSpace!=='break-spaces') s = s.replace(/\s+/g,' ');
      return dec(s, cs);
    }
    if (node.nodeType!==1) return '';
    const el = node, tag = el.tagName.toUpperCase();
    if (SKIP.has(tag)) return '';
    const cs = win.getComputedStyle(el);
    if (hidden(el, cs)) return '';
    if (!opt.hidden && el.childElementCount===0 && cs.display!=='contents' && (el.textContent||'').trim() && !/^(OPTION|TEXTAREA|TITLE)$/.test(tag)) {
      const r = el.getBoundingClientRect(); if (r.width < 0.5 || r.height < 0.5) return '';
    }
    if (opt.skipNav && el.closest && el.ownerDocument===document && tag==='NAV' && /main/i.test(el.getAttribute('aria-label')||'')) return '';
    if (el.getAttribute('role')==='img' && tag!=='SVG' && tag!=='IMG' && !(el.textContent||'').trim()) { return ' [value drawn as a picture: '+(el.getAttribute('aria-label')||'image')+' - use the VISUAL READING] '; }
    switch (tag) {
      case 'IFRAME': {
        if (!opt.frames) return '';
        let d=null; try { d = el.contentDocument } catch(e) {}
        return d ? '\n' + walkDoc(d) + '\n' : '';
      }
      case 'BR': return '\n';
      case 'HR': return '\n---\n';
      case 'IMG': { const a = el.getAttribute('alt'); return a ? ' [image: '+a+'] ' : ''; }
      case 'SVG': {
        const ts = el.querySelectorAll('text'); if (ts.length) return ' '+[...ts].map(t=>t.textContent).join(' ')+' ';
        const lab = el.getAttribute('aria-label'); return (lab && el.getAttribute('role')==='img') ? ' ['+lab+'] ' : '';
      }
      case 'INPUT': {
        const ty = (el.type||'text').toLowerCase();
        if (ty==='hidden') return '';
        if (ty==='checkbox' || ty==='radio') return (el.checked ? ' [x] ' : ' [ ] ');
        if (ty==='submit' || ty==='button') return ' [button: '+(el.value||'')+'] ';
        const nm = el.name || el.id || ty;
        return ' [input '+nm+(ty!=='text'?' ('+ty+')':'')+' = "'+(el.value||'')+'"'+(!el.value && el.placeholder ? ' placeholder="'+el.placeholder+'"' : '')+'] ';
      }
      case 'TEXTAREA': return ' [textarea '+(el.name||'')+' = "'+(el.value||'')+'"] ';
      case 'SELECT': {
        const opts = [...el.options];
        const sel = opts.filter(o=>o.selected).map(o=>o.text.trim()).join(', ');
        let s = ' [select '+(el.name||el.id||'')+' = "'+sel+'"';
        if (opt.maxOptions>0) { const names = opts.map(o=>o.text.trim()); s += ' options('+names.length+'): '+names.slice(0,opt.maxOptions).join('; ')+(names.length>opt.maxOptions?'; ...':''); }
        return s+'] ';
      }
      case 'TABLE': return table(el, win);
      case 'DL': return dl(el, win);
      case 'DETAILS': if (!el.open) { const su = el.querySelector(':scope > summary'); return su ? ' '+walk(su, win)+' ' : ''; } break;
    }
    const pb = pseudo(el, win, '::before'), pa = pseudo(el, win, '::after');
    let inner = pb;
    const clipped = (cs.clipPath && cs.clipPath !== 'none') && el.childElementCount===0 && (pb || pa);
    if (!clipped) { for (const k of ordered(el, cs)) inner += walk(k, win); }
    inner += pa;
    const role = el.getAttribute('role');
    if (tag==='A' && opt.links) {
      const href = el.getAttribute('href');
      const t = inner.replace(/\s+/g,' ').trim() || el.getAttribute('aria-label') || '';
      if (href && !href.startsWith('#') && !href.startsWith('javascript:')) inner = ' '+t+' <'+pathOf(el.href)+'>' + (el.getAttribute('aria-current') ? ' (current)' : '') + ' ';
    } else if (tag==='BUTTON' || tag==='SUMMARY' || role==='button' || role==='tab') {
      const t = inner.replace(/\s+/g,' ').trim() || el.getAttribute('aria-label') || el.getAttribute('title') || (el.textContent||'').replace(/\s+/g,' ').trim();
      let flags = '';
      if (el.getAttribute('aria-pressed')==='true' || el.getAttribute('aria-selected')==='true' || el.getAttribute('aria-current')) flags += ' (current)';
      if (el.disabled) flags += ' (disabled)';
      inner = ' ['+t+flags+'] ';
    }
    if (tag==='NAV') return '\n' + inner.split('\n').map(s=>s.trim()).filter(Boolean).join(' | ') + '\n';
    const h = /^H([1-6])$/.exec(tag);
    if (h) return '\n' + '#'.repeat(+h[1]) + ' ' + inner.replace(/\s+/g,' ').trim() + '\n';
    if (tag==='LI') return '\n- ' + inner.trim() + '\n';
    if (tag==='P' || BLOCKD.test(cs.display)) return '\n' + inner + '\n';
    if (/^inline-(block|flex|grid|table)$/.test(cs.display)) { const t = inner.trim(); if (t.length <= 2 && el.childElementCount===0) return t; return ' ' + inner + ' '; }
    return inner;
  }
  function clean(s){
    return s.split('\n').map(l=>l.replace(/[ \t\u00a0]+/g,' ').trim()).filter(l=>l).join('\n').trim();
  }
  function innerOf(el, win){ return [...el.childNodes].map(k=>walk(k, win)).join('').replace(/\s+/g,' ').trim(); }
  return {walk, walkDoc, dec, clean, inlineText, innerOf};
}
"""

EXTRACT_JS = "(args) => {\n" + WALKER_JS + r"""
  const W = __wfMakeWalker(args.maps||{}, args.opts||{});
  const doc = document;
  let root = doc.body;
  if ((args.opts||{}).mainOnly !== false) { root = doc.querySelector('main') || doc.querySelector('[role=main]') || doc.body; }
  const loc = [...doc.querySelectorAll('summary,button')].map(e=>e.getAttribute('aria-label')||'').find(a=>/location/i.test(a)) || '';
  const head = 'URL: '+location.pathname+location.search + (loc ? '\nLOCATION: '+loc.replace(/^\s*location:\s*/i,'').replace(/\.?\s*change location\.?\s*$/i,'') : '');
  return head + '\n\n' + W.clean(W.walk(root, doc.defaultView));
}
"""

# find clickable element by (decoded) visible text across all frames; mark it with data-wfc and return its frame path
FIND_JS = "(args) => {\n" + WALKER_JS + r"""
  const W = __wfMakeWalker(args.maps||{}, {links:false, maxOptions:0});
  const want = args.text.replace(/\s+/g,' ').trim().toLowerCase();
  const sel = args.selector || 'a,button,summary,[role=button],[role=tab],[role=link],[role=menuitem],[role=option],label,input[type=submit],input[type=button],input[type=radio],input[type=checkbox],option';
  const cands = [];
  (function scan(doc, depth){
    const win = doc.defaultView;
    for (const el of doc.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect(); const cs = win.getComputedStyle(el);
      if (el.tagName!=='OPTION' && (r.width===0 || r.height===0 || cs.visibility==='hidden')) continue;
      if (el.closest('[aria-hidden=true]') && el.getAttribute('tabindex')==='-1') continue;  // honeypot-style hidden links
      let t = W.innerOf(el, win).toLowerCase();
      if (el.tagName==='OPTION') t = el.text.trim().toLowerCase();
      const al = (el.getAttribute('aria-label')||el.getAttribute('title')||'').trim().toLowerCase();
      let score = 0;
      if (t===want || al===want) score = 3; else if (t.startsWith(want) || al.startsWith(want)) score = 2; else if (args.contains !== false && (t.includes(want) || al.includes(want))) score = 1;
      if (score) cands.push({el, score, depth, t});
    }
    for (const f of doc.querySelectorAll('iframe')) { try { scan(f.contentDocument, depth+1) } catch(e){} }
  })(document, 0);
  cands.sort((a,b)=> b.score-a.score || b.depth-a.depth);
  const pick = cands[args.nth||0];
  if (!pick) return null;
  const id = 'c' + Math.random().toString(36).slice(2);
  pick.el.setAttribute('data-wfc', id);
  const a = pick.el.closest('a');
  return {id, tag: pick.el.tagName, text: pick.t, href: a ? a.href : null, target: a ? a.getAttribute('target') : null, download: a ? a.hasAttribute('download') : false, n: cands.length};
}
"""

LINKS_JS = "(args) => {\n" + WALKER_JS + r"""
  const W = __wfMakeWalker(args.maps||{}, {links:false, maxOptions:0});
  const out = [];
  (function scan(doc){
    const win = doc.defaultView;
    for (const a of doc.querySelectorAll('a[href]')) {
      const cs = win.getComputedStyle(a); const r = a.getBoundingClientRect();
      if (cs.display==='none' || r.width===0 || a.getAttribute('aria-hidden')==='true') continue;
      let p; try { const u = new URL(a.href); p = u.origin===location.origin ? u.pathname+u.search : a.href } catch(e) { p = a.href }
      out.push({text: W.inlineText(a, win), href: p, row: a.closest('tr') ? W.inlineText(a.closest('tr'), win) : null});
    }
    for (const f of doc.querySelectorAll('iframe')) { try { scan(f.contentDocument) } catch(e){} }
  })(document);
  return out;
}
"""

TABLES_JS = "(args) => {\n" + WALKER_JS + r"""
  const W = __wfMakeWalker(args.maps||{}, {links:false, maxOptions:0});
  const out = [];
  (function scan(doc){
    const win = doc.defaultView;
    for (const tb of doc.querySelectorAll('table')) {
      if (win.getComputedStyle(tb).display==='none') continue;
      const rows = [];
      let header = null;
      for (const row of tb.rows) {
        if (win.getComputedStyle(row).display==='none') continue;
        const cells = [], links = [];
        for (const td of row.cells) {
          if (win.getComputedStyle(td).display==='none') continue;
          let ct = W.inlineText(td, win);
          if (!ct && td.tagName==='TH') ct = (td.textContent||'').replace(/\s+/g,' ').trim();  // sr-only header label (e.g. 'Flags')
          cells.push(ct);
          const a = td.querySelector('a[href]');
          let p = null; if (a) { try { const u = new URL(a.href); p = u.pathname+u.search } catch(e) {} }
          links.push(p);
        }
        const isHead = row.parentElement && row.parentElement.tagName==='THEAD' || [...row.cells].every(c=>c.tagName==='TH');
        if (isHead && !header) header = cells; else rows.push({cells, links});
      }
      out.push({caption: tb.caption ? W.inlineText(tb.caption, win) : null, header, rows});
    }
    for (const f of doc.querySelectorAll('iframe')) { try { scan(f.contentDocument) } catch(e){} }
  })(document);
  return out;
}
"""

CHART_TABS = ["demographics", "insurance", "problems", "notes", "documents", "appointments", "activity"]


class WrenfieldError(Exception):
    pass


# --------------------------------------------------------------------------------------------------------
class WrenfieldTab:
    """One browser tab showing the Wrenfield shell. All reads/clicks go through here."""

    def __init__(self, client: "WrenfieldClient", page: Page):
        self.c = client
        self.page = page
        self._req_started = 0
        self._inflight = 0
        page.on("request", self._on_req)
        page.on("requestfinished", self._on_done)
        page.on("requestfailed", self._on_done)
        self.last_nav_s = 0.0

    # ---- request tracking -------------------------------------------------------------------------
    def _tracked(self, req) -> bool:
        return req.method == "POST" or req.resource_type in ("document", "fetch", "xhr")

    def _on_req(self, req):
        if self._tracked(req):
            self._inflight += 1
            self._req_started += 1

    def _on_done(self, req):
        if self._tracked(req):
            self._inflight = max(0, self._inflight - 1)

    # ---- waiting ----------------------------------------------------------------------------------
    async def _ready_once(self) -> bool:
        try:
            return bool(await self.page.evaluate(READY_JS))
        except Exception:
            return False

    async def wait_settled(self, timeout: float = 15.0, quiet: float = 0.04, poll: float = 0.015) -> bool:
        """Wait until no tracked request is in flight and all frames are ready, stable for `quiet` seconds.
        Robust to lost request events: if the DOM has been ready continuously for 0.35 s, treat as settled."""
        t0 = time.time()
        stable_since, mark = None, None
        ready_since = None
        while time.time() - t0 < timeout:
            ready = await self._ready_once()
            if ready:
                if ready_since is None:
                    ready_since = time.time()
                if self._inflight == 0:
                    if stable_since is None or mark != self._req_started:
                        stable_since, mark = time.time(), self._req_started
                    elif time.time() - stable_since >= quiet:
                        return True
                elif time.time() - ready_since >= 0.35:
                    self._inflight = 0   # lost requestfinished/failed events; don't stay poisoned
                    return True
            else:
                stable_since = None
                ready_since = None
            await asyncio.sleep(poll)
        self._inflight = 0
        return False

    async def _frame_sig(self) -> str:
        try:
            return await self.page.evaluate(FRAMESIG_JS)
        except Exception:
            return ""

    # ---- navigation -------------------------------------------------------------------------------
    def _is_shell_loaded(self) -> bool:
        u = self.page.url or ""
        return u.startswith(self.c.base_url) and "/v/" not in u and "/login" not in u

    async def goto(self, path: str, fresh: bool = False, timeout: float = 20.0) -> None:
        """Show `path` (e.g. '/patients/abc/insurance' or '/patients?lastName=Smith').
        Uses the app's popstate navigation when a shell is already loaded (fast), otherwise a full load."""
        if path.startswith("http"):
            u = urlparse(path)
            path = u.path + (("?" + u.query) if u.query else "")
        if not path.startswith("/"):
            path = "/" + path
        t0 = time.time()
        if not fresh and self.c.use_popstate and self._is_shell_loaded():
            before = await self._frame_sig()
            try:
                await self.page.evaluate("p => { history.pushState(null, '', p); dispatchEvent(new PopStateEvent('popstate')); }", path)
                # wait for new content (frame URLs change) then settle
                t1 = time.time()
                while time.time() - t1 < self.c.popstate_timeout:
                    sig = await self._frame_sig()
                    if sig and sig != before:
                        break
                    await asyncio.sleep(0.01)
                else:
                    self.c.popstate_failures += 1
                    if self.c.popstate_failures >= 2 and self.c.popstate_successes == 0:
                        self.c.use_popstate = False  # this Wrenfield version does not support it -> always full loads
                    raise WrenfieldError("popstate navigation produced no new frame")
                self.c.popstate_successes += 1
                if await self.wait_settled(timeout=timeout):
                    await self._after_nav(path)
                    self.last_nav_s = time.time() - t0
                    return
            except WrenfieldError:
                pass
            except Exception:
                pass
        # full load
        await self.page.goto(self.c.base_url + path, wait_until="commit", timeout=timeout * 1000)
        await asyncio.sleep(0.02)
        if not await self.wait_settled(timeout=timeout):
            raise WrenfieldError(f"page did not settle: {path}")
        await self._after_nav(path)
        self.last_nav_s = time.time() - t0

    async def _after_nav(self, path):
        # session expired / judge sign-in page?
        if "/login" in urlparse(self.page.url).path or await self._has_password_field():
            await self.c._login_on(self)
            await self.goto(path, fresh=True)

    async def _has_password_field(self) -> bool:
        for fr in self.page.frames:
            try:
                if await fr.locator("input[type=password]").count():
                    return True
            except Exception:
                pass
        return False

    async def reload(self):
        await self.goto(self.current_path(), fresh=True)

    def current_path(self) -> str:
        u = urlparse(self.page.url)
        return u.path + (("?" + u.query) if u.query else "")

    # ---- reading ----------------------------------------------------------------------------------
    async def _maps(self) -> Dict[str, Dict[str, str]]:
        known = list(self.c.fonts.cache.keys())
        res = await self.page.evaluate(FONTS_JS, known)
        for url, b64 in (res.get("data") or {}).items():
            self.c.fonts.decode_map(base64.b64decode(b64), url)
        maps = {}
        for fam, url in (res.get("faces") or {}).items():
            m = self.c.fonts.cache.get(url)
            if m:
                maps[fam] = m
        return maps

    async def text(self, main_only: bool = True, max_options: int = 40, hidden: bool = False, links: bool = True) -> str:
        """Clean text of the current page (main content incl. nested frames)."""
        maps = await self._maps()
        return await self.page.evaluate(EXTRACT_JS, {"maps": maps, "opts": {"mainOnly": main_only, "maxOptions": max_options, "hidden": hidden, "links": links}})

    async def get_text(self, path: Optional[str] = None, **kw) -> str:
        if path:
            await self.goto(path)
        return await self.text(**kw)

    async def links(self) -> List[Dict[str, Any]]:
        maps = await self._maps()
        return await self.page.evaluate(LINKS_JS, {"maps": maps})

    async def tables(self) -> List[Dict[str, Any]]:
        """Structured tables of the current page: [{caption, header, rows:[{cells, links}]}] (decoded text)."""
        maps = await self._maps()
        return await self.page.evaluate(TABLES_JS, {"maps": maps})

    # ---- acting -----------------------------------------------------------------------------------
    async def _marked(self, mid: str):
        for fr in self.page.frames:
            loc = fr.locator(f'[data-wfc="{mid}"]')
            try:
                if await loc.count():
                    return fr, loc.first
            except Exception:
                continue
        return None, None

    async def click_by_text(self, text: str, nth: int = 0, selector: Optional[str] = None, contains: bool = True,
                            navigate_links: bool = True) -> Dict[str, Any]:
        """Click the clickable element whose visible (decoded) text matches `text` (exact > prefix > substring),
        preferring the deepest frame. Internal links are followed via fast app navigation."""
        maps = await self._maps()
        info = await self.page.evaluate(FIND_JS, {"maps": maps, "text": text, "nth": nth, "selector": selector, "contains": contains})
        if not info:
            raise WrenfieldError(f"no clickable element with text {text!r}")
        href = info.get("href")
        if navigate_links and href and href.startswith(self.c.base_url) and "/v/" not in href and not info.get("target") and not info.get("download"):
            await self.goto(href)
            return info
        fr, loc = await self._marked(info["id"])
        if loc is None:
            raise WrenfieldError("marked element vanished")
        await loc.click(timeout=5000)
        await asyncio.sleep(0.02)
        await self.wait_settled()
        return info

    async def _field(self, field: str):
        """Locate an input/select/textarea in any frame by label text, name, id, placeholder or aria-label."""
        for fr in reversed(self.page.frames):
            for loc in (fr.get_by_label(field, exact=True), fr.locator(f'[name="{field}"]'), fr.locator(f'[id="{field}"]'),
                        fr.get_by_placeholder(field), fr.get_by_label(field)):
                try:
                    if await loc.count():
                        return loc.first
                except Exception:
                    continue
        raise WrenfieldError(f"no field {field!r}")

    async def fill(self, field: str, value: str):
        loc = await self._field(field)
        await loc.fill(value)

    async def select(self, field: str, option: str):
        loc = await self._field(field)
        try:
            await loc.select_option(label=option, timeout=3000)
        except Exception:
            await loc.select_option(value=option, timeout=3000)
        await asyncio.sleep(0.02)
        await self.wait_settled()

    async def submit(self, field: Optional[str] = None, button_text: Optional[str] = None):
        """Submit a form: click its button by text, or press Enter in `field`."""
        if button_text:
            await self.click_by_text(button_text, navigate_links=False)
            return
        loc = await self._field(field) if field else None
        if loc is None:
            raise WrenfieldError("submit needs field or button_text")
        await loc.press("Enter")
        await asyncio.sleep(0.02)
        await self.wait_settled()

    # ---- shell: location ---------------------------------------------------------------------------
    async def location(self) -> str:
        lab = await self.page.evaluate("() => [...document.querySelectorAll('summary,button')].map(e=>e.getAttribute('aria-label')||'').find(a=>/location/i.test(a)) || ''")
        return re.sub(r"(?i)\.?\s*change location\.?\s*$", "", re.sub(r"(?i)^\s*location:\s*", "", lab)).strip()

    async def set_location(self, name: str) -> str:
        """Switch 'Work at location' (session-wide: affects every tab of this client)."""
        if (await self.location()).lower() == name.lower():
            return name
        await self.page.evaluate("""() => { const s=[...document.querySelectorAll('summary')].find(x=>/location/i.test(x.getAttribute('aria-label')||'')); if (s && !s.parentElement.open) s.click(); }""")
        ok = await self.page.evaluate("""(name) => {
            const s=[...document.querySelectorAll('summary')].find(x=>/location/i.test(x.getAttribute('aria-label')||''));
            const box = s ? s.parentElement : document;
            const norm = t => (t||'').replace(/\\s+/g,' ').trim().toLowerCase();
            const btns=[...box.querySelectorAll('button,[role=menuitem],[role=option],a')];
            let b = btns.find(x => norm(x.querySelector('span span')?.textContent) === norm(name)) || btns.find(x => norm(x.textContent) === norm(name)) || btns.find(x => norm(x.textContent).startsWith(norm(name)));
            if (!b) return false; b.click(); return true; }""", name)
        if not ok:
            raise WrenfieldError(f"location {name!r} not found")
        await asyncio.sleep(0.02)
        await self.wait_settled()
        return await self.location()

    async def locations(self) -> List[str]:
        return await self.page.evaluate("""() => { const s=[...document.querySelectorAll('summary')].find(x=>/location/i.test(x.getAttribute('aria-label')||''));
            if (!s) return []; return [...s.parentElement.querySelectorAll('button')].map(b=>{ const sp=b.querySelector('span span'); return (sp?sp.textContent:b.textContent).replace(/\\s+/g,' ').trim(); }); }""")

    # ---- high level --------------------------------------------------------------------------------
    async def search_patients(self, last_name: Optional[str] = None, dob: Optional[str] = None, all_pages: bool = True, max_pages: int = 50, base: str = "/patients") -> List[Dict[str, Any]]:
        """Patient search (4.2.0: last-name PREFIX >= 2 chars, case/accent-insensitive; or exact DOB). Not both at once.
        Returns rows [{name, mrn, dob, sex, flags, href, cells}] from all result pages.
        Fast path = deep link /patients?lastName=..|dob=YYYY-MM-DD; falls back to filling the visible search form."""
        q = {}
        if last_name:
            q["lastName"] = last_name.strip()
        elif dob:
            q["dob"] = _iso_date(dob)
        qs = "&".join(f"{k}={quote(v)}" for k, v in q.items())
        await self.goto(base + ("?" + qs if qs else ""))
        rows = await self._patient_rows()
        def _relevant(rs):
            # rows that answer this search; none means the URL parameter was probably ignored (default listing)
            if not rs:
                return False
            if last_name:
                tl = _fold(last_name.strip())
                return any(tl[:4] in _fold(r.get("name") or "") or _fold(r.get("name") or "")[:1] == tl[:1] for r in rs)
            y = _iso_date(dob)[:4]
            return any(y in " ".join(str(c) for c in (r.get("cells") or [])) + str(r.get("dob") or "") or
                       y[2:] in " ".join(str(c) for c in (r.get("cells") or [])) for r in rs)
        if q and (rows is None or (rows and not _relevant(rows))):
            # fallback: fill the visible search form (another version may use different URL params)
            labels = ("Last name", "Surname", "Family name", "Name", "Patient", "Search") if last_name else \
                     ("Date of birth", "DOB", "Birth date", "Born", "Birthdate")
            iso = _iso_date(dob) if dob else ""
            vals = [last_name.strip()] if last_name else [iso, f"{iso[5:7]}/{iso[8:10]}/{iso[:4]}"]
            done = False
            for val in vals:
                for label in labels:
                    try:
                        await self.fill(label, val)
                        await self.submit(field=label)
                        r2 = await self._patient_rows()
                        if r2 is not None and (r2 or val == vals[-1]) and (not r2 or _relevant(r2)):
                            rows = r2
                            done = True
                            break
                    except Exception:
                        continue
                if done:
                    break
        out = list(rows or [])
        pages = 1
        while all_pages and rows and pages < max_pages and await self._has_enabled_button("Next"):
            await self.click_by_text("Next", contains=False, navigate_links=False)
            rows = await self._patient_rows() or []
            out.extend(rows)
            pages += 1
        return out

    async def _patient_rows(self) -> Optional[List[Dict[str, Any]]]:
        """Rows of the patient-results table on the current page; [] if 'no match' shown; None if no results UI."""
        found_table = False
        out = []
        for tb in await self.tables():
            hdr = [h.lower() for h in (tb.get("header") or [])]
            if not hdr or not any("patient" in h or "name" in h for h in hdr) or not any("birth" in h or "mrn" in h for h in hdr):
                continue
            found_table = True
            for r in tb["rows"]:
                d = {"cells": r["cells"], "href": next((l for l in r["links"] if l and "/patients/" in l), None)}
                for h, v in zip(hdr, r["cells"]):
                    if ("patient" in h or h == "name") and "name" not in d:
                        d["name"] = v
                    elif "mrn" in h or "record" in h:
                        d["mrn"] = v
                    elif "birth" in h or h == "dob":
                        d["dob"] = v
                    elif h in ("sex", "gender"):
                        d["sex"] = v
                    elif "flag" in h:
                        d["flags"] = v
                if len(d["cells"]) > len(hdr):  # unlabeled trailing flag column
                    d.setdefault("flags", " ".join(d["cells"][len(hdr):]))
                out.append(d)
        if found_table:
            return out
        txt = await self.text(max_options=0)
        if re.search(r"(?i)no patients? (match|found)|no results", txt):
            return []
        return None

    async def _has_enabled_button(self, text: str) -> bool:
        return await self.page.evaluate("""(t) => { let found=false; (function s(doc){ for (const b of doc.querySelectorAll('button,[role=button],a')) {
            if ((b.innerText||'').trim().toLowerCase()===t.toLowerCase() && !b.disabled && b.getAttribute('aria-disabled')!=='true' && b.getBoundingClientRect().width>0) found=true; }
            for (const f of doc.querySelectorAll('iframe')) { try { s(f.contentDocument) } catch(e){} } })(document); return found; }""", text)

    async def chart_tab(self, patient_ref: str, tab: str = "demographics") -> str:
        """Text of one chart tab. 4.2.0 URLs: /patients/<id>[/insurance|problems|notes|documents|appointments|activity],
        billing account /billing/accounts/<id>. Falls back to clicking the tab by its label."""
        pid = _patient_id(patient_ref)
        tab = tab.lower().strip()
        if tab in ("", "demographics", "overview", "summary"):
            path = f"/patients/{pid}"
        elif tab in ("billing", "invoices", "account"):
            path = f"/billing/accounts/{pid}"
        else:
            path = f"/patients/{pid}/{tab}"
        txt = await self.get_text(path)
        if re.search(r"(?i)not available|not found|page (does not|doesn.t) exist", txt) and tab not in ("", "demographics"):
            # unknown URL scheme in this version: open the chart and click the tab label
            await self.goto(f"/patients/{pid}")
            try:
                await self.click_by_text(tab.capitalize())
                txt = await self.text()
            except WrenfieldError:
                pass
        return txt

    async def open_chart(self, patient_ref: str, tabs: Optional[List[str]] = None) -> Dict[str, str]:
        """Text of the chart tabs (default: all tabs + billing account). Restricted charts return the gate page text."""
        tabs = tabs or CHART_TABS + ["billing"]
        out = {}
        for t in tabs:
            out[t] = await self.chart_tab(patient_ref, t)
            if t == tabs[0] and _looks_restricted(out[t]):
                out["restricted"] = "true"
                break
        return out

    async def paginate_all(self, max_pages: int = 100, rows_per_page: Optional[str] = "100") -> List[str]:
        """Return text of every page of the current paginated list (tries 'Rows per page' = 100 first)."""
        if rows_per_page:
            try:
                for fr in self.page.frames:
                    loc = fr.locator('select[name="size"]')
                    if await loc.count():
                        opts = await loc.first.evaluate("s => [...s.options].map(o=>o.value)")
                        best = rows_per_page if rows_per_page in opts else max(opts, key=lambda v: int(v) if v.isdigit() else 0)
                        await loc.first.select_option(value=best)
                        await asyncio.sleep(0.02)
                        await self.wait_settled()
                        break
            except Exception:
                pass
        pages = [await self.text()]
        for _ in range(max_pages - 1):
            if not await self._has_enabled_button("Next"):
                break
            await self.click_by_text("Next", contains=False, navigate_links=False)
            pages.append(await self.text())
        return pages

    async def document_files(self, want=("pdf", "image")) -> List[Dict[str, Any]]:
        """Bytes of the document shown in the viewer (page images <img> and the PDF behind 'Download'/'Open in new tab').
        Viewer asset URLs live under /v/<rand>/ (session-bound). Returns [{kind, url, content_type, data(bytes), alt}]."""
        res = await self.page.evaluate("""async (want) => { const out=[], seen=new Set();
          async function grab(kind, u, alt){ if (seen.has(u)) return; seen.add(u);
            try { const r = await fetch(u, {credentials:'same-origin'}); const b = new Uint8Array(await r.arrayBuffer()); let s='';
                  for (let i=0;i<b.length;i+=0x8000) s += String.fromCharCode.apply(null, b.subarray(i,i+0x8000));
                  out.push({kind, url:u, status:r.status, content_type:r.headers.get('content-type'), b64:btoa(s), alt}); } catch(e) { out.push({kind, url:u, error:String(e)}) } }
          async function scan(doc){
            if (want.includes('pdf')) for (const a of doc.querySelectorAll('a[download], a[href$=".pdf"], a[target=_blank]')) { if (a.href.includes('/v/') || /pdf/i.test(a.getAttribute('download')||a.href)) await grab('pdf', a.href, a.getAttribute('download')); }
            if (want.includes('image')) for (const im of doc.querySelectorAll('img')) { if (im.src && !im.src.startsWith('data:image/svg') && (im.naturalWidth>200 || im.width>200)) await grab('image', im.src, im.alt); }
            for (const f of doc.querySelectorAll('iframe')) { try { await scan(f.contentDocument) } catch(e){} } }
          await scan(document); return out; }""", list(want))
        for r in res:
            if r.get("b64"):
                r["data"] = base64.b64decode(r.pop("b64"))
        return res

    async def request_restricted_access(self, reason: str = "Providing care to this patient", details: str = "") -> str:
        """WRITE ACTION (creates an access request + audit entry). Only call on your own clinic (judge), never on the
        shared practice clinic. On a 'This chart is restricted' page: choose reason, optional details, submit."""
        await self.select("Reason for access", reason)
        if details:
            await self.fill("Details", details)
        await self.click_by_text("Request access", navigate_links=False)
        return await self.text()

    async def screenshot(self, path: str, full_page: bool = True):
        await self.page.screenshot(path=path, full_page=full_page)


# --------------------------------------------------------------------------------------------------------
class WrenfieldClient:
    """Owns the browser/context (one Wrenfield session) and a pool of tabs. Methods proxy to the default tab."""

    def __init__(self, base_url: str, username: Optional[str] = None, password: Optional[str] = None, *,
                 headless: bool = True, block_assets: bool = False, viewport=(1400, 1000), browser: Optional[Browser] = None,
                 launch_args: Optional[List[str]] = None):
        self.base_url = base_url.rstrip("/")
        self.username = username or os.environ.get("SITE_USERNAME", "")
        self.password = password or os.environ.get("SITE_PASSWORD", "")
        self.headless = headless
        self.block_assets = block_assets
        self.viewport = viewport
        self._browser_given = browser
        self.launch_args = launch_args or []
        self.fonts = FontDecoder()
        self.use_popstate = True       # fast in-shell navigation via the app's popstate handler
        self.popstate_timeout = 4.0
        self.popstate_failures = 0
        self.popstate_successes = 0
        self._pw = None
        self.browser: Optional[Browser] = None
        self.ctx: Optional[BrowserContext] = None
        self.main: Optional[WrenfieldTab] = None
        self._login_lock = asyncio.Lock()
        self._pool: asyncio.Queue = asyncio.Queue()
        self._tabs: List[WrenfieldTab] = []

    async def __aenter__(self):
        await self.start()
        return self

    async def __aexit__(self, *a):
        await self.close()

    async def start(self, n_tabs: int = 1):
        if self._browser_given:
            self.browser = self._browser_given
        else:
            self._pw = await async_playwright().start()
            self.browser = await self._pw.chromium.launch(headless=self.headless, args=self.launch_args)
        self.ctx = await self.browser.new_context(viewport={"width": self.viewport[0], "height": self.viewport[1]},
                                                  bypass_csp=True, locale="en-US")
        if self.block_assets:
            # images only; fonts must load (scrambled-font decoding fetches them; layout fingerprint)
            async def _route(route):
                if route.request.resource_type == "image":
                    await route.abort()
                else:
                    await route.continue_()
            await self.ctx.route("**/*", _route)
        self.main = await self._new_tab()
        await self.login()
        for _ in range(n_tabs - 1):
            await self.add_tab()
        return self

    async def _new_tab(self) -> WrenfieldTab:
        pg = await self.ctx.new_page()
        t = WrenfieldTab(self, pg)
        self._tabs.append(t)
        return t

    async def add_tab(self, path: str = "/") -> WrenfieldTab:
        t = await self._new_tab()
        await t.goto(path, fresh=True)
        self._pool.put_nowait(t)
        return t

    @contextlib.asynccontextmanager
    async def tab(self):
        """Borrow a pooled tab (creates one if none is free). Same session => same location."""
        if self._pool.empty():
            t = await self.add_tab()
            self._pool.get_nowait()
        else:
            t = self._pool.get_nowait()
        try:
            yield t
        finally:
            self._pool.put_nowait(t)

    async def close(self):
        with contextlib.suppress(Exception):
            if self.ctx:
                await self.ctx.close()
        if not self._browser_given:
            with contextlib.suppress(Exception):
                if self.browser:
                    await self.browser.close()
            with contextlib.suppress(Exception):
                if self._pw:
                    await self._pw.stop()

    # ---- login ---------------------------------------------------------------------------------------
    async def login(self):
        await self._login_on(self.main)
        await self.main.goto("/", fresh=True)

    async def _login_on(self, tab: WrenfieldTab):
        """Open /login; if a password form is shown (judge), fill it and submit. Practice auto-signs-in (302 -> /)."""
        async with self._login_lock:
            pg = tab.page
            await pg.goto(self.base_url + "/login", wait_until="domcontentloaded")
            await asyncio.sleep(0.05)
            await tab.wait_settled(timeout=10)
            for attempt in range(2):
                pw_frame = None
                for fr in pg.frames:
                    try:
                        if await fr.locator("input[type=password]").count():
                            pw_frame = fr
                            break
                    except Exception:
                        pass
                if not pw_frame:
                    return  # already signed in (or no sign-in needed)
                fr = pw_frame
                await fr.evaluate("""() => {
                    const vis = i => { const r = i.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
                    const ins = [...document.querySelectorAll('input')].filter(i => vis(i) && !/^(password|hidden|checkbox|radio|submit|button|image|file|reset)$/i.test(i.type||'text'));
                    const pw = document.querySelector('input[type=password]');
                    const hint = i => /user|email|login|account|name/i.test((i.name||'')+' '+(i.id||'')+' '+(i.autocomplete||'')+' '+(i.placeholder||'')+' '+(i.labels && i.labels[0] ? i.labels[0].textContent : ''));
                    let u = ins.find(hint) || ins.filter(i => pw && (i.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING)).pop() || ins[0];
                    document.querySelectorAll('[data-wfc-user]').forEach(e => e.removeAttribute('data-wfc-user'));
                    if (u) u.setAttribute('data-wfc-user', '1');
                }""")
                user = fr.locator("[data-wfc-user]").first
                pwd = fr.locator("input[type=password]").first
                if await user.count():
                    await user.fill(self.username)
                await pwd.fill(self.password)
                await pwd.press("Enter")
                with contextlib.suppress(Exception):
                    await pg.wait_for_load_state("domcontentloaded", timeout=10000)
                await asyncio.sleep(0.1)
                await tab.wait_settled(timeout=10)
                if "/login" not in urlparse(pg.url).path and not await tab._has_password_field():
                    return
            raise WrenfieldError("login failed (still on sign-in page)")

    # ---- proxies (default tab) -------------------------------------------------------------------------
    async def goto(self, path, **kw):
        return await self.main.goto(path, **kw)

    async def get_text(self, path=None, **kw):
        return await self.main.get_text(path, **kw)

    async def text(self, **kw):
        return await self.main.text(**kw)

    async def tables(self):
        return await self.main.tables()

    async def links(self):
        return await self.main.links()

    async def click_by_text(self, text, **kw):
        return await self.main.click_by_text(text, **kw)

    async def fill(self, field, value):
        return await self.main.fill(field, value)

    async def select(self, field, option):
        return await self.main.select(field, option)

    async def submit(self, field=None, button_text=None):
        return await self.main.submit(field, button_text)

    async def search_patients(self, last_name=None, dob=None, all_pages=True):
        return await self.main.search_patients(last_name, dob, all_pages)

    async def open_chart(self, patient_ref, tabs=None):
        return await self.main.open_chart(patient_ref, tabs)

    async def chart_tab(self, patient_ref, tab="demographics"):
        return await self.main.chart_tab(patient_ref, tab)

    async def set_location(self, name):
        return await self.main.set_location(name)

    async def location(self):
        return await self.main.location()

    async def locations(self):
        return await self.main.locations()

    async def paginate_all(self, **kw):
        return await self.main.paginate_all(**kw)

    async def get_texts(self, paths: List[str]) -> Dict[str, str]:
        """Read several pages concurrently using pooled tabs (+ the main tab)."""
        async def one(p):
            async with self.tab() as t:
                return p, await t.get_text(p)
        res = await asyncio.gather(*[one(p) for p in paths])
        return dict(res)

    async def list_all_patients(self, concurrency: int = 4, prefixes: Optional[List[str]] = None) -> List[Dict[str, Any]]:
        """There is no 'all patients' list in 4.2.0 (/patients/all is a hidden honeypot link -> 'not available').
        Enumerate via 2-letter last-name prefix searches (676 searches; ~40 s with 4 tabs). Deduped by href/MRN."""
        import string
        prefixes = prefixes or [a + b for a in string.ascii_lowercase for b in string.ascii_lowercase]
        while self._pool.qsize() < concurrency - 1:
            await self.add_tab()
        seen, out = set(), []
        sem = asyncio.Semaphore(concurrency)

        async def one(px):
            async with sem:
                async with self.tab() as t:
                    return await t.search_patients(last_name=px)

        for rows in await asyncio.gather(*[one(p) for p in prefixes]):
            for r in rows:
                k = r.get("href") or r.get("mrn") or r.get("name")
                if k not in seen:
                    seen.add(k)
                    out.append(r)
        return out


# --------------------------------------------------------------------------------------------------------
def _patient_id(ref: str) -> str:
    m = re.search(r"/patients/([0-9a-z]+)", ref)
    if m:
        return m.group(1)
    m = re.search(r"/billing/accounts/([0-9a-z]+)", ref)
    if m:
        return m.group(1)
    return ref.strip().strip("/")


def _fold(x) -> str:
    import unicodedata
    x = unicodedata.normalize("NFKD", str(x or ""))
    return "".join(c for c in x if not unicodedata.combining(c)).casefold().strip()


def _iso_date(s: str) -> str:
    s = s.strip()
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})$", s)
    if m:
        return f"{m.group(3)}-{int(m.group(1)):02d}-{int(m.group(2)):02d}"
    return s


def _looks_restricted(text: str) -> bool:
    return bool(re.search(r"(?i)chart is restricted|request access", text)) and "Demographics" not in text


# --------------------------------------------------------------------------------------------------------
if __name__ == "__main__":
    async def _demo():
        base = os.environ.get("SITE_URL", "https://practice.speedrun.scopehealth.com")
        async with WrenfieldClient(base) as wf:
            for p in sys.argv[1:] or ["/"]:
                t = time.time()
                txt = await wf.get_text(p)
                print(f"===== {p} ({time.time()-t:.2f}s)\n{txt}\n")
    asyncio.run(_demo())
