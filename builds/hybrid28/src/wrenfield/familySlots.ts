/**
 * Paraphrase-tolerant routing + slots for filing-deadline and good-faith-estimate tasks that the
 * exact Set 1 patterns (families.ts) do not match. Routes by MEANING (what is asked: a last day to
 * file a not-yet-sent claim / when a good faith estimate is due), extracts slots by role (DOB after
 * "DOB"/"born"/"date of birth"; the other date is the visit; names as "Last, First" or "First Last";
 * ISO, US and written dates; 24-hour or AM/PM times). Hard negatives (appeals, remittances, invoice
 * balances, "was it filed", "did we send the estimate") do not route.
 */
import { dateSpans, timeIn } from "./pageSnapshot.js";
import type { FamilyMatch } from "./families.js";

const NAME_WORD = String.raw`[A-Z][\p{L}'’\-]+`;
const STOP = new Set(["good", "faith", "estimate", "gfe", "filing", "deadline", "dos", "dob", "appointment", "appt", "visit", "claim", "claims", "when", "what", "whats", "what's", "can", "could", "would", "please", "we", "i", "is", "the", "for", "patient", "pt", "original", "secondary", "corrected", "date", "service", "today", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "jan", "january", "feb", "february", "mar", "march", "apr", "april", "may", "jun", "june", "jul", "july", "aug", "august", "sep", "sept", "september", "oct", "october", "nov", "november", "dec", "december", "billing", "front", "desk", "question", "hi", "hello", "quick", "need", "how", "does", "do", "did", "has", "have", "medicare", "medicaid", "health", "plan", "insurance", "born", "am", "pm", "last", "first", "deadline", "by", "until", "file", "due"]);
const okName = (s: string) => { const w = s.toLowerCase().split(/[\s,]+/).filter(Boolean); return w.length >= 2 && w.length <= 4 && !w.some((x) => STOP.has(x.replace(/['’]s$/, ""))); };
const key = (s: string) => s.toLowerCase().replace(/[,]/g, " ").split(/\s+/).filter(Boolean).sort().join(" ");

export type LooseSlots = { name?: string; dob?: string; dates: string[]; time?: string };
/** Slots by role from free text. `dates` are the non-DOB full dates (distinct, in order). */
export function looseSlots(text: string): LooseSlots {
  const t = text.trim();
  const spans = dateSpans(t);
  let dob: string | undefined; const others: string[] = [];
  for (const d of spans) {
    const before = t.slice(Math.max(0, d.start - 22), d.start);
    if (/\b(dob|d\.o\.b\.?|born(\s+on)?|date of birth|birth\s*date|birthday|b\.)\s*[:\-]?\s*(on\s+)?$/i.test(before)) { if (dob && dob !== d.iso) dob = "__conflict__"; else dob = d.iso; }
    else if (!others.includes(d.iso)) others.push(d.iso);
  }
  // Blank out dates/times so their words (months) don't read as names.
  let bare = t; for (const d of [...spans].reverse()) bare = bare.slice(0, d.start) + " ".repeat(d.end - d.start) + bare.slice(d.end);
  const time = timeIn(bare) ?? undefined;
  bare = bare.replace(/\b\d{1,2}:\d{2}\s*([AaPp]\.?\s*[Mm]\.?)?/g, " ");
  const cands = new Map<string, string>();
  const take = (s: string | undefined) => { let v = (s ?? "").trim().replace(/\s+/g, " ").replace(/['’]s?$/, ""); while (/^\S+\s+\S+\s+\S/.test(v) && STOP.has(v.split(" ")[0].toLowerCase())) v = v.slice(v.indexOf(" ") + 1); if (v && okName(v)) cands.set(key(v), v); };
  for (const m of bare.matchAll(new RegExp(`(${NAME_WORD}(?:[ \\-]${NAME_WORD})?),\\s+(${NAME_WORD}(?:\\s${NAME_WORD})?)(?=\\s*(?:,|\\(|$|\\.|\\?|\\s(?:DOB|dob|born|b\\.|date|is|has|had|was|on|at|for|seen|came|with|need|needs)\\b|:))`, "gu"))) take(`${m[1]}, ${m[2]}`);
  for (const m of bare.matchAll(new RegExp(`(${NAME_WORD}(?:\\s${NAME_WORD}){1,2})['’]s?\\b(?!\\w)`, "gu"))) if (/['’]/.test(m[0])) take(m[1]);
  for (const m of bare.matchAll(new RegExp(`\\b(?:for|patient|pt\\.?|of|re:?|about)\\s+(?:patient\\s+)?(${NAME_WORD}(?:\\s${NAME_WORD}){1,2})`, "gu"))) take(m[1]);
  for (const m of bare.matchAll(new RegExp(`^(?:[A-Za-z ]{0,30}:\\s*)?(${NAME_WORD}(?:\\s${NAME_WORD}){1,2})(?=\\s*(?:\\(|,|\\s(?:is|has|was|had|needs|came|DOB|born)\\b))`, "gu"))) take(m[1]);
  // Any other run of 2–3 capitalised words that is not a stop word (e.g. "give Jamal Brooks a …").
  for (const m of bare.matchAll(new RegExp(`(${NAME_WORD}(?:\\s${NAME_WORD}){1,2})`, "gu"))) take(m[1]);
  // A "Last, First" candidate and a "First Last" one with the same words are the same person (same key).
  const names = [...cands.values()];
  return { name: names.length === 1 ? names[0] : undefined, dob: dob === "__conflict__" ? undefined : dob, dates: others, time };
}

const NOT_FILING = /\bappeal|remittance|\bdenied|\bdenial|next step|good[- ]faith|\bestimate|invoice|\bowed\b|balance|\bpaid\b|payment|recall|lab report|tetanus|complaint|grievance|\bforms?\b|paperwork|\breports?\b|\brecords\b|referral|incident|lawsuit/i;
const FILE = /\b(fil(e|ing|ed)|submit(ting|ted)?|send(ing)?|bill(ing)?)\b/i;
const DEADLINE = /\b(deadline|last (day|date)|latest|until when|by when|how long|still (file|submit|send|bill)|time limit|cut-?off|timely filing|filing limit|due)\b/i;
const UNFILED = /not[- ]yet[- ](filed|billed|sent|submitted)|haven'?t (yet )?(been )?(billed|filed|sent|submitted)|has(n'?t| not) (yet )?been (billed|filed|sent|submitted)|\bunfiled\b|\bnot (been )?(billed|filed|sent|submitted)( yet)?/i;

export function looseFiling(text: string): FamilyMatch | null {
  if (NOT_FILING.test(text) || !FILE.test(text) || !(DEADLINE.test(text) || (UNFILED.test(text) && /\b(when|deadline|last|until|how long|by)\b/i.test(text)))) return null;
  if (!/\b(claim|visit|service|dos|appointment|encounter)\b/i.test(text)) return null;
  const s = looseSlots(text);
  if (!s.dates.length) return null;
  const slots: Record<string, string> = {};
  if (s.name) slots.name = s.name; if (s.dob) slots.dob = s.dob; if (s.dates.length === 1) slots.dos = s.dates[0];
  return { family: "filing-deadline", slots };
}

const GFE_WORD = /good[- ]faith(?:\s+estimate)?|\bGFE\b/i;
/** The estimate the No Surprises Act requires for a visit insurance isn't paying for, by name or by meaning. */
const GFE = { test: (t: string) => GFE_WORD.test(t) || (/\bestimate of (?:the |expected )?charges\b|\bcharge estimate\b|\bcost estimate\b/i.test(t) && /\buninsured\b|\bself[- ]pay(?:ing)?\b|\bnot using (?:their )?insurance\b|\bwithout insurance\b|\bno insurance\b/i.test(t)) };
const GFE_ASK = /\b(due|deadline|by when|by what date|last day|latest|owe|required|require|need(ed|s)?|do we have to|must we|when|timing|have to reach)\b/i;
const NOT_GFE = /\b(amount|how much|total|cost of|price|did we send|was it sent|sent it|signed|dispute|copy of)\b/i;
export function looseGoodFaith(text: string): FamilyMatch | null {
  if (!GFE.test(text) || !GFE_ASK.test(text) || NOT_GFE.test(text)) return null;
  const s = looseSlots(text);
  if (!s.dates.length) return null;
  const slots: Record<string, string> = {};
  if (s.name) slots.name = s.name; if (s.dob) slots.dob = s.dob; if (s.dates.length === 1) slots.date = s.dates[0]; if (s.time) slots.time = s.time;
  return { family: "good-faith-estimate", slots };
}

// ── claim next step: what to do with a claim now that its remittance is back ──
const CLAIM_NEXT = /\bnext (step|action|move)s?\b|\bwhere does\b[^.?]{0,80}\bgo\b|\bwhat(?:'s| is| do we do| should we do| do i do| happens)? next\b|\bwhat (?:should|do) (?:we|i) do (?:now )?(?:with|about|on)\b|\bhow (?:should|do) (?:we|i) (?:work|handle|proceed with)\b|\bwork(?:ing)? (?:the|this) claim\b|\bwhat now\b|\bwhat action\b|\bnext action\b|\bwhat happens (?:with|to)\b|\bhow (?:do|should) (?:we|i) work\b|\bwhat (?:do|should) (?:we|i) do now\b|\bhow should (?:we|i) proceed\b/i;
const NOT_CLAIM = /\bfil(e|ing|ed)\b[^.?]{0,30}\b(deadline|by when|until)|\bdeadline\b|\blast day\b|\bappeal (deadline|window|by)\b|\binvoice|\bhow much\b|\bhow many\b|\bwhen (was|were|did|is|will)\b|\bstatus of\b|\bwas (it|the claim) (paid|denied|submitted|filed)\b|\bgood[- ]faith|\blab report|\btetanus|\brecall|\bnot[- ]yet[- ](filed|billed|sent)|\bhaven'?t (yet )?(billed|filed|sent)|\bunfiled\b|\bbalance\b|\bowe[sd]?\b|\bwho (is|was)\b|\bwhich payer\b|\bamount\b/i;
export function looseClaim(text: string): FamilyMatch | null {
  if (!/\bclaims?\b/i.test(text) || !CLAIM_NEXT.test(text) || NOT_CLAIM.test(text)) return null;
  const s = looseSlots(text);
  if (!s.dates.length) return null;
  const slots: Record<string, string> = {};
  if (s.name) slots.name = s.name; if (s.dob) slots.dob = s.dob; if (s.dates.length === 1) slots.dos = s.dates[0];
  return { family: "claim-next-step", slots };
}
