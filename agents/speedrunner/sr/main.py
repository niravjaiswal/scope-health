import asyncio, json, os, re, sys, time
from .util import log, jdump, ENV, now
from .llm import LLM
from .site import Site
from .memory import Memory
from .solver import Solver
from .queue import Queue

TOTALS = {900: 225, 1800: 458, 3600: 924, 1200: 6}
CFG = {"max_steps": int(os.environ.get("MAX_STEPS", "7")), "effort": os.environ.get("EFFORT", "medium"),
       "min_conf": float(os.environ.get("MIN_CONF", "0.75"))}


async def load_reference(site):
    from .reference import provider_directory, site_map
    t = time.time()
    try:
        site.sitemap = await site_map(site)
        log(f"SITEMAP ready {time.time()-t:.1f}s chars={len(site.sitemap)}")
        print("SITEMAP " + json.dumps(site.sitemap), flush=True)
    except Exception as e:
        log("SITEMAP err", repr(e)[:200])
    t = time.time()
    try:
        site.reference = await provider_directory(site)
        log(f"REFERENCE ready {time.time()-t:.1f}s chars={len(site.reference)}")
    except Exception as e:
        log("REFERENCE err", repr(e)[:200])


def est_total(shift):
    best = min(TOTALS, key=lambda k: abs(k - shift))
    return TOTALS[best] if abs(best - shift) < 120 else max(10, int(shift / 4))


def validate(ans):
    if ans is None: return None
    if isinstance(ans, (int, float)): return ans
    a = str(ans).strip().strip("`").strip()
    if a.startswith('"') and a.endswith('"'): a = a[1:-1].strip()
    if not a or a.lower() in ("true", "false", "null", "none", "n/a", "unknown"):
        return None
    if a.endswith(".") and len(a) > 3 and " " in a and not re.search(r"\b(Inc|Jr|Sr|St|Ltd|Co|Dr|Mt|Ave|Rd|Blvd|Ct|Ln|Pkwy|etc|Corp|LLC|P\.C|M\.D)\.$", a):
        a = a[:-1].rstrip()
    return a


async def handle_task(item, solver, deadline):
    t = time.time()
    try:
        res, info = await asyncio.wait_for(solver.solve(item, deadline), timeout=max(1, deadline - time.time()))
    except asyncio.TimeoutError:
        log("TASK timeout"); return None, {"why": "timeout"}
    except Exception as e:
        import traceback; traceback.print_exc()
        log("TASK error", repr(e)[:300]); return None, {"why": repr(e)[:200]}
    log(f"TASK result {time.time()-t:.1f}s {jdump(res, 600)}")
    if os.environ.get("DUMP_CTX", "1") == "1":
        try:
            import gzip, base64
            ctx = [{"role": m.get("role"), "content": m.get("content"), "tool_calls": m.get("tool_calls")} for m in info.get("msgs", [])[1:]]
            blob = base64.b64encode(gzip.compress(json.dumps({"id": item.get("id"), "route": info.get("route"), "ctx": ctx}, ensure_ascii=False).encode())).decode()
            print("CTX " + blob, flush=True)
        except Exception as e:
            log("CTX dump err", repr(e)[:100])
    if not res or res.get("skip"):
        return None, res or {}
    ans = validate(res.get("answer"))
    kind = ((info or {}).get("route") or {}).get("answer_kind")
    if ans is not None and isinstance(ans, str):
        digits = re.sub(r"\D", "", ans)
        if (kind == "phone" or re.search(r"(?i)phone number", item["text"])) and not (len(digits) == 10 or (len(digits) == 11 and digits[0] == "1")):
            log("GATE phone shape invalid", ans); return None, res
        if re.search(r"(\b\d\d\s+){4,}", ans):
            log("GATE suspicious digit groups", ans); return None, res
    conf = res.get("confidence")
    try: conf = float(conf)
    except Exception: conf = 0.5
    if ans is None or conf < CFG["min_conf"]:
        return None, res
    return ans, res


async def run_queue():
    shift = float(ENV["SHIFT_SECONDS"] or 900)
    total = est_total(shift)
    llm = LLM()
    site = Site(ENV["SITE_URL"], ENV["SITE_USERNAME"], ENV["SITE_PASSWORD"], n_tabs=int(os.environ.get("TABS", "2")))
    q = Queue(ENV["QUEUE_URL"])
    mem = Memory()
    await site.start()
    solver = Solver(site, llm, mem, CFG)
    asyncio.create_task(load_reference(site))
    state = await q.get()
    n = 0; tasks_seen = 0; answered = 0; skipped = 0
    while state.get("status") == "open":
        it = state["item"]; n += 1
        secs_left = float(state.get("seconds_left") or 0)
        if it["kind"] == "message":
            print("ITEM " + jdump({"n": n, "id": it["id"], "kind": "message", "secs_left": round(secs_left, 1), "text": it["text"]}), flush=True)
            mem.add(n, it["text"])
            state = await q.close(it["id"], acknowledge=True)
            continue
        tasks_seen += 1
        remaining = max(1, total - tasks_seen + 1)
        per = secs_left / remaining
        budget = max(float(os.environ.get("MIN_BUDGET", "9")), min(float(os.environ.get("MAX_BUDGET", "25")), per * 3.0)) if secs_left > 30 else max(0.0, secs_left - 4)
        print("ITEM " + jdump({"n": n, "id": it["id"], "kind": "task", "secs_left": round(secs_left, 1), "budget": round(budget, 1), "text": it["text"]}), flush=True)
        if budget < 3:
            state = await q.close(it["id"], skip=True); skipped += 1; continue
        t = time.time()
        ans, res = await handle_task(it, solver, time.time() + budget)
        if ans is None:
            state = await q.close(it["id"], skip=True); skipped += 1
            print("CLOSE " + jdump({"n": n, "skip": True, "dt": round(time.time()-t, 1), "why": (res or {}).get("reason") or (res or {}).get("why") or (res or {}).get("answer")}), flush=True)
        else:
            state = await q.close(it["id"], answer=ans); answered += 1
            print("CLOSE " + jdump({"n": n, "answer": ans, "conf": res.get("confidence"), "dt": round(time.time()-t, 1), "why": (res.get("why") or "")[:300]}), flush=True)
        log(f"PROGRESS tasks={tasks_seen} answered={answered} skipped={skipped} llm=${llm.spent:.3f} fetch={site.stats}")
    log("END", jdump(state), f"answered={answered} skipped={skipped} llm=${llm.spent:.3f}")
    await site.close()


async def run_local(path):
    """Local eval: items JSON (list of {kind,text,expected?}) against SITE_URL without a queue."""
    items = json.load(open(path))
    llm = LLM()
    site = Site(ENV["SITE_URL"], ENV["SITE_USERNAME"] or "x", ENV["SITE_PASSWORD"] or "x", n_tabs=int(os.environ.get("TABS", "2")))
    mem = Memory()
    await site.start()
    solver = Solver(site, llm, mem, CFG)
    await load_reference(site)
    only = os.environ.get("ONLY")
    results = []
    for i, it in enumerate(items):
        if it["kind"] == "message":
            mem.add(it.get("n", i + 1), it["text"]); continue
        if only and str(it.get("n")) not in only.split(","):
            continue
        t = time.time()
        ans, res = await handle_task(it, solver, time.time() + float(os.environ.get("BUDGET", "45")))
        exp = it.get("expected")
        from .compare import same
        ok = None if exp is None else same(ans, exp)
        print("LOCAL " + jdump({"n": it.get("n"), "text": it["text"][:120], "answer": ans, "expected": exp, "ok": ok,
                                 "conf": (res or {}).get("confidence"), "dt": round(time.time() - t, 1)}), flush=True)
        results.append(ok)
    log("LOCAL done", f"correct={sum(1 for r in results if r)} wrong={sum(1 for r in results if r is False)} n={len(results)} llm=${llm.spent:.3f}")
    await site.close()


def main():
    if len(sys.argv) > 2 and sys.argv[1] == "--local":
        asyncio.run(run_local(sys.argv[2]))
    else:
        asyncio.run(run_queue())


if __name__ == "__main__":
    main()
