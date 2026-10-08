import asyncio, base64, io, re, hashlib
from playwright.async_api import async_playwright
from fontTools.ttLib import TTFont
from fontTools.pens.recordingPen import RecordingPen
BASE="https://practice.speedrun.scopehealth.com"
def sigs(font):
    gs=font.getGlyphSet(); cmap=font.getBestCmap(); out={}
    for cp,gn in cmap.items():
        pen=RecordingPen(); gs[gn].draw(pen)
        out[chr(cp)]=hashlib.md5(repr(pen.value).encode()).hexdigest()
    return out
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(headless=True)
        ctx=await b.new_context(viewport={"width":1400,"height":1000}, bypass_csp=True)
        pg=await ctx.new_page()
        await pg.goto(BASE+"/patients/535rn1pbvb", wait_until="networkidle")
        await pg.wait_for_timeout(800)
        f=pg.frames[1]
        rules=await f.evaluate("""()=>{let o=[];for(const s of document.styleSheets){try{for(const r of s.cssRules){if(r.cssText.includes('font-face')&&!r.cssText.includes('Atkinson'))o.push(r.cssText)}}catch(e){}}return o}""")
        items=await f.evaluate("""()=>{const out=[];document.querySelectorAll('span').forEach(el=>{const cs=getComputedStyle(el);if(!cs.fontFamily.includes('Atkinson')&&el.children.length==0)out.push([el.textContent,cs.fontFamily.split(',')[0]])});return out}""")
        fonts={}
        for r in rules:
            fam=re.search(r'font-family: ([^;]+);',r).group(1).strip('"'); url=re.search(r'url\("([^"]+)"\)',r).group(1)
            b64=await f.evaluate("async(u)=>{const r=await fetch(u);const b=new Uint8Array(await r.arrayBuffer());let s='';for(const x of b)s+=String.fromCharCode(x);return btoa(s)}", url)
            fonts[fam]=sigs(TTFont(io.BytesIO(base64.b64decode(b64))))
        ref={v:k for k,v in fonts["Wrenfield Mono"].items()}
        for txt,fam in items:
            m=fonts.get(fam)
            dec=''.join(ref.get(m.get(c,''),c) if m else c for c in txt)
            print(repr(txt), fam, '->', dec)
        await pg.screenshot(path="/Users/nirav/development/scope health/research/taxo/chart2.png", clip={"x":240,"y":250,"width":600,"height":40})
        await b.close()
asyncio.run(main())
