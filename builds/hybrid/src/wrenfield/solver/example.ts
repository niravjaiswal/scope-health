/**
 * The worked example of a policy message, read deterministically: the request, the expected answer and
 * the explanation (the facts the example states). The expected answer never comes from a model.
 */
import { headingsIn } from "../policyText.js";

export type WorkedExample = { request: string; answer: string; explanation: string; section: string };

export function workedExample(raw: string): WorkedExample | null {
  const secs = headingsIn(raw);
  const sec = [...secs].reverse().find((s) => /\bexample\b/i.test(s.heading));
  let body = sec?.body ?? "";
  if (!sec) { const i = raw.search(/\n\s*(?:For example|Example)\b[^\n]*\n/i); if (i < 0) { const j = raw.search(/\b(?:If someone asks|Request)\s*:/i); if (j < 0) return null; body = raw.slice(j); } else body = raw.slice(i); }
  const q = body.match(/[“"]([^"”]{8,400})[”"]/); if (!q) return null;
  const after = body.slice(body.indexOf(q[0]));
  const a = after.match(/\banswer(?: is|:)\s*:?\s*`([^`]+)`/i) ?? after.match(/`([^`]+)`/);
  if (!a) return null;
  const explanation = body.replace(q[0], "").replace(/^\s*(?:If someone asks|Request)\s*:\s*/im, "").replace(/^\s*(?:The answer is|Answer:)\s*`[^`]+`\.?\s*$/im, "").trim();
  return { request: q[1].trim(), answer: a[1].trim(), explanation, section: body.trim() };
}

/** The message without its worked example: what a second-opinion world builder may NOT see is the
 *  rule; what the plan writer must not lean on is the explanation. Here: the rule part only. */
export function ruleText(raw: string): string {
  const secs = headingsIn(raw);
  const k = secs.map((s) => /\bexample\b/i.test(s.heading)).lastIndexOf(true);
  if (k < 0) return raw;
  const lines = raw.split("\n"); const h = lines.findIndex((l) => l.includes(secs[k].heading) && /^\s*(#|\*\*)/.test(l));
  return h < 0 ? raw : lines.slice(0, h).join("\n").trim();
}
