"""cartographer: scan pages for anti-scraping tricks (read-only). Reports per page which values use scrambled
fonts, per-char shuffles, hidden decoys, pseudo-element text, and compares raw innerText vs decoded extraction."""
import asyncio, sys, os, json, re, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wf_client import WrenfieldClient

SCAN_JS = r"""
(maps) => {
  const rep = {fontText: [], charRuns: [], hiddenLeaf: [], pseudo: [], zeroW: [], transparent: [], offscreen: [], fams: {}};
  const famOf = cs => (cs.fontFamily||'').split(',')[0].trim().replace(/^["']|["']$/g,'');
  (function scan(doc){
    const win = doc.defaultView;
    for (const el of doc.body.querySelectorAll('*')) {
      if (/^(SCRIPT|STYLE|TEMPLATE)$/.test(el.tagName)) continue;
      const cs = win.getComputedStyle(el);
      const f = famOf(cs);
      const own = [...el.childNodes].filter(n=>n.nodeType===3).map(n=>n.nodeValue).join('').trim();
      if (own) { rep.fams[f] = (rep.fams[f]||0)+1; if (maps[f]) rep.fontText.push(el.closest('dd,td,li,p,div')?.previousElementSibling?.textContent?.slice(0,20) + ' :: ' + own.slice(0,30)); }
      if (el.childElementCount>=4 && [...el.children].every(c=>c.childElementCount===0 && (c.textContent||'').length<=2)) {
        const shifted = [...el.children].some(c=>{const k=win.getComputedStyle(c); return k.position!=='static' || k.transform!=='none' || k.order!=='0'});
        const hid = [...el.children].filter(c=>win.getComputedStyle(c).display==='none').length;
        const lab = el.closest('dd,td')?.previousElementSibling?.textContent || el.closest('tr')?.cells?.[0]?.textContent || '';
        rep.charRuns.push(lab.slice(0,25)+' :: shifted='+shifted+' hidden='+hid+' n='+el.childElementCount);
      }
      if (cs.display==='none' && own && el.parentElement && win.getComputedStyle(el.parentElement).display.startsWith('inline') ) rep.hiddenLeaf.push(own.slice(0,20));
      for (const w of ['::before','::after']) { const c = win.getComputedStyle(el, w).content; if (c && c!=='none' && c!=='normal' && c!=='""') rep.pseudo.push(el.tagName+w+'='+c.slice(0,30)); }
      if (own && cs.color==='rgba(0, 0, 0, 0)') rep.transparent.push(own.slice(0,20));
      if (own && (cs.position==='absolute'||cs.position==='fixed')) { const r=el.getBoundingClientRect(); if (r.right<-100||r.bottom<-100) rep.offscreen.push(own.slice(0,20)); }
      if (own && cs.display!=='none' && el.childElementCount===0) { const r=el.getBoundingClientRect(); if ((r.width<0.5||r.height<0.5) && cs.display!=='contents') rep.zeroW.push(own.slice(0,20)+'|'+cs.position+'|'+cs.clip); }
    }
    for (const fr of doc.querySelectorAll('iframe')) { try { scan(fr.contentDocument) } catch(e){} }
  })(document);
  for (const k of Object.keys(rep)) if (Array.isArray(rep[k])) rep[k] = [...new Set(rep[k])].slice(0, 12);
  return rep;
}
"""
RAW_JS = """() => { let out=''; (function w(doc){ const m = doc.querySelector('main') || doc.body; out += m.innerText + '\\n'; for (const f of doc.querySelectorAll('iframe')) { try { w(f.contentDocument) } catch(e){} } })(document); return out; }"""

PATHS = sys.argv[1].split(",") if len(sys.argv) > 1 else [
    "/", "/patients?lastName=Murphy", "/patients/03q14ndmmd", "/patients/03q14ndmmd/insurance", "/patients/03q14ndmmd/problems",
    "/patients/03q14ndmmd/notes", "/patients/03q14ndmmd/documents", "/patients/03q14ndmmd/appointments", "/patients/03q14ndmmd/activity",
    "/billing/accounts/03q14ndmmd", "/patients/03q14ndmmd/appointments/6x505m94xc", "/patients/535rn1pbvb/recurring/4wmqk4lx5r",
    "/schedule?date=2026-10-14", "/schedule/providers/1x0jb5xxv1?date=2026-10-14", "/schedule/appointments?from=2026-10-14&to=2026-10-14",
    "/billing", "/billing/invoices/6b7q92km6g", "/documents", "/activity", "/patients/03q14ndmmd/documents/0l1jqh8zfg"]


async def main():
    async with WrenfieldClient("https://practice.speedrun.scopehealth.com") as wf:
        for p in PATHS:
            t = time.time()
            await wf.goto(p)
            dt = time.time() - t
            maps = await wf.main._maps()
            rep = await wf.main.page.evaluate(SCAN_JS, maps)
            print(f"\n##### {p}  nav={dt:.2f}s  scrambledFonts={list(maps.keys())}")
            for k, v in rep.items():
                if v:
                    print(f"  {k}: {v}")
        print("font warnings:", wf.fonts.warnings)

asyncio.run(main())
