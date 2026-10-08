import asyncio, base64, io
from playwright.async_api import async_playwright
from fontTools.ttLib import TTFont
BASE="https://practice.speedrun.scopehealth.com"
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(headless=True)
        ctx=await b.new_context(viewport={"width":1400,"height":1000}, bypass_csp=True)
        pg=await ctx.new_page()
        await pg.goto(BASE+"/patients/535rn1pbvb", wait_until="networkidle")
        await pg.wait_for_timeout(800)
        f=pg.frames[1]
        rules=await f.evaluate("""()=>{let o=[];for(const s of document.styleSheets){try{for(const r of s.cssRules){if(r.cssText.includes('font-face')&&!r.cssText.includes('Atkinson'))o.push(r.cssText)}}catch(e){}}return o}""")
        # phone element text & family
        items=await f.evaluate("""()=>{const out=[];document.querySelectorAll('span').forEach(el=>{const cs=getComputedStyle(el);if(!cs.fontFamily.includes('Atkinson')&&el.children.length==0)out.push([el.textContent,cs.fontFamily.split(',')[0]])});return out}""")
        print(items)
        for r in rules:
            print(r[:200])
            import re
            fam=re.search(r'font-family: ([^;]+);',r).group(1); url=re.search(r'url\("([^"]+)"\)',r).group(1)
            b64=await f.evaluate("async(u)=>{const r=await fetch(u);const b=new Uint8Array(await r.arrayBuffer());let s='';for(const x of b)s+=String.fromCharCode(x);return btoa(s)}", url)
            font=TTFont(io.BytesIO(base64.b64decode(b64)))
            cmap=font.getBestCmap()
            print(fam, url, {chr(k):v for k,v in cmap.items() if chr(k) in '0123456789()-. '})
        await b.close()
asyncio.run(main())
