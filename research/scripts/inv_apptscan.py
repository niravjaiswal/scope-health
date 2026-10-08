# scan schedule appointment list for a date range (all pages, 100/page), tally patient flags; read-only
import asyncio, sys, json, re, collections
sys.path.insert(0, "/Users/nirav/development/scope health/research/scripts")
from inv_lib import *
from inv_run import set_all_locations
async def main():
    frm,to=sys.argv[1],sys.argv[2]; extra=sys.argv[3] if len(sys.argv)>3 else ""
    async with async_playwright() as p:
        b,ctx=await open_browser(p); pg=await ctx.new_page()
        await goto(pg, "/"); await set_all_locations(pg)
        f=await goto(pg, f"/schedule/appointments?from={frm}&to={to}{extra}")
        await f.select_option("select[name=size]", label="100 per page"); await settle(pg, 500)
        rows=[]; page=1
        while True:
            f=content_frame(pg)
            rs=await f.evaluate("""()=>[...document.querySelectorAll('table tbody tr')].map(tr=>[...tr.querySelectorAll('td,th')].map(td=>td.innerText.trim().replace(/\\n+/g,' | ')))""")
            rows+=rs
            t=await text(f); m=re.search(r'Showing (\d+) to (\d+) of ([\d+,]+)', t)
            print("page", page, len(rs), m.group(0) if m else t[-200:].replace("\n"," "))
            nxt=f.get_by_role("button", name="Next", exact=True)
            if not m or await nxt.count()==0 or await nxt.is_disabled() or m.group(2)==m.group(3).replace(",",""): break
            await nxt.click(); await settle(pg, 400); page+=1
            if page>40: break
        flags=collections.Counter(); status=collections.Counter(); tz=collections.Counter(); locs=collections.Counter(); prov=collections.Counter(); types=collections.Counter()
        for r in rows:
            if len(r)<7: continue
            pat=r[2]
            for fl in ["Restricted","Test record","Deleted","Merged"]:
                if fl in pat: flags[fl]+=1
            if "Recurring" in r[1]: flags["Recurring"]+=1
            status[r[6]]+=1; tz[r[1].split(' | ')[0][-3:]]+=1; locs[r[4]]+=1; prov[r[3]]+=1; types[r[5]]+=1
        print("rows", len(rows)); print("flags", flags); print("status", status); print("tz", tz); print("locs", locs); print("types", types.most_common()); print("providers", len(prov))
        print([r for r in rows if any(x in r[2] for x in ["Test","Deleted"])][:10])
        json.dump(rows, open(f"/Users/nirav/development/scope health/research/dumps/appts_{frm}_{to}.json","w"))
        await b.close()
asyncio.run(main())
