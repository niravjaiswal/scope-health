/**
 * Memo classification and the memo gate (MEMO-GATE.md).
 *
 * 1. classifyMemo(raw, earlier): what a message IS, from its structure (no model, no site-specific words):
 *    - workflow:   a "How to answer" heading, an answer-token grammar (backticked `TOKEN` / `FORM:value` / `<placeholder>`),
 *                  or an "If someone asks … The answer is …" example; or a "From <role>: <title>" memo that says "Answer with …".
 *    - revocation: "stop answering / don't answer / no longer answer / skip every …" about an earlier memo.
 *    - amendment:  "change / from now on / starting <date> / instead / no longer / now …" about an earlier memo (merged into that memo;
 *                  an effective date "From YYYY-MM-DD" / "on or after YYYY-MM-DD" is kept with it).
 *    - null:       anything else (notes, heads-ups, facts): the caller's model classifier decides, as before.
 *    "About an earlier memo" = two of the earlier memo's title words, or one title word and one of its answer tokens.
 *    A message that carries its own full answer spec ("How to answer" or a worked example) is a workflow even when it shares
 *    words with an earlier memo (a second workflow on a related topic is not an amendment).
 *
 * 2. matchMemo(task, memos): the memo a task belongs to, keyed on each memo's title nouns, its answer tokens, its worked-example
 *    requests and its quoted phrases (and those of its amendments), never on one generic word: a match needs a score >= 1.5
 *    (a word counts 1 / the number of memos that share it) with at least one title or answer-token word among the hits, and a
 *    strict lead over the next memo (a tie returns every tied memo: the task is still governed, by an ambiguous memo).
 */

import { IDF_N, IDF_DF } from "./memoIdf.js";

export type MemoKind = "workflow" | "amendment" | "revocation";
export type MemoInfo = { title: string; tokens: string[]; vocab: Map<string, VocabSrc>; counts: boolean };
type VocabSrc = "title" | "token" | "example" | "quoted" | "body";
export type MemoClass = { kind: MemoKind; target?: number; effective?: string; why: string };

// ── words ──
const STOP = new Set(("the a an of to for and or in on at by with what when how is are be it its this that from we our your you they them their " +
  "do does did which who whom has have had any each every one two not but if so as was were been will would could should can may might " +
  "there here's than then also only just very all some most more less into onto over under after before about per via yet off out up").split(" "));
/** Words that every back-office request carries: never a memo's key on their own. */
const GENERIC = new Set(("patient patients visit visits date dates day days year years number numbers many much count counts total totals " +
  "check checks please give tell need needs want wants ask asks asked someone question questions answer answers request requests " +
  "today time name names chart charts record records clinic office team list page site use used using note notes " +
  "born birth dob mrn yes none new rule rules example examples whole look find get got see seen").split(" "));

/** A light stem: possessive and plural off, -ing / -ed / -e off, -y → -i, first 6 letters. */
export function stem(w: string): string {
  let s = w.toLowerCase().replace(/['’]s$/, "");
  if (s.endsWith("ies") && s.length > 4) s = s.slice(0, -3) + "y";
  else if (s.endsWith("sses")) s = s.slice(0, -2);
  else if (s.endsWith("s") && !/(ss|us|is)$/.test(s) && s.length > 3) s = s.slice(0, -1);
  if (s.endsWith("ing") && s.length > 5) s = s.slice(0, -3);
  else if (s.endsWith("ed") && s.length > 4) s = s.slice(0, -2);
  else if (/(?:ure|ment)$/.test(s) && s.length > 6) s = s.replace(/(?:ure|ment)$/, "");
  else if (/ial$/.test(s) && s.length >= 6) s = s.slice(0, -2);
  if (s.endsWith("e") && s.length > 3) s = s.slice(0, -1);
  if (s.endsWith("y") && s.length > 3) s = s.slice(0, -1) + "i";
  return s.slice(0, 6);
}
/** Words of 3+ letters; short all-caps acronyms (DOS, MRN, DOB, PCP) are not words of a memo's vocabulary. */
const rawWords = (t: string) => t.split(/[^A-Za-z'’]+/).map((w) => w.replace(/^['’]+|['’]+$/g, "")).filter((w) => w.length >= 3 && !/^[A-Z]{2,4}$/.test(w));
/** Content stems of a text (stop and generic words out). */
export const contentStems = (t: string): string[] => [...new Set(rawWords(t).map((w) => w.toLowerCase().replace(/['’]s$/, "")).filter((w) => !STOP.has(w) && !GENERIC.has(w)).map(stem).filter((s) => s.length >= 3 && !GENERIC.has(s)))];
/** Drop people's names (Title-case runs of two or more words, "Last, First") from a quoted request before taking its words. */
const dropNames = (t: string) => t.replace(/\b[A-Z][a-z'’-]+(?:,? [A-Z][a-z'’-]+)+/g, " ").replace(/\((?:DOB|born|MRN)[^)]*\)/gi, " ");

// ── memo structure ──
const HEADER = /^From [^:\n]{2,80}:\s*(.+)$/;
export const memoTitle = (raw: string): string => { const first = raw.split("\n")[0].trim(); return (first.match(HEADER)?.[1] ?? first).trim().slice(0, 140); };
export const hasHeader = (raw: string) => HEADER.test(raw.split("\n")[0].trim());
/** Answer tokens: backticked TOKEN / TOKEN:value / TOKEN:<placeholder> (heads only, colon kept when a value follows). */
export function answerTokens(raw: string): string[] {
  const out = new Set<string>();
  for (const m of raw.matchAll(/`([A-Z][A-Z0-9_]{1,}(?::[^`\n]*)?)`/g)) { const h = m[1].replace(/:.*$/, (x) => (x.length > 1 ? ":" : ":")); if (/^(YYYY|MM|DD|HH)/.test(h)) continue; out.add(h); }
  return [...out];
}
const HOW_TO = /^#{1,4}\s*How to answer\b|^How to answer\s*$/im;
const EXAMPLE = /\bIf (?:someone|a caller|anyone|they|the front desk|staff) asks?\b[\s\S]{0,400}?\bThe answer is\b/i;
const ANSWER_WITH = /\b(?:Answer with|Answer in|The answer is (?:one of|a|the)|Example answers?:|Reply with)\b/i;
/** A message that carries its own complete answer spec. */
export const fullSpec = (raw: string) => HOW_TO.test(raw) || EXAMPLE.test(raw);
/** A workflow memo by its structure. */
export function isWorkflowMemo(raw: string): boolean {
  if (raw.length < 150) return false;
  if (fullSpec(raw)) return true;
  if (answerTokens(raw).length && (hasHeader(raw) || raw.length >= 300)) return true;
  return hasHeader(raw) && ANSWER_WITH.test(raw);
}
const REVOKE = /\b(?:stop answering|no longer answer|(?:don['’]t|do not) answer (?:them|these|those|any|this|it)|skip (?:every|all|these|those|them|any|each) (?:question|task|request)s?|skip them\b|stop (?:handling|working) (?:these|those|them))/i;
const CHANGE = /\b(?:change[sd]?|changing|from now on|starting|effective|instead|no longer|going forward|update[sd]?|amend(?:ed|ment)?|correction|replac(?:e|es|ed|ing)|now (?:count|counts|have|has|require|requires|is|are|means|use|uses|apply|applies)|new (?:rule|target|bucket|buckets|limit|threshold|cutoff|window|period)|tighter|from \d{4}-\d{2}-\d{2}|on or after \d{4}-\d{2}-\d{2})\b/i;

export function memoInfo(raw: string): MemoInfo {
  const title = memoTitle(raw); const tokens = answerTokens(raw);
  const vocab = new Map<string, VocabSrc>();
  const add = (stems: string[], src: VocabSrc) => { for (const s of stems) if (!vocab.has(s) || (src === "title" && vocab.get(s) !== "title")) vocab.set(s, src); };
  add(taskStems(title), "title");
  add(taskStems(tokens.map((t) => t.replace(/:.*$/, "").toLowerCase().replace(/_/g, " ")).join(" ")), "token");
  // the worked examples' requests and every quoted question / phrase: real phrasings of the task (names dropped by taskStems)
  // (capitalised words inside a request are its entities, a payer, a team, a product: not the topic)
  const quoted = [...raw.matchAll(/["“]([^"”\n]{6,240})["”]/g)].map((m) => m[1].replace(/(?<=[a-z0-9,;)'’]\s+)[A-Z][A-Za-z'’-]*/g, " "));
  // and the questions the body itself asks ("how many days was a location closed in a calendar year?")
  const asked = (raw.split("\n").slice(1).join(" ").match(/[^.?!:\n]{10,200}\?/g) ?? []).filter((q) => !/["“”]/.test(q));
  add(taskStems([...quoted, ...asked].join(" ")), "example");
  // words the memo's body repeats (3+ times): weak evidence, never a key
  const freq = new Map<string, number>();
  for (const w of rawWords(raw.split("\n").slice(1).join(" "))) { const lw = w.toLowerCase(); if (STOP.has(lw)) continue; const st = stem(lw); if (st.length >= 3) freq.set(st, (freq.get(st) ?? 0) + 1); }
  add([...freq].filter(([, n]) => n >= 3).map(([st]) => st).filter((st) => !vocab.has(st)), "body");
  return { title, tokens, vocab, counts: memoCounts(raw) };
}
/** The memo's answers are counts ("A whole number", "how many …" in its title or its examples' requests). */
export const memoCounts = (raw: string): boolean => /\bwhole number\b/i.test(raw) || /\b(?:how many|number of|count of|counts?)\b/i.test(memoTitle(raw)) ||
  [...raw.matchAll(/["“]([^"”\n]{6,240})["”]/g)].some((m) => isCountQ(m[1]));
/** A count question ("how many …", "number of …", "count …"; not "Complete blood count"). */
export const isCountQ = (t: string) => /\bhow many\b|\bnumber of\b|^\s*(?:count|tally)\b|\b(?:count|tally)(?: of| up| the| all| how)\b|\bwhat(?:'s| is) the (?:total )?count\b|\b(?!blood\b)[a-z-]{3,} count\b(?! of)/i.test(t);
/** Merge an amendment's title and tokens into its memo's vocabulary (a "new blood pressure target" adds "target"). */
export function mergeAmendment(info: MemoInfo, raw: string): void {
  for (const s of taskStems(memoTitle(raw))) if (!info.vocab.has(s)) info.vocab.set(s, "title");
  for (const t of answerTokens(raw)) { if (!info.tokens.includes(t)) info.tokens.push(t); for (const s of taskStems(t.replace(/:.*$/, "").toLowerCase().replace(/_/g, " "))) if (!info.vocab.has(s)) info.vocab.set(s, "token"); }
}
const effectiveOf = (raw: string): string | undefined => raw.match(/\b(?:From|Starting|Effective|on or after|as of)\s+(\d{4}-\d{2}-\d{2})\b/i)?.[1];

/** Which earlier memo a short message is about: two of its title words, or one title word and one of its answer-token heads.
 *  The latest such memo wins a tie on overlap. -1 when none. */
export function aboutMemo(raw: string, earlier: Array<{ raw: string }>): number {
  const words = new Set(contentStems(raw)); const titleWords = new Set(contentStems(memoTitle(raw)));
  let best = -1, bestN = 0;
  earlier.forEach((m, i) => {
    const tw = contentStems(memoTitle(m.raw));
    const inTitle = tw.filter((s) => titleWords.has(s)).length, inBody = tw.filter((s) => words.has(s)).length;
    const heads = answerTokens(m.raw).map((t) => t.replace(/:$/, "")).filter((h) => h.length >= 4 && raw.includes(h)).length;
    const n = Math.max(inTitle, inBody) + heads;
    const wholeTitle = tw.length >= 1 && inTitle === tw.length; // every content word of the memo's title is in this message's title
    if ((inBody >= 2 || (inBody >= 1 && heads >= 1) || heads >= 2 || wholeTitle) && n >= bestN) { best = i; bestN = n; }
  });
  return best;
}

/** What a message is, by structure; null → not decided here (notes, facts: the model classifier decides). */
export function classifyMemo(raw: string, earlier: Array<{ raw: string }>): MemoClass | null {
  if (raw.length < 80) return null;
  if (fullSpec(raw)) return { kind: "workflow", why: HOW_TO.test(raw) ? "how-to-answer" : "worked example" };
  // a long message with its own answer tokens is a workflow whatever its headings say (amendments and revocations are short notes)
  if (raw.length >= 800 && answerTokens(raw).length) return { kind: "workflow", why: "answer tokens (long)" };
  const about = earlier.length && hasHeader(raw) ? aboutMemo(raw, earlier) : -1;
  if (about >= 0 && REVOKE.test(raw)) return { kind: "revocation", target: about, why: "revocation: " + (raw.match(REVOKE)?.[0] ?? "") };
  if (about >= 0 && CHANGE.test(raw)) return { kind: "amendment", target: about, effective: effectiveOf(raw), why: "amendment: " + (raw.match(CHANGE)?.[0] ?? "") };
  if (isWorkflowMemo(raw)) return { kind: "workflow", why: answerTokens(raw).length ? "answer tokens" : "answer form" };
  return null;
}

// ── matching a task to a memo ──
export type MemoRef = { key: number; info: MemoInfo };
export type MemoMatch = { keys: number[]; score: number; second: number; hits: string[] };
/** A request's word stems: names, dates and numbers out, function words out (generic words stay: the weights handle them). */
export const taskStems = (t: string): string[] => [...new Set(rawWords(dropNames(t)).map((w) => w.toLowerCase()).filter((w) => !STOP.has(w) && !REQUEST_WORDS.has(w)).map(stem).filter((x) => x.length >= 3))];
/** Words of the request itself, not of its topic ("check", "please", "give me"): never part of a memo's vocabulary. */
const REQUEST_WORDS = new Set("check checks checking please give need needs want wants know help find look sure right thanks kindly quick quickly".split(" "));
/** How rare a stem is in back-office requests (memoIdf.ts: 379 requests of Set 1, the Set 2 hypotheses and the practice queue):
 *  1 for a word no request carries, ~0.1 for one in half of them. */
export const rarity = (s: string): number => Math.log((IDF_N + 1) / ((IDF_DF[s] ?? 0) + 1)) / Math.log(IDF_N + 1);
const SRC_W: Record<VocabSrc, number> = { title: 1, token: 1, example: 0.75, quoted: 0.75, body: 0.5 };
/** A memo's own key: a title, answer-token or example-request word that is not common in requests. */
const KEY_RARITY = 0.3;
export const MATCH_MIN = Number(process.env.AGENT_MEMO_MATCH_MIN ?? 0.9);
export const TOUCH_MIN = Number(process.env.AGENT_MEMO_TOUCH_MIN ?? 0.45);
const NEAR_TIE = 0.15;
export type MemoScore = { key: number; score: number; keyed: boolean; titled: boolean; hits: string[] };
/** Every memo's score for a task: the sum, over the memo's vocabulary words the task carries, of (rarity in requests × source weight
 *  / number of memos with that word). `keyed`: one of the hits is a title / token word of rarity >= KEY_RARITY. A count question
 *  scores only memos whose answers are counts. */
export function scoreMemos(task: string, memos: MemoRef[]): MemoScore[] {
  const count = isCountQ(task); const pool = memos.filter((m) => !count || m.info.counts);
  const tw = new Set(taskStems(task));
  const df = new Map<string, number>();
  for (const m of pool) for (const s of m.info.vocab.keys()) df.set(s, (df.get(s) ?? 0) + 1);
  return pool.map((m) => {
    const hits = [...m.info.vocab.entries()].filter(([st]) => tw.has(st));
    const score = hits.reduce((a, [st, src]) => a + (rarity(st) * SRC_W[src]) / (df.get(st) ?? 1), 0);
    const keyed = hits.some(([st, src]) => (src === "title" || src === "token") && rarity(st) >= KEY_RARITY);
    const titled = hits.some(([st, src]) => src === "title" && rarity(st) >= KEY_RARITY);
    return { key: m.key, score: Math.round(score * 100) / 100, keyed, titled, hits: hits.map(([st]) => st) };
  }).sort((a, b) => b.score - a.score);
}
/** The memo(s) a task belongs to at `min` (MATCH_MIN: governed; TOUCH_MIN: touched), or null. A near tie returns every tied memo
 *  (an ambiguous task is still governed). */
export function matchMemo(task: string, memos: MemoRef[], min = MATCH_MIN): MemoMatch | null {
  // a match is keyed by a title or answer-token word; a mere touch (below MATCH_MIN) needs a word of the memo's title (a token list
  // can name fields of other topics: the claims memo's REFERRING_PROVIDER_ID is no key to referral-letter questions)
  // (a match keyed by answer tokens alone needs twice the score: the claims memo's REFERRING_PROVIDER_ID + "reason" is 0.9, an
  // aging question's "past due … bucket … invoice" 2.5)
  const sc = scoreMemos(task, memos).filter((x) => (x.titled || (min >= MATCH_MIN && x.keyed && x.score >= 2 * MATCH_MIN)) && x.score >= min);
  if (!sc.length) return null;
  const best = sc[0]; const tied = sc.filter((x) => x.score >= best.score - NEAR_TIE);
  const second = sc.find((x) => x.score < best.score - NEAR_TIE)?.score ?? 0;
  return { keys: tied.map((x) => x.key), score: best.score, second, hits: best.hits };
}

/** Optional async memo router (s3: wfShadow.wfForAsync / the router decision): returns the raw text of the memo a task belongs to,
 *  or null. Consulted only when the lexical match found nothing. */
export type MemoRouter = (task: string) => Promise<string | null>;
let router: MemoRouter | undefined;
export const setMemoRouter = (r?: MemoRouter): void => { router = r; };
export const memoRouter = (): MemoRouter | undefined => router;
