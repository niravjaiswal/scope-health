import asyncio, sys
from playwright.async_api import async_playwright
BASE="https://practice.speedrun.scopehealth.com"
OUT="/Users/nirav/development/scope health/research/taxo/"
async def main(items):
    async with async_playwright() as p:
        b=await p.chromium.launch(headless=True)
        ctx=await b.new_context(viewport={"width":1400,"height":1000}, bypass_csp=True)
        pg=await ctx.new_page()
        for path,name in items:
            await pg.goto(BASE+path, wait_until="networkidle"); await pg.wait_for_timeout(1000)
            for f in pg.frames:
                imgs=await f.query_selector_all("img")
                for im in imgs:
                    alt=await im.get_attribute("alt") or ""
                    if "Page" in alt:
                        await im.screenshot(path=OUT+name+".png"); print("saved",name,alt)
        await b.close()
args=sys.argv[1:]
asyncio.run(main(list(zip(args[::2],args[1::2]))))
