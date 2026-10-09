# Adaptive agent (`src/adaptive/`)

A from-scratch, runtime-learning solver that replaces the pre-baked family catalog with classifiers
it **builds as it reads questions**. Goal: generalize to Set 2/3 (rephrasings) and to different
Wrenfield architectures without any edits, using Haiku 5.5's speed to explore and learn live.

It reuses the proven low-level pieces of `../wrenfield` (the `Crawler` with font-deobfuscated reads,
patient resolution, vision OCR, and `compileMessage`) but none of its fixed question logic.

## The loop (per task)

```
question
  └─ signature()            deterministic: lift typed slots (NAME/DOB/DATE/MONEY/CODE…) → skeleton
  └─ Knowledge.resolveIntent()   learned: skeleton-cache → keyword-overlap → Haiku classify()  → intent
       ├─ intent has a Plan? ── replay()      re-bind slots, run the saved nav steps, one Haiku extract
       │                                       grounded? → ANSWER (fast, ~1–2 calls)
       └─ no plan / replay failed ── agentic ReAct loop (tools) ──► grounded answer?
                                          └─ induce() a Plan from the trajectory, store under intent
                                          └─ ANSWER   (next same-intent question will replay)
```

- **Classifications are not set before the run.** `Knowledge` starts empty. The first question of a
  kind mints an intent (Haiku names it so rephrasings reuse the label); the first *solve* of that
  intent induces the plan. Everything after replays.
- **Never-wrong is absolute.** `ground.ts` accepts an answer only if its value appears in content the
  agent actually read. A wrong turn costs time and a skip (0), never a −1. This is what makes the
  aggressive exploration safe.
- **Site-agnostic.** The agent discovers routes via `goto`/`links`/`search_patient`; induced plans
  encode what worked on *this* clinic (with `{PATIENT}`/`{ROLE}` placeholders), not hardcoded paths.
  If a replay stops grounding (site differs), the plan is dropped and re-learned.

## Files
| file | role |
|---|---|
| `types.ts` | Signature, Slot, Classifier, Plan, Observation |
| `signature.ts` | deterministic question → skeleton + typed slots (no LLM) |
| `memory.ts` | `Knowledge`: skeleton→intent cache + intent→Classifier(plan), learned at runtime |
| `llm.ts` | Haiku 5.5: `classify()` (name intent), `step()` (one ReAct turn), `extract()` (grounded read) |
| `tools.ts` | the action space over `Crawler`: goto / read_text / links / search_patient / read_table / read_document / answer / give_up |
| `plan.ts` | `induce()` a plan from a successful trajectory, `replay()` it for later same-intent questions |
| `ground.ts` | the never-wrong gate (value must appear in observed content) |
| `solver.ts` | the per-task loop (replay → agentic → induce) |
| `shiftMain.ts` | entrypoint: queue loop, message→context, task→solve |

## Running it
```bash
# local smoke (deterministic parts)
npx tsx -e "import {signature} from './src/adaptive/signature.js'; console.log(signature('What phone number do we have on file for patient Carol Jones (born 1982-09-07)?'))"

# full shift (needs the judge env: QUEUE_URL / SITE_URL / creds / LLM_BASE_URL / LLM_API_KEY)
npx tsx src/adaptive/shiftMain.ts
```
To ship it as the agent, build an image whose `CMD` is `["npx","tsx","src/adaptive/shiftMain.ts"]`
(the wrenfield agent stays the default CMD and the fallback).

## Tunables
- `AGENT_MODEL` (default `anthropic/claude-haiku-5.5`) — reasoning model for classify/step/extract.
- `ADAPTIVE_MAX_STEPS` (default 8) — ReAct budget per unknown question.
- `ADAPTIVE_TASK_MS` (default 25000) — hard per-task wall clock (also bounded by the shift deadline).
