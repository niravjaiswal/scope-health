import asyncio, sys, re
from playwright.async_api import async_playwright
BASE="https://practice.speedrun.scopehealth.com"
OUT="/Users/nirav/development/scope health/research/taxo/"
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(headless=True)
        ctx=await b.new_context(viewport={"width":1400,"height":1400}, bypass_csp=True)
        pg=await ctx.new_page()
        await pg.goto(BASE+"/schedule/providers/4vqb93p4g9?date=2026-10-14", wait_until="networkidle"); await pg.wait_for_timeout(600)
        f=pg.frames[1]
        html=await f.content()
        i=html.find("Ann Shaw"); print(html[i-400:i+200])
        opts=await f.evaluate("()=>{const s=[...document.querySelectorAll('select')][0]; return s?[...s.options].map(o=>[o.text,o.value]):null}")
        print(opts[-10:] if opts else None)
        await b.close()
asyncio.run(main())
