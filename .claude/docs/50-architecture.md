# Speedrunner agent — architecture (v1 draft, Oct 8 21:00 EDT)

Goal: maximize (correct − wrong) over Set1/2/3 + final (924 tasks/60 min/$25, unseen clinic, possibly unseen Wrenfield version).
Leaders answer ~35% of tasks with ~0 wrong; Sets 2/3 are wide open. Robust generalization > Set-1 overfitting.

## Facts that shape the design
- Strictly sequential queue, ~4 s/task average budget, ~$0.035/task. Wrong = −1 ⇒ skip when unsure.
- Items are fixed per set (practice queue identical across runs). Set 1 & Set 2 = Wrenfield 4.3.1; practice = 4.2.0; Set 3 = other.
- Judge site: ≤4 concurrent page loads per session or it throttles (503 / 2.5 s JS retry). Practice-in-judge: 0.07 s/page.
  Set 1 dumper saw ~2 s/page (to be analysed).
- Anti-scraping: randomized class/attr names per load; content in an iframe; per-load cipher fonts on identifiers
  (decode by glyph-outline matching vs the honest "Wrenfield Mono" face); some text drawn as vector pictures;
  documents are generated PDFs (some handwriting fonts).
- Site state can change during the shift ("cancellations in the next few minutes", "posting payments") ⇒
  "as of now" questions must read fresh pages.
- Workflow messages define precise rules + answer formats; later messages amend (effective dates!).

## Components
1. **Data layer (`wf`)**: Playwright pool (4 pages, one session) → `fetch(path)` → decoded text (cipher fonts,
   SVG text, tables as rows, links as `<path>`), cache with timestamps. PDF documents → text.
   Version-agnostic: discover nav sections + chart tab links at startup; never rely on class names.
2. **Runtime**: queue loop, time budget per task (seconds_left / est. remaining tasks), logging of every item,
   answer, evidence, timing (Set 1 logs are our only scored-set window).
3. **Memory**: all messages in order; workflow registry (title, text, amendments with effective dates);
   facts; noise filtered.
4. **Solver** (per task):
   a. Router (fast LLM, JSON): workflow id | lookup kind; entities (patient name/DOB, provider, date, location,
      invoice no., lot, DOS, time); data plan.
   b. Gather (code, parallel ≤4): patient resolution (search by last name, match first name/DOB; handle accents,
      duplicates/merged, restricted charts) → all chart tabs + linked detail pages needed by the plan;
      global pages (staff/specialties, payers, calendar, vaccines/lots, schedule views) cached once.
   c. Answer (LLM): rule text + gathered text → {answer, confidence, evidence}. Model tier by difficulty.
   d. Gates in code: unique entity, format regex from the workflow examples / answer-kind validation,
      optional second opinion for risky workflows; else skip.
   e. Agentic fallback: tool loop (open(path), search, find) with a hard time box.
5. **Learning during the shift**: per workflow, cache the page plan that worked (which tabs/details/global pages)
   so later tasks prefetch exactly that; optionally LLM-written Python per workflow, verified against the
   LLM answer on the first instances.

## Dev loop
- Offline replay harness over dumped pages (Set 1 dump with font decoding) + practice expected answers.
- Oracle answers for Set 1 tasks via a strong model with high reasoning over complete dumped data + manual spot checks.
- Submissions: each gives Set 1/2/3 correct/wrong/skip counts + Set 1 logs.
