"""Build agents/dumper3/set1_targets.json from research/set1_items.json (Set 1 task texts).
Parses every task into a target: patient (first/last/dob) + kind-specific data, invoices, lots, schedule queries.
Run: python research/scripts/build_set1_targets.py  (prints unparsed tasks; must be none)."""
import json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
items = json.load(open(os.path.join(ROOT, "research", "set1_items.json")))

D = r"(\d{4}-\d{2}-\d{2})"
NAME = r"([A-ZÀ-Ý][\w'’.À-ÿ-]+(?: [A-ZÀ-Ý][\w'’.À-ÿ-]+)*)"   # one or more capitalized words


def split_first_last(full):
    parts = full.strip().split()
    return parts[0], " ".join(parts[1:])


def P(first=None, last=None, full=None, dob=None, lastfirst=None):
    if lastfirst:
        last, first = [x.strip() for x in lastfirst.split(",", 1)]
    if full:
        first, last = split_first_last(full)
    return {"first": first, "last": last, "dob": dob}


LAB = [
    (rf"lab report for {NAME}, {NAME} \(DOB {D}\), received on {D}", lambda m: (P(lastfirst=m[1] + "," + m[2], dob=m[3]), m[4])),
    (rf"lab report received on {D} for {NAME}\.", lambda m: (P(full=m[2]), m[1])),
    (rf"lab report for {NAME} \(born {D}\), received {D}", lambda m: (P(full=m[1], dob=m[2]), m[3])),
    (rf"Next step for a lab report: {NAME}, [^,]+, received {D}", lambda m: (P(full=m[1]), m[2])),
]
PANEL = re.compile(r"(Basic metabolic panel|Complete blood count|Thyroid panel|Liver function panel|Lipid panel|Vitamin D|Iron studies|[A-Z][a-z]+ [a-z]+ panel)")

out_pat = []   # list of {first,last,dob,tasks:[...]}
invoices, lots, sched, unparsed = [], [], [], []


def add(p, task):
    p = dict(p)
    p["tasks"] = [task]
    out_pat.append(p)


for it in items:
    if it["kind"] != "task":
        continue
    n, t = it["n"], it["text"]
    done = False
    # ---- lab
    if "lab report" in t:
        for rx, f in LAB:
            m = re.search(rx, t)
            if m:
                p, rec = f(m)
                pm = PANEL.search(t)
                add(p, {"n": n, "kind": "lab", "panel": pm.group(1) if pm else None, "received": rec})
                done = True
                break
    # ---- phone
    elif "phone number" in t:
        m = re.search(rf"patient {NAME} \(born {D}\)", t)
        if m:
            add(P(full=m[1], dob=m[2]), {"n": n, "kind": "phone"}); done = True
    # ---- referral
    elif t.startswith("Referral letter received"):
        m = re.search(rf"received on {D} for patient {NAME} \(born {D}\): (which practice|what reason)", t)
        if m:
            add(P(full=m[2], dob=m[3]), {"n": n, "kind": "referral_practice" if m[4].startswith("which") else "referral_reason", "received": m[1]}); done = True
    # ---- tetanus
    elif "tetanus" in t.lower():
        for rx, f in [
            (rf"What should {NAME} have gotten for tetanus when they came in with a wound on {D}", lambda m: (P(full=m[1]), m[2])),
            (rf"wound visits\. {NAME}, DOB {D}, came in on {D}", lambda m: (P(full=m[1], dob=m[2]), m[3])),
            (rf"tetanus part right for {NAME}, {NAME} \(born {D}\), seen {D}", lambda m: (P(lastfirst=m[1] + "," + m[2], dob=m[3]), m[4])),
            (rf"Tetanus for {NAME} on {D}", lambda m: (P(full=m[1]), m[2])),
        ]:
            m = re.search(rx, t)
            if m:
                p, d = f(m)
                add(p, {"n": n, "kind": "tetanus", "visit": d}); done = True
                break
    # ---- invoice
    elif "invoice" in t and "owed" in t:
        m = re.search(rf"invoice (\d+) \(patient {NAME}, service date {D}\)", t)
        if m:
            invoices.append({"n": n, "number": m[1], "patient": m[2], "dos": m[3]})
            add(P(full=m[2]), {"n": n, "kind": "invoice", "number": m[1], "dos": m[3]}); done = True
    # ---- recall
    elif re.search(r"\blot\b", t) and ("notify" in t or "told" in t):
        m = re.search(r"lot ([A-Z0-9]{5,10})", t)
        if m:
            lots.append({"n": n, "lot": m[1]}); done = True
    # ---- claim next step
    elif "claim" in t and ("next" in t.lower() or "from here" in t):
        for rx, f in [
            (rf"Next step on claim: {NAME}, {NAME}, DOB {D}, service date {D}", lambda m: (P(lastfirst=m[1] + "," + m[2], dob=m[3]), m[4])),
            (rf"claim for {NAME} with the date of service {D}", lambda m: (P(full=m[1]), m[2])),
            (rf"claim for {NAME}, born {D}, with the date of service {D}", lambda m: (P(full=m[1], dob=m[2]), m[3])),
            (rf"claim for {NAME}, date of service {D}", lambda m: (P(full=m[1]), m[2])),
        ]:
            m = re.search(rx, t)
            if m:
                p, d = f(m)
                add(p, {"n": n, "kind": "claim", "dos": d}); done = True
                break
    # ---- filing deadline
    elif "fil" in t.lower() and ("deadline" in t.lower() or "until when" in t or "billed" in t):
        for rx, f in [
            (rf"^{NAME}, {NAME}, DOB {D}, date of service {D}", lambda m: (P(lastfirst=m[1] + "," + m[2], dob=m[3]), m[4])),
            (rf"file for {NAME}'s visit on {D}", lambda m: (P(full=m[1]), m[2])),
            (rf"^{NAME}, born {D}, has a visit from {D}", lambda m: (P(full=m[1], dob=m[2]), m[3])),
            (rf"Filing deadline for {NAME}, DOS {D}", lambda m: (P(full=m[1]), m[2])),
        ]:
            m = re.search(rx, t)
            if m:
                p, d = f(m)
                add(p, {"n": n, "kind": "filing", "dos": d}); done = True
                break
    # ---- good faith estimate
    elif "good faith estimate" in t.lower():
        for rx, f in [
            (rf"^{NAME} is on the books for {D} at (\d\d:\d\d)", lambda m: (P(full=m[1]), m[2], m[3])),
            (rf"Good faith estimate question: {NAME}, {NAME}, born {D}, (\d\d:\d\d) on {D}", lambda m: (P(lastfirst=m[1] + "," + m[2], dob=m[3]), m[5], m[4])),
            (rf"due for {NAME} \(DOB {D}\)\? Appointment {D} (\d\d:\d\d)", lambda m: (P(full=m[1], dob=m[2]), m[3], m[4])),
            (rf"paperwork for {NAME}'s (\d\d:\d\d) appointment on {D}", lambda m: (P(full=m[1]), m[3], m[2])),
        ]:
            m = re.search(rx, t)
            if m:
                p, d, tm = f(m)
                add(p, {"n": n, "kind": "gfe", "date": d, "time": tm}); done = True
                break
    # ---- schedule-type questions
    if not done:
        m = re.search(rf"how many scheduled appointments does {NAME}, (MD|DO|NP|PA) have on {D}", t, re.I)
        if m:
            sched.append({"n": n, "kind": "prov_day", "provider": f"{m[1]}, {m[2]}", "date": m[3], "status": "Scheduled"}); done = True
    if not done:
        m = re.search(rf"How many completed visits did {NAME}, (MD|DO|NP|PA) have on {D}", t)
        if m:
            sched.append({"n": n, "kind": "prov_day", "provider": f"{m[1]}, {m[2]}", "date": m[3], "status": "Completed"}); done = True
    if not done:
        m = re.search(rf"open slots are there for {NAME}, (MD|DO|NP|PA) at {NAME} on {D}", t)
        if m:
            sched.append({"n": n, "kind": "open_slots", "provider": f"{m[1]}, {m[2]}", "location": m[3], "date": m[4]}); done = True
    if not done:
        m = re.search(rf"How many completed visits at {NAME} on {D} started before", t)
        if m:
            sched.append({"n": n, "kind": "loc_day", "location": m[1], "date": m[2], "status": "Completed"}); done = True
    if not done:
        m = re.search(rf"at least one (completed visit|scheduled appointment) at {NAME} in (\w+) (\d{{4}})", t)
        if m:
            mon = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"].index(m[3].lower()) + 1
            sched.append({"n": n, "kind": "loc_month", "location": m[2], "month": f"{m[4]}-{mon:02d}", "status": "Completed" if "completed" in m[1] else "Scheduled"}); done = True
    if not done:
        m = re.search(r"Which three providers had the most completed visits across all locations in (\w+) (\d{4})", t)
        if m:
            mon = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"].index(m[1].lower()) + 1
            sched.append({"n": n, "kind": "top_providers", "month": f"{m[2]}-{mon:02d}", "status": "Completed"}); done = True
    if not done:
        unparsed.append((n, t))

# merge patients by (first,last,dob)
pats = {}
for p in out_pat:
    k = (p["first"], p["last"], p["dob"])
    if k not in pats:
        pats[k] = {"first": p["first"], "last": p["last"], "dob": p["dob"], "tasks": []}
    pats[k]["tasks"] += p["tasks"]

res = {"patients": list(pats.values()), "invoices": invoices, "lots": lots, "sched": sched}
dst = os.path.join(ROOT, "agents", "dumper3", "set1_targets.json")
os.makedirs(os.path.dirname(dst), exist_ok=True)
json.dump(res, open(dst, "w"), ensure_ascii=False, indent=1)
from collections import Counter
print("patients", len(res["patients"]), Counter(t["kind"] for p in res["patients"] for t in p["tasks"]))
print("invoices", len(invoices), "lots", len(lots), "sched", len(sched), Counter(s["kind"] for s in sched))
print("UNPARSED", len(unparsed))
for n, t in unparsed:
    print(" ", n, t[:200])
