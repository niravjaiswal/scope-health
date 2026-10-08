# check whether scrambled PDFs use duplicate glyphs (same outline, different ToUnicode)
import asyncio, sys, base64, re, io, hashlib, collections
sys.path.insert(0, "/Users/nirav/development/scope health/research/scripts")
from inv_lib import *
from inv_run import set_all_locations
from fontTools.ttLib import TTFont
from fontTools.pens.recordingPen import RecordingPen
from inv_pdftext import _streams, _cmap
def analyze(data):
    objs=_streams(data)
    for num,(d,s) in objs.items():
        for name,ref in re.findall(rb'/(F\d+)\s+(\d+) 0 R', d):
            fd=objs[int(ref)][0]
            tu=_cmap(objs[int(re.search(rb'/ToUnicode\s+(\d+) 0 R', fd).group(1))][1])
            cid=objs[int(re.search(rb'/DescendantFonts\s*\[(\d+) 0 R', fd).group(1))][0]
            fdesc=re.search(rb'/FontDescriptor\s+(\d+) 0 R', cid).group(1)
            ff=re.search(rb'/FontFile2\s+(\d+) 0 R', objs[int(fdesc)][0]).group(1)
            tt=TTFont(io.BytesIO(objs[int(ff)][1])); gs=tt.getGlyphSet(); order=tt.getGlyphOrder()
            byhash=collections.defaultdict(list)
            for gid,gn in enumerate(order):
                pen=RecordingPen(); gs[gn].draw(pen)
                g=tt['glyf'][gn]; nc=getattr(g,'numberOfContours',0)
                pts=len(g.coordinates) if nc>0 else 0
                bb=tuple(round(getattr(g,k,0)/40) for k in ('xMin','yMin','xMax','yMax'))
                h=(tt['hmtx'][gn][0]//10, nc, pts, bb)
                byhash[h].append((gid, tu.get(gid,'?')))
            print(name, "glyphs", len(order), "unique outlines", len(byhash))
            for h,v in byhash.items():
                if len(v)>1: print("  dup outline", h, v)
async def main():
    async with async_playwright() as p:
        b,ctx=await open_browser(p); pg=await ctx.new_page()
        await goto(pg, "/"); await set_all_locations(pg)
        for path in sys.argv[1:]:
            f=await goto(pg, path)
            b64=await f.evaluate("""async()=>{const a=document.querySelector('a[download]');const r=await fetch(a.href);const buf=new Uint8Array(await r.arrayBuffer());let s='';for(let i=0;i<buf.length;i++)s+=String.fromCharCode(buf[i]);return btoa(s)}""")
            print("=====", path); analyze(base64.b64decode(b64))
        await b.close()
asyncio.run(main())
