import asyncio
from playwright.async_api import async_playwright
BASE="https://practice.speedrun.scopehealth.com"
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(headless=True)
        ctx=await b.new_context(viewport={"width":1400,"height":1400}, bypass_csp=True)
        pg=await ctx.new_page()
        for pid in ["1ng9xl9wkn","3xn04x0076","547lkhvbrg","042xngpx1b"]:
            await pg.goto(BASE+f"/schedule/providers/{pid}?date=2026-10-14", wait_until="networkidle"); await pg.wait_for_timeout(500)
            f=pg.frames[1]
            print(await f.evaluate("()=>[...document.querySelectorAll('h1,h2,p,header')].slice(0,8).map(e=>e.innerText.replace(/\\n/g,' | ').slice(0,150)).join(' || ')"))
        # appointment list with filters: count line
        await pg.goto(BASE+"/schedule/appointments?from=2026-10-01&to=2026-10-31&status=5", wait_until="networkidle"); await pg.wait_for_timeout(800)
        for f in pg.frames:
            try:
                t=await f.inner_text("body")
                import re
                for m in re.finditer(r"(Showing[^\n]*|\d+ appointments?|Appointments from[^\n]*)", t): print("LIST:",m.group(0))
            except Exception: pass
        await b.close()
asyncio.run(main())
