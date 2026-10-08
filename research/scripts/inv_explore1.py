import asyncio, sys, json
sys.path.insert(0, "/Users/nirav/development/scope health/research/scripts")
from inv_lib import *
async def main():
    async with async_playwright() as p:
        b,ctx=await open_browser(p); pg=await ctx.new_page()
        for path in sys.argv[1:]:
            f=await goto(pg, path)
            print("=====", path, "URL", pg.url, "frame", f.url)
            t=await text(f); print(t[:6000])
            print("--- interactive")
            for e in await interactive(f): print(e)
            # shell text too
            st=await pg.inner_text("body")
            print("--- shell"); print(st[:1500])
        await b.close()
asyncio.run(main())
