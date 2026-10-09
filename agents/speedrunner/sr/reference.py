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
            rows.append(f"{t} | specialty: {spec or '?'} | {g or ''}")
        lines.append("=== Provider directory (from Schedule > Provider view; 'Inactive' = left the group, keeps specialty) ===\n" + "\n".join(rows))
    except Exception as e:
        log("REF providers err", repr(e)[:200])
    return "\n".join(lines)
