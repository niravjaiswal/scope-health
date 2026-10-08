import asyncio
from playwright.async_api import async_playwright
BASE="https://practice.speedrun.scopehealth.com"
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(headless=True)
        ctx=await b.new_context(viewport={"width":1400,"height":1000}, bypass_csp=True)
        pg=await ctx.new_page()
        await pg.goto(BASE+"/patients", wait_until="networkidle")
        await pg.wait_for_timeout(800)
        for f in pg.frames:
            print(f.url, f.name)
            try:
                print(await f.evaluate("()=>[...document.querySelectorAll('input,button')].map(e=>e.outerHTML.slice(0,200)).join('\\n')"))
            except Exception as e: print(e)
        await b.close()
asyncio.run(main())
