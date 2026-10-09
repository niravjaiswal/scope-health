#!/usr/bin/env python3
"""Model benchmark for the Scope Health Speedrun agent (OpenRouter-compatible endpoint).

Usage (from project root):
  .venv/bin/python research/scripts/model_bench.py latency  --models m1,m2 --variants default,rlow --runs 3
  .venv/bin/python research/scripts/model_bench.py quality  --models m1,m2 [--variant rlow]
  .venv/bin/python research/scripts/model_bench.py json     --models m1,m2
  .venv/bin/python research/scripts/model_bench.py tools    --models m1,m2
  .venv/bin/python research/scripts/model_bench.py cache    --models m1,m2
  .venv/bin/python research/scripts/model_bench.py report   (summarise all jsonl results)

Reads LLM_API_KEY / LLM_BASE_URL from env, else from .env.dev (never prints the key).
Writes JSONL to research/bench_out/<mode>.jsonl.
"""
import argparse, json, os, sys, time, threading, statistics
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).parent))
import model_bench_data as D  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "research" / "bench_out"
OUT.mkdir(parents=True, exist_ok=True)


def load_env():
    env = dict(os.environ)
    p = ROOT / ".env.dev"
    if "LLM_API_KEY" not in env and p.exists():
        for line in p.read_text().splitlines():
            if "=" in line and not line.strip().startswith("#"):
                k, v = line.split("=", 1)
                env.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    return env["LLM_BASE_URL"].rstrip("/"), env["LLM_API_KEY"]


BASE, KEY = load_env()
HEADERS = {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}
CLIENT = httpx.Client(timeout=httpx.Timeout(120.0, connect=10.0), http2=False,
                      limits=httpx.Limits(max_connections=16, max_keepalive_connections=16))
_lock = threading.Lock()

# Request-body overlays. Merged into the body as-is.
VARIANTS = {
    "default": {},
    "rlow": {"reasoning": {"effort": "low"}},
    "rmin": {"reasoning": {"effort": "minimal"}},
    "rnone": {"reasoning": {"effort": "none"}},
    "roff": {"reasoning": {"enabled": False}},
    "rhigh": {"reasoning": {"effort": "high"}},
    "tput": {"provider": {"sort": "throughput"}},
    "lat": {"provider": {"sort": "latency"}},
    "roff_tput": {"reasoning": {"enabled": False}, "provider": {"sort": "throughput"}},
    "rlow_tput": {"reasoning": {"effort": "low"}, "provider": {"sort": "throughput"}},
    "cerebras": {"provider": {"order": ["cerebras"], "allow_fallbacks": True}},
    "groq": {"provider": {"order": ["groq"], "allow_fallbacks": True}},
    "sambanova": {"provider": {"order": ["sambanova"], "allow_fallbacks": True}},
    "cerebras_rlow": {"provider": {"order": ["cerebras"], "allow_fallbacks": True}, "reasoning": {"effort": "low"}},
    "groq_rlow": {"provider": {"order": ["groq"], "allow_fallbacks": True}, "reasoning": {"effort": "low"}},
    "rhigh_tput": {"reasoning": {"effort": "high"}, "provider": {"sort": "throughput"}},
    "rmed_tput": {"reasoning": {"effort": "medium"}, "provider": {"sort": "throughput"}},
}


def deep_merge(a, b):
    out = dict(a)
    for k, v in b.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def chart_messages(question, rules=D.RULES, chart=D.CHART):
    return [
        {"role": "system", "content": rules},
        {"role": "user", "content": f"Page text (patient chart):\n{chart}\n\nTask: {question}"},
    ]


def call(model, messages, overlay=None, max_tokens=2000, extra=None, stream=True):
    """Stream one chat completion; returns timing + usage dict. Never raises."""
    body = {"model": model, "messages": messages, "max_tokens": max_tokens, "stream": stream,
            "temperature": 0, "usage": {"include": True}}
    if overlay:
        body = deep_merge(body, overlay)
    if extra:
        body = deep_merge(body, extra)
    res = {"model": model, "overlay": overlay or {}, "ok": False}
    t0 = time.perf_counter()
    t_first = t_content = None
    content, reasoning, tool_calls = [], [], {}
    usage, provider, finish = None, None, None
    try:
        if not stream:
            r = CLIENT.post(f"{BASE}/chat/completions", headers=HEADERS, json=body)
            res["status"] = r.status_code
            j = r.json()
            if r.status_code != 200 or "error" in j:
                res["error"] = json.dumps(j.get("error", j))[:500]
                res["t_total"] = time.perf_counter() - t0
                return res
            ch = j["choices"][0]
            m = ch.get("message", {})
            content = [m.get("content") or ""]
            reasoning = [m.get("reasoning") or ""]
            for tc in m.get("tool_calls") or []:
                tool_calls[len(tool_calls)] = {"name": tc["function"]["name"], "args": tc["function"].get("arguments", "")}
            usage, provider, finish = j.get("usage"), j.get("provider"), ch.get("finish_reason")
            t_first = t_content = time.perf_counter() - t0
        else:
            with CLIENT.stream("POST", f"{BASE}/chat/completions", headers=HEADERS, json=body) as r:
                res["status"] = r.status_code
                if r.status_code != 200:
                    res["error"] = r.read().decode(errors="replace")[:500]
                    res["t_total"] = time.perf_counter() - t0
                    return res
                for line in r.iter_lines():
                    if not line or line.startswith(":"):
                        continue
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        j = json.loads(data)
                    except Exception:
                        continue
                    if "error" in j:
                        res["error"] = json.dumps(j["error"])[:500]
                        break
                    provider = j.get("provider") or provider
                    if j.get("usage"):
                        usage = j["usage"]
                    for ch in j.get("choices", []):
                        d = ch.get("delta", {}) or {}
                        now = time.perf_counter() - t0
                        rc = d.get("reasoning") or ""
                        if not rc and d.get("reasoning_details"):
                            rc = "".join((x.get("text") or x.get("summary") or "") for x in d["reasoning_details"] if isinstance(x, dict))
                        c = d.get("content") or ""
                        tcs = d.get("tool_calls") or []
                        if (rc or c or tcs) and t_first is None:
                            t_first = now
                        if (c or tcs) and t_content is None:
                            t_content = now
                        if rc:
                            reasoning.append(rc)
                        if c:
                            content.append(c)
                        for tc in tcs:
                            idx = tc.get("index", 0)
                            slot = tool_calls.setdefault(idx, {"name": "", "args": ""})
                            fn = tc.get("function") or {}
                            if fn.get("name"):
                                slot["name"] = fn["name"]
                            if fn.get("arguments"):
                                slot["args"] += fn["arguments"]
                        if ch.get("finish_reason"):
                            finish = ch["finish_reason"]
        res["ok"] = "error" not in res
    except Exception as e:  # network etc.
        res["error"] = f"{type(e).__name__}: {e}"[:500]
    res["t_total"] = time.perf_counter() - t0
    res["t_first"] = t_first
    res["t_content"] = t_content
    res["content"] = "".join(content)
    res["reasoning_chars"] = len("".join(reasoning))
    res["tool_calls"] = list(tool_calls.values())
    res["provider"] = provider
    res["finish"] = finish
    if usage:
        res["prompt_tokens"] = usage.get("prompt_tokens")
        res["completion_tokens"] = usage.get("completion_tokens")
        res["cost"] = usage.get("cost")
        res["reasoning_tokens"] = (usage.get("completion_tokens_details") or {}).get("reasoning_tokens")
        ptd = usage.get("prompt_tokens_details") or {}
        res["cached_tokens"] = ptd.get("cached_tokens")
        res["cache_write_tokens"] = ptd.get("cache_write_tokens")
    ct = res.get("completion_tokens") or 0
    if res.get("t_total") and res.get("t_first") and ct:
        gen = res["t_total"] - res["t_first"]
        res["tok_per_s"] = ct / gen if gen > 0.05 else None
    return res


def log(mode, rec):
    with _lock:
        with open(OUT / f"{mode}.jsonl", "a") as f:
            f.write(json.dumps(rec) + "\n")


def fmt(r):
    tf = r.get("t_first"); tc = r.get("t_content")
    return (f"{r['model'][:34]:34s} {r.get('variant',''):10s} {'OK ' if r.get('ok') else 'ERR'} "
            f"tot={r.get('t_total',0):5.2f}s first={tf if tf is None else round(tf,2)!s:5s} cont={tc if tc is None else round(tc,2)!s:5s} "
            f"in={r.get('prompt_tokens')} out={r.get('completion_tokens')} rsn={r.get('reasoning_tokens')} cached={r.get('cached_tokens')} "
            f"cost={r.get('cost')} prov={r.get('provider')} ans={(r.get('content') or '')[:40]!r} {('ERR:'+r.get('error','')[:160]) if r.get('error') else ''}")


# ---------------- modes ----------------

def mode_latency(models, variants, runs, workers):
    jobs = [(m, v, i) for i in range(runs) for m in models for v in variants]

    def job(x):
        m, v, i = x
        r = call(m, chart_messages(D.LATENCY_QUESTION), VARIANTS[v], max_tokens=3000)
        r.update(variant=v, run=i, correct=D.is_correct(r.get("content", ""), D.LATENCY_EXPECTED, "nvse"))
        log("latency", r)
        print(fmt(r), "CORRECT" if r["correct"] else "", flush=True)
    with ThreadPoolExecutor(workers) as ex:
        list(ex.map(job, jobs))


def mode_quality(models, variant, workers, tag=None):
    jobs = [(m, q) for m in models for q in D.QUESTIONS]

    def job(x):
        m, (qid, q, exp, kind, trap) = x
        chart = D.chart_local() if tag == "localtz" else D.CHART
        r = call(m, chart_messages(q, chart=chart), VARIANTS[variant], max_tokens=4000)
        r.update(variant=variant, qid=qid, expected=exp, correct=D.is_correct(r.get("content", ""), exp, kind), tag=tag)
        log("quality", r)
        print(fmt(r), qid, "CORRECT" if r["correct"] else f"WRONG(exp {exp})", flush=True)
    with ThreadPoolExecutor(workers) as ex:
        list(ex.map(job, jobs))


JSON_SCHEMA_RF = {
    "type": "json_schema",
    "json_schema": {
        "name": "task_answer",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {
                "answer": {"type": "string", "description": "final answer string, exactly in the requested form"},
                "confidence": {"type": "number", "description": "0..1"},
                "skip": {"type": "boolean"},
            },
            "required": ["answer", "confidence", "skip"],
            "additionalProperties": False,
        },
    },
}


def mode_json(models, variant, runs, workers):
    jobs = [(m, i) for i in range(runs) for m in models]

    def job(x):
        m, i = x
        msgs = chart_messages(D.LATENCY_QUESTION)
        msgs[0] = {"role": "system", "content": D.RULES + "\nReturn a JSON object with fields answer (string), confidence (0..1), skip (boolean)."}
        r = call(m, msgs, VARIANTS[variant], max_tokens=3000, extra={"response_format": JSON_SCHEMA_RF})
        valid = False
        ans = None
        try:
            obj = json.loads(r.get("content", ""))
            valid = isinstance(obj, dict) and set(obj) == {"answer", "confidence", "skip"} and isinstance(obj["answer"], str)
            ans = obj.get("answer")
        except Exception:
            pass
        r.update(variant=variant, run=i, json_valid=valid, correct=bool(ans) and D.is_correct(ans, D.LATENCY_EXPECTED, "nvse"))
        log("json", r)
        print(fmt(r), "VALID" if valid else "INVALID", "CORRECT" if r["correct"] else "", flush=True)
    with ThreadPoolExecutor(workers) as ex:
        list(ex.map(job, jobs))


TOOLS = [
    {"type": "function", "function": {
        "name": "open_patient_chart",
        "description": "Open a patient's chart in the clinic product and return its page text.",
        "parameters": {"type": "object", "properties": {
            "last_name": {"type": "string"}, "first_name": {"type": "string"},
            "dob": {"type": "string", "description": "YYYY-MM-DD"},
            "tab": {"type": "string", "enum": ["Summary", "Demographics", "Appointments", "Documents", "Billing", "Activity"]}},
            "required": ["last_name", "tab"], "additionalProperties": False}}},
    {"type": "function", "function": {
        "name": "submit_answer",
        "description": "Submit the final answer for the current task.",
        "parameters": {"type": "object", "properties": {"answer": {"type": "string"}},
                       "required": ["answer"], "additionalProperties": False}}},
]


def mode_tools(models, variant, runs, workers, tool_choice="required"):
    q = "Referral letter received on 2025-06-11 for patient Marisol Bennett (born 1958-03-14): which practice made the referral?"
    jobs = [(m, i) for i in range(runs) for m in models]

    def job(x):
        m, i = x
        msgs = [{"role": "system", "content": "You are a clinic back-office agent. Use the tools to look things up. Call exactly one tool now."},
                {"role": "user", "content": q}]
        r = call(m, msgs, VARIANTS[variant], max_tokens=2000, extra={"tools": TOOLS, "tool_choice": tool_choice})
        tc = r.get("tool_calls") or []
        good = False
        if tc:
            try:
                a = json.loads(tc[0]["args"] or "{}")
                good = tc[0]["name"] == "open_patient_chart" and a.get("last_name", "").lower() == "bennett" and a.get("tab") == "Documents"
            except Exception:
                pass
        r.update(variant=variant, run=i, tool_ok=good, tool_choice=tool_choice)
        log("tools", r)
        print(fmt(r), "TOOL_OK" if good else f"TOOL_BAD {tc}", flush=True)
    with ThreadPoolExecutor(workers) as ex:
        list(ex.map(job, jobs))


def big_prefix():
    # ~6-7k tokens: rules + chart + a schedule dump, so it exceeds every provider's min cacheable size.
    sched = "\n".join(
        f"SCH-{50000+i} | 2025-11-{(i % 28)+1:02d} {8 + i % 9:02d}:{(i*7) % 60:02d} | {['Northgate','Eastside','Front Range','Highline','Stonebrook'][i % 5]} | "
        f"{['Sharon Morales, MD','David Cho, DO','Elena Ruiz, NP','Priya Natarajan, MD','Thomas Greer, MD'][i % 5]} | "
        f"Patient {['Alvarez','Brooks','Chen','Dawson','Eriksen','Fischer','Garcia','Hughes'][i % 8]}, {['Ana','Ben','Cara','Dev','Eli','Fay','Gus','Hal'][(i*3) % 8]} | "
        f"{['Office visit','Annual wellness visit','Lab draw','Skin check','Cardiology follow-up'][i % 5]} | {['Completed','Scheduled','No-show','Cancelled'][i % 4]}"
        for i in range(140))
    return D.RULES + "\n\nReference page (Schedule, November 2025, all locations):\n" + sched


def mode_cache(models, workers, reps=4):
    pre = big_prefix()
    qs = [q for _, q, *_ in D.QUESTIONS][:reps]

    def run_model(m):
        anth = m.startswith("anthropic/")
        for i, q in enumerate(qs):
            if anth:
                sys_msg = {"role": "system", "content": [{"type": "text", "text": pre, "cache_control": {"type": "ephemeral"}}]}
            else:
                sys_msg = {"role": "system", "content": pre}
            msgs = [sys_msg, {"role": "user", "content": f"Page text (patient chart):\n{D.CHART}\n\nTask: {q}"}]
            # pin the provider so the cache can hit
            prov = {"provider": {"sort": "throughput"}} if not anth else {}
            r = call(m, msgs, prov, max_tokens=2000, extra={"reasoning": {"effort": "low"}} if not anth else None)
            r.update(variant="cache", run=i)
            log("cache", r)
            print(fmt(r), flush=True)
            time.sleep(1.0)
    with ThreadPoolExecutor(workers) as ex:
        list(ex.map(run_model, models))


SCRATCH = Path(os.environ.get("BENCH_SCRATCH", "/private/tmp/claude-502/-Users-nirav-development-scope-health/07543581-6db0-4558-89e6-42d589d0daa6/scratchpad"))
RUNNER = """import json, sys
ns = {}
exec(open(sys.argv[1]).read(), ns)
data = json.load(open(sys.argv[2]))
print(json.dumps(str(ns['solve'](data))))
"""


def code_questions():
    from datetime import date
    data = D.code_dataset()
    c1, c3, nve = D.code_truth(data)
    rules = D.RULES.split("---")[1].strip()
    return data, [
        ("c1_distinct_co_oct", "How many distinct patients had at least one Completed appointment at a Colorado location in October 2025 (local dates)? Return a whole number as a string.", str(c1), "int"),
        ("c2_new_est", f"Rules:\n{rules}\n\nQuestion: visit for patient P1017 with Elena Ruiz, NP on 2025-11-05. Return NEW or ESTABLISHED:YYYY-MM-DD.", nve("P1017", "Elena Ruiz, NP", date(2025, 11, 5)), "nvse"),
        ("c3_top_noshow", "Which provider had the most No-show appointments in calendar year 2025 (local dates)? Return the provider name exactly as in the data.", c3, "text"),
    ]


def mode_code(models, variant, runs, workers):
    import re, subprocess
    SCRATCH.mkdir(parents=True, exist_ok=True)
    data, qs = code_questions()
    dpath = SCRATCH / "bench_code_data.json"
    dpath.write_text(json.dumps(data))
    rpath = SCRATCH / "bench_runner.py"
    rpath.write_text(RUNNER)
    sample = {k: v[:3] for k, v in data.items()}
    jobs = [(m, q, i) for i in range(runs) for m in models for q in qs]

    def job(x):
        m, (qid, q, exp, kind), i = x
        msgs = [{"role": "system", "content": D.CODE_SYSTEM},
                {"role": "user", "content": f"Sample of data (first 3 rows of each list):\n{json.dumps(sample, indent=1)}\n\nAppointments: {len(data['appointments'])} rows total.\n\n{q}"}]
        r = call(m, msgs, VARIANTS[variant], max_tokens=6000)
        code = r.get("content") or ""
        mm = re.search(r"```(?:python)?\n(.*?)```", code, re.S)
        code = mm.group(1) if mm else code
        cpath = SCRATCH / f"bench_code_{abs(hash((m, qid, i, time.time())))}.py"
        cpath.write_text(code)
        out, err = None, None
        try:
            pr = subprocess.run([sys.executable, "-I", str(rpath), str(cpath), str(dpath)], capture_output=True, text=True, timeout=20, cwd=str(SCRATCH))
            out = json.loads(pr.stdout.strip()) if pr.returncode == 0 and pr.stdout.strip() else None
            err = pr.stderr[-300:] if pr.returncode else None
        except Exception as e:
            err = str(e)[:300]
        r.update(variant=variant, qid=qid, run=i, expected=exp, exec_out=out, exec_err=err,
                 correct=out is not None and D.is_correct(out, exp, kind))
        r["content"] = (r.get("content") or "")[:4000]
        log("code", r)
        print(fmt(r)[:200], qid, "CORRECT" if r["correct"] else f"WRONG got={out!r} exp={exp!r} err={(err or '')[-120:]!r}", flush=True)
    with ThreadPoolExecutor(workers) as ex:
        list(ex.map(job, jobs))


def mode_report():
    def load(mode):
        p = OUT / f"{mode}.jsonl"
        return [json.loads(l) for l in p.read_text().splitlines()] if p.exists() else []

    def med(xs):
        xs = [x for x in xs if x is not None]
        return round(statistics.median(xs), 2) if xs else None

    lat = load("latency")
    groups = {}
    for r in lat:
        groups.setdefault((r["model"], r.get("variant")), []).append(r)
    print("\n## latency (median over runs)")
    print("| model | variant | n ok | correct | first(s) | content(s) | total(s) | out tok | rsn tok | tok/s | $/call | providers |")
    print("|---|---|---|---|---|---|---|---|---|---|---|---|")
    for (m, v), rs in sorted(groups.items()):
        ok = [r for r in rs if r.get("ok")]
        provs = sorted({str(r.get("provider")) for r in ok})
        errs = {r.get("error", "")[:60] for r in rs if not r.get("ok")}
        print(f"| {m} | {v} | {len(ok)}/{len(rs)} | {sum(r.get('correct', False) for r in ok)} | {med([r.get('t_first') for r in ok])} | "
              f"{med([r.get('t_content') for r in ok])} | {med([r.get('t_total') for r in ok])} | {med([r.get('completion_tokens') for r in ok])} | "
              f"{med([r.get('reasoning_tokens') for r in ok])} | {med([r.get('tok_per_s') for r in ok])} | "
              f"{med([r.get('cost') for r in ok]) if ok else None} | {','.join(provs)}{' ERR:'+';'.join(errs) if errs else ''} |")
    q = load("quality")
    if q:
        print("\n## quality")
        qg = {}
        for r in q:
            qg.setdefault((r["model"], r.get("variant"), r.get("tag")), []).append(r)
        qids = [x[0] for x in D.QUESTIONS]
        print("| model | variant | score | " + " | ".join(qids) + " | med total(s) | sum $ |")
        print("|---|---|---|" + "---|" * len(qids) + "---|---|")
        for (m, v, t), rs in sorted(qg.items(), key=lambda kv: str(kv[0])):
            byq = {r["qid"]: r for r in rs}
            cells = []
            for qid in qids:
                r = byq.get(qid)
                cells.append("-" if not r else ("Y" if r["correct"] else f"N:{(r.get('content') or r.get('error','ERR'))[:24]!s}".replace("|", "/").replace("\n", " ")))
            print(f"| {m} | {v}{'/'+t if t else ''} | {sum(r['correct'] for r in rs)}/{len(rs)} | " + " | ".join(cells) +
                  f" | {med([r.get('t_total') for r in rs])} | {round(sum(r.get('cost') or 0 for r in rs), 4)} |")
    for mode in ("json", "tools", "cache"):
        rs = load(mode)
        if not rs:
            continue
        print(f"\n## {mode}")
        for r in rs:
            print("  ", fmt(r), r.get("json_valid", ""), r.get("tool_ok", ""), r.get("correct", ""))
    tot = sum((r.get("cost") or 0) for mode in ("latency", "quality", "json", "tools", "cache", "code", "probe") for r in load(mode))
    print(f"\nTotal measured spend: ${tot:.4f}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["latency", "quality", "json", "tools", "cache", "code", "report"])
    ap.add_argument("--models", default="")
    ap.add_argument("--variants", default="default")
    ap.add_argument("--variant", default="default")
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--tag", default=None)
    ap.add_argument("--tool-choice", dest="tool_choice", default="required")
    a = ap.parse_args()
    models = [m for m in a.models.split(",") if m]
    if a.mode == "latency":
        mode_latency(models, a.variants.split(","), a.runs, a.workers)
    elif a.mode == "quality":
        mode_quality(models, a.variant, a.workers, a.tag)
    elif a.mode == "json":
        mode_json(models, a.variant, a.runs, a.workers)
    elif a.mode == "tools":
        mode_tools(models, a.variant, a.runs, a.workers, a.tool_choice)
    elif a.mode == "cache":
        mode_cache(models, a.workers)
    elif a.mode == "code":
        mode_code(models, a.variant, a.runs, a.workers)
    else:
        mode_report()


if __name__ == "__main__":
    main()
