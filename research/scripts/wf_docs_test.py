"""Tests / results table for wf_docs.  Run:  .venv/bin/python research/scripts/wf_docs_test.py [--llm]
  1. exact glyph decode of every vector sample PDF vs ground truth (keys + table rows), timing
  2. --llm: end-to-end read_document(pdf only) on the scanned samples + synthetic 4.3.1-style docs (spends ~$0.01)
  3. unit tests: resolve_partial_dates, parse_lab_report"""
import sys, os, json, time, asyncio, statistics
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wf_docs
from docs_bench import score, load_env, D

def t_dates():
    R = wf_docs.resolve_partial_dates
    assert R(["03/14/2019", "05/16", "11/02", "01/15"], "MM/DD/YYYY") == ["2019-03-14", "2019-05-16", "2019-11-02", "2020-01-15"]
    assert R(["24.02.1999", "24.04.", "13.06.", "02.03.2000"], "DD.MM.YYYY") == ["1999-02-24", "1999-04-24", "1999-06-13", "2000-03-02"]
    assert R(["3 Nov 2008", "5 Jan", "8 Mar", "12 Dec", "1 Sep 2012"], "day month year") == ["2008-11-03", "2009-01-05", "2009-03-08", "2009-12-12", "2012-09-01"]
    assert R(["2015-06-30"], "YYYY-MM-DD") == ["2015-06-30"]
    assert R(["14 Mar 2021", "14 Mar"], "day month year") == ["2021-03-14", "2022-03-14"]   # same month/day -> next year
    print("dates: ok")

def t_glyph():
    gt = json.load(open(f"{D}/gt_all.json"))
    wf_docs.load_reference()
    n = perfect = 0; ms = []; trapped = 0
    for did, g in gt.items():
        if g["set"] != "clean": continue
        pdf = open(f"{D}/{did}.pdf", "rb").read()
        t = time.time(); r = wf_docs.pdf_decode(pdf); ms.append((time.time() - t) * 1000)
        s = score(g, r["text"]); n += 1; perfect += s["perfect"]; trapped += r["trapped"]
        if g["type"] == "lab":
            p = wf_docs.parse_lab_report(r["text"])
            assert p.get("tests_reported") == len(p["tests"]), did
        if not s["perfect"]: print("  MISS", did, s["miss"])
    print(f"glyph decode: {perfect}/{n} docs perfect ({trapped} had a lying ToUnicode layer); median {statistics.median(ms):.0f} ms, max {max(ms):.0f} ms")
    for did in [k for k, v in gt.items() if v["set"] == "scan"]:
        r = wf_docs.pdf_decode(open(f"{D}/{did}.pdf", "rb").read())
        assert r["kind"] == "scan", (did, r["kind"])
    print("scan detection: ok")

async def t_llm():
    load_env()
    llm = wf_docs.make_llm_call()
    gt = json.load(open(f"{D}/gt_all.json"))
    rows = []
    async def one(did):
        g = gt[did]
        if g["set"] == "scan":
            r = await wf_docs.read_document(pdf_bytes=open(f"{D}/{did}.pdf", "rb").read(), llm_call=llm, hint=g["type"])
        else:  # synthetic 4.3.1-style scans exist only as PNG
            r = await wf_docs.read_document(png_bytes=open(g["png"], "rb").read(), llm_call=llm, hint=g["type"])
        s = score(g, r["text"]); rows.append((did, g["type"], r["method"], r["ms"], r.get("cost"), s["ok"], s["items"], s["miss"]))
    ids = [k for k, v in gt.items() if v["set"] in ("scan", "synth2")]
    await asyncio.gather(*[one(d) for d in ids])
    # cached second read
    t = time.time(); r = await wf_docs.read_document(pdf_bytes=open(f"{D}/{ids[0]}.pdf", "rb").read(), llm_call=llm)
    print(f"cached re-read: {(time.time()-t)*1000:.1f} ms cached={r.get('cached')}")
    print(f"{'doc':16s} {'type':12s} {'method':40s} {'ms':>6s} {'$':>8s} ok")
    for x in sorted(rows): print(f"{x[0]:16s} {x[1]:12s} {x[2]:40s} {x[3]:6d} {x[4] or 0:8.5f} {x[5]}/{x[6]} {x[7] if x[7] else ''}")
    print("perfect %d/%d, median %.2f s, total $%.4f" % (sum(x[5] == x[6] for x in rows), len(rows), statistics.median(x[3] for x in rows) / 1000, sum(x[4] or 0 for x in rows)))

if __name__ == "__main__":
    t_dates(); t_glyph()
    if "--llm" in sys.argv: asyncio.run(t_llm())
