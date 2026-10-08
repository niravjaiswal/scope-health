# sample invoices across sort orders; collect ledger description variety (read-only)
import asyncio, sys, json, re, collections
sys.path.insert(0, "/Users/nirav/development/scope health/research/scripts")
from inv_lib import *
from inv_run import set_all_locations
async def main():
    async with async_playwright() as p:
        b,ctx=await open_browser(p); pg=await ctx.new_page()
        await goto(pg, "/"); await set_all_locations(pg)
        hrefs=[]
        for sort in ["Issued date, oldest first","Amount owed, largest first","Total, largest first","Status, Z to A","Service date, oldest first"]:
            f=await goto(pg, "/billing")
            await f.select_option("select[name=sort]", label=sort); await settle(pg, 600)
            f=content_frame(pg)
            hs=await f.evaluate("()=>[...document.querySelectorAll('a[href^=\"/billing/invoices/\"]')].map(a=>a.getAttribute('href'))")
            t=await text(f)
            print(sort, len(hs)); hrefs+= hs[:12]
            dump("billing_sorted_"+re.sub(r'\W+','_',sort)+".txt", f"URL: {pg.url}\nSORT: {sort}\n\n"+t)
        desc=collections.Counter(); samples={}
        for h in dict.fromkeys(hrefs):
            f=await goto(pg, h); t=await text(f)
            i=t.find("Ledger of this invoice")
            led=t[i:].split("\n")[2:] if i>=0 else []
            for l in led:
                parts=l.split("\t")
                if len(parts)>=2 and re.match(r'[A-Z][a-z]{2} \d', parts[0]):
                    d=re.sub(r'\d','#',parts[1]); desc[d]+=1; samples.setdefault(d, h)
            st=re.search(r'Status\n(.*)', t)
            print(h, st.group(1) if st else '?', "|", " / ".join(l.replace("\t"," | ") for l in led[:8]))
        print(json.dumps(desc.most_common(), indent=0)); print(samples)
        await b.close()
asyncio.run(main())
