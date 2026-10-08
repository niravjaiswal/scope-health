import httpx, asyncio
from .util import log, jdump

class Queue:
    def __init__(self, base):
        self.base = base.rstrip("/")
        self.c = httpx.AsyncClient(timeout=30)
        self.state = None

    async def get(self):
        for i in range(5):
            try:
                r = await self.c.get(self.base + "/item")
                self.state = r.json()
                return self.state
            except Exception as e:
                log("QUEUE get err", repr(e)); await asyncio.sleep(0.5)
        return {"status": "ended", "reason": "error"}

    async def close(self, item_id, **kw):
        body = {"id": item_id, **kw}
        for i in range(5):
            try:
                r = await self.c.post(self.base + "/item/close", json=body)
                d = r.json()
                if r.status_code == 200:
                    self.state = d; return d
                code = (d.get("error") or {}).get("code")
                log("QUEUE close", r.status_code, jdump(d, 400))
                if code in ("not_current", "ended") and "state" in d:
                    self.state = d["state"]; return d["state"]
                if code == "bad_request" and "answer" in kw:
                    # fall back to skip so we never get stuck
                    body = {"id": item_id, "skip": True}
                    continue
                if code == "wrong_action":
                    body = {"id": item_id, "acknowledge": True} if "acknowledge" not in body else {"id": item_id, "skip": True}
                    continue
                await asyncio.sleep(0.3)
            except Exception as e:
                log("QUEUE close err", repr(e)); await asyncio.sleep(0.5)
        return await self.get()
