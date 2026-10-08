import asyncio, json, sys
from playwright.async_api import async_playwright
OUT = "/Users/nirav/development/scope health/research/web/"
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(bypass_csp=True, viewport={"width":1440,"height":900}, reduced_motion="reduce")
        pg = await ctx.new_page()
        reqs = []
        pg.on("request", lambda r: reqs.append(r.method + " " + r.url))
        await pg.goto("https://speedrun.scopehealth.com/", wait_until="networkidle")
        await pg.wait_for_timeout(3000)
        txt = await pg.evaluate("document.body.innerText")
        open(OUT+"spa_home_text.txt","w").write(txt)
        dock = await pg.evaluate("""Array.from(document.querySelectorAll('#dock a, #dock button, .menubar button')).map(e=>({t:e.innerText, a:e.getAttribute('aria-label'), h:e.getAttribute('href'), d:JSON.stringify(e.dataset)}))""")
        print(json.dumps(dock, indent=1))
        print("\n".join(r for r in reqs if 'fonts' not in r))
        print("----TEXT----"); print(txt[:5000])
        await b.close()
asyncio.run(main())
