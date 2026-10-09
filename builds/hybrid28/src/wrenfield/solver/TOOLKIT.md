# solver/ — capability toolkit + site model (branch `solver-toolkit`)

The Plan contract (plan schema, vocabulary, `World`, executor, acceptance gates) is `README.md` / `plan.ts` /
`exec.ts` on `solver-compiler`. This branch is the other half: **what the agent can read from the clinic
site, and proof that it read all of it**. New files only; no existing file changes.

| File | What |
|---|---|
| `pageRead.ts` | One structural reading of any page, by labels (browser JS + jsdom): tables (caption / aria-label / heading, header labels, cells + links + custom-font digit segments), the count footer and Next / Show-more that belong to *each* table, `<dl>` label → value blocks, labelled filter controls, tabs, gates, image documents. |
| `siteModel.ts` + `siteModel.data.json` | Per entity: where it is listed (clinic-wide / one patient's chart / a parent page), reached by **label** (chart tab "Documents", in-app link "Activity" — URLs differ: Set 1 `/audit-log` + chart `/files`, practice `/activity` + chart `/documents`), the filter controls by label, the table (title + required headers), detail page blocks, field synonyms. The JSON is generated (`buildSiteModel.ts`) from the three Set 1 recon dumps + a practice-site crawl (`siteCrawl-live.ts`); it stores labels, option lists, value shapes and paging seen — no record data. |
| `listJudge.ts` | Completeness proof for any list (pure): Next pagers (continuous ranges, exact end), Show more (prefix never changes, end at the stated total), "N things" counts, "No … on file", capped lists ("200+", "No more results", "about N" cut short) decline. |
| `toolkit.ts` | The uniform live API (below). |
| `dates.ts`, `lookup.ts` | Exact date / business-day / money arithmetic; governing-message table lookups. |
| `world.ts` | `fillWorld(tk, plan.needs, inputs)` → the executor's `World` (vocabulary fields ← site labels). |
| `toolkit-test.ts` | Gate: captured Set 1 HTML (jsdom) vs the dumps' decoded-text oracle + every judge rule + dates/lookup. |
| `toolkit-live.ts` | Practice site vs an independent raw-text oracle (own paging, own form filling). |

## API (`toolkit.ts`) — every call returns `{ok:true, value, proof}` or `{ok:false, why}`

```ts
const tk = new Toolkit(crawler, log);
tk.getPatient(name, dob?)                       // patientResolve (DOB search, or sorted name list read past the name)
tk.listEntities(entity, scope, filters, {patientHref?, parentUrl?, budgetMs?})
                                               // → { rows: [{cells: {label: text}, links}], headers }
                                               //   appointment/clinic → apptList.ApptList (proven walk)
tk.getFields(entity, detailHref, ["status", "Visit.Date", …])   // label → value blocks; "Block.Label" narrows
rowFields(entity, row, fields)                  // a listed row's cells by header label (pure)
tk.readImageDoc("lab", docHref, {need, vocab})  // labRead: tesseract ∥ model must agree (tiebreak), else decline
tk.readImageDoc("remit", docHref, {expect})     // remitRead, same rule
dates.*  (parseDate, addDays/Months/Years, addBusinessDays, businessDaysBetween, rollToOpen, ageOn, cents, money, percentOf)
lookup.* (findTable(message, headers), lookup(table, where, want), band(table, rangeCol, x, want))
```

`proof.strength`: `"page"` — the site states the count/end (safe for absence answers: 0, "no dose", "no
claim"); `"model"` — complete only by the site model (a table never seen paged on a full capture; an "about N"
list that ended within tolerance). An executor that answers from an ABSENCE must require `"page"`.

Never: pressing write controls or gates (operate.ts refuses; restricted charts decline), returning digits
drawn in a scrambled font without an exact per-family map (`decodeRead` → decline), trusting a list filter
without re-checking the rows (`recheck`), guessing a column (0 or ≥ 2 label matches → decline).

## How the other pieces plug in

- **Executor** (`solver-compiler` exec.ts, `coverage-exec`): `fillWorld(tk, plan.needs, inputs)` →
  `World`; structured `need.filters` (`{from, to, type, status, location…}` = siteModel `ListSpec.filters`
  keys) are applied by the list's own labelled controls and re-checked on the rows; prose filters are left to
  the plan's `where`. A vocabulary field without a site source in `FIELD_MAP` declines (extend the map, or
  read it with the family reader that owns it: claims → claimReader, labs → labLive).
- **Count / lookup executor** (`coverage-count`): `listEntities` for any entity, `rowFields` /
  `getFields` for values, `proof.strength` for zero counts.
- **Planner prompt**: `modelSummary()` (siteModel.ts) lists entities, scopes, filters and fields.
- **Deterministic families** stay authoritative; nothing here is wired into `index-builder` / `solvers`.

## Rebuild / test

    npx tsx src/wrenfield/solver/toolkit-test.ts                       # in gates
    npx tsx src/wrenfield/solver/buildSiteModel.ts [practice-crawl.jsonl]
    # live (practice site, read-only), in the agent image:
    scripts/dk run --rm --platform linux/amd64 --shm-size=1g -v "$PWD/hybrid-build/src:/app/src" -v "$OUT:/out" \
      -e WORK_DIR=/tmp <speedrun-agent image> sh -c "npx tsx src/wrenfield/solver/siteCrawl-live.ts /out/practice-crawl.jsonl; npx tsx src/wrenfield/solver/toolkit-live.ts"

## Measured (commit of this section)

- `toolkit-test.ts` (gates): 205 checks, 0 failed — every Set 1 page read; every entity list that Set 1 captured
  maps to exactly one table; claims/remittances/immunizations/chart documents vs the dumps' decoded text; a
  capped capture (recon HTML is cut at 14,000 chars: 12 of 21 remittances, footer lost) DECLINES; scrambled lot
  digits decline without a map and decode to the decoded text with one; 26 judge rules; dates/money/lookup.
- `toolkit-live.ts` (practice site, independent raw-text oracle): **45 right, 0 wrong, 3 declined** — 8/8
  patients resolved, per-chart appointments (+ every row date), documents, invoices, problems, activity across
  6 charts (Show more, "N things", "No conditions recorded", "No documents in this chart"), 3 invoice detail
  pages, clinic Documents filtered by Type + Received frto by label (19 = oracle 19). Declines: a clinic
  activity day whose pager restarted at row 1 (list not provably complete), a chart with "No single appointments
  on record." (qualified statement: recurring series may exist), one chart's activity table not found.
- Practice vs Set 1 differences the model now carries: chart documents `/files` vs `/documents`, clinic activity
  `/audit-log` vs `/activity`, chart appointments Show more (Set 1) vs Next pager (practice) — all reached and
  paged by label/footer, not by URL or a fixed paging assumption.
- `scripts/gates.sh`: 47 suites rc=0. `VARIANTS_DOCKER=1 scripts/variants.sh`: parity 0 answered changed, 0 new
  answers, page DIFFERENT 0 (no existing file changed except the gates list).
