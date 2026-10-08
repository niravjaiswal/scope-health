# Read-only: capture text of /about/notices and /about (version info) on the practice clinic.
import asyncio
from playwright.async_api import async_playwright
BASE="https://practice.speedrun.scopehealth.com"
OUT="/Users/nirav/development/scope health/research/web/practice_about_pages.md"
async def grab(pg, path):
    await pg.goto(BASE+path, wait_until="networkidle"); await pg.wait_for_timeout(1500)
    out=[f"\n## {path}  (final url: {pg.url})\n"]
    try: out.append("### shell\n```\n"+(await pg.inner_text("body"))[:4000]+"\n```")
    except Exception as e: out.append(str(e))
    for f in pg.frames[1:]:
        try: out.append("### iframe\n```\n"+(await f.inner_text("body"))[:12000]+"\n```")
        except Exception as e: out.append(str(e))
    return "\n".join(out)
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(headless=True)
        ctx=await b.new_context(viewport={"width":1400,"height":1000}, bypass_csp=True)
        pg=await ctx.new_page()
        parts=["# Practice clinic about/notices pages (read-only capture 2026-10-08)"]
        for path in ["/about/notices","/about"]:
            parts.append(await grab(pg,path))
        open(OUT,"w").write("\n".join(parts))
        await b.close()
asyncio.run(main())
