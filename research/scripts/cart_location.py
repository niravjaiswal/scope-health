"""cartographer: test the 'Work at location' switcher: is it per-session? what does it change? (session preference only)"""
import asyncio, time, sys, os, re
from playwright.async_api import async_playwright
BASE = "https://practice.speedrun.scopehealth.com"


async def ready(pg, timeout=10):
    t = time.time()
    while time.time() - t < timeout:
        fr = [f for f in pg.frames if "/v/" in f.url]
        if fr:
            try:
                if await fr[-1].evaluate("document.readyState!=='loading' && !document.documentElement.hasAttribute('aria-busy') && !document.body.hasAttribute('inert')") and \
                        await pg.evaluate("!document.documentElement.hasAttribute('aria-busy')"):
                    return fr[-1]
            except Exception:
                pass
        await asyncio.sleep(0.03)


async def loc_label(pg):
    return await pg.evaluate("(()=>{const s=[...document.querySelectorAll('summary')].find(x=>/location/i.test(x.getAttribute('aria-label')||''));return s&&s.getAttribute('aria-label')})()")


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=True)
        ctxA = await b.new_context(viewport={"width": 1400, "height": 1000}, bypass_csp=True)
        ctxB = await b.new_context(viewport={"width": 1400, "height": 1000}, bypass_csp=True)
        A = await ctxA.new_page(); B = await ctxB.new_page()
        log = []
        async def on_resp(r):
            if r.request.method == "POST" or r.request.resource_type == "document":
                try: body = await r.text()
                except Exception: body = ""
                log.append((r.request.method, r.url.replace(BASE, ""), r.status, r.request.post_data, body))
        A.on("response", lambda r: asyncio.ensure_future(on_resp(r)))
        await A.goto(BASE + "/billing"); await ready(A)
        print("A before:", await loc_label(A), A.url)
        print("A cookies:", [(c['name'], c['value'][:6] + '...') for c in await ctxA.cookies()])
        log.clear()
        # open the details and click "All locations"
        summ = A.locator("summary[aria-label*='ocation']")
        await summ.click()
        await A.get_by_role("button", name=re.compile("All locations")).click()
        await asyncio.sleep(0.4); await ready(A); await asyncio.sleep(0.6)
        for m, u, st, pd, body in log:
            body2 = re.sub(r"<svg.*?</svg>", "", body, flags=re.S)
            print(f"  {m} {u} {st} post={pd}\n     body[{len(body)}]: {body2[:600]!r}")
        print("A after:", await loc_label(A), A.url)
        print("A cookies:", [(c['name'], c['value'][:6] + '...') for c in await ctxA.cookies()])
        fr = await ready(A)
        txt = await fr.inner_text("body"); i = txt.find("Invoice\t"); print(txt[i:i+400])
        await B.goto(BASE + "/billing"); await ready(B)
        print("B fresh session:", await loc_label(B))
        # A: reload to see if persisted in session
        await A.goto(BASE + "/schedule"); fr = await ready(A)
        print("A after reload:", await loc_label(A), A.url)
        txt = await fr.inner_text("body"); print(txt[:300])
        await b.close()

asyncio.run(main())
