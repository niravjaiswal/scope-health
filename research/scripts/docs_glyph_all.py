"""Run the exact glyph decoder over every sample PDF; write <id>.glyph.txt (+ .tounicode.txt) and print stats."""
import sys, os, glob, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wf_docs
D = "/Users/nirav/development/scope health/research/docs_samples"
t = time.time(); wf_docs.load_reference(); print("ref load %.2fs" % (time.time() - t))
for pdf in sorted(glob.glob(f"{D}/*.pdf")):
    did = os.path.basename(pdf)[:-4]
    png = f"{D}/{did}_p1.png"
    r = wf_docs.pdf_decode(open(pdf, "rb").read(), open(png, "rb").read() if os.path.exists(png) else None)
    if r["kind"] == "vector":
        open(f"{D}/{did}.glyph.txt", "w").write(r["text"])
        open(f"{D}/{did}.tounicode.txt", "w").write(r["tounicode_text"])
    first = r["text"].split("\n")[0][:50] if r["text"] else ""
    print(did, json.dumps({k: v for k, v in r.items() if k not in ("text", "tounicode_text")}), "|", first)
