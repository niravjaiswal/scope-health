/**
 * Shared offline harness for the variants tooling: the real Set 1 queue, the 158 run's per-item
 * record, a message store primed exactly as the 158 run compiled each message, and an instrumented
 * fake clinic whose every reader records the call it got. Tracing a task through the real
 * handleItem against it gives the task's ACTION: which reader(s) it reaches with which arguments,
 * and whether it ends in an answer. Two phrasings of one task are equivalent iff their actions are.
 *
 * The fake answers deterministically from the arguments it is called with (an invoice page for the
 * invoice asked, a day for the provider/date asked...), so a different argument shows up as a
 * different action, never as the same answer by accident. Pages carry the ORIGINAL task's facts
 * (`truth`), so a reader's own cross-checks (patient on the invoice page, service date) run for real.
 */
import { readFileSync } from "node:fs";
import { MessageStore, Classifier, handleItem, type ClinicIndex, type PatientRecord, type QueryPlan, type CompiledMessage } from "../inference.js";
import { toPlan, params, exec, compiler } from "../run.js";
import { familyMatch } from "../families.js";

export const FIX = new URL("../../../fixtures/", import.meta.url).pathname;
export type Item = { kind: "task" | "message"; text: string };
export type LogItem = { n: number; kind: "task" | "message"; family: string | null; ms: number; text: string; plan?: string | null; slots?: Record<string, any>; result?: { answer?: string; skip?: boolean }; why?: string; compiled?: any };

export const loadItems = (): Item[] => readFileSync(FIX + "set1-items.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
export const loadLog = (name = "run-158-items.jsonl"): LogItem[] => readFileSync(FIX + "set1/" + name, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r: any) => r.event === "item");

// ── normalisation ──
export const normName = (s?: string) => (s ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[.,]/g, " ").split(/\s+/).filter(Boolean).sort().join(" ");
export const normProv = (s?: string) => normName((s ?? "").replace(/,?\s*(MD|DO|PA-C|PA|NP|RN|CNM|CRNA|PhD|PsyD)\.?\s*$/i, ""));
/** Slots → comparable form: names as sorted token sets, providers without title, everything else trimmed lower. */
export function normSlots(s: Record<string, any> | undefined): Record<string, string> {
  const o: Record<string, string> = {};
  for (const [k, v] of Object.entries(s ?? {})) {
    if (v == null || typeof v === "object") continue;
    const x = String(v);
    o[k] = k === "name" ? normName(x) : k === "provider" ? normProv(x) : x.trim().toLowerCase();
  }
  return o;
}

// ── message store primed as the 158 run compiled each message ──
/** The 158 run compiled the non-regex messages with the model (govern scopes, facts). Offline the
 *  model is unreachable, so take those results from the run's own record; regex-compiled messages
 *  (lab, new/established) go through the real compiler. */
export function replayCompiler(log: LogItem[]) {
  const byText = new Map(log.filter((r) => r.kind === "message").map((r) => [r.text, r.compiled]));
  return async (raw: string, order: number, known: CompiledMessage[] = []): Promise<CompiledMessage> => {
    const real = await compiler(raw, order, known);
    const rec = byText.get(raw);
    if (real.kind !== "noise" || !rec || rec.kind === "noise") return real;
    if (rec.kind === "workflow") return { id: `m${order}`, order, raw, kind: "workflow", scope: rec.scope ?? [], active: true };
    if (rec.kind === "fact" && rec.fact) return { id: `m${order}`, order, raw, kind: "fact", scope: [], fact: rec.fact, active: true };
    return real;
  };
}
/** Stores after the first k messages, k = 0..#messages (a task is traced against the store the
 *  queue had built when it arrived). */
export async function storesByPrefix(items: Item[], log: LogItem[]): Promise<MessageStore[]> {
  const msgs = items.filter((i) => i.kind === "message");
  const comp = replayCompiler(log);
  const out: MessageStore[] = [];
  for (let k = 0; k <= msgs.length; k++) { const st = new MessageStore(comp); for (const m of msgs.slice(0, k)) await st.ingest(m.text); out.push(st); }
  return out;
}
/** Number of messages before each item index. */
export const messagesBefore = (items: Item[]) => { let k = 0; return items.map((i) => { const v = k; if (i.kind === "message") k++; return v; }); };

// ── instrumented fake clinic ──
export type Trace = { calls: string[]; answer: string | null; why?: string; generalist: boolean };
const OPAQUE = /^(labContext|claimContext|filingContext|tetanusContext|goodFaithContext)\(/;

/** Set 1's location names: a "patient" by one of these names never resolves at the live clinic. */
const PLACES = new Set(["northgate", "front range", "eastside", "stonebrook", "lakeside", "riverbend", "highline", "prairie view", "cedar hollow", "willow creek"].map(normName));
/** Would the live resolver find a chart for `name`? It searches by DOB (or last name) and requires
 *  every token of the asked name in the row's name. So a name padded with extra words (a captured
 *  "… Garrison. Thank you so much") never resolves, nor does a place; any other name may resolve
 *  (a real person with that name may exist), possibly to someone else than the task meant. */
export function resolves(name: string, truthName?: string): boolean {
  const n = normName(name); if (!n || PLACES.has(n)) return false;
  if (!truthName) return true;
  const want = n.split(" "), have = new Set(normName(truthName).split(" "));
  return !(want.length > have.size && [...have].every((t) => want.includes(t)));
}

export function fakeClinic(truth: Record<string, string>, calls: string[]): ClinicIndex {
  const rec = (s: string) => { calls.push(s); };
  const ok = (n: string) => resolves(n, truth.name);
  const patient = (name: string, dob?: string): PatientRecord => ({
    id: "/patients/x", name, dobISO: dob ?? truth.dob ?? "1980-01-01", appointmentsComplete: true,
    demographics: { phone: `PHONE[${normName(name)}]`, email: "a@b.c", address: "1 Main St" },
    appointments: [{ dateISO: "2026-01-08", provider: "Amy Fuller", status: "Scheduled", service: "Office visit", location: "Northgate" }],
    documents: [{ title: "Referral letter from Granite Fork Internal Medicine", kind: "referral letter", receivedISO: truth.received ?? "2024-12-20", source: `SOURCE[${normName(name)}]`, docHref: `/documents/${normName(name).replace(/ /g, "-")}` }],
  });
  return {
    providers: new Map(), hasSpecialties: true, appointments: [], byDate: () => [],
    findPatient: (name, dob) => { if (!ok(name)) return null; rec(`findPatient(${normName(name)}|${dob ?? ""})`); return patient(name, dob); },
    nameIsPatient: () => false,
    readDocument: async (href, q) => { rec(`readDocument(${href})`); return "DOCVALUE"; },
    answerGeneralist: async (q, name, dob) => { rec(`generalist(${normName(name)}|${dob ?? ""})`); return "GENERALIST ANSWER"; },
    invoicePage: async (inv) => { rec(`invoicePage(${inv})`); return { invoice: inv, patient: truth.name ?? "Unknown Person", dosISO: truth.dos, total: 100, payments: [40], other: [], status: "Partly paid", owed: 60, void: false }; },
    providerDay: async (prov, date) => {
      rec(`providerDay(${normProv(prov)}|${date})`);
      return { provider: prov.replace(/,?\s*(MD|DO|PA-C|PA|NP)\.?$/i, "").trim(), dateISO: date, sections: [{ location: truth.location ?? "Northgate", working: "Working 9:00 AM to 5:00 PM", rows: [
        // 2 scheduled, 3 completed, 4 open: each count question has its own answer
        ...[1, 2].map((i) => ({ time: `9:0${i} AM`, patient: `S${i}, P`, flags: [], type: "Office visit", status: "Scheduled", open: false })),
        ...[1, 2, 3].map((i) => ({ time: `10:0${i} AM`, patient: `C${i}, P`, flags: [], type: "Office visit", status: "Completed", open: false })),
        ...[1, 2, 3, 4].map((i) => ({ time: `11:0${i} AM`, patient: "", flags: [], type: "", status: "", open: true }))] }] };
    },
    claimContext: async (n, d, dos) => { if (!ok(n)) return null; rec(`claimContext(${normName(n)}|${d ?? ""}|${dos})`); return null; },
    filingContext: async (n, d, dos) => { if (!ok(n)) return null; rec(`filingContext(${normName(n)}|${d ?? ""}|${dos})`); return null; },
    tetanusContext: async (n, d, v) => { if (!ok(n)) return null; rec(`tetanusContext(${normName(n)}|${d ?? ""}|${v})`); return null; },
    goodFaithContext: async (n, d, date, time) => { if (!ok(n)) return null; rec(`goodFaithContext(${normName(n)}|${d ?? ""}|${date}|${time})`); return null; },
    labContext: async (n, d, panel, rcv) => { if (!ok(n)) return null; rec(`labContext(${normName(n)}|${d ?? ""}|${panel.toLowerCase()}|${rcv})`); return null; },
  };
}

/** Trace one task through the real handleItem against the fake clinic. */
export async function trace(text: string, store: MessageStore, truth: Record<string, string> = {}): Promise<Trace> {
  const calls: string[] = [];
  const index = fakeClinic(truth, calls);
  const classifier = new Classifier(toPlan, async () => { throw new Error("disabled"); }, store);
  const deps = { index, store, classifier, params, verify: (_: QueryPlan, raw: unknown) => raw != null, exec };
  const out = await handleItem({ kind: "task", text }, deps).catch((e) => ({ skip: true as const, why: "threw " + String(e) }));
  const answer = "answer" in out ? out.answer : null;
  return { calls, answer, why: (out as any).why, generalist: calls.some((c) => c.startsWith("generalist(")) };
}

/** A trace as one comparable string. */
export const actionOf = (t: Trace) => `${t.answer !== null ? "A" : "S"}:${t.calls.join(">")}${t.answer !== null ? "=" + t.answer : ""}`;

/** A trace without the chart lookups: every fake value already encodes whose chart it came from
 *  (PHONE[name], SOURCE[name], /documents/<name>, reader arguments), so a resolution by name only
 *  (no DOB) that reaches the same values is the same action. */
export const canonOf = (t: Trace) => `${t.answer !== null ? "A" : "S"}:${t.calls.filter((c) => !c.startsWith("findPatient(")).join(">")}${t.answer !== null ? "=" + t.answer : ""}`;

export type Verdict = "SAME" | "DECLINE" | "DIFFERENT" | "GENERALIST";
/** How a variant's trace compares with its original's. DIFFERENT and GENERALIST are would-be −1s:
 *  the variant reached an answer (or an opaque reader) by a different path or with different
 *  arguments. DECLINE is a lost point (0) but safe. */
export function compare(orig: Trace, v: Trace): Verdict {
  if (canonOf(orig) === canonOf(v)) return "SAME";
  if (v.answer !== null) return v.generalist ? "GENERALIST" : "DIFFERENT";
  const op = (t: Trace) => t.calls.filter((c) => OPAQUE.test(c)).join(">");
  if (op(v) && op(v) !== op(orig)) return "DIFFERENT";
  if (op(v) && op(v) === op(orig) && orig.answer === null) return "SAME";
  return "DECLINE";
}
/** What kind of answer a trace ends in: its terminal readers + the answer's shape (fake values
 *  carry their kind, e.g. PHONE[..] → PHONE). Two traces of one kind answer the same question. */
export function kindOf(t: Trace): string {
  const readers = t.calls.filter((c) => !c.startsWith("findPatient(")).map((c) => c.replace(/\(.*$/, ""));
  const shape = t.answer === null ? (readers.some((r) => OPAQUE.test(r + "(")) ? "(opaque)" : "") : t.answer.replace(/\[.*?\]/g, "");
  return shape ? `${readers.join(">")}=${shape}` : "";
}
/** For hard negatives: does the trace end in the same KIND of answer as the family's original task? */
export const reachesFamilyPath = (t: Trace, orig: Trace) => kindOf(t) !== "" && kindOf(t) === kindOf(orig);

export { familyMatch };

// ── deterministic RNG ──
export function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export const pick = <T>(r: () => number, xs: T[]): T => xs[Math.floor(r() * xs.length)];
