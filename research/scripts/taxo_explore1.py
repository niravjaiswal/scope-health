import asyncio, time, sys, json
from playwright.async_api import async_playwright
BASE="https://practice.speedrun.scopehealth.com"
OUT="/Users/nirav/development/scope health/research/taxo/"
PAGES=["/","/patients","/patients/all","/schedule","/billing","/documents","/activity","/about/notices"]
JS_INTER="""() => { const out=[]; document.querySelectorAll('a,button,input,select,textarea,[role=tab],[role=button]').forEach(e=>{ let t=(e.innerText||e.value||e.getAttribute('aria-label')||e.getAttribute('placeholder')||'').trim().slice(0,80); let extra=''; if(e.tagName=='SELECT'){extra=' OPTIONS='+[...e.options].map(o=>o.text).join('|')} if(e.tagName=='A') extra+=' href='+e.getAttribute('href'); out.push(e.tagName+'['+(e.type||'')+'] '+t+extra)}); return out.join('\\n'); }"""
async def dump(pg, name):
    await pg.wait_for_timeout(800)
    txt="== SHELL ==\n"+(await pg.inner_text("body"))[:4000]
    txt+="\n== SHELL INTERACTIVE ==\n"+await pg.evaluate(JS_INTER)
    for f in pg.frames[1:]:
        try:
            txt+=f"\n== FRAME {f.url} ==\n"+(await f.inner_text("body"))
            txt+="\n== FRAME INTERACTIVE ==\n"+await f.evaluate(JS_INTER)
        except Exception as e: txt+=f"\nERR {e}"
    open(OUT+name+".txt","w").write(txt)
    print(name, len(txt))
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(headless=True)
        ctx=await b.new_context(viewport={"width":1400,"height":1000}, bypass_csp=True)
        pg=await ctx.new_page()
        for path in PAGES:
            await pg.goto(BASE+path, wait_until="networkidle")
            await dump(pg, "page"+path.replace("/","_"))
        await b.close()
asyncio.run(main())
