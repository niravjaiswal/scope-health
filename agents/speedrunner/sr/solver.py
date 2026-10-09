"""Task solver: router -> entity resolution -> prefetch -> LLM tool loop -> validation."""
import asyncio, json, re, time, unicodedata
from .util import log, jdump, now
from . import prompts

FAST = {"model": "openai/gpt-oss-120b", "extra": {"provider": {"sort": "throughput"}}}
STRONG = {"model": "openai/gpt-6.1-sol", "extra": {}}

TOOLS = [
    {"type": "function", "function": {
        "name": "open", "description": "Open a Wrenfield page by path (e.g. /patients/abc123/notes) and return its decoded text. "
        "Set all_pages=true to also read every further page of a paginated list (slower).",
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string"}, "all_pages": {"type": "boolean"}}, "required": ["path"]}}},
    {"type": "function", "function": {
        "name": "search_patients", "description": "Search patients by last name (prefix ok) OR by date of birth YYYY-MM-DD. Returns matching rows with chart links and flags.",
        "parameters": {"type": "object", "properties": {
            "last_name": {"type": "string"}, "dob": {"type": "string"}}}}},
    {"type": "function", "function": {
        "name": "query", "description": "Open a page, set form fields (filters/search boxes/selects, by field name or label as listed in the SITE MAP) and submit; returns the resulting page text (all pages if all_pages=true). Use for filtered lists (appointment list by provider/status/location/date range, invoice search, document type filters, note search, etc.).",
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string"}, "fields": {"type": "object", "description": "field name or label -> value (for selects use the option text)"},
            "all_pages": {"type": "boolean"}}, "required": ["path", "fields"]}}},
    {"type": "function", "function": {
        "name": "read_document", "description": "Read a document (lab report, referral letter, outside record...) given its viewer page path from the documents list (e.g. /patients/<id>/documents/<docid>), returning a faithful transcription. Opening a document viewer page with open() also includes the content.",
        "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}},
    {"type": "function", "function": {
        "name": "answer", "description": "Submit the final answer (exact required format). confidence = probability (0-1) that it is exactly right.",
        "parameters": {"type": "object", "properties": {
            "answer": {"type": "string"}, "confidence": {"type": "number"}, "why": {"type": "string"}},
            "required": ["answer", "confidence"]}}},
    {"type": "function", "function": {
        "name": "skip", "description": "Skip this task (no penalty) when the data cannot be found or the answer is uncertain.",
        "parameters": {"type": "object", "properties": {"reason": {"type": "string"}}, "required": ["reason"]}}},
]


def norm(s):
    s = unicodedata.normalize("NFKD", s or "")
    return "".join(c for c in s if not unicodedata.combining(c)).casefold().strip()


def dob_iso(s):
    if not s: return None
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", s)
    if m: return m.group(0)
    m = re.search(r"(\d{1,2})/(\d{1,2})/(\d{4})", s)
    if m: return f"{m.group(3)}-{int(m.group(1)):02d}-{int(m.group(2)):02d}"
    return None


def abstract_path(p, ids):
    for k, v in ids.items():
        if v and v in p:
            p = p.replace(v, "{" + k + "}")
    return p


class Solver:
    def __init__(self, site, llm, memory, cfg):
        self.site = site; self.llm = llm; self.mem = memory; self.cfg = cfg
        self.plans = {}       # kind -> {abstract_path: count}
        self.doc_cache = {}

    # ------------------------------------------------------------------ router
    async def route(self, text):
        wf = self.mem.workflow_titles()
        msgs = [{"role": "system", "content": prompts.ROUTER_SYS},
                {"role": "user", "content": prompts.router_user(text, wf)}]
        r = await self.llm.chat(FAST["model"], msgs, max_tokens=900, json_mode=True,
                                reasoning={"effort": "low"}, extra=FAST["extra"], timeout=12, tag="route")
        from .llm import parse_json
        d = parse_json(r["content"]) if r else None
        return d or {}

    # ------------------------------------------------------------------ entities
    async def resolve_patient(self, p):
        last = (p.get("last") or "").strip()
        first = (p.get("first") or "").strip()
        dob = dob_iso(p.get("dob") or "")
        def match(rows):
            out = []
            for r in rows:
                name = r.get("name") or ""
                if "," in name:
                    rl, rf = [x.strip() for x in name.split(",", 1)]
                else:
                    parts = name.split(); rf, rl = (" ".join(parts[:-1]), parts[-1]) if parts else ("", "")
                ok_first = not first or norm(rf).split(" ")[0] == norm(first).split(" ")[0] or norm(rf).startswith(norm(first))
                ok_last = not last or norm(rl) == norm(last) or norm(rl).startswith(norm(last)) or norm(last) in norm(rl)
                ok_dob = not dob or dob_iso(r.get("dob") or "") == dob
                if ok_first and ok_last and ok_dob:
                    out.append(r)
            return out
        rows = []
        if dob:
            rows = await self.site.search(dob=dob)
            c = match(rows)
            if c: return c, rows
        if last:
            rows = await self.site.search(last_name=last)
            if not rows and " " in last:
                rows = await self.site.search(last_name=last.split()[-1])
        return match(rows), rows

    async def _unused(self, rows, first, last, dob):
        cands = []
        for r in rows:
            name = r.get("name") or ""
            if "," in name:
                rl, rf = [x.strip() for x in name.split(",", 1)]
            else:
                parts = name.split(); rf, rl = (" ".join(parts[:-1]), parts[-1]) if parts else ("", "")
            ok_first = not first or norm(rf).split(" ")[0] == norm(first).split(" ")[0] or norm(rf).startswith(norm(first))
            ok_last = not last or norm(rl) == norm(last) or norm(rl).startswith(norm(last))
            ok_dob = not dob or dob_iso(r.get("dob") or "") == dob
            if ok_first and ok_last and ok_dob:
                cands.append(r)
        return cands, rows

    # ------------------------------------------------------------------ tools
    async def tool_open(self, path, all_pages=False, fresh=False):
        path = path.strip()
        if path.startswith("http"):
            path = re.sub(r"^https?://[^/]+", "", path)
        if not path.startswith("/"): path = "/" + path
        if re.search(r"/patients/all\b|logout|log-out", path):
            return "Refused: not allowed."
        if all_pages:
            return await self.site.page_all(path)
        if path.startswith("/v/") and getattr(self, "last_doc_path", None):
            return await self.tool_read_document(self.last_doc_path)
        txt = await self.site.page(path, fresh=fresh)
        txt = re.sub(r"\s*<\/v\/[^>]*>", "", txt or "")
        if re.search(r"/(documents|files)/[0-9a-z]{6,}/?$", path.split("?")[0]):
            self.last_doc_path = path
            doc = await self.tool_read_document(path)
            txt += "\n\n=== DOCUMENT CONTENT (decoded from the document file) ===\n" + doc
        return txt

    async def tool_query(self, path, fields, all_pages=False):
        path = (path or "/").strip()
        if not path.startswith("/"): path = "/" + path
        return await self.site.query(path, fields, all_pages)

    async def tool_read_document(self, path, hint=""):
        path = (path or "").strip()
        if path.startswith("/v/") and getattr(self, "last_doc_path", None):
            path = self.last_doc_path
        if path in self.doc_cache: return self.doc_cache[path]
        try:
            files = await self.site.documents(path)
        except Exception as e:
            return f"ERROR {e!r}"
        from . import wf_docs
        if not hasattr(self, "_llm_call"):
            self._llm_call = wf_docs.make_llm_call()
        pdfs = [f["data"] for f in files if f.get("kind") == "pdf" and f.get("data") and f["data"][:4] == b"%PDF"]
        imgs = [f["data"] for f in files if f.get("kind") == "image" and f.get("data")]
        if not pdfs and not imgs:
            return "ERROR: no document file found on this page (open the document viewer page linked from the documents list)"
        t = time.time()
        res = await wf_docs.read_document(pdf_bytes=pdfs[0] if pdfs else None, pngs=None if pdfs else imgs[:6],
                                          llm_call=self._llm_call, hint=hint or "clinic document")
        txt = res.get("text") or "ERROR: unreadable"
        log(f"DOC {path} method={res.get('method')} conf={res.get('confidence')} {time.time()-t:.1f}s chars={len(txt)}")
        txt = f"[document {path} read via {res.get('method')}]\n" + txt
        self.doc_cache[path] = txt
        return txt

    async def visual_read(self, path, focus=""):
        """Screenshot the page and transcribe it with a vision model (defeats cipher fonts / pictures of text)."""
        import base64
        try:
            img = await self.site.screenshot(path)
        except Exception as e:
            return f"ERROR screenshot {e!r}"
        prompt = ("Transcribe the main content of this screenshot of a clinic records page exactly as displayed: every label and value, "
                  "one 'Label: value' per line, tables as 'a | b | c' rows. Copy digits, letters and punctuation exactly as they appear on screen. "
                  + (f"Be especially careful with: {focus}." if focus else ""))
        content = [{"type": "text", "text": prompt}, {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(img).decode()}}]
        for model, extra in (("anthropic/claude-haiku-5.5", {"reasoning": {"enabled": False}, "provider": {"sort": "latency"}}),
                             ("google/gemini-3.8-flash", {"reasoning": {"effort": "minimal"}})):
            r = await self.llm.chat(model, [{"role": "user", "content": content}], max_tokens=1500, timeout=12, extra=extra, tag="visual")
            if r and (r.get("content") or "").strip():
                return r["content"].strip()
        return "ERROR visual read failed"

    # ------------------------------------------------------------------ main
    async def solve(self, item, deadline):
        text = item["text"]
        t0 = time.time()
        route = await self.route(text)
        log("ROUTE", jdump(route, 500))
        try:
            from .stats import KSTATS
            f = KSTATS.budget_factor(KSTATS.key(route))
            if f < 1.0:
                new_deadline = t0 + max(2.5, (deadline - t0) * f)
                log(f"FAILFAST kind={KSTATS.key(route)} factor={f} budget {deadline-t0:.1f}->{new_deadline-t0:.1f}")
                deadline = new_deadline
        except Exception as e:
            log("failfast err", repr(e)[:100])
        kind = (route.get("kind") or "other").strip().lower()[:60]
        wfs = route.get("workflows")
        if not isinstance(wfs, list):
            wfs = [route.get("workflow")] if route.get("workflow") is not None else []
        byn = {w["n"]: i for i, w in enumerate(self.mem.workflows)}
        ok = set()
        for x in wfs:
            try: x = int(x)
            except Exception: continue
            if 0 <= x < len(self.mem.workflows):
                ok.add(x)
            elif x in byn:
                ok.add(byn[x])
        wfs = sorted(ok)
        wf_idx = wfs[0] if wfs else None
        route["workflow"] = wf_idx
        wf_text = self.mem.workflows_text(wfs) if wfs else None
        plan_key = f"wf{wf_idx}" if wf_idx is not None else kind

        # entity resolution + prefetch
        ctx_parts = []
        ids = {}
        pats = route.get("patients") or []
        resolved = await asyncio.gather(*[self.resolve_patient(p) for p in pats[:2]])
        prefetch = []
        for i, (cands, rows) in enumerate(resolved):
            p = pats[i]
            if not cands:
                ctx_parts.append(f"[patient search for {jdump(p)}: no exact match. Search rows: {jdump(rows[:12], 2500)}]")
                continue
            ctx_parts.append(f"[patient search for {jdump(p)} -> candidates: {jdump(cands[:6], 2000)}]")
            for j, c in enumerate(cands[:3]):
                href = c.get("href") or ""
                m = re.search(r"/patients/([0-9a-z]+)", href)
                if not m: continue
                pid = m.group(1)
                if i == 0 and j == 0: ids["pid"] = pid
                prefetch.append(f"/patients/{pid}")
                for ap, cnt in sorted(self.plans.get(plan_key, {}).items(), key=lambda x: -x[1])[:8]:
                    if "{pid}" in ap and cnt >= 1:
                        prefetch.append(ap.replace("{pid}", pid))
        for ap, cnt in sorted(self.plans.get(plan_key, {}).items(), key=lambda x: -x[1])[:6]:
            if "{" not in ap and cnt >= 2:
                prefetch.append(ap)
        prefetch = list(dict.fromkeys(prefetch))[:10]
        if prefetch:
            texts = await self.site.pages(prefetch)
            for pth, tx in zip(prefetch, texts):
                ctx_parts.append(f"=== PAGE {pth} ===\n{clip(tx, 9000)}")
        # provider facts from the directory, made salient
        ref = getattr(self.site, "reference", "") or ""
        for prov in (route.get("providers") or [])[:4]:
            pn = norm(re.sub(r",.*$", "", prov))
            hits = [l for l in ref.splitlines() if pn and pn in norm(l)]
            if hits:
                ctx_parts.insert(0, f"[provider directory for {prov}: " + " || ".join(hits[:3]) + "]")
            elif ref:
                ctx_parts.insert(0, f"[provider directory: no exact entry for {prov}]")
        # identifiers may be drawn with cipher/ligature fonts or as pictures: read them visually when they look off
        want_ident = (re.search(r"(?i)phone|MRN|record number|member id|insurance id|account number", text) or route.get("answer_kind") == "phone"
                      or (wf_text and re.search(r"(?i)record number|\bMRN\b", wf_text)))
        chart_paths = [p for p in prefetch if re.match(r"^/patients/[0-9a-z]+$", p)]
        if chart_paths:
            ctext = "\n".join(ctx_parts)
            suspicious = re.search(r"Phone:\s*\(?\s*\d\d\s+\d\d", ctext) or re.search(r"MRN:\s*\n", ctext) or "drawn as a picture" in ctext
            if want_ident or (suspicious and self.cfg.get("visual_always")):
                vis = await self.visual_read(chart_paths[0], "phone number, MRN / record number, member ID")
                ctx_parts.append(f"=== VISUAL READING of {chart_paths[0]} (screenshot transcription; trust this over the decoded text for phone numbers, MRN and IDs) ===\n{vis}")
                log("VISUAL", vis[:300].replace(chr(10), " | "))
        log(f"PREFETCH {len(prefetch)} pages {time.time()-t0:.1f}s kind={kind} wf={wf_idx}")

        sys_prompt = prompts.solver_system(self.site, self.mem, wf_text)
        user = prompts.solver_user(text, route, "\n\n".join(ctx_parts))
        msgs = [{"role": "system", "content": sys_prompt}, {"role": "user", "content": user}]
        opened = []
        model = self.cfg.get("loop_model", FAST)
        result = None
        nudged = False
        for step in range(self.cfg.get("max_steps", 7)):
            left = deadline - time.time()
            if left < 2.5:
                log("STEP budget exhausted"); break
            r = await self.llm.chat(model["model"], msgs, max_tokens=3000, tools=TOOLS, extra=model["extra"],
                                    reasoning={"effort": self.cfg.get("effort", "medium")}, timeout=min(40, left), tag=f"step{step}")
            if not r:
                break
            m = r["message"]
            calls = m.get("tool_calls") or []
            msgs.append({"role": "assistant", "content": m.get("content") or "", "tool_calls": calls} if calls else
                        {"role": "assistant", "content": m.get("content") or ""})
            if not calls:
                log("NOCALL content", (m.get("content") or "")[:300])
                if not nudged:
                    nudged = True
                    msgs.append({"role": "user", "content": "Finish by calling the answer tool with the exact final answer value (or the skip tool). Do not reply in plain text."})
                    continue
                result = parse_text_answer(m.get("content") or "")
                break
            outs = []
            final = None
            async def run(call):
                fn = call["function"]["name"]
                try: args = json.loads(call["function"].get("arguments") or "{}")
                except Exception: args = {}
                if fn == "open":
                    opened.append(args.get("path", ""))
                    return await self.tool_open(args.get("path", ""), bool(args.get("all_pages")))
                if fn == "query":
                    opened.append(args.get("path", ""))
                    return await self.tool_query(args.get("path", ""), args.get("fields") or {}, bool(args.get("all_pages")))
                if fn == "search_patients":
                    rows = await self.site.search(last_name=args.get("last_name"), dob=args.get("dob"))
                    return jdump(rows[:40], 6000) if rows else "No patients match."
                if fn == "read_document":
                    opened.append(args.get("path", ""))
                    return await self.tool_read_document(args.get("path", ""))
                return ""
            finals = [c for c in calls if c["function"]["name"] in ("answer", "skip")]
            others = [c for c in calls if c["function"]["name"] not in ("answer", "skip")]
            if finals and not others:
                c = finals[0]
                try: args = json.loads(c["function"].get("arguments") or "{}")
                except Exception: args = {}
                result = {"skip": c["function"]["name"] == "skip", **args}
                break
            log("TOOLS", jdump([(c["function"]["name"], c["function"].get("arguments")) for c in others], 600))
            res = await asyncio.gather(*[run(c) for c in others])
            for c, out in zip(others, res):
                msgs.append({"role": "tool", "tool_call_id": c["id"], "content": clip(out or "", 12000)})
            for c in finals:
                msgs.append({"role": "tool", "tool_call_id": c["id"], "content": "Ignored: call answer alone after reading the results."})
        # gate: a request about a patient must be grounded in that patient's chart
        charts = set(re.findall(r"/patients/([0-9a-z]{6,})", " ".join(prefetch + opened)))
        if result and not result.get("skip") and pats and not charts:
            log("GATE no chart opened for patient request -> skip")
            result = {"skip": True, "reason": "patient chart never opened"}
        # verification by a stronger model on workflow tasks
        if result and not result.get("skip") and wf_idx is not None and self.cfg.get("verify", True) and deadline - time.time() > 4:
            evidence = "\n\n".join(m["content"] for m in msgs[1:] if m.get("role") in ("user", "tool") and m.get("content"))
            ref = getattr(self.site, "reference", "")
            if ref: evidence = "REFERENCE DATA:\n" + ref[:14000] + "\n\n" + evidence
            vr = await self.llm.json(STRONG["model"], [{"role": "system", "content": prompts.VERIFY_SYS},
                                     {"role": "user", "content": prompts.verify_user(text, wf_text, self.mem.notes_text(), clip(evidence, 120000))}],
                                     max_tokens=6000, reasoning={"effort": self.cfg.get("verify_effort", "low")}, timeout=min(45, deadline - time.time() - 1), tag="verify")
            if vr is None and deadline - time.time() > 4:
                vr = await self.llm.json("anthropic/claude-sonnet-5.5", [{"role": "system", "content": prompts.VERIFY_SYS},
                                         {"role": "user", "content": prompts.verify_user(text, wf_text, self.mem.notes_text(), clip(evidence, 120000))}],
                                         max_tokens=6000, timeout=min(45, deadline - time.time() - 1), tag="verify2")
            log("VERIFY", jdump(vr, 400))
            a1 = str(result.get("answer", "")).strip().lower().replace(" ", "")
            a2 = str((vr or {}).get("answer", "")).strip().lower().replace(" ", "")
            if vr and a2 and a1 == a2:
                result["confidence"] = max(float(result.get("confidence") or 0), float(vr.get("confidence") or 0))
            elif vr and a2 and float(vr.get("confidence") or 0) >= 0.85:
                log("VERIFY override", a1, "->", a2)
                result = {"answer": vr["answer"], "confidence": float(vr.get("confidence")) - 0.05, "why": "verifier: " + str(vr.get("why"))}
            elif vr is None:
                result["confidence"] = float(result.get("confidence") or 0) * 0.9
            else:
                result["confidence"] = min(float(result.get("confidence") or 0), 0.5)
        # learn plan
        if result and not result.get("skip") and opened:
            pl = self.plans.setdefault(plan_key, {})
            for p in set(opened):
                ap = abstract_path(p, ids)
                pl[ap] = pl.get(ap, 0) + 1
        return result, {"route": route, "kind": kind, "wf": wf_idx, "opened": opened, "msgs": msgs}


def clip(s, n):
    s = s or ""
    return s if len(s) <= n else s[:n] + f"\n…[truncated {len(s)-n} chars]"


def parse_text_answer(s):
    from .llm import parse_json
    d = parse_json(s)
    if d and "answer" in d:
        return d
    m = re.search(r"(?im)^\s*answer\s*[:=]\s*(.+)$", s)
    if m:
        return {"answer": m.group(1).strip().strip("`"), "confidence": 0.5}
    return None
