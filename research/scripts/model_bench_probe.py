import json, httpx, time, sys
from pathlib import Path
env = {}
for line in Path("/Users/nirav/development/scope health/.env.dev").read_text().splitlines():
    if "=" in line and not line.strip().startswith("#"):
        k, v = line.split("=", 1); env[k.strip()] = v.strip().strip('"').strip("'")
BASE = env["LLM_BASE_URL"].rstrip("/")
H = {"Authorization": f"Bearer {env['LLM_API_KEY']}", "Content-Type": "application/json"}
body = {"model": sys.argv[1], "messages": [{"role":"user","content":"Reply with just the word: pong"}], "max_tokens": 200, "stream": True, "usage": {"include": True}}
if len(sys.argv) > 2: body.update(json.loads(sys.argv[2]))
t0 = time.time()
with httpx.Client(timeout=120) as c:
    with c.stream("POST", f"{BASE}/chat/completions", headers=H, json=body) as r:
        print("status", r.status_code)
        for line in r.iter_lines():
            if not line: continue
            print(round(time.time()-t0,3), line[:400])
