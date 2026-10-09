/**
 * Shift state — the running transcript that makes the agent stateful across a shift.
 *
 * Two things change future answers and must be remembered:
 *  (1) STATEMENTS (messages): governing rules, amendments (a later one overrides an earlier rule),
 *      and facts. Handled by the proven wrenfield MessageStore, which already layers amendments,
 *      indexes facts, keeps the full raw governing text per scope, and flags workflows it can't
 *      execute. The adaptive agent doesn't run hardcoded rule engines — instead it feeds the RAW
 *      governing text to the solver as context and lets Haiku apply it. So every active workflow is
 *      "executed" by being read.
 *  (2) PRIOR Q&A: a task may refer back ("that same lot", "the patient from before"), or simply
 *      repeat. The QALog caches every question + its answer so later tasks can consult it.
 *
 * activeContext(question) renders the slice of state relevant to one question (bounded), injected
 * into both the agentic loop and a replayed plan's final extract — so answers always reflect the
 * CURRENT rules, even for a plan learned before a rule changed.
 */
import { MessageStore } from "../wrenfield/inference.js";
import { compiler } from "../wrenfield/run.js";

const STOP = new Set("the a an of for to in on at is are do we have what which who when how many that this it i you me my our their them they as by with from a and or".split(/\s+/));
const toks = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));
const overlap = (a: Set<string>, b: Set<string>) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n; };
const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) + " …" : s);

export interface QA { question: string; answer?: string; intent?: string; seq: number }

export class ShiftState {
  readonly store = new MessageStore(compiler);
  private qa: QA[] = [];
  private seq = 0;

  async ingestMessage(raw: string): Promise<void> { try { await this.store.ingest(raw); } catch { /* a message we can't compile is still inert context */ } }
  recordQA(question: string, answer: string | undefined, intent?: string) { this.qa.push({ question, answer, intent, seq: this.seq++ }); }

  /** True when an active workflow governs this question (so it must be answered under a rule, not
   *  guessed). Returns the matching governing raw text (may be empty). */
  governingText(question: string): string {
    const q = toks(question);
    const govs = this.store.all().filter((m) => m.active && (m.kind === "workflow" || m.kind === "amendment"));
    const scored = govs.map((m) => ({ raw: m.raw, score: overlap(q, toks(m.raw)) })).filter((x) => x.score >= 2).sort((a, b) => b.score - a.score);
    return scored.slice(0, 2).map((x) => cap(x.raw, 1800)).join("\n\n");
  }

  /** The state relevant to one question: governing rule text + all facts + the most relevant recent
   *  prior Q&A. Bounded so it never blows the model context. */
  activeContext(question: string): string {
    const parts: string[] = [];
    const gov = this.governingText(question);
    if (gov) parts.push("GOVERNING RULE(S) — apply exactly:\n" + gov);
    const facts = this.store.all().filter((m) => m.active && m.kind === "fact" && m.fact);
    if (facts.length) parts.push("FACTS:\n" + facts.map((m) => `- ${m.fact!.subject} ${m.fact!.predicate}: ${JSON.stringify(m.fact!.value)}`).join("\n"));
    const q = toks(question);
    const relevant = this.qa.filter((x) => x.answer).map((x) => ({ x, s: overlap(q, toks(x.question)) })).filter((r) => r.s >= 2).sort((a, b) => b.s - a.s).slice(0, 5).map((r) => r.x);
    if (relevant.length) parts.push("EARLIER ANSWERS (may be referenced):\n" + relevant.map((x) => `- Q: ${cap(x.question, 120)} → A: ${x.answer}`).join("\n"));
    return cap(parts.join("\n\n"), 6000);
  }

  /** Did any governing rule/amendment arrive AFTER a plan for `intent` was learned? If so the plan is
   *  rule-sensitive and should be re-solved rather than blindly replayed. Tracked by message count at
   *  learn time vs now (any new workflow/amendment since could change the answer). */
  rulesChangedSince(mark: number): boolean { return this.store.all().filter((m) => m.kind === "workflow" || m.kind === "amendment").length > mark; }
  ruleMark(): number { return this.store.all().filter((m) => m.kind === "workflow" || m.kind === "amendment").length; }
  summary() { return { messages: this.store.all().length, qa: this.qa.length }; }
}
