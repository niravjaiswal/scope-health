import asyncio, sys
from playwright.async_api import async_playwright
BASE="https://practice.speedrun.scopehealth.com"
OUT="/Users/nirav/development/scope health/research/taxo/"
JS_INTER="""() => { const out=[]; document.querySelectorAll('a,button,input,select,textarea,img,iframe').forEach(e=>{ let t=(e.innerText||e.value||e.getAttribute('aria-label')||e.getAttribute('alt')||'').trim().slice(0,80); let extra=''; if(e.tagName=='A') extra+=' href='+e.getAttribute('href'); out.push(e.tagName+' '+t.replace(/\\n/g,' / ')+extra)}); return out.join('\\n'); }"""
async def frame_text(pg):
    txt=f"URL {pg.url}\n"
    for f in pg.frames[1:]:
        try: txt+=f"\n== FRAME {f.url} ==\n"+(await f.inner_text("body"))+"\n== FRAME INTERACTIVE ==\n"+await f.evaluate(JS_INTER)
        except Exception as e: txt+=f"\nERR {e}"
    return txt
async def setloc(pg, loc):
    await pg.click("details summary")
    await pg.wait_for_timeout(300)
    await pg.locator("details button", has_text=loc).first.click()
    await pg.wait_for_timeout(1500)
async def search(pg, last=None, dob=None, name="search"):
    await pg.goto(BASE+"/patients", wait_until="networkidle")
    f=pg.frames[1]
    if last: await f.fill("#lastName", last)
    if dob: await f.fill("#dob", dob)
    await f.click("button[type=submit]")
    await pg.wait_for_timeout(1500)
    t=await frame_text(pg); open(OUT+name+".txt","w").write(t); print(name,len(t))
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(headless=True)
        ctx=await b.new_context(viewport={"width":1400,"height":1000}, bypass_csp=True)
        pg=await ctx.new_page()
        await pg.goto(BASE+"/", wait_until="networkidle")
        await setloc(pg, "All locations")
        print("summary:", await pg.inner_text("details summary"))
        t=await frame_text(pg); open(OUT+"all_dashboard.txt","w").write(t)
        await search(pg,"Gray",name="sa_gray")
        await search(pg,dob="2010-01-10",name="sa_dob")
        await search(pg,"Singh",name="sa_singh")
        await search(pg,"Driscoll",name="sa_driscoll")
        await pg.goto(BASE+"/schedule", wait_until="networkidle"); await pg.wait_for_timeout(800)
        t=await frame_text(pg); open(OUT+"all_schedule.txt","w").write(t)
        await setloc(pg, "Front Range")
        await pg.goto(BASE+"/schedule", wait_until="networkidle"); await pg.wait_for_timeout(800)
        t=await frame_text(pg); open(OUT+"fr_schedule.txt","w").write(t)
        await pg.goto(BASE+"/", wait_until="networkidle"); await pg.wait_for_timeout(800)
        t=await frame_text(pg); open(OUT+"fr_dashboard.txt","w").write(t)
        await b.close()
asyncio.run(main())
