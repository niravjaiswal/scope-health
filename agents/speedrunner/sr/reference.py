"""Startup reference crawl: provider directory (name, credential, specialty, status) and other global facts."""
import asyncio, re
from .util import log

OPTS_JS = """() => { const out=[]; (function s(doc){ for (const sel of doc.querySelectorAll('select')) { for (const o of sel.options) {
  const g = o.parentElement && o.parentElement.tagName === 'OPTGROUP' ? o.parentElement.label : '';
  out.push([sel.name || sel.id || '', o.value, (o.textContent||'').trim(), g]); } }
  for (const f of doc.querySelectorAll('iframe')) { try { s(f.contentDocument) } catch(e){} } })(document); return out; }"""

CRED = re.compile(r",\s*(MD|DO|NP|PA|PA-C|DNP|RN|LCSW|PhD|DPT|PT|CNM|FNP|DPM)\b")


async def provider_directory(site):
    lines = []
    nav = {a.lower(): b for a, b in (site.nav or [])}
    for key in ("staff", "providers"):
        if key in nav:
            txt = await site.page(nav[key])
            if txt and not txt.startswith("ERROR"):
                lines.append(f"=== {nav[key]} (first page) ===\n" + txt[:15000])
    try:
        sched = await site.page("/schedule")
        m = re.search(r"Provider\s*<(/schedule/providers[^>]*)>", sched or "")
        if not m:
            return "\n".join(lines)
        ppath = m.group(1)
        async with site.sem:
            async with site.c.tab() as tab:
                await tab.goto(ppath)
                opts = await tab.page.evaluate(OPTS_JS)
        provs = [(v, t, g) for name, v, t, g in opts if CRED.search(t) and v]
        log("REF providers", len(provs), "via", ppath)
        if not provs:
            return "\n".join(lines)
        base = re.sub(r"/schedule/providers/[0-9a-z]+", "/schedule/providers/{id}", ppath.split("?")[0])
        paths = [base.replace("{id}", v) for v, t, g in provs]
        texts = [await site.page(pp, background=True) for pp in paths]
        rows = []
        for (v, t, g), tx in zip(provs, texts):
            spec = ""
            for l in (tx or "").splitlines():
                if "·" in l and re.search(r"(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)", l):
                    spec = l.split("·")[0].strip(); 
                    if "Inactive" in l and "Inactive" not in g: g = (g + " Inactive").strip()
                    if spec.lower() == "inactive":
                        parts = [p.strip() for p in l.split("·")]
                        spec = parts[1] if len(parts) > 2 else spec
                    break
            rows.append(f"{t} | id {v} | specialty: {spec or '?'} | {g or ''}")
        lines.append(f"=== Provider directory (from Schedule > Provider view; day view of one provider: {base.replace('{id}', '<id>')}?date=YYYY-MM-DD; 'Inactive' = left the group, keeps specialty) ===\n" + "\n".join(rows))
    except Exception as e:
        log("REF providers err", repr(e)[:200])
    return "\n".join(lines)


FORM_JS = """() => { const out=[]; const seen=new Set(); (function s(doc){
  for (const el of doc.querySelectorAll('input,select,textarea')) {
    if (el.type === 'hidden' || !el.name || el.name === 'theme') continue; const k = el.name; if (seen.has(k)) continue; seen.add(k);
    let lab = ''; if (el.labels && el.labels[0]) lab = el.labels[0].innerText.replace(/\\s+/g,' ').trim().slice(0,40); else if (el.getAttribute('aria-label')) lab = el.getAttribute('aria-label');
    let opts = ''; if (el.tagName === 'SELECT') { const o=[...el.options].map(x=>x.textContent.trim()); opts = ' options(' + o.length + '): ' + o.slice(0,14).join('; ') + (o.length>14?'; ...':''); }
    out.push((lab ? lab + ' ' : '') + '[' + el.tagName.toLowerCase() + ' name=' + k + (el.type && el.tagName==='INPUT' ? ' type=' + el.type : '') + ']' + opts); }
  for (const b of doc.querySelectorAll('button')) { const t=(b.innerText||'').replace(/\\s+/g,' ').trim(); if (t && t.length < 30 && !seen.has('btn:'+t)) { seen.add('btn:'+t); out.push('button: ' + t); } }
  for (const f of doc.querySelectorAll('iframe')) { try { s(f.contentDocument) } catch(e){} } })(document); return out; }"""


async def site_map(site):
    """Compact map of every nav section: sub-links (with ids abstracted) and form fields/buttons."""
    lines = []
    navset = set(h for _, h in (site.nav or []))
    for label, href in (site.nav or []):
        if not href or href in ("#main",) or "logout" in href or href.endswith("/all"):
            continue
        try:
            async with site.bg_sem:
                async with site.c.tab() as tab:
                    await asyncio.wait_for(tab.goto(href), timeout=site.page_timeout)
                    links = await tab.links()
                    fields = await tab.page.evaluate(FORM_JS)
        except Exception as e:
            lines.append(f"## {label} <{href}>: (failed {type(e).__name__})"); continue
        pats = []
        for l in links:
            h = (l.get("href") or "") if isinstance(l, dict) else (l[1] if isinstance(l, (list, tuple)) and len(l) > 1 else "")
            t = (l.get("text") or "") if isinstance(l, dict) else (l[0] if isinstance(l, (list, tuple)) else "")
            h = re.sub(r"^https?://[^/]+", "", h)
            if not h.startswith("/") or h.startswith("/v/") or h.startswith("/static") or h in navset or h.startswith("/about"):
                continue
            ab = re.sub(r"/[0-9a-z]{10}(?=/|$|\?)", "/<id>", h)
            ab = re.sub(r"=\d{4}-\d{2}-\d{2}", "=YYYY-MM-DD", ab)
            key = ab
            if key not in [p[0] for p in pats]:
                pats.append((key, t.strip()[:40]))
        sub = "; ".join(f"{t + ' ' if t and '<id>' not in k else ''}<{k}>" for k, t in pats[:30])
        lines.append(f"## {label} <{href}>\nlinks: {sub}\nform: {' | '.join(fields[:25])}")
    return "\n".join(lines)
