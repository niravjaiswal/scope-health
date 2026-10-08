import asyncio, json, os, time, gzip, base64, urllib.request, urllib.error, urllib.parse
import wfcrawl
from wfcrawl import log

Q = os.environ.get("QUEUE_URL", "").rstrip("/")
SITE = os.environ.get("SITE_URL", "").rstrip("/")
SHIFT = float(os.environ.get("SHIFT_SECONDS", "900"))
CRAWL_FRAC = float(os.environ.get("CRAWL_FRAC", "0.85"))

def req(method, url, body=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"} if data else {})
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp: return resp.status, resp.read().decode()
    except urllib.error.HTTPError as e: return e.code, e.read().decode()
    except Exception as e: return -1, repr(e)

buf = []; bufsize = 0; chunk_no = 0
def flush():
    global buf, bufsize, chunk_no
    if not buf: return
    raw = "\n".join(buf).encode()
    b = base64.b64encode(gzip.compress(raw, 9)).decode()
    chunk_no += 1
    for i in range(0, len(b), 8000):
        print(f"DUMP {chunk_no} {i//8000} {b[i:i+8000]}", flush=True)
    print(f"DUMPEND {chunk_no} pages_in_chunk={len(buf)}", flush=True)
    buf = []; bufsize = 0

npages = 0
def on_page(r):
    global bufsize, npages
    npages += 1
    s = json.dumps(r, ensure_ascii=False)
    buf.append(s); bufsize += len(s)
    if npages % 50 == 0: log("pages", npages, "last", r.get('path'), "dt", round(r.get('dt', 0), 2))
    if bufsize > 400000: flush()

async def main():
    st, body = req("GET", Q + "/item") if Q else (0, "{}")
    log("FIRST_ITEM", body[:300])
    br = wfcrawl.Browser(SITE, os.environ.get("SITE_USERNAME", "x"), os.environ.get("SITE_PASSWORD", "x"), n_pages=int(os.environ.get("NPAGES", "6")))
    await br.start()
    html = await br.shell_html()
    print("SHELL_HTML_B64 " + base64.b64encode(gzip.compress(html.encode())).decode(), flush=True)
    deadline = wfcrawl.T0 + SHIFT * CRAWL_FRAC
    import re as _re
    ver = _re.findall(r"Wrenfield\s*</span>\s*<span[^>]*>\s*([0-9.]+)|>([0-9]+\.[0-9]+\.[0-9]+)<", html)
    log("VERSION_HINTS", ver[:5])
    only = os.environ.get("ONLY_VERSION")
    if only and only not in html:
        log("NOT TARGET VERSION -> skipping crawl"); deadline = 0
    seeds = ["/", "/patients", "/schedule", "/billing", "/documents", "/activity", "/about/notices"]
    try:
        names = json.load(open(os.path.join(os.path.dirname(__file__), "set1_lastnames.json")))
        seeds = ["/patients?lastName=" + urllib.parse.quote(n) for n in names] + seeds
    except Exception as e:
        log("no names", e)
    done, seen, left = await wfcrawl.crawl(br, seeds, deadline, on_page, workers=int(os.environ.get("NPAGES", "6")))
    flush()
    log("CRAWL_DONE pages", done, "seen", seen, "queue_left", left)
    await br.close()
    # drain queue
    state = json.loads(body) if body and body.startswith("{") else {}
    n = 0
    while Q and state.get("status") == "open":
        it = state["item"]; n += 1
        print("ITEM_JSON " + json.dumps({"n": n, **it}, ensure_ascii=False), flush=True)
        payload = {"id": it["id"], "acknowledge": True} if it["kind"] == "message" else {"id": it["id"], "skip": True}
        st, b2 = req("POST", Q + "/item/close", payload)
        try: state = json.loads(b2)
        except Exception: break
        if st != 200: state = state.get("state", {})
    log("END", n)

asyncio.run(main())
