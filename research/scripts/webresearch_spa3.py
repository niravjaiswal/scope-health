import asyncio, json
from playwright.async_api import async_playwright
OUT = "/Users/nirav/development/scope health/research/web/"
async def layer(pg): return await pg.evaluate("document.querySelector('#layer').innerText")
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(bypass_csp=True, viewport={"width":1600,"height":1000}, reduced_motion="reduce")
        pg = await ctx.new_page()
        await pg.goto("https://speedrun.scopehealth.com/", wait_until="networkidle")
        await pg.wait_for_timeout(2000)
        res={}
        for name in ["Agent interface","Reference agent","Rules"]:
            await pg.click('#dock [data-id="finder"]'); await pg.wait_for_timeout(1200)
            before = await layer(pg)
            el = pg.locator('#layer').get_by_text(name, exact=True).last
            await el.dblclick(timeout=5000); await pg.wait_for_timeout(2500)
            after = await layer(pg)
            pl=set(before.splitlines())
            res[name]="\n".join(l for l in after.splitlines() if l not in pl)
            print("==", name, len(res[name]))
        json.dump(res, open(OUT+"spa_docs_windows.json","w"), indent=1)
        await pg.click('#dock [data-id="library"]'); await pg.wait_for_timeout(1500)
        html = await pg.evaluate("document.querySelector('#layer').innerHTML")
        open(OUT+"spa_library.html","w").write(html)
        await b.close()
asyncio.run(main())
