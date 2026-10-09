/**
 * Shift pacer: reach every item of a set whose size we don't know, losing as few points as possible.
 *
 * The queue never says how many items are left. SHIFT_SECONDS does: the public set is 240 items (224 tasks +
 * 16 messages) in 900 s, and a scored set is that size or larger (Set 3 = 458 tasks; its old runs left 200 not
 * reached). So two sizes are kept:
 *   e1 = 240 × SHIFT/900 items (the public density)   — "a Set-1-sized run"
 *   e2 = 2 × e1                                       — "the set could be twice as dense"
 * Past e1 items the set IS bigger, and e1 is replaced by e2 (past e2, by 1.25 × seen).
 *
 * Two tiers, both of which only ever turn an attempt into a skip (0) — never an answer into another answer:
 *
 *  A (cheap, vs e1 — e2 once past e1 items): when the attempt-everything projection doesn't fit, stop paying for work that
 *    has not paid yet: a family with 0 answers in ≥ ZERO_TRIES attempts is skipped instantly (every
 *    RESAMPLE-th one is still tried, so a family that starts answering comes back), a task of no known family
 *    is skipped instantly, and the skip probe is off. A Set-1-sized run loses nothing here: a family that
 *    never answers gave 0 anyway.
 *  B (costly, vs e1): when the projection still doesn't fit, families are dropped in order of lowest
 *    answers per second (measured in this shift, Set 1 priors until there are samples) until it fits. On a
 *    Set-1-sized run that fits (Set 1: ~504 s of item time in 900 s), B never triggers.
 *    Lab is dropped at its read (solvers.ts asks labWhy), so NOT_COVERED answers stay.
 *
 * The hidden-set tiers (AGENT_PACER_TIERS=slack, default; `v1` = the old rule). A task no family takes is paced as
 * "workflow-exec" / "best-effort" / "lookup" (shiftMain's paceKey), and its tier attempt (executor, learner, best effort,
 * lookup) asks extraOk. The old rule priced every future tier task at its full attempt cost in the projection, so the tiers'
 * own cost said "behind" (tier A: slack 0) and every attempt was refused — and each refused item was booked as a 0-answer
 * try, so tier A then skipped the tier outright (Site C, s3: 87 best-effort + 80 executor "no slack" refusals; Set 2:
 * 540-700 s of the shift unused). Now:
 *  - the projection prices a tier task at its FLOOR (what the item costs when the attempt is refused: routing, crawl, skip),
 *    measured in this shift (the item time minus the attempt time). Families keep their measured cost: the floor projection
 *    is what reach needs, and Set 1 (every task family-claimed, no tier key) projects exactly as before;
 *  - the tier budget = seconds left − 1.15 × floor projection of the rest (lo − seen items at this shift's mix) − a hard end
 *    reserve (AGENT_PACER_TIER_RESERVE_S, default max(24 s, 3 % of the shift));
 *  - the budget goes to the tiers in order of measured answers per second of ATTEMPT time (priors TIER_PRIORS, weight 2):
 *    a tier whose remaining demand (its asks per item × items left × its attempt cost) fits is admitted every time, the
 *    marginal one at the fraction of its demand that fits (a deterministic rate, spread over the rest of the shift), the
 *    rest not at all; a tier under AGENT_PACER_TIER_VMIN answers per second is admitted at most every RESAMPLE-th ask;
 *  - a refused item is a floor sample, never a 0-answer try; an admitted attempt that burns time without an answer lowers
 *    that tier's answers per second (its admission rate), not the shift's projection.
 * Every attempt still needs the budget it may spend (estS) now, so an admitted attempt can never take reach.
 */
const num = (k: string, d: number) => { const n = Number(process.env[k]); return Number.isFinite(n) && n > 0 ? n : d; };

/** Set 1 (baseline, run-146-set1.log): mean seconds per task and answers per task, by family. */
export const PRIORS: Record<string, { s: number; y: number }> = {
  "lab-report-triage": { s: 4.9, y: 0.84 }, "claim-next-step": { s: 2.3, y: 0.53 }, "referral-reason": { s: 7.5, y: 1 },
  "tetanus-wound": { s: 2.75, y: 0.58 }, "good-faith-estimate": { s: 2.4, y: 0.15 }, "patient-phone": { s: 1.36, y: 1 },
  "filing-deadline": { s: 1.7, y: 0 }, "invoice-balance": { s: 0.33, y: 1 }, "referral-source": { s: 1.24, y: 1 },
  "vaccine-lot-recall": { s: 0.12, y: 0 },
  // the appointment-list aggregates (apptList: Show-more reads, 20 rows a press, ~0.2-0.3 s a press). Run 265 read the 8 month counts (425-2,400 rows) and top-k on 3 tabs:
  // 97 s, 0 answers, a 503 and an account suspension. With AGG_MAX_REQ=17 (default) only a list of <= ~330 rows is read (item 83's kind, ~3 s, answers);
  // the month counts and top-k (22-120 and ~150 requests) decline from their first page, ~0.3 s. Raise AGG_MAX_REQ / AGG_TOPK and these priors with it.
  "location-month-distinct-patients": { s: 0.6, y: 0.05 }, "location-completed-before-time": { s: 4, y: 0.8 }, "top-providers-completed-month": { s: 0.4, y: 0 },
  "provider-day-scheduled-count": { s: 0.08, y: 1 }, "provider-open-slots": { s: 0.08, y: 1 }, "provider-day-completed-count": { s: 0.08, y: 1 },
  "(message)": { s: 1.5, y: 0 }, "(none)": { s: 2.0, y: 0.1 },
  // the workflow executor (wfShadow.ts, tasks no family takes that a captured workflow message routes): its own family,
  // so its cost never passes for an instant skip's and tier A/B drop it first when behind (prior: gather + 3 parallel runs)
  "workflow-exec": { s: 12, y: 0.6 },
  // the lookup path (lookup.ts: one chart list or label block per task, no model): measured 3.0 s per task on practice
  "lookup": { s: 3.5, y: 0.5 },
  // the best-effort tier (bestEffort.ts): unrouted tasks it attempts; prior = gather + votes, measured yield on the benches
  "best-effort": { s: 15, y: 0.4 },
};
const MSG = "(message)", NONE = "(none)", LAB = "lab-report-triage";
/** The hidden-set tiers' pace keys (shiftMain: tasks no family takes). */
export const TIER_KEYS = new Set(["workflow-exec", "best-effort", "lookup"]);
/** Seconds and answers per ADMITTED attempt (the attempt only, not the item's routing / crawl): executor + learner, measured
 *  median 7.5 s (GATHER.md jev-4: 49/49 right, p90 12.2 s; Site C 51 runs median 1.9 s, many fast "patient not resolved"),
 *  best effort median 12.9 s and 0.28 answered per attempt that browses (BEST-EFFORT.md), lookup 3.0-3.5 s. */
export const TIER_PRIORS: Record<string, { s: number; y: number }> = { "workflow-exec": { s: 9, y: 0.45 }, "best-effort": { s: 13, y: 0.28 }, lookup: { s: 3.5, y: 0.4 } };
/** Prior seconds of a tier task whose attempt is refused (Set 2: skips close in < 300 ms; Site C: ~1.6 s with the patient crawl). */
const TIER_FLOOR_S = 1;
type TStat = { asks: number; tried: number; ans: number; ms: number; acc: number; rate: number };

/** AGENT_PACER=v2 (value per second, see "v2" below). Priors measured on Set 1 by the 265 and 278 runs (seconds and answers per tried item;
 *  the aggregates answered 0 of 13 tries at ~12 s, top providers 0 of 1 at 36 s). They are only the starting point: every figure is blended
 *  with this shift's samples at weight 2 and the plan is recomputed at the start of every item. */
export const PRIORS2: Record<string, { s: number; y: number }> = {
  ...PRIORS,
  "lab-report-triage": { s: 6, y: 0.9 }, "claim-next-step": { s: 3.5, y: 0.7 }, "tetanus-wound": { s: 5, y: 0.8 }, "filing-deadline": { s: 3.5, y: 0.75 },
  "good-faith-estimate": { s: 2.5, y: 0.6 }, "referral-reason": { s: 8, y: 0.75 }, "vaccine-lot-recall": { s: 3, y: 0.4 },
  "location-month-distinct-patients": { s: 14, y: 0.12 }, "top-providers-completed-month": { s: 36, y: 0.15 }, "location-completed-before-time": { s: 3, y: 0.5 },
};
/** Add-on reads (not families): a scanned remittance (13 s measured), a lab's Documents list (+5-9 s, not the 2 s the call site assumes) and a
 *  visit day's appointment list for a name-only patient (2 answers of 7 tries in 265, ~9 s each). */
export const XPRIORS: Record<string, { s: number; y: number }> = {
  scan: { s: 13, y: 0.9 }, "ctx:the Documents read": { s: 8, y: 0.85 }, "ctx:the visit-day list read": { s: 9, y: 0.28 }, wf: { s: 16, y: 0.5 }, lookup: { s: 3.5, y: 0.5 },
};
type XStat = { req: number; tried: number; ans: number; ms: number };

type Stat = { n: number; tried: number; ans: number; ms: number; instant: number; since: number; fN: number; fMs: number };

export class Pacer {
  private seen = 0; private secondsLeft = Infinity; private startedAt = 0;
  private stats = new Map<string, Stat>(); private labOk: number[] = [];
  private dropped = new Set<string>(); private tierA = false; private tierB = false; private lastNote = "";
  readonly e1: number;
  /** Items seen so far (the spend governor's item-based projection). */
  get itemsSeen(): number { return this.seen; }
  /** Tier B (dropping families / lab reads) needs this many items seen: Set 1 opens with ~40 lab tasks (~12 s each),
   *  so an early projection says "behind" on a run that finishes in 545 s (run 164: 5 labs lost at item 41). */
  tierBMinSeen = num("AGENT_PACER_TIERB_MIN_SEEN", 80);
  constructor(
    shiftSeconds = num("SHIFT_SECONDS", 900),
    expected = num("AGENT_EXPECTED_ITEMS", 0),
    private margin = num("AGENT_PACER_MARGIN_S", 8),
    private minSeen = num("AGENT_PACER_MIN_SEEN", 20),
    private zeroTries = num("AGENT_PACER_ZERO_TRIES", 6),
    private resample = num("AGENT_PACER_RESAMPLE", 3),
    private instantS = 0.08,
    private keepYps = num("AGENT_PACER_KEEP_YPS", 0.5), // a family answering ≥ this many per second is never dropped (invoice, provider-day, phone)
    private now: () => number = Date.now,
    /** AGENT_PACER=v2: value-per-second admission (plan() below); v1 (default) is the tiers above. */
    readonly v2 = (process.env.AGENT_PACER ?? "").toLowerCase() === "v2",
  ) { this.e1 = expected || Math.round(240 * shiftSeconds / 900); this.shift = shiftSeconds; this.tierReserveS = num("AGENT_PACER_TIER_RESERVE_S", Math.max(24, 0.03 * shiftSeconds)); }
  private shift: number;
  // ───────────────────────── the hidden-set tiers (see the header) ─────────────────────────
  /** AGENT_PACER_TIERS=v1 restores the old rule (a tier attempt = any extra: v1 slack, full attempt cost in the projection). */
  tierMode = (process.env.AGENT_PACER_TIERS ?? "slack").toLowerCase() !== "v1";
  tierReserveS: number; tierFloorF = num("AGENT_PACER_TIER_FLOOR_F", 1.15); tierVMin = num("AGENT_PACER_TIER_VMIN", 0.004);
  private ts = new Map<string, TStat>(); private curKey: string | null = null;
  /** this item: the tier whose attempt was admitted (null = none yet), when, and which tiers asked */
  private tierKey: string | null = null; private tierAt = 0; private asked = new Set<string>();
  /** a second tier in the same item (best effort after the executor declined): its own rate, its own seconds */
  private tierKey2: string | null = null; private tierAt2 = 0;
  private tierBase = Infinity; private lastTierNote = "";
  private tst(k: string): TStat { let x = this.ts.get(k); if (!x) this.ts.set(k, x = { asks: 0, tried: 0, ans: 0, ms: 0, acc: 1, rate: 1 }); return x; }
  private tc(k: string) { const x = this.tst(k), p = TIER_PRIORS[k] ?? TIER_PRIORS["best-effort"]; return (p.s * 2 + x.ms / 1000) / (2 + x.tried); }
  private ty(k: string) { const x = this.tst(k), p = TIER_PRIORS[k] ?? TIER_PRIORS["best-effort"]; return (p.y * 2 + x.ans) / (2 + x.tried); }
  private floorCost(f: string) { const s = this.st(f); return (TIER_FLOOR_S * 2 + s.fMs / 1000) / (2 + s.fN); }
  private isTier(f: string) { return this.tierMode && TIER_KEYS.has(f); }
  /** Plan the tiers at the start of an item: the budget (floor projection) and each tier's admission rate. */
  private tierPlan(left: number) {
    this.tierBase = Infinity;
    if (!this.tierMode || !Number.isFinite(this.secondsLeft)) return;
    if (this.seen < this.minSeen) { this.tierBase = left - this.tierReserveS; return; } // no pace yet: only the end reserve
    const { lo } = this.sizes(), rem = Math.max(0, lo - this.seen);
    const floor = this.project(rem, false, new Set());
    this.tierBase = left - this.tierFloorF * floor - this.tierReserveS;
    let budget = this.tierBase;
    const tiers = [...this.ts.keys()].filter((k) => this.tst(k).asks > 0).sort((a, b) => this.ty(b) / this.tc(b) - this.ty(a) / this.tc(a));
    for (const k of tiers) {
      const x = this.tst(k), demand = rem * (x.asks / Math.max(1, this.seen)) * this.tc(k);
      x.rate = budget <= 0 ? 0 : demand <= budget ? 1 : budget / demand; budget -= demand;
      if (this.ty(k) / this.tc(k) < this.tierVMin) x.rate = Math.min(x.rate, 1 / this.resample);
    }
    const note = tiers.map((k) => `${k}:${this.tst(k).rate.toFixed(1)}`).join(",") + (this.tierBase < 0 ? ",none" : "");
    if (tiers.length && (note !== this.lastTierNote || this.seen % 50 === 0)) {
      this.lastTierNote = note;
      try { process.stdout.write(JSON.stringify({ event: "pacer_tiers", seen: this.seen, left: Math.round(left), lo, floor: Math.round(floor), budget: Math.round(this.tierBase),
        tiers: Object.fromEntries(tiers.map((k) => { const x = this.tst(k); return [k, { rate: +x.rate.toFixed(2), s: +this.tc(k).toFixed(1), y: +this.ty(k).toFixed(2), asks: x.asks, tried: x.tried, ans: x.ans }]; })) }) + "\n"); } catch {}
    }
  }
  /** A tier attempt's admission (extraOk inside a tier task): the budget must hold estS now; the first attempt of an item also
   *  passes its tier's rate; a later one in the same item (the learner after the executor, best effort after it) only the budget. */
  private tierOk(k: string, estS: number): boolean {
    const slack = this.tierBase - (this.now() - this.startedAt) / 1000;
    if (this.tierKey === k || this.tierKey2 === k) return slack >= estS; // the same tier again (the learner, round 2)
    const x = this.tst(k); if (!this.asked.has(k)) { this.asked.add(k); x.asks++; }
    if (slack < estS) return false;
    x.acc = Math.min(1, x.acc + x.rate); if (x.acc < 1 - 1e-9) return false;
    x.acc -= 1;
    if (!this.tierKey) { this.tierKey = k; this.tierAt = this.now(); } else { this.tierKey2 = k; this.tierAt2 = this.now(); }
    return true;
  }
  /** the learner's ask (learn/learner.ts: AGENT_LEARN_TASK_S) inside an executor item is the executor's attempt; any other "extra" is best effort */
  private learnS() { return num("AGENT_LEARN_TASK_S", 15); }
  /** Seconds of tier budget now (Infinity before there is a clock). */
  tierSlackS(): number { return this.tierBase - (this.now() - this.startedAt) / 1000; }
  /** Re-read the AGENT_PACER_* knobs from the env: a per-set profile (profile.ts) sets them after this module built `pacer`.
   *  Call it before the first item; the defaults repeat the constructor's (profile.test.ts compares reload() with a fresh Pacer). */
  reload(): void {
    this.tierBMinSeen = num("AGENT_PACER_TIERB_MIN_SEEN", 80); this.tierMode = (process.env.AGENT_PACER_TIERS ?? "slack").toLowerCase() !== "v1";
    this.tierReserveS = num("AGENT_PACER_TIER_RESERVE_S", Math.max(24, 0.03 * this.shift)); this.tierFloorF = num("AGENT_PACER_TIER_FLOOR_F", 1.15); this.tierVMin = num("AGENT_PACER_TIER_VMIN", 0.004); this.extraReserve = num("AGENT_PACER_EXTRA_RESERVE_S", 30); this.ctxShare = num("AGENT_PACER_CTX_SHARE", 0.06);
    this.margin = num("AGENT_PACER_MARGIN_S", 8); this.minSeen = num("AGENT_PACER_MIN_SEEN", 20); this.zeroTries = num("AGENT_PACER_ZERO_TRIES", 6);
    this.resample = num("AGENT_PACER_RESAMPLE", 3); this.keepYps = num("AGENT_PACER_KEEP_YPS", 0.5);
  }

  private st(f: string): Stat { let s = this.stats.get(f); if (!s) this.stats.set(f, s = { n: 0, tried: 0, ans: 0, ms: 0, instant: 0, since: 0, fN: 0, fMs: 0 }); return s; }
  /** Seconds per attempt and answers per attempt: Set 1 prior blended with this shift (prior weight 2). */
  private cost(f: string) { const s = this.st(f), p = PRIORS[f] ?? PRIORS[NONE]; return (p.s * 2 + s.ms / 1000) / (2 + s.tried); }
  private yieldOf(f: string) { const s = this.st(f), p = PRIORS[f] ?? PRIORS[NONE]; return (p.y * 2 + s.ans) / (2 + s.tried); }
  private zero(f: string) { const s = this.st(f); return f !== MSG && s.tried >= this.zeroTries && s.ans === 0; }
  private left() { return this.secondsLeft - (this.now() - this.startedAt) / 1000 - this.margin; }
  private sizes() {
    const e2 = 2 * this.e1;
    const hi = this.seen < e2 ? e2 : Math.ceil(this.seen * 1.25);
    const lo = this.seen < this.e1 ? this.e1 : hi;
    return { lo, hi };
  }
  /** Projected seconds for `remaining` items with this shift's family mix; `skipZero` / `drop` cost an instant skip. */
  private project(remaining: number, skipZero: boolean, drop: Set<string>) {
    let per = 0;
    for (const [f, s] of this.stats) {
      if (!s.n) continue;
      const w = s.n / this.seen;
      const instant = (skipZero && (this.zero(f) || f === NONE)) || drop.has(f);
      per += w * (instant ? (f === LAB ? Math.min(this.cost(f), 0.3) : this.instantS) : this.isTier(f) ? this.floorCost(f) : this.cost(f));
    }
    return remaining * per;
  }
  // ───────────────────────── v2 (AGENT_PACER=v2): value per second ─────────────────────────
  // Run 265 spent 97 s on four aggregates that answered nothing, 37 s on visit-day reads that answered one of four and 24 s opening scanned
  // remittances it then declined for "no slack", while 31 cheap late answers (a phone, an invoice, a claim at 2.5 s) were never reached. v1
  // asks "is the rest of the set at its observed pace still inside the shift?" (tiers) and lets every extra read spend whatever slack that leaves
  // (aggregates were also granted 15 s whatever the pace). v2 prices time: every item the rest of the shift may contain is a (demand s, answers)
  // pair priced by answers per second from this shift's own samples (priors from the Set 1 logs, weight 2), the families and the add-on reads
  // (scan, context, executor, lookup) in ONE list, and plan() fills the time that is left, minus a reserve proportional to the kept demand, in order
  // of answers per second. Where it stops is the price of a second, lam: a family or extra below it is not worked (taskWhy / labWhy / admit
  // refuse), one above it is. The spare time (slack) is what an extra's single read may use. A kind that has burned seconds without an answer falls
  // down the list by its own numbers, so it is dropped when the numbers say so (after ~2 tries of a 15 s aggregate), not after N tries, and
  // nothing in the list is named in the code.
  private xs = new Map<string, XStat>(); private cur: Array<{ kind: string; spent: number }> = [];
  private keep = new Set<string>(); private lam = 0; private slackS = Infinity; private planned = false;
  private busyUntil = 0; private busyN = 0;
  /** reserve = rf × kept demand + r0 seconds (±10 % of noise is absorbed; the replay measures ±20 %) */
  rf = num("AGENT_PACER_RF", 0.1); r0 = num("AGENT_PACER_R0", 6);
  /** an item (or read) worth less than this many answers per second is only worked on abundant slack (3× its cost spare) */
  delta = num("AGENT_PACER_DELTA", 0.01);
  /** families / reads that read appointment lists (the call site says so): they wait while the site says it is busy */
  private lists = new Set<string>(); markList(key: string) { this.lists.add(key); }
  private p2(f: string) { return PRIORS2[f] ?? PRIORS2[NONE]; }
  private fc(f: string) { const s = this.st(f); return (this.p2(f).s * 2 + s.ms / 1000) / (2 + s.tried); }
  private fy(f: string) { const s = this.st(f); return (this.p2(f).y * 2 + s.ans) / (2 + s.tried); }
  private xst(k: string): XStat { let x = this.xs.get(k); if (!x) this.xs.set(k, x = { req: 0, tried: 0, ans: 0, ms: 0 }); return x; }
  /** blended seconds / answers per run of an add-on read; `s0` is the caller's own estimate when the kind has no prior */
  private xe(k: string, s0 = 10) { const x = this.xst(k), p = XPRIORS[k] ?? { s: s0, y: 0.3 }; return { s: (p.s * 2 + x.ms / 1000) / (2 + x.tried), y: (p.y * 2 + x.ans) / (2 + x.tried) }; }
  /** Seconds of the shift left now (the clock the queue gave at the start of this item, less what this item has used). */
  remainingS(): number { return this.secondsLeft - (this.now() - this.startedAt) / 1000; }
  private slackNow() { return this.planned ? this.slackS - (this.now() - this.startedAt) / 1000 : Infinity; }
  private busy() { return this.now() < this.busyUntil; }
  /** A list page that says the site is busy (fewer rows than usual): list reads wait 60 s, 120 s, ... (max 300 s). Run 265's aggregates met 21 such pages
   *  in five items, answered nothing, and the site suspended the account twice after them (see NEXT.md). */
  /** The site suspended the account (crawl.ts met its "This account is suspended" page): list reads wait as after a busy list, and every extra that
   *  costs `heavyS` or more waits `troubleS` after the site is back (a failed 15-30 s read is the most expensive thing to repeat on a site that just went down). */
  noteSuspended() { this.noteBusy(); this.troubleUntil = this.now() + this.troubleS * 1000; }
  private troubleUntil = 0; troubleS = num("AGENT_PACER_TROUBLE_S", 90); heavyS = num("AGENT_PACER_HEAVY_S", 8);
  private trouble() { return this.now() < this.troubleUntil; }
  noteBusy() { this.busyN++; this.busyUntil = this.now() + Math.min(300, 60 * 2 ** (this.busyN - 1)) * 1000; }
  private plan(left: number, N: number) {
    const its: Array<{ id: string; d: number; w: number }> = []; let fixed = this.r0;
    for (const [f, s] of this.stats) {
      if (!s.n) continue; const share = s.n / this.seen, c = this.fc(f);
      if (f === MSG) { fixed += N * share * Math.max(c, 0.5); continue; }
      fixed += N * share * this.instantS; its.push({ id: f, d: this.fy(f) / c, w: N * share * c });
    }
    for (const [k, x] of this.xs) if (x.req) { const e = this.xe(k); its.push({ id: "x:" + k, d: e.y / e.s, w: N * (x.req / this.seen) * e.s }); }
    its.sort((a, b) => b.d - a.d || a.w - b.w);
    // What is worked is whatever the time left pays for, no reserve (a prefix of the first items over-states the rest: Set 1's opening is lab-heavy and
    // its first 80 items run at 3.7 s against 2.7 s for the other 160, so a reserve here dropped a family the shift had room for); the reserve is
    // only taken off the time the add-on reads may spend.
    let cum = 0; this.keep = new Set(); this.lam = 0;
    for (const it of its) { if (cum + it.w <= left - fixed || it.d >= this.keepYps) { cum += it.w; this.keep.add(it.id); } else { this.lam = it.d; break; } } // nothing beats an answer per two seconds: never dropped (invoice, provider-day, phone)
    this.slackS = left - fixed - cum * (1 + this.rf);
    const dropped = its.filter((i) => !this.keep.has(i.id)).map((i) => i.id);
    const note = dropped.join(",");
    if (note !== this.lastNote) { this.lastNote = note; try { process.stdout.write(JSON.stringify({ event: "pacer", v: 2, seen: this.seen, left: Math.round(left), lo: this.seen + N, lam: +this.lam.toFixed(3), slack: Math.round(this.slackS), dropped }) + "\n"); } catch {} }
  }
  /** The plan needs this many items seen: Set 1 opens with ~40 lab tasks (~6 s) among cheaper ones, so the first items' mix says "behind" on a shift that
   *  ends at 725 of 900 s (v1's tierBMinSeen). Before it nothing is dropped; extras spend only a small allowance (`earlyShare` of the shift). */
  planMinSeen = num("AGENT_PACER_PLAN_MIN_SEEN", 60); earlyShare = num("AGENT_PACER_EARLY_SHARE", 0.06); private earlySpent = 0;
  private beginV2(secondsLeft: number) {
    this.cur = []; this.planned = false; this.slackS = Infinity;
    if (!Number.isFinite(secondsLeft) || this.seen < this.planMinSeen) return;
    const { lo } = this.sizes(); this.plan(this.left(), Math.max(1, lo - this.seen)); this.planned = true;
  }
  private taskWhyV2(f: string): string | null {
    if (!this.planned || f === LAB) return null;
    const s = this.st(f), c = this.fc(f), d = this.fy(f) / c, slack = this.slackNow();
    let why = "";
    if (s.n > 0 ? !this.keep.has(f) : d < this.lam) why = `${f} is below the price of a second (${(d * 100).toFixed(1)} answers per 100 s, price ${(this.lam * 100).toFixed(1)})`;
    else if (this.lists.has(f) && this.busy()) why = `the site is busy, ${f} (a list read) waits`;
    else if (c >= this.heavyS && this.trouble()) why = `the site just suspended the account, ${f} (${c.toFixed(0)} s a try) waits`;
    else if (d < this.delta && slack < 3 * c) why = `${f} earns ${(d * 100).toFixed(1)} answers per 100 s and the slack is ${Math.round(slack)} s`;
    if (!why) return null;
    // a family that costs little and has not answered is looked at every few items, so one that starts answering comes back
    if (c <= 4 && s.tried >= this.zeroTries && s.ans === 0 && ++s.since % this.resample === 0) return null;
    return `pacer: behind pace (${this.seen} seen, ${Math.round(this.left())} s left), ${why}`;
  }
  /** An add-on read of `kind` the caller estimates at estS (its first guess; the shift's own samples take over). Null = refused. `budgetS` is how long
   *  the read may run; `done(spentS)` books what it took (and, at the item's end, whether the item answered) so the next price is the measured one.
   *  v1 (default): the old rules, call site by call site (scan / wf / lookup: extraOk; ctx: ctxAdmit). */
  admit(kind: string, estS: number, capS = 40): { budgetS: number; done: (spentS: number) => void } | null {
    if (!this.v2) {
      if (kind.startsWith("ctx:")) { const a = this.ctxAdmit(estS, capS); return a ? { budgetS: a.budgetMs / 1000, done: a.done } : null; }
      return this.extraOk(estS) ? { budgetS: capS, done: () => {} } : null;
    }
    const x = this.xst(kind), known = x.req > 0; x.req++;
    const e = this.xe(kind, estS), d = e.y / e.s, slack = this.slackNow();
    let ok = true;
    if (!this.planned && Number.isFinite(this.secondsLeft)) {
      // before the plan: a small allowance of the shift, spent only on reads with some chance of an answer
      const allow = this.earlyShare * this.shift - this.earlySpent;
      ok = e.s <= allow && this.left() > e.s + this.extraReserve;
      if (ok) return { budgetS: Math.min(capS, allow, Math.max(e.s * 1.5, 12)), done: (spentS) => { this.earlySpent += Math.max(0, spentS); this.cur.push({ kind, spent: Math.max(0, spentS) }); } };
    } else if (this.planned) {
      ok = (known && this.keep.has("x:" + kind) ? true : d >= this.lam && e.s <= slack)
        && !(this.lists.has(kind) && this.busy()) && !(e.s >= this.heavyS && this.trouble()) && (d >= this.delta || slack >= 3 * e.s);
    }
    if (!ok) { try { process.stdout.write(JSON.stringify({ event: "pacer_refuse", kind, estS: +e.s.toFixed(1), perS: +d.toFixed(3), lam: +this.lam.toFixed(3), slack: Math.round(slack) }) + "\n"); } catch {} return null; }
    const room = Number.isFinite(slack) ? Math.max(0.6 * slack, 1.5 * e.s) : capS;
    return { budgetS: Math.min(capS, Math.max(e.s, room)), done: (spentS) => { this.cur.push({ kind, spent: Math.max(0, spentS) }); } };
  }
  /** Seconds one task of an aggregate-like family may spend (v2): about 1.5× its typical cost, or half the spare time, never past `capS`; 0 = do not read. */
  familyBudgetS(f: string, capS = 45): number {
    if (!this.planned) return capS;
    return Math.max(0, Math.min(capS, Math.max(1.5 * this.fc(f), 0.5 * this.slackNow()), this.left() - 12));
  }
  /** Recompute the tiers (start of every item). */
  begin(secondsLeft: number) {
    this.secondsLeft = secondsLeft; this.startedAt = this.now();
    this.tierA = false; this.tierB = false; this.dropped = new Set();
    this.curKey = null; this.tierKey = null; this.tierAt = 0; this.tierKey2 = null; this.tierAt2 = 0; this.asked = new Set();
    if (this.v2) { this.beginV2(secondsLeft); return; }
    try { this.beginV1(secondsLeft); } finally { if (!this.tierA) this.tierPlan(this.left()); else this.tierBase = -Infinity; }
  }
  private beginV1(secondsLeft: number) {
    if (!Number.isFinite(secondsLeft) || this.seen < this.minSeen) return;
    const left = this.left(), { lo, hi } = this.sizes();
    // Tier A vs e1 (not e2): a set that fits at its own observed pace (Set 1: ~505 s of 900 s) keeps the skip
    // probe and every family, including those that start answering late (filing, good-faith, recall, aggregates).
    // Past e1 items lo becomes e2, so a bigger set still turns tier A on.
    void hi; this.tierA = this.project(lo - this.seen, false, this.dropped) > left;
    if (this.seen < Math.max(this.minSeen, this.tierBMinSeen)) return;
    const rem = lo - this.seen;
    if (this.project(rem, true, this.dropped) <= left) return;
    // B: drop families, lowest answers per second first, until the projection fits.
    const fams = [...this.stats.keys()].filter((f) => f !== MSG && this.st(f).n > 0 && this.yieldOf(f) / this.cost(f) < this.keepYps).sort((a, b) => this.yieldOf(a) / this.cost(a) - this.yieldOf(b) / this.cost(b));
    this.tierA = true; this.tierB = true;
    for (const f of fams) { this.dropped.add(f); if (this.project(rem, true, this.dropped) <= left) break; }
    const note = [...this.dropped].join(",");
    if (note !== this.lastNote) { this.lastNote = note; try { process.stdout.write(JSON.stringify({ event: "pacer", seen: this.seen, left: Math.round(left), lo, dropped: [...this.dropped] }) + "\n"); } catch {} }
  }
  /** Before any browsing: a reason to skip this task outright, or null to work it. Lab is never skipped here
   *  (its NOT_COVERED answers are free); its read is gated by labWhy. */
  taskWhy(family: string | null): string | null {
    const f = family ?? NONE; this.curKey = f;
    if (this.v2) return this.taskWhyV2(f);
    if (!this.tierA) return null;
    if (f === NONE) return "pacer: behind pace, task of no known family skipped without browsing";
    if (f === LAB) return null;
    const s = this.st(f);
    if (this.tierB && this.dropped.has(f)) return `pacer: behind pace (${this.seen} seen, ${Math.round(this.left())} s left), ${f} is among the lowest answers per second`;
    if (this.zero(f)) { if (++s.since % this.resample === 0) return null; return `pacer: behind pace, ${f} answered 0 of ${s.tried} tried`; }
    return null;
  }
  /** Lab read gate (solvers.ts): skip a covered-panel read when tier B dropped lab, or (tier A) lab has never answered. */
  labWhy(): string | null {
    if (this.v2) return this.planned && this.st(LAB).n > 0 && !this.keep.has(LAB) ? `pacer: behind pace (${this.seen} seen, ${Math.round(this.left())} s left), lab reads are below the price of a second (${(this.lam * 100).toFixed(1)} answers per 100 s)` : null;
    if (!this.tierA) return null;
    if (this.tierB && this.dropped.has(LAB)) return `pacer: behind pace (${this.seen} seen, ${Math.round(this.left())} s left), lab reads are among the lowest answers per second`;
    return null;
  }
  /** Optional extra work (name-only context lookups, scanned-remittance reads, aggregate list re-reads): run it only
   *  when the shift is not behind AND the projected rest of a Set-1-sized run plus this extra still fits with a
   *  reserve. The extras then can't push answering items past the end of the shift: an extra that doesn't fit is a
   *  skip (0), never an answer taken from a later task. Before minSeen items there is no pace yet: allowed. */
  extraOk(estS: number, kind = "extra"): boolean {
    if (this.v2) return this.admit(kind, estS) !== null;
    // a tier attempt: the executor ("wf"), the lookup ("lookup"), or any extra asked inside a tier task (best effort, the learner)
    const k = kind === "wf" ? "workflow-exec" : kind === "lookup" ? "lookup" : this.curKey && TIER_KEYS.has(this.curKey) ? (this.tierKey === "workflow-exec" && estS === this.learnS() ? "workflow-exec" : "best-effort") : null;
    if (k && this.tierMode) return this.tierOk(k, estS);
    return this.extraSlackS() >= estS;
  }
  /** Seconds of slack for extras (Infinity before there is a pace; 0 when behind). */
  extraSlackS(): number {
    if (this.v2) return Math.max(0, this.slackNow());
    if (this.tierA) return 0;
    if (!Number.isFinite(this.secondsLeft) || this.seen < this.minSeen) return Infinity;
    const { lo } = this.sizes();
    return this.left() - this.project(Math.max(0, lo - this.seen), false, new Set()) - this.extraReserve;
  }
  extraReserve = num("AGENT_PACER_EXTRA_RESERVE_S", 30);
  /** A name-only patient the search cannot settle is a certain skip, and its context read (contextResolve: that day's
   *  lab reports / appointment lists) is the only way to an answer — so it gets an allowance of its own, not only the
   *  pace slack. Set 1 opens with ~40 lab tasks (~10 s each): from item 20 to ~75 the projection says "behind" (tier A,
   *  slack 0) on a shift that ends at 725 of 900 s, and 3 name-only tasks there (items 25, 29, 60) were refused for
   *  "no slack" (run 278). The allowance is `ctxShare` of the shift (6 %), spent only while ≥ the extras reserve is left,
   *  and the pace slack stays the first source: a shift that really is behind (tier A with nothing left of the allowance,
   *  or no time) refuses as before, and tier A/B go on dropping low-yield families whatever the reads cost.
   *  Returns the read's time budget and the callback that books what it spent (only the allowance is booked), or null. */
  ctxShare = num("AGENT_PACER_CTX_SHARE", 0.06);
  private ctxSpent = 0;
  ctxAdmit(estS: number, capS = 40, what = "read"): { budgetMs: number; done: (spentS: number) => void } | null {
    if (this.v2) { const a = this.admit("ctx:" + what, estS, capS); return a && { budgetMs: a.budgetS * 1000, done: a.done }; }
    // pace slack with a 10 s reserve instead of the extras' 30 s (a context read is a task's only way to an answer)
    const raw = this.extraSlackS(), slack = raw > 0 && Number.isFinite(raw) ? raw + Math.max(0, this.extraReserve - 10) : raw;
    if (slack >= estS) return { budgetMs: Math.min(capS, Math.max(estS, Math.min(slack, 1e6) * 0.6)) * 1000, done: () => {} }; // one read never takes more than 60 % of the slack
    const allow = this.ctxShare * this.shift - this.ctxSpent;
    if (allow < estS || this.left() < estS + this.extraReserve) return null;
    // (a read estimated at 16 s gets 22 s: run 265's visit-day reads died at the old flat 15 s, 4 s of it a reserve they didn't need)
    return { budgetMs: Math.min(capS, allow, Math.max(15, estS * 1.4)) * 1000, done: (s) => { this.ctxSpent += Math.max(0, s); } };
  }
  /** The skip probe only runs when the shift is not behind. */
  probeOk(): boolean { return this.v2 ? !this.planned || (this.lam === 0 && this.slackNow() > this.extraReserve) : !this.tierA; }
  /** End of an item. `attempted` false = skipped by the pacer without browsing (not a sample of the family's cost). */
  end(family: string | null, ms: number, answered = false, attempted = true, kind: "task" | "message" = "task", modelFault = false) {
    const f = kind === "message" ? MSG : family ?? NONE;
    const s = this.st(f); this.seen++; s.n++;
    // A lab read slowed by a model failure (retry, substitute reader, hung tiebreak) is not the lab family's pace:
    // the failover now restores a healthy reader, so the sample is counted at the healthy lab time (median of this
    // shift's fault-free lab reads, at least the prior). The clock (seconds left) still carries the real time spent.
    // Run r4: hung/failed reads made labs ~26-41 s and tier B dropped lab at item 80 on a run that fits.
    if (f === LAB && attempted) {
      if (!modelFault) { this.labOk.push(ms); if (this.labOk.length > 40) this.labOk.shift(); }
      else { const xs = [...this.labOk].sort((a, b) => a - b); const med = xs.length ? xs[xs.length >> 1] : 0; ms = Math.min(ms, Math.max(PRIORS[LAB].s * 1000, med)); }
    }
    if (this.v2) {
      // add-on reads book their own seconds and answers; an item that used one is not a sample of its family's cost or yield
      for (const c of this.cur) { const x = this.xst(c.kind); x.tried++; x.ms += c.spent * 1000; if (answered) x.ans++; }
      if (this.cur.length) { this.cur = []; return; }
    }
    if (this.isTier(f) && attempted) {
      // a tier task: the floor (routing, crawl, skip) is the item's time less the attempt's; the attempt is its tier's sample
      const a = this.tierKey ? Math.min(ms, Math.max(0, this.now() - this.tierAt)) : 0;
      const a2 = this.tierKey2 ? Math.min(a, Math.max(0, this.now() - this.tierAt2)) : 0;
      s.fN++; s.fMs += ms - a;
      // the answer goes to the tier that ran last (the first one declined when a second ran)
      if (this.tierKey) { const x = this.tst(this.tierKey); x.tried++; x.ms += a - a2; if (answered && !this.tierKey2) x.ans++; s.tried++; s.ms += a; if (answered) s.ans++; }
      if (this.tierKey2) { const x = this.tst(this.tierKey2); x.tried++; x.ms += a2; if (answered) x.ans++; }
      this.tierKey = null; this.tierAt = 0; this.tierKey2 = null; this.tierAt2 = 0; return;
    }
    if (attempted) { s.tried++; s.ms += ms; if (answered) s.ans++; } else s.instant++;
  }
}

/** A probe step that may take at most `ms` (resolves null on timeout; never throws). */
export function capped<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

/** The shift's pacer (shiftMain feeds it; the lab solver asks it). */
export const pacer = new Pacer();

// ── self-check ──
if (process.argv[1]?.endsWith("/pacer.ts")) {
  let fail = 0; const ok = (c: boolean, m: string) => { if (!c) { fail++; console.error("✗ " + m); } else console.log("✓ " + m); };
  let t = 0; const clock = () => t;
  const mk = () => new Pacer(900, 0, 8, 20, 5, 4, 0.08, 0.5, clock, false);
  { const p = mk(); p.begin(900); ok(p.extraOk(40), "no history → extras allowed"); }
  { const p = mk(); p.begin(900); ok(p.taskWhy("filing-deadline") === null && p.labWhy() === null && p.probeOk(), "no history → work everything"); }
  { // Set-1-like pace (2.1 s/item), 100 seen at 690 s left: e1=240 fits (294 s) → no tier: probe on, 0-answer family still worked
    const p = mk(); for (let i = 0; i < 100; i++) p.end(i % 10 === 0 ? "filing-deadline" : i % 2 ? "patient-phone" : "lab-report-triage", 2100, i % 10 !== 0);
    p.begin(690); ok(p.taskWhy("patient-phone") === null && p.labWhy() === null, "Set-1 pace: answering families and labs are worked");
    ok(p.taskWhy("filing-deadline") === null && p.probeOk(), "Set-1 pace fits e1: a 0-answer family is still worked, probe on");
  }
  { // same pace, 280 s left: e1 projection (294 s) behind → tier A; skipping zero families fits → no tier B
    const p = mk(); for (let i = 0; i < 100; i++) p.end(i % 10 === 0 ? "filing-deadline" : i % 2 ? "patient-phone" : "lab-report-triage", 2100, i % 10 !== 0);
    p.begin(280); ok(/answered 0/.test(p.taskWhy("filing-deadline") ?? ""), "behind e1: a 0-answer family is skipped (tier A)");
    ok(/no known family/.test(p.taskWhy(null) ?? ""), "tier A: unknown family skipped"); ok(!p.probeOk(), "tier A: probe off");
    ok(p.taskWhy("patient-phone") === null && p.labWhy() === null, "tier A only: answering families and labs kept");
  }
  { // well ahead: 100 items in 100 s → nothing
    const p = mk(); for (let i = 0; i < 100; i++) p.end(i % 10 === 0 ? "filing-deadline" : "patient-phone", 1000, i % 10 !== 0); p.begin(800);
    ok(p.taskWhy("filing-deadline") === null && p.probeOk(), "ahead of the 2x projection → nothing skipped");
  }
  { // badly behind (Set-3-like): 260 seen, 30 s left → tier B drops low-yield families, keeps cheap high-yield ones
    const p = mk(); for (let i = 0; i < 260; i++) { const f = ["claim-next-step", "lab-report-triage", "invoice-balance", "patient-phone"][i % 4]; p.end(f, f === "invoice-balance" ? 300 : f === "patient-phone" ? 1300 : 4000, f !== "claim-next-step" || i % 8 === 0); }
    p.begin(120); ok(/lowest/.test(p.taskWhy("claim-next-step") ?? ""), "behind: claims dropped"); ok(p.taskWhy("invoice-balance") === null, "behind: invoice kept");
    ok(/lab reads/.test(p.labWhy() ?? ""), "behind: lab reads dropped");
  }
  { // resample: a zero family is still tried every 4th time
    const p = mk(); for (let i = 0; i < 100; i++) p.end(i % 10 === 0 ? "filing-deadline" : "lab-report-triage", 3000, i % 10 !== 0); p.begin(420);
    const w = [0, 1, 2, 3, 4, 5, 6, 7].map(() => p.taskWhy("filing-deadline")); ok(w.filter((x) => x === null).length === 2, "zero family resampled every 4th");
  }
  // ── v2 (AGENT_PACER=v2) ──
  const mk2 = () => new Pacer(900, 0, 8, 20, 6, 3, 0.08, 0.5, clock, true);
  const feed = (p: Pacer, n: number, f: (i: number) => [string, number, boolean]) => { for (let i = 0; i < n; i++) { const [fam, ms, ans] = f(i); p.end(fam, ms, ans); } };
  const mix = (i: number): [string, number, boolean] => i % 3 === 0 ? ["lab-report-triage", 5000, true] : i % 3 === 1 ? ["patient-phone", 1100, true] : ["claim-next-step", 2500, true];
  { const p = mk2(); p.begin(900); ok(p.taskWhy("filing-deadline") === null && p.labWhy() === null && p.admit("scan", 13) !== null, "v2: no history: everything worked, extras allowed"); }
  { // ahead of the pace (100 items at 3 s, 600 s left for 140): extras with a fair yield are admitted and book what they took
    const p = mk2(); feed(p, 100, mix); p.begin(600);
    const a = p.admit("scan", 13); ok(!!a && a.budgetS >= 13, "v2: ahead of the pace: a scan read (0.07 answers/s) is admitted"); a?.done(12); p.end("claim-next-step", 14000, true);
    ok(p.taskWhy("patient-phone") === null && p.labWhy() === null, "v2: ahead of the pace: nothing is dropped");
  }
  { // an aggregate family that has burned 30 s for nothing falls below the floor and is not worked while the slack is thin; a cheap dense family never is
    const p = mk2(); feed(p, 100, mix); p.end("location-month-distinct-patients", 15000, false); p.end("location-month-distinct-patients", 15000, false);
    p.begin(330); ok(/location-month-distinct-patients/.test(p.taskWhy("location-month-distinct-patients") ?? ""), "v2: 0 answers in 30 s (2 tries): the family is dropped on its own numbers, not after N tries");
    ok(p.taskWhy("patient-phone") === null, "v2: a family answering >= 0.5 per second is never dropped");
  }
  { // behind: the lowest answers per second go first, including the add-on reads
    const p = mk2(); feed(p, 100, mix); p.begin(60); ok(/price of a second/.test(p.taskWhy("claim-next-step") ?? "") || /lab reads/.test(p.labWhy() ?? ""), "v2: behind: a low-yield family is dropped");
    ok(p.admit("ctx:the visit-day list read", 15) === null, "v2: behind: a 9 s visit-day read worth 0.03 answers/s is refused");
  }
  { // a busy list or a suspended account: list reads wait; the heavy extras wait after a suspension; cheap work goes on
    const p = mk2(); feed(p, 100, mix); p.markList("location-month-distinct-patients"); p.begin(700);
    p.noteBusy();
    ok(/busy/.test(p.taskWhy("location-month-distinct-patients") ?? ""), "v2: a busy list: list families wait"); ok(p.admit("scan", 13) !== null, "v2: a busy list does not stop a scan read");
    p.noteSuspended(); ok(p.admit("scan", 13) === null, "v2: a suspended account: a 13 s read waits"); ok(p.taskWhy("patient-phone") === null, "v2: ...cheap work goes on");
    t = 100_000; ok(p.admit("scan", 13) !== null, "v2: ...for 90 s only");
  }
  { const p = new Pacer(900, 0, 8, 20, 6, 3, 0.08, 0.5, clock, false); feed(p, 100, mix); p.begin(600); ok(p.admit("scan", 13) !== null && p.taskWhy("patient-phone") === null, "v1 (default): admit() is the old extraOk / ctxAdmit"); }
  // ── the hidden-set tiers (AGENT_PACER_TIERS=slack, default) ──
  t = 0;
  const mkT = (v1 = false) => { const p = new Pacer(900, 0, 8, 20, 6, 3, 0.08, 0.5, clock, false); if (v1) p.tierMode = false; return p; };
  /** one item: begin at `left`, then (task) taskWhy + the executor's ask; the clock moves by floor + (admitted) attempt */
  const item = (p: Pacer, left: number, key: string | null, floorS: number, attemptS = 0, answered = false, ask = "wf") => {
    p.begin(left); const why = p.taskWhy(key); let ok = false;
    if (!why) { t += floorS * 1000; if (attemptS) { ok = p.extraOk(ask === "wf" ? 20 : 25, ask); if (ok) t += attemptS * 1000; } }
    p.end(key, why ? 80 : (floorS + (ok ? attemptS : 0)) * 1000, ok && answered, !why); return { why, ok };
  };
  { // Set-2-like: 240 items at 0.3 s (fast skips), an executor ask every 4th item (60 x 8 s): it all fits in 890 s → every attempt admitted
    for (const v1 of [false, true]) {
      t = 0; const p = mkT(v1); let adm = 0, asks = 0, left = 890;
      for (let i = 0; i < 238; i++) { const tk = i % 4 === 0; const r = item(p, left - t / 1000, tk ? "workflow-exec" : null, 0.3, tk ? 8 : 0, i % 8 === 0); if (tk) { asks++; if (r.ok) adm++; } }
      if (!v1) ok(adm === asks, `tiers: Set-2-like pace, the executor admitted ${adm}/${asks}`);
      else console.log(`  (v1 on the same items: ${adm}/${asks} admitted)`);
    }
  }
  { // refused asks are floor samples, not 0-answer tries: 40 refusals (behind on the tier budget) never make tier A skip the tier
    t = 0; const p = mkT(); for (let i = 0; i < 30; i++) p.end("patient-phone", 2000, true);
    let tierASkips = 0; for (let i = 0; i < 40; i++) { const r = item(p, 70, "workflow-exec", 0.3, 8); if (r.why) tierASkips++; }
    ok(tierASkips === 0, `tiers: 40 refused asks (no budget) are no 0-answer tries (tier-A skips ${tierASkips})`);
  }
  { // behind on the floor itself (a family-heavy shift): no tier attempt is admitted
    t = 0; const p = mkT(); for (let i = 0; i < 100; i++) p.end(i % 2 ? "lab-report-triage" : "claim-next-step", 5000, true);
    ok(!item(p, 500, "workflow-exec", 0.3, 8).ok, "tiers: the floor projection does not fit (140 items x 5 s in 500 s) → refused");
  }
  { // a tier that burns its attempts without an answer loses its admission rate (1 in RESAMPLE), the other tier keeps its own
    t = 0; const p = mkT(); let beAdm = 0, beAsk = 0, wfAdm = 0, wfAsk = 0;
    for (let i = 0; i < 230; i++) {
      const be = i % 2 === 0, left = 880 - t / 1000;
      const r = item(p, left, be ? "best-effort" : "workflow-exec", 0.2, be ? 20 : 2, !be && i % 3 === 0, be ? "extra" : "wf");
      if (i >= 60) { if (be) { beAsk++; if (r.ok) beAdm++; } else { wfAsk++; if (r.ok) wfAdm++; } }
    }
    ok(beAdm <= Math.ceil(beAsk / 3) + 1 && beAdm > 0, `tiers: a 0-answer 20 s tier is throttled (${beAdm}/${beAsk} admitted after item 60)`);
    ok(wfAdm >= wfAsk - 2, `tiers: ...while the answering tier keeps its rate (${wfAdm}/${wfAsk})`);
  }
  { // inside an executor item: the learner's ask (AGENT_LEARN_TASK_S, 15) rides on the executor's admission; best effort after the executor
    // declined needs best effort's own rate (Site C, f5e7271: best effort ran as a free continuation after 0-answer executor runs)
    t = 0; const p = mkT(); for (let i = 0; i < 30; i++) p.end("patient-phone", 300, true);
    for (let i = 0; i < 12; i++) { p.begin(800 - t / 1000); p.taskWhy("best-effort"); const a = p.extraOk(25); t += a ? 20_000 : 100; p.end("best-effort", a ? 20_100 : 100, false); }
    let learnOk = 0, beOk = 0;
    for (let i = 0; i < 9; i++) { p.begin(600 - t / 1000); p.taskWhy("workflow-exec"); if (p.extraOk(20, "wf")) { t += 5000; if (p.extraOk(15)) learnOk++; if (p.extraOk(25)) { beOk++; t += 20_000; } } p.end("workflow-exec", 5000, false); }
    ok(learnOk === 9 && beOk <= 3, `tiers: in an executor item the learner rides (${learnOk}/9), best effort keeps its own throttled rate (${beOk}/9)`);
  }
  { // a family task's extras (scan, context, aggregate) keep the v1 rule: same answer as AGENT_PACER_TIERS=v1
    for (const left of [600, 250, 120]) {
      t = 0; const a = mkT(), b = mkT(true);
      for (const p of [a, b]) for (let i = 0; i < 100; i++) p.end(i % 3 ? "claim-next-step" : "lab-report-triage", 2500, true);
      a.begin(left); b.begin(left); a.taskWhy("claim-next-step"); b.taskWhy("claim-next-step");
      ok(a.extraOk(13) === b.extraOk(13) && a.extraSlackS() === b.extraSlackS(), `tiers: a family's extra at ${left} s left is decided as in v1 (${a.extraOk(13)})`);
    }
  }
  { // the end reserve: no tier attempt with less than reserve + estS left, whatever the pace
    t = 0; const p = mkT(); for (let i = 0; i < 200; i++) p.end("workflow-exec", 300, false);
    ok(!item(p, 40, "workflow-exec", 0.1, 8).ok, "tiers: 40 s left (reserve 27 s + 20 s ask) → refused");
  }
  t = 0;
  console.log(fail ? "FAIL" : "ALL PASS"); process.exit(fail ? 1 : 0);
}
