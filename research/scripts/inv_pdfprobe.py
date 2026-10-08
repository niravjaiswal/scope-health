# fetch one document's PDF into memory and analyze structure (no disk write)
import asyncio, sys, json, base64, zlib, re
sys.path.insert(0, "/Users/nirav/development/scope health/research/scripts")
from inv_lib import *
from inv_run import set_all_locations
async def main():
    async with async_playwright() as p:
        b,ctx=await open_browser(p); pg=await ctx.new_page()
        await goto(pg, "/"); await set_all_locations(pg)
        f=await goto(pg, sys.argv[1])
        b64=await f.evaluate("""async()=>{const a=document.querySelector('a[download]');const r=await fetch(a.href);const buf=new Uint8Array(await r.arrayBuffer());let s='';for(let i=0;i<buf.length;i++)s+=String.fromCharCode(buf[i]);return btoa(s)}""")
        data=base64.b64decode(b64)
        objs=re.findall(rb'(\d+) 0 obj(.*?)endobj', data, re.S)
        print("objects", len(objs))
        for num,body in objs:
            d=body.split(b'stream')[0][:300]
            print(num, d.replace(b'\n',b' ')[:250])
            m=re.search(rb'stream\r?\n(.*?)\r?\nendstream', body, re.S)
            if m:
                s=m.group(1)
                try: s=zlib.decompress(s)
                except Exception as e: s=b'<<nodecomp>>'+s[:50]
                print("   STREAM", len(s), s[:400])
        await b.close()
asyncio.run(main())
