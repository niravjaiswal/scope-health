# 60 — Reading Wrenfield documents (lab reports, referral letters, statements, outside immunization records, remittances)

Author: Task B (documents), Oct 8 2026 evening. Dev-key spend for this work: **about $0.99** (about 1,030 vision calls).
Code: `research/scripts/wf_docs.py` (ship it with `research/doc_fonts/`). Tests: `research/scripts/wf_docs_test.py`.
Benchmark: `research/scripts/docs_bench.py`, raw results `research/bench_out/docs_vision.jsonl`.
Samples + ground truth: `research/docs_samples/` (42 practice documents: PDF + page PNG + viewer text, `gt_all.json`,
`*.glyph.txt` exact decodes, `synth/` degraded copies, `synth2/` synthetic 4.3.1-style immunization records and remittances).

## TL;DR

1. **Fetch only the PDF** from the viewer (`wf.main.document_files(want=("pdf",))`). The page PNG the site shows is the
   PDF rendered at 200 dpi: pixel-identical to a PyMuPDF render (mean diff 0.6/255 on 34 of 34 documents). The PNG
   download adds nothing and costs a request (250–330 KB).
2. Call `await wf_docs.read_document(pdf_bytes=pdf, llm_call=llm, hint="lab report")`:
   - **Vector PDF** (81% of the sample) → **exact glyph-outline decode**, no model. **34/34 documents exact**, including
     the 15 whose ToUnicode text layer lies. 13 ms median and 55 ms max on the Mac, 30–75 ms in an emulated amd64
     container. $0.
   - **Scanned PDF** (only an image; 19%: some lab reports, some referral letters, some statements) → page rendered
     from the PDF → **`anthropic/claude-haiku-5.5`**, thinking off, `provider.sort="latency"`, **1240 px wide JPEG q85**, verbatim-transcription
     prompt. Accuracy: **391 of 391 calls exact** across real scans, degraded copies, clean pages and synthetic
     immunization grids and remittances (4,897 checked fields and table rows). Latency median 2.1 s, p90 2.65 s, max 3.2 s.
     About **$0.0005 per page**.
   - Hedge: if Haiku has not answered after 4.5 s, or it errors, or the transcription fails the self-check (lab report:
     "Tests reported: N" must equal the parsed row count, and the record and report numbers must be present), it fires
     `google/gemini-3.8-flash` (reasoning minimal; 90/90 exact, median 2.7–3.7 s, rare 25 s stalls). The
     third choice is `openai/gpt-4.1-mini`.
3. Use the helpers instead of asking the LLM to do the arithmetic. `parse_lab_report(text)` returns the header fields and
   every test as (test, result, units, range, flag). `resolve_partial_dates(row, fmt)` handles year-less grid dates
   such as `05/16`, `16.05.` and `16 May`.
4. Never trust the PDF text layer (`pdftotext`, PyMuPDF `get_text`, ToUnicode). In 15 of 34 vector PDFs it is wrong in
   names, dates, MRNs, amounts and values. Example: a statement's layer says account `HG7662520`, amount due `$1881.96`
   and statement date 2026-12-17, while the page shows `HG4552820`, `$1771.95` and 2025-12-14. Labels are honest; values are not.
5. Don't use Tesseract. It takes 0.3–0.4 s per page, but it misreads digits next to speckles (Serum iron "12," for
   112), misses rows, and fails on handwriting fonts (4 of 22 items correct on an immunization grid).

## 1. What the documents are (practice clinic, regenerated data, Oct 8)

Sample: 42 documents taken from `/documents` (300 listed: 58 statements, about 136 lab reports in 8 panels, about 90 referral letters from 13 practices).

| kind | lab report | referral letter | statement | total |
|---|---|---|---|---|
| vector PDF, honest text layer | 11 | 5 | 3 | 19 |
| vector PDF, **lying ToUnicode** | 9 | 5 | 1 | 15 |
| scanned (one 1-bit 1700×2200 image, no text) | 4 | 3 | 1 | 8 |

- In the current data, referral letters are **not always scans** (this corrects 11-wrenfield-data.md). Vector letters
  have a trapped layer too (e.g. "Elk Band Haelth Cantar"). The letterhead practice name and the reason sentence are
  correct in our decode.
- Signatures are drawn as vector paths or image strokes, not as text. Pangolin and Mali (the handwriting fonts) were not used for text in any sample;
  the decoder supports them anyway (in the reference set), and our synthetic tests use them for handwritten entries.
- Scans: 1-bit at 200 dpi, slight skew, speckle noise. Speckles sometimes sit inside numbers (e.g. "2026-10-1.1" in
  `72ftdnmrb9`). Gemini 3.5 Flash, 3.5 Flash-Lite and GPT-5.6-luna copied the dot; Haiku did not. The prompt now says
  to ignore specks.
- Every page is a US Letter page with one `<img alt="Page i of n, …">`. All samples had one page; the code handles
  n pages (one vision call per page, run concurrently).
- Traps to remember for tasks: lab reports print a **Record number** that can differ from the chart's MRN. The triage
  rule says to ignore those reports. The same **Report number** filed twice is one report. Misfiled referral letters
  exist (the letter names a different patient).

## 2. Exact decode of vector PDFs (glyph outlines)

How the PDFs are generated (verified):
- Fonts are Type0/Identity-H TrueType subsets derived from @fontsource 5.2.5 (latin + latin-ext) Noto Sans 400/700,
  Noto Serif 400/400i/700, Pangolin and Mali. Each subset has a **random unitsPerEm** (seen: 2003, 2391), so every
  coordinate is rescaled. Points carry **±1–2 unit jitter**, and **glyph order is shuffled** (glyph names are
  `glyphNNNNN`). Trapped PDFs add **near-duplicate glyphs** (the same outline, re-jittered) whose ToUnicode entry
  points to a different letter. Static labels use the honest copy; names, dates and values use the lying copies.
- Decoder (`pdf_decode`):
  1. Per glyph, take the outline (decomposed), scale it to 1000 upem, and form its structure signature (the sequence of
     pen operations and point counts).
  2. Compare it with the reference outlines that share the structure (3,700 structure buckets from the 15 bundled
     woff files) by mean |Δ|. True matches score 0.2–0.7; the next candidate is ≥ 4, or there is no candidate at all.
  3. Exact lookalikes (g/ɡ, -/soft hyphen, ,/‚, s/ꜱ) resolve to the plainest code point.
  4. Lay out text from PyMuPDF `get_texttrace()` (per-glyph ids and positions): group into lines by baseline, sort by x,
     and join with ` | ` where the gap exceeds 1.2 em (tables and label/value pairs).
  5. **Hidden-text guard**: drop a span if it is invisible (render mode 3 / opacity 0) or if its box shows no ink in a
     100-dpi render (white-on-white text, text under a box). No sample had any hidden text.
- Results: 34/34 exact against ground truth; zero unmatched or ambiguous glyphs. CPU time is 13 ms median and 38–55 ms
  max on the Mac, and 30–75 ms in an amd64 slim container (emulated). The reference set loads in 0.4 s, or 0.02 s from
  `doc_fonts/ref_outlines.pkl`, which is written on first load. Pre-warm it with `wf_docs.load_reference()` at startup.
- Fallbacks: a glyph that doesn't match (another font, or CFF/cubic outlines) or a page with large images (`mixed`) →
  vision on the rendered page. For a mixed page, the exact text layer is appended after the vision text.

Example (`4nswk8vqpn`, trapped). The text layer says "Divam Ridíroz … Petissaud 2.5 ddel/L … Tests reported: 4". The decode gives:
```
Patient | David Ramírez | Ordering provider | Richard Harrison, NP
Date of birth | 2006-01-03 | Collected | 2026-10-13
Sex | M | Received | 2026-10-14
Record number | HG5460668 | Report number | LR-040000
Basic metabolic panel
Test | Result | Units | Reference range | Flag
Sodium | 145 | mmol/L | 135 - 145 | normal
Potassium | 3.4 | mmol/L | 3.5 - 5.1 | low
...
Tests reported: 8
```

## 3. Vision benchmark (scans and anything not decodable)

Prompt: `wf_docs.VISION_PROMPT`. It asks for verbatim lines, ` | ` between columns and cells, dates exactly as printed
(year-less dates kept as printed), accents kept, handwriting transcribed, and specks ignored. One user message holds
the text plus a `data:image/jpeg;base64` image. Temperature 0, max_tokens 4000.

Scoring: every key field (names, DOB, MRN or record number, report number, dates, phones, amounts, reason, urgency,
signer, vaccine dates) must appear verbatim, and every table row's (test, result, units) must appear on one line.
For lab reports, `parse_lab_report` must also reproduce all fields and rows exactly ("parse").
Data sets:
- `scan`: 8 real scans, ground truth read by hand.
- `clean`: 34 vector pages, ground truth from the exact decode.
- `synth`: the same 34 pages binarised, rotated ±0.7° and speckled, noisier than the real scans.
- `synth2`: 8 synthetic outside-immunization records and paper remittances. These include grids with year-less dates
  in MM/DD, DD.MM. and "day Mon" forms, handwriting fonts, and CO-45 / PR-2 adjustment columns.

### 3a. Screening on the 8 real scans (1 run, 1240 px JPEG)

| model (overlay) | perfect docs | lab parse | median s | max s | $/page | notes |
|---|---|---|---|---|---|---|
| **anthropic/claude-haiku-5.5** (thinking off) | **8/8** | 4/4 | 2.4 | 2.9 | 0.00047 | |
| google/gemini-2.5-flash-lite | 8/8 | 4/4 | 2.4 | 9.2 | 0.00030 | 24/34 on synth: weak with heavy noise |
| google/gemini-3.8-flash (minimal) | 8/8 | 4/4 | 3.8 | 9.0 | 0.0019 | |
| openai/gpt-4.1-mini | 8/8 | 4/4 | 3.1 | 3.9 | 0.00093 | |
| openai/gpt-5-nano (minimal) | 8/8 | 3/4 | 3.6 | 4.8 | 0.00016 | 14/34 on synth |
| xiaomi/mimo-v2.6-flash (no reasoning) | 8/8 | 4/4 | 2.7 | 10.7 | 0.00041 | tail up to 18 s |
| inclusionai/ling-3.0-flash-vl | 8/8 | 4/4 | 10.3 | 72.6 | 0.00025 | too slow |
| google/gemini-3.5-flash (minimal) | 7/8 | 3/4 | 2.7 | 3.1 | 0.0043 | copied the speck dot |
| google/gemma-4-31b-it | 7/8 | 4/4 | 5.7 | 9.0 | 0.00047 | |
| openai/gpt-5.6-luna (minimal) | 7/8 | 3/4 | 4.3 | 5.0 | 0.0011 | |
| meta-llama/llama-4-scout | 7/8 | 2/4 | 15.8 | 20.5 | 0.00033 | |
| google/gemini-3.5-flash-lite | 6/8 | 3/4 | 2.0 | 52 | 0.00076 | |
| amazon/nova-2-lite-v1 | 6/8 | 2/4 | 2.2 | 2.5 | 0.00069 | adds and drops digits in MRNs |
| deepseek/deepseek-v4-flash-vision-exp | 5/8 | 3/4 | 13.6 | 16.2 | 0.0015 | |
| openai/gpt-6-luna (minimal) | **0/8** | 0/4 | 6.3 | 18.3 | 0.00056 | **drops repeated digits** (LR-039971 → LR-03971) |
| gemini-3.1-flash-lite / mistral-small-2603 | — | — | — | — | — | 429 rate-limited upstream |
| qwen/qwen3.8-omni-flash | — | — | — | — | — | 404, ZDR blocks it |
| z-ai/glm-5.3-flash | — | — | — | — | — | 400, reasoning cannot be disabled |

### 3b. Larger runs (scan + synth: 42 docs; synth2: 8 docs × 2 runs)

| config | scan | synth (noisy) | synth2 (4.3.1-style) | median s | p90 s | max s | $/page |
|---|---|---|---|---|---|---|---|
| **haiku-5.5, thinking off, sort=latency** (`VISION_MODELS[0]`) | 24/24 (3 runs) | 34/34 | 8/8 | **1.9–2.3** | 2.4–2.8 | 3.2 | 0.00047 |
| haiku-5.5, thinking off, default routing | 8/8 | 34/34 | 17/17 | 2.5–2.9 | 3.0–3.3 | 4.0 | 0.00047 |
| haiku-5.5, sort=throughput | 24/24 | — | — | 2.0 | 2.75 | 4.1 | 0.00047 |
| gemini-3.8-flash, minimal (hedge) | 40/40 | 34/34 | 16/16 | 2.7–3.7 | 3.0–4.5 | **25.8** | 0.0019 |
| gemini-3.5-flash, minimal | 39/40 | 33/34 | 16/16 | 2.0–2.6 | 2.2–3.1 | 21.5 | 0.0043 |
| gpt-4.1-mini | 8/8 | 32/34 | 14/16 | 2.7–3.7 | 4.2 | 8.6 | 0.0009 |
| mimo-v2.6-flash | 8/8 | 33/34 | 14/16 | 4.1–4.6 | 6–12 | 18.7 | 0.0004 |
| gemma-4-31b | 8/8 | 28/34 | — | 2.5–5.0 | 4.7–5.8 | 7.9 | 0.0005 |
| gemini-2.5-flash-lite | 8/8 | 24/34 | 10/16 | 2.2–3.1 | 3.0–3.3 | 20.6 | 0.0003 |
| gpt-5-nano | 8/8 | 14/34 | — | 3.6–4.1 | 4.3–4.8 | 5.1 | 0.0002 |

With `sort=latency`, Haiku was served by Azure (100/100 calls): 100/100 exact, median 2.13 s, p90 2.65 s, max 3.2 s.
In end-to-end `read_document` runs (PDF in, 16 concurrent), the median was 2.65 s with one hedged call at 6.8 s; 16/16 exact; $0.0072 total.

### 3c. Image size and format (Haiku, scan + synth)

| input | perfect | median s | input tokens | $/page |
|---|---|---|---|---|
| 800 px JPEG | 41/42 (one row missed) | 2.4–2.6 | 1,347 | 0.00032 |
| 1000 px JPEG | 42/42 | 2.5–3.0 | 1,966 | 0.00038 |
| **1240 px JPEG q85 (default)** | 42/42 (×3 configs) | 2.4–2.7 | 2,884 | 0.00047 |
| 1240 px PNG | 42/42 | 3.6–5.3 | 2,884 | 0.00048 |
| 1700 px PNG (original) | 42/42 | 3.2–3.8 | 5,032 | 0.00068 |

Latency comes mostly from the 250–380 output tokens, not from image size. PNG uploads are slower. Use 1240 JPEG; 1000
is fine if bandwidth is tight.

## 4. Recommended integration in the agent

- At startup, call `wf_docs.load_reference()` (reads the pickle in 0.02 s; builds it in 0.4 s) and `llm = wf_docs.make_llm_call()`,
  or pass our own client: any `async (messages, model=..., **body) -> {"text": ..., "cost": ...}` or `-> str` works.
- Per document: open `/documents/<did>` (or the chart's Documents → View), then `document_files(want=("pdf",))`, then
  `read_document(pdf_bytes=…)`.
  Fire all documents a task needs **concurrently**: the lab report asked about, the other reports of the same panel
  (for the change rule), and every outside immunization record. Glyph decodes are effectively free, and scans cost
  about 2–3 s and $0.0005 each.
- Results are cached by content hash, and concurrent reads of the same document are deduplicated. The same report
  shows up for several tasks (previous reports), so this saves calls.
- Lab triage: run `parse_lab_report(res["text"])`, then do the rule in code (critical limits, review ranges by
  sex and age, the change rule, the record-number filter, report-number dedup). Parsing worked on 100% of decoded and
  Haiku-transcribed lab reports (52/52 in the "final" and "lat3" runs).
- Tetanus: transcribe each "Immunization record:" document. Read `Dates written`, map vaccine names using the table in
  the message, and expand each grid row with `resolve_partial_dates(cells, fmt)`. A same-month-and-day date rolls to
  the next year, as the message requires. Then deduplicate doses by date in code.
- Remittances (scanned paper): the transcription keeps `CO-45 47.60`-style adjustments and remark codes on the line's
  row. Our synthetic remittances came back 100% exact (Haiku, Gemini 3.8, Gemini 3.5); gpt-4.1-mini dropped one modifier.
- Budget per task: a vector-only task costs $0 and under 0.1 s for the documents. A task with 1–3 scans costs about
  $0.0005–0.0015 and 2–3 s of wall time when the reads run in parallel.

## 5. Unknowns and risks for 4.3.1 (Sets 1–2) and the final set

- The 4.3.1 document generator was not observable here: the practice clinic runs 4.2.0, and the judge site is unreachable from the Mac. If 4.3.1 embeds other
  fonts or CFF outlines, glyphs come back unmatched and `read_document` falls back to vision automatically (method
  `vision:…`). Watch `res["method"]` and `res["unmatched"]` in the Set 1 logs.
- **Pictures of text in the web UI**: the 4.3.1 chart header MRN had no DOM text. /about/notices says Atkinson
  Hyperlegible Mono outlines are "read … to draw pictures of text". There are two ways to read it:
  1. Element screenshot, then `vision_transcribe(png, llm, hint="MRN")`. This takes about 2 s and is robust.
  2. Match the SVG path outlines against Atkinson Hyperlegible Mono with the same normalisation as `pdf_decode`.
     To set this up, add `@fontsource/atkinson-hyperlegible-mono@5.2.5/files/atkinson-hyperlegible-mono-latin-400-normal.woff`
     to `doc_fonts/` and write a small SVG adapter. This is untested because we have no sample.
- Handwritten entries on real outside records may be messier than Pangolin and Mali. Haiku read our handwriting-font
  grids perfectly. The self-check only covers lab reports, so consider a second-model cross-check on immunization
  records if Set 1 logs show misses.
- The proxy accepts images only as `data:` URLs (shift.md), which is what `vision_transcribe` sends.

## 6. Files

- `research/scripts/wf_docs.py`: the main functions.
  - `read_document`, `pdf_decode`, `vision_transcribe`, `vision_robust` (hedge plus self-check).
  - `make_llm_call`, `parse_lab_report`, `parse_date`, `resolve_partial_dates`, `pdf_page_pngs`, `downscale_png`.
  - `VISION_MODELS`, `VISION_PROMPT`, `VISION_WIDTH`, `HEDGE_AFTER`.
- `research/doc_fonts/`: 15 @fontsource 5.2.5 woff files (OFL) and `ref_outlines.pkl`. Ship them next to `wf_docs.py`
  as `doc_fonts/`, or set `WF_DOC_FONTS`.
- `research/scripts/wf_docs_test.py`: unit tests and the decode table. `--llm` runs end-to-end vision on scans and synth2 (about $0.01).
- `research/scripts/docs_bench.py`: subcommands `gt` (build ground truth and synthetic scans), `run <cfgs> --docs scan+synth --runs N --width W --fmt JPEG|PNG --tag T`, and `report [regex]`.
- `research/scripts/docs_collect.py`: the practice-clinic collector (read-only). `docs_synth2.py` builds the synthetic 4.3.1-style docs. `docs_glyph_all.py` decodes every sample.
- Python deps: `pymupdf==1.28.2` (about 58 MB, manylinux wheel, no system libraries), `fonttools`, `pillow`, `httpx`. Checked in `python:3.12-slim` (amd64).
