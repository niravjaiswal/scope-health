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
            self.workflows.append({"n": n, "title": title, "text": t})
            log(f"MEMORY workflow #{len(self.workflows)-1} item{n}: {title}")
        else:
            self.notes.append((n, t))
            log(f"MEMORY note item{n}: {t[:120]}")

    def workflow_titles(self):
        return [(i, w["n"], w["title"]) for i, w in enumerate(self.workflows)]

    def workflow_text(self, idx):
        try:
            idx = int(idx)
            return self.workflows[idx]["text"]
        except Exception:
            return None

    def notes_text(self):
        return "\n".join(f"- (item {n}) {t}" for n, t in self.notes) or "(none)"
