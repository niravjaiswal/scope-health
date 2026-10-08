import asyncio, sys, json
sys.path.insert(0, "/Users/nirav/development/scope health/research/scripts")
from inv_lib import *
async def set_all_locations(pg):
    await pg.click("summary[aria-label^='Location']")
    await pg.click("button:has-text('All locations')")
    await settle(pg, 1500)
async def main():
    async with async_playwright() as p:
        b,ctx=await open_browser(p); pg=await ctx.new_page()
        reqs=[]
        pg.on("request", lambda r: reqs.append((r.method, r.url[:100], (r.post_data or "")[:120])) if r.method=="POST" else None)
        await goto(pg, "/patients")
        print("cookies before", [(c['name'], len(c['value'])) for c in await ctx.cookies()])
        await set_all_locations(pg)
        print("POSTs", reqs)
        print("cookies after", [(c['name'], len(c['value'])) for c in await ctx.cookies()])
        print("shell:", (await pg.inner_text("header"))[:200])
        for arg in sys.argv[1:]:
            name,path=arg.split("=",1)
            f=await goto(pg, path)
            t=await text(f)
            els=await interactive(f)
            links="\n".join(f"[{e['tag']}{'/'+e['role'] if e['role'] else ''}] {e['text']!r} {e['href']} {e['name']} {e['sel']}".replace("\n"," ") for e in els)
            out=f"URL: {pg.url}\nTITLE: {await pg.title()}\n\n{t}\n\n---- INTERACTIVE ----\n{links}\n"
            dump(name+".txt", out)
            print("=====", name, pg.url); print(out)
        await b.close()
asyncio.run(main())
