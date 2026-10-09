"""Site access layer: pooled, cached, retrying reads of Wrenfield pages (decoded text) on top of wf_client."""
import asyncio, re, time
from .util import log, now
from .wf.wf_client import WrenfieldClient, WrenfieldError, _looks_restricted

TRUNC_RE = re.compile(r"is busy, so this list shows fewer|fewer rows than usual|Open it again in a moment", re.I)
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
        self.probed_kinds = set()
        self.probe_budget = int(__import__("os").environ.get("PROBES", "12"))
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
                if TRUNC_RE.search(txt) and attempt < retries + 2:
                    self.stats["trunc"] = self.stats.get("trunc", 0) + 1
                    log(f"PAGE truncated-busy {path} attempt={attempt}; retrying")
                    last = txt
                    await asyncio.sleep(0.6 * (attempt + 1))
                    continue
                if dt > 3: log(f"SLOW page {path} {dt:.1f}s")
                pk = re.sub(r"[0-9a-z]{10}", "<id>", path.split("?")[0])
                if self.probe_budget > 0 and pk not in self.probed_kinds and re.match(r"^/(patients|payers|claims|billing|vaccines|settings|staff|schedule)", pk):
                    self.probed_kinds.add(pk); self.probe_budget -= 1
                    asyncio.create_task(self.probe_html(path))
                return txt
            self.stats["fail"] += 1
            last = txt
            log(f"PAGE retry {path} attempt={attempt} dt={dt:.1f} {txt[:120]!r}")
            await asyncio.sleep(0.3 * (attempt + 1))
        if last and TRUNC_RE.search(last):
            return "WARNING: the server was busy and this list is TRUNCATED (rows missing). Do not count from it; reopen later or skip.\n" + last
        return last or "ERROR"

    async def probe_html(self, path):
        """Recon: print raw HTML of the content frames + fonts used, gzip+b64 (to learn how this version renders data)."""
        import gzip, base64, json
        try:
            async with self.bg_sem:
                async with self.c.tab() as tab:
                    await asyncio.wait_for(tab.goto(path), timeout=self.page_timeout)
                    data = await tab.page.evaluate("""async () => { const out = {frames: [], fonts: {}};
                      async function grab(doc) {
                        out.frames.push((doc.body ? doc.body.innerHTML : '').slice(0, 60000));
                        try { for (const ss of doc.styleSheets) { for (const r of ss.cssRules) { if (r.constructor.name === 'CSSFontFaceRule') {
                          const fam = r.style.getPropertyValue('font-family'); const m = (r.style.getPropertyValue('src') || '').match(/url\\("?([^")]+)"?\\)/);
                          if (m && !out.fonts[m[1]] && Object.keys(out.fonts).length < 12) { try { const resp = await fetch(m[1]); const b = new Uint8Array(await resp.arrayBuffer()); let s = '';
                            for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); out.fonts[m[1]] = [fam, btoa(s)]; } catch (e) {} } } } } } catch (e) {}
                        for (const f of doc.querySelectorAll('iframe')) { try { await grab(f.contentDocument) } catch (e) {} } }
                      await grab(document); return out; }""")
            blob = base64.b64encode(gzip.compress(json.dumps({"path": path, **data}).encode())).decode()
            print("PROBE " + path + " " + blob, flush=True)
            log("probe done", path, len(blob))
        except Exception as e:
            log("probe err", repr(e)[:150])

    async def screenshot(self, path):
        """JPEG screenshot of the page as rendered (what a human sees)."""
        async with self.sem:
            async with self.c.tab() as tab:
                await asyncio.wait_for(tab.goto(path), timeout=self.page_timeout)
                return await tab.page.screenshot(type="jpeg", quality=85, full_page=False)

    async def pages(self, paths, **kw):
        return await asyncio.gather(*[self.page(p, **kw) for p in paths])

    async def search(self, last_name=None, dob=None, max_pages=8):
        async with self.sem:
            async with self.c.tab() as tab:
                try:
                    return await asyncio.wait_for(tab.search_patients(last_name=last_name, dob=dob, max_pages=max_pages), timeout=20)
                except Exception as e:
                    log("SEARCH err", last_name, dob, repr(e)[:200])
                    return []

    async def documents(self, path, want=("pdf",)):
        """PDF (and/or page image) bytes of a document viewer page."""
        async with self.sem:
            async with self.c.tab() as tab:
                await asyncio.wait_for(tab.goto(path), timeout=self.page_timeout)
                files = await tab.document_files(want=want)
                if not any(f.get("data") for f in files) and "image" not in want:
                    files = await tab.document_files(want=("pdf", "image"))
                return files

    async def close(self):
        await self.c.close()
