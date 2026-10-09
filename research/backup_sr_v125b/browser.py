import asyncio, time, re
from urllib.parse import urljoin, urlparse
from playwright.async_api import async_playwright
from .util import log, now

JS_EXTRACT = r"""
() => {
  const out = [];
  function walk(node, depth) {
    if (node.nodeType === 3) { const t = node.textContent.replace(/\s+/g,' '); if (t.trim()) out.push(t); return; }
    if (node.nodeType !== 1) return;
    const el = node; const tag = el.tagName;
    if (['SCRIPT','STYLE','SVG','TEMPLATE','NOSCRIPT'].includes(tag)) return;
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return;
    const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden') return;
    if (tag === 'TABLE') {
      const rows = Array.from(el.querySelectorAll('tr'));
      out.push('\n[TABLE]\n');
      for (const r of rows) {
        const cells = Array.from(r.children).map(c => {
          let t = c.innerText.replace(/\s+/g,' ').trim();
          const a = c.querySelector('a[href]'); if (a) t += ' <' + a.getAttribute('href') + '>';
          return t; });
        out.push(cells.join(' | ') + '\n');
      }
      out.push('[/TABLE]\n'); return;
    }
    if (tag === 'SELECT') { const o = el.options[el.selectedIndex]; out.push(' [select ' + (el.name||'') + '=' + (o ? o.text : '') + '] '); return; }
    if (tag === 'INPUT') { if (el.type !== 'hidden') out.push(' [input ' + (el.name||el.id||'') + '=' + (el.value||'') + '] '); return; }
    const block = /^(DIV|P|LI|H1|H2|H3|H4|H5|H6|SECTION|ARTICLE|HEADER|FOOTER|TR|DL|DT|DD|UL|OL|FORM|FIELDSET|DETAILS|SUMMARY|MAIN|NAV|ASIDE|BR|HR)$/.test(tag);
    if (/^H[1-6]$/.test(tag)) out.push('\n' + '#'.repeat(+tag[1]) + ' ');
    else if (block) out.push('\n');
    if (tag === 'A' && el.getAttribute('href')) { out.push(el.innerText.replace(/\s+/g,' ').trim() + ' <' + el.getAttribute('href') + '>'); return; }
    if (tag === 'DT') { out.push(el.innerText.replace(/\s+/g,' ').trim() + ': '); return; }
    for (const c of el.childNodes) walk(c, depth+1);
    if (block) out.push('\n');
  }
  walk(document.body, 0);
  return out.join('').replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}
"""

FRAME_STATE = "() => [document.body ? document.body.innerText.length : 0, document.documentElement.hasAttribute('aria-busy'), !!document.querySelector('[role=status]:not([hidden])') && document.body.innerText.length < 40]"

class Page:
    __slots__ = ("path", "url", "title", "text", "links", "error", "t", "dt")
    def __init__(self, **kw):
        for k in self.__slots__: setattr(self, k, kw.get(k))

class Browser:
    """Pool of Playwright pages sharing one logged-in context. fetch(path) -> Page with clean text."""
    def __init__(self, base, user, pw, n_pages=6):
        self.base = base.rstrip('/'); self.user = user; self.pw = pw; self.n = n_pages
        self.cache = {}
        self.inflight = {}
        self.fetches = 0

    async def start(self):
        self.pwr = await async_playwright().start()
        self.browser = await self.pwr.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"])
        self.ctx = await self.browser.new_context(viewport={"width": 1400, "height": 1000}, bypass_csp=True)
        self.pages = [await self.ctx.new_page() for _ in range(self.n)]
        self.free = asyncio.Queue()
        for p in self.pages: self.free.put_nowait(p)
        await self.login(self.pages[0])

    async def login(self, pg):
        try:
            await pg.goto(self.base + "/login", wait_until="domcontentloaded")
            for _ in range(30):
                if await pg.locator("input[type=password]").count(): break
                if "/login" not in pg.url: break
                await asyncio.sleep(0.1)
            if await pg.locator("input[type=password]").count():
                u = pg.locator("input[name=username], #username, input[autocomplete=username], input[type=text], input[type=email]").first
                await u.fill(self.user)
                await pg.fill("input[type=password]", self.pw)
                await pg.press("input[type=password]", "Enter")
                for _ in range(100):
                    await asyncio.sleep(0.1)
                    if "/login" not in pg.url: break
            log("LOGIN ->", pg.url)
        except Exception as e:
            log("LOGIN error", repr(e)[:200])

    async def _ready(self, pg, timeout=12):
        t = time.time()
        while time.time() - t < timeout:
            frs = [f for f in pg.frames if '/v/' in f.url]
            f = frs[-1] if frs else pg.main_frame
            try:
                st = await f.evaluate(FRAME_STATE)
                if st[0] > 0 and not st[1] and not st[2] and (frs or time.time() - t > 2.5):
                    return f
            except Exception:
                pass
            await asyncio.sleep(0.03)
        return None

    def url(self, path):
        return urljoin(self.base + '/', path.lstrip('/'))

    async def fetch(self, path, fresh=False, max_age=None):
        """Fetch a page's main content. Cached unless fresh=True or older than max_age seconds."""
        c = self.cache.get(path)
        if c and not fresh and not c.error and (max_age is None or now() - c.t <= max_age):
            return c
        if path in self.inflight and not fresh:
            return await self.inflight[path]
        fut = asyncio.get_event_loop().create_future()
        self.inflight[path] = fut
        try:
            p = await self._fetch(path)
            if p.error and 'login' in (p.url or ''):
                await self.login(self.pages[0]); p = await self._fetch(path)
            self.cache[path] = p
            fut.set_result(p)
            return p
        except Exception as e:
            p = Page(path=path, error=repr(e)[:200], t=now(), text="", links=[])
            fut.set_result(p); return p
        finally:
            self.inflight.pop(path, None)

    async def _fetch(self, path):
        pg = await self.free.get()
        t = time.time()
        try:
            await pg.goto(self.url(path), wait_until="domcontentloaded", timeout=20000)
            if "/login" in pg.url and not path.startswith("/login"):
                return Page(path=path, url=pg.url, error="login", t=now(), text="", links=[], dt=time.time()-t)
            f = await self._ready(pg)
            if f is None:
                return Page(path=path, url=pg.url, error="timeout", t=now(), text="", links=[], dt=time.time()-t)
            text = await f.evaluate(JS_EXTRACT)
            links = await f.evaluate("() => Array.from(document.querySelectorAll('a[href]')).map(a => [a.innerText.replace(/\\s+/g,' ').trim(), a.getAttribute('href')])")
            title = await pg.title()
            self.fetches += 1
            return Page(path=path, url=pg.url, title=title, text=text, links=links, t=now(), dt=time.time()-t)
        except Exception as e:
            return Page(path=path, url=getattr(pg, 'url', ''), error=repr(e)[:200], t=now(), text="", links=[], dt=time.time()-t)
        finally:
            self.free.put_nowait(pg)

    async def fetch_many(self, paths, **kw):
        return await asyncio.gather(*[self.fetch(p, **kw) for p in paths])

    async def shell(self):
        """Nav links + location options + version from the app shell."""
        pg = await self.free.get()
        try:
            await pg.goto(self.base + "/", wait_until="domcontentloaded")
            await self._ready(pg)
            nav = await pg.evaluate("() => Array.from(document.querySelectorAll('nav a[href], header a[href], a[href]')).map(a => [a.innerText.replace(/\\s+/g,' ').trim(), a.getAttribute('href')])")
            text = await pg.evaluate("() => document.body.innerText")
            return {"nav": nav, "text": text}
        finally:
            self.free.put_nowait(pg)

    async def close(self):
        try:
            await self.browser.close(); await self.pwr.stop()
        except Exception:
            pass
