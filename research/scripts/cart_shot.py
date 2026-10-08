"""cartographer: screenshot a page + dump CSS/fonts used by the iframe (read-only)."""
import asyncio, time, sys, json, os, re
from playwright.async_api import async_playwright
BASE = "https://practice.speedrun.scopehealth.com"
OUT = "/Users/nirav/development/scope health/research/cart_out"
os.makedirs(OUT, exist_ok=True)

async def main(path, tag):
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=True)
        ctx = await b.new_context(viewport={"width": 1400, "height": 1000}, bypass_csp=True)
        pg = await ctx.new_page()
        bodies = {}
        async def on_resp(r):
            u = r.url
            if u.endswith(".css") or u.endswith(".woff2") or u.endswith(".woff"):
                try:
                    bodies[u] = await r.body()
                except Exception:
                    pass
        pg.on("response", lambda r: asyncio.ensure_future(on_resp(r)))
        await pg.goto(BASE + path, wait_until="networkidle")
        await pg.wait_for_timeout(800)
        await pg.screenshot(path=f"{OUT}/{tag}.png", full_page=True)
        for u, bd in bodies.items():
            fn = u.rsplit("/", 1)[1]
            open(f"{OUT}/asset_{fn}", "wb").write(bd)
            print(u, len(bd))
        await b.close()

asyncio.run(main(sys.argv[1], sys.argv[2]))
