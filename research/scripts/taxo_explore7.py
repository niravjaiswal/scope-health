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
    await pg.click("details summary"); await pg.wait_for_timeout(300)
    await pg.locator("details button", has_text=loc).first.click(); await pg.wait_for_timeout(1500)
async def activity(pg, action=None, record=None, name="act"):
    await pg.goto(BASE+"/activity", wait_until="networkidle"); await pg.wait_for_timeout(500)
    f=pg.frames[1]
    sels=await f.query_selector_all("select")
    # sels: user, action, record
    for s in sels:
        opts=await s.evaluate("e=>[...e.options].map(o=>o.text)")
        if action and action in opts and 'Merged' in opts: await s.select_option(label=action)
        if record and record in opts and 'Invoice' in opts: await s.select_option(label=record)
    await f.click("button[type=submit]"); await pg.wait_for_timeout(1500)
    t=await frame_text(pg); open(OUT+name+".txt","w").write(t); print(name,len(t))
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(headless=True)
        ctx=await b.new_context(viewport={"width":1400,"height":1000}, bypass_csp=True)
        pg=await ctx.new_page()
        await pg.goto(BASE+"/", wait_until="networkidle")
        await setloc(pg, "All locations")
        await activity(pg, action="Merged", name="act_merged")
        await activity(pg, action="Deleted", name="act_deleted")
        await activity(pg, record="User account", name="act_users")
        await activity(pg, record="Appointment", action="Changed", name="act_appt_changed")
        await activity(pg, record="Patient", action="Changed", name="act_patient_changed")
        await activity(pg, record="Document", name="act_docs")
        await activity(pg, record="Recurring appointment", name="act_recur")
        await activity(pg, action="Logged in", name="act_login")
        await b.close()
asyncio.run(main())
