import httpx, asyncio, json, time, re
from .util import log, jdump, ENV

class LLM:
    """OpenAI-compatible chat client for the judge proxy / OpenRouter, with cost tracking."""
    def __init__(self, base=None, key=None, budget=None):
        self.base = (base or ENV["LLM_BASE_URL"]).rstrip("/")
        self.key = key or ENV["LLM_API_KEY"]
        self.c = httpx.AsyncClient(timeout=httpx.Timeout(120, connect=10),
                                   limits=httpx.Limits(max_connections=40, max_keepalive_connections=40))
        self.spent = 0.0
        self.calls = 0
        self.budget = budget
        self.dead = False   # set when budget exhausted (402)
        self.sem = asyncio.Semaphore(12)

    async def chat(self, model, messages, max_tokens=800, temperature=0, timeout=60, json_mode=False,
                   reasoning=None, extra=None, retries=2, tag="", tools=None):
        if self.dead:
            return None
        body = {"model": model, "messages": messages, "max_tokens": max_tokens, "temperature": temperature,
                "usage": {"include": True}}
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        if reasoning is not None:
            body["reasoning"] = reasoning
        if tools:
            body["tools"] = tools
            body["tool_choice"] = "auto"
        if extra:
            body.update(extra)
        t = time.time()
        for attempt in range(retries + 1):
            try:
                async with self.sem:
                    r = await self.c.post(self.base + "/chat/completions", json=body,
                                          headers={"Authorization": "Bearer " + self.key}, timeout=timeout)
                if r.status_code == 402:
                    self.dead = True; log("LLM budget exhausted"); return None
                if r.status_code == 429 or r.status_code >= 500:
                    log("LLM", r.status_code, r.text[:200]); await asyncio.sleep(0.3 + attempt); continue
                if r.status_code != 200:
                    log("LLM err", r.status_code, r.text[:300])
                    if attempt < retries and r.status_code in (400, 404) and "provider" in body:
                        body.pop("provider", None); continue
                    return None
                d = r.json()
                if not d.get("choices"):
                    log("LLM no choices", model, str(d)[:300])
                    if attempt < retries: await asyncio.sleep(0.3); continue
                    return None
                u = d.get("usage") or {}
                cost = u.get("cost") or 0.0
                self.spent += float(cost or 0); self.calls += 1
                ch = (d.get("choices") or [{}])[0]
                msg = ch.get("message") or {}
                content = msg.get("content") or ""
                log(f"LLM {tag} {model} {time.time()-t:.1f}s in={u.get('prompt_tokens')} out={u.get('completion_tokens')} ${cost:.4f} tot=${self.spent:.3f}")
                return {"content": content, "message": msg, "usage": u, "dt": time.time() - t}
            except (httpx.TimeoutException, httpx.TransportError) as e:
                log("LLM timeout/transport", model, repr(e)[:120])
                if attempt >= retries or time.time() - t > timeout: return None
            except Exception as e:
                log("LLM exc", repr(e)[:200]); return None
        return None

    async def json(self, model, messages, **kw):
        r = await self.chat(model, messages, json_mode=kw.pop("json_mode", True), **kw)
        if not r: return None
        return parse_json(r["content"])

def parse_json(s):
    if not s: return None
    s = s.strip()
    m = re.search(r"```(?:json)?\s*(.*?)```", s, re.S)
    if m: s = m.group(1)
    i = s.find("{"); j = s.rfind("}")
    if i >= 0 and j > i:
        try: return json.loads(s[i:j+1])
        except Exception: pass
    return None
