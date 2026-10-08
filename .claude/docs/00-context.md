# Scope Health Speedrun — shared context (read first)

Deadline: submissions close **Fri Oct 9 2026, 3:00 PM EDT**. Final set (924 tasks / 60 min / $25) runs once on our
latest finished submission afterwards, at an unseen clinic. Final rank = latest submission (Set1+Set2+Set3) + final set.

## Paths
- Project root: `/Users/nirav/development/scope health`
- Kit: `speedrun-kit/` (CLI `./arena`, docs in `speedrun-kit/docs/shift.md`, `rules.md`, reference agent in `speedrun-kit/reference-agent/`)
- Python venv with Playwright + chromium + httpx + bs4: `.venv/bin/python`
- Research scratch: `research/`; docs/plans go in `.claude/docs/`
- Dev OpenRouter key: env file `/Users/nirav/development/scope health/.env.dev` (`LLM_API_KEY`, `LLM_BASE_URL=https://openrouter.ai/api/v1`). NEVER put it in an image, a log, or a doc.

## The game
- Queue of items (one at a time, no lookahead): `message` (acknowledge; may define/override workflows & answer formats; later message wins) or `task` (answer / skip).
- Correct +1, wrong −1, skip 0, not reached 0. Shift clock starts at container start.
- Set 1: 224 tasks/15 min/$8 (agent output visible to us afterwards). Set 2: 226/15 min/$8. Set 3: 458/30 min/$15. ⇒ ~4 s per task, ~$0.03 per task.
- Model endpoint: OpenAI-compatible proxy to OpenRouter (`LLM_BASE_URL`, `LLM_API_KEY`); any OpenRouter model except web-search ones. Concurrency: max 32 in flight, and ≤ 1 per $0.50 budget left. 120 s timeout. No URLs in message content.
- Container: 4 CPU, 8 GB RAM, no internet (only QUEUE_URL, SITE_URL, LLM_BASE_URL). Image ≤ 8 GB, linux/amd64.
- Answer comparison rules: see `speedrun-kit/docs/shift.md` "How answers are compared" (dates flexible, phones normalized, text exact modulo case/whitespace, lists split on commas).
- Leaderboard right now (Oct 8 evening): top total 325 (Set1 ~167-185, Set2 ≤112, Set3 ≤59). Everyone does badly on Sets 2/3 ⇒ those clinics probably use a *different Wrenfield version* / harder messages. Robustness to unseen versions is the key to winning (final set too).

## Wrenfield (the clinic web app) — what we know
- Practice clinic: https://practice.speedrun.scopehealth.com (no sign-in needed there; on the judge: `$SITE_URL/login` with `SITE_USERNAME`/`SITE_PASSWORD`, session cookie). Version string seen: "Wrenfield 4.2.0", user "frontdesk" (Administrator), clinic "Harbor Glen Medical Group".
- The practice clinic is SHARED with every competitor. Be strictly read-only (only searches / navigation). Do not cancel/create/edit records. Keep load modest (≤ 4 concurrent pages).
- Server-driven UI, anti-scraping: all CSS class names and data-attribute names are randomized **per page load**; the URL of the JS/CSS and of the POST endpoint is a one-time `/v/<random>/...` path.
- Page shell (GET /patients etc.) has nav + location switcher. Main content is an `<iframe src="/v/<random>/">` (title = page name) whose document holds the real content.
- Interactions = POST to `/v/<rand>/<rand>` with form params `{<actionParam>: <element token from a data-attr>, <fpParam>: window[<rand fn>]()}`. The fp value is a **layout fingerprint** (getBoundingClientRect widths of hidden `<i>` elements) ⇒ wrong value → HTTP 401. So a real browser engine is needed (Playwright Chromium). Response = HTML fragments (`<template data-X="target">`), scripts, and `<meta data-Y="code" content=...>` commands (2=pushState, 3=replaceState, 5=title, 1=navigate).
- Playwright needs `bypass_csp=True` on the context to use `wait_for_function`/evaluate strings.
- Nav pages: `/`, `/patients` (search by last name or DOB), `/patients/all`, `/schedule`, `/billing`, `/documents`, `/activity`, `/about/notices`. Location switcher: All locations + ~10 locations (Northgate, Front Range, Eastside, Stonebrook, Lakeside, Riverbend, Highline, Prairie View, Cedar Hollow, Willow Creek), in KS and CO (⇒ Central vs Mountain time zones!).
- Some charts are **restricted**: "Restricted chart requests" table (Patient / Reason e.g. "Providing care to this patient", "Billing or insurance question" / Status Approved/Ended).
- Working smoke script: `research/scripts/smoke2.py`.

## Known task examples (practice set)
1. Message: new-vs-established rule (3-year window, completed only, same provider or same specialty, excluded service types, merged duplicate charts, recurring appointments, location-local dates). Answer `NEW` or `ESTABLISHED:YYYY-MM-DD`.
2. "Billing question: Guadalupe Driscoll, visit with Sharon Morales, MD on 2025-11-05. Is that a new or an established patient visit?" → `NEW`
3. "Referral letter received on 2025-11-10 for patient Randy Singh (born 1939-12-04): which practice made the referral?" → `Plains Dermatology Associates` (chart → Documents tab)
4. "What phone number do we have on file for patient Julie Martínez (born 2010-01-10)?" → `(620) 323-6931` (chart → Demographics)
