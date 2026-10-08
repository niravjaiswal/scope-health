import asyncio, time
from playwright.async_api import async_playwright
BASE="https://practice.speedrun.scopehealth.com"
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(headless=True)
        ctx=await b.new_context(viewport={"width":1400,"height":1000}, bypass_csp=True)
        pg=await ctx.new_page()
        reqs=[]
        pg.on("request", lambda r: reqs.append((r.method, r.url, (r.post_data or "")[:200])))
        t=time.time()
        await pg.goto(BASE+"/patients", wait_until="networkidle")
        print("load", time.time()-t)
        await pg.wait_for_timeout(1500)
        for r in reqs: print(r)
        print("FRAMES", [(f.name, f.url) for f in pg.frames])
        html=await pg.content()
        i=html.find('<main'); print(html[i:i+5000])
        for f in pg.frames[1:]:
            try:
                print("== frame", f.url); print((await f.inner_text("body"))[:3000])
            except Exception as e: print(e)
        await b.close()
asyncio.run(main())
