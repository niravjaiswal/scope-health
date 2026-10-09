/**
 * Shift entrypoint: implements the Speedrun queue contract end-to-end.
 *   read env → build ClinicIndex (crawl SITE_URL) → loop GET /item → handleItem → POST /item/close
 * Every failure degrades to skip (0), never a wrong answer (−1). Honors the shift deadline.
 */
import { MessageStore, Classifier, handleItem, generalistBlocked, type ClinicIndex, type QueryPlan } from "./inference.js";
import { toPlan, params, exec, compiler } from "./run.js";
import { extractSlots } from "./parse.js";
import { familyMatch, KEYWORD_OK } from "./families.js";
import { checkModels, faultCount, taskTick, lastCause } from "./failover.js";
import { choose } from "./decisions.js";
import { routerMode } from "./wfRoute.js";
import { setShiftDeadline } from "./apptList.js";
import { Crawler } from "./crawl.js";
import { pacer } from "./pacer.js";
import { applyProfile } from "./profile.js";
import { cacheMode, cacheNoteMessage, cacheSummary } from "./readCache.js";
import { fontMemoStats } from "./fontDecode.js";
import { siteWatchSummary } from "./siteWatch.js";
import * as spend from "./spend.js";
import { adaptiveGate, adaptiveAnswerOk } from "./adaptiveGate.js";
// Adaptive fallback (src/adaptive): the runtime-learning agent. Handles tasks baseline's family router
// can't place (Set 2/3 rephrasings / different site) by exploring + learning a replayable plan.
import { solve as adaptiveSolve } from "../adaptive/solver.js";
import { Knowledge as AdaptiveKB } from "../adaptive/memory.js";
import { ShiftState as AdaptiveState } from "../adaptive/state.js";
import { wfNoteMessage, wfExecute, wfExecuteDetail, wfRoutedAsync, wfList, funnel, funnelEvent } from "./wfShadow.js";
import { lookup, lookupSpec } from "./lookup.js";
import { providerMode, dateTimeOn } from "./formFlags.js";
// Recursive learning loop (src/wrenfield/learn): procedure library + within-shift learner + safe harness. AGENT_LEARN=off (default)
// | shadow | canary | on. Fires only for a task no deterministic family claimed (harness rule (a)); Set 1 is protected by construction.
import { learnMode, learnHarness } from "./learn/harness.js";
import { learner } from "./learn/learner.js";
import { captureWorkflow, workflowFor, skipKey, capturedWorkflows } from "./workflowCapture.js";
import * as wfShadow from "./wfShadow.js";
import { memoRouter, setMemoRouter } from "./memoGate.js";
import { bestEffort, beRouted } from "./bestEffort.js";

type Close = { id: string; acknowledge?: true } | { id: string; answer: string } | { id: string; skip: true };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runShift(index: ClinicIndex, opts: { maxItems?: number } = {}): Promise<{ closed: number }> {
  const QUEUE = process.env.QUEUE_URL;
  if (!QUEUE) throw new Error("QUEUE_URL not set");
  const store = new MessageStore(compiler);
  // The async memo router: wfShadow.wfForAsync where this build has it (s3: words, then the router decision), unless one is set already.
  { const f = (wfShadow as any).wfForAsync as undefined | ((t: string, o?: object) => Promise<{ w: { spec: { raw: string } } | null }>);
    if (f && !memoRouter() && process.env.AGENT_MEMO_ROUTER !== "off") setMemoRouter(async (t) => (await f(t, {}))?.w?.spec.raw ?? null); }
  // No model plan tier: a plan the model invents for a novel phrasing answered the wrong question on
  // scored sets. Novel phrasings fall through to the grounded generalist instead.
  const classifier = new Classifier(toPlan, async () => { throw new Error("model plan tier disabled"); }, store);
  const deps = { index, store, classifier, params, verify: (_: QueryPlan, raw: unknown) => raw != null, exec };
  // Margin before the shift ends in which we stop starting new work. `seconds_left` from the
  // queue API is the authoritative clock (the shift started at container boot, before warm-up).
  const margin = Number(process.env.REFERENCE_DEADLINE_MARGIN_SECONDS ?? 4);

  // Retrying queue client: a transient network/5xx blip must not end the shift. A refusal that
  // carries `state` (not_current / ended) returns that state so we reconcile and go on.
  // under hybrid.ts split mode (AGENT_QUEUE_TIMEOUT_MS set) a request can wait on the other agent past fetch's 300 s header limit: keep retrying
  const ATTEMPTS = process.env.AGENT_QUEUE_TIMEOUT_MS ? 1000 : 5, RETRY_MS = 1000;
  const call = async (method: "GET" | "POST", path: string, body?: Close): Promise<any> => {
    let last = "no attempt";
    for (let i = 1; i <= ATTEMPTS; i++) {
      try {
        const r = await fetch(`${QUEUE}${path}`, {
          method, signal: AbortSignal.timeout(Number(process.env.AGENT_QUEUE_TIMEOUT_MS) || 15000), // hybrid.ts split mode raises it (an item can wait on the other agent)
          ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
        });
        const json: any = await r.json();
        if (r.status === 200) return json;
        if (json?.state !== undefined) return json.state; // not_current / ended → reconcile from state
        last = `status ${r.status}: ${JSON.stringify(json).slice(0, 200)}`;
        if (r.status < 500) break; // a 4xx refusal won't change on retry
      } catch (e) { last = String(e); }
      await sleep(RETRY_MS);
    }
    throw new Error(`${method} ${path} failed: ${last}`);
  };
  const getItem = () => call("GET", "/item");
  const close = (body: Close) => call("POST", "/item/close", body);

  let state: any = await getItem();
  // Warm-up cost (container start → first item), for the next pacing round.
  try { const sh = Number(process.env.SHIFT_SECONDS); process.stdout.write(JSON.stringify({ event: "warmup", shiftSeconds: sh || null, secondsLeft: state?.seconds_left ?? null, usedS: sh && typeof state?.seconds_left === "number" ? Math.round((sh - state.seconds_left) * 10) / 10 : null, uptimeS: Math.round(process.uptime() * 10) / 10, e1: pacer.e1, spendCapUsd: spend.capUsd(), spendLineUsd: +spend.lineUsd().toFixed(2) }) + "\n"); } catch {}
  // Per-set flag profile (profile.ts, AGENT_PROFILES; unset = nothing happens): decided by the shift length and the first item, applied to
  // process.env before any task, so the flags read at use below (and the pacer's, reloaded) are this set's.
  try { const ev = applyProfile(process.env, state?.status === "open" ? state.item : null); if (ev) { pacer.reload(); process.stdout.write(JSON.stringify(ev) + "\n"); } } catch {}
  let closed = 0;
  const SHADOW = process.env.AGENT_SHADOW === "1";
  const LEARN = learnMode() !== "off";
  const skips: Record<string, Record<string, number>> = {}; // family → reason → count
  // Adaptive fallback state (disable with AGENT_ADAPTIVE=0). Shares baseline's live crawler; its own
  // learned classifiers/plans + statement/QA log persist across the shift.
  const ADAPT = process.env.AGENT_ADAPTIVE !== "0";
  const adaptiveKb = new AdaptiveKB();
  const adaptiveState = new AdaptiveState();
  const adaptiveCrawler = (index as any).crawler;
  let adaptiveWins = 0;
  while (state?.status === "open" && (!opts.maxItems || closed < opts.maxItems)) {
    const item = state.item;
    const secondsLeft = typeof state.seconds_left === "number" ? state.seconds_left : Infinity;
    if (secondsLeft <= margin) break; // not enough time to safely start another item
    if (Number.isFinite(secondsLeft)) { setShiftDeadline(Date.now() + secondsLeft * 1000); Crawler.shiftEndsAt = Date.now() + secondsLeft * 1000; } // pacer for long list reads; the suspension wait stops before the end
    pacer.begin(secondsLeft); // lab-read pacer (pacer.ts)
    const t0 = Date.now(), faults0 = faultCount(), susp0 = Crawler.suspendWaitedMs;
    taskTick(); // model re-probe clock (failover.noteRead)
    (index as any).beginItem?.(); // reset the per-item [nav] step counter so each item numbers from 0
    let family = item.kind === "task" ? familyMatch(item.text) : null;
    // Practice-family hijack guard (MEMO-GATE.md): a memo-dependent family keeps the task only when its memo parsed as that family.
    if (family) { const fb = store.familyBlocked(family.family, item.text); if (fb) { try { process.stdout.write(JSON.stringify({ event: "family_drop", family: family.family, why: fb }) + "\n"); } catch {} family = null; } }
    // The memo gate (inference.ts MessageStore.memoGate): the memo this task belongs to; when the words found none, the async memo router
    // (s3: the router decision behind wfForAsync) may name one. A governed / touched / revoked task never goes to the lookup.
    let gate = item.kind === "task" ? store.memoGate(item.text, family?.family ?? null) : null;
    if (gate && gate.action === "none" && !family && store.openMemos() > 0 && memoRouter()) {
      const raw = await memoRouter()!(item.text).catch(() => null); const e = raw ? store.memos().find((x) => x.raw === raw && !x.compiled) : undefined;
      if (e) gate = e.revokedBy !== undefined ? { action: "revoked", memos: [e] } : { action: "governed", memos: [e] };
    }
    if (item.kind === "task") { funnel.tasks++; if (!family) funnel.noFamily++; }
    // A task no family takes that a captured workflow message routes is the executor's: it gets its own pacer family
    // ("workflow-exec", measured cost/yield) so a 10-20 s executor task never passes for an instant skip, and the pacer
    // drops it first when behind (tier A skips it without browsing).
    // (words first; then, AGENT_WF_ROUTER=jev, one ~0.3 s router decision over the acknowledged memos — not while the pacer is
    // behind, when a no-family task is skipped without browsing anyway; the decision is cached for the executor)
    // A task no family and no workflow takes that reads as a one-patient chart question is the lookup path's (lookup.ts);
    // one nothing else takes that the best-effort tier would attempt (AGENT_BEST_EFFORT=on, text gate passed) is "best-effort".
    const LOOKUP = process.env.AGENT_LOOKUP !== "off";
    const wfr = item.kind === "task" && !family && gate?.action !== "revoked" && (gate?.action === "governed" || gate?.action === "touched" || (await wfRoutedAsync(item.text, { quick: !pacer.probeOk() }).catch(() => false)));
    // A task the router sends to a memo (words, or Jev at p >= AGENT_WF_ROUTE_P) is that memo's even when the gate's own words found
    // none: never answered by the keyword tier, the lookup or the generalist in their own form (Site C on s3: both wrong answers
    // were routed right by Jev, then answered first by the lookup path).
    if (wfr && gate && gate.action === "none") gate = { action: "governed", memos: [], hits: ["(router)"] };
    if (gate && (gate.action !== "none" || store.memos().length)) try { process.stdout.write(JSON.stringify({ event: "memo_gate", action: gate.action, memos: gate.memos.map((e) => e.title), score: gate.score, hits: gate.hits, family: family?.family ?? null }) + "\n"); } catch {}
    const gated = !!gate && gate.action !== "none";
    const lookupable = LOOKUP && item.kind === "task" && !family && !wfr && !gated && !("why" in lookupSpec(item.text));
    const paceKey = family?.family ?? (wfr ? "workflow-exec" : lookupable ? "lookup" : item.kind === "task" && gate?.action !== "revoked" && beRouted(item.text, family) ? "best-effort" : null);
    // spend governor (spend.ts): the pace of the shift for its projection, and this item's accounting
    spend.tick({ secondsLeft, seen: pacer.itemsSeen, e1: pacer.e1 }); spend.beginTask(closed + 1, item.kind === "message" ? "(message)" : paceKey);
    // Only tasks that can end in an answer get the patient crawled up front: keyword-tier families,
    // and unknown-family tasks that either have a keyword plan or may reach the generalist. Family
    // solvers read their own pages; everything else skips without a crawl (Set 2 lost 126 tasks to
    // the clock while crawling charts for questions the generalist was going to refuse).
    const paceWhy = item.kind === "task" ? pacer.taskWhy(paceKey) : null;
    const crawl = !paceWhy && item.kind === "task" && !gated && (family ? !!KEYWORD_OK[family.family] : (toPlan(item.text) !== null || !generalistBlocked(item.text)));
    let action: Close; let error: string | undefined;
    try {
      if (ADAPT && item.kind === "message") await adaptiveState.ingestMessage(item.text).catch(() => {}); // statements also update the adaptive state machine
      if (item.kind === "message") cacheNoteMessage(item.text); // AGENT_CACHE: a message that says data is changing ends the read cache entries it touches
      if (crawl) {
        // pre-fetch the referenced patient (async) so the sync solver can resolve it, then lazily
        // resolve the specialties of every provider the task might compare (new/established).
        const s = extractSlots(item.text);
        // A demographics-only family (patient-phone) needs neither the appointments nor the documents
        // tab — skip both so the patient crawl is ~1 s instead of paying for tabs it won't read.
        // A known family other than patient-phone can only answer through its own plan (KEYWORD_OK), never the phone or the
        // decoded chart text: its chart open skips the scrambled-font wait (index-builder ChartNeed.phone).
        const need = family?.family === "patient-phone" ? { appointments: false, documents: false } : family ? { phone: false } : undefined;
        if (s.patient) await (index as any).ensurePatient?.(s.patient, s.dob, need).catch(() => {});
        if (s.provider && s.dates[0]) {
          const names = new Set<string>([s.provider.name]);
          const pat = s.patient ? index.findPatient(s.patient, s.dob) : null;
          if (pat) for (const a of pat.appointments) names.add(a.provider);
          await (index as any).ensureProviders?.([...names]).catch(() => {});
        }
      }
      // Lookup path (handleItem Tier B, before the generalist): no family, no workflow route, only on the pacer's slack.
      const lk = lookupable && pacer.extraOk(6, "lookup") && (index as any).crawler ? (t: string) => lookup(t, (index as any).crawler, 15000, undefined, { isProvider: (index as any).isProviderName }) : undefined;
      let out: any = paceWhy ? { skip: true, why: paceWhy } : await handleItem({ kind: item.kind, text: item.text }, { ...deps, family, lookup: lk, memoGate: gate ?? undefined });
      // Workflow executor (workflowExec.ts): shadow by default — logs a would-be answer, never sends it. Not on a pacer skip.
      if (item.kind === "message") { wfNoteMessage(item.text, closed + 1); if (LEARN) { const w = wfList().at(-1); if (w && w.order === closed + 1) learner().onMessage(w.spec, w.order, w.later); } }
      else if (paceWhy) { /* pacer skipped without browsing */ }
      else if ("skip" in out && !family) {
        // a task the govern gate blocked (an uncompiled workflow message's keyword): AGENT_GOVERN=route hands it to that message's executor run
        const gov = /^governed by an uncompiled workflow message/.test(String(out.why)); if (gov || gate?.action === "governed") funnel.governBlocked++;
        // the memo gate's memos are the executor's owners (it routes by its own words first, then Jev, then among these); a task the
        // gate governs or touches is handed to the tiers (executor, learner, best-effort), never skipped by the gate itself
        const owners = gate && (gate.action === "governed" || gate.action === "touched") ? gate.memos.map((e) => e.raw) : gov && process.env.AGENT_GOVERN === "route" ? store.governOwners(item.text) : [];
        if (gate?.action !== "revoked") {
        const left = Number.isFinite(secondsLeft) ? secondsLeft - (Date.now() - t0) / 1000 : 1e9;
        // tier 1: the executor (words, then Jev, route it to a memo; its own gates decide)
        const r = await wfExecuteDetail(index, item.text, left, undefined, owners).catch(() => ({ answer: null, why: "", ran: false }));
        if (r.ran) funnel.ran++; if (r.answer) { funnel.answered++; out = { answer: r.answer }; } else if (r.ran) out = { skip: true, why: r.why };
        // tier 2, learned: a second derivation (the memo's Plan) + calibrated confidence; the harness decides whether an answer the
        // executor did not send may go (never overrides an answer already taken; AGENT_LEARN_VETO=1 withdraws a disputed one)
        if (LEARN && r.ran) {
          const l = await learner().onTask(index, item.text, r, left - (Date.now() - t0) / 1000).catch(() => null);
          if (l) {
            // an answer the executor already sends is logged in shadow (graded later), never charged to the canary budget
            const d = learnHarness.consider({ tier: "learner", task: item.text, family: null, answer: l.answer, p: l.p, signals: l.signals, secondsLeft: left, procedure: l.procedure, why: l.why, ms: l.ms }, "skip" in out ? undefined : "shadow");
            if ("skip" in out && d.send && l.answer) out = { answer: l.answer };
            else if ("answer" in out && process.env.AGENT_LEARN_VETO === "1" && l.derivations.plan != null && l.derivations.plan !== String(out.answer)) out = { skip: true, why: "learner veto: " + l.why };
          }
        }
        // tier 3, best effort (bestEffort.ts, AGENT_BEST_EFFORT=on): a task no family claimed, no lookup answered and neither the
        // executor nor the learner answered is attempted and answered when its estimated precision clears AGENT_BEST_EFFORT_MIN_P.
        // `family` is null on this branch by construction and the tier re-checks familyMatch itself: a family's task can never reach it.
        if ("skip" in out) { const b = await bestEffort(index, item.text, family, Number.isFinite(secondsLeft) ? secondsLeft - (Date.now() - t0) / 1000 : 1e9).catch(() => ({ answer: null, why: "", ran: false })); if (b.answer) out = { answer: b.answer }; else if (b.ran || (b.why && !out.why)) out = { skip: true, why: [out.why, b.why].filter(Boolean).join("; ") }; }
        } // (revoked: "stop answering" — no tier runs)
      }
      else if ("answer" in out && process.env.AGENT_WF_COMPARE === "1") await wfExecute(index, item.text, Number.isFinite(secondsLeft) ? secondsLeft - (Date.now() - t0) / 1000 : 1e9, String(out.answer)).catch(() => null);
      const { why: w, ...close } = out as any;
      action = { id: item.id, ...close } as Close;
      if (w) { error = undefined; const f = family?.family ?? "(no family)"; const key = String(w).replace(/\d{4}-\d{2}-\d{2}/g, "<date>").replace(/"[^"]*"/g, "<x>").slice(0, 110); (skips[f] ??= {})[key] = (skips[f][key] ?? 0) + 1; (action as any).__why = w; }
    } catch (e) {
      action = item.kind === "message" ? { id: item.id, acknowledge: true } : { id: item.id, skip: true }; // fail safe
      error = String(e).slice(0, 200);
    }
    // ADAPTIVE FALLBACK (Set 2/3 generalization) — ONLY for a task whose FAMILY baseline did not
    // recognise (a rephrased / novel question its router missed). That is the one case the agentic
    // layer can add value. When om recognised the family but its reader skipped (patient not resolved,
    // scanned doc, no reader), the adaptive layer shares the same crawler/resolver and cannot do
    // better — running it there only burns ~20s per task (fatal on the 226/458-task sets). So gate on
    // !family. Budget kept tight so even on a novel question it can't run away.
    // Pacer: never when the pacer skipped this task (behind → instant skip) or the shift is behind pace
    // (probeOk false); per-task time hard-capped at 12 s whatever ADAPTIVE_TASK_MS says.
    // (never for a task a memo governs / touches / revoked or the router sent to a memo: their answer form is the memo's)
    if (ADAPT && adaptiveCrawler && item.kind === "task" && !paceWhy && !gated && !wfr && pacer.probeOk() && adaptiveGate(item.text, family?.family ?? null) === "" && "skip" in (action as any)) {
      const budgetLeftMs = (secondsLeft - margin) * 1000;
      if (budgetLeftMs > 9000) {
        const perTask = Math.min(12000, Number(process.env.ADAPTIVE_TASK_MS ?? 12000) || 12000);
        try {
          const r = await adaptiveSolve(item.text, { crawler: adaptiveCrawler, note: () => {} }, adaptiveKb, adaptiveState, Date.now() + Math.min(perTask, budgetLeftMs));
          if ("answer" in r && adaptiveAnswerOk(String(r.answer))) { action = { id: item.id, answer: r.answer }; adaptiveWins++; process.stderr.write(`[adaptive] answered (${r.via}/${r.intent}): ${item.text.replace(/\s+/g, " ").slice(0, 70)}\n`); }
        } catch {}
      }
    }
    // One line per item for the sets that show agent output (Set 1 does): what it was, what we did.
    let skipWhy = "";
    try {
      const rec: Record<string, unknown> = { event: "item", n: closed + 1, kind: item.kind, family: family?.family ?? null, ms: Date.now() - t0, text: item.text, error };
      if (item.kind === "message") { const m = store.all().at(-1); rec.compiled = m && { kind: m.kind, scope: m.scope, params: m.rule?.params, fact: m.fact }; }
      if (item.kind === "message") { const w = captureWorkflow(item.text, closed + 1); if (w) rec.workflow = w; }
      else {
        const s = extractSlots(item.text), pat = s.patient ? index.findPatient(s.patient, s.dob) : null;
        rec.plan = toPlan(item.text)?.type ?? null; rec.slots = family?.slots ?? s;
        rec.patient = pat && { appts: pat.appointments.length, complete: pat.appointmentsComplete, docs: pat.documents.length };
        const { __why, ...result } = action as any; rec.result = result; if (__why) { rec.why = __why; skipWhy = String(__why); } action = result as Close;
        if ("skip" in result) { const k = skipKey(item.text); rec.sk = { ...k, fast: Date.now() - t0 < 300, wf: family ? undefined : workflowFor(item.text)?.title }; }
      }
      if (SHADOW && item.kind === "task") action = { id: item.id, skip: true }; // shadow: work it, log it, never submit it
      process.stdout.write(JSON.stringify(rec) + "\n");
      // Readable one-liner (stderr), to match the navigator's trace: result + question head, right
      // after the per-item [nav] step lines. `why` is appended on a skip so the reason is inline.
      try { const a: any = action; const verb = "answer" in a ? `ans=${JSON.stringify(String(a.answer).slice(0, 48))}` : "skip" in a ? `SKIP${rec.why ? " (" + rec.why + ")" : ""}` : "ack";
        process.stderr.write(`[item ${item.id}] ${item.kind} ${verb} :: ${String(item.text).replace(/\s+/g, " ").slice(0, 90)}\n`); } catch {}
    } catch {}
    // a wait for the account suspension to lift is the product's outage, not the family's pace: it stays out of the family's cost sample (the shift clock carries it)
    pacer.end(paceKey, Date.now() - t0 - (Crawler.suspendWaitedMs - susp0), "answer" in (action as any), !paceWhy, item.kind === "message" ? "message" : "task", faultCount() > faults0);
    spend.endTask({ kind: item.kind, answered: "answer" in (action as any) });
    // Skip probe: the first time a known family skips on a given page type, log that page's HTML once
    // (Set 1 shows agent output), so the next iteration can build/fix the reader from the real layout.
    if (item.kind === "task" && "skip" in (action as any) && family?.family && !paceWhy && pacer.probeOk()) await skipProbe(index, family.family, skipWhy);
    let resp: any;
    try { resp = await close(action); } catch { break; } // queue unreachable after retries → stop
    // reconcile duplicate/stale close; stop on ended
    if (resp?.error?.code === "not_current") { state = resp.state; continue; }
    if (resp?.error?.code === "ended" || resp?.status === "ended") break;
    closed++;
    state = resp;
  }
  try { process.stdout.write(JSON.stringify({ event: "skips", byFamily: skips }) + "\n"); } catch {}
  try { process.stdout.write(JSON.stringify(siteWatchSummary()) + "\n"); } catch {}
  if (cacheMode() !== "off" || fontMemoStats.hits + fontMemoStats.misses > 0) try { process.stdout.write(JSON.stringify(cacheSummary()) + "\n"); } catch {}
  if (ADAPT) try { process.stdout.write(JSON.stringify({ event: "adaptive", wins: adaptiveWins, learned: adaptiveKb.summary() }) + "\n"); } catch {}
  try { process.stdout.write(JSON.stringify(funnelEvent()) + "\n"); } catch {}
  try { process.stdout.write(JSON.stringify({ event: "workflows", captured: capturedWorkflows().map((w) => ({ order: w.order, title: w.title, tokens: w.tokens })) }) + "\n"); } catch {}
  if (LEARN) try { for (const e of learner().events()) process.stdout.write(JSON.stringify(e) + "\n"); process.stdout.write(JSON.stringify(learnHarness.summary()) + "\n"); } catch {}
  return { closed };
}

const probed = new Set<string>();
let probes = 0;
const probesBy = new Map<string, number>();
/** Log the current page (url + body HTML without scripts; long pages keep head AND tail, so pagers/footers —
 *  never captured so far — survive) once per family × page template.
 *  Bounded: AGENT_SKIP_PROBES pages per shift (default 40), AGENT_SKIP_PROBES_PER_FAMILY (default 4), 2 s each; never throws. */
async function skipProbe(index: ClinicIndex, family: string, reason: string): Promise<void> {
  const max = Number(process.env.AGENT_SKIP_PROBES ?? 40);
  // per family too: run 146 spent all 30 on lab/recall/claims before filing + good-faith (items 155+) skipped
  const perFamily = Number(process.env.AGENT_SKIP_PROBES_PER_FAMILY ?? 4);
  const cr = (index as any).crawler;
  if (!cr || probes >= max || (probesBy.get(family) ?? 0) >= perFamily) return;
  try {
    const page = await Promise.race([
      cr.evalApp(`const b=doc.body?doc.body.cloneNode(true):null; if(!b) return null; b.querySelectorAll('script,style').forEach(e=>e.remove()); return {url:(doc.location&&doc.location.pathname+doc.location.search)||'', html:(h=>h.length<=${Number(process.env.AGENT_SKIP_PROBE_CHARS ?? 40000)}?h:h.slice(0,${Math.round(Number(process.env.AGENT_SKIP_PROBE_CHARS ?? 40000)*0.7)})+'\\n<!-- …probe cut… -->\\n'+h.slice(-${Math.round(Number(process.env.AGENT_SKIP_PROBE_CHARS ?? 40000)*0.3)}))(b.outerHTML)};`),
      new Promise((r) => setTimeout(() => r(null), 2000)),
    ]) as { url: string; html: string } | null;
    if (!page?.html) return;
    const key = `${family}|${page.url.replace(/\?.*$/, "").replace(/\/[a-z0-9]{8,12}(?=\/|$)/gi, "/{id}")}`;
    if (probed.has(key)) return;
    probed.add(key); probes++; probesBy.set(family, (probesBy.get(family) ?? 0) + 1);
    process.stdout.write(JSON.stringify({ event: "skip_probe", family, why: reason, template: key.split("|")[1], url: page.url, html: page.html }) + "\n");
  } catch {}
}

/** Build the live ClinicIndex by crawling SITE_URL. (Pluggable — see index-builder.) */
async function buildIndex(): Promise<ClinicIndex> {
  const mod = await import("./index-builder.js").catch(() => null);
  if (mod?.buildClinicIndex) return mod.buildClinicIndex({ siteUrl: process.env.SITE_URL!, user: process.env.SITE_USERNAME!, pass: process.env.SITE_PASSWORD! });
  throw new Error("no index-builder available — wire the Wrenfield crawler into ClinicIndex");
}

/** Index of last resort: if the crawler can't start, still work the queue — acknowledge every
 *  message, skip every task (0), never a crash that leaves items un-closed. */
function nullIndex(): ClinicIndex {
  return { providers: new Map(), appointments: [], hasSpecialties: false, nameIsPatient: () => false, findPatient: () => null, byDate: () => [] };
}

/** Diagnostic (AGENT_SELFTEST=1 only): force the GENERALIST method — the path the fixed practice
 *  tasks never trigger — against THIS run's live clinic with the real LLM, and log each probe's
 *  answer + timing to stderr (shown in the practice record). Never runs on a scored submission
 *  (the env var is baked only into a throwaway test image). Wrapped so it can't affect the shift. */
async function selfTest(index: ClinicIndex): Promise<void> {
  const gen = (index as any).answerGeneralist as undefined | ((q: string, n?: string, d?: string) => Promise<string | null>);
  if (!gen) { console.error("[selftest] index has no answerGeneralist — skipping"); return; }
  // Section-generalist probes: no patient → discovers the clinic's sidebar, routes to the
  // dashboard/section, reads DECODED text, answers (grounded + verified, else null).
  const probes = ["How many open slots are there today?", "How many invoices were issued this week?", "How many patients were seen today?"];
  console.error("[selftest] ==== GENERALIST METHOD PROBES (section generalist, no deterministic path) ====");
  for (const q of probes) {
    const t0 = Date.now(); let ans: string | null = null, err = "";
    try { ans = await gen(q, undefined, undefined); } catch (e) { err = String(e); }
    const ms = Date.now() - t0;
    console.error(`[selftest] ${ms}ms ${ms < 4000 ? "<4s OK" : "OVER-4s"} ans=${JSON.stringify(ans)}${err ? " err=" + err : ""} :: ${q}`);
  }
  console.error("[selftest] ==== END GENERALIST PROBES ====");
}

/** Startup probe of the decision endpoint (decisions.ts → `$LLM_BASE_URL/${AGENT_DECISIONS_PATH ?? "systemone"}`): one `choice`
 *  question with a known answer; logs {"event":"wf_route_probe", ok, choice, p, ms, path} (the transport's own llm line carries the
 *  HTTP status). Diagnostic only: the router does not depend on it. */
async function probeDecisions(): Promise<void> {
  const t0 = Date.now(); const path = process.env.AGENT_DECISIONS_URL ?? (process.env.AGENT_DECISIONS_PATH ?? "systemone");
  try {
    const r = await choose({ request: "What is the phone number on file for the patient García, Abigail (DOB 1952-04-03)?" }, "Which kind of request is this?",
      { phone_number: "The request asks for a patient's phone number.", invoice_balance: "The request asks what is owed on an invoice.", none_of_these: "Neither." }, { cls: "background", waitMs: 8000, tag: "probe" });
    console.log(JSON.stringify({ event: "wf_route_probe", ok: !!r, choice: r?.choice ?? null, p: r ? +(r.probabilities[r.choice] ?? 0).toFixed(3) : null, ms: Date.now() - t0, path, cause: r ? undefined : lastCause || "no reply" }));
  } catch (e) { console.log(JSON.stringify({ event: "wf_route_probe", ok: false, ms: Date.now() - t0, path, cause: String(e).slice(0, 120) })); }
}

if (process.argv[1]?.endsWith("shiftMain.ts")) {
  (async () => {
    // First log line of every run: which code this image was built from (scripts/build-image.sh bakes it in).
    console.log(JSON.stringify({ event: "version", commit: process.env.AGENT_GIT_SHA ?? "unknown", branch: process.env.AGENT_GIT_BRANCH ?? "unknown",
      dirty: process.env.AGENT_GIT_DIRTY ?? "unknown", subject: process.env.AGENT_GIT_SUBJECT ?? "", builtAt: process.env.AGENT_BUILT_AT ?? "unknown" }));
    if (providerMode() !== "off" || dateTimeOn()) console.log(JSON.stringify({ event: "forms", provider: providerMode(), datetime: dateTimeOn() ? "on" : "off" })); // FORM-THEORIES.md: which answer-form flags this run used
    if (!process.env.QUEUE_URL) { console.error("QUEUE_URL not set — nothing to do"); process.exit(0); }
    void checkModels(process.env.AGENT_MODEL ?? "anthropic/claude-haiku-4.5"); // diagnostics only; prunes unlisted fallbacks
    // Jev router on: one tiny decision at startup (background class, ≤ 8 s, ~$0.00002) so every run records whether the proxy
    // serves $LLM_BASE_URL/systemone (the first practice run with the router on had no family-less task, so Jev was never asked)
    if (routerMode() === "jev") void probeDecisions();
    let index: ClinicIndex;
    try { index = await buildIndex(); }
    catch (e) { console.error("index build failed — degrading to skip-only:", String(e)); index = nullIndex(); }
    // Self-test runs BEFORE the shift: the judge tears the clinic down the instant the queue
    // drains, so post-shift probes would hit a dead site. Ample slack (1200s shift, ~16s of work).
    if (process.env.AGENT_SELFTEST) await selfTest(index).catch((e) => console.error("[selftest] fatal:", String(e)));
    // Recon dump (AGENT_RECON=1, throwaway image only): print the detail-page structure the family
    // readers need to stdout, read back from Set-1 logs. Runs before the queue (clinic is torn down
    // once it drains). Never on a scored submission (the env var is baked only into a recon image).
    if (process.env.AGENT_RECON) {
      try { const { reconDump } = await import("./recon.js"); const cr = (index as any).crawler; if (cr) await reconDump(cr); else console.log("[recon] no crawler on index"); }
      catch (e) { console.error("[recon] fatal:", String(e)); }
    }
    const { closed } = await runShift(index);
    console.log(`shift complete: ${closed} items closed`);
    // close the headless browser so the event loop drains, then exit cleanly (otherwise the
    // live Chrome child keeps Node alive and the container hangs after the queue finishes).
    try { await (index as any).close?.(); } catch {}
    process.exit(0);
  })();
}
