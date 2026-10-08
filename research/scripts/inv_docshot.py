# screenshot the page image(s) of a document viewer (element screenshot) to scratchpad
import asyncio, sys
sys.path.insert(0, "/Users/nirav/development/scope health/research/scripts")
from inv_lib import *
from inv_run import set_all_locations
SP="/private/tmp/claude-502/-Users-nirav-development-scope-health/07543581-6db0-4558-89e6-42d589d0daa6/scratchpad/"
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(headless=True); ctx=await b.new_context(viewport={"width":1500,"height":2600}, bypass_csp=True); pg=await ctx.new_page()
        await goto(pg, "/"); await set_all_locations(pg)
        for arg in sys.argv[1:]:
            name,path=arg.split("=",1)
            f=await goto(pg, path)
            imgs=f.locator("img[alt^='Page']")
            n=await imgs.count(); print(name, "pages", n)
            for i in range(n):
                await imgs.nth(i).screenshot(path=SP+f"{name}_p{i+1}.png")
        await b.close()
asyncio.run(main())
