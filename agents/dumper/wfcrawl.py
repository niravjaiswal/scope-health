"""Generic BFS crawler for Wrenfield. Works on any version: follows <a href> links inside the content iframe."""
import asyncio, time, re, os, json, sys
from urllib.parse import urljoin, urlparse
from playwright.async_api import async_playwright

T0 = time.time()
def log(*a):
    print(f"[{time.time()-T0:7.2f}]", *a, flush=True)

BAD = re.compile(r"logout|log-out|signout|delete|cancel|void|/edit|/new|request|reveal|export|download|print", re.I)

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

class Browser:
    def __init__(self, base, user, pw, n_pages=6):
        self.base = base.rstrip('/'); self.user = user; self.pw = pw; self.n = n_pages
    async def start(self):
        self.pw_ctx = await async_playwright().start()
        self.browser = await self.pw_ctx.chromium.launch(headless=True, args=["--no-sandbox","--disable-dev-shm-usage"])
        self.ctx = await self.browser.new_context(viewport={"width":1400,"height":1000}, bypass_csp=True)
        self.pages = [await self.ctx.new_page() for _ in range(self.n)]
        self.free = asyncio.Queue()
        for p in self.pages: self.free.put_nowait(p)
        await self.login(self.pages[0])
    async def login(self, pg):
        await pg.goto(self.base + "/login")
        await asyncio.sleep(0.3)
        try:
            if await pg.locator("input[name=username], #username").count():
                await pg.fill("input[name=username], #username", self.user)
                await pg.fill("input[type=password]", self.pw)
                await pg.press("input[type=password]", "Enter")
                for _ in range(100):
                    await asyncio.sleep(0.1)
                    if "/login" not in pg.url: break
            log("LOGIN done url=", pg.url)
        except Exception as e:
            log("LOGIN error", repr(e))
    async def frame_ready(self, pg, timeout=12):
        t = time.time()
        while time.time() - t < timeout:
            frs = [f for f in pg.frames if '/v/' in f.url]
            f = frs[-1] if frs else pg.main_frame
            try:
                st = await f.evaluate("() => [document.body ? document.body.innerText.length : 0, document.documentElement.hasAttribute('aria-busy'), !!document.querySelector('[role=status]:not([hidden])') && document.body.innerText.length < 40]")
                if st[0] > 0 and not st[1] and not st[2] and (frs or time.time()-t > 2.5):
                    return f
            except Exception:
                pass
            await asyncio.sleep(0.05)
        return None
    async def fetch(self, path):
        pg = await self.free.get()
        try:
            t = time.time()
            await pg.goto(urljoin(self.base + '/', path.lstrip('/')), wait_until="domcontentloaded", timeout=20000)
            f = await self.frame_ready(pg)
            if f is None:
                return {"path": path, "url": pg.url, "error": "timeout", "dt": time.time()-t}
            text = await f.evaluate(JS_EXTRACT)
            links = await f.evaluate("() => Array.from(document.querySelectorAll('a[href]')).map(a => a.getAttribute('href'))")
            shell_links = await pg.evaluate("() => Array.from(document.querySelectorAll('a[href]')).map(a => a.getAttribute('href'))")
            title = await pg.title()
            return {"path": path, "url": pg.url, "title": title, "text": text, "links": links, "shell_links": shell_links, "dt": time.time()-t}
        except Exception as e:
            return {"path": path, "error": repr(e)[:300]}
        finally:
            self.free.put_nowait(pg)
    async def shell_html(self):
        pg = await self.free.get()
        try:
            await pg.goto(self.base + "/")
            await self.frame_ready(pg)
            return await pg.content()
        finally:
            self.free.put_nowait(pg)
    async def close(self):
        await self.browser.close(); await self.pw_ctx.stop()

def norm(href, base):
    if not href or href.startswith('#') or href.startswith('mailto:') or href.startswith('tel:') or href.startswith('javascript:'): return None
    u = urlparse(urljoin(base + '/', href))
    if u.netloc and u.netloc != urlparse(base).netloc: return None
    p = u.path + (('?' + u.query) if u.query else '')
    if p.startswith('/v/') or p.startswith('/static/'): return None
    if BAD.search(p): return None
    return p

BOOST = set()
def priority(p):
    # crawl structural pages first, then charts, then deep pages
    m = re.match(r'^/(?:patients|billing/accounts)/([^/?]+)', p)
    boost = -10 if (m and m.group(1) in BOOST) else 0
    if p.startswith('/patients?'): return -20
    if p.count('/') <= 1: return 0
    if re.match(r'^/patients/[^/?]+$', p): return 1 + boost
    if re.match(r'^/patients/[^/?]+/[a-z\-]+$', p): return 2 + boost
    if re.match(r'^/patients/[^/?]+/(appointments|recurring)/', p): return 6 + boost
    if p.count('/') == 2: return 3
    return 4 + boost

async def crawl(br, seeds, deadline, on_page, max_pages=100000, workers=6):
    seen = set(); q = []
    import heapq
    cnt = 0
    for s in seeds:
        if s not in seen: seen.add(s); heapq.heappush(q, (priority(s), cnt, s)); cnt += 1
    done = 0
    async def worker():
        nonlocal cnt, done
        while time.time() < deadline and done < max_pages:
            if not q:
                await asyncio.sleep(0.2)
                if not q: 
                    if all_idle(): return
                    continue
            _, _, p = heapq.heappop(q)
            busy.add(id(asyncio.current_task()))
            r = await br.fetch(p)
            busy.discard(id(asyncio.current_task()))
            done += 1
            on_page(r)
            if r.get('path', '').startswith('/patients?'):
                for h in (r.get('links') or []):
                    m = re.match(r'^/patients/([^/?]+)$', h or '')
                    if m and 'Restricted' not in (r.get('text') or '')[:0]: BOOST.add(m.group(1))
            for h in (r.get('links') or []) + (r.get('shell_links') or []):
                n = norm(h, br.base)
                if n and n not in seen:
                    seen.add(n); heapq.heappush(q, (priority(n), cnt, n)); cnt += 1
    busy = set()
    def all_idle(): return not busy
    await asyncio.gather(*[worker() for _ in range(workers)])
    return done, len(seen), len(q)
