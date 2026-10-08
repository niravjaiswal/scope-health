"""cartographer: load a page and dump every frame (recursive) - url, inner_text, html snippet. Read-only."""
import asyncio, time, sys, os, re
from playwright.async_api import async_playwright
BASE = "https://practice.speedrun.scopehealth.com"
OUT = "/Users/nirav/development/scope health/research/cart_out/frames"
os.makedirs(OUT, exist_ok=True)


async def main(paths, ntext):
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=True)
        ctx = await b.new_context(viewport={"width": 1400, "height": 1000}, bypass_csp=True)
        pg = await ctx.new_page()
        reqs = []
        pg.on("request", lambda r: reqs.append((r.method, r.resource_type, r.url.replace(BASE, ""))))
        for path in paths:
            reqs.clear()
            t = time.time()
            await pg.goto(BASE + path, wait_until="networkidle")
            dt = time.time() - t
            print(f"\n######## {path} networkidle={dt:.2f}s shell={pg.url.replace(BASE,'')}")
            print("  reqs:", [r for r in reqs if not r[2].endswith(('.woff2', '.css'))])
            fn = re.sub(r"[^a-zA-Z0-9]+", "_", path).strip("_")
            for i, f in enumerate(pg.frames):
                depth = 0; pf = f.parent_frame
                while pf: depth += 1; pf = pf.parent_frame
                html = await f.content()
                open(f"{OUT}/{fn}_f{i}.html", "w").write(html)
                if i == 0:
                    continue
                try:
                    txt = await f.inner_text("body")
                except Exception as e:
                    txt = str(e)
                print(f"  -- frame{i} depth={depth} url={f.url.replace(BASE,'')} name={f.name!r} len={len(html)}")
                print("    " + txt[:ntext].replace("\n", "\n    "))
        await b.close()

asyncio.run(main(sys.argv[1].split(","), int(sys.argv[2]) if len(sys.argv) > 2 else 1500))
