# 20 — Model benchmark (OpenRouter, Oct 8 2026)

Script: `research/scripts/model_bench.py` (+ `model_bench_data.py` with the made-up chart, the questions and the ground truth).
Raw results: `research/bench_out/{latency,quality,json,tools,cache,code,probe}.jsonl`. Model and endpoint lists: `research/bench_out/models.json`, `endpoints.json`.
To rebuild the tables: `.venv/bin/python research/scripts/model_bench.py report`. Total spend on this benchmark: about $1.22.

All latencies were measured from a dev Mac to openrouter.ai, streaming, `temperature: 0`. The prompt is about 2.1k tokens (OpenAI tokenizer) or 3.3k (Anthropic tokenizer): a rules message plus a made-up patient chart (demographics, 15 appointments in UTC, 12 documents, billing, activity). The answer is short. On the judge, the proxy adds a small hop.

## TL;DR — what to use

| Role | Pick | Request overlay | Expected time | $/call (2–3k-token prompt) | Accuracy seen |
|---|---|---|---|---|---|
| **(a) Fast router / extractor** | `openai/gpt-oss-120b` on **Cerebras** | `"reasoning":{"effort":"low"}` (use `"high"` for rule tasks), `"provider":{"sort":"throughput"}` | **0.5–0.8 s** low; **~1.0 s (max 2 s)** high | $0.0010 low / $0.0021 high | low: 25/32 on raw UTC chart. high: 8/8 with times already local, 7/8 on raw UTC |
| (a) Fallback | same model on **Groq** (`"provider":{"order":["cerebras","groq"],"allow_fallbacks":false}`) or `openai/gpt-6-luna` | — | 1.3 s (Groq); ~3 s (luna) | $0.0006; $0.0001–0.0003 | luna 23/24 |
| **(b) Reasoner** for hard rule tasks | `openai/gpt-6.1-sol` | `"reasoning":{"effort":"low"}` | **median 2.3–2.5 s**, p90 5 s (one 33 s outlier) | $0.0006 with an implicit cache hit, $0.0055 cold | **23/23** quality, 3/3 JSON, 7/7 code |
| (b) Fallback reasoner | `anthropic/claude-haiku-5.5` (new Oct 7, $0.10/$0.50) | none (adaptive thinking about 800 tokens); add `response_format` json_schema so reasoning cannot leak into the answer | 2.7–4 s, **tightest tail** (max 3.8 s on quality) | $0.0006–0.0007 | 23/24 (the miss was reasoning text leaking into a plain-text answer) |
| (b) Heavy / tie-break | `anthropic/claude-sonnet-5.5` | `"provider":{"sort":"throughput"}` (routes to Google Vertex, a bit faster) | 4.4–6.3 s | $0.011 cold, about $0.0035 for the cached part | 8/8, 3/3 JSON, 6/6 code |
| **(c) Code-writer** (Python over crawled data) | `openai/gpt-6.1-sol` (low) | as (b) | median 3.4 s | $0.003 | 7/7 executed correctly |
| (c) Cheap code-writer | `anthropic/claude-haiku-5.5` or `deepseek/deepseek-v4.1-flash` (low + throughput sort) | — | 4.0 s / 2.6 s (deepseek max 16 s) | $0.0006 / $0.0010 | 6/6, 6/6 |

**Budget check** ($0.03 and 4 s per task): a gpt-oss-120b@Cerebras extraction (~$0.002) plus one gpt-6.1-sol reasoning call (~$0.001–0.006) fits easily, roughly 5–10× under budget. The binding limit is **latency**, not dollars.

## Findings that change how we build the agent

1. **Provider routing matters more than model choice for open-weight models.** With default routing, `openai/gpt-oss-120b` landed on CoreWeave, DeepInfra, Phala or DekaLLM and took **9–31 s**. With `provider.sort = "throughput"` it went to Cerebras and took **0.5 s**. Each of `:nitro`, `{"sort":"throughput"}`, `{"sort":{"by":"throughput","partition":"none"}}` and `{"order":["cerebras",...]}` routed to Cerebras. `{"sort":"latency"}`, `{"only":["cerebras","groq"]}` and `{"preferred_min_throughput":300}` all picked **Groq** (1.2–1.3 s).
2. **Our key enforces ZDR (zero data retention).** Endpoints that are not ZDR are removed:
   - `qwen/qwen3.8-flash` and `qwen/qwen3.7-flash` (Alibaba-only) → 404 "0 endpoints … ZDR violation".
   - `qwen/qwen3.8-27b` with `order:["cerebras"], allow_fallbacks:true` **quietly fell back to Wafer and took 75–135 s**.
   - Lesson: when you pin a provider, use `allow_fallbacks:false` with an explicit list of fast providers, and put the fallback at the model level (`"models":[...]` or our own hedge). The judge's key may have the same policy. Do not depend on a model that has only one provider.
3. **Reasoning cannot be turned off on the new frontier models.** `reasoning.effort:"none"` or `enabled:false` → 400 `"Reasoning is mandatory for this endpoint and cannot be disabled."` on gpt-6.1-sol, claude-sonnet-5.5, grok-4.7 and gemini-3.5-flash-lite. `"minimal"` is accepted. On gpt-6-luna, deepseek-v4.1-flash and mimo, turning reasoning off is accepted, and **every** non-reasoning run answered the date-window question wrong (0/12), though in 0.3–1 s. **Date-window rules need thinking tokens**, or code.
4. **Do the timezone conversion in code, not in the model.** The trap where a UTC timestamp falls on a different local date (q7: count of 2024 visits, UTC gives 3, local gives 4) was missed by gpt-oss-120b, gpt-5.6-luna, gpt-6-sol, gpt-6-luna (1 of 3 runs) and glm. When we give the model a **local-time** table (`--tag localtz`), gpt-5.6-luna, gpt-6-luna, haiku-5.5 and gpt-oss-120b(high) all score 8/8. Plan: the crawler converts every appointment timestamp to `YYYY-MM-DD HH:MM TZ` local time at the location's state (KS = Central, CO = Mountain) before any LLM sees it.
5. **Tail latency is real. Hedge.** Outliers seen:
   - gemini-3.8-flash hung for **125 s** with no output (one of 4 cache runs) and had a 19.9 s run.
   - gpt-6.1-sol had 32.8 s, and one 123 s stall mid-stream.
   - glm-5.3-flashx had 32 s; deepseek had 16 s.
   - gpt-6.1-sol also returned **429 "temporarily rate-limited upstream"** about 3 times in about 60 calls.

   The client needs a soft deadline (e.g. 4–6 s): then fire the same prompt at a second model or provider and take the first valid answer. Also retry once on 429/5xx. Claude haiku-5.5 and gpt-oss@Cerebras had the tightest tails.
6. **Answer format leaks.** In plain-text mode, claude-haiku-5.5 sometimes writes its reasoning into `content` (1/24). Claude with `reasoning.effort` low or minimal turns off thinking and writes chain-of-thought into `content`. The same happens with `enabled:false` on haiku. With `response_format` json_schema, all 10 models tested gave **30/30 valid JSON**. Use json_schema (`{"answer","confidence","skip"}`) for the final answer, or parse the last line.
7. **Prompt caching:**
   - OpenAI models (Azure): **implicit**. The 2nd call cached 5518 of 7263 tokens; gpt-6.1-sol went from $0.0186 to $0.0053 per call. In short runs, the 2k prompt was cached at 2062 tokens.
   - Anthropic: **explicit `cache_control`** on the system block. 9113 tokens were written once, then read on every later call: haiku $0.00168 → $0.00071, sonnet $0.032 → $0.0098.
   - Implicit caching also worked on DeepSeek (7168 cached, $0.0042 → $0.0017–0.0021) and GLM (7488 cached, $0.0029 → $0.0008–0.0010).
   - Cerebras gpt-oss shows cached tokens but charges the same price.
   - Gemini 3.8 showed **0 cached** tokens.
   - **Caching did not noticeably cut latency** (only ±0.5 s). It is a cost lever only. Keep the long, stable prefix (rules, messages, site map) first and the task last.
8. **Tool calling:**
   - `tool_choice:"required"` works on gpt-oss, gpt-6-luna, gpt-5.6-luna, gpt-6.1-sol, gemini, deepseek, glm and haiku-5.5. Correct args in 0.3–4 s; gpt-oss(Cerebras) was fastest at 0.28 s, but in 3/3 runs it chose tab "Summary" instead of "Documents".
   - **claude-sonnet-5.5 rejects forced tool choice:** 400 `tool_choice: type "tool" and "any" are not supported for this model`. Use `"auto"`: then sonnet and haiku answer in about 1.2 s.
9. **Tokenizer:** Anthropic models count the same prompt as **3315 tokens, against 2065 for OpenAI** (×1.6). Use this when comparing $/Mtok.
10. Models that did badly on our task:
    - `google/gemini-3.5-flash-lite`: does not think by default; 0.8 s but 5/16.
    - `nvidia/nemotron-3.5-lightning`, `openai/gpt-oss-20b`, `mercury-2.5` (low): wrong.
    - `x-ai/grok-4.7`: 15–45 s, $0.011–0.029.
    - `minimax-m2.7`@Groq: burned 3000 reasoning tokens and returned an empty answer in 2/3 runs.
    - `mimo-v2.6-flash`: 7–15 s with low reasoning.

## Candidate list (prices per Mtok, input/output; cache-read price in brackets)

| Model | $ in / out (cache) | ctx | Providers (ZDR-usable ones we were served by) |
|---|---|---|---|
| anthropic/claude-haiku-5.5 (2026-10-07) | 0.10 / 0.50 (0.01) | 1M | Claude Platform on AWS, Google Vertex, Azure, Anthropic, Bedrock |
| anthropic/claude-sonnet-5.5 (2026-09-28) | 2 / 10 (0.10) | 1M | same |
| anthropic/claude-opus-5.5 | 4 / 20 | — | same (6.9 s, $0.019 — too slow and expensive) |
| openai/gpt-6.1-sol (2026-09-29) | 2 / 10 (0.10) | 1.05M | Azure, OpenAI, Bedrock; `openai/fast` tag $4/$20 |
| openai/gpt-6-sol | 2 / 10 (0.20) | 1.05M | Azure, OpenAI |
| openai/gpt-6-luna (2026-09-22) | 0.10 / 0.50 (0.01) | 1.05M | Azure, OpenAI, Bedrock |
| openai/gpt-5.6-luna | 0.20 / 1.20 (0.02) | 1.05M | Azure, OpenAI, Bedrock |
| openai/gpt-oss-120b | 0.037 / 0.17 base; **Cerebras 0.35 / 0.75**, Groq 0.15 / 0.60 | 131k | Cerebras (~740–1280 tok/s), Groq (~320–750), SambaNova, Nebius, Bedrock … |
| google/gemini-3.8-flash | 0.75 / 3.75 (0.075) | 1M | Google AI Studio / Vertex |
| google/gemini-3.5-flash-lite | 0.30 / 2.50 | 1M | Google |
| deepseek/deepseek-v4.1-flash | 0.30 / 1.20 list (providers from 0.012 / 1.2) | 1M | Together, DekaLLM, Fireworks … |
| z-ai/glm-5.3-flashx | 0.37 / 1.25 | 1M | Z.AI |
| x-ai/grok-4.7 | 2 / 6 | 500k | xAI |
| qwen/qwen3.8-flash, qwen3.7-flash, qwen3.8-27b@Cerebras | — | — | **blocked by ZDR** |

## Latency — date-window question (q3), median of 3 runs (2–4 runs per config)

`first` = first streamed token of any kind. `content` = first answer token. All runs of a row gave the same answer unless noted.

| model | overlay | correct | first s | content s | total s (min–max) | out tok (reasoning) | $/call | served by |
|---|---|---|---|---|---|---|---|---|
| gpt-oss-120b | rlow + sort throughput | 3/3 | 0.28 | 0.64 | **0.65** (0.51–0.76) | 391 (371) | 0.00104 | Cerebras |
| gpt-oss-120b | order [cerebras], default effort (medium) | 3/3 | 0.33 | 1.36 | 1.39 (0.90–1.72) | 1228 (1208) | 0.00167 | Cerebras |
| gpt-oss-120b | rlow + order [groq] | 3/3 | 0.69 | 1.28 | 1.34 (1.28–1.64) | 451 | 0.00059 | Groq |
| gpt-oss-120b | rlow, default routing | 2/3 | 0.98 | 11.9 | **11.9 (9.4–18.5)** | 511 | 0.00016 | DeepInfra/DekaLLM/Phala |
| gpt-6.1-sol | rlow | 3/3 | 2.21 | 2.21 | 2.46 (1.67–2.54) | 35 (19) | 0.00062 (cached) | Azure |
| gpt-6.1-sol | default | 3/3 | 2.06 | 2.06 | 2.24 | 44 | 0.00065 | Azure |
| gpt-6-sol | rlow | 3/3 | 2.75 | 2.75 | 2.90 (2.30–6.51) | 84 | 0.00138 | Azure |
| gpt-5.6-luna | rlow | 3/3 | 2.54 | 2.54 | 2.69 (2.12–3.12) | 164 | 0.00024 | Azure |
| gpt-6-luna | default | 4/4 | 2.84 | 2.84 | 3.02 (2.86–3.33) | 207 | 0.00013 | Azure |
| gpt-6-luna | effort none | 0/3 | 0.78 | 0.78 | 1.15 | 14 | 0.00003 | Azure |
| claude-haiku-5.5 | sort throughput | 3/3 | 3.51 | 3.51 | 3.51 (3.14–3.80) | 793 (776) | 0.00073 | Google Vertex |
| claude-haiku-5.5 | default | 4/4 | 4.2 | 4.2 | 4.21 (3.88–8.11) | 821 | 0.00074 | Claude on AWS |
| claude-haiku-5.5 | enabled:false | 3/3* | 0.89 | 0.89 | 3.55 | 698 (CoT written in content) | 0.00068 | Claude on AWS |
| claude-sonnet-5.5 | sort throughput | 3/3 | 2.19 | 5.02 | 5.03 (4.74–5.26) | 414 | 0.01077 | Google Vertex |
| claude-sonnet-5.5 | default | 4/4 | 2.93 | 6.32 | 6.32 (5.20–6.71) | 430 | 0.01093 | Claude on AWS |
| deepseek-v4.1-flash | rlow | 3/3 | 0.50 | 5.25 | 5.28 (4.40–5.38) | 1646 | 0.00223 | Together |
| deepseek-v4.1-flash | enabled:false | 0/3 | 0.34 | 0.34 | 0.35 | 12 | 0.00004 | Together |
| gemini-3.8-flash | rlow | 3/3 | 2.60 | 5.39 | 5.53 (4.84–6.78) | 636 | 0.00421 | Google |
| gemini-3.5-flash-lite | default | 2/4 | 0.72 | 0.72 | 0.89 | 13 (0) | 0.00076 | Google |
| glm-5.3-flashx | rlow | 2/3 | 1.93 | 2.47 | 2.48 (2.38–3.92) | 152 | 0.00039 | Z.AI |
| grok-4.7 | rlow | 3/3 | 2.27 | 15.6 | 15.6 | 1417 | 0.01105 | xAI |
| qwen3.8-27b | order [cerebras] → fallback | 3/3 | 0.59 | 80 | **80 (77–136)** | 2096 | 0.0092 | Wafer (Cerebras excluded by ZDR) |

\* "Correct" here only because the last line of the CoT was right. As a raw answer it is a format failure.

## Quality — 8 tricky questions (one call each)

Questions (see `model_bench_data.py`):
- q1: 3-year boundary is inclusive, and a UTC→local shift moves the date back.
- q2: boundary exclusion.
- q3: excluded services plus a same-specialty provider plus a timezone shift.
- q4: a same-specialty provider (PA-C) holds the latest qualifying visit.
- q5: a later Scheduled visit must be ignored.
- q6: phone stored as `316.555.0187`, answer must be `(XXX) XXX-XXXX`.
- q7: count of 2024 visits, with a UTC New-Year shift.
- q8: latest referral before a cutoff date, with a distractor fax on a nearby date.

| model / overlay | raw UTC chart | local-time chart | med s | p90 s | med $/call |
|---|---|---|---|---|---|
| gpt-6.1-sol rlow | **8/8, 7/7** (+1 429) | 8/8 | 2.5 | 5.0 (max 32.8) | 0.0056 cold (0.0006 cached) |
| claude-sonnet-5.5 | 8/8 | — | 4.4 | 4.6 | 0.0098 |
| deepseek-v4.1-flash rlow | 8/8, 8/8 | — | 4.2 | 6.9 (max 15.6) | 0.0016 |
| gemini-3.8-flash rlow | 8/8 | — | 6.7 | 7.8 (max 15.4) | 0.0051 |
| gpt-6-luna default | 8/8, 7/8 (q7) | 8/8 | 3.0 | 4.5 | 0.0003 |
| claude-haiku-5.5 | 7/8 (q6 leak), 8/8 | 8/8 | 2.7 | 3.5 | 0.0006 |
| gpt-5.6-luna rlow | 7/8 (q7) | 8/8 | 2.5 | 3.8 | 0.0007 |
| gpt-6-sol rlow | 7/8 (q7) | — | 2.9 | 3.3 | 0.0056 |
| gpt-oss-120b@Cerebras **high** | 7/8 (q7) | **8/8** | **1.0** | 1.5 (max 2.0) | 0.0021 |
| gpt-oss-120b@Cerebras low | 6/8, 6/8 | 7/8 (q4) | 0.6 | 1.2 | 0.0010 |
| glm-5.3-flashx rlow | 6/8 | 6/8 | 2.3 | 3.0 (max 32) | 0.0003 |
| gemini-3.5-flash-lite | 2/8 | 3/8 | 0.9 | 1.0 | 0.0008 |

## JSON schema (q3, 3 runs each) and tools

- `response_format` json_schema (strict): **valid 3/3 for every model tested**: gpt-oss-120b@Cerebras (0.6 s), gpt-6.1-sol (2.5 s), gpt-5.6-luna (2.9 s), gpt-6-luna (3.9 s), gemini-3.8-flash (2–3 s; reasoning tokens reported 0 under a schema, still correct), deepseek (2.8–4.9 s), glm-flashx, haiku-5.5 (4.3 s), sonnet-5.5 (5.1 s). Correct 3/3 for all except gemini-3.5-flash-lite (0/3).
- Tools (`open_patient_chart` and `submit_answer`, forced choice): median 0.28 s gpt-oss@Cerebras, 0.58 s deepseek, 0.94 s flash-lite, 0.90 s haiku, 1.2 s gpt-6-luna, 1.3 s gpt-5.6-luna, 1.7 s gpt-6.1-sol, 2.7 s gemini-3.8-flash, 4.0 s glm. Sonnet needs `tool_choice:"auto"` (1.2 s).

## Code-writer (LLM writes `solve(data)`, run locally on 420 appointments)

Three questions:
- c1: distinct patients with a Completed visit at a CO location in Oct 2025, local dates.
- c2: new-vs-established under the full rules.
- c3: provider with the most no-shows in 2025.

| model | correct / executed | med s | max s | med $ |
|---|---|---|---|---|
| gpt-6.1-sol rlow | **7/7** | 3.4 | 7.2 | 0.0033 |
| claude-haiku-5.5 | 6/6 | 4.0 | 10.6 | 0.0006 |
| claude-sonnet-5.5 | 6/6 | 4.9 | 14.8 | 0.0063 |
| deepseek-v4.1-flash rlow | 6/6 | 2.6 | 16.5 | 0.0010 |
| gpt-5.6-luna rlow | 6/6 | 5.1 | 8.2 | 0.0005 |
| gpt-6-luna | 6/6 | 5.4 | 8.1 | 0.0002 |
| glm-5.3-flashx rlow | 6/6 | 4.8 | 14.0 | 0.0004 |
| gpt-oss-120b@Cerebras rlow | 4/6 (c2 wrong both times) | **0.8** | 1.9 | 0.0005 |

Several first-pass failures were our own network blips (DNS, TLS timeouts) and were re-run. One gpt-6.1-sol stall at 123 s was real; its output was cut off mid-string.

## Exact request bodies that worked (POST `$LLM_BASE_URL/chat/completions`)

Fast extractor / router (Cerebras):
```json
{"model": "openai/gpt-oss-120b",
 "messages": [{"role":"system","content":"<rules>"},{"role":"user","content":"<page text>\n\nTask: <question>"}],
 "max_tokens": 3000, "temperature": 0, "stream": true, "usage": {"include": true},
 "reasoning": {"effort": "high"},
 "provider": {"order": ["cerebras", "groq"], "allow_fallbacks": false}}
```
Equivalent routing that also worked: `"provider":{"sort":"throughput"}` and `"model":"openai/gpt-oss-120b:nitro"`. A top-level `"reasoning_effort":"low"` is also accepted. `"reasoning":{"max_tokens":256}` was ignored on gpt-oss.

Reasoner:
```json
{"model": "openai/gpt-6.1-sol", "messages": [...], "max_tokens": 2000, "temperature": 0, "stream": true,
 "reasoning": {"effort": "low"}, "usage": {"include": true},
 "response_format": {"type": "json_schema", "json_schema": {"name": "task_answer", "strict": true, "schema": {
   "type": "object", "properties": {"answer": {"type": "string"}, "confidence": {"type": "number"}, "skip": {"type": "boolean"}},
   "required": ["answer", "confidence", "skip"], "additionalProperties": false}}}}
```
Also accepted: `"verbosity":"low"`, `"service_tier":"priority"` (no speed change seen), `"reasoning":{"effort":"minimal"}`. Rejected: effort `none` / `enabled:false` (400).

Model-level fallback list (accepted):
```json
{"models": ["openai/gpt-oss-120b", "openai/gpt-5.6-luna"], "provider": {"sort": "throughput"}, "reasoning": {"effort": "low"}, ...}
```

Claude with explicit prompt caching:
```json
{"model": "anthropic/claude-haiku-5.5",
 "messages": [{"role": "system", "content": [{"type": "text", "text": "<long stable prefix: rules + messages + site map>", "cache_control": {"type": "ephemeral"}}]},
              {"role": "user", "content": "<page text + task>"}],
 "max_tokens": 2000, "temperature": 0, "stream": true, "usage": {"include": true}}
```
Response `usage.prompt_tokens_details` has `cached_tokens` and `cache_write_tokens`, and `usage.cost` is the real charge in USD. The served provider is in the top-level `provider` field of every stream chunk.

Tools: `"tools":[{"type":"function","function":{...}}], "tool_choice":"required"`. For claude-sonnet-5.5, use `"auto"`.

## Recommended client policy

1. All page timestamps are converted to location-local time **in code**, and date-window logic is ideally done in code too (new/established is deterministic once the rule is parsed). The LLM extracts the rule's parameters and handles the leftovers.
2. Default call: gpt-oss-120b on `["cerebras","groq"]` with `allow_fallbacks:false`, effort high, json_schema answer, client timeout 4 s.
3. Hard or low-confidence tasks: gpt-6.1-sol (effort low). Hedge at about 4 s to claude-haiku-5.5. Retry 429/5xx once on the other model.
4. Keep the stable prefix (system rules and all workflow messages) at the front so OpenAI/DeepSeek implicit caching hits. Add `cache_control` for Claude.
5. Never send `reasoning.enabled:false` to frontier models (400). Never rely on a single-provider model (ZDR can remove it on the judge).
