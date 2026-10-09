# solver/ — general workflow solver: message → Plan → deterministic execution

Shared contract for the general solver. Deterministic families (`families.ts` / `solvers.ts`) stay
authoritative for every task they take; this path is for tasks **no family takes**, governed by a policy
message we have never seen. A model writes a **Plan** from the message; a deterministic **executor** runs it
with the capability toolkit; the model never computes the final answer.

Pieces:

| Piece | File(s) |
|---|---|
| Plan schema, vocabulary, validator | `plan.ts` (this contract in code) |
| Exact numbers + calendar ops | `num.ts` |
| Reference executor over a `World` | `exec.ts` |
| message → Plan compiler, example worlds, plan verifier | `example.ts`, `compile.ts`, `verify.ts` |
| Corpus + per-message bench | `corpus.ts`, `bench.ts`, `selftest.ts` (gates) |
| Live toolkit: fills a `World` from the site (patientResolve/nameResolve/contextResolve, apptList + operate.ts, label readers / pageScripts, labRead/remitRead, pacer) | `toolkit*.ts` (planned) |

## Plan

```jsonc
{
  "workflow": "short title",
  "inputs":  [{ "name": "patient", "type": "patient" }, { "name": "dos", "type": "date" }],
  "constants": { "today": "2026-10-14" },            // facts stated by the message (dates, limits)
  "tables": { "remarks": { "headers": ["Remark","Field"], "rows": [["N290","RENDERING_PROVIDER_ID"]] } },
  "needs": [{ "entity": "claim", "scope": "patient", "filters": "dos = inputs.dos", "fields": ["dos","payer","lines"] }],
  "steps": [{ "id": "claim", "expr": { "op": "one", "from": { "op": "select", "entity": "claim",
             "where": { "op": "eq", "a": { "var": "$.dos" }, "b": { "var": "inputs.dos" } } } } }],
  "answer": { "op": "concat", "parts": ["APPEAL:", { "op": "fmt", "value": { "var": "steps.last" }, "as": "date" }] }
}
```

- **inputs** — named slots from the task. Types: `patient` (name + optional DOB; resolved by the toolkit to
  one record, `inputs.patient` is that record), `date`, `time` (HH:MM 24 h), `int`, `dec`, `text`, `id`.
- **constants / tables** — numbers, dates and tables copied from the message (the message is the rule).
- **needs** — what the toolkit must read: `entity`, `scope` (`patient` = only the resolved patient's
  records incl. merged duplicates; `clinic` = clinic-wide, complete read), `filters` (prose / expr hint),
  `fields`. The toolkit must prove completeness (all pages, all locations) for `clinic` scope and any
  absence the answer depends on.
- **steps** — `{id, expr}` let-bindings, evaluated **lazily** (on first use, memoised): data a branch doesn't
  use is never required. An error / `decline` / unknown on the answer's path → skip.
- **answer** — an expr producing the answer string. Must be one of the message's answer forms.

## Expressions

`literal` | `{"var":"inputs.x" | "steps.x" | "constants.x" | "$" | "$.field.sub" | "$$.field"}` | `{"op": …, args}`.
A bare string `"$.field"` / `"$$.field"` / `"$"` is normalised to a var (models write that shorthand).
`$` is the current item inside `where`/`to`/`by` lambdas, `$$` the outer item in a nested lambda.
Numbers are exact rationals (no floats); dates are `YYYY-MM-DD` strings; null propagates as "unknown"
and an unknown that reaches the answer is a decline.

| Group | Ops |
|---|---|
| data | `select{entity, where?}` `filter{from, where}` `map{from, to}` `flatMap{from, to}` `count{from}` `sum{from, of?}` `min{from, of?}` `max{from, of?}` `argmax{from, by, tie?: "error"\|"first"\|"last"}` `argmin{…}` `one{from}` (exactly one, else decline) `first{from}` `sortBy{from, by, desc?}` `distinct{from, by?}` `any{from, where}` `all{from, where}` `get{from, field}` `len{from}` `in{value, list}` `rows{table}` `lookup{table, match:{col: expr}, column}` (exactly one row) |
| logic | `and{args}` `or{args}` `not{a}` `if{cond, then, else}` `eq` `ne` `lt` `le` `gt` `ge` (`{a, b}`; numbers numerically, dates as ISO) `isNull{a}` `coalesce{args}` |
| text | `contains{text, any:[…]}` (case-insensitive) `startsWith{text, prefix}` `matches{text, regex}` `concat{parts}` `join{from, sep}` `upper{a}` `lower{a}` `split{text, sep}` `num{a}` (parse decimal) `fmt{value, as: date\|money2\|int\|text\|dec}` |
| arithmetic | `add` `sub` `mul` `div` (`{a, b}`) `abs{a}` `pctChange{from, to}` (\|to−from\| / from × 100) `neg{a}` |
| dates | `addDays{date, n}` `addMonths{date, n}` (clamps to month end) `addYears{date, n, feb29?: "feb28"\|"mar1"}` `daysBetween{from, to}` `ageOn{dob, on}` `weekday{date}` (1=Mon…7=Sun) `isOpen{date, closed, weekends?}` `businessDaysBetween{after, through, closed}` (count in (after, through]) `addBusinessDays{date, n, closed}` `prevOpenDay{date, closed}` (on or before) `today{}` |
| rules | `firstMatch{cases:[{when, then}], else?}` (priority order) `decline{why}` |
| names | `sameName{a, b}` — person / provider / payer names equal ignoring order, commas, case, accents, credentials |
| judgement | `classify{text, question, labels}` — the toolkit answers from the text with two agreeing model reads, else unknown. Only for reading free text (notes), never for the answer. |

## Vocabulary (`plan.ts` VOCAB)

entity → fields. Lists of sub-records are written `name[{…}]`.

- patient: id recordNumber name dob sex insured payer plan memberId problems[] restricted test merged
- appointment: id patientId date start status location provider service bookedOn startMovedOn[] recurring
- document: id patientId type title date received collected panel reportNumber recordNumber results[{test value unit}] doses[{vaccine date}]
- invoice: id number patientId issued serviceDate location status total payments[{date amount}] balance
- claim: id number patientId dos payer type filed primaryRemitArrived originalRemitArrived lines[{code modifiers[] description billed}] submissions[{date status by accepted resultDate}] accountNotes[{date text}]
- remittance: id number claimId kind paymentDate reverses scanned lines[{code modifiers[] adjustments[{group reason amount}] remarks[]}]
- authorization: id patientId payer code service validFrom validTo status
- coverage: id patientId payer plan from to subscriberIsPatient
- immunization: id patientId vaccine date status lot location givenElsewhere
- note: id patientId date type author text
- lot: id number vaccine location received
- activity: id appointmentId patientId date kind detail
- closure: id date status scope location name
- provider: id name specialty active
- payer: id name appealsDays claimsDays plans[] filingTerms[{effective originalDays originalMonths secondaryDays correctedDays}]

References between records hold the **name as the site shows it** (appointment.provider = "Jane Roe, MD",
claim.payer = payer name, closure.location = location name); only `*Id` fields and `remittance.reverses` hold ids.

## World

The executor reads a `World`: `{ inputs: {name: value}, entities: {entity: record[]}, resolved?: {patient: id} }`.
The live toolkit builds it from the site; the verifier builds it from the message's worked example
(recorded page data when available; otherwise, an independent model call encodes facts from the example).

## Acceptance (verify.ts)

A plan is accepted only if all hold:
1. structurally valid (known ops / entities / fields, every `var` defined before use, answer forms parse);
2. on the example world, with inputs extracted from the example request, it reproduces the message's
   worked-example answer **exactly**;
3. a second plan, written independently (different model or seed, no sight of the first), also passes 1–2,
   and both give the same output (answer or decline) on N mutated copies of the example world.
   "Same output" counts only when informative: both plans must answer (not decline) on ≥ max(5, N/4) mutations.
4. no literal in the plan equals the example's answer (or its suffix) unless the rule text has it (hardcode guard).
If exactly one of the first two plans passes, a third writer (temperature 0.5) gets one chance to be the second.
Each writer gets ≤ 2 repair rounds for validation issues and 1 learning round showing the executor's step
values on the example (never the expected answer).
Any failure → no plan → the task is skipped with the failure reason.

## Live use (`index.ts`)

```ts
const c = await compileWorkflow(messageText);           // once per workflow message (≈ 1–3 min of model time, ≈ $0.10–0.40)
const r = await solveTask(c, taskText, toolkit);        // inputs (haiku) → toolkit.world(plan, inputs) → runPlan → answer-form gate
// AGENT_SOLVER = off | shadow (default: log only) | on
```
`Toolkit.world(plan, inputs)` is the toolkit branch's job: read what `plan.needs` lists (patient via patientFor,
lists via apptList/operate with completeness proofs, documents via labRead/remitRead) into a `World` with these
entity/field names. `answerFormOk` rejects any answer outside the message's own forms. Model calls go through
`failover.chat` one at a time (the judge proxy allows one in flight).

## Bench

`npx tsx src/wrenfield/solver/bench.ts [--ids …] [--variants orig,restyle,bullets] [--budget $]` with
`LLM_BASE_URL/LLM_API_KEY` (OpenRouter offline). Example worlds are cached in `fixtures/solver/worlds/<base>.json`
(shared by every rewording of a message); results (both plans per message) in `bench/solver/*.json`.
`selftest.ts` (gates) is offline: num/exec/validator/example extraction/hand plans/pipeline with a canned model.

## Measured (2026-10-08, plans: sonnet-5.5 ×2 at temp 0 / 0.8, world: sonnet-5.5, inputs + classify: haiku-5.5 (+ sonnet), 40 mutations)

| Message | Result | Notes (`bench/solver/run-*.json`) |
|---|---|---|
| set1-1 lab triage | **accepted** (39/40 mutations both answered, 10 distinct answers) | first run rejected: example world had no record numbers / sex → fixed in the world-builder rules |
| set1-30 tetanus | **accepted** (40/40, 11 distinct) | uses `classify` for the wound note |
| set1-76 recall count | rejected | run 1: plan A forgot "already notified" (17 vs 4); run 2: `classify` got an unevaluated question (fixed); run 3: A answered 0, B reproduced 4, third writer failed |
| set1-120 claim next step | **accepted** (34/40, 5 distinct) | first run: B evaluated the reason-29 branch eagerly → lazy steps |
| set1-150 filing deadline | **accepted**; restyle + bullets variants **accepted** | |
| set1-198 good-faith estimate | **accepted**; restyle **accepted** | first run: boolean `eq(false, true)` was unknown → fixed |
| practice new/established | **accepted**; restyle **accepted** | first run: provider referenced by id → names-not-ids rule + `sameName` |
| loop invoiceOwed | **accepted**; bullets **accepted**; restyle rejected | restyle: plan A declared an optional patient input → now null, not resolved (not re-measured) |
| loop latestReferral | **accepted** | |
| loop invoiceCount / docCount / dashToday | rejected | no worked example in the message → nothing to verify against (by design) |

Cost ≈ $0.08–0.40 per message (lab/claim/recall dearest; recall's `classify` per note), ≈ $4.6 for all runs.
Example worlds are model-encoded from the example's explanation (`fixtures/solver/worlds/`), not recorded
pages; a plan that reproduces them can still mis-read the live site — the toolkit's World and the answer-form
gate carry that risk, and `AGENT_SOLVER` stays `shadow` until a live bench says otherwise.
