# Speedrun — final report (draft, Oct 9 06:00 EDT)

## Where things stand
- Best total so far: **v1.18 = 266** (Set 1 124, Set 2 93, Set 3 49). Image id on the judge: `i34a17a8897f7`.
- Earlier best: v1.8 = 261 (rerun 231), image `i93eaf447445f`.
- The leaderboard and the final ranking use the **latest finished submission**, so the last submission before
  15:00 EDT must be the best image.

## How to resubmit an image (from `speedrun-kit/`)
```bash
./arena submit --image i34a17a8897f7 --wait
```

## What the agent does (agents/speedrunner)
See `50-architecture.md`. Two modes chosen at startup from the Wrenfield version string:
- **full** (validated version 4.3.1 — Sets 1 and 2): rule-summary router, format/code-word gates, plan replay,
  DOB pre-search, speculative document reads, table_compute/open_documents/click tools, workflow data-gathering
  plans for rules that keep failing.
- **safe** (any other version — Set 3, possibly the final set): behaves like v1.8, the build that scored best on Set 3.

## Score history
| image | Set 1 | Set 2 | Set 3 | total |
|---|---|---|---|---|
| v1.6 | 71 | 93 | 75 | 239 |
| v1.8 | 93 / 76 | 99 / 96 | 69 / 59 | 261 / 231 |
| v1.12 | 104 | 112 | 8 | 224 |
| v1.16 | 93 | 74 | 47 | 214 |
| v1.18 | 124 | 93 | 49 | **266** |

Run-to-run variance is about ±10–15 points per set, so single runs are noisy.
