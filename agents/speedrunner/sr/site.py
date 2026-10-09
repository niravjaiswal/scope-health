"""Site access layer: a bounded pool of logged-in tabs; every operation has a hard timeout and always returns its tab."""
import asyncio, os, re, time
from .util import log, now
from .wf.wf_client import WrenfieldClient, WrenfieldError

TRUNC_RE = re.compile(r"is busy, so this list shows fewer|fewer rows than usual|Open it again in a moment", re.I)
BUSY_RE = re.compile(r"503 Service|Service Temporarily Unavailable|is not responding|Too Many Requests|Bad Gateway", re.I)
VLINK_RE = re.compile(r"\s*<\/v\/[^>]*>")


class Site:
    def __init__(self, base, user, pw, n_tabs=2):
        self.c = WrenfieldClient(base, user, pw, launch_args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"])
        self.base = base.rstrip("/")
        self.n_tabs = n_tabs
        self.max_tabs = n_tabs + 1
        self.pool = asyncio.Queue()
        self.tabs = []
        self.bg_lock = asyncio.Semaphore(1)
        self.cache = {}       # path -> (t, text)
        self.inflight = {}
        self.stats = {"fetch": 0, "fail": 0, "time": 0.0, "starved": 0, "recycled": 0}
        self.today = None
        self.nav = []
        self.version = ""
        self.page_timeout = float(os.environ.get("PAGE_TIMEOUT", "9"))
        self.probed_kinds = set()
        self.probe_budget = int(os.environ.get("PROBES", "8"))
        self.reference = ""
        self.sitemap = ""

    # ------------------------------------------------------------------ lifecycle
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
        for tab in await asyncio.gather(*[self._new_tab() for _ in range(self.n_tabs)], return_exceptions=True):
            if not isinstance(tab, Exception):
                self.pool.put_nowait(tab)
        log("SITE pool", self.pool.qsize())
        try:
            dash = await asyncio.wait_for(self.c.main.get_text("/"), timeout=15)
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

    async def _new_tab(self):
        tab = await self.c._new_tab()
        self.tabs.append(tab)
        await asyncio.wait_for(tab.goto("/", fresh=True), timeout=20)
        return tab

    async def _recycle(self, tab):
        self.stats["recycled"] += 1
        tab._inflight = 0
        try:
            await asyncio.wait_for(tab.page.goto(self.base + "/", wait_until="domcontentloaded"), timeout=15)
            await asyncio.wait_for(tab.wait_settled(timeout=8), timeout=10)
        except Exception as e:
            log("TAB recycle failed -> new tab", repr(e)[:100])
            try:
                await tab.page.close()
            except Exception:
                pass
            try:
                self.tabs.remove(tab)
            except ValueError:
                pass
            try:
                tab = await self._new_tab()
            except Exception as e2:
                log("TAB new failed", repr(e2)[:100]); return
        self.pool.put_nowait(tab)

    async def use(self, fn, timeout, background=False, label=""):
        """Run fn(tab) with a pooled tab under a hard timeout. The tab always goes back (recycled if anything went wrong)."""
        if background:
            async with self.bg_lock:
                return await self._use(fn, timeout, label)
        return await self._use(fn, timeout, label)

    async def _use(self, fn, timeout, label):
        try:
            tab = await asyncio.wait_for(self.pool.get(), timeout=6)
        except asyncio.TimeoutError:
            self.stats["starved"] += 1
            log(f"POOL starved ({label}); tabs={len(self.tabs)}")
            if len(self.tabs) < self.max_tabs + 1:
                tab = await self._new_tab()
            else:
                raise WrenfieldError("no free tab")
        ok = False
        try:
            r = await asyncio.wait_for(fn(tab), timeout=timeout)
            ok = True
            return r
        finally:
            if ok:
                self.pool.put_nowait(tab)
            else:
                asyncio.ensure_future(self._recycle(tab))

    # ------------------------------------------------------------------ reads
    async def page(self, path, fresh=False, max_age=None, retries=2, background=False):
        """Decoded text of a page (cached; concurrent requests for the same path share one load)."""
        c = self.cache.get(path)
        if c and not fresh and (max_age is None or now() - c[0] <= max_age):
            return c[1]
        if path in self.inflight and not fresh:
            try:
                return await asyncio.wait_for(asyncio.shield(self.inflight[path]), timeout=self.page_timeout * 2)
            except Exception:
                return "ERROR waiting for page"
        fut = asyncio.get_event_loop().create_future()
        self.inflight[path] = fut
        txt = "ERROR"
        try:
            txt = await self._load(path, retries, background)
            if txt and not txt.startswith("ERROR") and not txt.startswith("WARNING"):
                self.cache[path] = (now(), txt)
            return txt
        except BaseException as e:
            txt = f"ERROR {type(e).__name__}"
            raise
        finally:
            if not fut.done():
                fut.set_result(txt)
            self.inflight.pop(path, None)

    async def _load(self, path, retries, background):
        last = ""
        for attempt in range(retries + 1):
            t = time.time()
            try:
                txt = await self.use(lambda tab: tab.get_text(path), self.page_timeout, background, label=path)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                txt = f"ERROR {e!r}"[:300]
            dt = time.time() - t
            self.stats["fetch"] += 1; self.stats["time"] += dt
            if txt and not txt.startswith("ERROR") and not (BUSY_RE.search(txt[:400]) and len(txt) < 600):
                if TRUNC_RE.search(txt) and attempt < retries:
                    self.stats["trunc"] = self.stats.get("trunc", 0) + 1
                    log(f"PAGE truncated-busy {path} attempt={attempt}; retrying")
                    last = txt
                    await asyncio.sleep(0.6 * (attempt + 1))
                    continue
                if dt > 2.5 or self.stats["fetch"] <= 40: log(f"PAGE {path} {dt:.2f}s")
                self._maybe_probe(path)
                return VLINK_RE.sub("", txt)
            self.stats["fail"] += 1
            last = txt
            log(f"PAGE retry {path} attempt={attempt} dt={dt:.1f} {txt[:120]!r}")
            await asyncio.sleep(0.3 * (attempt + 1))
        if last and TRUNC_RE.search(last):
            return "WARNING: the server was busy and this list is TRUNCATED (rows missing). Do not count from it; reopen later or skip.\n" + VLINK_RE.sub("", last)
        return last or "ERROR"

    async def pages(self, paths, **kw):
        return await asyncio.gather(*[self.page(p, **kw) for p in paths])

    async def page_all(self, path, max_pages=15, timeout=18):
        async def fn(tab):
            await tab.goto(path)
            pages = await tab.paginate_all(max_pages=max_pages)
            return "\n\n--- next page ---\n\n".join(pages)
        try:
            return VLINK_RE.sub("", await self.use(fn, timeout, label="all:" + path))
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log("page_all failed", path, repr(e)[:120])
            return await self.page(path)

    async def search(self, last_name=None, dob=None, max_pages=6):
        try:
            return await self.use(lambda tab: tab.search_patients(last_name=last_name, dob=dob, max_pages=max_pages), 14, label=f"search {last_name or dob}")
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log("SEARCH err", last_name, dob, repr(e)[:200])
            return []

    async def find_patient(self, last, first=None, dob=None, max_pages=14):
        """Name search that copes with phonetic matching, pagination, sort order and 'busy' truncated pages.
        Returns all rows read (caller filters). Stops once the alphabetical position passes the target."""
        import unicodedata
        def nrm(x):
            x = unicodedata.normalize("NFKD", x or "")
            return "".join(c for c in x if not unicodedata.combining(c)).casefold().strip()
        tl, tf = nrm(last), nrm(first or "")
        async def fn(tab):
            from urllib.parse import quote
            rows_all = []
            await tab.goto("/patients?lastName=" + quote(last))
            for attempt in range(3):
                txt = await tab.text(max_options=0)
                if not TRUNC_RE.search(txt): break
                await asyncio.sleep(0.5 + 0.5 * attempt)
                await tab.goto("/patients?lastName=" + quote(last), fresh=True)
            # biggest page size available
            try:
                for fr in tab.page.frames:
                    loc = fr.locator('select[name="size"]')
                    if await loc.count():
                        opts = await loc.first.evaluate("s => [...s.options].map(o=>o.value)")
                        best = max(opts, key=lambda v: int(re.sub(r"\D", "", v) or 0))
                        cur = await loc.first.evaluate("s => s.value")
                        if best != cur:
                            await loc.first.select_option(value=best)
                            await asyncio.sleep(0.03); await tab.wait_settled(timeout=8)
                        break
            except Exception:
                pass
            for page_no in range(max_pages):
                rows = None
                for attempt in range(3):
                    txt = await tab.text(max_options=0)
                    rows = await tab._patient_rows()
                    if not TRUNC_RE.search(txt): break
                    self.stats["trunc"] = self.stats.get("trunc", 0) + 1
                    await asyncio.sleep(0.6 + 0.4 * attempt)
                    try:
                        await tab.page.evaluate("() => 0")
                        await tab.reload()
                    except Exception:
                        pass
                rows = rows or []
                rows_all.extend(rows)
                found = any(nrm((r.get("name") or "").split(",")[0]) == tl and (not tf or nrm((r.get("name") or "").split(",", 1)[-1]).startswith(tf.split(" ")[0])) for r in rows)
                passed = False
                if rows and not dob:
                    ln = nrm((rows[-1].get("name") or "").split(",")[0]); fn_ = nrm((rows[-1].get("name") or "").split(",", 1)[-1])
                    passed = (ln > tl) or (ln == tl and tf and fn_ > tf + "\uffff")
                if (found and not dob and passed) or passed or not rows:
                    break
                if not await tab._has_enabled_button("Next"):
                    break
                await tab.click_by_text("Next", contains=False, navigate_links=False)
            return rows_all
        try:
            return await self.use(fn, 25, label=f"find {last}")
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log("FIND err", last, repr(e)[:200])
            return []

    async def documents(self, path, want=("pdf",)):
        async def fn(tab):
            await tab.goto(path)
            files = await tab.document_files(want=want)
            if not any(f.get("data") for f in files) and "image" not in want:
                files = await tab.document_files(want=("pdf", "image"))
            return files
        return await self.use(fn, 12, label="doc " + path)

    async def screenshot(self, path):
        async def fn(tab):
            await tab.goto(path)
            return await tab.page.screenshot(type="jpeg", quality=85, full_page=False)
        return await self.use(fn, 10, label="shot " + path)

    async def query(self, path, fields, all_pages=False):
        async def fn(tab):
            await tab.goto(path)
            done = []
            for k, v in (fields or {}).items():
                v = str(v)
                try:
                    loc = await tab._field(k)
                    tag = await loc.evaluate("e => e.tagName")
                    if tag == "SELECT":
                        try:
                            await loc.select_option(label=v, timeout=2500)
                        except Exception:
                            opts = await loc.evaluate("e => [...e.options].map(o => [o.value, o.textContent.trim()])")
                            m = next((o for o in opts if o[1].lower() == v.lower()), None) or \
                                next((o for o in opts if o[1].lower().startswith(v.lower()) or v.lower() in o[1].lower() or o[0] == v), None)
                            if not m:
                                return f"ERROR: option {v!r} not in field {k!r}. Options: " + "; ".join(o[1] for o in opts[:40])
                            await loc.select_option(value=m[0], timeout=2500)
                    else:
                        await loc.fill(v, timeout=2500)
                    done.append(k)
                except Exception as e:
                    return f"ERROR setting field {k!r}: {type(e).__name__}. Check the field names (SITE MAP lists them)."
            clicked = False
            for bt in ("Apply filters", "Apply", "Show appointments", "Show", "Search", "Find", "Filter", "Go", "Submit"):
                try:
                    if await tab._has_enabled_button(bt):
                        await tab.click_by_text(bt, contains=False, navigate_links=False); clicked = True; break
                except Exception:
                    continue
            if not clicked and done:
                try:
                    loc = await tab._field(done[-1]); await loc.press("Enter"); await asyncio.sleep(0.05); await tab.wait_settled(timeout=8)
                except Exception:
                    pass
            if all_pages:
                pages = await tab.paginate_all(max_pages=15)
                return "\n\n--- next page ---\n\n".join(pages)
            return await tab.text()
        try:
            return VLINK_RE.sub("", await self.use(fn, 20 if all_pages else 12, label="query " + path))
        except asyncio.CancelledError:
            raise
        except Exception as e:
            return f"ERROR {e!r}"[:300]

    # ------------------------------------------------------------------ recon
    def _maybe_probe(self, path):
        pk = re.sub(r"[0-9a-z]{10}", "<id>", path.split("?")[0])
        if self.probe_budget > 0 and pk not in self.probed_kinds and re.match(r"^/(patients|payers|claims|billing|vaccines|settings|staff|schedule)", pk):
            self.probed_kinds.add(pk); self.probe_budget -= 1
            asyncio.ensure_future(self.probe_html(path))

    async def probe_html(self, path):
        """Recon: print raw HTML of the content frames + fonts used, gzip+b64 (to learn how this version renders data)."""
        import gzip, base64, json
        async def fn(tab):
            await tab.goto(path)
            return await tab.page.evaluate("""async () => { const out = {frames: [], fonts: {}, css: []};
              async function grab(doc) {
                out.frames.push((doc.body ? doc.body.innerHTML : '').slice(0, 60000));
                try { for (const ss of doc.styleSheets) { let txt = ''; try { for (const r of ss.cssRules) txt += r.cssText + '\\n'; } catch (e) {} out.css.push(txt.slice(0, 80000));
                  for (const r of ss.cssRules) { if (r.constructor.name === 'CSSFontFaceRule') {
                  const fam = r.style.getPropertyValue('font-family'); const m = (r.style.getPropertyValue('src') || '').match(/url\\("?([^")]+)"?\\)/);
                  if (m && !out.fonts[m[1]] && Object.keys(out.fonts).length < 12) { try { const resp = await fetch(m[1]); const b = new Uint8Array(await resp.arrayBuffer()); let s = '';
                    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); out.fonts[m[1]] = [fam, btoa(s)]; } catch (e) {} } } } } } catch (e) {}
                for (const f of doc.querySelectorAll('iframe')) { try { await grab(f.contentDocument) } catch (e) {} } }
              await grab(document); return out; }""")
        try:
            data = await self.use(fn, 15, background=True, label="probe")
            blob = base64.b64encode(gzip.compress(json.dumps({"path": path, **data}).encode())).decode()
            print("PROBE " + path + " " + blob, flush=True)
        except Exception as e:
            log("probe err", repr(e)[:150])

    async def close(self):
        await self.c.close()
