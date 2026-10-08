# usage: inv_dump.py name=path [name=path ...]  -> writes dumps/<name>.txt (text + links)
import asyncio, sys, json
sys.path.insert(0, "/Users/nirav/development/scope health/research/scripts")
from inv_lib import *
async def main():
    async with async_playwright() as p:
        b,ctx=await open_browser(p); pg=await ctx.new_page()
        for arg in sys.argv[1:]:
            name,path=arg.split("=",1)
            f=await goto(pg, path)
            t=await text(f)
            els=await interactive(f)
            links="\n".join(f"[{e['tag']}{'/'+e['role'] if e['role'] else ''}] {e['text']!r} {e['href']} {e['name']} {e['sel']}".replace("\n"," ") for e in els)
            out=f"URL: {pg.url}\nTITLE: {await pg.title()}\n\n{t}\n\n---- INTERACTIVE ----\n{links}\n"
            dump(name+".txt", out)
            print("=====", name, pg.url); print(out[:int(sys.argv[0] and 99999)])
        await b.close()
asyncio.run(main())
