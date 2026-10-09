"""Task solver: router -> entity resolution -> prefetch -> LLM tool loop -> validation."""
import asyncio, json, re, time, unicodedata
from .util import log, jdump, now
from . import prompts

FAST = {"model": "openai/gpt-oss-120b", "extra": {"provider": {"sort": "throughput"}}}
STRONG = {"model": "openai/gpt-6.1-sol", "extra": {}}

TOOLS = [
    {"type": "function", "function": {
        "name": "open", "description": "Open one or several Wrenfield pages (e.g. /patients/abc123/notes, or several document viewer pages at once via paths=[...]) and return their decoded text. "
        "Document viewer pages include the document's decoded content. Set all_pages=true to also read every further page of a paginated list (slower). "
        "Always batch: if you will need several pages or documents, pass them all in paths in ONE call.",
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string"}, "paths": {"type": "array", "items": {"type": "string"}}, "all_pages": {"type": "boolean"}}}}},
    {"type": "function", "function": {
        "name": "search_patients", "description": "Search patients by last name (prefix ok) OR by date of birth YYYY-MM-DD. Returns matching rows with chart links and flags.",
        "parameters": {"type": "object", "properties": {
            "last_name": {"type": "string"}, "dob": {"type": "string"}}}}},
    {"type": "function", "function": {
        "name": "query", "description": "Open a page, set form fields (filters/search boxes/selects, by field name or label as listed in the SITE MAP) and submit; returns the resulting page text (all pages if all_pages=true). Use for filtered lists (appointment list by provider/status/location/date range, invoice search, document type filters, note search, etc.).",
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string"}, "fields": {"type": "object", "description": "field name or label -> value (for selects use the option text)"},
            "submit": {"type": "string", "description": "text of the button to press after filling (e.g. 'Open' next to 'Find invoice', 'Apply filters', 'Search', 'Show appointments'); default: the page's main filter/search button"},
            "all_pages": {"type": "boolean"}}, "required": ["path", "fields"]}}},
    {"type": "function", "function": {
        "name": "table_compute", "description": "For counting/aggregating over a list: loads ALL rows of the list at path (optionally after setting filter fields and pressing submit), across all pages, as `rows` = list of dicts keyed by the table's column headers (plus '_links'), then evaluates your Python expression `code` over `rows` and returns the result. Use it instead of counting by eye. Available: rows, re, Counter, defaultdict, datetime. Example code: len({r['Patient'] for r in rows if r['Status']=='Completed' and 'Test record' not in r['Patient'] and 'Deleted' not in r['Patient']})",
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string"}, "fields": {"type": "object"}, "submit": {"type": "string"}, "code": {"type": "string"}},
            "required": ["path", "code"]}}},
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
        self.trust = {}       # plan_key -> verifier agreement record
        self.replays = {}     # plan_key -> [(tool, templated args)]
        self.taught = {}
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
            rows = await self.site.find_patient(last, first, dob)
            if not match(rows) and " " in last:
                rows = await self.site.find_patient(last.split()[-1], first, dob)
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

    async def exec_tool(self, fn, args, opened):
        if fn == "open":
            ps = [p for p in ([args.get("path")] if args.get("path") else []) + list(args.get("paths") or []) if p][:8]
            opened.extend(ps)
            outs = await asyncio.gather(*[self.tool_open(p, bool(args.get("all_pages"))) for p in ps])
            if len(ps) == 1: return outs[0]
            return "\n\n".join(f"=== PAGE {p} ===\n{clip(o, 9000)}" for p, o in zip(ps, outs))
        if fn == "query":
            path = (args.get("path") or "/").strip()
            if not path.startswith("/"): path = "/" + path
            opened.append(path)
            return await self.site.query(path, args.get("fields") or {}, bool(args.get("all_pages")), args.get("submit"))
        if fn == "search_patients":
            if args.get("last_name") and not args.get("dob"):
                rows = await self.site.find_patient(args.get("last_name"))
            else:
                rows = await self.site.search(last_name=args.get("last_name"), dob=args.get("dob"))
            return jdump(rows[:40], 6000) if rows else "No patients match."
        if fn == "read_document":
            opened.append(args.get("path", ""))
            return await self.tool_read_document(args.get("path", ""))
        if fn == "table_compute":
            path = (args.get("path") or "/").strip()
            if not path.startswith("/"): path = "/" + path
            opened.append(path)
            try:
                rows, notes = await self.site.table_rows(path, args.get("fields") or None, args.get("submit"))
            except Exception as e:
                return f"ERROR loading rows: {e!r}"[:300]
            hdrs = list(rows[0].keys()) if rows else []
            res = safe_eval(args.get("code") or "len(rows)", rows)
            return f"rows loaded: {len(rows)}; columns: {hdrs}; page notes: {notes[-2:]}\nfirst rows: {jdump(rows[:3], 900)}\nRESULT: {res}"
        return ""

    @staticmethod
    def entities(route, ids, text=""):
        ents = {}
        tdates = re.findall(r"\b(\d{4}-\d{2}-\d{2})\b", text or "")
        if ids.get("pid"): ents["pid"] = ids["pid"]
        pats = route.get("patients") or []
        if pats:
            p = pats[0]
            if p.get("last"): ents["last"] = p["last"]
            if p.get("first"): ents["first"] = p["first"]
            d = dob_iso(p.get("dob") or "")
            if d:
                ents["dob"] = d
                ents["dobus"] = f"{d[5:7]}/{d[8:10]}/{d[0:4]}"
        dob = ents.get("dob")
        dl = [d for d in tdates if d != dob] or [d for d in (route.get("dates") or []) if re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(d))]
        for i, d in enumerate(dl[:3]):
            ents[f"date{i}"] = d
            ents[f"dateus{i}"] = f"{d[5:7]}/{d[8:10]}/{d[0:4]}"
        for i, x in enumerate((route.get("ids") or [])[:3]):
            if str(x).strip(): ents[f"id{i}"] = str(x).strip()
        for i, x in enumerate((route.get("providers") or [])[:2]):
            ents[f"prov{i}"] = re.sub(r",.*$", "", str(x)).strip()
        for i, x in enumerate((route.get("locations") or [])[:2]):
            ents[f"loc{i}"] = str(x).strip()
        return {k: v for k, v in ents.items() if v and len(str(v)) >= 2}

    @staticmethod
    def templatize(obj, ents):
        items = sorted(ents.items(), key=lambda kv: -len(str(kv[1])))
        def t(x):
            if isinstance(x, str):
                for k, v in items:
                    x = x.replace(str(v), "{" + k + "}")
                return x
            if isinstance(x, dict): return {kk: t(vv) for kk, vv in x.items()}
            if isinstance(x, list): return [t(vv) for vv in x]
            return x
        return t(obj)

    @staticmethod
    def fill(obj, ents):
        bad = [False]
        def f(x):
            if isinstance(x, str):
                for k, v in ents.items():
                    x = x.replace("{" + k + "}", str(v))
                if re.search(r"\{[a-z]+\d?\}", x): bad[0] = True
                return x
            if isinstance(x, dict): return {kk: f(vv) for kk, vv in x.items()}
            if isinstance(x, list): return [f(vv) for vv in x]
            return x
        out = f(obj)
        return None if bad[0] else out

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
        from .memory import lexical_match, answer_formats
        lex = lexical_match(self.mem, text)
        if set(lex) - ok:
            log(f"LEXICAL adds workflows {sorted(set(lex) - ok)} (router gave {sorted(ok)})")
        ok |= set(lex)
        wfs = sorted(ok)
        wf_idx = wfs[0] if wfs else None
        route["workflow"] = wf_idx
        wf_text = self.mem.workflows_text(wfs) if wfs else None
        try:
            from .stats import KSTATS
            if KSTATS.should_skip(KSTATS.key(route)):
                log(f"PRESSURE skip kind={KSTATS.key(route)} pace={KSTATS.pace:.1f}")
                return {"skip": True, "reason": "time pressure"}, {"route": route, "kind": route.get("kind"), "wf": route.get("workflow"), "opened": [], "msgs": []}
            f = KSTATS.budget_factor(KSTATS.key(route))
            if f < 1.0:
                new_deadline = t0 + max(2.5, (deadline - t0) * f)
                log(f"FAILFAST kind={KSTATS.key(route)} factor={f} budget {deadline-t0:.1f}->{new_deadline-t0:.1f}")
                deadline = new_deadline
        except Exception as e:
            log("failfast err", repr(e)[:100])
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
                capped = len(rows) >= 90
                ctx_parts.append(f"[patient search for {jdump(p)}: no exact match" + ("; the name search is CAPPED (too many patients with this last name), so locate the record through its own section with filters instead: e.g. Documents filtered by type and received date, Claims by date of service, Billing 'Find invoice' + Open, appointment list by date, then follow the patient link" if capped else "") + f". Search rows: {jdump(rows[:8], 1500)}]")
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
        asks_ident = bool(re.search(r"(?i)phone|MRN|record number|member id|insurance id|account number", text) or route.get("answer_kind") == "phone")
        rule_ident = bool(wf_text and re.search(r"(?i)record number|\bMRN\b", wf_text))
        chart_paths = [p for p in prefetch if re.match(r"^/patients/[0-9a-z]+$", p)]
        vis_task = None
        if chart_paths and (asks_ident or rule_ident):
            vis_task = asyncio.ensure_future(self.visual_read(chart_paths[0], "phone number, MRN / record number, member ID"))
        if prefetch:
            texts = await self.site.pages(prefetch)
            for pth, tx in zip(prefetch, texts):
                ctx_parts.append(f"=== PAGE {pth} ===\n{clip(tx, 9000)}")
        # provider facts (specialty, id, status), made salient
        from .reference import provider_info
        ref = getattr(self.site, "reference", "") or ""
        provs = (route.get("providers") or [])[:4]
        infos = await asyncio.gather(*[provider_info(self.site, pv) for pv in provs], return_exceptions=True)
        for prov, info in zip(provs, infos):
            pn = norm(re.sub(r",.*$", "", prov))
            hits = [l for l in ref.splitlines() if pn and pn in norm(l)]
            line = info if isinstance(info, str) else (" || ".join(hits[:2]) if hits else None)
            ctx_parts.insert(0, f"[provider directory for {prov}: {line}]" if line else f"[provider directory: no entry found for {prov}]")
        # identifiers may be drawn with cipher/ligature fonts or as pictures: visual reading (started above) as cross-check
        if vis_task is not None and asks_ident:
            try:
                vis = await asyncio.wait_for(vis_task, timeout=max(1.0, min(8, deadline - time.time() - 3)))
                ctx_parts.append(f"=== VISUAL READING of {chart_paths[0]} (screenshot transcription; if it disagrees with the decoded text on phone numbers, MRN or IDs, trust the visual reading) ===\n{vis}")
                log("VISUAL", vis[:300].replace(chr(10), " | "))
            except Exception as e:
                log("VISUAL failed", repr(e)[:100])
            vis_task = None
        log(f"PREFETCH {len(prefetch)} pages {time.time()-t0:.1f}s kind={kind} wf={wf_idx}")

        # replay the tool calls that solved earlier tasks of this kind, with this task's entities
        ents = self.entities(route, ids, text)
        calls_log = []
        replay_opened = []
        tmpl = self.replays.get(plan_key) or []
        todo = []
        for fn, targs in tmpl:
            a = self.fill(targs, ents)
            if a is None: continue
            blob = json.dumps(a)
            if re.search(r"/[0-9a-z]{10}(?=[/?\"]|$)", blob.replace(ents.get("pid", "@@"), "")):
                continue   # depends on an id discovered at run time
            todo.append((fn, a))
        todo = todo[:6]
        if todo and deadline - time.time() > 4:
            t1 = time.time()
            outs = await asyncio.gather(*[self.exec_tool(fn, a, replay_opened) for fn, a in todo], return_exceptions=True)
            for (fn, a), o in zip(todo, outs):
                if isinstance(o, Exception): continue
                ctx_parts.append(f"=== {fn} {json.dumps(a, ensure_ascii=False)} (pre-fetched) ===\n{clip(o or '', 9000)}")
                calls_log.append((fn, a))
            log(f"REPLAY {plan_key} {len(todo)} calls {time.time()-t1:.1f}s")

        sys_prompt = prompts.solver_system(self.site, self.mem, wf_text)
        user = prompts.solver_user(text, route, "\n\n".join(ctx_parts))
        msgs = [{"role": "system", "content": sys_prompt}, {"role": "user", "content": user}]
        opened = []
        model = self.cfg.get("loop_model", FAST)
        teacher = wf_idx is not None and not tmpl and self.cfg.get("teacher", True) and self.taught.get(plan_key, 0) < 2
        if teacher:
            self.taught[plan_key] = self.taught.get(plan_key, 0) + 1
            model = {"model": STRONG["model"], "extra": {}}
            deadline = min(deadline + self.cfg.get("teacher_bonus", 8), t0 + 40)
            log(f"TEACHER mode for {plan_key}")
        result = None
        nudged = False
        for step in range(self.cfg.get("max_steps", 7)):
            left = deadline - time.time()
            if left < 2.5:
                log("STEP budget exhausted"); break
            r = await self.llm.chat(model["model"], msgs, max_tokens=3000, tools=TOOLS, extra=model["extra"],
                                    reasoning={"effort": "low" if teacher else self.cfg.get("effort", "medium")}, timeout=min(40, left), tag=f"step{step}")
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
                calls_log.append((fn, args))
                return await self.exec_tool(fn, args, opened)
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
            if vis_task is not None and vis_task.done():
                try:
                    vis = vis_task.result()
                    res = list(res); res[-1] = (res[-1] or "") + f"\n\n=== VISUAL READING of the chart header (screenshot; trust it for MRN / record number) ===\n{vis}"
                    log("VISUAL(async)", vis[:200].replace(chr(10), " | "))
                except Exception:
                    pass
                vis_task = None
            for c, out in zip(others, res):
                msgs.append({"role": "tool", "tool_call_id": c["id"], "content": clip(out or "", 12000)})
            for c in finals:
                msgs.append({"role": "tool", "tool_call_id": c["id"], "content": "Ignored: call answer alone after reading the results."})
        # format gate: rule-governed answers must match one of the rule's answer forms
        if result and not result.get("skip") and wfs:
            fpats, fexs = answer_formats(self.mem, wfs)
            def fmt_ok(a):
                return not fpats or any(p.match(str(a).strip()) for p in fpats)
            if not fmt_ok(result.get("answer", "")):
                log("FORMAT bad answer", repr(result.get("answer"))[:80])
                if deadline - time.time() > 3:
                    msgs.append({"role": "user", "content": f"Your answer {result.get('answer')!r} is not in a required form. Allowed forms (from the rule): {', '.join(dict.fromkeys(fexs))[:600]}. Call answer again with the value in exactly one of these forms (or skip)."})
                    r = await self.llm.chat(model["model"], msgs, max_tokens=2000, tools=TOOLS, extra=model["extra"], reasoning={"effort": "low"}, timeout=max(2, deadline - time.time() - 1), tag="reformat")
                    calls = ((r or {}).get("message") or {}).get("tool_calls") or []
                    fin = [c for c in calls if c["function"]["name"] == "answer"]
                    if fin:
                        try:
                            a2 = json.loads(fin[0]["function"].get("arguments") or "{}")
                            if fmt_ok(a2.get("answer", "")):
                                result = {**result, **a2}
                                log("FORMAT fixed ->", a2.get("answer"))
                        except Exception:
                            pass
                if not fmt_ok(result.get("answer", "")):
                    result = {"skip": True, "reason": f"answer not in required format: {result.get('answer')!r}"}
        # gate: a request about a patient must be grounded in that patient's chart
        charts = set(re.findall(r"/patients/([0-9a-z]{6,})", " ".join(prefetch + opened)))
        if result and not result.get("skip") and pats and not charts:
            log("GATE no chart opened for patient request -> skip")
            result = {"skip": True, "reason": "patient chart never opened"}
        # verification by a stronger model on workflow tasks (skipped once the loop has earned trust on this workflow)
        trust = self.trust.setdefault(plan_key, {"agree": 0, "disagree": 0, "skipped": 0})
        trusted = trust["agree"] >= 3 and trust["disagree"] == 0 and trust["skipped"] < 3
        if result and not result.get("skip") and wf_idx is not None and trusted:
            trust["skipped"] += 1
            log(f"VERIFY skipped (trusted {plan_key}: {trust})")
        if result and not result.get("skip") and wf_idx is not None and self.cfg.get("verify", True) and deadline - time.time() > 4 and not trusted:
            trust["skipped"] = 0
            evidence = "\n\n".join(m["content"] for m in msgs[1:] if m.get("role") in ("user", "tool") and m.get("content"))
            if vis_task is not None:
                try:
                    vis = await asyncio.wait_for(asyncio.shield(vis_task), timeout=max(0.5, min(3, deadline - time.time() - 4)))
                    evidence += "\n\n=== VISUAL READING of the chart header (screenshot; trust it for MRN / record number) ===\n" + vis
                except Exception:
                    pass
            ref = getattr(self.site, "reference", "")
            if ref: evidence = "REFERENCE DATA:\n" + ref[:14000] + "\n\n" + evidence
            vmsgs = [{"role": "system", "content": prompts.VERIFY_SYS},
                     {"role": "user", "content": prompts.verify_user(text, wf_text, self.mem.notes_text(), clip(evidence, 120000))}]
            vt = max(3.0, min(40, deadline - time.time() - 0.5))
            tasks = [asyncio.ensure_future(self.llm.json(STRONG["model"], vmsgs, max_tokens=6000, reasoning={"effort": self.cfg.get("verify_effort", "low")}, timeout=vt, retries=1, tag="verify")),
                     asyncio.ensure_future(self.llm.json("anthropic/claude-haiku-5.5", vmsgs, max_tokens=6000, timeout=vt, retries=1, extra={"provider": {"sort": "latency"}}, tag="verify2"))]
            nrm = lambda x: re.sub(r"[.\s`'\"]+$", "", str(x or "").strip().lower().replace(" ", ""))
            a1 = nrm(result.get("answer"))
            strong_r, weak_r = "pending", "pending"
            try:
                for fut in asyncio.as_completed(tasks, timeout=vt + 0.5):
                    try:
                        r_ = await fut
                    except Exception:
                        r_ = None
                    if tasks[0].done() and strong_r == "pending":
                        try: strong_r = tasks[0].result()
                        except Exception: strong_r = None
                    if tasks[1].done() and weak_r == "pending":
                        try: weak_r = tasks[1].result()
                        except Exception: weak_r = None
                    if strong_r != "pending" and strong_r is not None:
                        break   # the strong verifier decides
                    if strong_r is None and weak_r != "pending":
                        break
            except asyncio.TimeoutError:
                pass
            for t_ in tasks:
                if not t_.done(): t_.cancel()
            if strong_r == "pending": strong_r = None
            if weak_r == "pending": weak_r = None
            log("VERIFY strong:", jdump(strong_r, 400), "weak:", jdump(weak_r, 200))
            sa = nrm((strong_r or {}).get("answer")) if strong_r else None
            wa = nrm((weak_r or {}).get("answer")) if weak_r else None
            if strong_r is not None:
                if sa and sa == a1:
                    trust["agree"] += 1
                    result["confidence"] = max(float(result.get("confidence") or 0), float(strong_r.get("confidence") or 0))
                elif sa and wa and sa == wa and float(strong_r.get("confidence") or 0) >= 0.8:
                    trust["disagree"] += 1
                    log("VERIFY override (strong+weak agree)", a1, "->", sa)
                    result = {"answer": strong_r["answer"], "confidence": float(strong_r.get("confidence") or 0) - 0.05, "why": "verifier: " + str(strong_r.get("why"))}
                else:
                    trust["disagree"] += 1
                    result["confidence"] = min(float(result.get("confidence") or 0), 0.5)
            elif weak_r is not None:
                if wa and wa == a1:
                    result["confidence"] = min(float(result.get("confidence") or 0), 0.9)
                else:
                    result["confidence"] = min(float(result.get("confidence") or 0), 0.5)
            else:
                result["confidence"] = float(result.get("confidence") or 0) * 0.9
        # learn a replay template from the calls that led to an accepted answer
        try:
            if result and not result.get("skip") and float(result.get("confidence") or 0) >= 0.75 and calls_log:
                seen = set(); tl = []
                for fn, a in calls_log:
                    ta = self.templatize(a, ents)
                    k = fn + json.dumps(ta, sort_keys=True)
                    if k in seen: continue
                    seen.add(k); tl.append((fn, ta))
                old = self.replays.get(plan_key) or []
                merged = old + [x for x in tl if fn_key(x) not in {fn_key(y) for y in old}]
                self.replays[plan_key] = merged[-8:]
                log(f"LEARN {plan_key}: {jdump(self.replays[plan_key], 500)}")
        except Exception as e:
            log("learn err", repr(e)[:150])
        # learn plan
        if result and not result.get("skip") and opened:
            pl = self.plans.setdefault(plan_key, {})
            for p in set(opened):
                ap = abstract_path(p, ids)
                pl[ap] = pl.get(ap, 0) + 1
        return result, {"route": route, "kind": kind, "wf": wf_idx, "opened": opened, "msgs": msgs}


def safe_eval(code, rows):
    import collections, datetime
    env = {"rows": rows, "re": re, "Counter": collections.Counter, "defaultdict": collections.defaultdict,
           "datetime": datetime, "len": len, "set": set, "sorted": sorted, "sum": sum, "min": min, "max": max,
           "any": any, "all": all, "list": list, "dict": dict, "str": str, "int": int, "float": float, "abs": abs,
           "round": round, "enumerate": enumerate, "zip": zip, "range": range, "tuple": tuple, "print": print}
    try:
        try:
            out = eval(code, {"__builtins__": {}}, env)
        except SyntaxError:
            loc = dict(env)
            exec(code, {"__builtins__": {}}, loc)
            out = loc.get("result", loc.get("answer"))
        return repr(out)[:3000]
    except Exception as e:
        return f"ERROR in code: {e!r}"[:500]


def fn_key(x):
    return x[0] + json.dumps(x[1], sort_keys=True)


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
