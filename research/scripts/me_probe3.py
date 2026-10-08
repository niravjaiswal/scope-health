import asyncio, time, sys
sys.path.insert(0,'research/scripts')
from me_probe2 import frame_ready
from playwright.async_api import async_playwright
BASE="https://practice.speedrun.scopehealth.com"
async def get(pg, path):
    t=time.time(); await pg.goto(BASE+path); f,txt=await frame_ready(pg); 
    links=await f.evaluate("Array.from(document.querySelectorAll('a')).map(a=>a.getAttribute('href'))") if f else []
    return time.time()-t, txt or '', links
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(headless=True)
        ctx=await b.new_context(viewport={"width":1400,"height":1000}, bypass_csp=True)
        pg=await ctx.new_page()
        for path in ["/patients?lastName=Dri","/patients?lastName=D","/patients?lastName=*","/patients?lastName=%25","/schedule","/billing","/documents","/activity","/about/notices"]:
            dt,txt,links=await get(pg,path)
            print(f"\n===== {path} {dt:.2f}s textlen={len(txt)} links={len(links)}")
            print(txt[:1800]); print(sorted(set(l for l in links if l))[:30])
        await b.close()
asyncio.run(main())
