import re
from .util import log


class Memory:
    """All messages in order. Long, rule-like messages are workflows; short ones are notes (facts/amendments/noise)."""
    def __init__(self):
        self.items = []      # (n, text)
        self.workflows = []  # list of dict(n, title, text)
        self.notes = []      # list of (n, text)

    def add(self, n, text):
        self.items.append((n, text))
        t = text.strip()
        is_wf = len(t) >= 450 or (len(t) >= 250 and re.search(r"(?i)answer|##|\|---", t))
        if is_wf:
            title = t.split("\n", 1)[0].strip()[:160]
            self.workflows.append({"n": n, "title": title, "text": t, "applies": ""})
            log(f"MEMORY workflow #{len(self.workflows)-1} item{n}: {title}")
        else:
            self.notes.append((n, t))
            log(f"MEMORY note item{n}: {t[:120]}")

    def workflow_titles(self):
        return [(i, w["n"], w["title"] + (f" — applies to: {w['applies']}" if w.get("applies") else "")) for i, w in enumerate(self.workflows)]

    async def summarize(self, llm, idx):
        """One-line 'applies when' description of a workflow message (what requests it governs)."""
        w = self.workflows[idx]
        prompt = ("Here is a message to back-office staff. In ONE line (max 30 words), say which incoming requests it governs "
                  "(what is asked, e.g. 'questions asking what to do with a lab report of a patient'), or say 'amends rule about <topic>' if it only changes an earlier rule, "
                  "or 'no requests' if it is not a work rule.\n\nMESSAGE:\n" + w["text"][:3000])
        r = await llm.chat("openai/gpt-oss-120b", [{"role": "user", "content": prompt}], max_tokens=600, reasoning={"effort": "low"},
                           extra={"provider": {"sort": "throughput"}}, timeout=10, tag="wfsum")
        if r and r.get("content"):
            w["applies"] = r["content"].strip().split("\n")[0][:220]
            log(f"MEMORY wf{idx} applies: {w['applies']}")

    def workflow_text(self, idx):
        try:
            idx = int(idx)
            return self.workflows[idx]["text"]
        except Exception:
            return None

    def workflows_text(self, idxs):
        parts = []
        for k, i in enumerate(idxs):
            w = self.workflows[i]
            head = f"[rule from item {w['n']}]" if k == 0 else f"[another message, item {w['n']}: if it changes the rule above, it overrides it only where and when it says so (check its conditions); if it is about something else, ignore it]"
            parts.append(head + "\n" + w["text"])
        return "\n\n".join(parts)

    def notes_text(self):
        return "\n".join(f"- (item {n}) {t}" for n, t in self.notes) or "(none)"


STOP = set("""about above after again against because been before being below between both could does doing during each
from further have having here into itself just more most other ought ourselves over same should some such than that their
theirs them themselves then there these they this those through under until very what when where which while with would
your yours patient patients answer request requests asked asks question visit visits date dates chart record records
clinic today rule rules work works them will need needs please that's what's there's give given name names""".split())


def _words(t):
    return {w for w in re.findall(r"[a-z]{4,}", (t or "").lower()) if w not in STOP}


def lexical_match(mem, text):
    """Indices of workflows whose topic words strongly overlap the request (backup for the LLM router)."""
    if not mem.workflows:
        return []
    docs = [_words(w["title"] + " " + w["text"][:700]) for w in mem.workflows]
    df = {}
    for d in docs:
        for w in d: df[w] = df.get(w, 0) + 1
    tw = _words(text)
    scores = []
    for i, d in enumerate(docs):
        sc = sum(1.0 / df[w] for w in tw & d)
        scores.append(sc)
    best = max(scores)
    if best < 1.5:
        return []
    return [i for i, sc in enumerate(scores) if sc >= max(1.5, 0.6 * best)]


def _example_regex(ex):
    ex = ex.strip()
    if not ex or len(ex) > 60:
        return None
    parts = re.split(r"(<[^>]+>|\d{4}-\d{2}-\d{2}|YYYY-MM-DD|\d+\.\d+|\d+|[A-Z][A-Z_]{1,}|[:,])", ex)
    out = ""
    for p in parts:
        if not p: continue
        if p.startswith("<") or (re.fullmatch(r"[A-Za-z' ]+", p) and not re.fullmatch(r"[A-Z][A-Z_]+", p)):
            out += r".+"
        elif re.fullmatch(r"\d{4}-\d{2}-\d{2}|YYYY-MM-DD", p):
            out += r"\d{4}-\d{2}-\d{2}"
        elif re.fullmatch(r"\d+\.\d+", p):
            out += r"\d+\." + r"\d" * len(p.split(".")[1])
        elif re.fullmatch(r"\d+", p):
            out += r"\d+"
        elif p in ":,":
            out += r"\s*" + re.escape(p) + r"\s*"
        elif re.fullmatch(r"\s+", p):
            out += r"\s*"
        else:
            out += re.escape(p)
    try:
        return re.compile("^" + out + "$", re.I)
    except re.error:
        return None


def answer_formats(mem, idxs):
    """Regexes built from the backticked answer examples of the given workflows ([] = no constraint)."""
    pats, exs = [], []
    for i in idxs:
        for ex in re.findall(r"`([^`\n]{1,60})`", mem.workflows[i]["text"]):
            r = _example_regex(ex)
            if r: pats.append(r); exs.append(ex)
    return pats, exs
