import asyncio, sys, re
from playwright.async_api import async_playwright
BASE="https://practice.speedrun.scopehealth.com"
OUT="/Users/nirav/development/scope health/research/taxo/"
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(headless=True)
        ctx=await b.new_context(viewport={"width":1400,"height":1000}, bypass_csp=True)
        pg=await ctx.new_page()
        await pg.goto(BASE+"/patients/535rn1pbvb", wait_until="networkidle")
        await pg.wait_for_timeout(800)
        await pg.screenshot(path=OUT+"chart.png")
        f=pg.frames[1]
        html=await f.content()
        open(OUT+"chart_frame.html","w").write(html)
        # computed font family of elements containing MRN / phone / email
        info=await f.evaluate("""()=>{const out=[];const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let n;while(n=w.nextNode()){const t=n.textContent.trim();if(!t)continue;const el=n.parentElement;const cs=getComputedStyle(el);out.push(t.slice(0,40)+' || '+cs.fontFamily.slice(0,60)+' || '+el.tagName);}return out.join('\\n')}""")
        open(OUT+"chart_fonts.txt","w").write(info)
        # shell html
        open(OUT+"chart_shell.html","w").write(await pg.content())
        await b.close()
asyncio.run(main())
