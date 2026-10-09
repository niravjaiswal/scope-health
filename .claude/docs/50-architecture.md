# Speedrunner agent — architecture & status (updated Oct 9 ~01:00 EDT)

Code: `agents/speedrunner/` (`sr/main.py` entry). Build: `docker build --platform linux/amd64 -t sr-agent:vX agents/speedrunner`.

## Scores so far (latest finished submission counts)
| image | Set 1 | Set 2 | Set 3 | total | notes |
|---|---|---|---|---|---|
| v1.1 | −3 (23✓/26✗) | 10 | 15 | 22 | 4.3.1 phone cipher → garbage phones |
| v1.3 | 13 | 6 | 1 | 20 | tab starvation hang |
| v1.4 | 27 (0✗) | 13 | 3 | 43 | still hanging (lost request events) |
| v1.6 | 71 (73✓/2✗) | 93 (95✓/2✗) | 75 (77✓/2✗) | **239** | wait_settled fix — 5th place |

## Pipeline per task
1. Router (gpt-oss-120b @ Cerebras, JSON): relevant workflow rules (base + amendments), kind, entities.
2. Patient resolution: DOB search first (exact), else paginated name search (copes with phonetic/capped search, busy truncation).
3. Prefetch: chart + learned pages; **plan replay**: tool calls that solved earlier tasks of the same kind, re-run with this task's entities.
4. Tool loop (gpt-oss; gpt-6.1-sol "teacher" for the first tasks of each new workflow): open (batch), query (form fill + submit), table_compute (rows → Python), search_patients, read_document (PDF glyph decode / haiku vision).
5. Verification for workflow tasks: gpt-6.1-sol (vetoes) ∥ haiku-5.5; skipped after 3 agreements (spot-check every 4th).
6. Gates: patient chart must be opened; phone shape; conf ≥ 0.75; fail-fast & time-pressure skipping per kind.

## Anti-scraping handled
- Randomized classes/attrs, iframe content, layout fingerprint (real Chromium).
- 4.2.0 cipher fonts (glyph-outline decode), 4.3.1 per-digit `::before` + clip-path decoys, MRN drawn as CSS background PNG (visual read via haiku), shuffled spans.
- Lying PDF text layers (glyph decode of embedded fonts), scans (vision).
- "Wrenfield is busy" truncated lists (retry), 503 throttling (≤2 tabs + 1 background lane), honeypot `/patients/all`.

## Known gaps / next
- Set 1 throughput: lab triage (45) mostly pressure-skipped; recall-lot (14) unsolved; invoices with capped name search.
- Disk space on the dev Mac (OrbStack dies under ~1 GB free).
