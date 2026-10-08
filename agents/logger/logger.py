import json, os, sys, time, urllib.request, urllib.error, re, html

T0 = time.time()
def log(*a):
    print(f"[{time.time()-T0:7.2f}]", *a, flush=True)

Q = os.environ.get("QUEUE_URL", "").rstrip("/")
SITE = os.environ.get("SITE_URL", "").rstrip("/")
LLM = os.environ.get("LLM_BASE_URL", "").rstrip("/")
KEY = os.environ.get("LLM_API_KEY", "")
log("ENV", {k: (v if k != "LLM_API_KEY" and "PASSWORD" not in k else "***") for k, v in os.environ.items()
            if k in ("QUEUE_URL","SITE_URL","SITE_USERNAME","LLM_BASE_URL","SHIFT_SECONDS","WORK_DIR")})

def req(method, url, body=None, headers=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    h = {"Content-Type": "application/json"} if body is not None else {}
    h.update(headers or {})
    r = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:
        return -1, repr(e)

def strip(s):
    s = re.sub(r"<script.*?</script>|<style.*?</style>|<svg.*?</svg>", " ", s, flags=re.S)
    s = re.sub(r"<[^>]+>", " | ", s)
    s = re.sub(r"(\s*\|\s*)+", " | ", s)
    return html.unescape(s)

# Models served by proxy
st, body = req("GET", LLM + "/models", headers={"Authorization": "Bearer " + KEY})
try:
    ids = [m["id"] for m in json.loads(body)["data"]]
    log("MODELS", len(ids)); print("MODEL_IDS " + " ".join(ids), flush=True)
except Exception:
    log("MODELS_ERR", st, body[:500])

# Queue first (time matters less for logger, but grab items quickly)
items = []
st, body = req("GET", Q + "/item")
state = json.loads(body) if st == 200 else {"status": "error", "body": body}
while state.get("status") == "open":
    it = state["item"]
    items.append(it)
    print("ITEM_JSON " + json.dumps({"n": len(items), "secs_left": state.get("seconds_left"), **it}, ensure_ascii=False), flush=True)
    payload = {"id": it["id"], "acknowledge": True} if it["kind"] == "message" else {"id": it["id"], "skip": True}
    st, body = req("POST", Q + "/item/close", payload)
    try:
        state = json.loads(body)
    except Exception:
        log("BAD", st, body[:500]); break
    if st != 200:
        log("ERR", st, body[:500])
        if "state" in state: state = state["state"]
        else: break
log("QUEUE_DONE", json.dumps(state), "items", len(items),
    "tasks", sum(1 for i in items if i["kind"] == "task"), "messages", sum(1 for i in items if i["kind"] == "message"))

# Site shell info
for path in ["/login", "/", "/patients"]:
    st, body = req("GET", SITE + path)
    log("SITE", path, st, len(body))
    print("SITE_TEXT", path, strip(body)[:3000], flush=True)
    print("SITE_HTML_HEAD", path, body[:1500].replace("\n", " "), flush=True)

log("END")
