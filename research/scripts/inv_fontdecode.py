# decode per-load cipher font: map cipher codepoints -> true chars by matching glyph outlines against the honest "Wrenfield Mono" face
import asyncio, sys, json, base64, io, hashlib
sys.path.insert(0, "/Users/nirav/development/scope health/research/scripts")
from inv_lib import *
from inv_run import set_all_locations
from fontTools.ttLib import TTFont
from fontTools.pens.recordingPen import RecordingPen
def sigs(data):
    tt=TTFont(io.BytesIO(data)); gs=tt.getGlyphSet(); cmap=tt.getBestCmap()
    out={}
    for cp,gn in cmap.items():
        pen=RecordingPen(); gs[gn].draw(pen)
        out[chr(cp)]=(gn, hashlib.md5(repr(pen.value).encode()).hexdigest()[:10])
    return tt, out
async def main():
    async with async_playwright() as p:
        b,ctx=await open_browser(p); pg=await ctx.new_page()
        await goto(pg, "/"); await set_all_locations(pg)
        f=await goto(pg, sys.argv[1])
        faces=await f.evaluate("""async()=>{const out=[];for(const ss of document.styleSheets){for(const r of ss.cssRules){if(r.constructor.name==='CSSFontFaceRule'){const fam=r.style.getPropertyValue('font-family');const m=r.style.getPropertyValue('src').match(/url\\("?([^")]+)"?\\)/);if(m&&!/Atkinson/.test(fam)){const resp=await fetch(m[1]);const buf=new Uint8Array(await resp.arrayBuffer());let s='';for(let i=0;i<buf.length;i++)s+=String.fromCharCode(buf[i]);out.push({fam,url:m[1],b64:btoa(s)})}}}}
          const els=[];document.querySelectorAll('body *').forEach(e=>{if(e.children.length===0&&e.textContent.trim()){const ff=getComputedStyle(e).fontFamily;if(!/Atkinson/.test(ff))els.push([ff.split(',')[0],e.textContent.trim()])}});return {out,els}}""")
        fonts={}
        for fc in faces['out']:
            data=base64.b64decode(fc['b64']); tt,s=sigs(data)
            fonts[fc['fam'].strip('"')]=s
            print(fc['fam'], fc['url'], len(data), "glyphs", len(tt.getGlyphOrder()), "cmap", "".join(sorted(s.keys()))[:120])
            print("   names sample", [(c,s[c][0]) for c in "0123456789"if c in s])
        honest=fonts.get("Wrenfield Mono")
        byhash={v[1]:c for c,v in honest.items()}
        for fam,s in fonts.items():
            if fam=="Wrenfield Mono": continue
            mp={c:byhash.get(v[1],'?') for c,v in s.items()}
            diff={c:t for c,t in mp.items() if c!=t}
            print("FONT", fam, "remapped chars:", json.dumps(diff, ensure_ascii=False))
            fonts[fam]=mp
        for fam,t in faces['els']:
            mp=fonts.get(fam)
            dec="".join(mp.get(c,c) for c in t) if isinstance(mp,dict) and fam!="Wrenfield Mono" else t
            print("EL", fam, repr(t), "->", repr(dec))
        await b.close()
asyncio.run(main())
