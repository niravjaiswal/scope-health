/**
 * The runtime-learned knowledge base — the heart of "classifications are created as it reads
 * questions, not set before the run."
 *
 * Two learned maps, both empty at shift start:
 *  - skeleton → intent : a lexical cache so a wording seen once is never re-classified.
 *  - intent → Classifier(plan) : the semantic class and the recipe that answers it on THIS clinic.
 *
 * resolveIntent unifies a new question to an existing class by (1) exact skeleton, (2) cheap keyword
 * overlap with a known class, or (3) a Haiku classify() call — so rephrasings across Set 2/3 collapse
 * onto the same learned plan, while genuinely new questions mint a new class (and get solved agentic).
 */
import type { Signature, Classifier, Plan } from "./types.js";

const jaccard = (a: Set<string>, b: Set<string>) => { if (!a.size || !b.size) return 0; let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i); };

export class Knowledge {
  private skelToIntent = new Map<string, string>();
  private classifiers = new Map<string, Classifier>();

  intents(): string[] { return [...this.classifiers.keys()]; }
  get(intent: string): Classifier | undefined { return this.classifiers.get(intent); }

  /** Map a question to its intent, learning a new class when nothing matches. `classify` is the Haiku
   *  fallback (called only on a genuinely novel wording). Returns the intent + whether it is new. */
  async resolveIntent(sig: Signature, classify: (q: string, known: string[]) => Promise<{ intent: string } | null>, rawQuestion: string): Promise<{ intent: string; fresh: boolean }> {
    const cached = this.skelToIntent.get(sig.skeleton);
    if (cached) return { intent: cached, fresh: false };
    // cheap semantic-ish unify: strong keyword overlap with a known class → reuse it, no LLM.
    const kw = new Set(sig.keywords);
    let best: { intent: string; score: number } | null = null;
    for (const c of this.classifiers.values()) { const s = jaccard(kw, c.keywords); if (!best || s > best.score) best = { intent: c.intent, score: s }; }
    if (best && best.score >= 0.6) { this.attach(best.intent, sig); return { intent: best.intent, fresh: false }; }
    // novel wording → ask Haiku to name the intent (it may reuse an existing label)
    const c = await classify(rawQuestion, this.intents());
    const intent = c?.intent || `intent_${this.classifiers.size + 1}`;
    const fresh = !this.classifiers.has(intent);
    this.attach(intent, sig);
    return { intent, fresh };
  }

  private attach(intent: string, sig: Signature) {
    let c = this.classifiers.get(intent);
    if (!c) { c = { intent, skeletons: new Set(), keywords: new Set(), wins: 0, losses: 0 }; this.classifiers.set(intent, c); }
    c.skeletons.add(sig.skeleton); for (const k of sig.keywords) c.keywords.add(k);
    this.skelToIntent.set(sig.skeleton, intent);
  }

  setPlan(intent: string, plan: Plan) { const c = this.classifiers.get(intent); if (c) c.plan = plan; }
  win(intent: string) { const c = this.classifiers.get(intent); if (c) c.wins++; }
  loss(intent: string) { const c = this.classifiers.get(intent); if (c) { c.losses++; if (c.losses >= 2 && c.wins === 0) c.plan = undefined; } } // a plan that keeps failing is dropped → re-learn

  summary() { return [...this.classifiers.values()].map((c) => ({ intent: c.intent, hasPlan: !!c.plan, wins: c.wins, losses: c.losses, skeletons: c.skeletons.size })); }
}
