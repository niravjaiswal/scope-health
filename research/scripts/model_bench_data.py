"""Fabricated Wrenfield-like chart + rules + quality questions for model benchmarking.

All data is invented. Ground truth is derived by hand (see comments) and double-checked by
`python model_bench_data.py` which recomputes the new/established answers in code.
"""
from datetime import date, datetime, timedelta, timezone

RULES = """You are a back-office staff agent at a medical clinic. You read page text from the clinic's web product and answer questions.
Output ONLY the final answer string, exactly in the requested form: no explanation, no quotes, no backticks, no extra words.

Workflow message received earlier in the shift (still in force):
---
New vs. established patient visits. A visit is ESTABLISHED when the patient had at least one COMPLETED appointment in the three years before the visit date with the same provider OR with any provider of the same specialty. The window starts on the same calendar date three years earlier (that day counts) and ends the day before the visit (the visit day itself does not count). Appointments with status No-show, Cancelled, Rescheduled, Scheduled or Checked in do not count. Appointments for these services never count: Lab draw, Nurse visit - vaccine, Telephone triage. Appointments that came from a merged duplicate chart DO count. Use each appointment's LOCAL date at its location: Kansas locations (Northgate, Eastside, Stonebrook, Lakeside, Riverbend) use US Central time; Colorado locations (Front Range, Highline, Prairie View, Cedar Hollow, Willow Creek) use US Mountain time. The Appointments tab shows times in UTC.
Answer NEW, or ESTABLISHED:YYYY-MM-DD where the date is the LOCAL date of the most recent qualifying appointment. Examples: NEW / ESTABLISHED:2024-07-03
---
Phone numbers: answer in the form (XXX) XXX-XXXX unless the question says otherwise.
"""

CHART = """Wrenfield 4.2.0 | Harbor Glen Medical Group | Signed in as frontdesk (Administrator) | Location: All locations
Patients > Marisol Bennett

PATIENT CHART: Marisol Bennett
MRN HG-0048213 | DOB 03/14/1958 (68 y) | Sex F | Preferred language English | Restricted chart: No
Tabs: Summary | Demographics | Appointments | Documents | Billing | Activity

== Demographics ==
Legal name: Marisol Ann Bennett
Preferred name: Mari
Date of birth: 1958-03-14
Sex assigned at birth: Female
Mobile phone: 316.555.0187
Home phone: (316) 555-2290
Work phone: none on file
Address: 1418 W Maple St, Apt 3B, Wichita, KS 67213
Primary location: Northgate (Wichita, KS)
Primary care provider: Sharon Morales, MD
Emergency contact: Daniel Bennett (son), mobile 316-555-7741
Insurance (primary): Blue Cross Blue Shield of Kansas | Member ID KSB448120937 | Group 77120 | Effective 2019-01-01
Insurance (secondary): Medicare Part B | MBI 4TR7-QW2-MK81 | Effective 2023-03-01
Preferred pharmacy: Dillons Pharmacy #142, 3211 W 13th St N, Wichita, KS 67203
Communication preferences: SMS reminders ON | Portal: active | Paper statements: OFF
Merged charts: Duplicate chart HG-0051177 (Marisol A. Bennet, DOB 1958-03-14) was merged into this chart on 2024-02-03 by jpatel. Appointments and documents from the duplicate are listed here and marked [merged].
Allergies: Penicillin (hives); Sulfa drugs (rash)
Problem list: Essential hypertension; Paroxysmal atrial fibrillation; Hyperlipidemia; Obstructive sleep apnea (suspected)

== Care team / provider directory (from Schedule > Providers) ==
Provider | Credentials | Specialty | Locations
Sharon Morales | MD | Family Medicine | Northgate, Highline
David Cho | DO | Family Medicine | Front Range, Highline
Elena Ruiz | NP | Family Medicine | Northgate, Eastside
Priya Natarajan | MD | Cardiology | Northgate, Stonebrook
Thomas Greer | MD | Dermatology | Eastside, Northgate
Aaron Feld | PA-C | Dermatology | Eastside
Lab Services | - | Laboratory | all locations

== Appointments (15) == times shown in UTC
ID | Date/time (UTC) | Location | Provider | Service | Status | Notes
APT-310442 | 2021-06-15 14:00 | Northgate | Sharon Morales, MD | Annual wellness visit | Completed |
APT-318907 | 2022-01-20 20:30 | Northgate | Lab Services | Lab draw | Completed | fasting lipid panel
APT-329115 | 2022-09-08 15:15 | Eastside | Thomas Greer, MD | Skin check | Completed | [merged] from HG-0051177
APT-340288 | 2023-02-27 17:00 | Northgate | Priya Natarajan, MD | Cardiology consult | Completed | referral from Prairie Heart & Vascular
APT-340961 | 2023-03-03 01:30 | Northgate | Priya Natarajan, MD | Echocardiogram review | Completed | evening clinic
APT-345530 | 2023-05-10 14:45 | Front Range | David Cho, DO | Office visit | No-show |
APT-357204 | 2023-11-14 22:00 | Northgate | Sharon Morales, MD | Office visit | Cancelled | patient called to cancel
APT-361877 | 2024-01-09 15:30 | Northgate | Elena Ruiz, NP | Nurse visit - vaccine | Completed | influenza + Tdap
APT-366012 | 2024-04-23 04:15 | Front Range | David Cho, DO | Urgent visit | Completed | after-hours urgent care
APT-372650 | 2024-08-19 18:00 | Eastside | Aaron Feld, PA-C | Skin biopsy | Completed |
APT-379341 | 2025-01-01 01:00 | Northgate | Elena Ruiz, NP | Telephone triage | Completed | dizziness, advised ED if worse
APT-384419 | 2025-05-28 20:20 | Northgate | Priya Natarajan, MD | Cardiology follow-up | Rescheduled | moved by clinic
APT-391006 | 2025-10-02 15:00 | Highline | Sharon Morales, MD | Telehealth office visit | Completed |
APT-398724 | 2026-02-11 17:30 | Northgate | Thomas Greer, MD | Skin check | Scheduled |
APT-401155 | 2026-03-20 13:00 | Northgate | Sharon Morales, MD | Annual wellness visit | Scheduled |

== Documents (12) ==
Received | Type | Title / From | Linked appointment | Uploaded by
2021-06-15 | Visit summary | Annual wellness visit, Sharon Morales, MD | APT-310442 | system
2022-01-21 | Lab results | Lipid panel, Quest Diagnostics | APT-318907 | interface
2022-08-30 | Referral letter | From Plains Dermatology Associates (Dr. Karen Holt): suspicious nevus, upper back [merged] | - | mlopez
2023-02-10 | Referral letter | From Prairie Heart & Vascular (Dr. Imran Qureshi): palpitations, irregular rhythm | - | frontdesk
2023-03-03 | Imaging report | Echocardiogram, Harbor Glen Imaging | APT-340961 | interface
2024-01-09 | Immunization record | Influenza (quadrivalent), Tdap | APT-361877 | eruiz
2024-08-26 | Pathology report | Skin biopsy: benign compound nevus | APT-372650 | interface
2025-03-12 | Referral letter | From Sunflower Family Practice (Dr. Lena Ortiz): second opinion, chest pain | - | frontdesk
2025-06-03 | Fax | Prior authorization approval, Blue Cross Blue Shield of Kansas | - | frontdesk
2025-06-11 | Referral letter | From Wichita Pulmonary Partners (Dr. Omar Haddad): suspected sleep apnea | - | jpatel
2025-06-30 | Referral letter | From Plains Dermatology Associates (Dr. Karen Holt): new lesion, left forearm | - | frontdesk
2025-10-02 | Visit summary | Telehealth office visit, Sharon Morales, MD | APT-391006 | system

== Billing summary ==
Account balance: $142.60 (patient responsibility) | Last statement 2025-10-15 | Payment plan: none
Recent claims: CLM-88412 2025-10-02 99213 Telehealth office visit $189.00 paid by BCBS-KS $121.40 | CLM-86120 2024-08-19 11102 Skin biopsy $310.00 paid $248.00 | CLM-84007 2024-04-22 99214 Urgent visit $226.00 paid $171.30

== Activity (last 5) ==
2025-11-18 09:12 frontdesk viewed chart | 2025-10-15 07:00 system generated statement | 2025-10-02 16:05 smorales signed visit note | 2025-06-30 13:40 frontdesk uploaded document | 2025-06-11 10:22 jpatel uploaded document
"""

# (id, question, expected, accepted_variants, kind, trap)
QUESTIONS = [
    ("q1_boundary_tz", "Billing question: Marisol Bennett, visit with Priya Natarajan, MD on 2026-03-02. Is that a new or an established patient visit?",
     "ESTABLISHED:2023-03-02", "nvse", "3-yr boundary inclusive + UTC 2023-03-03 01:30 is local 2023-03-02 CST"),
    ("q2_boundary_excl", "Billing question: Marisol Bennett, visit with Priya Natarajan, MD on 2026-03-03. Is that a new or an established patient visit?",
     "NEW", "nvse", "window starts 2023-03-03; local echo date 2023-03-02 is outside; 2025 visit Rescheduled"),
    ("q3_excluded_tz", "Billing question: Marisol Bennett, visit with Sharon Morales, MD on 2025-09-15. Is that a new or an established patient visit?",
     "ESTABLISHED:2024-04-22", "nvse", "vaccine/triage excluded; same-specialty Cho; UTC 04-23 04:15 = local 04-22 MDT"),
    ("q4_same_specialty", "Billing question: Marisol Bennett, visit with Thomas Greer, MD on 2025-08-20. Is that a new or an established patient visit?",
     "ESTABLISHED:2024-08-19", "nvse", "latest derm visit is with Feld PA-C (same specialty)"),
    ("q5_status_latest", "Billing question: Marisol Bennett, visit with David Cho, DO on 2026-04-25. Is that a new or an established patient visit?",
     "ESTABLISHED:2025-10-02", "nvse", "2026-03-20 Scheduled must be ignored; pick latest completed FM"),
    ("q6_phone", "What mobile phone number do we have on file for patient Marisol Bennett (born 1958-03-14)?",
     "(316) 555-0187", "phone", "stored as 316.555.0187; home/emergency numbers are distractors"),
    ("q7_count_tz", "How many completed appointments did Marisol Bennett have in calendar year 2024 (use local dates)? Answer with a whole number.",
     "4", "int", "UTC 2025-01-01 01:00 is 2024-12-31 local; UTC count would be 3"),
    ("q8_latest_referral", "Which practice sent the most recent referral letter for Marisol Bennett received before 2025-06-20? Answer with the practice name only.",
     "Wichita Pulmonary Partners", "text", "06-30 referral is after cutoff; 06-03 fax is not a referral"),
]

LATENCY_QUESTION = QUESTIONS[2][1]  # q3: needs date-window reasoning, short answer
LATENCY_EXPECTED = QUESTIONS[2][2]


def normalize(ans: str, kind: str) -> str:
    import re
    a = (ans or "").strip().strip("`").strip('"').strip("'").strip()
    a = a.splitlines()[-1].strip() if a else a  # last line if the model rambled
    if kind == "phone":
        d = re.sub(r"\D", "", a)
        if len(d) == 11 and d.startswith("1"):
            d = d[1:]
        return d
    if kind == "int":
        return a.replace(",", "").replace(".0", "")
    a = re.sub(r"\s*([:,])\s*", r"\1", a)
    a = re.sub(r"\s+", " ", a).lower().rstrip(".")
    return a


def is_correct(ans: str, expected: str, kind: str) -> bool:
    return normalize(ans, kind) == normalize(expected, kind)


# ---------- self-check of ground truth ----------
def _local(utc_str: str, loc: str) -> date:
    from zoneinfo import ZoneInfo
    tz = ZoneInfo("America/Denver" if loc in {"Front Range", "Highline", "Prairie View", "Cedar Hollow", "Willow Creek"} else "America/Chicago")
    return datetime.strptime(utc_str, "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc).astimezone(tz).date()


def _check():
    spec = {}
    rows = []
    sec = None
    for line in CHART.splitlines():
        if line.startswith("== "):
            sec = line
            continue
        if sec and sec.startswith("== Care team") and " | " in line and not line.startswith("Provider"):
            p = [x.strip() for x in line.split("|")]
            spec[f"{p[0]}, {p[1]}" if p[1] != "-" else p[0]] = p[2]
        if sec and sec.startswith("== Appointments") and line.startswith("APT-"):
            p = [x.strip() for x in line.split("|")]
            rows.append(dict(utc=p[1], loc=p[2], prov=p[3], svc=p[4], status=p[5]))
    excl = {"Lab draw", "Nurse visit - vaccine", "Telephone triage"}

    def nve(prov, vdate):
        v = date.fromisoformat(vdate)
        start = v.replace(year=v.year - 3)
        best = None
        for r in rows:
            if r["status"] != "Completed" or r["svc"] in excl:
                continue
            if not (r["prov"] == prov or spec.get(r["prov"]) == spec[prov]):
                continue
            d = _local(r["utc"], r["loc"])
            if start <= d < v and (best is None or d > best):
                best = d
        return "NEW" if best is None else f"ESTABLISHED:{best.isoformat()}"

    import re
    for qid, q, exp, kind, _ in QUESTIONS:
        if kind == "nvse":
            m = re.search(r"with (.+?) on (\d{4}-\d{2}-\d{2})", q)
            got = nve(m.group(1), m.group(2))
            print(qid, got, "OK" if got == exp else f"MISMATCH (expected {exp})")
    n2024 = sum(1 for r in rows if r["status"] == "Completed" and _local(r["utc"], r["loc"]).year == 2024)
    print("q7", n2024, "OK" if str(n2024) == QUESTIONS[6][2] else "MISMATCH")


if __name__ == "__main__":
    _check()


def chart_local():
    """Same chart, but the Appointments table pre-converted to location-local time (what our code would do)."""
    out = []
    for line in CHART.splitlines():
        if line.startswith("== Appointments"):
            line = "== Appointments (15) == times shown in each location's local time"
        elif line.startswith("ID | Date/time (UTC)"):
            line = line.replace("Date/time (UTC)", "Local date/time")
        elif line.startswith("APT-"):
            p = [x.strip() for x in line.split("|")]
            from zoneinfo import ZoneInfo
            tz = ZoneInfo("America/Denver" if p[2] in {"Front Range", "Highline", "Prairie View", "Cedar Hollow", "Willow Creek"} else "America/Chicago")
            dt = datetime.strptime(p[1], "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc).astimezone(tz)
            p[1] = dt.strftime("%Y-%m-%d %H:%M %Z")
            line = " | ".join(p)
        out.append(line)
    return "\n".join(out)


# ---------------- code-writer benchmark dataset ----------------
CO_LOCS = ["Front Range", "Highline", "Prairie View", "Cedar Hollow", "Willow Creek"]
KS_LOCS = ["Northgate", "Eastside", "Stonebrook", "Lakeside", "Riverbend"]
PROVIDERS = [("Sharon Morales, MD", "Family Medicine"), ("David Cho, DO", "Family Medicine"), ("Elena Ruiz, NP", "Family Medicine"),
             ("Priya Natarajan, MD", "Cardiology"), ("Omar Haddad, MD", "Cardiology"), ("Thomas Greer, MD", "Dermatology"),
             ("Aaron Feld, PA-C", "Dermatology"), ("Lab Services", "Laboratory")]
SERVICES = {"Family Medicine": ["Office visit", "Annual wellness visit", "Urgent visit", "Telephone triage", "Nurse visit - vaccine"],
            "Cardiology": ["Cardiology consult", "Cardiology follow-up", "Echocardiogram review"],
            "Dermatology": ["Skin check", "Skin biopsy"], "Laboratory": ["Lab draw"]}


def code_dataset(seed=7):
    import random
    rnd = random.Random(seed)
    first = ["Ana", "Ben", "Cara", "Dev", "Eli", "Fay", "Gus", "Hal", "Ivy", "Jon", "Kai", "Lea", "Max", "Nia", "Oto", "Pia"]
    last = ["Alvarez", "Brooks", "Chen", "Dawson", "Eriksen", "Fischer", "Garcia", "Hughes", "Ibarra", "Jensen", "Kowalski", "Lindqvist"]
    patients = []
    for i in range(60):
        patients.append({"patient_id": f"P{1000+i}", "name": f"{rnd.choice(first)} {rnd.choice(last)}",
                         "dob": f"{rnd.randint(1940, 2015)}-{rnd.randint(1,12):02d}-{rnd.randint(1,28):02d}"})
    appts = []
    base = datetime(2022, 1, 1, tzinfo=timezone.utc)
    for j in range(420):
        p = rnd.choice(patients)
        prov, spec = rnd.choice(PROVIDERS)
        loc = rnd.choice(CO_LOCS + KS_LOCS)
        t = base + timedelta(minutes=rnd.randint(0, 60 * 24 * 365 * 4))
        # bias some times to late evening UTC (date-shift edge cases)
        if rnd.random() < 0.3:
            t = t.replace(hour=rnd.choice([0, 1, 2, 3, 4, 5]))
        status = rnd.choices(["Completed", "No-show", "Cancelled", "Rescheduled", "Scheduled"], [70, 10, 10, 5, 5])[0]
        appts.append({"appointment_id": f"APT-{500000+j}", "patient_id": p["patient_id"], "start_utc": t.strftime("%Y-%m-%dT%H:%M:%SZ"),
                      "location": loc, "provider": prov, "service": rnd.choice(SERVICES[spec]), "status": status})
    providers = [{"provider": a, "specialty": b} for a, b in PROVIDERS]
    locations = [{"location": l, "state": "CO", "timezone": "America/Denver"} for l in CO_LOCS] + \
                [{"location": l, "state": "KS", "timezone": "America/Chicago"} for l in KS_LOCS]
    return {"patients": patients, "appointments": appts, "providers": providers, "locations": locations}


def code_truth(data):
    from zoneinfo import ZoneInfo
    tzof = {l["location"]: ZoneInfo(l["timezone"]) for l in data["locations"]}
    spec = {p["provider"]: p["specialty"] for p in data["providers"]}

    def ld(a):
        return datetime.strptime(a["start_utc"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).astimezone(tzof[a["location"]]).date()
    # C1
    c1 = len({a["patient_id"] for a in data["appointments"] if a["status"] == "Completed" and a["location"] in CO_LOCS
              and ld(a).year == 2025 and ld(a).month == 10})
    # C2: pick a patient/provider with history
    from collections import Counter
    ns = Counter(a["provider"] for a in data["appointments"] if a["status"] == "No-show" and ld(a).year == 2025)
    top = ns.most_common()
    c3 = top[0][0] if len(top) < 2 or top[0][1] != top[1][1] else None
    excl = {"Lab draw", "Nurse visit - vaccine", "Telephone triage"}

    def nve(pid, prov, v):
        start = v.replace(year=v.year - 3)
        best = None
        for a in data["appointments"]:
            if a["patient_id"] != pid or a["status"] != "Completed" or a["service"] in excl:
                continue
            if not (a["provider"] == prov or spec[a["provider"]] == spec[prov]):
                continue
            d = ld(a)
            if start <= d < v and (best is None or d > best):
                best = d
        return "NEW" if best is None else f"ESTABLISHED:{best.isoformat()}"
    return c1, c3, nve


CODE_SYSTEM = """You write Python 3 to answer questions about clinic data that our agent has already crawled.
Write a function `solve(data)` that returns the final answer as a string. `data` is a dict with keys:
- patients: list of {patient_id, name, dob}
- appointments: list of {appointment_id, patient_id, start_utc ("YYYY-MM-DDTHH:MM:SSZ", UTC), location, provider, service, status}
- providers: list of {provider, specialty}
- locations: list of {location, state, timezone (IANA name)}
Standard library only (datetime, zoneinfo, collections are available). Dates in questions are LOCAL dates at the appointment's location.
Output ONLY one ```python code block with the function, no explanation."""
