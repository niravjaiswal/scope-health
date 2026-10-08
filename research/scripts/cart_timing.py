"""cartographer: timing of navigation strategies (read-only GETs / app's own popstate navigation)."""
import asyncio, time, sys, os, re, statistics
from playwright.async_api import async_playwright
BASE = "https://practice.speedrun.scopehealth.com"

READY_JS = r"""
() => {
  const loadingRe = /^\s*loading\b/i;
  function vis(el){ if(!el) return false; const r = el.getBoundingClientRect(); return r.width>0 && r.height>0; }
  function ok(doc, top){
    if(!doc || doc.readyState==='loading' || !doc.body) return false;
    if(doc.body.hasAttribute('inert') || doc.documentElement.hasAttribute('aria-busy')) return false;
    for (const s of doc.querySelectorAll('[role=status]')) { if(!s.hidden && vis(s) && loadingRe.test(s.textContent||'')) return false; }
    for (const f of doc.querySelectorAll('iframe')) {
      let d; try { d = f.contentDocument } catch(e) { continue }
      if(!d || !f.contentWindow || f.contentWindow.location.href==='about:blank') return false;
      if(!ok(d,false)) return false;
    }
    return true;
  }
  return ok(document, true);
}
"""

PATHS = ["/patients/03q14ndmmd", "/patients/03q14ndmmd/insurance", "/patients/03q14ndmmd/problems", "/patients/03q14ndmmd/notes",
         "/patients/03q14ndmmd/documents", "/patients/03q14ndmmd/appointments", "/billing/accounts/03q14ndmmd", "/patients/6sqtnhdpq1",
         "/patients/6sqtnhdpq1/insurance", "/patients?lastName=Murphy", "/documents", "/billing"]


async def wait_ready(pg, timeout=15.0, poll=0.02):
    t = time.time()
    while time.time() - t < timeout:
        try:
            if await pg.evaluate(READY_JS):
                return True
        except Exception:
            pass
        await asyncio.sleep(poll)
    return False


async def last_frame_marker(pg):
    # url of the deepest /v/ frame (changes on every navigation)
    return [f.url for f in pg.frames if "/v/" in f.url]


async def nav_goto(pg, path):
    await pg.goto(BASE + path, wait_until="commit")
    await asyncio.sleep(0.01)
    return await wait_ready(pg)


async def nav_popstate(pg, path):
    before = set(await last_frame_marker(pg))
    await pg.evaluate("p => { history.pushState(null, '', p); dispatchEvent(new PopStateEvent('popstate')); }", path)
    t = time.time()
    while time.time() - t < 15:
        now = await last_frame_marker(pg)
        if now and not (set(now) & before):
            break
        await asyncio.sleep(0.01)
    return await wait_ready(pg)


async def text_of(pg):
    return await pg.evaluate("""() => { let out=''; (function w(doc){ out += (doc.body? doc.body.innerText : '') + '\\n'; for (const f of doc.querySelectorAll('iframe')) { try { w(f.contentDocument) } catch(e){} } })(document); return out; }""")


async def run_seq(ctx, paths, mode, label, block=None):
    pg = await ctx.new_page()
    if block:
        await pg.route(re.compile(block), lambda r: r.abort())
    await nav_goto(pg, "/")
    times = []
    for p in paths:
        t = time.time()
        ok = await (nav_goto(pg, p) if mode == "goto" else nav_popstate(pg, p))
        txt = await text_of(pg)
        times.append(time.time() - t)
        if not ok or len(txt) < 50:
            print("  !!", label, p, ok, len(txt))
    await pg.close()
    return times


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=True)
        ctx = await b.new_context(viewport={"width": 1400, "height": 1000}, bypass_csp=True)
        for mode in ["goto", "popstate"]:
            t = await run_seq(ctx, PATHS, mode, mode)
            print(f"{mode:10s} 1 page: mean={statistics.mean(t):.3f}s median={statistics.median(t):.3f}s max={max(t):.3f}s")
        # blocking fonts (woff2) — fingerprint uses layout of <i> boxes, check it still works
        t = await run_seq(ctx, PATHS, "goto", "goto-nofonts", block=r".*\.(woff2?|ttf|otf|png|jpg|svg)(\?.*)?$")
        print(f"goto no-fonts 1 page: mean={statistics.mean(t):.3f}s median={statistics.median(t):.3f}s max={max(t):.3f}s")
        for n in (2, 4):
            for mode in ["goto", "popstate"]:
                t0 = time.time()
                res = await asyncio.gather(*[run_seq(ctx, PATHS, mode, f"{mode}x{n}") for _ in range(n)])
                wall = time.time() - t0
                allt = [x for r in res for x in r]
                print(f"{mode:10s} {n} pages: per-view mean={statistics.mean(allt):.3f}s; throughput={len(allt)/wall:.2f} views/s (wall {wall:.1f}s)")
        await b.close()

if __name__ == "__main__":
    asyncio.run(main())
