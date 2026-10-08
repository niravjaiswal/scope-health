import asyncio, time, os, json, statistics, urllib.request
from util import log
from browser import Browser
import httpx

SITE = os.environ.get("SITE_URL", "https://practice.speedrun.scopehealth.com").rstrip("/")
Q = os.environ.get("QUEUE_URL", "").rstrip("/")

async def timed_many(b, paths):
    t = time.time()
    rs = await b.fetch_many(paths, fresh=True)
    return time.time() - t, [round(r.dt or -1, 2) for r in rs], sum(1 for r in rs if r.error)

async def main():
    # hold the first item open
    first = None
    if Q:
        first = httpx.get(Q + "/item").json(); log("FIRST", json.dumps(first)[:200])
    import resource
    # 1) raw HTTP latency (no browser): shell GET
    c = httpx.Client(timeout=30)
    ts = []
    for i in range(5):
        t = time.time(); r = c.get(SITE + "/login"); ts.append(time.time() - t)
    log("RAW GET /login", [round(x, 3) for x in ts])
    b = Browser(SITE, os.environ.get("SITE_USERNAME", "x"), os.environ.get("SITE_PASSWORD", "x"), n_pages=8)
    await b.start()
    p = await b.fetch("/patients?lastName=Smith", fresh=True)
    pids = [h for _, h in p.links if h.startswith('/patients/') and h.count('/') == 2][:8]
    log("pids", pids)
    tabs = ["", "/insurance", "/problems", "/notes", "/documents", "/appointments", "/activity"]
    # sequential single page
    seq = []
    for pid in pids[:4]:
        t = time.time(); r = await b.fetch(pid, fresh=True); seq.append(round(time.time() - t, 2))
    log("SEQ 1-at-a-time", seq)
    for n in (2, 4, 8):
        paths = [pids[i % len(pids)] + tabs[i % len(tabs)] for i in range(n)]
        dt, each, err = await timed_many(b, paths)
        log(f"PAR {n} same-context total={dt:.2f} each={each} err={err}")
    # separate contexts (separate sessions)
    bs = []
    for k in range(3):
        bb = Browser(SITE, os.environ.get("SITE_USERNAME", "x"), os.environ.get("SITE_PASSWORD", "x"), n_pages=2)
        await bb.start(); bs.append(bb)
    t = time.time()
    rs = await asyncio.gather(*[bb.fetch(pids[i] + "/appointments", fresh=True) for i, bb in enumerate(bs)])
    log(f"PAR 3 separate-sessions total={time.time()-t:.2f} each={[round(r.dt,2) for r in rs]}")
    t = time.time()
    rs = await asyncio.gather(*[bb.fetch(pids[(i+j) % len(pids)] + tabs[j], fresh=True) for i, bb in enumerate(bs) for j in range(2)])
    log(f"PAR 6 = 3 sessions x 2 total={time.time()-t:.2f} each={[round(r.dt,2) for r in rs]}")
    # timing breakdown of one page load
    pg = b.pages[0]
    evs = []
    pg.on("requestfinished", lambda r: evs.append((round(time.time() - T, 3), r.method, r.url[-40:], round(r.timing.get('responseEnd', -1)) if r.timing else None)))
    T = time.time()
    await b._fetch(pids[0] + "/appointments")
    log("BREAKDOWN", json.dumps(evs))
    log("RU", resource.getrusage(resource.RUSAGE_SELF).ru_utime, resource.getrusage(resource.RUSAGE_CHILDREN).ru_utime)
    try:
        import psutil
    except Exception:
        pass
    log("loadavg", os.getloadavg())
    await b.close()
    for bb in bs: await bb.close()
    # drain queue
    st = first
    while Q and st and st.get("status") == "open":
        it = st["item"]
        payload = {"id": it["id"], "acknowledge": True} if it["kind"] == "message" else {"id": it["id"], "skip": True}
        st = httpx.post(Q + "/item/close", json=payload).json()
    log("END")
asyncio.run(main())
