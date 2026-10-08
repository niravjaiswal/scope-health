import asyncio, sys, re, collections
from playwright.async_api import async_playwright
BASE="https://practice.speedrun.scopehealth.com"
OUT="/Users/nirav/development/scope health/research/taxo/"
async def setloc(pg, loc):
    await pg.click("details summary"); await pg.wait_for_timeout(300)
    await pg.locator("details button", has_text=loc).first.click(); await pg.wait_for_timeout(1500)
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(headless=True)
        ctx=await b.new_context(viewport={"width":1400,"height":2400}, bypass_csp=True)
        pg=await ctx.new_page()
        await pg.goto(BASE+"/", wait_until="networkidle")
        await setloc(pg, "All locations")
        await pg.goto(BASE+"/billing", wait_until="networkidle"); await pg.wait_for_timeout(800)
        f=pg.frames[1]
        # sort by amount owed largest first
        sels=await f.query_selector_all("select")
        for s in sels:
            opts=await s.evaluate("e=>[...e.options].map(o=>o.text)")
            if "Amount owed, largest first" in opts: await s.select_option(label="Amount owed, largest first")
        await pg.wait_for_timeout(1500)
        f=pg.frames[1]
        txt=await f.inner_text("body"); open(OUT+"billing_all_sorted.txt","w").write(txt)
        hrefs=await f.evaluate("()=>[...document.querySelectorAll('a')].map(a=>a.getAttribute('href')).filter(h=>h&&h.startsWith('/billing/invoices/'))")
        hrefs=list(dict.fromkeys(hrefs))[:6]
        descs=collections.Counter(); out=""
        for h in hrefs:
            await pg.goto(BASE+h, wait_until="networkidle"); await pg.wait_for_timeout(500)
            t=await pg.frames[1].inner_text("body")
            seg=t[t.find("Details"):]
            out+="\n#### "+h+"\n"+seg
        open(OUT+"invoices_sample.txt","w").write(out)
        # documents: statements and referral
        for typ in ["Statement","Referral letter"]:
            await pg.goto(BASE+"/documents", wait_until="networkidle"); await pg.wait_for_timeout(500)
            f=pg.frames[1]
            for s in await f.query_selector_all("select"):
                opts=await s.evaluate("e=>[...e.options].map(o=>o.text)")
                if typ in opts: await s.select_option(label=typ)
            await f.click("button[type=submit]"); await pg.wait_for_timeout(1500)
            f=pg.frames[1]
            t=await f.inner_text("body"); open(OUT+"docs_"+typ.replace(' ','_')+".txt","w").write(t)
            links=await f.evaluate("()=>[...document.querySelectorAll('a')].map(a=>[a.innerText,a.getAttribute('href')])")
            open(OUT+"docs_"+typ.replace(' ','_')+".txt","a").write("\n"+repr(links))
            # click first View
            vh=[l[1] for l in links if l[0].strip()=="View"]
            if vh:
                await pg.goto(BASE+vh[0], wait_until="networkidle"); await pg.wait_for_timeout(1500)
                for fr in pg.frames:
                    for im in await fr.query_selector_all("img"):
                        alt=await im.get_attribute("alt") or ""
                        if "Page" in alt:
                            await im.screenshot(path=OUT+"docimg_"+typ.replace(' ','_')+".png"); print("saved",typ,alt)
        await b.close()
asyncio.run(main())
