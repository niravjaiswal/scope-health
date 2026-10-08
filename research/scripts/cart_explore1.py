"""cartographer: log full protocol for one page load (read-only)."""
import asyncio, time, sys, json, os
from playwright.async_api import async_playwright
BASE = "https://practice.speedrun.scopehealth.com"
OUT = "/Users/nirav/development/scope health/research/cart_out"
os.makedirs(OUT, exist_ok=True)

async def main(path):
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=True)
        ctx = await b.new_context(viewport={"width": 1400, "height": 1000}, bypass_csp=True)
        pg = await ctx.new_page()
        log = []
        t0 = time.time()
        async def on_resp(r):
            req = r.request
            ent = {"t": round(time.time() - t0, 3), "m": req.method, "url": req.url, "st": r.status,
                   "post": req.post_data, "frame": (req.frame.url if req.frame else None)}
            try:
                if req.method == "POST" or req.resource_type in ("document",):
                    ent["body"] = (await r.text())[:20000]
            except Exception as e:
                ent["body_err"] = str(e)
            log.append(ent)
        pg.on("response", lambda r: asyncio.ensure_future(on_resp(r)))
        await pg.goto(BASE + path, wait_until="networkidle")
        await pg.wait_for_timeout(1500)
        print("cookies", [(c["name"], c["domain"], c["path"], c.get("expires")) for c in await ctx.cookies()])
        for e in log:
            print(e["t"], e["m"], e["st"], e["url"], "frame=", e["frame"], "post=", (e["post"] or "")[:200])
        print("FRAMES", [(f.name, f.url) for f in pg.frames])
        name = path.strip("/").replace("/", "_") or "root"
        json.dump(log, open(f"{OUT}/{name}_log.json", "w"), indent=1)
        open(f"{OUT}/{name}_shell.html", "w").write(await pg.content())
        for i, f in enumerate(pg.frames[1:]):
            open(f"{OUT}/{name}_frame{i}.html", "w").write(await f.content())
            print("== frame", f.url)
            print((await f.inner_text("body"))[:2500])
        await b.close()

asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else "/patients"))
