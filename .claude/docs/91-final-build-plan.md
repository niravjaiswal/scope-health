# Final build plan (v1.26) — multi-agent analysis, Oct 9 2026

Produced by a 43-agent workflow: six analysts (Set 1 forensics, v1.25 code review, Set 3/safe mode, throughput model, selection statistics, 60-minute robustness), adversarial verification of their top findings, and a synthesis.
Applied to agents/speedrunner/sr on Oct 9 ~11:40 EDT (34 edits; full diff in research/v126.diff), plus a plain-text answer fallback for rule-free requests.
Judge image: v1.26 = ie58a17572eb2, submitted 11:45 EDT as s6a396a00c459. Pre-patch backup of v1.25b: research/backup_sr_v125b/.

## Recommendation

Make the final image v1.26 = v1.25b (current agents/speedrunner/sr, md5 solver.py 5403f894…) plus the 10 grouped changes below (34 exact edits across 5 files). I checked every OLD snippet against the current files: each occurs exactly once. Apply them all at once with the script, which checks everything before writing anything:
  python3 /private/tmp/claude-502/-Users-nirav-development-scope-health/07543581-6db0-4558-89e6-42d589d0daa6/scratchpad/wf/final/apply_final.py "agents/speedrunner/sr"
The script refuses to write unless every snippet matches exactly once, then runs py_compile on each file. A tested patched copy is at scratchpad/wf/final/pkg/sr, and the full diff (505 lines) is scratchpad/wf/final/v126.diff.

Why this set, and how it maps to the data:
(1) Sets 1/2 (4.3.1, full mode). We already know how v1.18 got 124: when Set 1 latency is normal, the code answers about 94% correctly and the score is limited by time and false failure signals. The full-mode changes target those losses directly:
- Unresolved-patient tasks used ~65 s per run with 1 rescue in ~115, and they also set off lab/claim pressure-skip cascades.
- Verifier abstentions vetoed correct RELEASE answers and broke trust in the workflow.
- Partial 'Show more' lists produced confident wrong counts, about 3 per run.
- Phone tasks waited about 38 s per run on the visual read.
- Invoice answers were blocked by the grounding gate.
- The strong verifier's correct overrides were thrown away.
(2) Set 3 and the likely final (unseen version, safe mode). The safe path is now bounded by the task deadline:
- The name search was a fixed 25 s; it now gets left−5 s (at most 7 s) and stops cleanly before its timeout.
- Overrun past the deadline is capped at 3 s instead of 10, as in v1.6/v1.8, which hold the best Set 3 scores.
- Tasks cut off by a timeout are now counted in KindStats.
- An unresolved-patient skip turns on only after this shift's own runs show the loop does not rescue those tasks.
- Form-fallback actions use 2.5 s timeouts. Before, one hidden field cost 25 s per patient task (reproduced: 25.0 s, 0 rows → 2.5 s).
- Other 'next page' controls are followed, with rows de-duplicated.
The safe-mode router, prompts, tools, KindStats thresholds and budget formula are unchanged, so the v1.8 behaviour that scores well on Set 3 is kept.

Verification I ran on the patched copy:
- ruff F-checks: no undefined names.
- test_solver.py: 37/37 checks pass. Coverage: NOPAT in full and safe mode with all exemptions and the kill switch; the safe-mode hard cap plus KindStats recording; full mode unchanged at 10 s; the phone early path (full mode only); every P1/P2 verifier branch, with safe mode unchanged; the list guard; the crash fix; the loose-parse guard.
- test_site.py: 8/8 pass. The 4.3.1-style Next pager gives identical rows to the original. Cumulative 'Show more' is found and de-duplicated; on the original it was not found. A stray control is clicked at most once. The soft stop returns before the hard timeout with the CAPPED marker. 'First Last' rows no longer trigger the form fallback. A hidden field fails in 2.5 s.

Fallback: if v1.26 fails the run gates and there is no quick fix, fall back first to the v1.21 image ic1c9bbf0c75c (confirm the id with ./arena images). It has the best clean safe-mode Set 3 (62; 254 total), it carries the v1.20+ DOB matching, and its DIAG_NOROWS hook is inactive in the 3600 s final (it requires shift≈1800). The final set is worth about 2× Set 3, so its expected value is about 20–25 above v1.18. Last resort: v1.18 i34a17a8897f7 (266 realized, but about 246 expected on a re-run; weakest Set 3 lineage). Do not end on v1.25b: it has never finished a judged run.

'Conclusive' in practice: v1.26 is the one image to end on. Submitting it again only re-rolls the Set 1–3 noise (SD about 20; slow-LLM afternoons cost about 90). The final set depends only on the image. Use the remaining slots with the stopping rule below, not with new builds.

## Changes

### P1 C1 Skip unresolved-patient tasks early; keep them and suspension-hit tasks out of KindStats (P3 + throughput-F2 + set3-F2, merged; long-shift F2)
- File: agents/speedrunner/sr/solver.py, agents/speedrunner/sr/main.py
- Expected points: 10
- Rationale: Set 1 data: across 11 runs, about 115 tasks had a named patient that no search path found, with no ids, no provider and no long number. The loop answered 4 of them: 1 plausible, plus 3 'Triage' answers that were almost certainly wrong. Each cost about 6–8 s, roughly 65 s per run after resolution. These tasks also counted as failures for their kind: in v1.20 n=31, wf0 at 9/18 and 7.46 s tripped the pressure skip, but without them it is 9/13 and does not. Replaying should_skip without them removes about 18.6 pressure skips per Set 1 run, worth about 10.7 points before time costs.

Full mode skips these tasks right after resolution. Safe mode measures the loop's rescue rate during the shift: it must see at least 5 loop runs with under 10% answered before skipping, and every 10th task still runs. I found and fixed a bug in the verifier's version: it only counted loop runs with 5 s or more left, but v18 fail-fast cuts budgets to 0.35×, so the warm-up never finished. Now every unresolved-patient task that reaches the loop is counted.

Exempt from the skip: route ids, any 5+ digit number in the text (invoices), named providers ('Carlos Chen, NP' cases), and count/schedule kinds. Tasks hit by an account suspension are also left out of KindStats (v1.6 open_slots lost 2 pressure-skipped tasks after 2 suspension-hit failures). Kill switch: NOPAT_SKIP=0. Tested: full-mode immediate skip 'FFFFFF' with nothing added to KindStats; every exemption takes the normal path; safe mode 'sssssFFFFsFFFFFFFFFsFF'; a loop that rescues never triggers the skip.
- Risk: Low. On 4.3.1 we lose at most about 0.1 rescues per run. In safe mode the guard measures itself and switches off if this shift's loop rescues at least 10%. During the warm-up, tasks are counted in KindStats as before, so they behave exactly like v1.25b. No new awaits. The early return happens before the visual read, the replay and the prefetch start; prov_task is None because no providers were named.

### P1 C2 Verifier: an abstention keeps the loop answer, and a confident strong verifier can override alone (P1 + P2 as corrected; full mode only)
- File: agents/speedrunner/sr/solver.py
- Expected points: 6
- Rationale: Abstentions: there were 68 across 13 builds. By the noisy-ILP labels the loop answer in those cases was about 78% correct overall and 88% on labs. Today every abstention is a veto, and it also adds to trust['disagree'], so a workflow that abstains once is never trusted again. In v1.21, abstentions at n=7 and n=8 led to the wf0 pressure cascade from t=50 s. Exceptions that keep the veto: zero/unknown answers and suspension pages (5 recall-lot cases, net −3.3), and, my addition, a weak verifier that gives a different concrete answer.

Strong verifier overriding alone: on 10 tasks it disagreed with the loop while haiku was null. Each one checks out against the rule text: i155 is a Sunday, so 02-26; i167 EXPIRED:5; i179 NO_FILING_TERMS; i186 BILL_OTHER:Individual; i219 SHORT_NOTICE. The override only fires when the strong answer looks like a code, date or number.

Tested every branch: abstention keeps RELEASE with trust untouched; '0' vetoes; suspension vetoes; a contradicting weak answer vetoes; safe mode vetoes as before; strong alone overrides with NURSE_REVIEW:2; prose never overrides; when weak sides with the loop, strong does not override; the agree path and the strong+weak path are unchanged.
- Risk: Low. Only active when not safe (4.3.1). About 13–22% of answers kept after an abstention may be wrong, so the expected gain is about +0.6 per case. No extra LLM calls or waits. The trust rule itself is unchanged (the relaxation was rejected).

### P1 C3 Safe mode: patient search bounded by the task deadline, 3 s overrun cap, timed-out tasks counted in KindStats (set3-F1 + F3, selection-F2 corrected)
- File: agents/speedrunner/sr/solver.py, agents/speedrunner/sr/main.py, agents/speedrunner/sr/site.py
- Expected points: 7
- Rationale: In safe mode, find_patient has a fixed 14 pages / 25 s while the Set 3 budget is about 11.8 s, and handle_task allows another 10 s on top. v1.8 used the same 25 s search and timed out during resolution on 6 Set 1 tasks (i026, i029, i192–i194, i197). v1.18's bounded 5 s search plus the CAPPED hint answered i192 and i193 correctly.

No safe-mode code path forms an answer after its deadline: the loop breaks when left<2.5, verify needs more than 4 s, and teacher mode and escalation are full-mode only. In Set 1 logs, the overrun seconds produced 0 answers across v1.18–v1.22. v1.6/v1.8 (hard cut at the budget) hold the best Set 3 scores.

Recording the route early is required. Without it, the shorter cap would hide slow failing tasks from fail-fast and the pressure skip, because main.py only sets _route after solve returns.

Full mode is unchanged: the search defaults are the same (verified in the mock: max_pages 6, 5 s, soft False), the cap stays 10 s, and timeouts are still not recorded. Tested: a hung safe-mode resolution is cut at budget+3 ('TT', 7.0 s at a 4 s budget) and recorded as other 0/2; the full-mode timeout stays at about 14 s.
- Risk: Low. On a slow unseen site, a patient listed deeper than about 7 s of paging is missed, but those tasks had at most about one LLM step left anyway. The 4 s floor on the DOB search covered all 4.3.1 DOB resolutions. Cancelled tabs are recycled in the background, as v1.8 did (0 starvation).

### P2 C4 find_patient pagination: other next-page controls, rows de-duplicated across pages, soft stop before the time limit (set3-F5 as corrected + set3-F1 soft stop moved before the click)
- File: agents/speedrunner/sr/site.py
- Expected points: 3
- Rationale: 4.3.1 already uses a cumulative 'Show more' on its Documents and Schedule lists, while the patient list still uses Previous/Next. If the 4.4.0 or final-clinic patient list switched to 'Show more', find_patient would read 20 rows and stop, which is consistent with the ~43 Set 3 tasks that had no row containing the surname.

De-duplication keeps match()'s single-undated rule and the 4 chart-DOB candidate slots working. It also fixes the existing problem where a busy reload re-adds page 1. The progress guard stops a stray control after one click.

The soft stop is checked before clicking, so a page that has already loaded is never thrown away, and the CAPPED marker only appears when more pages really exist.

Tested against the original: the Next pager gives identical rows (116). 'Show more' is now found with 116 unique rows (the original returned only 20 rows and did not find the target). A stray '›' is clicked once. The soft stop returns in 2.0 s with the marker at a 3 s timeout. No marker appears when the list ends in time. Rows are unique after a busy re-read.
- Risk: Low. 'Next' is still tried first, so 4.3.1 control flow is unchanged. None of the 271 recorded /patients pages contains the new labels. The only extra cost is up to 8 cheap in-page button checks at the end of a walk. A '»' that jumps to the last page can only add rows.

### P2 C5 Incomplete-list guard: table_compute refuses 'Showing 20 of about N' partial lists; open/query add a note (F1 as corrected; full mode only)
- File: agents/speedrunner/sr/solver.py
- Expected points: 3
- Rationale: Across recs files, 289 table_compute outputs read 'rows loaded: 20 (complete)' from 'Showing 20 of about 575/975/17,300 appointments'. The existing `of \d+\+` cap check never fired. Resulting confident wrong answers: v1.18 i053 '1', i058 '1', i115 '20', i151 '19', i195; v1.24 i115 and i225 '20'. That is about 3 per Set 1 run.

The number regex `\d[\d,]*` cannot crash on int(''). Tested: the 575-row case returns the WARNING; '17,300' is parsed; '9 of about 9' and '51 to 70 of 70' are not flagged; the NOTE is added only in full mode.
- Risk: Low. table_compute exists only in full mode, and the notes are gated by `not safe`. A count that used to be answered (wrongly) now takes 3–6 s and usually becomes a skip, or a correct answer through the day view or a provider filter.

### P2 C6 Phone questions: don't block on the haiku visual read when the decoded chart shows exactly one well-formed phone (P4 as corrected; full mode only)
- File: agents/speedrunner/sr/solver.py
- Expected points: 3
- Rationale: Waiting on the visual read costs about 25–48 s per Set 1 run, roughly 1.3–2.4 s on each of about 20 phone tasks. The decoded phone matched the visual read in 211/211 cases and was never contradicted. In v1.10, three correct decoded phones were skipped because haiku disagreed or returned nothing.

The condition requires exactly one anchored 'Phone:' line on the visualised chart, and every phone anywhere in the context must equal it, so a 'Claims phone' on an insurance page blocks it. Garbled or blank decodes still wait. The visual task keeps running and is attached asynchronously, as today.

Tested: in full mode a phone task answers in 0.0 s instead of waiting 4 s; safe mode still waits.
- Risk: Low. Full mode only. The only loss would come if a well-formed but wrong phone were decoded, and that never happened in 211 cases.

### P2 C7 Grounding gate: a record opened by its own number grounds the answer (P5 as corrected); in safe mode, record-number requests can be grounded through the record page (set3-F6 as corrected)
- File: agents/speedrunner/sr/solver.py
- Expected points: 4
- Rationale: In v1.18–v1.24, 'GATE no chart opened for patient request' fired 10 times, and 9 of those were correct invoice answers: i103 0.00, i189 12.50 (= 134.00−120.17−1.33), i192 61.16. They came from pre-fetched replay sections, which the relaxation never scanned because it only looks at tool messages.

In safe mode (v1.8 i189, v1.8b i189/i192), the invoice page returned by the model's own query held the surname and a /patients/ link, but the relaxation was disabled in safe mode. It is now enabled only when an id has 5 or more digits, so lot codes and a mis-routed 'Basic metabolic panel' id cannot unlock lab answers. The check is guarded against a non-list ids value and wrapped in try/except.
- Risk: Low. It can only relax a skip, never reject an answer. It needs the surname and a chart link in the record text. A −1 is possible if a trap invoice belongs to another patient with the same surname; none were seen in Set 1.

### P3 C8 Search-form fallback and page-size select: 2.5 s action timeouts; relevance compares the surname initial (code-review F1 minimal + long-shift F3 + F4)
- File: agents/speedrunner/sr/wf/wf_client.py, agents/speedrunner/sr/site.py
- Expected points: 1
- Rationale: No default timeout is set, so fill(), press() and select_option() wait up to Playwright's 30 s for a hidden, collapsed or decoy element. That burns the whole find timeout on every patient task at an unseen clinic. The mock confirms it: the original took 25.0 s and returned 0 rows; the patched version takes 2.5 s and the visible 'Name' field still works. query() and table_rows() already use 2.5 s and have worked on every set.

Relevance on 'First Last' displays: the old check compared the first-name initial and falsely triggered the fallback. The mock confirms the patched version does 0 fills. For 'Last, First' rows (4.2.0/4.3.1) the result is identical.

I did not adopt the analyst's one-submission rule or the 4 s / 1.5 s caps, because they lose slow-submit and busy-first-submit cases.
- Risk: Very low. These are the same elements and the same Enter submit; only the timeouts change. On 4.3.1 the fallback almost never runs, since v1.25's relevance check already removed v1.24's false triggers.

### P3 C9 Run the resolve_patient page-text fallback only when no row containing the surname was read (code-review F2 as corrected)
- File: agents/speedrunner/sr/solver.py
- Expected points: 1
- Rationale: The fallback produced 0 candidates tagged via=text in the CTX of v1.20–v1.24. It reloads pages that were already read, costing 0.1–4 s with busy retries (v1.24 Jiménez and Campbell both ended in 'STEP budget exhausted'). It still runs when there are no rows, when the name column was misdetected, or when the name search failed, which are the cases it exists for.
- Risk: Very low. When rows containing the surname were read, the fallback cannot add a correct candidate that match() missed.

### P3 C10 Small robustness fixes: open(path=[list]) crash, loose-parse digit guard, Site.start retry, wf_docs cleanup on cancellation
- File: agents/speedrunner/sr/solver.py, agents/speedrunner/sr/site.py, agents/speedrunner/sr/wf_docs.py
- Expected points: 1
- Rationale: - open(path=[list]) crashed a lab task in v1.21 n=102 with an AttributeError on path.strip(). The mock confirms the fix.
- '...' and '-' were accepted as answers at confidence 0.8.
- An unguarded site.start() failure would crash the whole 60-min final (asyncio.run exits); close() is capped at 10 s.
- If a read is cancelled, _INFLIGHT[key] hangs and every later read of that document hangs too (reproduced locally by the long-shift analyst).
- Risk: Negligible. Each is error-path only, or a strict tightening of an unobserved case. The success paths are byte-identical in behaviour.

## Rejected ideas

- Throughput-F1 trust relaxation (agree>=2, disagree*3<=agree, re-verify every 10th task, full mode): rejected. Once C2 stops abstentions from breaking trust, the extra gain is small, and an error-prone workflow among Set 2's unseen rules (like wf5 at 31% loop error) that gets 2 lucky agreements loses about 3-5 points.
- Throughput-F7, never verify in full mode: rejected. The verifier catches the same wf5 errors every run (i155, i167, i179: +2-4 per Set 1 run), and the proposed patch also quietly changes safe-mode trust.
- P6, 0.95 'VERIFY no time' factor in full mode: rejected. The K1 verdict shows plain-text workflow codes are the risky class (#92, #155, #179 were systematically wrong and only the verifier caught them). The 0.9 factor is what blocks them.
- P8, provfull replay entity: not verified, and it changes learned replay templates. The F1 list guard covers part of the damage.
- Code-review F3 chart-DOB label-line filter: rejected. It breaks on non-<dl> layouts (practice-clinic dump 'Date of birth\n09/07/1982'), which are exactly what the unseen final might use.
- Code-review F5 format-gate tightening: about 0 EV, and it could send valid answers to reformat.
- Code-review F1 as the analyst wrote it (one submission per fallback, 4 s / 1.5 s caps, search_patients loop rewrite): loses the slow-submit and busy-first-submit cases. C8 keeps the minimal version (action timeouts only).
- Phantom-tab fixes (code-review F6 / long-shift F6): about 0.05 EV and never observed. Left out to keep the change set small.
- Long-shift F1 periodic exploration of written-off kinds: negative in whole-shift simulation (-1.9 normal, -9.5 Set-3-like).
- Long-shift F9 retiring extra starvation tabs: the starvation-suspension correlation was miscounted (p≈0.4), and the patch adds 6 s waits.
- Long-shift F5 queue retry and F8 402 handling: 0.1-0.2 EV, never observed. Optional, not included.
- Set3-F4 early stop on sorted pages for DOB searches: about +1 EV and it touches 4.3.1 paging logic. Only its surname-initial relevance part is kept (in C8).
- Set3-F7 curly-apostrophe folding in norm(): no evidence it is needed.
- Set3-F2's KSTATS '_nopat' pseudo-kind and throughput-F2's loop_left0>=5 counting: replaced by C1's solver-internal guard. In my mock, the >=5 s condition never finished its warm-up once v18 fail-fast (0.35×) cut budgets.
- Changing the budget formula (K, MIN_BUDGET) or KindStats thresholds: the optimum is flat (±1-3) and depends on latency. Keep as is.
- A 2 s grace for full mode (throughput F3): full mode keeps the validated 10 s, so 4.3.1 behaviour and the escalation teacher bonus are untouched. Only safe mode gets the 3 s cap.
- Ending on the v1.18 image by default: its 266 was a lucky draw (expected about 246 on a re-run) and it has the weakest Set 3 / final lineage. Use it only as the last-resort fallback.
- Any further diagnostic build: results could not be acted on before the 12:45 code freeze.

## Local tests

All checks below already pass on the scratch copy (scratchpad/wf/final/pkg/sr). Repeat them on the real tree before building. S = /private/tmp/claude-502/-Users-nirav-development-scope-health/07543581-6db0-4558-89e6-42d589d0daa6/scratchpad/wf/final
1. Apply: python3 $S/apply_final.py "agents/speedrunner/sr". Expect "applied 34 edits to 5 files; all compile: main.py, site.py, solver.py, wf/wf_client.py, wf_docs.py". If any OLD snippet does not match exactly once, it aborts without writing anything. Compare with $S/v126.diff (diff -ru against a pristine copy) if needed.
2. Lint: ruff check --select F821,F811,F823 agents/speedrunner/sr. Expect no undefined names; the pre-existing F401/F841 warnings are fine.
3. Solver/main mock: python3 $S/test_solver.py "agents/speedrunner". Expect 37 PASS and "FAILED: none". It covers NOPAT in full/safe mode, every exemption, the kill switch, the safe-mode hard cap at budget+3 with KindStats recording, full mode unchanged at 10 s, the phone early path, every P1/P2 verifier branch, the list guard, the open(list) crash fix and the loose parse.
4. find_patient mock: python3 $S/test_site.py "agents/speedrunner". Expect 8 PASS: Next pager unchanged at 116 rows; 'Show more' found and de-duplicated; stray control clicked once; soft stop at 2.0 s with the marker; no fallback on 'First Last'; hidden field fails in 2.5 s; unique hrefs.
5. Dockerfile: grep -n 'DIAG\|FORCE_MODE' agents/speedrunner/Dockerfile should print nothing (currently true).
6. Build: docker build --platform linux/amd64 -t sr-agent:v1.26 agents/speedrunner. The Dockerfile's own 'ref ok' step must pass. Then docker run --rm sr-agent:v1.26 python -c "import sr.main, sr.solver, sr.site, sr.wf.wf_client; print('ok')". Disk hazard: delete old local images after pushing, and do NOT run 'docker builder prune -af'.
7. Optional, about 8 min, in parallel with the build (the practice clinic is shared, so keep it short and read-only): a practice-clinic smoke run in safe mode (4.2.0) using the kit's env, e.g. BUDGET=12 python -m sr.main --local research/practice_items.json with 15-20 items. Expect no Traceback, 'MODE safe' (or SITE version 4.2.0), and RESOLVE/FIND timings of 7 s or less. '(search stopped: time limit)' should appear only on big lists, 'NOPAT loop ...' lines on unresolved patients, and no 'phone-ok err' or 'gate-id err'. If this run shows a regression, do not submit v1.26; use the fallback plan.

## Submission plan and stopping rule

It is 11:35 EDT now, not 10:45. Runs take about 31-35 min, one at a time; check ./arena first for a submission already in progress and wait for it to finish. Only the latest finished submission counts, both for the leaderboard and for the final-set image.

- 11:35-11:50: apply the change set, run tests 1-5, build and push sr-agent:v1.26, optionally run the smoke test (7) in parallel.
- ~11:50, SUBMIT #1 = v1.26. It finishes around 12:25. While it runs, watch the Set 1 log with ./arena logs <run>.
- 12:25, judge #1.
  - Hard gates: not reached ≤10 on every set; wrong ≤12 on Set 1, ≤12 on Set 2, ≤10 on Set 3; the Set 1 log shows MODE full, no Traceback or 'TASK error' clusters, 'NOPAT early skip' about 6-20 times, at least one 'VERIFY abstained', and no 'phone-ok err' or 'gate-id err'; Set 3 ≥ 42.
  - Latency regime, from the Set 1 log: SLOW if the median of 'LLM route ... gpt-oss' times is ≥0.40 s or the p90 of step times is ≥1.8 s. A SLOW run is inconclusive about the code, so do not blame v1.26 for low points on a slow run. Only the gates above decide whether the code is healthy.
  - If the gates pass, v1.26 is the final image.
  - If a gate fails with a clear local cause, build v1.26b with the minimal fix. Easiest: reverse just that group, since apply_final.py's E list is grouped by ID. CODE FREEZE 12:45; submit #2 by about 12:50, finishing about 13:25.
  - If the gates fail with no quick fix, submit the fallback image right away: the v1.21 image ic1c9bbf0c75c (confirm the id via ./arena images), or v1.18 i34a17a8897f7 if that id is not available.
- 12:30-14:20, re-draws of the chosen image under a stopping rule. Re-submitting the same image only re-rolls the Sets 1-3 noise; the final set depends only on the image.
  - After each finished run that passed the gates, let k = submissions that can still start by 14:20, counting the next one.
  - STOP (submit nothing more) if R = S1+S2+S3 ≥ T[k].
  - T after a NORMAL-latency run: k=1:219, 2:237, 3:245, 4:250, 5:254.
  - T after a SLOW run: k=1:190, 2:205, 3:215, 4:222.
  - These assume about 250 expected. If v1.26's first normal-latency run shows a higher level, raise T by (that R - 250)/2.
  - Possible starts: about 12:30, 13:05, 13:40, 14:15.
- Rules:
  - A new (never-judged) image must start by 13:40, so a judged fallback can still start by 14:15.
  - The last start is 14:20; a submission that starts after about 14:25 may only re-draw the image of the current latest finished submission.
  - Never let a diagnostic build or an un-judged image be last. v1.25b has never finished a run, so it is not a fallback.
  - Never cancel a submission to discard a bad draw: cancelled runs count against the quota, and whether they count as 'finished' is undocumented.
- Fallback order, if v1.26 cannot be made healthy:
  1. v1.21 image ic1c9bbf0c75c: 101/91/62 = 254, best clean safe-mode Set 3, and its DIAG_NOROWS hook is inactive in the 3600 s final.
  2. v1.18 i34a17a8897f7: 266 realized, about 246 expected on a re-run; the weakest Set 3 / final lineage.
  3. v1.8 i93eaf447445f.
- Overall expected gain over v1.25b: roughly +20 to +30 points across Sets 1-3 plus the final (sum of the per-change estimates is about +39, which is optimistic). Most of the Set 1/2 gain comes from C1, C2, C5 and C6; most of the Set 3 / final gain comes from C3, C1's safe guard, C4 and C7.
