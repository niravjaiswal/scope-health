# inspect which elements use the 'identifier' font and fetch that font in-page (in memory) to inspect cmap/glyph names
import asyncio, sys, json, base64, io
sys.path.insert(0, "/Users/nirav/development/scope health/research/scripts")
from inv_lib import *
from inv_run import set_all_locations
from fontTools.ttLib import TTFont
async def main():
    async with async_playwright() as p:
        b,ctx=await open_browser(p); pg=await ctx.new_page()
        await goto(pg, "/"); await set_all_locations(pg)
        f=await goto(pg, sys.argv[1])
        info=await f.evaluate("""()=>{
          const faces=[];for(const ss of document.styleSheets){try{for(const r of ss.cssRules){if(r.constructor.name==='CSSFontFaceRule')faces.push(r.cssText.slice(0,300))}}catch(e){faces.push('ERR '+e)}}
          const fams={};document.querySelectorAll('body *').forEach(e=>{if(e.children.length===0&&e.textContent.trim()){const ff=getComputedStyle(e).fontFamily;(fams[ff]=fams[ff]||[]).push(e.textContent.trim().slice(0,40))}});
          return {faces,fams}}""")
        for x in info['faces']: print("FACE", x)
        for k,v in info['fams'].items(): print("FAMILY", k, "::", v[:15])
        await b.close()
asyncio.run(main())
