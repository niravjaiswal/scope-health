"""Synthetic 4.3.1-style documents (outside immunization records with grids + handwriting, scanned paper remittances)
rendered with the same font families (Noto Sans/Serif, Pangolin, Mali), rasterised at 200 dpi and degraded like scans.
Writes docs_samples/synth2/<name>.png and adds entries to gt_all.json (set 'synth2')."""
import sys, os, io, json, random
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pymupdf as fitz
from fontTools.ttLib import TTFont
from docs_bench import degrade, D
FD = "/Users/nirav/development/scope health/research/doc_fonts/"
def ttf(name):
    tt = TTFont(FD + name + ".woff"); tt.flavor = None; b = io.BytesIO(); tt.save(b); return b.getvalue()
FONTS = {"sans": ttf("noto-sans-latin-400-normal"), "sansb": ttf("noto-sans-latin-700-normal"), "serif": ttf("noto-serif-latin-400-normal"),
         "serifb": ttf("noto-serif-latin-700-normal"), "pang": ttf("pangolin-latin-400-normal"), "mali": ttf("mali-latin-400-normal")}
def page():
    doc = fitz.open(); pg = doc.new_page(width=612, height=792)
    for k, v in FONTS.items(): pg.insert_font(fontname=k, fontbuffer=v)
    return doc, pg
def T(pg, x, y, s, font="sans", size=10, color=(0.1, 0.1, 0.12)):
    pg.insert_text((x, y), s, fontname=font, fontsize=size, color=color)
def finish(doc, name, gt, rnd_seed):
    pix = doc[0].get_pixmap(dpi=200); png = pix.tobytes("png")
    out = f"{D}/synth2/{name}.png"; open(out, "wb").write(degrade(png, rnd_seed)); gt["png"] = out; gt["set"] = "synth2"; return gt

def immun_grid(name, seed, place, patient, dob, sex, fmt, rows, hand="pang"):
    doc, pg = page()
    T(pg, 60, 70, place, "serifb", 17); T(pg, 60, 88, "Immunization Record", "serif", 12)
    T(pg, 60, 106, "Official record of vaccinations. Keep with your health records.", "sans", 8, (0.4, 0.4, 0.4))
    y = 135
    for lab, val in [("Name", patient), ("Date of birth", dob), ("Sex", sex), ("Dates written", fmt)]:
        T(pg, 60, y, lab, "sans", 9.5, (0.35, 0.35, 0.35)); T(pg, 170, y, val, "sans" if lab == "Dates written" else hand, 11 if lab != "Dates written" else 9.5); y += 18
    y += 15
    cols = [60, 170, 250, 330, 410, 490]
    for i, h in enumerate(["Vaccine", "Dose 1", "Dose 2", "Dose 3", "Dose 4", "Dose 5"]): T(pg, cols[i], y, h, "sansb", 9.5)
    pg.draw_line((58, y + 5), (560, y + 5), color=(0, 0, 0), width=0.8); y += 22
    for vac, doses in rows:
        T(pg, cols[0], y, vac, "sans", 9.5)
        for i, d in enumerate(doses): T(pg, cols[i + 1], y, d, hand, 11)
        pg.draw_line((58, y + 7), (560, y + 7), color=(0.6, 0.6, 0.6), width=0.4); y += 24
    T(pg, 60, y + 30, "Verified by:", "sans", 9); T(pg, 130, y + 30, "R. Okafor, RN", hand, 12)
    keys = [patient, dob, fmt] + [d for _, ds in rows for d in ds] + [v for v, _ in rows]
    rws = [[v] + ds for v, ds in rows]
    return finish(doc, name, {"type": "immunization", "keys": keys, "rows": rws}, seed)

def immun_list(name, seed, place, patient, dob, sex, fmt, rows, hand="mali"):
    doc, pg = page()
    T(pg, 60, 70, place, "sansb", 16); T(pg, 60, 88, "Vaccination history", "sans", 11)
    y = 120
    for lab, val in [("Patient", patient), ("Born", dob), ("Sex", sex), ("Dates written", fmt)]:
        T(pg, 60, y, lab + ":", "sans", 9.5); T(pg, 150, y, val, "sans", 9.5); y += 16
    y += 18
    cols = [60, 230, 330, 430]
    for i, h in enumerate(["Vaccine", "Date given", "Lot", "Given by"]): T(pg, cols[i], y, h, "sansb", 9.5)
    y += 20
    for r in rows:
        for i, c in enumerate(r): T(pg, cols[i], y, c, hand if i in (1, 3) else "sans", 10.5 if i in (1, 3) else 9.5)
        y += 20
    keys = [patient, dob, fmt] + [c for r in rows for c in r[:3]]
    return finish(doc, name, {"type": "immunization", "keys": keys, "rows": [r[:3] for r in rows]}, seed)

def remit(name, seed, payer, chk, pdate, lines, hand_note=None):
    doc, pg = page()
    T(pg, 50, 60, payer, "sansb", 15); T(pg, 50, 76, "PO Box 4410, Topeka, KS 66601", "sans", 8.5, (0.4, 0.4, 0.4))
    T(pg, 400, 60, "REMITTANCE ADVICE", "sansb", 12)
    y = 105
    for lab, val in [("Payee", "Harbor Glen Medical Group"), ("Check / EFT number", chk), ("Payment date", pdate)]:
        T(pg, 50, y, lab, "sans", 9, (0.35, 0.35, 0.35)); T(pg, 170, y, val, "sans", 9.5); y += 15
    y += 15
    cols = [50, 150, 205, 252, 282, 330, 378, 420, 505]
    hdr = ["Patient", "Service date", "Proc", "Mod", "Billed", "Allowed", "Paid", "Adjustments", "Remarks"]
    for i, h in enumerate(hdr): T(pg, cols[i], y, h, "sansb", 7.5)
    pg.draw_line((48, y + 4), (575, y + 4), color=(0, 0, 0), width=0.7); y += 16
    keys = [payer, chk, pdate]; rws = []
    for ln in lines:
        for i, c in enumerate(ln): T(pg, cols[i], y, c, "sans", 7.5)
        keys += [c for c in ln if c]; rws.append([c for c in ln[:5]]); y += 15
    if hand_note:
        T(pg, 60, y + 40, hand_note, "pang", 13, (0.1, 0.1, 0.5)); keys.append(hand_note)
    T(pg, 50, 740, "Group codes: CO contractual obligation, PR patient responsibility. Remark codes per X12.", "sans", 7, (0.4, 0.4, 0.4))
    return finish(doc, name, {"type": "remittance", "keys": keys, "rows": rws}, seed)

gt = json.load(open(f"{D}/gt_all.json"))
gt["imm_grid_dmy"] = immun_grid("imm_grid_dmy", 11, "Cedar County Health Department", "Kathryn Lewis", "1998-12-03", "Female", "DD.MM.YYYY",
    [("Infanrix", ["24.02.1999", "24.04.", "13.06.", "02.03.2000", "11.10.2003"]), ("IPOL", ["24.02.1999", "24.04.", "13.06."]),
     ("M-M-R II", ["15.12.1999", "11.10.2003"]), ("Boostrix", ["14.01.2013"])])
gt["imm_grid_mdy"] = immun_grid("imm_grid_mdy", 12, "Prairie Valley Pediatrics", "Douglas Walker", "03/14/2019", "Male", "MM/DD/YYYY",
    [("Pentacel", ["03/14/2019", "05/16", "11/02", "01/15"]), ("Engerix-B", ["03/14/2019", "04/18", "09/30"]),
     ("Prevnar 20", ["05/16/2019", "07/19", "01/15/2020"]), ("Kinrix", ["03/02/2023"])], hand="mali")
gt["imm_grid_dmon"] = immun_grid("imm_grid_dmon", 13, "Elk Bend Health Center", "Mary Turner", "2008-09-03", "Female", "day month year",
    [("Daptacel", ["3 Nov 2008", "5 Jan", "8 Mar", "12 Dec", "1 Sep 2012"]), ("ActHIB", ["3 Nov 2008", "5 Jan", "8 Mar"]),
     ("Adacel", ["17 Aug 2019"]), ("Gardasil 9", ["17 Aug 2019", "20 Feb"])])
gt["imm_list_iso"] = immun_list("imm_list_iso", 14, "Wickford Women's Health", "Amy Marshall", "1987-05-22", "Female", "YYYY-MM-DD",
    [["Tdap", "2015-06-30", "AC52B019AA", "J. Price"], ["Influenza", "2023-10-12", "UJ7741", "J. Price"], ["Td", "2024-02-08", "TK4471D", "M. Cole"], ["Shingrix", "2024-03-01", "3K92X", "M. Cole"]])
gt["imm_list_dmon"] = immun_list("imm_list_dmon", 15, "Marrow Lake Urgent Care", "Caleb Johnson", "1967-02-19", "Male", "day month year",
    [["Tenivac", "14 Mar 2021", "U6893AA", "S. Ng"], ["Fluzone", "2 Oct 2022", "UT8812CA", "S. Ng"], ["Boostrix", "30 Jul 2011", "AC52B044CA", "T. Reyes"]])
gt["remit1"] = remit("remit1", 21, "Tallgrass Health Plan", "CHK4578491", "2026-08-17", [
    ["Coleman, Linda", "07/06/2026", "99213", "", "190.00", "0.00", "0.00", "CO-197 190.00", "N290"],
    ["Coleman, Linda", "07/06/2026", "11102", "59", "145.00", "98.20", "78.56", "CO-45 46.80 PR-2 19.64", ""],
    ["Payne, Roger", "07/16/2026", "17110", "", "210.00", "162.40", "142.40", "CO-45 47.60 PR-3 20.00", "MA130"]], hand_note="Rec'd 8/21 - posted JS")
gt["remit2"] = remit("remit2", 22, "Northfield Life and Health", "EFT0093317", "2026-09-02", [
    ["Murphy, Samantha", "03/16/2026", "20610", "", "320.00", "0.00", "0.00", "CO-97 320.00", "M51"],
    ["Murphy, Samantha", "03/16/2026", "20605", "59", "260.00", "0.00", "0.00", "CO-16 260.00", "N382 MA130"],
    ["Lee, Elena", "08/28/2026", "99214", "25", "245.00", "171.33", "121.33", "CO-45 73.67 PR-1 50.00", ""],
    ["Lee, Elena", "08/28/2026", "90715", "", "68.00", "0.00", "0.00", "CO-22 68.00", ""]])
gt["remit3"] = remit("remit3", 23, "Meridian Mutual Health", "CHK0071264", "2026-07-10", [
    ["Anderson, Evelyn", "05/02/2026", "12001", "", "180.00", "0.00", "0.00", "CO-29 180.00", ""],
    ["Khan, Kevin", "06/11/2026", "99203", "", "200.00", "140.00", "112.00", "CO-45 60.00 PR-2 28.00", ""]])
json.dump(gt, open(f"{D}/gt_all.json", "w"), indent=1)
print("ok", sum(1 for v in gt.values() if v["set"] == "synth2"))
