import asyncio, sys, json, base64
sys.path.insert(0, "/Users/nirav/development/scope health/research/scripts")
from inv_lib import *
from inv_run import set_all_locations
from inv_pdftext import extract
async def main():
    async with async_playwright() as p:
        b,ctx=await open_browser(p); pg=await ctx.new_page()
        await goto(pg, "/"); await set_all_locations(pg)
        for arg in sys.argv[1:]:
            name,path=arg.split("=",1)
            f=await goto(pg, path)
            hdr=(await text(f)).split("\n")[0]
            info=await f.evaluate("""async()=>{const a=document.querySelector('a[download]');const r=await fetch(a.href);const buf=new Uint8Array(await r.arrayBuffer());let s='';for(let i=0;i<buf.length;i++)s+=String.fromCharCode(buf[i]);return {fn:a.getAttribute('download'),b64:btoa(s)}}""")
            data=base64.b64decode(info['b64'])
            t=extract(data)
            out=f"URL: {pg.url}\nVIEWER: {hdr}\nFILE: {info['fn']}\n\n--- PDF TEXT LAYER ---\n{t}\n"
            dump(name+".txt", out); print(out)
        await b.close()
asyncio.run(main())
