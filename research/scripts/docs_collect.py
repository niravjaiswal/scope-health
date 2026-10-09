"""Collect sample documents (PNG page images + PDF) from the PRACTICE clinic, read-only.
Usage: python docs_collect.py list            -> writes docs_samples/list.json (rows of /documents, first 2 pages of 100)
       python docs_collect.py fetch id1 id2 ... -> saves docs_samples/<id>.pdf, <id>_p1.png, <id>.json
"""
import asyncio, sys, os, json, re, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wf_client import WrenfieldClient
BASE = "https://practice.speedrun.scopehealth.com"
OUT = "/Users/nirav/development/scope health/research/docs_samples"

async def do_list(wf):
    await wf.set_location("All locations")
    await wf.goto("/documents")
    pages = await wf.paginate_all(max_pages=3, rows_per_page="100")
    rows = []
    for pg in pages:
        for line in pg.split("\n"):
            if "/documents/" in line or "| View" in line:
                rows.append(line)
    links = await wf.links()
    json.dump({"pages": pages, "links": links}, open(f"{OUT}/list.json", "w"), indent=1)
    print(len(pages), "pages"); print(pages[0][:3000])

async def do_fetch(wf, ids):
    await wf.set_location("All locations")
    for did in ids:
        t0 = time.time()
        txt = await wf.get_text(f"/documents/{did}")
        files = await wf.main.document_files()
        meta = {"id": did, "viewer_text": txt, "files": []}
        for i, f in enumerate(files):
            d = f.pop("data", None)
            if d is None: meta["files"].append(f); continue
            ext = "pdf" if f["kind"] == "pdf" else "png"
            fn = f"{did}.pdf" if ext == "pdf" else f"{did}_p{i}.png"
            open(f"{OUT}/{fn}", "wb").write(d)
            f["saved"] = fn; f["size"] = len(d); meta["files"].append(f)
        json.dump(meta, open(f"{OUT}/{did}.json", "w"), indent=1)
        print(did, f"{time.time()-t0:.1f}s", [(f.get('kind'), f.get('size'), f.get('alt')) for f in meta["files"]], txt.split("\n")[:3])

async def main():
    async with WrenfieldClient(BASE, "u", "p") as wf:
        if sys.argv[1] == "list": await do_list(wf)
        else: await do_fetch(wf, sys.argv[2:])
asyncio.run(main())
