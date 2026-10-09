"""Local re-implementation of the judge's answer normalization (approximate) for offline eval."""
import re, datetime

MONTHS = {m: i for i, m in enumerate(["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"], 1)}

def as_date(s):
    s = str(s).strip()
    m = re.match(r"^(\d{4})[-/](\d{1,2})[-/](\d{1,2})", s)
    if m: return (int(m[1]), int(m[2]), int(m[3]))
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})", s)
    if m: return (int(m[3]), int(m[1]), int(m[2]))
    m = re.match(r"^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})", s)
    if m and m[1].lower() in MONTHS: return (int(m[3]), MONTHS[m[1].lower()], int(m[2]))
    m = re.match(r"^(\d{1,2}) ([A-Za-z]{3})[a-z]* (\d{4})", s)
    if m and m[2].lower() in MONTHS: return (int(m[3]), MONTHS[m[2].lower()], int(m[1]))
    return None

def as_phone(s):
    d = re.sub(r"\D", "", str(s))
    if len(d) == 11 and d[0] == "1": d = d[1:]
    return d if len(d) == 10 and re.fullmatch(r"[\d\s().+\-]+", str(s).strip()) else None

def as_num(s):
    t = str(s).strip().replace(",", "")
    t = re.sub(r"^\$", "", t); t = re.sub(r"%$", "", t)
    try: return float(t)
    except Exception: return None

def text_norm(s):
    s = str(s).strip().lower()
    s = re.sub(r"\s*([:,])\s*", r"\1", s)
    return re.sub(r"\s+", " ", s)

def same(ans, exp):
    if ans is None: return None
    if isinstance(ans, list): ans = ", ".join(map(str, ans))
    a, e = str(ans), str(exp)
    if text_norm(a) == text_norm(e): return True
    pe = as_phone(e)
    if pe and as_phone(a) == pe: return True
    de = as_date(e)
    if de and as_date(a) == de and re.fullmatch(r"\d{4}-\d{2}-\d{2}", e.strip()): return True
    ne = as_num(e)
    if ne is not None and re.fullmatch(r"[\d,.$%-]+", e.strip()) and as_num(a) is not None and abs(as_num(a) - ne) < 0.005: return True
    if "," in e or ";" in e:
        sa = sorted(text_norm(x) for x in re.split(r"[;,\n]", a) if x.strip())
        se = sorted(text_norm(x) for x in re.split(r"[;,\n]", e) if x.strip())
        if sa == se and ":" not in e: return True
    return False
