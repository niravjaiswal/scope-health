"""cartographer: interactive probes (search / pagination / filters) logging POSTs and URL changes. Read-only actions only."""
import asyncio, time, sys, json, os, re
from playwright.async_api import async_playwright
BASE = "https://practice.speedrun.scopehealth.com"


async def wait_ready(pg, timeout=10):
    t = time.time()
    while time.time() - t < timeout:
        fr = [f for f in pg.frames if "/v/" in f.url and f != pg.main_frame]
        if fr:
            try:
                ok = await fr[-1].evaluate("document.readyState!=='loading' && !document.documentElement.hasAttribute('aria-busy')")
                ok2 = await pg.evaluate("!document.documentElement.hasAttribute('aria-busy')")
                if ok and ok2:
                    return fr[-1]
            except Exception:
                pass
        await asyncio.sleep(0.03)
    return None


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=True)
        ctx = await b.new_context(viewport={"width": 1400, "height": 1000}, bypass_csp=True)
        pg = await ctx.new_page()
        log = []

        async def on_resp(r):
            req = r.request
            if req.method == "POST" or req.resource_type == "document":
                try:
                    body = await r.text()
                except Exception:
                    body = ""
                log.append((req.method, req.url.replace(BASE, ""), r.status, req.post_data, (req.frame.url.replace(BASE, "") if req.frame else None), body))
        pg.on("response", lambda r: asyncio.ensure_future(on_resp(r)))

        def dump(label):
            print(f"\n######## {label}  shell={pg.url.replace(BASE,'')}")
            for m, u, st, pd, fu, body in log:
                body2 = re.sub(r"<svg.*?</svg>", "", body, flags=re.S)
                body2 = re.sub(r"<script.*?</script>", "<script/>", body2, flags=re.S)
                print(f"  {m} {u} {st} post={pd} frame={fu}\n     body[{len(body)}]: {body2[:700]!r}")
            log.clear()

        await pg.goto(BASE + "/patients"); fr = await wait_ready(pg); await asyncio.sleep(0.5); dump("load /patients")
        await fr.fill("input[name=lastName]", "Murphy")
        await fr.press("input[name=lastName]", "Enter")
        await asyncio.sleep(0.3); fr = await wait_ready(pg); await asyncio.sleep(0.5); dump("search Murphy")
        print("FRAME URLS", [f.url for f in pg.frames])
        print((await fr.inner_text("body"))[:1500])

        await pg.goto(BASE + "/billing"); fr = await wait_ready(pg); await asyncio.sleep(0.3); log.clear()
        await fr.get_by_role("button", name="Next").click()
        await asyncio.sleep(0.3); fr = await wait_ready(pg); await asyncio.sleep(0.5); dump("billing Next")
        print("FRAME URLS", [f.url for f in pg.frames])
        txt = await fr.inner_text("body"); i = txt.find("Showing"); print(txt[i-300:i+100])

        await fr.select_option("select[name=size]", "100")
        await asyncio.sleep(0.3); fr = await wait_ready(pg); await asyncio.sleep(0.5); dump("billing size 100")
        txt = await fr.inner_text("body"); i = txt.find("Showing"); print(txt[i:i+100])
        await b.close()

asyncio.run(main())
