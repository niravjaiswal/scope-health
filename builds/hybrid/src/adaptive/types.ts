/**
 * Adaptive agent — core types.
 *
 * The whole premise: NOTHING about the question catalog or the site layout is known ahead of time.
 * The agent learns, at runtime, (a) what KINDS of question exist (intents), and (b) HOW to answer each
 * kind on THIS clinic (a plan). Both are built as questions stream in, so the same binary adapts to a
 * different question set (Set 2/3 rephrasings) and a different Wrenfield architecture without edits.
 */

/** A typed value lifted out of a question (a name, a date, a dollar amount, …). The skeleton keeps
 *  the ROLE; the concrete value rides along so a learned plan can be re-bound to a new question. */
export interface Slot { role: SlotRole; value: string; raw: string }
export type SlotRole =
  | "NAME" | "DOB" | "DATE" | "TIME" | "MONTH" | "MONEY" | "INVOICE" | "NUMBER" | "CODE" | "QUOTED";

/** A question reduced to its shape: the text with every slot replaced by `{ROLE}` (+ the slots). Two
 *  questions with the same wording but different values share a skeleton; rephrasings do NOT — those
 *  are unified later by the learned intent (semantic), not the skeleton (lexical). */
export interface Signature { skeleton: string; slots: Slot[]; keywords: string[] }

/** One step of a learned plan: a tool call whose string args are templated by slot ROLE (e.g.
 *  `{"name":"{NAME}","dob":"{DOB}"}`), so replay re-binds them from the new question's slots. */
export interface PlanStep { tool: string; args: Record<string, string> }

/** A learned way to answer one intent on this clinic: the navigation recipe + how the answer was
 *  finally extracted. Induced from the first agentic solve, replayed (fast) for later same-intent
 *  questions, and repaired if replay stops grounding. */
export interface Plan { steps: PlanStep[]; extract: { kind: "field" | "table" | "document" | "model"; hint: string }; ruleMark?: number; /** the question that taught it */ question?: string; }

/** A runtime-learned classifier: an intent label, the skeletons/keywords that map to it, and the plan
 *  that answers it. Confidence/usage drive repair and eviction. */
export interface Classifier {
  intent: string;
  skeletons: Set<string>;
  keywords: Set<string>;
  plan?: Plan;
  wins: number;
  losses: number;
}

/** Result of solving one task. `answer` is set only when grounded; otherwise `skip` with a reason. */
export type Solved = { answer: string; intent: string; via: "replay" | "agentic" } | { skip: true; reason: string; intent?: string };

/** An observation returned by a tool — compact text the model (and the grounding gate) reads. */
export interface Observation { tool: string; text: string; ok: boolean }
