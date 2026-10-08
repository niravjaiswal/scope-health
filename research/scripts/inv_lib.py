# data inventory analyst helpers (read-only exploration)
import asyncio, time, os, re, json, sys
from playwright.async_api import async_playwright
BASE="https://practice.speedrun.scopehealth.com"
DUMPS="/Users/nirav/development/scope health/research/dumps"

async def open_browser(p):
    b=await p.chromium.launch(headless=True)
    ctx=await b.new_context(viewport={"width":1500,"height":1100}, bypass_csp=True)
    return b, ctx

def content_frame(pg):
    fr=[f for f in pg.frames if f is not pg.main_frame]
    return fr[-1] if fr else pg.main_frame

async def wait_frame(pg, timeout=15000):
    t=time.time()
    while time.time()-t<timeout/1000:
        fr=[f for f in pg.frames if f is not pg.main_frame]
        if fr:
            f=fr[-1]
            try:
                txt=await f.inner_text("body", timeout=2000)
                if txt.strip(): return f
            except Exception: pass
        await pg.wait_for_timeout(200)
    return content_frame(pg)

async def goto(pg, path):
    await pg.goto(BASE+path, wait_until="networkidle")
    f=await wait_frame(pg)
    await pg.wait_for_timeout(500)
    return f

async def settle(pg, ms=800):
    try: await pg.wait_for_load_state("networkidle", timeout=8000)
    except Exception: pass
    await pg.wait_for_timeout(ms)

async def text(f):
    return await f.inner_text("body")

async def interactive(f):
    return await f.evaluate("""()=>{const out=[];document.querySelectorAll('a,button,input,select,textarea,[role=tab],[role=button],summary').forEach((e,i)=>{out.push({i,tag:e.tagName,role:e.getAttribute('role'),type:e.type||'',name:e.name||'',text:(e.innerText||e.value||e.getAttribute('aria-label')||e.placeholder||'').trim().slice(0,80),href:e.getAttribute('href')||'',aria:e.getAttribute('aria-label')||'',sel:e.getAttribute('aria-selected')||e.getAttribute('aria-current')||''})});return out}""")

def dump(name, txt):
    with open(os.path.join(DUMPS, name), "w") as fh: fh.write(txt)
