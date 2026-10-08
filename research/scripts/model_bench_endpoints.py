import json, httpx, sys
from pathlib import Path
env = {}
for line in Path("/Users/nirav/development/scope health/.env.dev").read_text().splitlines():
    if "=" in line and not line.strip().startswith("#"):
        k, v = line.split("=", 1); env[k.strip()] = v.strip().strip('"').strip("'")
BASE = env["LLM_BASE_URL"].rstrip("/")
H = {"Authorization": f"Bearer {env['LLM_API_KEY']}"}
ids = sys.argv[1:]
allout = {}
with httpx.Client(timeout=60) as c:
    for mid in ids:
        r = c.get(f"{BASE}/models/{mid}/endpoints", headers=H)
        if r.status_code != 200:
            print(mid, r.status_code, r.text[:200]); continue
        d = r.json()["data"]
        allout[mid] = d
        print(f"== {mid}  (params: {','.join(d.get('endpoints',[{}])[0].get('supported_parameters',[]) if d.get('endpoints') else [])})")
        for e in d.get("endpoints", []):
            p = e.get("pricing", {})
            lat = e.get("latency_last_30m"); thr = e.get("throughput_last_30m")
            def g(x, k):
                if isinstance(x, dict): return x.get(k)
                return x
            print(f"   {e.get('provider_name'):22s} tag={e.get('tag')!s:28s} q={e.get('quantization')!s:6s} in={float(p.get('prompt',0))*1e6:.3f} out={float(p.get('completion',0))*1e6:.3f} cache={float(p.get('input_cache_read',0) or 0)*1e6:.3f} ctx={e.get('context_length')} lat_p50={g(lat,'p50')} thr_p50={g(thr,'p50')} up={e.get('uptime_last_30m')} status={e.get('status')}")
Path("/Users/nirav/development/scope health/research/bench_out/endpoints.json").write_text(json.dumps(allout, indent=1))
