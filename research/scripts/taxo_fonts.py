import asyncio, re
from playwright.async_api import async_playwright
BASE="https://practice.speedrun.scopehealth.com"
OUT="/Users/nirav/development/scope health/research/taxo/"
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(headless=True)
        ctx=await b.new_context(viewport={"width":1400,"height":1000}, bypass_csp=True)
        pg=await ctx.new_page()
        fonts={}
        async def on_resp(r):
            if r.request.resource_type=="font" or r.url.endswith(".woff") or r.url.endswith(".woff2"):
                try: fonts[r.url]=await r.body()
                except Exception as e: print("fonterr",e)
        pg.on("response", on_resp)
        await pg.goto(BASE+"/patients/535rn1pbvb/insurance", wait_until="networkidle")
        await pg.wait_for_timeout(1000)
        f=pg.frames[1]
        css=await f.evaluate("""()=>{let o=[];for(const s of document.styleSheets){try{for(const r of s.cssRules){if(r.cssText.includes('font-face'))o.push(r.cssText.slice(0,300))}}catch(e){o.push('ERR '+e)}}return o.join('\\n')}""")
        print(css)
        info=await f.evaluate("""()=>{const out=[];const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let n;while(n=w.nextNode()){const t=n.textContent.trim();if(!t)continue;const el=n.parentElement;const cs=getComputedStyle(el);if(!cs.fontFamily.includes('Atkinson'))out.push(t.slice(0,40)+' || '+cs.fontFamily.slice(0,60));}return out.join('\\n')}""")
        print(info)
        await pg.screenshot(path=OUT+"insurance.png")
        for u,bts in fonts.items():
            print(u, len(bts))
            open(OUT+"font_"+u.split("/")[-1],"wb").write(bts)
        await b.close()
asyncio.run(main())
