import asyncio, time, sys
from playwright.async_api import async_playwright
BASE="https://practice.speedrun.scopehealth.com"
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(headless=True)
        ctx=await b.new_context(viewport={"width":1400,"height":1000}, bypass_csp=True)
        pg=await ctx.new_page()
        for path in ["/","/patients","/patients/all","/schedule","/billing","/documents","/activity"]:
            t=time.time()
            await pg.goto(BASE+path, wait_until="domcontentloaded")
            # wait until no aria-busy and loading spinner gone
            try:
                await pg.wait_for_function("!document.documentElement.hasAttribute('aria-busy') && !document.querySelector('main [role=status]')", timeout=10000)
            except Exception as e: print("wait err",e)
            txt=await pg.inner_text("main")
            print(f"=== {path} {time.time()-t:.2f}s url={pg.url} len={len(txt)}")
            print(txt[:1500])
        await b.close()
asyncio.run(main())
