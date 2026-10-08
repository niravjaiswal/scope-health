import asyncio, time
from playwright.async_api import async_playwright
BASE="https://practice.speedrun.scopehealth.com"
async def frame_ready(pg, timeout=10):
    t=time.time()
    while time.time()-t<timeout:
        fr=[f for f in pg.frames if '/v/' in f.url]
        if fr:
            try:
                txt=await fr[-1].evaluate("document.body ? document.body.innerText : ''")
                busy=await fr[-1].evaluate("document.documentElement.hasAttribute('aria-busy')")
                if txt.strip() and not busy: return fr[-1]
            except Exception: pass
        await asyncio.sleep(0.05)
    return None
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(headless=True)
        ctx=await b.new_context(viewport={"width":1400,"height":1000}, bypass_csp=True)
        pg=await ctx.new_page()
        t=time.time(); await pg.goto(BASE+"/patients/all"); f=await frame_ready(pg); print("all", time.time()-t)
        txt=await f.evaluate("document.body.innerText"); print(txt[:1500])
        links=await f.evaluate("Array.from(document.querySelectorAll('a')).map(a=>[a.innerText.trim(),a.getAttribute('href'),a.getAttribute('target')]).slice(0,40)")
        print(links)
        btns=await f.evaluate("Array.from(document.querySelectorAll('button,[role=tab],select,input')).map(e=>[e.tagName,e.innerText?.trim()||e.name||e.value, e.getAttribute('aria-label')]).slice(0,60)")
        print(btns)
        await b.close()
asyncio.run(main())
