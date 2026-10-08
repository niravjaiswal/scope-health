"""cartographer: polite BFS crawl of the practice clinic (GET navigation only, read-only).
Records for each page: title/h1, forms, links, buttons, tables, deferred loaders, non-icon svgs, fonts."""
import asyncio, time, sys, json, os, re
from urllib.parse import urlparse
from bs4 import BeautifulSoup
from playwright.async_api import async_playwright

BASE = "https://practice.speedrun.scopehealth.com"
OUT = "/Users/nirav/development/scope health/research/cart_out/crawl"
os.makedirs(OUT, exist_ok=True)
SKIP = {"/patients/all"}  # honeypot (aria-hidden link)


def pattern(path):
    p = re.sub(r"/[0-9a-z]{10}(?=/|$|\?)", "/<id>", path)
    p = re.sub(r"\d{4}-\d{2}-\d{2}", "<date>", p)
    return p


async def load(pg, path):
    t = time.time()
    await pg.goto(BASE + path, wait_until="domcontentloaded")
    fr = None
    for _ in range(200):
        for f in pg.frames:
            if "/v/" in f.url and f != pg.main_frame:
                fr = f
        if fr:
            try:
                ok = await fr.evaluate("document.readyState!=='loading' && !document.documentElement.hasAttribute('aria-busy')")
                if ok:
                    break
            except Exception:
                pass
        await asyncio.sleep(0.03)
    return fr, time.time() - t


def summarize(html):
    s = BeautifulSoup(html, "lxml")
    for t in s(["script", "style"]):
        t.decompose()
    info = {}
    info["title"] = s.title.get_text(strip=True) if s.title else None
    info["h1"] = [h.get_text(" ", strip=True) for h in s.find_all("h1")]
    info["h2"] = [h.get_text(" ", strip=True) for h in s.find_all(["h2", "h3"])][:30]
    links = []
    for a in s.find_all("a"):
        href = a.get("href")
        hidden = a.get("aria-hidden") == "true" or a.has_attr("hidden") or a.get("tabindex") == "-1"
        links.append({"href": href, "text": a.get_text(" ", strip=True)[:60], "hidden": hidden})
    info["links"] = links
    info["buttons"] = [b.get_text(" ", strip=True)[:60] + (" [" + (b.get("aria-label") or "") + "]" if b.get("aria-label") else "") for b in s.find_all("button")]
    forms = []
    for f in s.find_all(["form", "search"]):
        if f.name == "search":
            continue
        fields = []
        for i in f.find_all(["input", "select", "textarea"]):
            d = {"tag": i.name, "name": i.get("name"), "type": i.get("type"), "value": i.get("value")}
            if i.name == "select":
                d["options"] = [(o.get("value"), o.get_text(strip=True), o.has_attr("selected")) for o in i.find_all("option")][:40]
            fields.append(d)
        forms.append(fields)
    info["forms"] = forms
    tables = []
    for tb in s.find_all("table"):
        cap = tb.find("caption")
        hdr = [th.get_text(" ", strip=True) for th in tb.find_all("th", attrs={"scope": "col"})] or [th.get_text(" ", strip=True) for th in (tb.find("thead") or tb).find_all("th")]
        rows = tb.find_all("tr")
        tables.append({"caption": cap.get_text(" ", strip=True) if cap else None, "hdr": hdr, "rows": len(rows)})
    info["tables"] = tables
    svgs = [sv for sv in s.find_all("svg") if sv.get("viewBox") != "0 0 24 24"]
    info["nonicon_svgs"] = [(sv.get("viewBox"), sv.get("aria-label"), sv.get("role"), len(str(sv))) for sv in svgs][:10]
    info["imgs"] = [(i.get("src", "")[:60], i.get("alt")) for i in s.find_all("img")]
    info["canvas"] = len(s.find_all("canvas"))
    info["iframes"] = [i.get("src") for i in s.find_all("iframe")]
    info["dl"] = [[dt.get_text(" ", strip=True) for dt in dl.find_all("dt")] for dl in s.find_all("dl")]
    info["details"] = [d.find("summary").get_text(" ", strip=True)[:60] if d.find("summary") else None for d in s.find_all("details")]
    info["text_len"] = len(s.get_text())
    return info


async def main(start_paths, max_pages, per_pattern):
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=True)
        ctx = await b.new_context(viewport={"width": 1400, "height": 1000}, bypass_csp=True)
        pg = await ctx.new_page()
        seen, pat_count, queue = set(), {}, list(start_paths)
        results = {}
        while queue and len(results) < max_pages:
            path = queue.pop(0)
            if path in seen or path in SKIP:
                continue
            seen.add(path)
            pt = pattern(path)
            if pat_count.get(pt, 0) >= per_pattern:
                continue
            pat_count[pt] = pat_count.get(pt, 0) + 1
            fr, dt = await load(pg, path)
            if not fr:
                print("NOFRAME", path)
                continue
            html = await fr.content()
            fn = re.sub(r"[^a-zA-Z0-9]+", "_", path).strip("_") or "root"
            open(f"{OUT}/{fn}.html", "w").write(html)
            info = summarize(html)
            info["shell_url"] = pg.url
            info["load_s"] = round(dt, 3)
            results[path] = info
            print(f"{dt:.2f}s {path} -> {pg.url} title={info['title']} links={len(info['links'])} tables={[(t['caption'], t['rows']) for t in info['tables']]}")
            for l in info["links"]:
                h = l["href"]
                if not h or l["hidden"]:
                    continue
                u = urlparse(h)
                if u.netloc and u.netloc not in BASE:
                    continue
                if not u.path.startswith("/") or u.path.startswith("/v/") or u.path.startswith("/static"):
                    continue
                full = u.path + ("?" + u.query if u.query else "")
                if full not in seen:
                    queue.append(full)
            await asyncio.sleep(0.15)
        json.dump(results, open(f"{OUT}/crawl.json", "w"), indent=1)
        await b.close()

if __name__ == "__main__":
    starts = sys.argv[1].split(",") if len(sys.argv) > 1 else ["/", "/patients", "/schedule", "/billing", "/documents", "/activity", "/about/notices"]
    asyncio.run(main(starts, int(sys.argv[2]) if len(sys.argv) > 2 else 80, int(sys.argv[3]) if len(sys.argv) > 3 else 2))
