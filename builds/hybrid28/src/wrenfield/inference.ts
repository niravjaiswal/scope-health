/**
 * Fast-inference layer for the Speedrun agent.
 *
 * Architecture (all per-task work is deterministic; the model is an offline builder
 * and a rare per-template fallback, never the per-task hot path):
 *
 *   GET item ─┬─ message → MessageStore.ingest()  (compile once, version, store)  → acknowledge
 *             └─ task    → Classifier.plan()       (keyword → memoized template → model-translate)
 *                          → QueryEngine.run(plan, index, rules, facts)
 *                          → format + verify → answer | skip
 *
 * The clinic data is pre-loaded into `ClinicIndex` at warm-up, so solvers are µs.
 * Messages are compiled between tasks (model OK there); tasks apply compiled rules
 * deterministically. Memoization is keyed by (template, ruleVersion) so a mid-shift
 * rule change invalidates dependent plans.
 */

import { familyMatch, FAMILY_SOLVERS, KEYWORD_OK, type FamilyMatch } from "./families.js";
import { solveFamily } from "./solvers.js";
import { why, resetWhy, takeWhy } from "./why.js";
import { matchMemo, scoreMemos, memoInfo, mergeAmendment, TOUCH_MIN, type MemoInfo } from "./memoGate.js";
import { messageFamily, parsePolicy, POLICY_FIELDS } from "./policyParse.js";

// ── The data the clinic exposes (filled in from the real Wrenfield schema) ──
export interface ClinicIndex {
  /** Resolve a patient by name (+ optional DOB) → record, or null/ambiguous. */
  findPatient(name: string, dobISO?: string): PatientRecord | null;
  /** True if ANY patient has this name (used to avoid treating an ambiguous patient
   *  name as a provider). */
  nameIsPatient?: (name: string) => boolean;
  /** False when provider specialties aren't loaded → specialty-dependent rules skip. */
  hasSpecialties?: boolean;
  /** Generic entity access + indexes built at warm-up. */
  appointments: Appointment[];
  providers: Map<string, Provider>; // by name
  // invoices, documents, slots, locations … added as the schema is mapped
  byDate: (entity: "appointment" | "invoice" | "document", dateISO: string) => any[];
  /** Read a value out of a rendered document (PDF/image viewer) via screenshot + vision.
   *  Returns the extracted value, or null when not present/not confident → skip. Live-only. */
  readDocument?: (docHref: string, question: string) => Promise<string | null>;
  /** Generalist fallback: answer a question from the patient's gathered chart text (verified
   *  grounded), when the deterministic solvers can't. Returns null → caller skips. Live-only. */
  answerGeneralist?: (question: string, name?: string, dob?: string) => Promise<string | null>;
  /** Live page readers for the family solvers (solvers.ts). Never cached: they answer "as of now". */
  invoicePage?: (invoice: string) => Promise<InvoicePage | null>;
  providerDay?: (provider: string, dateISO: string) => Promise<ProviderDay | null>;
  /** Build the claim-next-step engine context from the live claim detail + payer contract. null → skip. */
  claimContext?: (name: string, dobISO: string | undefined, dosISO: string, policy?: import("./claimNextStep.js").ClaimPolicy) => Promise<import("./claimNextStep.js").ClaimContext | null>;
  /** Build the filing-deadline engine context from the not-yet-filed claim + payer filing terms. null → skip. */
  filingContext?: (name: string, dobISO: string | undefined, dosISO: string) => Promise<import("./filingDeadline.js").FilingContext | null>;
  /** Build the tetanus engine context: wound-visit flag + wound class + documented dose dates. null → skip. */
  tetanusContext?: (name: string, dobISO: string | undefined, visitISO: string, rule: import("./immunizations.js").TetanusRule) => Promise<import("./tetanusWound.js").TetanusContext | null>;
  /** Patients left to notify for a recalled vaccine lot (or UNKNOWN_LOT); null → skip. */
  recallLeft?: (lot: string, policy: { unknownToken: string }) => Promise<string | null>;
  /** Build the good-faith-estimate context: insurance/self-pay status, scheduling date, location closures. null → skip. */
  goodFaithContext?: (name: string, dobISO: string | undefined, apptDateISO: string, time: string) => Promise<import("./goodFaith.js").GoodFaithContext | null>;
  /** Read a lab report (tesseract + vision model agreement) + chart context for the lab-triage engine; `rule` = the parsed limits table. null → skip. */
  /** Aggregate reads over the appointment list (aggregate.ts / apptList.ts). `begin` starts a task's time budget. */
  aggregate?: import("./aggregate.js").AggSource & { begin?: (budgetMs: number, opts?: { endEstimate?: boolean; gate?: (estS: number) => boolean }) => void };
  /** Clinic-wide list reads (Documents / Billing) for list-count questions (listQuery.ts / listRead.ts). */
  lists?: import("./listQuery.js").ListSource & { begin?: (budgetMs: number) => void };
  labContext?: (name: string, dobISO: string | undefined, panel: string, receivedISO: string, rule?: import("./labTriage.js").LabRule) => Promise<{ report: { panel: string; values: Record<string, number> }; patient: import("./labTriage.js").LabPatient; prev: Record<string, number> | "none" | "unknown" } | null>;
}

export interface PatientRecord { id: string; name: string; dobISO: string; demographics: Record<string, string>; appointments: Appointment[]; documents: Doc[];
  /** false when the appointments read failed or couldn't be fully understood; absence-based answers must skip. */
  appointmentsComplete?: boolean; }
/** A provider's day across every location, as the schedule page shows it (unpaginated). */
export type ProviderDay = { provider: string; dateISO: string; sections: Array<{ location: string; working: string; rows: Array<{ time: string; patient: string; flags: string[]; type: string; status: string; open: boolean }> }> };
/** An invoice detail page: the details list and the ledger, as read. */
export type InvoicePage = { invoice: string; patient: string; dosISO?: string; total?: number; payments: number[]; other: string[]; status: string; owed?: number; void: boolean };
/** `provider` is the name without its title; `providerRaw` the row's own text ("Name, NP") and `time` its clock text ("9:20 AM MDT"),
 *  both only where the crawl captured them (formFlags.ts: AGENT_FORM_PROVIDER / AGENT_FORM_DATETIME). */
export interface Appointment { dateISO: string; provider: string; status: string; service: string; location: string; providerRaw?: string; time?: string; }
export interface Provider { name: string; specialty: string; active: boolean; }
export interface Doc { title: string; kind: string; receivedISO: string; source?: string; docHref?: string; }

// ── Answer types (the 7 from shift.md) + formatters ──
export type AnswerType = "whole" | "decimal" | "date" | "datetime" | "phone" | "text" | "list";
export const format: Record<AnswerType, (v: any) => string> = {
  whole: (v) => String(Math.round(Number(v))),
  decimal: (v) => String(Number(v)),
  date: (v) => v, // normalize to YYYY-MM-DD or as the workflow specifies
  datetime: (v) => v,
  phone: (v) => String(v),
  text: (v) => String(v).trim(),
  list: (v) => (Array.isArray(v) ? v.join(", ") : String(v)),
};

// ── A structured query plan: what inference produces ──
export interface QueryPlan {
  type: string; // template id, e.g. "patient.phone", "appointments.count", "billing.new-or-established"
  entity: "patient" | "provider" | "appointment" | "invoice" | "document" | "aggregate";
  op: "lookup" | "count" | "sum" | "filter" | "extreme" | "rule" | "document";
  output: { field?: string; answerType: AnswerType };
  ruleType?: string; // if op==="rule", which workflow rule governs it
}

// ── Messages: compile once, version, supersede, apply ──
export type MessageKind = "workflow" | "amendment" | "revocation" | "fact" | "noise";
export interface CompiledMessage {
  id: string; order: number; raw: string;
  kind: MessageKind;
  /** memoGate.ts: a workflow memo (its structure says so), the memo an amendment / revocation is about, an amendment's effective date. */
  memo?: boolean; amends?: string; revokes?: string; effective?: string; why?: string;
  scope: string[];          // task-types / entities this governs, e.g. ["billing.new-or-established"]
  supersedesId?: string;    // explicit replacement of an earlier message
  rule?: CompiledRule;      // for workflow/amendment
  fact?: Fact;              // for fact
  active: boolean;
}
export interface CompiledRule { ruleType: string; version: number; evaluate: (ctx: RuleContext) => unknown; params?: Record<string, unknown>; }
export interface Fact { subject: string; predicate: string; value: unknown; }
export interface RuleContext { index: ClinicIndex; patient?: PatientRecord; params: Record<string, string>; facts: Fact[]; }

/** Injected: uses the model (LLM_BASE_URL) to compile a raw message into structure. Runs
 *  between tasks, so it's off the task hot path. */
export type MessageCompiler = (raw: string, order: number, known: CompiledMessage[]) => Promise<CompiledMessage>;

export class MessageStore {
  private msgs: CompiledMessage[] = [];
  private rulesByType = new Map<string, CompiledRule>();        // active rule per type
  private ruleVersion = new Map<string, number>();              // bump on change → invalidates memo
  private factsBySubject = new Map<string, Fact[]>();

  /** Workflow memos (memoGate.ts), in arrival order, with their amendments and revocation merged in. */
  private memoList: MemoEntry[] = [];

  constructor(private compile: MessageCompiler) {}

  /** Call when a message item arrives; returns after storing (then the caller acknowledges). */
  async ingest(raw: string): Promise<void> {
    const m = await this.compile(raw, this.msgs.length, this.msgs);
    this.msgs.push(m);
    this.noteMemo(m);
    if (m.supersedesId) { const old = this.msgs.find((x) => x.id === m.supersedesId); if (old) old.active = false; }
    if ((m.kind === "workflow" || m.kind === "amendment") && m.rule) {
      for (const scope of m.scope) {
        this.rulesByType.set(scope, m.rule);                     // later holds
        this.ruleVersion.set(scope, (this.ruleVersion.get(scope) ?? 0) + 1); // invalidate memo
      }
    }
    if (m.kind === "fact" && m.fact) {
      const arr = this.factsBySubject.get(m.fact.subject) ?? [];
      arr.push(m.fact); this.factsBySubject.set(m.fact.subject, arr);
    }
    // "noise" is still kept (a later task may reference it) — just not indexed as rule/fact.
  }

  ruleFor(type: string): CompiledRule | undefined { return this.rulesByType.get(type); }
  /** Raw text of every message scoped to `type` (the governing workflow + its amendments), joined —
   *  so a reader can parse the full spec (e.g. the lab limits table) straight from the message. */
  rawFor(type: string): string { return this.msgs.filter((m) => m.scope?.includes(type)).map((m) => m.raw).join("\n\n"); }
  versionFor(type: string): number { return this.ruleVersion.get(type) ?? 0; }
  factsFor(subjects: string[]): Fact[] { return subjects.flatMap((s) => this.factsBySubject.get(s) ?? []); }
  all(): CompiledMessage[] { return this.msgs; }
  /** Keyword phrases of active workflows we could NOT compile into an executable rule. A task
   *  matching these is governed by a rule we don't implement → the caller declines (never wrong). */
  /** Raw text of every uncompiled workflow message whose govern keywords this task matches (no logging; AGENT_GOVERN=route). */
  governOwners(text: string): string[] { return this.msgs.filter((m) => m.active && m.kind === "workflow" && !m.rule && m.scope.some((s) => { const re = s.startsWith("govern:") ? governRe(s.slice(7)) : null; return !!re && re.test(text); })).map((m) => m.raw); }
  governKeywords(): string[] { return this.msgs.filter((m) => m.active && m.kind === "workflow" && !m.rule && !m.memo).flatMap((m) => m.scope).filter((s) => s.startsWith("govern:")).map((s) => s.slice("govern:".length)); }

  // ── workflow memos (memoGate.ts) ──
  private noteMemo(m: CompiledMessage): void {
    if (m.memo) {
      const fam = messageFamily(m.raw); let familyOk = false;
      // parsed as the family = its rule compiled (new/established) or at least one of its policy fields read (a field the message
      // does not give declines only the answers that need it: the family's own solver decides those)
      try { familyOk = !!fam && (fam === "new-vs-established" ? !!m.rule : parsePolicy(fam, m.raw).missing.length < (POLICY_FIELDS[fam]?.length ?? 1)); } catch {}
      this.memoList.push({ id: m.id, order: m.order, raw: m.raw, title: memoInfo(m.raw).title, info: memoInfo(m.raw), compiled: !!m.rule, family: fam, familyOk, amendments: [] });
    }
    const target = m.amends ?? m.revokes; const e = target ? this.memoList.find((x) => x.id === target) : undefined;
    if (e) { mergeAmendment(e.info, m.raw); if (m.revokes) e.revokedBy = m.order; else { e.amendments.push({ order: m.order, raw: m.raw, effective: m.effective }); if (m.rule) e.compiled = true; } }
    try { process.stdout.write(JSON.stringify({ event: "memo_class", n: m.order, kind: m.kind, memo: m.memo ? memoInfo(m.raw).title : undefined, about: e?.title, effective: m.effective, why: m.why, family: m.memo ? this.memoList.at(-1)?.family ?? undefined : undefined, familyOk: m.memo ? this.memoList.at(-1)?.familyOk : undefined }) + "\n"); } catch {}
  }
  memos(): ReadonlyArray<MemoEntry> { return this.memoList; }
  /** Memos whose answers no rule of ours computes (no compiled rule): a task they govern goes to the executor, never the free-form paths. */
  openMemos(): number { return this.memoList.filter((e) => !e.compiled && e.revokedBy === undefined).length; }
  /** The memo gate's decision for a task (MEMO-GATE.md):
   *  - revoked:  the task touches a memo a later message revoked ("stop answering …") → skip;
   *  - governed: it matches (matchMemo, MATCH_MIN) a memo no rule of ours compiles and its family (if any) does not own → executor or skip;
   *  - touched:  it shares a memo's key words below a match (TOUCH_MIN) → the free-form paths do not answer it; executor or skip;
   *  - none.     A memo that a family parsed completely (`familyOk`) is that family's: its family tasks pass. */
  memoGate(text: string, family: string | null = null): MemoDecision {
    if (!this.memoList.length) return { action: "none", memos: [] };
    // a family with its own solver owns its tasks (it parses its own memo; familyBlocked took the task away if that failed)
    if (family && FAMILY_SOLVERS.has(family)) return { action: "none", memos: [] };
    const refs = this.memoList.map((e, i) => ({ key: i, info: e.info }));
    const open = (i: number) => { const e = this.memoList[i]; return !e.compiled && e.revokedBy === undefined && !(family && e.family === family && e.familyOk); };
    const sc = scoreMemos(text, refs);
    const revoked = sc.filter((x) => this.memoList[x.key].revokedBy !== undefined && x.keyed && x.score >= TOUCH_MIN);
    const m = matchMemo(text, refs); const t = m ? null : matchMemo(text, refs, TOUCH_MIN);
    const top = m ?? t;
    // "Skip these" is safe to over-apply (a skip is 0): a task that touches a revoked memo is skipped unless another memo's score is
    // more than twice the revoked memo's (it is plainly that memo's task)
    const bestOpen = sc.find((x) => open(x.key) && x.keyed)?.score ?? 0;
    if (revoked.length && revoked[0].score * 2 >= bestOpen) return { action: "revoked", memos: [this.memoList[revoked[0].key]], score: revoked[0].score };
    // a keyword-tier family's task (phone, referral, new/established) is governed only by a memo whose title is about that family's domain
    const dom = family ? GOVERN_DOMAIN[family] : undefined;
    const ownsDomain = (i: number) => !dom || dom.test(this.memoList[i].title);
    const gov = (m?.keys ?? []).filter((i) => open(i) && ownsDomain(i)); if (gov.length) return { action: "governed", memos: gov.map((i) => this.memoList[i]), score: m!.score, hits: m!.hits };
    if (family) return { action: "none", memos: [], ...(top ? { score: top.score, hits: top.hits } : {}) }; // a family task is never merely "touched"
    const tch = (t?.keys ?? []).filter(open); if (tch.length) return { action: "touched", memos: tch.map((i) => this.memoList[i]), score: t!.score, hits: t!.hits };
    return { action: "none", memos: [], ...(top ? { score: top.score, hits: top.hits } : {}) };
  }
  /** Practice-family hijack guard: why a memo-dependent family (one whose rule comes from a memo: POLICY_FIELDS) may not take this task,
   *  or "". The family keeps a task only when its memo parsed as that family: the latest memo of the family failed to parse, or no memo
   *  parsed as the family and the task matches another memo → the general path. */
  familyBlocked(family: string, text: string): string {
    if (!(family in POLICY_FIELDS)) return "";
    const own = this.memoList.filter((e) => e.family === family && e.revokedBy === undefined);
    const last = own.at(-1);
    if (last && !last.familyOk) return `the ${family} memo "${last.title}" did not parse as that family`;
    if (!own.some((e) => e.familyOk)) { const g = this.memoGate(text, null); if (g.action === "governed") return `no memo parsed as ${family}; the task matches "${g.memos[0].title}"`; }
    return "";
  }
}
export type MemoEntry = { id: string; order: number; raw: string; title: string; info: MemoInfo; compiled: boolean; family: string | null; familyOk: boolean; revokedBy?: number; amendments: Array<{ order: number; raw: string; effective?: string }> };
export type MemoDecision = { action: "none" | "governed" | "touched" | "revoked"; memos: MemoEntry[]; score?: number; hits?: string[] };

// ── Three-tier classifier with template-keyed memoization ──
/** Injected: model translates a novel question into a QueryPlan (one call per new template). */
export type PlanTranslator = (text: string) => Promise<QueryPlan>;

export class Classifier {
  /** memo keyed by (template signature + rule version) → plan */
  private memo = new Map<string, QueryPlan>();
  constructor(
    private keyword: (text: string) => QueryPlan | null, // tier 1: regex/keyword fast-paths
    private translate: PlanTranslator,                   // tier 3: model (memoized by template)
    private store: MessageStore,
  ) {}

  /** Abstract a question to its template by stripping entities/values (names, dates, numbers). */
  private templateOf(text: string): string {
    return text
      .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "{date}")
      .replace(/\(born[^)]*\)/gi, "(born {dob})")
      .replace(/\b\d+\b/g, "{n}")
      .replace(/[A-Z][a-zÀ-ÿ]+(?:\s+[A-Z][a-zÀ-ÿ.]+)+/g, "{name}") // crude name abstraction
      .toLowerCase().replace(/\s+/g, " ").trim();
  }

  async plan(text: string): Promise<QueryPlan> {
    const fast = this.keyword(text);
    if (fast) return fast; // tier 1: no model
    const tmpl = this.templateOf(text);
    // memo key includes governing rule version so rule changes invalidate cached plans
    const ruleType = tmpl.includes("new") && tmpl.includes("established") ? "billing.new-or-established" : "";
    const key = `${tmpl}|v${ruleType ? this.store.versionFor(ruleType) : 0}`;
    const hit = this.memo.get(key);
    if (hit) return hit; // tier 2: known template → µs, no model
    const plan = await this.translate(text); // tier 3: model, once per template
    this.memo.set(key, plan);
    return plan;
  }
}

// ── Query engine: execute a plan over the index (deterministic, µs) ──
export function runQuery(plan: QueryPlan, index: ClinicIndex, store: MessageStore, params: Record<string, string>): unknown {
  if (plan.op === "rule") {
    const rule = store.ruleFor(plan.ruleType!);
    if (!rule) return null; // no governing rule → caller should skip/fallback
    const patient = params.name ? index.findPatient(params.name, params.dob) : undefined;
    return rule.evaluate({ index, patient: patient ?? undefined, params, facts: store.factsFor([params.provider, params.name].filter(Boolean)) });
  }
  // lookup / count / sum / filter / extreme → execute against index + plan.output.field
  // (schema-specific solvers registered here once the Wrenfield schema is mapped)
  return null; // TODO: dispatch by plan.entity/op/output.field
}

/** Why the generalist may not answer this question at all, or "" if it may. Exact numeric fields
 *  come only from the deterministic decoder; counts, dates and rule outcomes are computed, never
 *  copied. Checked BEFORE any crawl: a task that will be declined must not cost a chart read. */
export function generalistBlocked(text: string): string {
  // A yes/no question's answer is never a value copied from the chart (set2-hyp: "Is X male?" → "Male").
  if (/^\s*(?:is|are|was|were|does|do|did|has|have|had|can|could|will|should)\b/i.test(text)) return "generalist never answers yes/no questions";
  if (/\bphone\b|\bfax\b|\bmrn\b|\bmedical record number\b|\bssn\b|\bsocial security\b|\baccount number\b|\bpolicy number\b|\bmember (id|number)\b|\bamount\b|\bbalance\b|\bcopay\b|\bhow much\b|\btotal (due|charge|amount|cost)\b|\$/i.test(text)) return "generalist never copies phone/MRN/money values";
  if (/\bhow many\b|\bnumber of\b|\bcount\b|\bwhen\b|\bdeadline\b|\bdue\b|\bshould\b|\bnext step\b|\bnew or established\b|\bhow (long|old|soon)\b|\bby when\b|\b(fewest|least|highest|lowest)\b|\btop \d+\b|\bmost (?!recent\b)\w+/i.test(text)) return "generalist never answers counts, rankings, dates or rule outcomes";
  // A reworded question of a family we solve (or decline) deterministically: the family's own reader
  // answers it or nobody does. Variants tooling: reworded good-faith / slot / invoice / referral
  // questions otherwise reached the generalist (would-be −1s).
  if (/\btetanus\b|\brecall(?:ed)?\b|\blot\b|\bclaims?\b|\bfil(?:e|ed|ing)\b|\bgood faith\b|\bestimate\b|\bGFE\b|\blab (?:report|result)s?\b|\binvoices?\b|\bslots?\b|\bopenings?\b|\breferr(?:al|ed|ing)\b|\bbilled\b|\bpayments?\b|\blab(?:oratory)?\b|\bpanel\b|\bblood count\b|\b(?:CBC|BMP|CMP)\b|\btriage\b|\bnurse review\b|\bwound\b|\bTIG\b|\bimmune globulin\b|\bremittance\b|\bdenial|\bappeal|\bnotif(?:y|ied|ication)|\bunnotified\b|\bnew or (?:an )?established\b|\bestablished patient\b/i.test(text)) return "generalist never answers a question in a solved family's domain";
  return "";
}

/** What each keyword-tier family's own rules are about. A govern word from an uncompiled workflow
 *  blocks a task of one of these families only when it is about that family (an uncompiled claim or
 *  good-faith workflow does not change how a phone number or a new/established visit is answered). */
const GOVERN_DOMAIN: Record<string, RegExp> = {
  "new-vs-established": /establish|new[- ]patient|\bnew\b|e\/?m\b|visit cod|cod(?:e|ing)\b|specialt|three[- ]year|\d[- ]year/i,
  "patient-phone": /phone|telephone|contact|number|demographic/i,
  "referral-source": /referr/i,
  "referral-reason": /referr/i,
};
/** The govern word of an uncompiled workflow message that this task matches, or null. Whole words
 *  only (plural allowed; "-", "_" and spaces are one separator), so "claim" no longer fires on
 *  "reclaimed" nor "lab" on "label"; a keyword-tier family task is blocked only by a word about its own
 *  domain. Every decision is logged (`govern_gate`: keyword, family, blocked/exempt). */
const governRe = (raw: string): RegExp | null => {
  const k = raw.toLowerCase().replace(/[-_\s]+/g, " ").trim();
  return k.length <= 3 ? null : new RegExp(`(?<![\\p{L}\\p{N}])${k.split(" ").map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s_-]+")}(?:s|es)?(?![\\p{L}\\p{N}])`, "iu");
};
export function governHit(text: string, govern: string[], family: string | null): string | null {
  for (const raw of govern) {
    const k = raw.toLowerCase().replace(/[-_\s]+/g, " ").trim();
    const re = governRe(raw);
    if (!re || !re.test(text)) continue;
    const dom = family ? GOVERN_DOMAIN[family] : undefined;
    const exempt = !!dom && !dom.test(k);
    try { process.stdout.write(JSON.stringify({ event: "govern_gate", keyword: raw, family, action: exempt ? "exempt" : "blocked" }) + "\n"); } catch {}
    if (!exempt) return raw;
  }
  return null;
}

// ── The shift loop skeleton ──
export interface Verdict { answer?: string; skip?: boolean; confident: boolean; }
export async function handleItem(
  item: { kind: "task" | "message"; text: string },
  deps: { index: ClinicIndex; store: MessageStore; classifier: Classifier; params: (text: string) => Record<string, string>; verify: (plan: QueryPlan, raw: unknown) => boolean; exec?: (plan: QueryPlan, index: ClinicIndex, store: MessageStore, params: Record<string, string>, question?: string) => unknown | Promise<unknown>; family?: FamilyMatch | null; lookup?: (text: string) => Promise<{ answer: string } | { why: string }>; memoGate?: MemoDecision },
): Promise<{ acknowledge: true } | { answer: string } | { skip: true; why: string }> {
  if (item.kind === "message") { await deps.store.ingest(item.text); return { acknowledge: true }; }
  resetWhy();
  const skip = (reason?: string) => ({ skip: true as const, why: reason ?? takeWhy() });
  // ── Family gate, before anything else and before any crawl. A known family has its own solver,
  // may go through the keyword tier (plan checked against the family below), or is skipped.
  let fam = deps.family === undefined ? familyMatch(item.text) : deps.family;
  if (deps.family === undefined && fam && deps.store.familyBlocked?.(fam.family, item.text)) fam = null; // shiftMain does this itself (and logs it)
  if (fam && FAMILY_SOLVERS.has(fam.family)) { const a = await solveFamily(fam, deps.index, deps.store).catch((e) => { why("solver threw: " + String(e).slice(0, 120)); return null; }); return a ? { answer: a } : skip(); }
  if (fam && !KEYWORD_OK[fam.family]) return skip("family has no solver: " + fam.family); // known family, no solver → 0 points in 0 s
  if (!fam && process.env.AGENT_UNKNOWN_FAMILY === "0") return skip("unknown family; AGENT_UNKNOWN_FAMILY=0"); // strict mode: catalog families only
  const params = deps.params(item.text);                        // extract entities once (both tiers use it)
  // A task governed by a workflow message we couldn't compile into an executable rule → decline
  // outright (a message changed the rules; neither tier may answer without honoring it → 0 > −1).
  // The memo gate (MEMO-GATE.md): a task a revoked memo covers is skipped; a task a workflow memo we cannot compile governs (or, with
  // no family, touches) is never answered by the keyword tier, the lookup or the generalist (shiftMain hands it to the executor).
  const gate = deps.memoGate ?? deps.store.memoGate?.(item.text, fam?.family ?? null); // (the shift loop's decision includes the router's)
  if (gate?.action === "revoked") return skip(`revoked workflow memo: ${gate.memos[0].title}`);
  if (gate && gate.action !== "none") {
    const titles = gate.memos.map((e) => e.title).join(" | ") || "(routed by the memo router)";
    return skip(`${gate.action === "touched" ? "touches" : "governed by"} workflow memo: ${titles}`);
  }
  // workflow messages only the model recognised (no memo structure): their scope words, as before
  const govern = deps.store.governKeywords?.() ?? [];
  if (govern.length) { const kw = governHit(item.text, govern, fam?.family ?? null); if (kw) return skip("governed by an uncompiled workflow message: " + kw); }

  // ── Tier A: deterministic (fast, µs). Produces a verified answer, a document marker, or nothing.
  const plan = await deps.classifier.plan(item.text).catch(() => null);
  if (plan) {
    if (plan.type === "skip.derived") return skip("asks for a derived part of a field; format unknown"); // deliberate skip
    if (plan.type === "skip.ambiguous") return skip("the question carries two different field intents"); // deliberate skip
    if (plan.type === "skip.near-miss") return skip("near miss of a field lookup (someone else's / yes-no / not the balance)"); // deliberate skip
    if (fam && !KEYWORD_OK[fam.family].includes(plan.type)) return skip(`plan ${plan.type} answers a different question than family ${fam.family}`);
    // A count of DIFFERENT people / a ranking is the aggregate engine's question (it declined it); the
    // keyword tier's appointment count would answer another question (variants: "how many different
    // people had a completed appointment at X in May" answered as one patient's appointment count).
    if (!fam && plan.type.startsWith("aggregate.") && /\b(?:different|distinct|unique|individual|separate)\s+(?:patients|people|persons)\b|\beach (?:person|patient) once\b|\bduplicate (?:records?|registrations?)\b|\btop \d+\b|\b(?:most|fewest|busiest)\b/i.test(item.text)) return skip(`plan ${plan.type}: a distinct-people count or ranking the aggregate engine did not parse`);
    const raw = await (deps.exec ?? runQuery)(plan, deps.index, deps.store, params, item.text);
    if (raw !== null && typeof raw === "object" && "__doc" in (raw as any)) {
      // Document questions live in a rendered image → read via vision. These don't fall back to
      // chart text (the value isn't in the DOM), so this path is self-contained.
      const d = (raw as any).__doc as { docHref: string; question: string };
      const val = deps.index.readDocument ? await deps.index.readDocument(d.docHref, d.question) : null;
      const out = (val ?? "").toString().trim();
      return out === "" ? skip(deps.index.readDocument ? undefined : "no document reader") : { answer: out };
    }
    if (raw != null && deps.verify(plan, raw)) {
      const fmt = format[plan.output.answerType];
      const out = fmt ? fmt(raw).trim() : "";
      if (out !== "") return { answer: out };                   // deterministic win
      return skip(`plan ${plan.type}: empty after formatting`);
    }
    if (raw != null) return skip(`plan ${plan.type}: verification failed`);
    // A generic chart question (chartAnswers.ts) that declined is never handed to the generalist.
    if (plan.type.startsWith("chart.")) return skip();
    if (fam) return skip(); // the solver said why
  } else if (fam) return skip(`family ${fam.family}: no keyword plan matched this phrasing`);

  // ── Tier B: generalist, only for tasks of NO known family, and only for verbatim-copy questions.
  // Counts, dates and rule outcomes are computed, never copied, so the generalist never answers
  // them (a number or date found somewhere in 9000 chars of page text is not an answer). Exact
  // numeric fields (phone, MRN, money) come only from the deterministic decoder.
  // ── Lookup path (lookup.ts): one labelled value or one page-proven count from the patient's chart, before the
  // substring-grounded generalist. Its decline falls through to the generalist unchanged.
  let lookupWhy = "";
  if (deps.lookup) { const r = await deps.lookup(item.text).catch((e) => ({ why: "lookup threw: " + String(e).slice(0, 100) })); if ("answer" in r) return { answer: r.answer }; lookupWhy = "; " + r.why; }
  if (!deps.index.answerGeneralist) return skip("no deterministic plan; no generalist" + lookupWhy);
  const blocked = generalistBlocked(item.text);
  if (blocked) return skip("no deterministic plan; " + blocked + lookupWhy);
  // The generalist copies a value in the page's own form: never while a workflow memo that fixes answer forms is in force.
  if ((deps.store.openMemos?.() ?? 0) > 0 && process.env.AGENT_GENERALIST_UNDER_MEMO !== "on") return skip("no deterministic plan; the generalist does not answer while a workflow memo is in force" + lookupWhy);
  const g = (await deps.index.answerGeneralist(item.text, params.name, params.dob).catch(() => null))?.trim() ?? "";
  if (!g) return skip("generalist: no grounded value in the page text" + (takeWhy() !== "unspecified" ? " (" + takeWhy() + ")" : ""));
  if (!/[A-Za-z]/.test(g) || /^\d{4}-\d{2}-\d{2}$/.test(g)) return skip("generalist: answer was a bare number or date, never copied: " + g.slice(0, 40));
  return { answer: g };
}
