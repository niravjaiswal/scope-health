class KindStats:
    """Per task-kind track record within this shift: answer rate and time, to spend time where it pays."""
    def __init__(self):
        self.d = {}
        self.pace = None   # seconds per remaining task available right now

    def key(self, route):
        if not route: return None
        wf = route.get("workflow")
        return f"wf{wf}" if wf is not None else (route.get("kind") or "other")

    def add(self, k, answered, dt):
        if k is None: return
        a = self.d.setdefault(k, {"n": 0, "ans": 0, "t": 0.0, "t_ans": 0.0})
        a["n"] += 1; a["ans"] += int(bool(answered)); a["t"] += dt
        if answered: a["t_ans"] += dt

    def budget_factor(self, k):
        a = self.d.get(k)
        if not a or a["n"] < 3: return 1.0
        rate = a["ans"] / a["n"]
        if rate == 0 and a["n"] >= 4: return 0.35
        if rate < 0.2: return 0.6
        return 1.0

    def should_skip(self, k):
        """Under time pressure, skip kinds whose expected points per second are far below what the remaining pace needs."""
        a = self.d.get(k)
        if not a or a["n"] < 2 or self.pace is None: return False
        avg_t = a["t"] / a["n"]
        rate = (a["ans"] + 0.5) / (a["n"] + 1)
        pts_per_s = rate / max(avg_t, 0.5)
        need = 1.0 / max(self.pace, 0.5)     # points/s we'd get if every remaining task were a quick sure answer
        return pts_per_s < 0.25 * need and avg_t > 1.6 * self.pace

    def summary(self):
        return {k: f"{v['ans']}/{v['n']} {v['t']/max(1,v['n']):.1f}s" for k, v in self.d.items()}


KSTATS = KindStats()
