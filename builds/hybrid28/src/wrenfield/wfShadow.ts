/**
 * Shift glue for the gated workflow executor (workflowExec.ts). Called ONLY for a task no deterministic family took
 * (shiftMain: `"skip" in out && !family`) whose text belongs to a captured workflow message (answer forms in backticks).
 * Gathers the pages the request's NAMED INPUTS point to (patient → the chart tabs the message talks about; invoice
 * number → that invoice's page; a list the message counts + a date → that list filtered to the date, every page read),
 * runs the v2 executor (structured extraction with quoted facts, one run per model) and applies the gates of
 * `decide` (agreement, format, grounding, applies) + the text worked-example gate (cached per workflow).
 * Every call logs one `{"event":"wf_exec"}` line: workflow, inputs, pages read, each run's answer / applies / grounding,
 * the decision and why, ms. Returns an answer ONLY in mode "on" with every gate passed; "shadow" (default) never answers.
 *
 * Enable: AGENT_WORKFLOW_EXEC=on. Thresholds (measured by wfEval.ts): AGENT_WF_MODELS (default sonnet-5.5, haiku-5.5,
 * gemini-3.8-flash: those the endpoint lists), AGENT_WF_K (default: all runs), AGENT_WF_STRICT=1 (any disagreeing run
 * abstains), AGENT_WF_GROUND=1, AGENT_WF_EXAMPLE=pass-or-na (a workflow whose example fails is never answered).
 * Time: AGENT_WF_TASK_S (default 20, hard cap) per task, only while the pacer has that much slack (pacer.extraOk), never
 * with fewer than AGENT_WF_RESERVE_S (240) shift seconds left; AGENT_WF_MAX tasks per shift (default 12 shadow / 400 on).
 * Gathering: AGENT_WF_GATHER=v3 (default: wfGather.ts — toolkit reads by label with completeness proofs + a cheap model's
 * read-only follow-up tools) or v2 (fixed pages by named inputs). The executor's runs go in parallel on the proxy's
 * request slots (failover maxInFlight − 1, one slot left for image reads).
 */
import { extractSlots } from "./parse.js";
import type { ClinicIndex, PatientRecord } from "./inference.js";
import { pacer } from "./pacer.js";
import { Operator } from "./operate.js";
import { isCountQuestion, messageCounts } from "./workflowCapture.js";
import { parseWorkflowSpec, runVotes, decide, exampleGateText, wfMode, wfPolicy, defaultRunner, type WfSpec, type Gathered, type Runner, type Vote } from "./workflowExec.js";
import { isListed, textSlots } from "./failover.js";
import * as spend from "./spend.js";
import { gatherV3, asGathered, type GatherOut } from "./wfGather.js";
import { classifyMemo } from "./memoGate.js";
import { routeByJev, routerMode, memoKeys, type Memo, type RouteDecision, type Chooser } from "./wfRoute.js";

export type Wf = { order: number; spec: WfSpec; later: string[]; example?: Promise<{ ok: boolean | null; why: string; transient?: boolean }>;
  /** the settled example verdict; a `transient` one (too few replies) is re-run on the next task */
  exampleLast?: { ok: boolean | null; why: string; transient?: boolean }; revoked?: number };
const wfs: Wf[] = [];
const wfsMod = wfs;
/** Every captured workflow message so far (the best-effort tier reads the memo a task is routed to). */
export const wfCaptured = (): Wf[] => wfs.slice();
const STOP = new Set("the a an of to for and or in on at by with what when how is are be it its this that from we our your you they them their do does did which who has have had any each every one patient patients visit".split(" "));
/** Content words. Plurals meet their singular (invoices ~ invoice) through `plural`; generic back-office words (count, number,
 *  record, date…) are stop words, so a workflow is matched on its own nouns (wfExec-test: 0 misroutes on Set 1). */
const GENERIC = new Set(("count counting counted number many total please could would should need needs want wants tell look know about there these those into over after before " +
  "the and for are was has had not you our who its how can did ask get got out all any one two new old use see say per via may yet off was were been have").split(" "));
const words = (s: string) => s.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3 && !STOP.has(w) && !GENERIC.has(w));
const plural = (w: string) => (w.endsWith("ies") ? w.slice(0, -3) + "y" : w.endsWith("es") && /[sxz]es$|[cs]hes$/.test(w) ? w.slice(0, -2) : w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
/** The forms a word is matched under: itself, its singular, and its -ed / -ing base (recalled ~ recall, filing ~ file). */
const forms = (w: string): string[] => { const out = new Set([w, plural(w)]); const p = plural(w);
  for (const x of [w, p]) { if (x.endsWith("ed") && x.length >= 6) { out.add(x.slice(0, -2)); out.add(x.slice(0, -1)); } if (x.endsWith("ing") && x.length >= 7) { out.add(x.slice(0, -3)); out.add(x.slice(0, -3) + "e"); } }
  return [...out].filter((x) => x.length >= 3); };

/** Every message: a new workflow (≥ 300 chars, "From …:" title, answer forms), or a later message about one. */
export function wfNoteMessage(text: string, order: number): void {
  // An amendment or a revocation of a captured workflow (memoGate.classifyMemo) is that workflow's later message, never a workflow of
  // its own (a "grace period for standing orders" amendment carries an answer token and is long enough to parse as one).
  const mc = wfs.length ? classifyMemo(text, wfs.map((w) => ({ raw: w.spec.raw }))) : null;
  if (mc && mc.target !== undefined && (mc.kind === "amendment" || mc.kind === "revocation")) {
    const w = wfs[mc.target]; w.later.push(text); if (mc.kind === "revocation") w.revoked = order;
    for (const o of wfs) if (o !== w) { const heads = [...o.spec.heads.keys()].filter((h) => h.length >= 4); if (heads.some((h) => text.includes(h))) o.later.push(text); }
    return;
  }
  const spec = text.length >= 300 && /^From [^:\n]{2,60}:/.test(text) ? parseWorkflowSpec(text) : null;
  if (spec) {
    // a memo re-sent word for word is the same workflow (bench/loop suite: the practice memo appears twice; two copies
    // would tie every lexical score and halve the router's probability)
    if (wfs.some((w) => w.spec.raw === spec.raw)) return;
    const w: Wf = { order, spec, later: [] }; wfs.push(w);
    // the text worked-example gate runs now, in the background (a message item has no browsing to do), so the workflow's
    // first task finds it done instead of racing it for request slots
    // one slot, BACKGROUND class: the gate's votes take a slot only when no reader / text call is waiting for one and are
    // aborted at the background hard timeout (judged practice td750384c4e29: a hung gemini vote of this gate held the
    // learned single slot for 45 s while a referral read waited)
    if (wfMode() !== "off" && process.env.AGENT_WF_EAGER_EXAMPLE !== "0") { const models = wfRunModels(); if (models.length >= 2) w.example = exampleGateText(spec, { models, concurrency: 1, cls: "background", waitMs: 60000, runner: exampleDumpRunner(spec.title) }).catch((e) => ({ ok: false, why: "example threw " + String(e).slice(0, 60) })); const p = w.example; p?.then((r) => { if (w.example === p) w.exampleLast = r; }).catch(() => {}); }
    return;
  }
  for (const w of wfs) {
    const heads = [...w.spec.heads.keys()].filter((h) => h.length >= 4);
    const topic = new Set(words(w.spec.title)); const n = words(text).filter((x) => topic.has(x)).length;
    if (heads.some((h) => text.includes(h)) || n >= 2) w.later.push(text);
  }
}
/** Routing vocabulary of a workflow: its title, its worked example's request (a real phrasing of the task, names
 *  dropped) and the "A request names …" sentence. */
function vocab(w: Wf): Set<string> {
  const ex = (w.spec.example?.request ?? "").replace(/\b[A-Z][a-z'’-]+(?:,? [A-Z][a-z'’-]+)+/g, " ");
  const names = w.spec.raw.match(/\b(?:A|The|Each) (?:request|question) (?:names|gives|asks)[^.]*\./i)?.[0] ?? "";
  // the "you'll be asked …" sentence and the answer tokens' words (VACCINE_AND_TIG → vaccine, tig): a short phrasing
  // ("Tetanus for X on D: vaccine, vaccine and TIG, or nothing?") shares the tokens' words, not the title's
  const asked = w.spec.raw.match(/\b(?:you(?:'ll| will) be asked|when someone asks|the person asking)[^.]*\./i)?.[0] ?? "";
  // every quoted question in the message (a worked example without a stated answer still shows how requests are phrased)
  const quoted = [...w.spec.raw.matchAll(/"([^"\n]{10,200}\?)"/g)].map((m) => m[1].replace(/\b[A-Z][a-z'’-]+(?:,? [A-Z][a-z'’-]+)+/g, " ")).join(" ");
  const toks = [...w.spec.heads.keys()].flatMap((h) => h.toLowerCase().split("_")).filter((x) => x.length >= 3 && !STOP.has(x));
  return new Set([...words(w.spec.title), ...words(ex), ...words(names), ...words(asked), ...words(quoted), ...toks]);
}
/** The workflow a task belongs to: the best overlap with its vocabulary, words found in only one workflow's vocabulary
 *  counting 1 and shared words 0.5; needs ≥ 2 and a strict lead over the next workflow. A count question ("how many …")
 *  is never a non-counting workflow's task (coverage-count: "how many lab reports came in" is not lab triage). */
export function wfFor(task: string, owners: string[] = []): Wf | null {
  const wfsAll = wfsMod;
  const tw = new Set(words(task).flatMap(forms));
  const wfs = wfsAll.filter((w) => w.revoked === undefined); if (!wfs.length) return null; // a revoked workflow's tasks are skipped, never run
  const count = isCountQuestion(task);
  // each workflow's vocabulary word is one base keyed by its singular; it hits when any of its forms is in the task
  const vs = wfs.map((w) => { const m = new Map<string, string[]>(); for (const x of vocab(w)) { const k = plural(x); m.set(k, [...new Set([...(m.get(k) ?? []), ...forms(x)])]); } return m; });
  const df = new Map<string, number>();
  for (const v of vs) for (const k of v.keys()) df.set(k, (df.get(k) ?? 0) + 1);
  const sc = wfs.map((w, i) => count && !messageCounts(w.spec.raw) ? -1 : [...vs[i].entries()].filter(([, fs]) => fs.some((f) => tw.has(f))).reduce((s, [k]) => s + (df.get(k) === 1 ? 1 : 0.5), 0));
  const order = sc.map((s, i) => [s, i]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const [best, second] = [order[0], order[1]];
  lastVia = "";
  if (!(best[0] < 2 || (second && second[0] >= best[0]))) {
    const w = wfs[best[1]];
    if (words(w.spec.title).some((x) => forms(x).some((f) => tw.has(f)))) { lastVia = "strict"; return w; } // and at least one word of the message's title
  }
  if (process.env.AGENT_WF_ROUTE === "wide") { const w = wideRoute(task, sc, wfs); if (w) { lastVia = "wide"; return w; } }
  // owners: the memos the memo gate matched (or, AGENT_GOVERN=route, those an uncompiled message's govern words named)
  if (owners.length) { const w = governRoute(owners, sc, wfs); if (w) { lastVia = "govern"; return w; } }
  return null;
}
/** What a text names, by meaning (the inputs a workflow's requests carry). `loose` reads a message's own sentence
 *  ("A request names the patient and the date …"); otherwise a task: a patient needs a name or DOB, a lot or an invoice its number. */
export function inputKinds(t: string, loose = false): Set<string> {
  const s = extractSlots(t); const k = new Set<string>();
  // a date of birth is the patient's identity, not a date the request names
  const noDob = t.replace(/\b(?:born|DOB|date of birth)\b[:\s]*(?:on )?(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4}|[A-Z][a-z]+ \d{1,2}, \d{4})/gi, " ");
  if (s.patient || s.dob || (loose && /\bpatients?\b|\bborn\b|\bDOB\b/i.test(t))) k.add("patient");
  if (isoDates(noDob).length || /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}\b/.test(noDob) || (loose && /\bdates?\b/i.test(t))) k.add("date");
  if (s.invoice || (loose && /\binvoice (?:number|#|no\b)/i.test(t))) k.add("invoice");
  if (/\blot\s+[A-Z0-9]*\d[A-Z0-9]*\b/.test(t) || (loose && /\blots?\b/i.test(t))) k.add("lot");
  if (s.provider || (loose && /\bprovider\b/i.test(t))) k.add("provider");
  return k;
}
/** The inputs a workflow's requests carry: those named in its "A request names …" / "you'll be asked …" sentence and
 *  those its worked example's request shows. */
function wfInputs(w: Wf): Set<string> {
  const names = w.spec.raw.match(/\b(?:A|The|Each) (?:request|question) (?:names|gives|asks)[^.]*\./i)?.[0] ?? w.spec.raw.match(/\b(?:you(?:'ll| will) be asked|they'll give you)[^.]*\./i)?.[0] ?? "";
  return new Set([...inputKinds(names, true), ...inputKinds(w.spec.example?.request ?? "")]);
}
/** AGENT_WF_ROUTE=wide: a task the strict vocabulary rule left unrouted goes to the workflow it shares a TOPIC word with (a word
 *  of the message's title, e.g. "invoice") and a vocabulary score >= 1 AND whose every input it names (patient / date /
 *  invoice number / lot / provider), an invoice number or a lot only when the message takes one (a request that names an
 *  invoice number is not a claim's); the winner needs a lead of >= 0.5 (vocabulary score + 0.25 per input) over every other such
 *  workflow, a tie routes nowhere. Strict needs two vocabulary hits; this needs one topic word plus the inputs. */
function wideRoute(task: string, sc: number[], wfs: Wf[] = wfsMod): Wf | null {
  // words meet by their first 5 letters (referral ~ referred, invoice ~ invoiced, recent ~ recently)
  const stem = (x: string) => { const p = plural(x); return p.length >= 6 ? p.slice(0, 5) : p; };
  const tk = inputKinds(task); const ts = new Set(words(task).map(stem));
  const vs = wfs.map((w) => new Set([...vocab(w)].map(stem)));
  const df = new Map<string, number>(); for (const v of vs) for (const x of v) df.set(x, (df.get(x) ?? 0) + 1);
  const cand = wfs.map((w, i) => {
    const k = wfInputs(w);
    const topic = words(w.spec.title).some((x) => ts.has(stem(x)));
    const s = [...vs[i]].filter((x) => ts.has(x)).reduce((a, x) => a + (df.get(x) === 1 ? 1 : 0.5), 0);
    return { w, s: s + 0.25 * k.size, ok: sc[i] >= 0 && topic && s >= 1 && k.size > 0 && [...k].every((x) => tk.has(x)) && ["invoice", "lot"].every((x) => k.has(x) === tk.has(x)) };
  }).filter((c) => c.ok).sort((a, b) => b.s - a.s || b.w.order - a.w.order);
  return cand.length && (cand.length === 1 || cand[0].s - cand[1].s >= 0.5) ? cand[0].w : null;
}
/** AGENT_GOVERN=route: `owners` = the raw text of the uncompiled workflow messages whose govern words blocked the task. The
 *  one the executor can run (answer forms parsed) wins; with several, the strict vocabulary's best, a tie → none. */
function governRoute(owners: string[], sc: number[], pool: Wf[] = wfs): Wf | null {
  const c = pool.map((w, i) => ({ w, s: sc[i] })).filter((x) => x.s >= 0 && owners.includes(x.w.spec.raw)).sort((a, b) => b.s - a.s);
  return c.length && (c.length === 1 || c[0].s > c[1].s) ? c[0].w : null;
}
export const _resetWorkflows = () => { wfs.length = 0; used = 0; routeCache.clear(); };
/** Every captured workflow spec (order, spec, later messages) — read-only view for the learner. */
export const wfList = (): ReadonlyArray<{ order: number; spec: WfSpec; later: string[] }> => wfs;
/** Text-only: would the executor take this task (a captured workflow routes it)? The shift loop uses it to give executor
 *  tasks their own pacer family ("workflow-exec") before any browsing. */
export const wfRouted = (task: string): boolean => wfMode() !== "off" && !!wfFor(task) && lastVia === "strict"; // the wide / govern routes only catch what skipped: lookup keeps its tasks

/** The per-shift funnel (shiftMain logs it as one `wf_funnel` line): tasks seen → no family → blocked by a govern word →
 *  routed to a workflow message → executor ran → executor answered. `viaWide` / `viaGovern`: routes only the AGENT_WF_ROUTE=wide /
 *  AGENT_GOVERN=route variants made; `viaJev`: routes the Jev memo router (AGENT_WF_ROUTER=jev, wfRoute.ts) made. */
export const funnel = { tasks: 0, noFamily: 0, governBlocked: 0, routed: 0, viaWide: 0, viaGovern: 0, viaJev: 0, ran: 0, answered: 0 };
/** How the last wfFor call routed: "strict" | "wide" | "govern" | "" (not routed). */
export let lastVia = "";
export const funnelEvent = () => ({ event: "wf_funnel", mode: wfMode(), route: process.env.AGENT_WF_ROUTE ?? "strict", govern: process.env.AGENT_GOVERN ?? "skip", router: routerMode(), ...funnel, workflows: wfs.length });

// ── memo router (wfRoute.ts): Jev picks the memo when the words did not ──
/** One router decision per task text: the pacer key (shiftMain, before browsing) and the executor share it. */
const routeCache = new Map<string, Promise<RouteDecision | null>>();
let chooser: Chooser | undefined;
/** Test hook: the chooser the router asks (default decisions.choose); counts calls offline. */
export const _setRouteChooser = (c?: Chooser): void => { chooser = c; routeCache.clear(); };
const memosNow = (): Memo[] => { const keys = memoKeys(wfs.map((w) => w.spec)); return wfs.map((w, i) => ({ key: keys[i], spec: w.spec })); };
/** The workflow a task belongs to: the lexical router first (wfFor: its Set 1 route is never overridden), else — router
 *  "jev", executor not off, at least one memo — Jev's choice over the acknowledged memos under the thresholds. The
 *  decision is cached per task text. `quick` skips Jev (the pacer is behind: the task is being skipped anyway). */
export async function wfForAsync(task: string, opts: { quick?: boolean; owners?: string[] } = {}): Promise<{ w: Wf | null; via: "words" | "jev" | null }> {
  const lex = wfFor(task, opts.owners ?? []); if (lex) return { w: lex, via: "words" };
  if (opts.quick || routerMode() !== "jev" || wfMode() === "off" || !wfs.length) return { w: null, via: null };
  let p = routeCache.get(task); if (!p) { p = routeByJev(task, memosNow(), { chooser }).catch(() => null); routeCache.set(task, p); }
  const d = await p; const w = d?.routed ? wfs.find((x) => x.spec === d.routed!.spec) ?? null : null;
  return { w, via: w ? "jev" : null };
}
/** Async form of wfRouted: the strict words, else Jev (unless `quick`). As in wfRouted, a wide / govern route never claims the
 *  pace key (lookup keeps its tasks); a Jev route does (the executor will run it). */
export const wfRoutedAsync = async (task: string, opts: { quick?: boolean } = {}): Promise<boolean> => {
  if (wfMode() === "off") return false;
  const r = await wfForAsync(task, opts); return !!r.w && (r.via === "jev" || lastVia === "strict");
};

/** Chart tabs the message names (by meaning), always the chart's main page. */
function tabsFor(raw: string): string[] {
  const t = raw.toLowerCase(); const tabs = [""];
  if (/insurance|payer|plan\b|authori[sz]/.test(t)) tabs.push("/insurance");
  if (/problem|diagnos|condition/.test(t)) tabs.push("/problems");
  if (/\bnotes?\b/.test(t)) tabs.push("/notes");
  if (/immuni[sz]|vaccin|dose|shot/.test(t)) tabs.push("/immunizations");
  if (/document|report|letter|scan/.test(t)) tabs.push("/documents");
  if (/claim|remittance/.test(t)) tabs.push("/claims");
  if (/invoice|balance|billed|payment/.test(t)) tabs.push("/invoices");
  return tabs;
}
const ISO = /\b(\d{4}-\d{2}-\d{2})\b/;
function isoDates(task: string): string[] {
  const out = new Set<string>(); for (const m of task.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) out.add(m[0]);
  for (const m of task.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) out.add(`${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`);
  const MON = "january february march april may june july august september october november december".split(" ");
  for (const m of task.matchAll(/\b(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2}), (\d{4})\b/gi)) out.add(`${m[3]}-${String(MON.indexOf(m[1].toLowerCase()) + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`);
  return [...out];
}

/** A site list (Documents / Billing) filtered to one date by its own labelled filters, every page read (gather v2;
 *  the live gather is wfGather.ts v3). The date fields are found by label in the page's GET filter form (a pair whose
 *  labels contain `key` and from / to); the form's non-clearing submit button applies them (coverage-exec). */
async function listForDate(cr: any, path: string, marker: RegExp, key: RegExp, date: string, why: string[]): Promise<string | null> {
  if (!(await cr.navTo(path, marker, 9000, true))) { why.push(`${path} not reached`); return null; }
  const op = new Operator(cr);
  const inv = await op.inventory().catch(() => null);
  const form = (inv?.forms ?? []).find((f: any) => f.method === "get" && f.fields.filter((x: any) => x.kind === "date" && key.test(x.label)).length === 2);
  if (!form) { why.push(`${path}: no filter form with two ${key} date fields`); return null; }
  const ds = form.fields.filter((x: any) => x.kind === "date" && key.test(x.label));
  const from = ds.find((x: any) => /\bfrom\b|after|start/i.test(x.label)), to = ds.find((x: any) => /\bto\b|before|end/i.test(x.label));
  const btn = (form.submit as string[]).filter((b) => !/clear|reset/i.test(b));
  if (!from || !to || from === to || btn.length !== 1) { why.push(`${path}: date fields / submit not identified (${ds.map((x: any) => x.label).join(", ")}; ${form.submit.join(", ")})`); return null; }
  for (const l of [from.label, to.label]) { const r = await op.set(l, date); if (!r.ok) { why.push(`${path}: ${l}: ${r.why}`); return null; } }
  const s = await op.submit(from.label, btn[0]); if (!s.ok) { why.push(`${path}: ${s.why}`); return null; }
  let text = await cr.decodedText(); const seen = new Set<string>([text]);
  for (let i = 0; i < 12; i++) {
    let p = await op.pager().catch(() => null);
    if (!p) { await new Promise((r) => setTimeout(r, 400)); p = await op.pager().catch(() => null); text = await cr.decodedText(); } // settle once
    if (!p) return /\bno\b[^.\n]{0,40}\b(match|found)/i.test(text) ? text : (why.push(`${path}: no pager / total`), null);
    if (p.approx) { why.push(`${path}: total is approximate`); return null; }
    if (p.to >= p.total) return text;
    const r = await op.press("Next", { exact: true }); if (!r.ok) { why.push(`${path}: ${r.why}`); return null; }
    const t = await cr.decodedText(); if (seen.has(t)) { why.push(`${path}: pager did not advance`); return null; }
    seen.add(t); text += "\n" + t;
  }
  why.push(`${path}: more than 12 pages`); return null;
}

async function gather(index: ClinicIndex, spec: WfSpec, request: string): Promise<Gathered & { inputs: Record<string, unknown> }> {
  const s = extractSlots(request); const cr = (index as any).crawler; const why: string[] = [];
  const inputs: Record<string, unknown> = { patient: s.patient ?? null, dob: s.dob ?? null };
  if (!cr) return { pages: [], why: "no live crawler", inputs };
  const pages: Gathered["pages"] = [];
  const inv = request.match(/\binvoice\s*(?:#|number|no\.?)?\s*(\d{8})\b/i)?.[1];
  const dates = isoDates(request); inputs.invoice = inv ?? null; inputs.dates = dates;
  if (inv) {
    const pg = await cr.fetchInvoicePage(inv).catch(() => null);
    if (pg) pages.push({ name: `Invoice ${inv} (Billing → Find invoice)`, text: await cr.decodedText().catch(() => "") });
    else pages.push({ name: `Billing → Find invoice ${inv}`, text: "No invoice page opened for that number." });
  } else if (s.patient) {
    const ensure = (index as any).ensurePatient;
    if (ensure) await ensure(s.patient, s.dob).catch(() => {});
    const pat: PatientRecord | null = index.findPatient(s.patient, s.dob);
    if (!pat) return { pages: [], why: "patient not resolved", inputs };
    const txt = await cr.fetchTabsText(pat.id, tabsFor(spec.raw), 40000).catch(() => "");
    if (txt) pages.push({ name: `Chart of ${pat.name} (tabs)`, text: txt });
    if (/appointment|visit|seen|schedul/i.test(spec.raw)) {
      if (pat.appointmentsComplete !== true) return { pages: [], why: "appointment history not complete", inputs };
      pages.push({ name: `All appointments of ${pat.name} (every page and location; date = local calendar date)`, text: pat.appointments.map((a) => `${a.dateISO} | ${a.service} | ${a.provider} | ${a.location} | ${a.status}`).join("\n") || "(none)" });
    }
  } else if (dates.length === 1 && /\bdocuments?\b|received/i.test(spec.raw)) {
    const t = await listForDate(cr, "/documents", /Received from|Filter documents/, /receiv/i, dates[0], why); if (t) pages.push({ name: `Documents received on ${dates[0]} (filtered, every page)`, text: t });
  } else if (dates.length === 1 && /\binvoices?\b/i.test(spec.raw)) {
    const t = await listForDate(cr, "/billing", /Issued date|Apply filters/, /issued/i, dates[0], why); if (t) pages.push({ name: `Invoices issued on ${dates[0]} (filtered, every page)`, text: t });
  } else why.push("no named input to gather by (patient, invoice number, or one date)");
  return { pages, why: why.join("; ") || undefined, inputs };
}

let used = 0;
/** AGENT_WF_DUMP=<dir>: the example gate's raw replies (bench diagnosis only); otherwise the default runner. */
const exampleDumpRunner = (title: string): Runner | undefined => !process.env.AGENT_WF_DUMP ? undefined : async (b, m, wm, c) => {
  const t = Date.now(); const r = await defaultRunner(b, m, wm, c);
  try { const fs = await import("node:fs"); fs.mkdirSync(process.env.AGENT_WF_DUMP!, { recursive: true }); fs.appendFileSync(`${process.env.AGENT_WF_DUMP}/example-replies.jsonl`, JSON.stringify({ workflow: title, model: m, ms: Date.now() - t, cls: c, reply: r }) + "\n"); } catch {}
  return r;
};
const round2S = (): number => Math.min(30, Number(process.env.AGENT_WF_ROUND2_S ?? 12));
export async function wfExecute(index: ClinicIndex, task: string, secondsLeft: number, compare?: string): Promise<string | null> { return (await wfExecuteDetail(index, task, secondsLeft, compare)).answer; }
/** The executor's decision for one task: the answer (mode "on", every gate passed) or null with the reason, and whether it ran. */
/** What the executor saw on one task, for the learner (learn/learner.ts): the routed workflow, the votes, the example gate, the
 *  gathered pages with their completeness proofs, and the decision it would have taken. */
export type WfDetail = { workflow: string; spec: WfSpec; later: string[]; would: string | null; votes: Vote[]; example: { ok: boolean | null; why: string }; pages: Array<{ name: string; proof?: string }>; ms: number };
export async function wfExecuteDetail(index: ClinicIndex, task: string, secondsLeft: number, compare?: string, owners: string[] = []): Promise<{ answer: string | null; why: string; ran: boolean; detail?: WfDetail }> {
  // compare: the deterministic answer we are sending anyway (AGENT_WF_COMPARE=1 measurement) → shadow only
  const mode = compare !== undefined ? "shadow" : wfMode(); if (mode === "off") return { answer: null, why: "", ran: false };
  // compare mode (a family answered; measurement only): words only, Jev is not spent on a task a family claimed
  let { w, via } = compare !== undefined ? { w: wfFor(task, owners), via: "words" as string | null } : await wfForAsync(task) as { w: Wf | null; via: string | null };
  if (!w && compare === undefined) { w = wfFor(task, owners); via = w ? lastVia : null; } // wide / govern routes
  if (!w) return { answer: null, why: "", ran: false };
  if (compare === undefined) { funnel.routed++; if (via === "jev") funnel.viaJev++; else if (lastVia === "wide") funnel.viaWide++; else if (lastVia === "govern") funnel.viaGovern++; }
  const max = Number(process.env.AGENT_WF_MAX ?? (mode === "on" ? 400 : 12));
  const taskS = Math.min(90, Number(process.env.AGENT_WF_TASK_S ?? 20));
  const models = wfRunModels();
  const rec: Record<string, unknown> = { event: "wf_exec", mode, workflow: w.spec.title, routed: via, ...(compare !== undefined ? { deterministic: compare } : {}) };
  const skip = (why: string, ran = false) => { rec.why = why; try { process.stdout.write(JSON.stringify(rec) + "\n"); } catch {} return { answer: null, why: "workflow executor: " + why, ran }; };
  if (used >= max) return skip(`AGENT_WF_MAX ${max} reached`);
  if (secondsLeft < Number(process.env.AGENT_WF_RESERVE_S ?? 240)) return skip("shift reserve");
  if (!pacer.extraOk(taskS, "wf")) return skip("pacer: no slack for a workflow run");
  // spend governor (spend.ts): the executor's projected per-task spend must stay under the reserve line
  { const g = spend.allowTask(); if (!g.ok) { rec.spend = { spent: +spend.state.total.usd.toFixed(3), est: +spend.estTaskUsd().toFixed(4), line: +spend.lineUsd().toFixed(2) }; return skip(g.why); } }
  if (models.length < 2) return skip("fewer than 2 executor models listed");
  used++;
  const t0 = Date.now();
  const policy = wfPolicy(models.length); const exMode = (process.env.AGENT_WF_EXAMPLE ?? "pass-or-na").toLowerCase();
  const useV3 = (process.env.AGENT_WF_GATHER ?? "v3").toLowerCase() !== "v2";
  const g3r: { v: GatherOut | null } = { v: null };
  const work = (async () => {
    if (w.exampleLast?.transient) { w.example = undefined; w.exampleLast = undefined; }
    w.example ??= exampleGateText(w.spec, { models, concurrency: 1, runner: exampleDumpRunner(w.spec.title) }).catch((e) => ({ ok: false, why: "example threw " + String(e).slice(0, 60) }));
    { const p = w.example!; p.then((r) => { if (w.example === p) w.exampleLast = r; }).catch(() => {}); }
    // the gather gets the task budget minus what the votes need (~6 s in parallel); the example gate runs alongside
    const gatherS = Math.min(Number(process.env.AGENT_WF_GATHER_S ?? 8), taskS - 6);
    const g = useV3 ? (g3r.v = await gatherV3(index, w.spec, task, { budgetMs: Math.max(3000, gatherS * 1000) }), { ...asGathered(g3r.v), inputs: g3r.v.inputs }) : await gather(index, w.spec, task);
    if (!g.pages.length) return { g, votes: [], d: { answer: null, why: "no pages gathered" + (g.why ? ": " + g.why : "") }, eg: await w.example };
    if (g.why) return { g, votes: [], d: { answer: null, why: "gather incomplete: " + g.why }, eg: await w.example };
    // the votes get what is left of the task cap; a run that has not answered by then counts as an abstention
    // (k=1 strict: an abstention never blocks an answer, a different answer does)
    const left = t0 + taskS * 1000 - Date.now();
    if (left < 6000) return { g, votes: [], d: { answer: null, why: `time budget: ${Math.round((Date.now() - t0) / 1000)} s spent gathering` }, eg: await w.example };
    // votes on the text slots in force (the learned cap: 1 → sequential, with early stop)
    // AGENT_WF_DUMP=<dir>: the gathered pages and every run's raw reply, one JSON file per task (bench diagnosis only)
    const dumpDir = process.env.AGENT_WF_DUMP; const raws: Array<{ model: string; reply: string | null }> = [];
    const runner: Runner | undefined = dumpDir ? async (b, m, wm, c) => { const r = await defaultRunner(b, m, wm, c); raws.push({ model: m, reply: r }); return r; } : undefined;
    const [votes, eg] = await Promise.all([runVotes(w.spec, w.later, task, g, { models, concurrency: textSlots(), waitMs: left - 500, stopEarly: true, runner }), w.example]);
    if (dumpDir) try { const fs = await import("node:fs"); fs.mkdirSync(dumpDir, { recursive: true }); fs.writeFileSync(`${dumpDir}/${Date.now()}-${w.spec.title.replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}.json`, JSON.stringify({ task, workflow: w.spec.title, pages: g.pages, raws, example: eg }, null, 1)); } catch {}
    let d = decide(votes, w.spec, policy);
    // Round 2 (AGENT_WF_ROUND2, default on): every run applied the workflow and abstained (no answer, none said "not this
    // question") → one more follow-up round steered by the runs' own reasons, then the votes again on the larger page set.
    // Only on pacer slack; its time is on top of the task cap (AGENT_WF_ROUND2_S, default 12 s). The gates are unchanged.
    let round2: Record<string, unknown> | undefined;
    if (!d.answer && useV3 && g3r.v?.more && process.env.AGENT_WF_ROUND2 !== "0" && votes.length && votes.every((v) => v.applies !== false && v.answer == null && !v.err)) {
      const r2S = round2S(); const t2 = Date.now();
      if (pacer.extraOk(r2S, "wf")) {
        const added = await g3r.v.more(votes.map((v) => v.rule ?? "").filter(Boolean), Math.max(3000, (r2S - 7) * 1000)).catch(() => 0);
        round2 = { added, ms: Date.now() - t2 };
        const left2 = t0 + (taskS + r2S) * 1000 - Date.now();
        if (added > 0 && left2 > 5000) {
          const g2 = { ...asGathered(g3r.v), inputs: g3r.v.inputs };
          const votes2 = await runVotes(w.spec, w.later, task, g2, { models, concurrency: textSlots(), waitMs: left2 - 500, stopEarly: true, runner });
          d = decide(votes2, w.spec, policy); round2.runs = votes2.map((v) => ({ m: v.model.split("/").pop(), a: v.answer, applies: v.applies, q: v.quotes, grounded: v.grounded }));
          votes.splice(0, votes.length, ...votes2); Object.assign(g, g2);
        }
      } else round2 = { skipped: "pacer: no slack" };
    }
    if (d.answer && exMode !== "ignore" && eg.ok === false) d = { answer: null, why: "worked example not reproduced: " + eg.why };
    if (d.answer && exMode === "require" && eg.ok !== true) d = { answer: null, why: "workflow has no worked example" };
    return { g, votes, d, eg, round2 };
  })();
  const capS = taskS + (useV3 && process.env.AGENT_WF_ROUND2 !== "0" ? round2S() : 0);
  const res = await Promise.race([work, new Promise<null>((r) => setTimeout(() => r(null), capS * 1000))]);
  rec.ms = Date.now() - t0; rec.policy = policy; rec.models = models;
  if (!res) { const g3 = g3r.v; if (g3) rec.gather = { ms: g3.ms, steps: g3.steps, stripped: g3.stripped, pages: g3.pages.length }; return skip(`time budget (${taskS} s)`, true); }
  rec.inputs = res.g.inputs; rec.pages = res.g.pages.map((p) => `${p.name} (${p.text.length})`); rec.gatherWhy = res.g.why;
  { const g3 = g3r.v; if (g3) rec.gather = { ms: g3.ms, steps: g3.steps, stripped: g3.stripped }; }
  rec.runs = res.votes.map((v) => ({ m: v.model.split("/").pop(), a: v.answer, applies: v.applies, q: v.quotes, grounded: v.grounded, ...(v.ungrounded.length ? { ung: v.ungrounded.slice(0, 2) } : {}), ...(v.err ? { err: v.err } : {}) }));
  if ((res as any).round2) rec.round2 = (res as any).round2;
  rec.example = res.eg.ok === null ? "n/a" : res.eg.ok ? "ok" : res.eg.why; rec.would = res.d.answer; rec.why = res.d.why || undefined;
  try { process.stdout.write(JSON.stringify(rec) + "\n"); } catch {}
  const detail: WfDetail = { workflow: w.spec.title, spec: w.spec, later: w.later, would: res.d.answer, votes: res.votes, example: { ok: res.eg.ok, why: res.eg.why }, pages: (g3r.v?.pages ?? res.g.pages).map((p: any) => ({ name: p.name, proof: p.proof })), ms: rec.ms as number };
  return { answer: mode === "on" && res.d.answer ? res.d.answer : null, why: res.d.answer ? (mode === "on" ? "" : "workflow executor (shadow): would answer " + res.d.answer) : "workflow executor: " + res.d.why, ran: true, detail };
}
/** Executor runs: AGENT_WF_MODELS, else the measured default set, filtered to what the endpoint lists. While text spend
 *  runs ahead of the shift's pace (spend.aheadOfPace), the expensive runs are dropped as long as two cheap ones remain
 *  (haiku-5.5 + gemini-3.8-flash: wfEval offline 108 right / 2 wrong of 110 answered, 98.2 %, same as sonnet + gemini). */
export function wfRunModels(): string[] {
  const env = (process.env.AGENT_WF_MODELS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const all = (env.length ? env : ["anthropic/claude-sonnet-5.5", "anthropic/claude-haiku-5.5", "google/gemini-3.8-flash"]).filter((m) => isListed(m));
  // the cheap pair also when only ONE text slot is in force (learned 429 cap): the votes run sequentially, and two fast
  // runs (~5 s each) fit the 20 s task cap where three would not
  const sequential = textSlots() === 1 && process.env.AGENT_WF_CHEAP_WHEN_SEQUENTIAL !== "0";
  if ((!spend.state.cheap && !sequential) || process.env.AGENT_WF_CHEAP_WHEN_AHEAD === "0") return all;
  const cheap = all.filter((m) => spend.isCheap(m));
  return cheap.length >= 2 ? cheap : all;
}
void ISO;
