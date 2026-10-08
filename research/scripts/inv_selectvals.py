import asyncio, sys, json
sys.path.insert(0, "/Users/nirav/development/scope health/research/scripts")
from inv_lib import *
from inv_run import set_all_locations
async def main():
    async with async_playwright() as p:
        b,ctx=await open_browser(p); pg=await ctx.new_page()
        await goto(pg, "/"); await set_all_locations(pg)
        f=await goto(pg, sys.argv[1])
        r=await f.evaluate("()=>[...document.querySelectorAll('select')].map(s=>({name:s.name,opts:[...s.options].map(o=>o.value+'='+o.textContent.trim())}))")
        for s in r: print(s['name'], s['opts'][:60])
        await b.close()
asyncio.run(main())
