class KindStats:
    """Per task-kind track record within this shift, to stop wasting time on kinds we keep failing."""
    def __init__(self):
        self.d = {}
    def key(self, route):
        if not route: return None
        wf = route.get("workflow")
        return f"wf{wf}" if wf is not None else (route.get("kind") or "other")
    def add(self, k, answered, dt):
        if k is None: return
        a = self.d.setdefault(k, {"n": 0, "ans": 0, "t": 0.0})
        a["n"] += 1; a["ans"] += int(bool(answered)); a["t"] += dt
    def budget_factor(self, k):
        a = self.d.get(k)
        if not a or a["n"] < 3: return 1.0
        rate = a["ans"] / a["n"]
        if rate == 0 and a["n"] >= 4: return 0.35
        if rate < 0.2: return 0.6
        return 1.0


KSTATS = KindStats()
