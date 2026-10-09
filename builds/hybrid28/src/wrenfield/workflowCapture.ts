/**
 * Generic capture of policy-message workflows we do not implement (Set 2 diagnosis).
 * A workflow message ("From the <role>: <topic>" + answer tokens in backticks) is reduced to its
 * structure: title, answer tokens (`NEW`, `ESTABLISHED:<date>`...), and topic words. A task whose text
 * shares the topic is tagged with that workflow so the skip log says WHICH uncovered workflow it was.
 * Never answers: no generic rule is verifiable without its reader (0 > -1).
 */
import { createHash } from "node:crypto";

export type CapturedWorkflow = { order: number; title: string; tokens: string[]; topic: string[]; inputs: string; counts?: boolean };
/** A count question ("how many …", "number of …", "count …"). */
export const isCountQuestion = (t: string) => /\bhow many\b|\bnumber of\b|^\s*(?:count|tally)\b|\b(?:count|tally)(?: of| up| the| all| how)\b|\bwhat(?:'s| is) the (?:total )?count\b/i.test(t); // not "Complete blood count"
/** The workflow message itself asks for counts (its answers are numbers of something). A count question is never
 *  governed by a workflow that doesn't count (bench loop: "how many lab reports came in" tagged as lab triage). */
export const messageCounts = (raw: string) => {
  // counting words are everywhere in rule text ("Complete blood count", "count back to …"): only the message's own
  // question decides — its title, or "you'll be asked how many …"
  const title = raw.split("\n")[0];
  return /\b(?:counting|counts? of|how many|number of)\b/i.test(title) || /\b(?:asked|ask you|asks?)\s+(?:for\s+|about\s+)?(?:how many|the number of|a count)\b/i.test(raw);
};
const STOP = new Set("the a an of to for and or in on at by with what when how is are be it its this that from we our your you they them their do does did when which who has have had any each every one".split(" "));
const words = (s: string) => s.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3 && !STOP.has(w));

const captured: CapturedWorkflow[] = [];
export function captureWorkflow(text: string, order: number): CapturedWorkflow | null {
  const tokens = [...new Set([...text.matchAll(/`([A-Z][A-Z_]{2,}(?::[^`\s]*)?)`/g)].map((m) => m[1].replace(/:.*$/, ":")))];
  if (!tokens.length || text.length < 300) return null; // notes and short amendments are not workflows
  const first = text.split("\n")[0];
  const title = (first.match(/^From [^:]+:\s*(.+)$/)?.[1] ?? first).trim().slice(0, 100);
  const inputs = (text.match(/\b(?:A|The) request names ([^.]+)\./i)?.[1] ?? text.match(/they'll give you ([^.]+)\./i)?.[1] ?? "").slice(0, 120);
  const w: CapturedWorkflow = { order, title, tokens: tokens.slice(0, 12), topic: [...new Set(words(title))], inputs, counts: messageCounts(text) };
  captured.push(w);
  return w;
}
/** The latest captured workflow whose title words appear in the task (≥1 distinctive word), or null. */
export function workflowFor(task: string): CapturedWorkflow | null {
  const tw = new Set(words(task));
  let best: CapturedWorkflow | null = null, bestN = 0;
  const count = isCountQuestion(task);
  for (const w of captured) { if (count && !w.counts) continue; const n = w.topic.filter((x) => tw.has(x)).length; if (n > 0 && n >= bestN) { best = w; bestN = n; } }
  return best;
}
/** Compact identity of a skipped task: stable hash + first words (no names/dates beyond the first 8 words). */
export function skipKey(text: string): { h: string; head: string } {
  const t = text.replace(/\s+/g, " ").trim();
  const tmpl = t.replace(/\b\d{4}-\d{2}-\d{2}\b/g, "{d}").replace(/\b\d+\b/g, "{n}");
  return { h: createHash("sha1").update(tmpl).digest("hex").slice(0, 8), head: t.split(" ").slice(0, 8).join(" ") };
}
export const capturedWorkflows = () => captured.slice();
