# estimate patient count by sampling DOB searches; sample charts for appointments/docs/notes counts (read-only)
import asyncio, sys, json, re, random, datetime
sys.path.insert(0, "/Users/nirav/development/scope health/research/scripts")
from inv_lib import *
from inv_run import set_all_locations
async def main():
    random.seed(7)
    async with async_playwright() as p:
        b,ctx=await open_browser(p); pg=await ctx.new_page()
        await goto(pg, "/"); await set_all_locations(pg)
        start=datetime.date(1930,1,1); end=datetime.date(2026,10,1); span=(end-start).days
        counts=[]; ids=[]
        for i in range(40):
            d=start+datetime.timedelta(days=random.randrange(span))
            f=await goto(pg, f"/patients?dob={d.isoformat()}"); t=await text(f)
            m=re.search(r'(\d+) patients?\n', t); n=int(m.group(1)) if m else (0 if 'No patients match' in t else -1)
            m2=re.search(r'of (\d+) patients', t); n=int(m2.group(1)) if m2 else n
            counts.append(n)
            ids+=await f.evaluate("()=>[...document.querySelectorAll('table a[href^=\"/patients/\"]')].map(a=>a.getAttribute('href'))")
            print(d, n, flush=True)
        avg=sum(counts)/len(counts); print("avg per date", avg, "=> est patients", round(avg*span))
        stats=[]
        for pid in ids[:20]:
            row={"id":pid}
            for tab,pat in [("/appointments",r'(\d+) appointments?'),("/documents",r'(\d+) documents?'),("/notes",r'(\d+) notes?'),("/problems",r'(\d+) conditions?')]:
                f=await goto(pg, pid+tab); t=await text(f); m=re.search(pat, t)
                row[tab]=int(m.group(1)) if m else (0 if re.search(r'No |not', t) else -1)
                if tab=="/appointments": row["recurring"]=len(re.findall(r'recurring appointments?\n', t)) and int(re.search(r'(\d+) recurring appointment', t).group(1))
            f=await goto(pg, pid.replace('/patients/','/billing/accounts/')); t=await text(f); m=re.search(r'(\d+) invoices?', t); row["invoices"]=int(m.group(1)) if m else 0
            print(row, flush=True); stats.append(row)
        json.dump({"dob_counts":counts,"charts":stats}, open("/Users/nirav/development/scope health/research/dumps/volume_sample.json","w"), indent=1)
        await b.close()
asyncio.run(main())
