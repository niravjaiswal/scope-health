"""Benchmark vision LLMs for Wrenfield document transcription.
  python docs_bench.py gt                       -> build gt_all.json (manual scans + auto GT from glyph-decoded vector PDFs) + synthetic scans
  python docs_bench.py run <cfg,...> [--docs set] [--runs N] [--conc N]
  python docs_bench.py report
Results: research/bench_out/docs_vision.jsonl"""
import sys, os, json, re, time, glob, random, asyncio, io, statistics
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wf_docs
ROOT = "/Users/nirav/development/scope health"
D = f"{ROOT}/research/docs_samples"
OUT = f"{ROOT}/research/bench_out/docs_vision.jsonl"

def load_env():
    for line in open(f"{ROOT}/.env.dev"):
        line = line.strip()
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

def norm(s):
    s = s.replace("|", " ").replace(" ", " ")
    return re.sub(r"\s+", " ", s).strip()

# ---------------- ground truth ----------------
def auto_gt(did, text):
    lines = text.split("\n")
    if "LABORATORY REPORT" in text:
        p = wf_docs.parse_lab_report(text)
        f = {k: p.get(k) for k in ["patient", "date_of_birth", "sex", "record_number", "collected", "received", "report_number", "panel"]}
        rows = [[t["test"], t["result"], t["units"], t["range"], t["flag"]] for t in p["tests"]]
        keys = [v for k, v in f.items() if v and k != "sex"] + [f"Tests reported: {p.get('tests_reported')}"]
        m = re.search(r"Clinical Laboratory, [A-Za-z ]+", text)
        if m: keys.append(m.group(0).strip())
        return {"type": "lab", "keys": keys, "fields": f, "rows": rows}
    if "STATEMENT" in text:
        toks = re.findall(r"-?\$[\d,]+\.\d\d|\b\d{4}-\d\d-\d\d\b|\bHG\d{7}\b|\d{3}-\d{3}-\d{4}", text)
        name = lines[5].split("|")[0].strip() if len(lines) > 5 else ""
        return {"type": "statement", "keys": sorted(set(toks)) + ([name] if name else []), "rows": []}
    keys = [lines[0].strip()]
    for pat in [r"Date: (\S+)", r"Patient: ([^|\n]+)", r"Date of birth: (\S+)", r"(Referral Coordinator, [A-Za-z ]+)",
                r"(\d{3}-\d{3}-\d{4})", r"Fax (\d{3}-\d{3}-\d{4})", r"^(\d+ [^|\n]+Suite \d+)"]:
        m = re.search(pat, text, re.M)
        if m: keys.append(m.group(1).strip())
    flat = norm(text)
    m = re.search(r"(?:reason(?: for this referral)?(?: is as follows)?|following problem|referred for this reason|reason is)\s*:\s*([^.]+)\.", flat)
    if m: keys.append(m.group(1).strip())
    m = re.search(r"\b(routine|urgent)\b", flat.split("Sincerely")[0])
    if m: keys.append(m.group(1))
    sig = [l for l in lines if re.search(r", (MD|DO|NP|PA-C|PA|RN)$", l.strip())]
    if sig: keys.append(sig[-1].strip())
    return {"type": "referral", "keys": keys, "rows": []}

def degrade(png_bytes, seed):
    from PIL import Image, ImageDraw
    rnd = random.Random(seed)
    im = Image.open(io.BytesIO(png_bytes)).convert("L")
    im = im.rotate(rnd.uniform(-0.7, 0.7), resample=Image.BICUBIC, fillcolor=255, expand=False)
    im = im.point(lambda v: 0 if v < 150 else 255).convert("L")
    dr = ImageDraw.Draw(im)
    W, H = im.size
    for _ in range(2500):
        x, y = rnd.randrange(W), rnd.randrange(H); r = rnd.choice([1, 1, 1, 2])
        dr.ellipse([x, y, x + r, y + r], fill=0)
    im = im.convert("1")
    b = io.BytesIO(); im.save(b, "PNG", optimize=True); return b.getvalue()

def build_gt():
    gt = json.load(open(f"{D}/gt_scans.json"))
    for k in gt: gt[k]["set"] = "scan"; gt[k]["png"] = f"{D}/{k}_p1.png"
    os.makedirs(f"{D}/synth", exist_ok=True)
    for i, gf in enumerate(sorted(glob.glob(f"{D}/*.glyph.txt"))):
        did = os.path.basename(gf).split(".")[0]
        g = auto_gt(did, open(gf).read())
        g["set"] = "clean"; g["png"] = f"{D}/{did}_p1.png"
        gt[did] = g
        sp = f"{D}/synth/{did}_synth.png"
        open(sp, "wb").write(degrade(open(g["png"], "rb").read(), i))
        gt[did + "_synth"] = dict(g, set="synth", png=sp)
    json.dump(gt, open(f"{D}/gt_all.json", "w"), indent=1)
    from collections import Counter
    print(len(gt), Counter((v["set"], v["type"]) for v in gt.values()))

def score(g, text):
    nt = norm(text)
    keys_ok = [k for k in g["keys"] if norm(k) in nt]
    miss = [k for k in g["keys"] if norm(k) not in nt]
    nlines = [norm(l) for l in text.split("\n")]
    rows_ok = 0; rmiss = []
    for r in g.get("rows", []):
        core = norm(" ".join(r[:3]))
        if any(core in l for l in nlines) or core in nt: rows_ok += 1
        else: rmiss.append(core)
    fields_ok = None
    if g["type"] == "lab" and g.get("fields"):
        p = wf_docs.parse_lab_report(text)
        fm = {k: (p.get(k) or "").strip() == (v or "").strip() for k, v in g["fields"].items()}
        tests = [(t["test"], t["result"], t["units"]) for t in p["tests"]]
        fields_ok = all(fm.values()) and tests == [tuple(r[:3]) for r in g["rows"]]
    n = len(g["keys"]) + len(g.get("rows", []))
    ok = len(keys_ok) + rows_ok
    return {"items": n, "ok": ok, "perfect": ok == n, "parse_ok": fields_ok, "miss": (miss + rmiss)[:8]}

# ---------------- configs ----------------
CFG = {
  "g38f_min":   ("google/gemini-3.8-flash", {"reasoning": {"effort": "minimal"}}),
  "g38f_low":   ("google/gemini-3.8-flash", {"reasoning": {"effort": "low"}}),
  "g35f_min":   ("google/gemini-3.5-flash", {"reasoning": {"effort": "minimal"}}),
  "g35fl":      ("google/gemini-3.5-flash-lite", {}),
  "g31fl":      ("google/gemini-3.1-flash-lite", {}),
  "g25fl":      ("google/gemini-2.5-flash-lite", {}),
  "g25f":       ("google/gemini-2.5-flash", {"reasoning": {"max_tokens": 0}}),
  "luna6_min":  ("openai/gpt-6-luna", {"reasoning": {"effort": "minimal"}}),
  "luna6_none": ("openai/gpt-6-luna", {"reasoning": {"effort": "none"}}),
  "luna56_min": ("openai/gpt-5.6-luna", {"reasoning": {"effort": "minimal"}}),
  "sol61_min":  ("openai/gpt-6.1-sol", {"reasoning": {"effort": "minimal"}}),
  "haiku55":    ("anthropic/claude-haiku-5.5", {}),
  "haiku55_off":("anthropic/claude-haiku-5.5", {"reasoning": {"enabled": False}}),
  "haiku55_tp": ("anthropic/claude-haiku-5.5", {"reasoning": {"enabled": False}, "provider": {"sort": "throughput"}}),
  "haiku55_lat":("anthropic/claude-haiku-5.5", {"reasoning": {"enabled": False}, "provider": {"sort": "latency"}}),
  "g38f_tp":    ("google/gemini-3.8-flash", {"reasoning": {"effort": "minimal"}, "provider": {"sort": "throughput"}}),
  "sonnet55":   ("anthropic/claude-sonnet-5.5", {"reasoning": {"effort": "low"}}),
  "mistral_s":  ("mistralai/mistral-small-2603", {}),
  "scout":      ("meta-llama/llama-4-scout", {"provider": {"sort": "throughput"}}),
  "maverick":   ("meta-llama/llama-4-maverick", {"provider": {"sort": "throughput"}}),
  "gemma4":     ("google/gemma-4-31b-it", {"provider": {"sort": "throughput"}}),
  "ling_vl":    ("inclusionai/ling-3.0-flash-vl", {}),
  "qwen_omni":  ("qwen/qwen3.8-omni-flash", {}),
  "gpt41mini":  ("openai/gpt-4.1-mini", {}),
  "gpt41nano":  ("openai/gpt-4.1-nano", {}),
  "gpt5nano":   ("openai/gpt-5-nano", {"reasoning": {"effort": "minimal"}}),
  "mimo_flash": ("xiaomi/mimo-v2.6-flash", {"reasoning": {"enabled": False}}),
  "dsv_vision": ("deepseek/deepseek-v4-flash-vision-exp", {}),
  "glm53f":     ("z-ai/glm-5.3-flash", {"reasoning": {"enabled": False}}),
  "nova2lite":  ("amazon/nova-2-lite-v1", {}),
  "perceptron": ("perceptron/perceptron-mk1.5", {}),
}

async def run(cfgs, docset, runs, conc, width, fmt, tag):
    load_env()
    llm = wf_docs.make_llm_call(timeout=90)
    gt = json.load(open(f"{D}/gt_all.json"))
    docs = [k for k, v in gt.items() if v["set"] in docset.split("+")]
    if os.environ.get("DOC_LIMIT"):
        lim = int(os.environ["DOC_LIMIT"]); random.Random(1).shuffle(docs); docs = sorted(docs[:lim])
    sem = asyncio.Semaphore(conc)
    jobs = [(c, d, r) for r in range(runs) for c in cfgs for d in docs]
    total = {"cost": 0.0}
    async def one(c, d, r):
        model, extra = CFG[c]
        async with sem:
            t0 = time.time()
            try:
                res = await wf_docs.vision_transcribe(open(gt[d]["png"], "rb").read(), llm, hint=gt[d]["type"], model=model,
                                                      width=width, fmt=fmt, extra=dict(extra, max_tokens=4000))
                err = None
            except Exception as e:
                res = {"text": "", "usage": {}, "cost": None}; err = str(e)[:300]
            ms = int((time.time() - t0) * 1000)
        sc = score(gt[d], res["text"]) if not err else {"items": 0, "ok": 0, "perfect": False, "parse_ok": False, "miss": []}
        u = res.get("usage") or {}
        rec = {"cfg": c, "model": model, "tag": tag, "width": width, "fmt": fmt, "doc": d, "set": gt[d]["set"], "type": gt[d]["type"],
               "run": r, "ms": ms, "cost": res.get("cost"), "in_tok": u.get("prompt_tokens"), "out_tok": u.get("completion_tokens"),
               "reason_tok": (u.get("completion_tokens_details") or {}).get("reasoning_tokens"), "provider": res.get("provider"),
               "img_bytes": res.get("image_bytes"), "err": err, **sc, "text": res["text"]}
        total["cost"] += res.get("cost") or 0
        with open(OUT, "a") as fh: fh.write(json.dumps(rec) + "\n")
        print(f"{c:12s} {d:16s} r{r} {ms:6d}ms ${res.get('cost') or 0:.5f} ok {sc['ok']}/{sc['items']} parse={sc['parse_ok']} {('ERR '+err) if err else ''} miss={sc['miss'][:3]}", flush=True)
    await asyncio.gather(*[one(*j) for j in jobs])
    print("TOTAL COST %.4f" % total["cost"])

def report(filt=None):
    from collections import defaultdict
    rows = [json.loads(l) for l in open(OUT)]
    if filt: rows = [r for r in rows if re.search(filt, r["tag"] + " " + r["cfg"])]
    g = defaultdict(list)
    for r in rows: g[(r["cfg"], r["tag"], r["set"])].append(r)
    print(f"{'cfg':12s} {'tag':14s} {'set':6s} {'n':>3s} {'err':>3s} {'perfect':>8s} {'items':>8s} {'parse':>6s} {'med_s':>6s} {'p90_s':>6s} {'max_s':>6s} {'$/doc':>8s} {'in_tok':>6s} {'out':>5s}")
    for k in sorted(g):
        v = g[k]; ok = [r for r in v if not r["err"]]
        ms = sorted(r["ms"] for r in ok) or [0]
        perf = sum(r["perfect"] for r in ok); items = sum(r["ok"] for r in ok); tot = sum(r["items"] for r in ok)
        pl = [r for r in ok if r["parse_ok"] is not None]; pok = sum(1 for r in pl if r["parse_ok"])
        cost = [r["cost"] for r in ok if r["cost"] is not None]
        print(f"{k[0]:12s} {k[1]:14s} {k[2]:6s} {len(v):3d} {len(v)-len(ok):3d} {perf:3d}/{len(ok):<4d} {items/max(1,tot):8.3f} {str(pok)+'/'+str(len(pl)):>6s} {statistics.median(ms)/1000:6.2f} {ms[int(0.9*(len(ms)-1))]/1000:6.2f} {ms[-1]/1000:6.2f} {statistics.mean(cost) if cost else 0:8.5f} {statistics.median([r['in_tok'] or 0 for r in ok] or [0]):6.0f} {statistics.median([r['out_tok'] or 0 for r in ok] or [0]):5.0f}")
    print("total spend in file: $%.3f" % sum(r["cost"] or 0 for r in rows))

if __name__ == "__main__":
    a = sys.argv[1:]
    if a[0] == "gt": build_gt()
    elif a[0] == "report": report(a[1] if len(a) > 1 else None)
    elif a[0] == "run":
        cfgs = a[1].split(",")
        def opt(n, d):
            return type(d)(a[a.index(n) + 1]) if n in a else d
        asyncio.run(run(cfgs, opt("--docs", "scan"), opt("--runs", 1), opt("--conc", 8), opt("--width", 1240), opt("--fmt", "JPEG"), opt("--tag", "w1240jpg")))
