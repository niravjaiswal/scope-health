import time, sys, json, os

T0 = time.time()

def now():
    return time.time() - T0

def log(*a):
    print(f"[{now():7.2f}]", *a, flush=True)

def jdump(o, n=None):
    s = json.dumps(o, ensure_ascii=False, default=str)
    return s if n is None or len(s) <= n else s[:n] + "…"

ENV = {k: os.environ.get(k, "") for k in
       ["QUEUE_URL", "SITE_URL", "SITE_USERNAME", "SITE_PASSWORD", "LLM_BASE_URL", "LLM_API_KEY", "SHIFT_SECONDS", "WORK_DIR"]}
