# Speedrunner agent — architecture & status (updated Oct 9 ~01:00 EDT)

Code: `agents/speedrunner/` (`sr/main.py` entry). Build: `docker build --platform linux/amd64 -t sr-agent:vX agents/speedrunner`.

## Scores so far (latest finished submission counts)
| image | Set 1 | Set 2 | Set 3 | total | notes |
|---|---|---|---|---|---|
| v1.1 | −3 (23✓/26✗) | 10 | 15 | 22 | 4.3.1 phone cipher → garbage phones |
| v1.3 | 13 | 6 | 1 | 20 | tab starvation hang |
| v1.4 | 27 (0✗) | 13 | 3 | 43 | still hanging (lost request events) |
| v1.6 | 71 (73✓/2✗) | 93 (95✓/2✗) | 75 (77✓/2✗) | 239 | wait_settled fix |
| v1.8 | 93 (102✓/9✗) | 99 (107✓/8✗) | 69 (74✓/5✗) | **261** | router fix, trust-streak verify skipping, 4.3.1 phone decode |
| v1.9 | 77 | 65 | 34 | 176 | lexical rule matcher (noisy) + strict format gate + teacher → Set 2/3 dropped |
| v1.10 | 66 (1✗) | 80 | 22 | 168 | strict format gate rejected valid answers; junk doc prefetch (bug since v1.1) slowed everything |
| v1.12 | ? | ? | ? | ? | rule-summary router (221/224), softened gate, no teacher, junk prefetch removed, suspension backoff |

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

## Lessons (Oct 9 night)
- Coverage beats caution: v1.8 (more answers, 9 wrong) > v1.10 (1 wrong, far fewer answers).
- Any gate that can reject valid answers is catastrophic on unseen sets (Set 3). Gates must only reject clear prose for code-style rules.
- Site traps seen on 4.3.1: "account is suspended — try again later" mid-shift (likely load-triggered), busy-truncated lists, 500-row list cap, phonetic/capped name search, document ids global across patients.

## Known gaps / next
- Set 1 throughput: lab triage (45) mostly pressure-skipped; recall-lot (14) unsolved; invoices with capped name search.
- Disk space on the dev Mac (OrbStack dies under ~1 GB free).
