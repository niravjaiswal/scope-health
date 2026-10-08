# survey anti-scraping obfuscation on pages: cipher-font fields (decoded), svg text pictures, pseudo-content, hidden text, flex reordering
import asyncio, sys, json, base64, io, hashlib
sys.path.insert(0, "/Users/nirav/development/scope health/research/scripts")
from inv_lib import *
from inv_run import set_all_locations
from fontTools.ttLib import TTFont
from fontTools.pens.recordingPen import RecordingPen
FONTCACHE={}
def sigs(data):
    tt=TTFont(io.BytesIO(data)); gs=tt.getGlyphSet(); out={}
    for cp,gn in tt.getBestCmap().items():
        pen=RecordingPen(); gs[gn].draw(pen); out[chr(cp)]=hashlib.md5(repr(pen.value).encode()).hexdigest()[:10]
    return out
JS=r"""async()=>{
 const faces=[];for(const ss of document.styleSheets){let rules;try{rules=ss.cssRules}catch(e){continue};for(const r of rules){if(r.constructor.name==='CSSFontFaceRule'){const fam=r.style.getPropertyValue('font-family').replace(/"/g,'');const m=r.style.getPropertyValue('src').match(/url\("?([^")]+)"?\)/);if(m&&!/Atkinson/.test(fam))faces.push({fam,url:m[1]})}}}
 for(const f of faces){const resp=await fetch(f.url);const buf=new Uint8Array(await resp.arrayBuffer());let s='';for(let i=0;i<buf.length;i++)s+=String.fromCharCode(buf[i]);f.b64=btoa(s)}
 const cipher=[];const pseudo=[];const hidden=[];const reorder=[];const svgs=[];
 const lbl=e=>{let p=e;for(let k=0;k<6&&p;k++){const prev=p.previousElementSibling;if(prev&&prev.textContent.trim())return prev.textContent.trim().slice(0,30);p=p.parentElement}return ''};
 document.querySelectorAll('body *').forEach(e=>{
   const cs=getComputedStyle(e);
   const ff=cs.fontFamily.split(',')[0].replace(/"/g,'').trim();
   if(e.childElementCount===0&&e.textContent.trim()&&!/Atkinson/.test(ff)&&ff!=='Wrenfield Mono')cipher.push([ff,e.textContent.trim(),lbl(e)]);
   for(const pe of ['::before','::after']){const c=getComputedStyle(e,pe).content;if(c&&c!=='none'&&c!=='normal'&&c!=='""')pseudo.push([e.tagName,pe,c.slice(0,40),e.textContent.trim().slice(0,30)])}
   if(e.childElementCount===0&&e.textContent.trim()&&e.closest('[aria-hidden=true],[hidden]')==null){const r=e.getBoundingClientRect();if(cs.display!=='none'&&(cs.visibility==='hidden'||cs.opacity==='0'||r.width<2||r.height<2||cs.color==='rgba(0, 0, 0, 0)'||cs.fontSize==='0px'||r.right<0||r.bottom<0))hidden.push([e.tagName,e.textContent.trim().slice(0,50),cs.visibility,cs.opacity,Math.round(r.width),Math.round(r.height),cs.position])}
   if(cs.order&&cs.order!=='0')reorder.push([e.tagName,cs.order,e.textContent.trim().slice(0,30)]);
   if(cs.flexDirection&&/reverse/.test(cs.flexDirection))reorder.push([e.tagName,cs.flexDirection,e.textContent.trim().slice(0,40)]);
   if(e.tagName==='svg'){const n=e.querySelectorAll('path').length;const t=e.getAttribute('aria-label')||(e.querySelector('title')||{}).textContent||'';if(n>8||t||e.getAttribute('role')==='img')svgs.push([n,t,e.getAttribute('role'),e.parentElement.textContent.trim().slice(0,40)])}
 });
 const canv=document.querySelectorAll('canvas').length;
 return {faces,cipher,pseudo,hidden,reorder,svgs,canv}}"""
async def probe(pg, path):
    f=await goto(pg, path)
    r=await f.evaluate(JS)
    fonts={}
    for fc in r['faces']:
        fonts[fc['fam']]=sigs(base64.b64decode(fc['b64']))
    honest=fonts.get('Wrenfield Mono',{}); byhash={h:c for c,h in honest.items()}
    maps={fam:{c:byhash.get(h,'?') for c,h in s.items()} for fam,s in fonts.items()}
    print("=====", path, "| faces:", [(f['fam'],f['url'][-25:]) for f in r['faces']], "| canvas:", r['canv'])
    for fam,t,l in r['cipher']:
        mp=maps.get(fam,{}); dec="".join(mp.get(c,c) for c in t)
        print(f"  CIPHER[{fam}] {l!r}: {t!r} -> {dec!r}" + ("" if dec!=t else " (same)"))
    for x in r['pseudo'][:15]: print("  PSEUDO", x)
    for x in r['hidden'][:25]: print("  HIDDEN", x)
    for x in r['reorder'][:15]: print("  REORDER", x)
    for x in r['svgs'][:15]: print("  SVG", x)
async def main():
    async with async_playwright() as p:
        b,ctx=await open_browser(p); pg=await ctx.new_page()
        await goto(pg, "/"); await set_all_locations(pg)
        for path in sys.argv[1:]:
            try: await probe(pg, path)
            except Exception as e: print("ERR", path, e)
        await b.close()
asyncio.run(main())
