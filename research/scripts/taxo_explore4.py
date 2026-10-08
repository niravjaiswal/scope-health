import asyncio, sys
from playwright.async_api import async_playwright
BASE="https://practice.speedrun.scopehealth.com"
OUT="/Users/nirav/development/scope health/research/taxo/"
JS_INTER="""() => { const out=[]; document.querySelectorAll('a,button,input,select,textarea,img,iframe,object,embed,canvas').forEach(e=>{ let t=(e.innerText||e.value||e.getAttribute('aria-label')||e.getAttribute('alt')||e.getAttribute('placeholder')||'').trim().slice(0,80); let extra=''; if(e.tagName=='A') extra+=' href='+e.getAttribute('href'); if(['IMG','IFRAME','OBJECT','EMBED'].includes(e.tagName)) extra+=' src='+(e.getAttribute('src')||e.getAttribute('data')||'').slice(0,100); out.push(e.tagName+'['+(e.type||'')+'] '+t.replace(/\\n/g,' / ')+extra)}); return out.join('\\n'); }"""
async def frame_text(pg):
    txt=f"URL {pg.url}\n"
    for f in pg.frames[1:]:
        try:
            txt+=f"\n== FRAME {f.url} ==\n"+(await f.inner_text("body"))+"\n== FRAME INTERACTIVE ==\n"+await f.evaluate(JS_INTER)
        except Exception as e: txt+=f"\nERR {e}"
    return txt
async def search(pg, last=None, dob=None, name="search"):
    await pg.goto(BASE+"/patients", wait_until="networkidle")
    f=pg.frames[1]
    if last: await f.fill("#lastName, input:not([type])", last)
    if dob: await f.fill("#dob, input[type=date]", dob)
    await f.click("button[type=submit]")
    await pg.wait_for_timeout(1500)
    t=await frame_text(pg); open(OUT+name+".txt","w").write(t); print(name,len(t))
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(headless=True)
        ctx=await b.new_context(viewport={"width":1400,"height":1000}, bypass_csp=True)
        pg=await ctx.new_page()
        await search(pg,"Ramirez",name="s_ramirez")
        await search(pg,"Martinez",name="s_martinez")
        await search(pg,"Martínez",name="s_martinez_acc")
        await search(pg,dob="2010-01-10",name="s_dob")
        for path,name in [("/patients/535rn1pbvb/documents/33svbjbwc6","docview_referral"),("/patients/535rn1pbvb/documents/2rmsqvd0l4","docview_lab"),("/patients/2q123zlg2m","restricted_porter")]:
            await pg.goto(BASE+path, wait_until="networkidle"); await pg.wait_for_timeout(800)
            t=await frame_text(pg); open(OUT+name+".txt","w").write(t); print(name,len(t))
            await pg.screenshot(path=OUT+name+".png", full_page=True)
        # location switcher
        await pg.goto(BASE+"/", wait_until="networkidle")
        open(OUT+"locbuttons.txt","w").write(await pg.evaluate("()=>[...document.querySelectorAll(\"button\")].map(e=>e.innerText.replace(/\\n/g,\" | \")).join(\"\\n\")"))
        btn=pg.locator("button:has-text(\"Northgate\")").last
        await btn.click(); await pg.wait_for_timeout(600)
        open(OUT+"locswitch.txt","w").write(await pg.inner_text("body"))
        await pg.screenshot(path=OUT+"locswitch.png")
        await b.close()
asyncio.run(main())
