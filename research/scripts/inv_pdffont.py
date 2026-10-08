# test: decode Wrenfield PDF text via embedded TrueType font cmap (GID->unicode) instead of ToUnicode
import asyncio, sys, json, base64, zlib, re, io
sys.path.insert(0, "/Users/nirav/development/scope health/research/scripts")
from inv_lib import *
from inv_run import set_all_locations
from fontTools.ttLib import TTFont
from inv_pdftext import _streams, _cmap
def decode(data):
    objs=_streams(data)
    fonts={}
    for num,(d,s) in objs.items():
        for name,ref in re.findall(rb'/(F\d+)\s+(\d+) 0 R', d):
            fd=objs[int(ref)][0]
            tu=re.search(rb'/ToUnicode\s+(\d+) 0 R', fd); desc=re.search(rb'/DescendantFonts\s*\[(\d+) 0 R', fd)
            cid=objs[int(desc.group(1))][0]; fdesc=re.search(rb'/FontDescriptor\s+(\d+) 0 R', cid).group(1)
            ff=re.search(rb'/FontFile2\s+(\d+) 0 R', objs[int(fdesc)][0]).group(1)
            tt=TTFont(io.BytesIO(objs[int(ff)][1]))
            rev={}
            try:
                for tab in tt['cmap'].tables:
                    for u,gn in tab.cmap.items(): rev[tt.getGlyphID(gn)]=chr(u)
            except Exception as e: print("cmap err", e)
            names={i:tt.getGlyphName(i) for i in range(len(tt.getGlyphOrder()))}
            fonts[name.decode()]=(_cmap(objs[int(tu.group(1))][1]), rev, names)
    out=[]
    for num,(d,s) in objs.items():
        if not s or b'BT' not in s: continue
        for bt in re.findall(rb'BT(.*?)ET', s, re.S):
            fm=re.search(rb'/(F\d+)\s+[\d.]+\s+Tf', bt); tu,rev,names=fonts[fm.group(1).decode()]
            for h in re.findall(rb'<([0-9A-Fa-f]+)>\s*Tj', bt):
                h=h.decode(); g=[int(h[i:i+4],16) for i in range(0,len(h),4)]
                out.append(("".join(tu.get(x,'?') for x in g), "".join(rev.get(x,'?') for x in g), " ".join(names.get(x,'?') for x in g[:6])))
    return out
async def main():
    async with async_playwright() as p:
        b,ctx=await open_browser(p); pg=await ctx.new_page()
        await goto(pg, "/"); await set_all_locations(pg)
        for path in sys.argv[1:]:
            f=await goto(pg, path)
            b64=await f.evaluate("""async()=>{const a=document.querySelector('a[download]');const r=await fetch(a.href);const buf=new Uint8Array(await r.arrayBuffer());let s='';for(let i=0;i<buf.length;i++)s+=String.fromCharCode(buf[i]);return btoa(s)}""")
            for tu,real,names in decode(base64.b64decode(b64))[:40]: print(repr(tu), "=>", repr(real), "|", names)
        await b.close()
asyncio.run(main())
