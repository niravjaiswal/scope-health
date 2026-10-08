# ONE-TIME allowed write: request access to ONE restricted chart with reason "Billing or insurance question"; then observe (GET only)
import asyncio, sys, time
sys.path.insert(0, "/Users/nirav/development/scope health/research/scripts")
from inv_lib import *
from inv_run import set_all_locations, fmt
PID="/patients/3mb3fmvpqf"
async def main():
    async with async_playwright() as p:
        b,ctx=await open_browser(p); pg=await ctx.new_page()
        posts=[]
        pg.on("request", lambda r: posts.append((round(time.time()),r.method, r.url[-40:], (r.post_data or "")[:200])) if r.method=="POST" else None)
        await goto(pg, "/"); await set_all_locations(pg)
        f=await goto(pg, PID)
        await f.select_option("select[name=reason]", label="Billing or insurance question")
        t0=time.time()
        await f.get_by_role("button", name="Request access").click()
        await settle(pg, 1500)
        f=content_frame(pg)
        out=await fmt(pg,f); dump("restricted_after_request.txt", out); print("== AFTER REQUEST", round(time.time()-t0,1)); print(out[:3000])
        print("POSTS", posts)
        for tab in ["", "/appointments", "/documents", "/notes", "/activity"]:
            f=await goto(pg, PID+tab); out=await fmt(pg,f); dump("restricted_open"+(tab.replace('/','_') or "_demographics")+".txt", out)
            print("== TAB", tab, round(time.time()-t0,1)); print(out[:1500])
        f=await goto(pg, "/patients"); print("== /patients requests table"); print((await text(f))[-800:])
        # observe expiry (GET only), every 30s up to 10 min
        for i in range(20):
            await pg.wait_for_timeout(30000)
            f=await goto(pg, PID); t=await text(f)
            st="RESTRICTED-GATE" if "This chart is restricted" in t else "OPEN"
            print("t+%ds"%round(time.time()-t0), st, t[:120].replace("\n"," | "))
            if st!="OPEN":
                dump("restricted_after_expiry.txt", await fmt(pg,f)); break
        await b.close()
asyncio.run(main())
