import asyncio, sys
from playwright.async_api import async_playwright
BASE="https://practice.speedrun.scopehealth.com"
OUT="/Users/nirav/development/scope health/research/taxo/"
JS_INTER="""() => { const out=[]; document.querySelectorAll('a,button,input,select,textarea,[role=tab],[role=button],img,svg[role=img],canvas,iframe,object,embed').forEach(e=>{ let t=(e.innerText||e.value||e.getAttribute('aria-label')||e.getAttribute('alt')||e.getAttribute('placeholder')||'').trim().slice(0,80); let extra=''; if(e.tagName=='SELECT'){extra=' OPTIONS='+[...e.options].map(o=>o.text).join('|')} if(e.tagName=='A') extra+=' href='+e.getAttribute('href'); if(e.tagName=='IMG'||e.tagName=='IFRAME'||e.tagName=='OBJECT'||e.tagName=='EMBED') extra+=' src='+(e.getAttribute('src')||e.getAttribute('data')||'').slice(0,80); out.push(e.tagName+'['+(e.type||'')+'] '+t.replace(/\\n/g,' / ')+extra)}); return out.join('\\n'); }"""
async def dump(pg, name):
    await pg.wait_for_timeout(700)
    txt=f"URL {pg.url}\n"
    for f in pg.frames[1:]:
        try:
            txt+=f"\n== FRAME {f.url} ==\n"+(await f.inner_text("body"))
            txt+="\n== FRAME INTERACTIVE ==\n"+await f.evaluate(JS_INTER)
        except Exception as e: txt+=f"\nERR {e}"
    open(OUT+name+".txt","w").write(txt)
    print(name, len(txt))
    return txt
async def main(paths):
    async with async_playwright() as p:
        b=await p.chromium.launch(headless=True)
        ctx=await b.new_context(viewport={"width":1400,"height":1000}, bypass_csp=True)
        pg=await ctx.new_page()
        for path in paths:
            await pg.goto(BASE+path, wait_until="networkidle")
            await dump(pg, "p"+path.replace("/","_").replace("?","_").replace("&","_").replace("=","-")[:120])
        await b.close()
asyncio.run(main(sys.argv[1:]))
