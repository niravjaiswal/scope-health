import os, json, httpx, re, sys
from pathlib import Path
env = {}
for line in Path("/Users/nirav/development/scope health/.env.dev").read_text().splitlines():
    if "=" in line and not line.strip().startswith("#"):
        k, v = line.split("=", 1); env[k.strip()] = v.strip().strip('"').strip("'")
BASE = env["LLM_BASE_URL"].rstrip("/")
H = {"Authorization": f"Bearer {env['LLM_API_KEY']}"}
r = httpx.get(f"{BASE}/models", headers=H, timeout=60)
data = r.json()["data"]
out = Path("/Users/nirav/development/scope health/research/bench_out/models.json")
out.write_text(json.dumps(data, indent=1))
print(len(data))
pat = re.compile(r"(claude-(haiku|sonnet)|gpt-5|gpt-4\.1|gemini.*flash|gemini-.*pro|grok|gpt-oss|qwen3|deepseek|kimi|glm|llama-4|mistral|cerebras|minimax|magistral|codestral|devstral)", re.I)
rows = []
for m in data:
    if pat.search(m["id"]):
        p = m.get("pricing", {})
        try:
            pi = float(p.get("prompt", 0))*1e6; po = float(p.get("completion", 0))*1e6
            cr = float(p.get("input_cache_read", 0) or 0)*1e6
        except Exception: pi=po=cr=-1
        rows.append((m["id"], pi, po, cr, m.get("context_length"), m.get("created"), ",".join(m.get("supported_parameters", []))[:0]))
rows.sort(key=lambda x: x[0])
import datetime
for r_ in rows:
    d = datetime.datetime.fromtimestamp(r_[5]).date() if r_[5] else ""
    print(f"{r_[0]:60s} in={r_[1]:7.3f} out={r_[2]:7.3f} cache={r_[3]:6.3f} ctx={r_[4]} {d}")
