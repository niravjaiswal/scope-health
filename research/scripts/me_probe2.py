import asyncio, time
from playwright.async_api import async_playwright
BASE="https://practice.speedrun.scopehealth.com"
async def frame_ready(pg, prev=None, timeout=10):
    t=time.time()
    while time.time()-t<timeout:
        fr=[f for f in pg.frames if '/v/' in f.url]
        if fr:
            f=fr[-1]
            try:
                txt=await f.evaluate("document.body ? document.body.innerText : ''")
                busy=await f.evaluate("document.documentElement.hasAttribute('aria-busy')")
                if txt.strip() and not busy and txt!=prev: return f, txt
            except Exception: pass
        await asyncio.sleep(0.05)
    return None, None
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(headless=True)
        ctx=await b.new_context(viewport={"width":1400,"height":1000}, bypass_csp=True)
        pg=await ctx.new_page()
        await pg.goto(BASE+"/patients"); f,txt=await frame_ready(pg)
        inputs=await f.evaluate("Array.from(document.querySelectorAll('input,button,select')).map(e=>[e.tagName,e.type,e.name,e.id,e.innerText])")
        print(inputs)
        t=time.time()
        await f.fill("input[name]", "Driscoll")
        await f.press("input[name]", "Enter")
        f2,txt2=await frame_ready(pg, prev=txt)
        print("search", time.time()-t, pg.url); print(txt2[:1200])
        links=await f2.evaluate("Array.from(document.querySelectorAll('a')).map(a=>[a.innerText.trim(),a.getAttribute('href')])")
        print(links[:20])
        href=[l for l in links if 'Driscoll' in l[0]][0][1]
        t=time.time(); await pg.goto(BASE+href); f3,txt3=await frame_ready(pg); print("chart", time.time()-t, pg.url); print(txt3[:2500])
        links=await f3.evaluate("Array.from(document.querySelectorAll('a')).map(a=>[a.innerText.trim(),a.getAttribute('href')])")
        print(links)
        await b.close()
if __name__=="__main__": asyncio.run(main())
