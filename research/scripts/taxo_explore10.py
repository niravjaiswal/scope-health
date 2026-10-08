import asyncio, sys, re
from playwright.async_api import async_playwright
BASE="https://practice.speedrun.scopehealth.com"
OUT="/Users/nirav/development/scope health/research/taxo/"
async def setloc(pg, loc):
    await pg.click("details summary"); await pg.wait_for_timeout(300)
    await pg.locator("details button", has_text=loc).first.click(); await pg.wait_for_timeout(1500)
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(headless=True)
        ctx=await b.new_context(viewport={"width":1400,"height":1400}, bypass_csp=True)
        pg=await ctx.new_page()
        await pg.goto(BASE+"/", wait_until="networkidle"); await setloc(pg,"All locations")
        for pid,name in [("1ng9xl9wkn","shaw"),("3xn04x0076","west"),("547lkhvbrg","williamson")]:
            for d in ["2026-10-14","2026-10-15"]:
                await pg.goto(BASE+f"/schedule/providers/{pid}?date={d}", wait_until="networkidle"); await pg.wait_for_timeout(600)
                t=await pg.frames[1].inner_text("body")
                i=t.find("Provider\n"); j=t.find("Joe Wilson, PA")
                print("####",name,d); print((t[:i]+t[j+15:])[:1500])
        for dob in ["1939-12-04"]:
            await pg.goto(BASE+"/patients", wait_until="networkidle")
            f=pg.frames[1]; await f.fill("#dob", dob); await f.click("button[type=submit]"); await pg.wait_for_timeout(1500)
            t=await pg.frames[1].inner_text("body"); print("#### dob",dob, t[t.find("Results"):t.find("Restricted chart requests")])
        await b.close()
asyncio.run(main())
