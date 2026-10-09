"""Tests for wf_client against the practice clinic (read-only: navigation, searches, pagination, location preference)."""
import asyncio, sys, os, time, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wf_client import WrenfieldClient

BASE = os.environ.get("SITE_URL", "https://practice.speedrun.scopehealth.com")
OUT = "/Users/nirav/development/scope health/research/cart_out/texts"
os.makedirs(OUT, exist_ok=True)


def show(label, txt, n=1200):
    print(f"\n===== {label} ({len(txt)} chars)\n{txt[:n]}")


async def main(which):
    async with WrenfieldClient(BASE, "u", "p") as wf:
        t = wf.main
        if "pages" in which:
            for p in ["/", "/schedule?date=2026-10-14", "/schedule/providers/1x0jb5xxv1?date=2026-10-14",
                      "/schedule/appointments?from=2026-10-14&to=2026-10-14", "/billing", "/documents", "/activity",
                      "/billing/invoices/6b7q92km6g", "/billing/accounts/03q14ndmmd", "/patients/03q14ndmmd/problems",
                      "/patients/03q14ndmmd/notes", "/patients/03q14ndmmd/documents/0l1jqh8zfg", "/patients/03q14ndmmd/appointments",
                      "/patients/03q14ndmmd/appointments/6x505m94xc", "/patients/535rn1pbvb/recurring/4wmqk4lx5r",
                      "/patients/03q14ndmmd/activity", "/patients/3pdsxpwzr5"]:
                t0 = time.time()
                txt = await wf.get_text(p)
                dt = time.time() - t0
                fn = re.sub(r"[^a-zA-Z0-9]+", "_", p).strip("_") or "root"
                open(f"{OUT}/{fn}.txt", "w").write(txt)
                show(f"{p} [{dt:.2f}s]", txt, 700)
        if "search" in which:
            t0 = time.time(); rows = await wf.search_patients(last_name="Smith"); dt = time.time() - t0
            print(f"\nsearch Smith: {len(rows)} rows in {dt:.2f}s; first={rows[0] if rows else None}; last={rows[-1] if rows else None}")
            rows = await wf.search_patients(dob="06/05/1971"); print("search dob 06/05/1971:", [(r.get('name'), r.get('href')) for r in rows])
            rows = await wf.search_patients(last_name="Zzzzqx"); print("search none:", rows)
            rows = await wf.search_patients(last_name="Rodriguez"); print("Rodriguez:", len(rows), [r for r in rows if r.get('flags')][:3])
        if "click" in which:
            await wf.goto("/billing")
            await wf.click_by_text("Next")
            txt = await wf.text(); m = re.search(r"Showing[^\n]*", txt); print("\nbilling after Next:", m.group(0) if m else txt[-300:])
            await wf.goto("/patients/03q14ndmmd")
            await wf.click_by_text("Insurance")
            print("after click Insurance tab ->", t.current_path())
            await wf.goto("/schedule?date=2026-10-14")
            await wf.click_by_text("Next day")
            print("after Next day ->", t.current_path(), (await wf.text()).split("\n")[3:8])
        if "paginate" in which:
            await wf.goto("/billing/accounts/03q14ndmmd")
            t0 = time.time(); pages = await wf.paginate_all(max_pages=5); print(f"\npaginate billing account: {len(pages)} pages in {time.time()-t0:.2f}s; rows per page:", [p.count('\n') for p in pages])
        if "location" in which:
            print("\nlocations:", await wf.locations())
            print("now:", await wf.location())
            print("set:", await wf.set_location("Front Range"))
            txt = await wf.get_text("/billing")
            print("billing rows with Front Range:", txt.count("| Front Range |"), "Northgate:", txt.count("| Northgate |"))
            txt = await wf.get_text("/schedule?date=2026-10-14"); print("schedule header:", [l for l in txt.split("\n") if "times in" in l.lower()][:2])
            print("set:", await wf.set_location("All locations"))
            txt = await wf.get_text("/billing"); print("All locations billing locations:", sorted(set(re.findall(r"\| (Northgate|Front Range|Eastside|Stonebrook|Lakeside|Riverbend|Highline|Prairie View|Cedar Hollow|Willow Creek) \|", txt))))
            print("set back:", await wf.set_location("Northgate"))
        if "concurrency" in which:
            paths = ["/patients/03q14ndmmd", "/patients/03q14ndmmd/insurance", "/patients/03q14ndmmd/problems", "/patients/03q14ndmmd/notes",
                     "/patients/6sqtnhdpq1", "/patients/6sqtnhdpq1/insurance", "/patients/6sqtnhdpq1/problems", "/patients/6sqtnhdpq1/notes"]
            for n in (1, 2, 4):
                while wf._pool.qsize() < n:
                    await wf.add_tab()
                t0 = time.time()
                sem = asyncio.Semaphore(n)
                async def one(p):
                    async with sem:
                        async with wf.tab() as tb:
                            return await tb.get_text(p)
                res = await asyncio.gather(*[one(p) for p in paths * 2])
                wall = time.time() - t0
                print(f"concurrency {n}: {len(res)} views in {wall:.2f}s = {len(res)/wall:.1f} views/s; min len {min(map(len,res))}")
        if "docs" in which:
            await wf.goto("/patients/03q14ndmmd/documents/0l1jqh8zfg")
            files = await t.document_files()
            print("\ndocument files:", [(f["kind"], f.get("content_type"), len(f.get("data") or b""), f.get("alt")) for f in files])
        if "allpat" in which:
            t0 = time.time(); rows = await wf.list_all_patients(concurrency=4, prefixes=["mu", "sm", "ro", "zz"]); print(f"\nlist_all_patients(4 prefixes): {len(rows)} in {time.time()-t0:.2f}s")
        print("font warnings:", wf.fonts.warnings, "popstate ok:", wf.use_popstate, wf.popstate_successes, wf.popstate_failures)

asyncio.run(main(sys.argv[1].split(",") if len(sys.argv) > 1 else ["pages", "search", "click", "paginate", "location", "concurrency", "docs", "allpat"]))
