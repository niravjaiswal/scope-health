# enumerate provider select options (+optgroups) and visit each provider page to read specialty line
import asyncio, sys, json
sys.path.insert(0, "/Users/nirav/development/scope health/research/scripts")
from inv_lib import *
from inv_run import set_all_locations
async def main():
    async with async_playwright() as p:
        b,ctx=await open_browser(p); pg=await ctx.new_page()
        await goto(pg, "/"); await set_all_locations(pg)
        f=await goto(pg, "/schedule/providers/47vhl7tdlt?date=2026-10-14")
        opts=await f.evaluate("""()=>[...document.querySelectorAll('select[name=provider] option')].map(o=>({v:o.value,t:o.textContent.trim(),g:o.parentElement.tagName=='OPTGROUP'?o.parentElement.label:''}))""")
        print(json.dumps(opts[:3])); print(len(opts), set(o['g'] for o in opts))
        sel=await f.evaluate("""()=>document.querySelector('select[name=provider]').outerHTML.slice(0,600)""")
        print(sel)
        res=[]
        lim=int(sys.argv[1]) if len(sys.argv)>1 else 999
        for o in [o for o in opts if (len(sys.argv)<3 or o['g']==sys.argv[2])][:lim]:
            f=content_frame(pg)
            await f.select_option("select[name=provider]", label=o['t']); await settle(pg, 300)
            f=content_frame(pg)
            t=await text(f)
            lines=[l for l in t.split("\n") if l.strip()]
            i=lines.index(o['t']) if o['t'] in lines else -1
            spec=next((l for l in lines[i+1:i+4] if ' · ' in l), '?') if i>=0 else "?"
            if i>=0 and lines[i+1].strip()=='Inactive': spec='INACTIVE: '+spec
            res.append({**o, "line":spec, "url":pg.url})
            print(o['t'], "|", spec, "|", pg.url)
        json.dump(res, open("/Users/nirav/development/scope health/research/dumps/providers"+(sys.argv[2] if len(sys.argv)>2 else "")+".json","w"), indent=1)
        await b.close()
asyncio.run(main())
