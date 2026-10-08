# command runner: inv_run.py "cmd1" "cmd2" ...
# cmds: all (set all locations) | goto PATH | click TEXT | clickx SELECTOR | select NAME LABEL | dump NAME | print [N] | links | wait MS | fill NAME VALUE | submit
import asyncio, sys, json
sys.path.insert(0, "/Users/nirav/development/scope health/research/scripts")
from inv_lib import *
async def set_all_locations(pg):
    await pg.click("summary[aria-label^='Location']")
    await pg.click("button:has-text('All locations')")
    await settle(pg, 1200)
async def fmt(pg, f):
    t=await text(f); els=await interactive(f)
    links="\n".join(f"[{e['tag']}{'/'+e['role'] if e['role'] else ''}] {e['text']!r} {e['href']} {e['name']} {e['sel']}".replace("\n"," ") for e in els)
    return f"URL: {pg.url}\nTITLE: {await pg.title()}\n\n{t}\n\n---- INTERACTIVE ----\n{links}\n"
async def main():
    async with async_playwright() as p:
        b,ctx=await open_browser(p); pg=await ctx.new_page()
        await goto(pg, "/")
        f=content_frame(pg)
        for cmd in sys.argv[1:]:
            op,_,arg=cmd.partition(" ")
            try:
                if op=="all": await set_all_locations(pg); f=content_frame(pg)
                elif op=="goto": f=await goto(pg, arg)
                elif op=="click":
                    f=content_frame(pg)
                    loc=f.get_by_text(arg, exact=True).first
                    await loc.click(); await settle(pg); f=content_frame(pg)
                elif op=="clickrole":
                    role,_,name=arg.partition(" ")
                    f=content_frame(pg); await f.get_by_role(role, name=name, exact=True).first.click(); await settle(pg); f=content_frame(pg)
                elif op=="clickx":
                    f=content_frame(pg); await f.locator(arg).first.click(); await settle(pg); f=content_frame(pg)
                elif op=="select":
                    name,_,label=arg.partition(" ")
                    f=content_frame(pg); await f.select_option(f"select[name='{name}']", label=label); await settle(pg); f=content_frame(pg)
                elif op=="fill":
                    name,_,val=arg.partition(" ")
                    f=content_frame(pg); await f.fill(f"[name='{name}']", val)
                elif op=="submit":
                    f=content_frame(pg); await f.locator("button[type=submit]").first.click(); await settle(pg); f=content_frame(pg)
                elif op=="wait": await pg.wait_for_timeout(int(arg))
                elif op=="dump":
                    f=content_frame(pg); out=await fmt(pg,f); dump(arg+".txt", out); print(f"[dumped {arg} {pg.url}]")
                elif op=="print":
                    f=content_frame(pg); out=await fmt(pg,f); n=int(arg) if arg else 8000; print(f"===== {pg.url}"); print(out[:n])
                elif op=="text":
                    f=content_frame(pg); print(f"===== {pg.url}"); print((await text(f))[:int(arg) if arg else 8000])
                elif op=="html":
                    f=content_frame(pg); h=await f.content(); dump(arg+".html", h); print(f"[html {arg}]")
                elif op=="shell":
                    print(await pg.inner_text("body"))
            except Exception as e:
                print("ERR", cmd, repr(e)[:300])
        await b.close()
asyncio.run(main())
