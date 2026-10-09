"""Site access layer: pooled, cached, retrying reads of Wrenfield pages (decoded text) on top of wf_client."""
import asyncio, re, time
from .util import log, now
from .wf.wf_client import WrenfieldClient, WrenfieldError, _looks_restricted

BUSY_RE = re.compile(r"503 Service|Service Temporarily Unavailable|is not responding|Too Many Requests|Bad Gateway", re.I)


class Site:
    def __init__(self, base, user, pw, n_tabs=4):
        self.c = WrenfieldClient(base, user, pw, launch_args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"])
        self.n_tabs = n_tabs
        self.cache = {}       # path -> (t, text)
        self.inflight = {}
        self.sem = asyncio.Semaphore(n_tabs)
        self.stats = {"fetch": 0, "fail": 0, "time": 0.0}
        self.today = None
        self.nav = []
        self.version = ""
        self.page_timeout = 9.0
        self.bg_sem = asyncio.Semaphore(1)

    async def start(self):
        t = time.time()
        await self.c.start(n_tabs=1)
        log(f"SITE started {time.time()-t:.1f}s")
        try:
            locs = await self.c.locations()
            cur = await self.c.location()
            log("SITE locations", locs, "current", cur)
            allname = next((l for l in locs if re.match(r"(?i)all\b", l)), None)
            if allname and cur.lower() != allname.lower():
                await self.c.set_location(allname)
                log("SITE location ->", await self.c.location())
        except Exception as e:
            log("SITE set_location failed", repr(e)[:200])
        await asyncio.gather(*[self.c.add_tab() for _ in range(self.n_tabs)])
        try:
            tl = [await t.location() for t in self.c._tabs]
            log("SITE tab locations", tl)
        except Exception as e:
            log("SITE tab loc err", repr(e)[:100])
        try:
            dash = await self.c.main.get_text("/")
            self.dashboard = dash
            m = re.search(r"\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}, \d{4}", dash)
            self.today = m.group(0) if m else None
            shell = await self.c.main.page.evaluate("() => document.body.innerText")
            mv = re.search(r"Wrenfield\s*([0-9]+\.[0-9]+(?:\.[0-9]+)?)", shell)
            self.version = mv.group(1) if mv else ""
            self.nav = await self.c.main.page.evaluate(
                "() => [...document.querySelectorAll('nav a[href]')].filter(a => a.getBoundingClientRect().width > 0 && a.getAttribute('aria-hidden') !== 'true').map(a => [a.innerText.trim(), a.getAttribute('href')])")
            log("SITE version", self.version, "today", self.today, "nav", self.nav)
        except Exception as e:
            log("SITE dashboard err", repr(e)[:200])

    async def page(self, path, fresh=False, max_age=None, retries=2, background=False):
        """Decoded text of a page (cached)."""
        c = self.cache.get(path)
        if c and not fresh and (max_age is None or now() - c[0] <= max_age):
            return c[1]
        if path in self.inflight and not fresh:
            return await asyncio.shield(self.inflight[path])
        fut = asyncio.get_event_loop().create_future()
        self.inflight[path] = fut
        try:
            txt = await self._load(path, retries, sem=self.bg_sem if background else None)
            if txt is not None and not txt.startswith("ERROR"):
                self.cache[path] = (now(), txt)
            fut.set_result(txt)
            return txt
        except Exception as e:
            fut.set_result(f"ERROR {e!r}")
            return f"ERROR {e!r}"
        finally:
            self.inflight.pop(path, None)

    async def _reset_tab(self, tab):
        try:
            await tab.page.goto(self.c.base_url + "/", wait_until="domcontentloaded", timeout=15000)
            await tab.wait_settled(timeout=8)
            log("TAB reset ok")
        except Exception as e:
            log("TAB reset failed", repr(e)[:120])

    async def _load(self, path, retries, sem=None):
        last = ""
        for attempt in range(retries + 1):
            t = time.time()
            async with (sem or self.sem):
                async with self.c.tab() as tab:
                    try:
                        txt = await asyncio.wait_for(tab.get_text(path), timeout=self.page_timeout)
                    except Exception as e:
                        txt = f"ERROR {e!r}"[:300]
                        await self._reset_tab(tab)
            dt = time.time() - t
            self.stats["fetch"] += 1; self.stats["time"] += dt
            if txt and not txt.startswith("ERROR") and not (BUSY_RE.search(txt[:400]) and len(txt) < 600):
                if dt > 3: log(f"SLOW page {path} {dt:.1f}s")
                return txt
            self.stats["fail"] += 1
            last = txt
            log(f"PAGE retry {path} attempt={attempt} dt={dt:.1f} {txt[:120]!r}")
            await asyncio.sleep(0.3 * (attempt + 1))
        return last or "ERROR"

    async def pages(self, paths, **kw):
        return await asyncio.gather(*[self.page(p, **kw) for p in paths])

    async def search(self, last_name=None, dob=None):
        async with self.sem:
            async with self.c.tab() as tab:
                try:
                    return await tab.search_patients(last_name=last_name, dob=dob)
                except Exception as e:
                    log("SEARCH err", last_name, dob, repr(e)[:200])
                    return []

    async def documents(self, path):
        """Images/PDF bytes of a document viewer page."""
        async with self.sem:
            async with self.c.tab() as tab:
                await tab.goto(path)
                return await tab.document_files()

    async def close(self):
        await self.c.close()
