/**
 * Calibration bench for the Jev memo router (wfRoute.ts): precision / recall / false-route rate per threshold.
 *
 * Sets (each with its own memo pool, as a shift would hold it):
 *   A  Set 1 (fixtures/set1-items.jsonl; labels from the 164 ∪ 162 logs): 6 memos; a workflow family's task → its memo,
 *      every other task (phone, referral, aggregates…) → none. All Set 1 tasks have a family, so Jev never runs there
 *      live; this is the LOWO view of its accuracy.
 *   B  bench/loop/suite.json (coverage-bench): 15 generated memos, 132 tasks in non-Set-1 wording with an oracle;
 *      "(skip)" tasks are the catalog's hard negatives (same words, another question) → none; chart-field → none.
 *   C  practice queues (practice-queue, practice-it-queue, set2-hyp-queue): 1 memo each; the other tasks → none.
 *   D  reworded Set 1 tasks (variants/taskVariants REWORDED + REWORDED_HELDOUT + TEMPLATES para) under the Set 1 memos;
 *      their negatives and every non-workflow family's paraphrases → none.
 *   E  catalog.mjs templates (→ memo) and negatives + HELD_OUT*.negatives (→ none) under the catalog memos, synthetic slots.
 * Threshold choice: dev = A+B+C; D+E confirm it (held out from the choice). Replies are cached in
 * bench/runs/wf-route/cache.jsonl (keyed by task + options), so `--offline` re-tabulates for free.
 *
 *   npx tsx src/wrenfield/wfRoute-bench.ts [--env ~/.config/speedrun/openrouter.env] [--offline] [--sets A,B,C,D,E]
 *                                          [--concurrency 3] [--json out.json]
 * Model access: OPENROUTER_API_KEY from --env (never printed) as LLM_API_KEY, LLM_BASE_URL https://openrouter.ai/api/v1
 * (so the client posts /api/v1/systemone — the path the proxy mirrors). AGENT_DECISIONS_URL can point at the alpha path.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { parseWorkflowSpec } from "./workflowExec.js";
import { memoKeys, memoOptions, judge, INSTRUCTIONS, NONE, type Memo, type Thresholds } from "./wfRoute.js";
import { choose, type Choice } from "./decisions.js";
import { _setListed } from "./failover.js";

const a = process.argv; const at = (f: string) => (a.indexOf(f) >= 0 ? a[a.indexOf(f) + 1] : undefined);
const OFFLINE = a.includes("--offline");
const SETS = (at("--sets") ?? "A,B,C,D,E").split(",");
const CONC = Number(at("--concurrency") ?? 3);
const FIX = new URL("../../fixtures/", import.meta.url).pathname;
const RUNS = new URL("../../bench/runs/wf-route/", import.meta.url).pathname;
mkdirSync(RUNS, { recursive: true });

// ── model access (the key is read, never printed) ──
if (!OFFLINE) {
  const envFile = (at("--env") ?? `${homedir()}/.config/speedrun/openrouter.env`).replace(/^~/, homedir());
  let key = process.env.OPENROUTER_API_KEY; try { key ??= readFileSync(envFile, "utf8").match(/OPENROUTER_API_KEY=(\S+)/)?.[1]; } catch {}
  if (!process.env.LLM_API_KEY && key) process.env.LLM_API_KEY = key;
  process.env.LLM_BASE_URL ??= "https://openrouter.ai/api/v1";
  if (!process.env.LLM_API_KEY) { console.error("no key: --env <file with OPENROUTER_API_KEY=…> or LLM_API_KEY"); process.exit(2); }
  _setListed(["typesafe/jev-1.13"]);
}

type Case = { set: string; sub: string; task: string; expect: string; kind: "memo" | "negative" | "other" };
type Pool = { memos: Memo[]; cases: Case[]; cases2?: Case[] };
const specOf = (text: string) => (text.length >= 300 && /^From [^:\n]{2,60}:/.test(text) ? parseWorkflowSpec(text) : null);
function pool(msgs: string[]): Memo[] {
  const specs: ReturnType<typeof parseWorkflowSpec>[] = []; const seen = new Set<string>();
  for (const m of msgs) { const s = specOf(m); if (s && !seen.has(s.raw)) { seen.add(s.raw); specs.push(s); } }
  const keys = memoKeys(specs as any); return specs.map((s, i) => ({ key: keys[i], spec: s! }));
}
const byTitle = (memos: Memo[], re: RegExp) => memos.find((m) => re.test(m.spec.title))?.key;

// ── A: Set 1 ──
const FAM_RE: Record<string, RegExp> = { "lab-report-triage": /lab report/i, "tetanus-wound": /tetanus/i, "vaccine-lot-recall": /recalled vaccine/i, "claim-next-step": /claim after its remittance/i, "filing-deadline": /last day to file/i, "good-faith-estimate": /good faith estimate/i };
function setA(): Pool {
  const items = readFileSync(FIX + "set1-items.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const memos = pool(items.filter((i: any) => i.kind === "message").map((i: any) => i.text));
  const fam = new Map<string, string | null>();
  for (const f of ["run-164-set1.log", "run-162-set1.log"]) for (const l of readFileSync(FIX + "set1/" + f, "utf8").split("\n")) { if (!l.startsWith('{"event":"item"')) continue; const i = JSON.parse(l); if (i.kind === "task" && !fam.has(i.text)) fam.set(i.text, i.family ?? null); }
  const cases: Case[] = [];
  for (const i of items) { if (i.kind !== "task") continue; const f = fam.get(i.text); if (f === undefined) continue; const k = f && FAM_RE[f] ? byTitle(memos, FAM_RE[f]) : undefined;
    cases.push({ set: "A", sub: f ?? "(none)", task: i.text, expect: k ?? NONE, kind: k ? "memo" : "other" }); }
  return { memos, cases };
}
// ── B: bench/loop suite ──
function setB(): Pool {
  const s = JSON.parse(readFileSync(new URL("../../bench/loop/suite.json", import.meta.url), "utf8"));
  const msgs: Array<{ workflow: string; text: string }> = s.items.filter((i: any) => i.kind === "message");
  const memos = pool(msgs.map((m) => m.text));
  const keyOf = new Map<string, string>(); for (const m of msgs) { const sp = specOf(m.text); const k = sp && memos.find((x) => x.spec.raw === sp.raw)?.key; if (k) keyOf.set(m.workflow, k); }
  const cases: Case[] = [];
  for (const t of s.items.filter((i: any) => i.kind === "task")) { const k = keyOf.get(t.workflow); const neg = t.expected === "(skip)";
    cases.push({ set: "B", sub: t.workflow, task: t.text, expect: k && !neg ? k : NONE, kind: k ? (neg ? "negative" : "memo") : "other" }); }
  return { memos, cases };
}
// ── C: practice queues ──
function setC(file: string, owns: Array<[RegExp, (t: any) => boolean]>): Pool {
  const q = JSON.parse(readFileSync(FIX + file, "utf8")); const items = q.items ?? q;
  const memos = pool(items.filter((i: any) => i.kind === "message").map((i: any) => i.text));
  const keyFor = (t: any) => { for (const [re, f] of owns) { const k = byTitle(memos, re); if (k && f(t)) return k; } return undefined; };
  const cases: Case[] = items.filter((i: any) => i.kind === "task").map((t: any) => { const k = keyFor(t); return { set: "C", sub: file.replace(/\.json$/, ""), task: t.text, expect: k ?? NONE, kind: k ? "memo" : "other" } as Case; });
  return { memos, cases };
}
// ── D: reworded Set 1 tasks (variants templates) ──
async function setD(memosA: Memo[]): Promise<Pool> {
  const V: any = await import("./variants/taskVariants.js");
  const facts = [
    { name: "Maria Lopez", dob: "1980-03-05", provider: "Kevin Miller, MD", panel: "Complete blood count", received: "2026-10-07", visit: "2026-09-30", lot: "TK4471D", dos: "2026-07-14", invoice: "40417730", date: "2026-10-12", location: "Northgate", time: "14:00", month: "August 2026", k: "3", status: "No-show" },
    { name: "Hughes, Daniel", dob: "1952-11-21", provider: "Elena Gutierrez, NP", panel: "Thyroid panel", received: "2026-10-11", visit: "2026-10-02", lot: "AB9920C", dos: "2026-08-03", invoice: "51235510", date: "2026-09-18", location: "Cedar Hollow", time: "9:30", month: "July 2026", k: "5", status: "Cancelled" },
  ];
  const parts = (n: string) => V.nameParts(n); const noTitle = (p: string) => p.replace(/,?\s*(MD|DO|PA-C|PA|NP)\.?\s*$/i, "").trim();
  let seed = 11; const r = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  const ctx = (f: any) => { const p = parts(f.name); return { ...f, N: `${p.first} ${p.last}`, LF: `${p.last}, ${p.first}`, dobParen: ` (DOB ${f.dob})`, dobComma: `, born ${f.dob}`, P: f.provider, Pnt: noTitle(f.provider), r }; };
  const cases: Case[] = []; const seen = new Set<string>();
  const add = (sub: string, task: string | null, expect: string, kind: Case["kind"]) => { if (task && !seen.has(task)) { seen.add(task); cases.push({ set: "D", sub, task, expect, kind }); } };
  for (const f of facts) { const c = ctx(f);
    for (const [fam, re] of Object.entries(FAM_RE)) { const k = byTitle(memosA, re)!;
      for (const t of V.REWORDED[fam]?.tasks ?? []) add(fam, t(c), k, "memo");
      for (const t of V.REWORDED_HELDOUT[fam] ?? []) add(fam, t(c), k, "memo");
      for (const t of V.TEMPLATES[fam]?.para ?? []) add(fam, t(c), k, "memo");
      for (const n of [...(V.REWORDED[fam]?.neg ?? []), ...(V.TEMPLATES[fam]?.neg ?? [])]) add(fam + " neg", n.tpl(c), NONE, "negative");
    }
    for (const [fam, tp] of Object.entries<any>(V.TEMPLATES)) { if (FAM_RE[fam]) continue; for (const t of tp.para) add(fam, t(c), NONE, "other"); for (const n of tp.neg) add(fam + " neg", n.tpl(c), NONE, "other"); }
  }
  return { memos: memosA, cases };
}
// ── E: catalog templates under the catalog memos ──
async function setE(): Promise<Pool> {
  const C: any = await import(/* @vite-ignore */ "../../bench/loop/catalog" + ".mjs");
  const memos = pool(Object.values<string>(C.MESSAGES));
  const keyOf = (id: string) => { const w = C.WORKFLOWS.find((x: any) => x.id === id); if (!w?.message) return undefined; const sp = specOf(w.message); return sp && memos.find((m) => m.spec.raw === sp.raw)?.key; };
  const slots = [
    { num: "40417730", first: "Grace", last: "Lin", patient: "Lin, Grace", dob: "09/30/1958", dobIso: "1958-09-30", dobLong: "September 30, 1958", date: "2026-10-12", dateUS: "10/12/2026", dateLong: "October 12, 2026", loc: "Northgate", status: "Paid", statusPl: "no-shows", type: "Lab report", typePl: "lab reports", typeLc: "lab report", cond: "type 2 diabetes", code: "E11.9", metric: "appointments completed", k: "3", month: "August 2026" },
    { num: "66001324", first: "Sam", last: "Ortiz", patient: "Ortiz, Sam", dob: "01/12/1990", dobIso: "1990-01-12", dobLong: "January 12, 1990", date: "2026-09-18", dateUS: "9/18/2026", dateLong: "September 18, 2026", loc: undefined, status: undefined, statusPl: "cancellations", type: "Referral letter", typePl: "referral letters", typeLc: "referral letter", cond: "asthma", code: "J45.909", metric: "documents received", k: "5", month: "July 2026" },
  ];
  const cases: Case[] = []; const seen = new Set<string>();
  const add = (sub: string, task: string, expect: string, kind: Case["kind"]) => { if (task && !seen.has(task)) { seen.add(task); cases.push({ set: "E", sub, task, expect, kind }); } };
  for (const s of slots) for (const w of C.WORKFLOWS) { const k = keyOf(w.id); if (!k) continue;
    for (const t of [...(w.templates ?? []), ...(w.chartTemplates ?? [])]) add(w.id, t(s), k, "memo");
    for (const t of w.negatives ?? []) add(w.id + " neg", t(s), NONE, "negative"); }
  for (const H of [C.HELD_OUT]) { for (const s of slots) { for (const t of H.docCount) add("doc-count", t(s), keyOf("doc-count")!, "memo"); for (const t of H.invoiceCount) add("invoice-count", t(s), keyOf("invoice-count")!, "memo"); } for (const n of H.negatives) add(n.workflow + " neg", n.text, NONE, "negative"); }
  // E2: the catalog's later held-out batches (HELD_OUT2–4), never used to word the router's options
  const cases2: Case[] = [];
  const add2 = (sub: string, task: string, expect: string, kind: Case["kind"]) => { if (task && !seen.has(task)) { seen.add(task); cases2.push({ set: "E2", sub, task, expect, kind }); } };
  for (const H of [C.HELD_OUT2, C.HELD_OUT3, C.HELD_OUT4]) { for (const s of slots) { for (const t of H.docCount) add2("doc-count", t(s), keyOf("doc-count")!, "memo"); for (const t of H.invoiceCount) add2("invoice-count", t(s), keyOf("invoice-count")!, "memo"); } for (const n of H.negatives) add2(n.workflow + " neg", n.text, NONE, "negative"); }
  return { memos, cases, cases2 };
}

// ── cache + runner ──
const CACHE = RUNS + "cache.jsonl";
const cache = new Map<string, Choice>();
if (existsSync(CACHE)) for (const l of readFileSync(CACHE, "utf8").split("\n")) { if (!l) continue; try { const r = JSON.parse(l); cache.set(r.key, r.choice); } catch {} }
const keyFor = (task: string, opts: Record<string, string>) => createHash("sha1").update(JSON.stringify([task, INSTRUCTIONS, opts])).digest("hex");
type Row = Case & { choice: Choice | null };
async function run(p: Pool): Promise<Row[]> {
  const opts = memoOptions(p.memos); const out: Row[] = []; let i = 0, fresh = 0;
  const workers = Array.from({ length: Math.max(1, CONC) }, async () => {
    while (i < p.cases.length) { const c = p.cases[i++]; const k = keyFor(c.task, opts);
      let ch = cache.get(k) ?? null;
      if (!ch && !OFFLINE) { ch = await choose({ request: c.task }, INSTRUCTIONS, opts, { tag: "bench" }).catch(() => null); if (ch) { cache.set(k, ch); appendFileSync(CACHE, JSON.stringify({ key: k, task: c.task.slice(0, 120), choice: ch }) + "\n"); fresh++; } }
      out.push({ ...c, choice: ch }); }
  });
  await Promise.all(workers);
  if (fresh) console.log(`  ${fresh} fresh Jev calls`);
  return out;
}

// ── tabulation ──
type Tally = { n: number; memoN: number; routed: number; right: number; wrongMemo: number; falseRoute: number; negN: number; negNone: number; otherN: number; otherNone: number; noReply: number };
const tally = (): Tally => ({ n: 0, memoN: 0, routed: 0, right: 0, wrongMemo: 0, falseRoute: 0, negN: 0, negNone: 0, otherN: 0, otherNone: 0, noReply: 0 });
function score(rows: Row[], memos: Memo[], th: Thresholds, t = tally()): Tally {
  for (const r of rows) {
    t.n++; if (r.kind === "memo") t.memoN++; if (r.kind === "negative") t.negN++; if (r.kind === "other") t.otherN++;
    if (!r.choice) { t.noReply++; if (r.kind !== "memo") { if (r.kind === "negative") t.negNone++; else t.otherNone++; } continue; }
    const d = judge(r.choice, memos, th);
    if (!d.routed) { if (r.kind === "negative") t.negNone++; else if (r.kind === "other") t.otherNone++; continue; }
    t.routed++;
    if (d.routed.key === r.expect) t.right++; else if (r.kind === "memo") t.wrongMemo++; else t.falseRoute++;
  }
  return t;
}
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)} %` : "—");
const line = (name: string, t: Tally) => `| ${name} | ${t.n} | ${t.memoN} | ${t.routed} | ${t.right} | ${t.wrongMemo} | ${t.falseRoute} | ${pct(t.right, t.routed)} | ${pct(t.right, t.memoN)} | ${pct(t.negNone, t.negN)} (${t.negNone}/${t.negN}) | ${pct(t.otherNone, t.otherN)} (${t.otherNone}/${t.otherN}) | ${t.noReply} |`;
const HEAD = "| set | n | memo tasks | routed | right | wrong memo | false route | precision | recall | negatives → none | no-memo → none | no reply |\n|---|---|---|---|---|---|---|---|---|---|---|---|";

const pools: Record<string, Pool> = {};
if (SETS.includes("A")) pools.A = setA();
if (SETS.includes("B")) pools.B = setB();
if (SETS.includes("C")) { const ne = (t: any) => /\bnew (or|vs\.?) established\b|new vs\. established/i.test(t.text); const lab = (t: any) => /\blab report\b/i.test(t.text) && !/how many|number of/i.test(t.text);
  const owns: Array<[RegExp, (t: any) => boolean]> = [[/new patients from established/i, ne], [/lab report/i, lab]];
  const c1 = setC("practice-queue.json", owns), c2 = setC("practice-it-queue.json", owns), c3 = setC("set2-hyp-queue.json", owns);
  pools.C1 = c1; pools.C2 = c2; pools.C3 = c3; }
if (SETS.includes("D")) pools.D = await setD((pools.A ?? setA()).memos);
if (SETS.includes("E")) { const e = await setE(); pools.E = { memos: e.memos, cases: e.cases }; pools.E2 = { memos: e.memos, cases: e.cases2! }; }

const rowsBy: Record<string, Row[]> = {};
for (const [name, p] of Object.entries(pools)) { console.log(`${name}: ${p.memos.length} memos, ${p.cases.length} cases (${p.cases.filter((c) => c.kind === "memo").length} memo / ${p.cases.filter((c) => c.kind === "negative").length} negative / ${p.cases.filter((c) => c.kind === "other").length} other)`); rowsBy[name] = await run(p); }

const TH: Thresholds[] = (["all", "memos"] as const).flatMap((p2Scope) => [0.5, 0.6, 0.7, 0.8, 0.9, 0.95].flatMap((p) => [0.05, 0.1, 0.2, 0.5].map((p2) => ({ p, p2, p2Scope }))));
const groups: Record<string, string[]> = { "dev (A+B+C+E)": ["A", "B", "C1", "C2", "C3", "E"], "held-out (D+E2)": ["D", "E2"], all: Object.keys(pools) };
console.log(`\n== shipped thresholds (p ≥ 0.8, runner-up ≤ 0.1) ==\n${HEAD}`);
for (const [name, p] of Object.entries(pools)) console.log(line(name, score(rowsBy[name], p.memos, { p: 0.8, p2: 0.1 })));
for (const [g, names] of Object.entries(groups)) { const t = tally(); for (const n of names) if (pools[n]) score(rowsBy[n], pools[n].memos, { p: 0.8, p2: 0.1 }, t); console.log(line(`**${g}**`, t)); }
console.log(`\n== threshold sweep ==\n| p ≥ | runner-up ≤ | runner-up over | group | routed | right | wrong memo | false route | precision | recall | negatives → none | no-memo → none |\n|---|---|---|---|---|---|---|---|---|---|---|---|`);
const sweep: any[] = [];
for (const th of TH) for (const [g, names] of Object.entries(groups)) { const t = tally(); for (const n of names) if (pools[n]) score(rowsBy[n], pools[n].memos, th, t);
  sweep.push({ ...th, group: g, ...t }); console.log(`| ${th.p} | ${th.p2} | ${th.p2Scope} | ${g} | ${t.routed} | ${t.right} | ${t.wrongMemo} | ${t.falseRoute} | ${pct(t.right, t.routed)} | ${pct(t.right, t.memoN)} | ${pct(t.negNone, t.negN)} | ${pct(t.otherNone, t.otherN)} |`); }
// misroutes at the shipped point, for the doc
console.log(`\n== misroutes / false routes at p ≥ 0.8, runner-up ≤ 0.1 ==`);
for (const [name, p] of Object.entries(pools)) for (const r of rowsBy[name]) { if (!r.choice) continue; const d = judge(r.choice, p.memos, { p: 0.8, p2: 0.1 }); if (d.routed && d.routed.key !== r.expect) console.log(`  ${name} ${r.kind} [${r.sub}] → ${d.routed.key} p=${d.p.toFixed(2)} (want ${r.expect}) :: ${r.task.slice(0, 110)}`); }
console.log(`\n== memo tasks NOT routed at p ≥ 0.8, runner-up ≤ 0.1 (recall losses; ≤ 40 shown) ==`);
let shown = 0;
for (const [name, p] of Object.entries(pools)) for (const r of rowsBy[name]) { if (r.kind !== "memo" || !r.choice) continue; const d = judge(r.choice, p.memos, { p: 0.8, p2: 0.1 }); if (!d.routed && shown++ < 40) console.log(`  ${name} [${r.sub}] best=${d.best} p=${d.p.toFixed(2)} 2nd=${d.second} ${d.p2.toFixed(2)} :: ${r.task.slice(0, 100)}`); }
const usd = Object.values(rowsBy).flat().reduce((s, r) => s + (r.choice?.usage.cost ?? 0), 0), ms = Object.values(rowsBy).flat().map((r) => r.choice?.ms ?? 0).filter(Boolean).sort((x, y) => x - y);
console.log(`\ncost of every cached decision: $${usd.toFixed(4)}; latency median ${ms[ms.length >> 1] ?? 0} ms, p90 ${ms[Math.floor(ms.length * 0.9)] ?? 0} ms (${ms.length} calls)`);
if (at("--json")) writeFileSync(at("--json")!, JSON.stringify({ sets: Object.fromEntries(Object.entries(pools).map(([n, p]) => [n, { memos: p.memos.map((m) => m.key), cases: rowsBy[n].map((r) => ({ ...r, choice: r.choice && { choice: r.choice.choice, probabilities: r.choice.probabilities } })) }])), sweep }, null, 1));
