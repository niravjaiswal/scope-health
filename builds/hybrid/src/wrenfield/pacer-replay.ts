/**
 * Ledger replay of the shift pacer on Set 1's REAL costs: the 265 run's per-item ms / outcomes joined with the 278 run's
 * (fixtures/set1/run-265-set1.log, run-278-set1.log; answer key bench/set1-key/key.json: 197 verified answers).
 *
 * Why this exists: sim-pacer.ts replays ONE run's timings (146 / 164 / r4 / 278) and models a new feature as "answers at
 * logged cost + N s". Run 265 broke that: its three new heavy paths (appointment-list aggregates on 3 tabs, scanned
 * remittance reads, visit-day context reads) cost 97 + 37 s and answered NOTHING on Set 1, and its site went "busy" and
 * then "This account is suspended" twice (about items 125-127 and 210-234; each failed browse then cost 13 s, the stuck
 * waits of a page that never shows the search form). The old replay answered every aggregate, never failed a read and
 * never lost the site, so it predicted 0 lost answers for a run that lost 31.
 *
 * Model (everything below is read from the two logs, nothing is a Set 1 position in the pacer itself):
 *   item        message / task, family, and two records: A = 265, B = 278 (ms, answered, why).
 *   plain       cost + outcome of the "healthy" record: A, or B where A sat in a suspension window / was not reached.
 *   scan        a claim whose current remittance is scanned: the reader asks pacer.extraOk(13). Admitted = B's cost and answer;
 *               declined = the ~3 s the claim reader spent before asking (A's own declined cost), no answer.
 *   agg         an appointment-list aggregate: solvers.aggregate's budget = min(taskBudget, max(15 s, slack)). It spends
 *               min(A's cost, budget); A's outcome (answered 0 on Set 1 in A and B except location-completed-before-time).
 *   ctx         a name-only patient (no DOB): the context read (pacer.ctxAdmit). Admitted = A's cost and outcome where A read
 *               it, else B's cost + a typical read with no answer (conservative). Refused = B's cost (all 14 refused in B).
 *   fault       the site is suspended in [W1s, W1e] and [W2s, inf) of the shift clock (read off 265's timeline). A browse that
 *               starts inside a window fails after `failS` (A's own cost where A was there, else 13 s) with no answer.
 * The clock is the shift clock: 3 s warm-up + each item's cost + 0.03 s per item (checked against 265's pacer events:
 * `left` at seen=127 and seen=214 matches within 1 s).
 *
 *   npx tsx src/wrenfield/pacer-replay.ts          # the table; exit 1 if the baseline does not reproduce 265
 */
import { readFileSync } from "node:fs";
import { Pacer } from "./pacer.js";

export type Rec = { n: number; kind: string; family: string | null; ms: number; ans: boolean; answer?: string; why: string; busy: number };
const rd = (f: string): Rec[] => {
  const out: Rec[] = []; let busy = 0;
  for (const l of readFileSync(new URL(`../../fixtures/set1/${f}`, import.meta.url), "utf8").split("\n")) {
    if (l.startsWith('{"event":"aggregate-read"') && /list busy/.test(l)) busy++;
    else if (l.startsWith('{"event":"item"')) { const r = JSON.parse(l); out.push({ n: r.n, kind: r.kind, family: r.family, ms: r.ms, ans: !!r.result && "answer" in r.result, answer: r.result?.answer, why: String(r.why ?? ""), busy }); busy = 0; }
  }
  return out;
};
const KEY: Record<string, unknown> = JSON.parse(readFileSync(new URL("../../bench/set1-key/key.json", import.meta.url), "utf8")).tasks;

/** Suspension windows on the shift clock (s): 265 saw the "account is suspended" page from ~item 125 (t 440) to before item 128 (t 503)
 *  and from item 210 (t 737) to the end of the shift. The 2nd window is open-ended: the account never came back in the 150 s that were left. */
export const WINDOWS: Array<[number, number]> = [[446, 509], [746, Infinity]];
const AGG = new Set(["location-month-distinct-patients", "top-providers-completed-month", "location-completed-before-time"]);
const NAME = new Set([10, 25, 29, 60, 65, 127, 174, 175, 179, 186, 218, 220, 223, 226]); // sim-pacer.ts: name-only tasks (no DOB), 278 refused every one
const WARM = 3, RTT = 0.03;

export type Item = {
  n: number; kind: "task" | "message"; family: string | null; cls: "plain" | "scan" | "agg" | "ctx" | "msg";
  /** healthy cost (s) / outcome when worked with no extras */ s: number; ans: boolean; browse: boolean;
  /** extras: the cost (s) / outcome / estimate of the extra when admitted, the cost of the declined or refused path */
  xS: number; xAns: boolean; estS: number; declS: number;
  /** cost of a browse that fails in a suspension window */ failS: number; key: boolean; /** "site busy" pages the aggregate met (A) */ busy: number;
  /** what 265's pacer did with this item: skipped it, let the extra / read run, or declined it (the replay of 265's own decisions) */ a: "skip" | "run" | "decline";
};
export function buildLedger(): Item[] {
  const A = new Map(rd("run-265-set1.log").map((r) => [r.n, r])), B = new Map(rd("run-278-set1.log").map((r) => [r.n, r]));
  // A's clock: which of its items started inside a suspension window
  let t = WARM; const faultedA = new Set<number>();
  for (let n = 1; n <= 240; n++) { const a = A.get(n); if (!a) break; if (a.kind === "task" && a.ms > 2000 && WINDOWS.some(([s, e]) => t >= s && t < e)) faultedA.add(n); t += a.ms / 1000 + RTT; }
  const items: Item[] = [];
  for (let n = 1; n <= 240; n++) {
    const a = A.get(n), b = B.get(n), r = (a ?? b)!;
    const kind = r.kind === "message" ? "message" : "task", family = r.family;
    const it: Item = { n, kind, family, cls: "plain", s: 0, ans: false, browse: false, xS: 0, xAns: false, estS: 0, declS: 0, failS: 13.1, key: String(n) in KEY, busy: a?.busy ?? 0, a: "run" };
    // A's record counts only where it really worked the item: not in a suspension window, not skipped by its pacer (that tells nothing of the item's cost)
    const healthy = a && !faultedA.has(n) && !/^pacer: behind pace/.test(a.why) ? a : b ?? a!;
    it.s = healthy.ms / 1000; it.ans = healthy.ans; it.browse = kind === "task" && healthy.ms >= 40;
    if (family === "invoice-balance") it.failS = 11.1;
    if (a && faultedA.has(n)) it.failS = a.ms / 1000;
    if (kind === "message") it.cls = "msg";
    else if (/no slack for a scan read/.test(a?.why ?? "") || (family === "claim-next-step" && b && b.ans && b.ms >= 8000 && a && (!a.ans || a.ms >= 8000))) {
      it.cls = "scan"; it.estS = 13;
      const adm = a && a.ans && a.ms >= 8000 ? a : b!; it.xS = adm.ms / 1000; it.xAns = adm.ans;
      it.declS = a && /no slack for a scan read/.test(a.why) ? a.ms / 1000 : 3.0;
    } else if (family && AGG.has(family) && a) {
      // an aggregate reads until it proves, fails, or its budget runs out: `xS` is how long it would run unbudgeted (Infinity: until the budget ends)
      const budgetBound = /exceed the task budget|no time budget|over the task budget/.test(a.why);
      it.cls = "agg"; it.s = a.ms / 1000; it.ans = a.ans; it.browse = a.ms >= 40; it.declS = 0.2; it.xAns = a.ans;
      it.estS = /~(\d+) s/.test(a.why) ? Number(/~(\d+) s/.exec(a.why)![1]) + 0.5 : 0;
      it.xS = a.ms < 1000 ? (it.estS || 15.5) : budgetBound ? Infinity : a.ms / 1000;
    } else if (NAME.has(n) && b) {
      // a name-only task: the context read (admitted) vs the refusal 278 got. A read that answered keeps A's cost; one that failed costs A's too
      it.cls = "ctx"; const lab = family === "lab-report-triage"; it.estS = lab ? 2 : 15; it.declS = b.ms / 1000;
      const read = !!a && !faultedA.has(n) && !/behind pace/.test(a.why);
      it.xS = read ? a!.ms / 1000 : b.ms / 1000 + (lab ? 8 : 12); it.xAns = read ? a!.ans : false;
    }
    it.a = /^pacer: behind pace/.test(a?.why ?? "") ? "skip" : it.cls === "scan" ? (/no slack for a scan read/.test(a?.why ?? "") ? "decline" : "run")
      : it.cls === "agg" ? (a && a.ms < 1000 ? "decline" : "run")
      : it.cls === "ctx" ? (!a || /behind pace/.test(a.why) || (!faultedA.has(n) && !a.ans && a.ms - (b?.ms ?? 0) < 1000) ? "decline" : "run") : "run";
    items.push(it);
  }
  return items;
}

/** What the replay needs from a pacer (v1 `Pacer` or the v2 pacer behind AGENT_PACER=v2). */
export interface Gate {
  at?(n: number): void; begin(left: number): void; taskWhy(f: string | null): string | null; labWhy(): string | null;
  /** claimReader: a scanned-remittance read (~estS) */ scan(estS: number): { done(spentS: number): void } | null;
  /** an aggregate met a "site busy" list */ busy(): void;
  /** solvers.aggregate: the time budget (s) of an aggregate task of this family, or 0 when it is refused */ agg(family: string, estS: number): number;
  /** contextResolve: the budget (s) of a name-only context read, or null */ ctx(estS: number, lab: boolean): { budgetS: number; done(spentS: number): void } | null;
  end(family: string | null, ms: number, answered: boolean, attempted: boolean, kind: "task" | "message"): void;
}
/** Today's pacer behind the call sites it has in solvers.ts / claimReader.ts / index-builder.ts. */
export function v1Gate(p: Pacer, now: () => number, deadline: () => number): Gate {
  return {
    begin: (l) => p.begin(l), taskWhy: (f) => p.taskWhy(f), labWhy: () => p.labWhy(), scan: (e) => p.extraOk(e) ? { done: () => {} } : null, busy: () => {},
    agg: (_f, estS) => {
      // solvers.aggregate: budget = min(taskBudgetMs(), max(15 s, slack)); taskBudgetMs = max(0, min(90 s, deadline - now - 20 s, max(15 s, slack)))
      const slack = Math.min(p.extraSlackS(), 1e6), left = deadline() - now() / 1000;
      const b = Math.max(0, Math.min(90, left - 20, Math.max(15, slack)));
      return b < 3 ? 0 : b;
    },
    ctx: (e) => { const a = p.ctxAdmit(e); return a ? { budgetS: a.budgetMs / 1000, done: a.done } : null; },
    end: (f, ms, a, att, k) => p.end(f, ms, a, att, k),
  };
}

/** 265's own pacer decisions, item by item: checks the cost model (clock, windows, failure costs) alone. */
export function forcedGate(items: Item[]): Gate {
  let cur: Item = items[0];
  return {
    at: (n) => { cur = items[n - 1]; }, begin: () => {}, labWhy: () => null, busy: () => {}, end: () => {},
    taskWhy: () => (cur.a === "skip" ? "pacer: behind pace (265's own decision)" : null),
    scan: () => (cur.a === "decline" ? null : { done: () => {} }),
    agg: () => (cur.a === "decline" ? 0 : cur.s + 0.01),
    ctx: () => (cur.a === "decline" ? null : { budgetS: 999, done: () => {} }),
  };
}

/** AGENT_PACER=v2: the same call sites asking the v2 pacer. */
export function v2Gate(p: Pacer): Gate {
  return {
    begin: (l) => p.begin(l), taskWhy: (f) => p.taskWhy(f), labWhy: () => p.labWhy(), busy: () => p.noteBusy(),
    scan: (e) => { const a = p.admit("scan", e); return a && { done: a.done }; },
    agg: (f) => { p.markList(f); const b = p.familyBudgetS(f); return b < 3 ? 0 : b; },
    ctx: (e, lab) => { if (!lab) p.markList("ctx:the visit-day list read"); const a = p.admit("ctx:" + (lab ? "the Documents read" : "the visit-day list read"), e); return a && { budgetS: a.budgetS, done: a.done }; },
    end: (f, ms, a, att, k) => p.end(f, ms, a, att, k),
  };
}

/** `hold`: an agent that waits out a suspended site (polls, then goes on with the same item) instead of failing the item after `failS`. */
export type Scn = { faults: boolean; noise?: number; hold?: boolean };
export type Out = { answered: number; known: number; reached: number; tasks: number; used: number; lost: string[]; skippedPacer: number[]; declined: Record<string, number[]>; wasted: number; items: Array<{ n: number; t: number; s: number; ans: boolean; note: string }> };

export function replay(items: Item[], mk: (now: () => number) => Gate, scn: Scn, shift = 900, margin = 4): Out {
  let t = WARM; const g = mk(() => t * 1000); const mute = process.stdout.write.bind(process.stdout);
  if (!process.env.REPLAY_VERBOSE) (process.stdout as any).write = () => true; // the pacer logs its tier notes to stdout
  const out: Out = { answered: 0, known: 0, reached: 0, tasks: 0, used: 0, lost: [], skippedPacer: [], declined: {}, wasted: 0, items: [] };
  const k = scn.noise ?? 1; let n0 = 0;
  try {
    for (const it of items) {
      if (scn.hold && scn.faults && it.kind === "task" && it.browse) { const w = WINDOWS.find(([a, b]) => t >= a && t < b); if (w) t = Math.min(w[1], shift); } // wait for the account to come back
      const left = shift - t; if (left <= margin) break;
      n0++; out.reached++; if (it.kind === "task") out.tasks++;
      g.at?.(it.n); g.begin(left);
      let s = it.s * k, ans = it.ans, attempted = true, note = "";
      const inWin = () => scn.faults && WINDOWS.some(([a, b]) => t >= a && t < b);
      if (it.cls === "msg") { /* acknowledged */ }
      else if (g.taskWhy(it.family)) { s = 0.08; ans = false; attempted = false; note = "pacer skip"; out.skippedPacer.push(it.n); }
      else if (it.cls === "plain") {
        if (it.family === "lab-report-triage" && it.s > 1.5 && g.labWhy()) { s = 0.3; ans = false; note = "lab dropped"; out.skippedPacer.push(it.n); }
        else if (it.browse && inWin()) { s = it.failS; ans = false; note = "suspended"; }
      } else if (it.cls === "scan") {
        const a = g.scan(it.estS);
        if (a) { s = (inWin() ? it.failS : it.xS) * k; ans = inWin() ? false : it.xAns; note = inWin() ? "suspended" : "scan read"; a.done(Math.max(0, s - 2.5)); }
        else { s = it.declS * k; ans = false; note = "scan declined"; (out.declined.scan ??= []).push(it.n); }
      } else if (it.cls === "agg") {
        const b = g.agg(it.family!, it.estS);
        if (b <= 0 || (it.estS > 0 && it.estS > b)) { s = it.declS; ans = false; note = "aggregate declined"; (out.declined.agg ??= []).push(it.n); }
        else if (inWin()) { s = it.failS; ans = false; note = "suspended"; }
        else { const need = it.xS * k; s = Math.min(need, b, 45); ans = it.xAns && need <= b; note = ans ? "aggregate" : "aggregate (0 answers)"; if (it.busy) g.busy(); }
      } else if (it.cls === "ctx") {
        const a = g.ctx(it.estS, it.family === "lab-report-triage");
        if (!a) { s = it.declS * k; ans = false; note = "ctx refused"; (out.declined.ctx ??= []).push(it.n); }
        else if (inWin()) { s = it.failS; ans = false; note = "suspended"; a.done(Math.max(0, it.failS - it.declS)); }
        else { const add = (it.xS - it.declS) * k; s = it.declS * k + Math.min(add, a.budgetS); ans = it.xAns && add <= a.budgetS; note = ans ? "ctx read" : "ctx read (0 answers)"; a.done(Math.min(add, a.budgetS)); }
      }
      if (ans) { out.answered++; if (it.key) out.known++; } else if (it.key) out.lost.push(String(it.n));
      if (note === "suspended" || /0 answers/.test(note)) out.wasted += s;
      t += s + RTT; g.end(it.family, s * 1000, ans, attempted, it.kind);
      out.items.push({ n: it.n, t, s, ans, note });
    }
  } finally { (process.stdout as any).write = mute; }
  out.used = Math.round(t);
  for (const it of items.slice(n0)) if (it.key) out.lost.push(String(it.n));
  return out;
}

const v1 = () => (now: () => number) => v1Gate(new Pacer(900, 0, 8, 20, 6, 3, 0.08, 0.5, now, false), now, () => 900);
const v2 = () => (now: () => number) => v2Gate(new Pacer(900, 0, 8, 20, 6, 3, 0.08, 0.5, now, true));

if (process.argv[1]?.endsWith("/pacer-replay.ts")) {
  const items = buildLedger(); let fail = 0; const check = (c: boolean, m: string) => { if (!c) { fail++; console.error("✗ " + m); } else console.log("✓ " + m); };
  const tasks = items.filter((i) => i.kind === "task").length, keyN = Object.keys(KEY).length;
  const show = (nm: string, o: Out) => console.log(`${nm.padEnd(46)} answered ${String(o.answered).padStart(3)} known ${String(o.known).padStart(3)}/${keyN} not reached ${String(tasks - o.tasks).padStart(2)} used ${o.used}s wasted ${String(Math.round(o.wasted)).padStart(3)}s`);
  const forced = replay(items, () => forcedGate(items), { faults: true });
  show("265's own decisions, windows (cost model)", forced);
  check(Math.abs(forced.answered - 166) <= 2 && Math.abs(tasks - forced.tasks - 6) <= 1, `265's decisions replayed reproduce 265 (166 answered, 6 not reached; got ${forced.answered}, ${tasks - forced.tasks})`);
  const grid = (nm: string, scn: Scn) => {
    for (const [pn, mk] of [["v1 (today)", v1()], ["v2", v2()]] as Array<[string, ReturnType<typeof v1>]>) {
      const row = [0.8, 0.9, 1, 1.1, 1.2].map((k) => { const o = replay(items, mk, { ...scn, noise: k }); return `${String(o.known).padStart(3)}/${tasks - o.tasks}`; });
      console.log(`${(nm + ", " + pn).padEnd(46)} known/not-reached at cost x0.8 x0.9 x1.0 x1.1 x1.2: ${row.join("  ")}`);
    }
  };
  console.log("\n== 265's real costs, free-running pacers (known answers of 197 / tasks not reached) ==");
  grid("site never suspended", { faults: false }); grid("suspension windows (as in 265)", { faults: true }); grid("windows + wait it out", { faults: true, hold: true });
  const b = replay(items, v1(), { faults: true, noise: 0.95 });
  check(b.known >= 150 && b.known <= 172 && tasks - b.tasks >= 3 && tasks - b.tasks <= 8, `today's pacer free-running on 265's costs + windows lands where 265 did (x0.95: ${b.known} known, ${tasks - b.tasks} not reached; 265: 166, 6)`);
  const c1 = replay(items, v1(), { faults: false }), c2 = replay(items, v2(), { faults: false });
  check(c2.known >= 190, `v2, site healthy, 265's costs: ${c2.known} of ${keyN} known answers fit in 900 s (target >= 190; today's pacer ${c1.known})`);
  for (const k of [0.8, 0.9, 1, 1.1, 1.2]) { const a = replay(items, v1(), { faults: false, noise: k }), d = replay(items, v2(), { faults: false, noise: k }); check(d.known >= a.known, `v2 >= today's pacer at cost x${k} (${d.known} vs ${a.known})`); }
  check(replay(items, v2(), { faults: true }).known >= replay(items, v1(), { faults: true }).known + 5, "v2 beats today's pacer with the suspension windows by >= 5 answers (the 2nd window never ends: nothing answers after it)");
  const lostBy = (o: Out) => o.lost.join(",");
  console.log(`\nv2, healthy site, x1.0: lost known answers at tasks ${lostBy(c2) || "-"}; declined ${JSON.stringify(c2.declined)}; skipped by the pacer ${c2.skippedPacer.length}: ${c2.skippedPacer.join(",")}`);
  console.log(`today's pacer, healthy site, x1.0: lost ${lostBy(c1)}; declined ${JSON.stringify(c1.declined)}`);
  // order and set-size robustness (the ledger's real items in other orders; Set 1 twice at 1800 s, e1 480)
  const shuffle = <T,>(xs: T[], seed: number): T[] => { const a = [...xs]; let q = seed; for (let i = a.length - 1; i > 0; i--) { q = (q * 1103515245 + 12345) >>> 0; const j = q % (i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  for (const k of [1, 1.2]) {
    const m = (mk: ReturnType<typeof v1>) => [1, 2, 3, 4, 5, 6, 7, 8].map((sd) => replay(shuffle(items, sd), mk, { faults: false, noise: k }).known);
    const a = m(v1()), d = m(v2()), mean = (x: number[]) => x.reduce((p, q) => p + q, 0) / x.length;
    console.log(`8 shuffled orders, healthy, x${k}: today's ${mean(a).toFixed(1)} (min ${Math.min(...a)}), v2 ${mean(d).toFixed(1)} (min ${Math.min(...d)})`);
    check(mean(d) >= mean(a) + 3, `v2 beats today's pacer on shuffled orders at x${k} by >= 3 on average`);
  }
  const twice: Item[] = [...items, ...items.map((i) => ({ ...i }))];
  const mk3 = (v: boolean) => (now: () => number) => v ? v2Gate(new Pacer(1800, 0, 8, 20, 6, 3, 0.08, 0.5, now, true)) : v1Gate(new Pacer(1800, 0, 8, 20, 6, 3, 0.08, 0.5, now, false), now, () => 1800);
  for (const k of [1, 1.2]) { const a = replay(twice, mk3(false), { faults: false, noise: k }, 1800), d = replay(twice, mk3(true), { faults: false, noise: k }, 1800); console.log(`Set 1 twice, 1800 s, x${k}: today's ${a.known}, v2 ${d.known} of 394 known (all reached: ${a.tasks === 448 && d.tasks === 448})`); check(d.known >= a.known, `v2 >= today's pacer on Set 1 twice at 1800 s, x${k}`); }
  console.log(fail ? "FAIL" : "ALL PASS"); process.exit(fail ? 1 : 0);
}
