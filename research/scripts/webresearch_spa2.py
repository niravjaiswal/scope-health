import asyncio, json
from playwright.async_api import async_playwright
OUT = "/Users/nirav/development/scope health/research/web/"
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(bypass_csp=True, viewport={"width":1600,"height":1000}, reduced_motion="reduce")
        pg = await ctx.new_page()
        api = []
        async def onresp(r):
            if "api.speedrun" in r.url:
                try: body = await r.text()
                except Exception: body = "<err>"
                api.append((r.request.method, r.url, r.status, body[:20000]))
        pg.on("response", lambda r: asyncio.ensure_future(onresp(r)))
        await pg.goto("https://speedrun.scopehealth.com/", wait_until="networkidle")
        await pg.wait_for_timeout(2000)
        base = await pg.evaluate("document.querySelector('#layer').innerText")
        out = {}
        for wid in ["welcome","guide","prizes","messages","board","library","about","finder","trash"]:
            try:
                await pg.click(f'#dock [data-id="{wid}"]', timeout=5000)
                await pg.wait_for_timeout(2500)
                t = await pg.evaluate("document.querySelector('#layer').innerText")
                out[wid] = t
            except Exception as e:
                out[wid] = "ERR " + str(e)
        json.dump(out, open(OUT+"spa_windows.json","w"), indent=1)
        json.dump(api, open(OUT+"spa_api.json","w"), indent=1)
        for k,v in out.items(): print("=====",k,len(v))
        for m,u,s,bd in api: print(m,u,s,len(bd))
        await b.close()
asyncio.run(main())
