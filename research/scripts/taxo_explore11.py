import asyncio, sys, re, collections
from playwright.async_api import async_playwright
BASE="https://practice.speedrun.scopehealth.com"
OUT="/Users/nirav/development/scope health/research/taxo/"
IDS=["3swl6qfzhr","53twnlcd3s","6fjzdfg4qj","3jnxnkkrqc","6ckwl4sq92","0hgrsfsq8h","53tgx0rj0g","71tmbt5tr0","3375qhk5xj","1xklszt01q","154xqznlrb","45mg44v4rw","2gq722tm5t","610g063wl6","4mnpvl1nfp"]
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(headless=True)
        ctx=await b.new_context(viewport={"width":1400,"height":1400}, bypass_csp=True)
        pg=await ctx.new_page()
        labels=collections.Counter(); out=""
        for pid in IDS:
            for tab in ["","/insurance","/appointments"]:
                await pg.goto(BASE+f"/patients/{pid}{tab}", wait_until="networkidle"); await pg.wait_for_timeout(400)
                f=pg.frames[1]
                dts=await f.evaluate("()=>[...document.querySelectorAll('dt,h2,th')].map(e=>e.innerText.trim())")
                for d in dts: labels[(tab or 'demo')+':'+d]+=1
                t=await f.inner_text("body")
                k=t.find("Activity\n")
                out+=f"\n#### {pid}{tab}\n"+t[:200].split('\n')[0]+"\n"+t[k+9:k+1800]
        open(OUT+"sample_patients.txt","w").write(out)
        for k,v in sorted(labels.items()): print(v,k)
        await b.close()
asyncio.run(main())
