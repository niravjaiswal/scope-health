/**
 * Deterministic question → Signature. No LLM: lift the typed values (dates, DOB, times, money,
 * invoice #, codes, quoted strings, capitalized name runs) out of the text and replace each with its
 * ROLE, yielding a skeleton. The skeleton is the cheap lexical key; identical phrasings collapse to
 * one skeleton (so a seen phrasing never costs a classify call again). Rephrasings get DIFFERENT
 * skeletons — the semantic intent layer (memory.ts + llm.classify) unifies those.
 */
import type { Signature, Slot, SlotRole } from "./types.js";

const STOP = new Set("the a an of for to in on at is are do we have what which who when how many that this it i you me my our their them they as by with from".split(/\s+/));

// Ordered so longer/more specific patterns win (DOB before bare DATE, month-year before number).
const PATTERNS: Array<{ role: SlotRole; re: RegExp; norm?: (m: RegExpExecArray) => string }> = [
  { role: "DOB", re: /\b(?:born|DOB|date of birth)\s*:?\s*(\d{4}-\d{2}-\d{2})\b/gi, norm: (m) => m[1] },
  { role: "DATE", re: /\b(\d{4}-\d{2}-\d{2})\b/g },
  { role: "MONTH", re: /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/gi, norm: (m) => m[0] },
  { role: "TIME", re: /\b(\d{1,2}:\d{2})\b/g },
  { role: "MONEY", re: /\$\s?(\d[\d,]*(?:\.\d{2})?)\b/g },
  { role: "INVOICE", re: /\binvoice\s+#?\s*(\d+)\b/gi, norm: (m) => m[1] },
  { role: "CODE", re: /\b([A-Z]{2,4}-?\d{2,6}|[A-Z]\d{2,4}(?:\.\d+)?)\b/g }, // CARC/CPT/ICD/lot-ish
  { role: "QUOTED", re: /["“]([^"”]{2,60})["”]/g },
];

const NAME_RE = /\b([A-Z][a-zà-ÿ'’.-]+(?:\s+[A-Z][a-zà-ÿ'’.-]+){0,3}(?:,\s*[A-Z][a-zà-ÿ'’.-]+)?)\b/g;
// a capitalized run that's really a name, not a sentence-initial word or a known non-name token
const NOTNAME = /^(What|Which|Who|When|How|Is|Are|Do|Does|Did|Please|Could|Can|The|On|For|Next|Referral|Good|Tetanus|Filing|Patient|DOB|Lab|Complete|Basic)\b/;

export function signature(text: string): Signature {
  const q = text.trim().replace(/\s+/g, " ");
  const slots: Slot[] = [];
  // Mask typed tokens left-to-right, recording spans so later patterns don't double-match inside them.
  const taken: Array<[number, number]> = [];
  const free = (s: number, e: number) => !taken.some(([a, b]) => s < b && e > a);
  let skeleton = q;
  const subs: Array<{ start: number; end: number; role: SlotRole; value: string; raw: string }> = [];
  for (const { role, re, norm } of PATTERNS) {
    re.lastIndex = 0; let m: RegExpExecArray | null;
    while ((m = re.exec(q))) { if (!free(m.index, m.index + m[0].length)) continue; taken.push([m.index, m.index + m[0].length]); subs.push({ start: m.index, end: m.index + m[0].length, role, value: norm ? norm(m) : (m[1] ?? m[0]), raw: m[0] }); }
  }
  // Names last (lowest priority — only on still-free spans, and validated against NOTNAME).
  NAME_RE.lastIndex = 0; let nm: RegExpExecArray | null;
  while ((nm = NAME_RE.exec(q))) {
    const s = nm.index, e = s + nm[0].length;
    if (!free(s, e)) continue;
    const token = nm[1];
    if (NOTNAME.test(token) || token.split(/\s+/).length < 2 && !/,/.test(token)) continue; // require a 2-word or "Last, First" run
    taken.push([s, e]); subs.push({ start: s, end: e, role: "NAME", value: token, raw: token });
  }
  // Build the skeleton by replacing spans right-to-left so indices stay valid.
  subs.sort((a, b) => b.start - a.start);
  for (const sub of subs) { skeleton = skeleton.slice(0, sub.start) + `{${sub.role}}` + skeleton.slice(sub.end); slots.push({ role: sub.role, value: sub.value, raw: sub.raw }); }
  slots.reverse(); // back to reading order
  const keywords = q.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
  return { skeleton: skeleton.replace(/\s+/g, " ").trim(), slots, keywords };
}

/** The first slot of a role (plans reference slots by role). */
export const slotOf = (sig: Signature, role: SlotRole): string | undefined => sig.slots.find((s) => s.role === role)?.value;
