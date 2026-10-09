/**
 * Offline funnel of the workflow executor's ROUTING over every queue we have with messages + tasks (no model calls):
 *   tasks → no family (familyMatch) → blocked by the govern gate (inference.governHit) → routed by wfFor → right / wrong message.
 * Variants (env, default off): AGENT_WF_ROUTE=wide (wfShadow.wideRoute) and AGENT_GOVERN=route (a govern-blocked task goes to the
 * message that blocked it). "families off" = the Set 2/3 stress view: every task counts as no-family (a reworded task fails the
 * family patterns), which is also how wfExec-test measures routing.
 * Truth = the message a task belongs to (Set 1: the family's workflow message; loop suite: the item's `workflow`; practice: lab /
 * new-or-established; wf-eval cases: the case's message); null = no message governs it, so ANY route is a misroute.
 * Govern keywords: Set 1 logs carry the model's compile (`compiled.scope`); other queues have none offline, so a PROXY stands in
 * (words of the message title, plus its role's domain word): the real compile of a Set 2/3 message is unknown until a live run.
 *   npx tsx src/wrenfield/wfFunnel.ts           # table for strict / wide / govern / both; asserts the Set 1 invariants (0 misroutes)
 */
import { readFileSync } from "node:fs";
import { MessageStore, governHit, type CompiledMessage } from "./inference.js";
import { familyMatch } from "./families.js";
import { wfNoteMessage, wfFor, lastVia, _resetWorkflows } from "./wfShadow.js";
import { parseWorkflowSpec } from "./workflowExec.js";

type Item = { kind: "message" | "task"; text: string; key?: string | null; scope?: string[]; family?: string | null; id?: string };
type Queue = { name: string; items: Item[]; realGovern: boolean };
const rd = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const json = (p: string) => JSON.parse(rd(p));
const NE = /\bestablished\b/i;

// ── queues
const FAM1: Record<string, number> = { "lab-report-triage": 1, "tetanus-wound": 30, "vaccine-lot-recall": 76, "claim-next-step": 120, "filing-deadline": 150, "good-faith-estimate": 198 };
function set1(f: string): Queue {
  const its = rd(`fixtures/set1/${f}`).split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((x) => x?.event === "item");
  const n2fam = Object.fromEntries(Object.entries(FAM1).map(([k, v]) => [v, k]));
  return { name: f.replace("-set1.log", "") + " (Set 1)", realGovern: true, items: its.map((it: any): Item => it.kind === "message"
    ? { kind: "message", text: it.text, key: n2fam[it.n] ?? null, scope: (it.compiled?.scope ?? []).filter((s: string) => s.startsWith("govern:")) }
    : { kind: "task", text: it.text, key: FAM1[it.family] ? it.family : null }) };
}
const fromItems = (name: string, items: any[], truth: (i: any) => string | null, msgKey: (i: any) => string | null): Queue => ({ name, realGovern: false, items: items.map((i): Item => i.kind === "message" ? { kind: "message", text: i.text, key: msgKey(i) } : { kind: "task", text: i.text, key: truth(i) }) });
function queues(): Queue[] {
  const q: Queue[] = [set1("run-164-set1.log"), set1("run-162-set1.log")];
  const lab = (i: any) => (String(i.family ?? "").startsWith("lab-") ? "lab" : i.family === "new-established" || NE.test(i.text) ? "ne" : null);
  const msgKey = (i: any) => (/lab report/i.test(i.text) ? "lab" : NE.test(i.text) ? "ne" : null);
  q.push(fromItems("practice-it-queue", json("fixtures/practice-it-queue.json").items, lab, msgKey));
  q.push(fromItems("set2-hyp-queue", json("fixtures/set2-hyp-queue.json").items, (i) => (NE.test(i.text) ? "ne" : null), msgKey));
  q.push(fromItems("practice-queue", json("fixtures/practice-queue.json").items, (i) => (NE.test(i.text) ? "ne" : null), msgKey));
  const suite = json("bench/loop/suite.json").items; const have = new Set(suite.filter((i: any) => i.kind === "message").map((i: any) => i.workflow));
  q.push(fromItems("bench/loop/suite", suite, (i) => (have.has(i.workflow) ? i.workflow : null), (i) => i.workflow));
  // wf-eval cases: every distinct message first, then each case's request (truth = its message)
  const ev = json("fixtures/wf-eval/cases.json"); const msgs = new Map<string, string>();
  for (const c of ev.cases) { const t: string = c.message ?? ev.set1Messages[String(c.msg)]; if (!msgs.has(c.workflow)) msgs.set(c.workflow, t); }
  q.push({ name: "wf-eval/cases", realGovern: false, items: [...[...msgs].map(([k, t]): Item => ({ kind: "message", text: t, key: k })), ...ev.cases.map((c: any): Item => ({ kind: "task", text: c.request, key: c.workflow, id: c.id }))] });
  return q;
}

// ── govern proxy: title words + the role's domain word, for a message the compile would leave uncompiled
const ROLE = /^From (?:the )?([^:]+?)(?: (?:supervisor|manager|lead|coordinators?|team|office|staff|director))*:/i;
function proxyScope(text: string, broad: boolean): string[] {
  const title = text.split("\n")[0].replace(/^From [^:]+:\s*/, ""); const role = text.match(ROLE)?.[1] ?? "";
  const w = (s: string) => s.toLowerCase().split(/[^a-z]+/).filter((x) => x.length >= 5 && !/^(what|about|their|there|patient|patients|which|after|before|comes|when)$/.test(x));
  return [...new Set([...w(title), ...(broad ? w(role) : [])])].map((x) => "govern:" + x);
}
const compiledByRule = (text: string) => NE.test(text) || (/\blab reports?\b/i.test(text) && /NOT_COVERED/.test(text)); // run.ts compiles these to a rule: nothing governs

// ── replay
type Stats = { tasks: number; noFamily: number; governBlocked: number; routed: number; right: number; wrong: number; viaWide: number; viaGovern: number; wrongList: string[]; routedList: string[]; ids: Array<[string, string, boolean]> };
async function replay(q: Queue, variant: { wide: boolean; govern: boolean }, o: { familiesOff: boolean; broad: boolean }): Promise<Stats> {
  process.env.AGENT_WF_ROUTE = variant.wide ? "wide" : ""; process.env.AGENT_GOVERN = variant.govern ? "route" : "";
  _resetWorkflows();
  const msgRaw: Array<{ raw: string; key: string | null }> = [];
  const store = new MessageStore(async (raw, order): Promise<CompiledMessage> => {
    const it = q.items.find((x) => x.kind === "message" && x.text === raw)!;
    const wf = it.text.length >= 300 && /^From [^:\n]{2,60}:/.test(it.text) && !!parseWorkflowSpec(it.text);
    const scope = it.scope ?? (wf && !compiledByRule(raw) ? proxyScope(raw, o.broad) : []);
    return { id: "m" + order, order, raw, kind: scope.length ? "workflow" : "noise", scope, active: true };
  });
  const s: Stats = { tasks: 0, noFamily: 0, governBlocked: 0, routed: 0, right: 0, wrong: 0, viaWide: 0, viaGovern: 0, wrongList: [], routedList: [], ids: [] };
  let n = 0;
  for (const it of q.items) {
    n++;
    if (it.kind === "message") { await store.ingest(it.text); wfNoteMessage(it.text, n); msgRaw.push({ raw: it.text, key: it.key ?? null }); continue; }
    s.tasks++;
    const fam = o.familiesOff ? null : familyMatch(it.text); if (fam) continue;
    s.noFamily++;
    const gov = governHit(it.text, store.governKeywords(), null); if (gov) s.governBlocked++;
    const w = wfFor(it.text, gov ? store.governOwners(it.text) : []); if (!w) continue;
    s.routed++; if (lastVia === "wide") s.viaWide++; if (lastVia === "govern") s.viaGovern++;
    const got = msgRaw.find((m) => m.raw === w.spec.raw)?.key ?? null;
    const ok = it.key != null && got === it.key;
    if (ok) s.right++; else { s.wrong++; s.wrongList.push(`${(it.key ?? "(none)")} → ${got ?? w.spec.title.slice(0, 30)} [${lastVia}] ${it.text.slice(0, 70)}`); }
    if (it.id) s.ids.push([it.id, lastVia, ok]);
    s.routedList.push(`${ok ? "ok " : "BAD"} ${lastVia.padEnd(6)} ${it.text.slice(0, 80)}`);
  }
  return s;
}

const noLog = process.stdout.write.bind(process.stdout); // governHit logs a line per hit: keep the table readable
const VARIANTS = [["strict (shipped)", { wide: false, govern: false }], ["wide", { wide: true, govern: false }], ["govern", { wide: false, govern: true }], ["wide+govern", { wide: true, govern: true }]] as const;
const verbose = process.argv.includes("-v");
let fails = 0; const t = (c: boolean, m: string) => { if (!c) { fails++; console.log("FAIL", m); } };
for (const familiesOff of [false, true]) {
  console.log(`\n### ${familiesOff ? "families OFF (Set 2/3 stress view: every task is no-family)" : "families ON (as shipped)"}`);
  console.log(`${"queue".padEnd(26)} ${"variant".padEnd(16)} tasks noFam govBlk routed right wrong (wide govern)`);
  for (const q of queues()) for (const [name, v] of VARIANTS) {
    process.stdout.write = ((c: any) => (typeof c === "string" && c.startsWith('{"event":"govern_gate"') ? true : noLog(c))) as any;
    const s = await replay(q, v, { familiesOff, broad: false });
    process.stdout.write = noLog as any;
    console.log(`${q.name.padEnd(26)} ${name.padEnd(16)} ${String(s.tasks).padStart(5)} ${String(s.noFamily).padStart(5)} ${String(s.governBlocked).padStart(6)} ${String(s.routed).padStart(6)} ${String(s.right).padStart(5)} ${String(s.wrong).padStart(5)} (${s.viaWide} ${s.viaGovern})`);
    if (verbose || (q.realGovern && s.wrong)) for (const w of s.wrongList.slice(0, 12)) console.log("     misroute: " + w);
    if (process.argv.includes("--ids") && familiesOff && q.name.startsWith("wf-eval")) console.log("     ids " + JSON.stringify(s.ids));
    if (q.name.includes("(Set 1)")) t(s.wrong === 0, `${q.name} ${name} families ${familiesOff ? "off" : "on"}: ${s.wrong} misroutes`);
  }
}
console.log(fails ? `wfFunnel: ${fails} FAIL` : "✓ wfFunnel");
process.exit(fails ? 1 : 0);
