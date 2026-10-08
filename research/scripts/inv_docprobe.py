# probe a document: fetch its PDF in-page (in memory), report content-type, text operators; screenshot the viewer
import asyncio, sys, json, base64, zlib, re
sys.path.insert(0, "/Users/nirav/development/scope health/research/scripts")
from inv_lib import *
from inv_run import set_all_locations
def pdf_text(data):
    out=[]
    for m in re.finditer(rb'stream\r?\n(.*?)\r?\nendstream', data, re.S):
        s=m.group(1)
        try: s=zlib.decompress(s)
        except Exception: pass
        for t in re.findall(rb'\((.*?)(?<!\\)\)\s*Tj', s): out.append(t.decode('latin1'))
        for arr in re.findall(rb'\[(.*?)\]\s*TJ', s, re.S):
            out.append("".join(x.decode('latin1') for x in re.findall(rb'\((.*?)(?<!\\)\)', arr)))
    return out
async def main():
    async with async_playwright() as p:
        b,ctx=await open_browser(p); pg=await ctx.new_page()
        await goto(pg, "/"); await set_all_locations(pg)
        for i,path in enumerate(sys.argv[1:]):
            f=await goto(pg, path)
            hdr=await text(f)
            info=await f.evaluate("""async()=>{const a=document.querySelector('a[download]');const img=[...document.querySelectorAll('img')].map(i=>i.src);
              const r=await fetch(a.href);const ct=r.headers.get('content-type');const buf=new Uint8Array(await r.arrayBuffer());
              let s='';for(let i=0;i<buf.length;i++)s+=String.fromCharCode(buf[i]);
              const r2=await fetch(a.href);
              let ict=null; if(img.length){const ri=await fetch(img[0]); ict=ri.headers.get('content-type')+' '+ri.status;}
              return {download:a.getAttribute('download'),ct,len:buf.length,b64:btoa(s),again:r2.status,img,ict}}""")
            data=base64.b64decode(info.pop('b64'))
            print("=====", path); print(hdr.split("\n")[0]); print(json.dumps(info))
            print("PDF head:", data[:20], "fonts:", len(re.findall(rb'/Font', data)), "images:", len(re.findall(rb'/Subtype\s*/Image', data)))
            txt=pdf_text(data); print("TEXT OPS:", len(txt)); print("\n".join(txt)[:3000])
            await pg.screenshot(path=f"/private/tmp/claude-502/-Users-nirav-development-scope-health/07543581-6db0-4558-89e6-42d589d0daa6/scratchpad/doc{i}.png", full_page=True)
        await b.close()
asyncio.run(main())
