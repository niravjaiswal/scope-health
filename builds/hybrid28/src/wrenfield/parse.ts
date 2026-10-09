/**
 * Question understanding = (1) deterministic slot extraction [phrasing-agnostic, µs],
 * then (2) intent → query plan in tiers [keyword → memoized template → model-translate].
 *
 * Slots are explicit tokens, so extraction is robust across phrasings and clinics.
 * The model (if reached) only maps intent to a schema-constrained plan, with slots
 * already extracted — a small, validatable call, memoized per template.
 */

import { chartQuestion } from "./chartAnswers.js";
import { providerMode } from "./formFlags.js";

export interface Slots {
  patient?: string;
  dob?: string;              // YYYY-MM-DD
  provider?: { name: string; title: string };
  dates: string[];           // non-DOB dates, normalized to YYYY-MM-DD
  statuses: string[];        // completed | scheduled | cancelled | no-show | late cancel | open
  numbers: number[];
  invoice?: string;          // invoice number as printed (leading zeros matter)
  relativeTime?: boolean;    // an unresolved relative window ("last month") is present
}

const MONTHS: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
const TITLE = "MD|DO|PA|PA-C|NP|RN|NP-C|CNM|CRNA|PhD|PsyD";

function normDate(s: string): string | null {
  let m = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/); if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`; // month-first
  m = s.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/);
  if (m) { const mo = MONTHS[m[1].slice(0, 3).toLowerCase()]; if (mo) return `${m[3]}-${mo}-${m[2].padStart(2, "0")}`; }
  return null;
}

export function extractSlots(q: string): Slots {
  const slots: Slots = { dates: [], statuses: [], numbers: [] };

  // DOB first (so it's not double-counted as a date). Accept "born", "DOB", "D.O.B.", with or
  // without a colon, inline or in parentheses.
  // ("Date of birth 06/07/1995." / "birth date 1995-06-07" as a trailing sentence too: Site C put the DOB there and it was read as a visit date)
  const dob = q.match(/\b(?:born|DOB|D\.?O\.?B\.?|date of birth|birth ?date)\s*:?\s+(?:is\s+)?(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})/i)
           || q.match(/\bborn\s+([0-9A-Za-z/,\s.-]+?)\s*[)\].]/i);
  if (dob) { const d = normDate(dob[1]); if (d) slots.dob = d; }

  const nameRe = "([A-ZÀ-Þ][\\wÀ-ÿ'’.-]+(?:\\s+[A-ZÀ-Þ][\\wÀ-ÿ'’.-]+)+)";

  // Provider: "First Last, MD" / "First Last MD" (titled), else untitled "with X on {date}"
  const prov = q.match(new RegExp(`${nameRe},?\\s+(${TITLE})\\b`));
  if (prov) slots.provider = { name: prov[1].trim(), title: prov[2] };
  else { const un = q.match(new RegExp(`\\b(?:visit\\s+)?with\\s+${nameRe}\\s+on\\b`)); if (un) slots.provider = { name: un[1].trim(), title: "" }; }

  // Other dates (exclude the DOB occurrence)
  const seen = new Set(slots.dob ? [slots.dob] : []);
  for (const re of [/\b\d{4}-\d{2}-\d{2}\b/g, /\b\d{1,2}\/\d{1,2}\/\d{4}\b/g, /\b[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}\b/g]) {
    for (const m of q.matchAll(re)) { const d = normDate(m[0]); if (d && !seen.has(d)) { slots.dates.push(d); seen.add(d); } }
  }

  // Statuses (handle plurals / spacing: "no-shows", "no show", "cancellations")
  const STATUS: Array<[string, RegExp]> = [["completed", /\bcompleted\b/i], ["scheduled", /\bscheduled\b/i], ["cancelled", /\bcancell?ed\b|\bcancellations?\b/i], ["no-show", /\bno[- ]?shows?\b/i], ["late cancel", /\blate[- ]cancel(?:s|led|lations?)?\b/i], ["open", /\bopen\b/i]];
  for (const [name, re] of STATUS) if (re.test(q)) slots.statuses.push(name);

  // Unresolved relative time window ("last month", "this year", "yesterday", "recently")
  if (/\b(last|this|past|previous|next)\s+(week|month|year|quarter|few\s+(days|weeks|months))\b|\byesterday\b|\brecently\b|\bso far\b/i.test(q)) slots.relativeTime = true;

  // Numbers (not part of dates)
  for (const m of q.replace(/\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4}/g, "").matchAll(/\b\d+\b/g)) slots.numbers.push(Number(m[0]));
  const inv = q.match(/\binvoice\s*(?:#|number|no\.?)?\s*(\d{5,})/i); if (inv) slots.invoice = inv[1];

  // Patient: "patient X", "is X (a) new", "question: X, visit with", "X, visit with",
  // "does X have", "for X"
  // possessive name, e.g. "Liam Hansen's cholesterol" → "Liam Hansen". The name char class here
  // omits the apostrophe so the match stops at the possessive 's (not swallowing it + the next
  // capitalized word like "Total"). Tried first: it's an unambiguous patient reference.
  const nameNoApos2 = "([A-ZÀ-Þ][\\wÀ-ÿ.-]+(?:\\s+[A-ZÀ-Þ][\\wÀ-ÿ.-]+)+)"; // 2+ words
  // strip a leading question-word the greedy name match may have swallowed ("Is Judith Jackson"
  // → "Judith Jackson"); no real first name is one of these.
  const clean = (s: string) => s
    .replace(/^(?:Is|Was|Are|Were|For|Of|About|On|At|With|Does|Did|And|But|The|Should|Could|Would|Can|Will|Has|Have|Had|Do|Please)\s+/i, "")
    .replace(/['’]s$/i, "").replace(/['’]$/, "").replace(/[.,]$/, "").trim();

  // Highest priority: the patient almost always carries the DOB. "Last, First, DOB …" (the chart
  // display order) → reorder to "First Last"; this must run before the generic patterns so a
  // comma-separated name isn't missed.
  const lastFirst = q.match(/\b([A-ZÀ-Þ][a-zà-ÿ'’.-]+),\s+([A-ZÀ-Þ][a-zà-ÿ'’.-]+)\s*,?\s*(?:\(\s*)?(?:born|DOB|D\.?O\.?B)/);
  if (lastFirst) slots.patient = `${lastFirst[2]} ${lastFirst[1]}`.trim();

  const pats = [
    new RegExp(`${nameRe}\\s*[(,]?\\s*(?:[Bb]orn|DOB|dob)\\b`),   // "Judith Jackson (born …"
    new RegExp(`${nameNoApos2}['’]s\\b`),
    new RegExp(`\\bpatient\\s+${nameRe}`),
    new RegExp(`\\bis\\s+${nameRe}\\s+(?:a\\s+)?new\\b`, "i"),
    new RegExp(`question:\\s*${nameRe}\\s*,\\s*visit with`, "i"),
    new RegExp(`${nameRe}\\s*,\\s*visit with`),
    new RegExp(`\\bdoes\\s+${nameRe}\\s+have\\b`, "i"),
    // keyword is case-tolerant via the char classes; NO /i flag — that would defeat nameRe's
    // capitalization requirement and let lowercase words ("birth") match as names.
    new RegExp(`\\b(?:[Ff]or|[Oo]f|[Aa]bout)\\s+${nameRe}\\b`),
  ];
  if (!slots.patient) for (const re of pats) {
    const m = q.match(re); if (!m) continue;
    const cand = clean(m[1]);
    // never take the provider as the patient (e.g. "… for Kenneth Sullivan, NP" would grab the
    // provider and then get nulled, losing the real patient). Keep looking.
    if (slots.provider && cand.toLowerCase() === slots.provider.name.toLowerCase()) continue;
    slots.patient = cand; break;
  }
  // Fallback: a name with no trigger word. Prefer a name AFTER the question pivot
  // (what/who/which/…) so a distractor in the preamble ("Samantha Jones is cool, …") is
  // deprioritized. Still safe — the index validates the pick, so a bad guess → skip, never wrong.
  if (!slots.patient) {
    const cands = [...q.matchAll(new RegExp(nameRe, "g"))]
      .map((m) => ({ name: clean(m[1]), idx: m.index ?? 0 }))
      .filter((c) => !(slots.provider && c.name.toLowerCase() === slots.provider.name.toLowerCase()));
    const pivot = q.search(/\b(what|who|whose|which|when|where|how|give|tell|list|find|does|is there)\b/i);
    const after = pivot >= 0 ? cands.filter((c) => c.idx > pivot) : [];
    slots.patient = (after[0] ?? cands[0])?.name;
  }
  // Don't let the provider name leak in as the patient
  if (slots.patient && slots.provider && slots.patient.toLowerCase() === slots.provider.name.toLowerCase()) slots.patient = undefined;

  return slots;
}

// ── Tier-1 intent: keyword/phrase → {ruleType | plan-type} for the known families ──
export interface Intent { type: string; ruleType?: string; op: string; field?: string; answerType: string; entity?: string; }

const INTENTS: Array<{ test: RegExp; intent: Intent }> = [
  { test: /new\s+(?:patient\s+)?(?:or|vs\.?|versus)\s+(?:an?\s+)?established|established\s+(?:patient\s+)?(?:or|vs\.?|versus)\s+(?:an?\s+)?new|established\s+patient\s+visit|\bestablished(?:\s+patient)?\b[^.?]{0,80},?\s+or\s+(?:an?\s+)?new\b/i,
    intent: { type: "billing.new-or-established", ruleType: "billing.new-or-established", op: "rule", answerType: "text", entity: "patient" } },
  { test: /which practice (made the referral|referred)|who referred|referring (practice|provider)|referral.*from (which|what) practice|which practice.*referr|\bwho sent\b[^?]{0,30}\breferral\b|\bwhat practice (made|sent)\b[^?]{0,30}\breferral\b/i,
    intent: { type: "patient.referral-source", op: "lookup", field: "document.referral.source", answerType: "text", entity: "patient" } },
  { test: /phone number|telephone number/i, intent: { type: "patient.phone", op: "lookup", field: "demographics.phone", answerType: "phone", entity: "patient" } },
  { test: /\bemail\b/i, intent: { type: "patient.email", op: "lookup", field: "demographics.email", answerType: "text", entity: "patient" } },
  // "email address" is the email field, not the postal address
  { test: /(?<!\be-?mail )\baddress\b/i, intent: { type: "patient.address", op: "lookup", field: "demographics.address", answerType: "text", entity: "patient" } },
  // "DOB 2015-01-04" inside a question is the patient's identifier, not what is asked (Set 1: 41 tasks);
  // and a date of birth named in an aside ("…answer with the patient's date of birth") is not asked either.
  { test: /\b(?:what(?:'s| is)?|give|tell|need|look up|confirm|which)\b[^?.]{0,40}(?:date of birth|\bdob\b|\bbirth ?date\b|\bbirthday\b)(?!\s*:?\s*\d)|\bwhen was\b[^?.]{0,40}\bborn\b/i, intent: { type: "patient.dob", op: "lookup", field: "dob", answerType: "date", entity: "patient" } },
  { test: /\binvoice\b[^?]*\b(?:owed?|owing|balance|outstanding|still due)\b|\b(?:owed?|balance|outstanding)\b[^?]*\binvoice\b/i,
    intent: { type: "invoice.balance", op: "lookup", field: "invoice.balance", answerType: "text", entity: "invoice" } },
  { test: /\bspecialt(y|ies)\b/i, intent: { type: "provider.specialty", op: "lookup", field: "specialty", answerType: "text", entity: "provider" } },
  { test: /next appointment|next visit|upcoming appointment/i, intent: { type: "patient.next-appointment", op: "extreme", field: "appointment.next", answerType: "datetime", entity: "patient" } },
];

/** What a "how many …" question is counting. */
function countEntity(q: string): string | null {
  if (/no[- ]?shows?/i.test(q)) return "appointment"; // status filter carried in slots
  if (/appointment|visit\b/i.test(q)) return "appointment";
  if (/invoice|bill(ing)?\b/i.test(q)) return "invoice";
  if (/document|referral/i.test(q)) return "document";
  if (/patient/i.test(q)) return "patient";
  return null;
}

/**
 * Field-lookup intents whose question might instead ask for a *derived part* of the field
 * (first letter, domain, area code, …). Returning the whole field to such a question is a
 * wrong answer, and guessing the derived value's exact format is also a wrong answer — so when
 * a derived-part cue is present we SKIP. Add an exact solver only after a real run shows the
 * expected format.
 */
const DERIVABLE = new Set(["patient.email", "patient.phone", "patient.address", "patient.dob"]);
const DERIVED_PART =
  /\b(first|last|second|third|fourth|fifth|final|initial|next[- ]to[- ]last)\b[^.?!]{0,25}\b(letter|char(?:acter)?s?|digits?|words?|parts?|segments?|initials?|names?)\b|\bhow many\b[^.?!]{0,25}\b(letters?|char(?:acter)?s?|digits?|words?)\b|\bdomain\b|\bafter the @|\bbefore the @|@\s*sign|\barea\s*code\b|\bzip\s?code\b|\bpostal\s*code\b|\busername\b|\blast\s+\w+\s+digits\b|\bextension\b|\bwhat\s+year\b|\bhow\s+old\b/i;

/** The skip sentinel: a non-null plan whose type no solver handles → exec returns null → skip.
 *  Returning it (instead of null) prevents the model tier from re-dumping the full field. */
const SKIP_DERIVED: Intent = { type: "skip.derived", op: "lookup", answerType: "text", entity: "patient" };

/** A question about a value printed INSIDE a document (lab report, etc.): a lab analyte, a report
 *  number, or an explicit "on the … report/panel" value. Routed to the document-vision solver. */
const DOC_CONTENT =
  /\breport number\b|\blab report\b|\blab result\b|\blab value\b|\bon the (?:lab )?(?:report|panel)\b|\b(?:total |hdl |ldl )?cholesterol\b|\btriglycerides?\b|\b(?:HDL|LDL)\b|\bglucose\b|\bA1C\b|\bhemoglobin\b|\bhematocrit\b|\bTSH\b|\bvitamin\s*d\b|\bcreatinine\b|\bpotassium\b|\bsodium\b|\bcalcium\b|\bplatelets?\b|\b(?:white|red) blood cell\b|\bWBC\b|\bRBC\b|\bbilirubin\b|\balbumin\b|\bBUN\b|\beGFR\b|\breferral\b[^?]{0,60}\b(?:reason|diagnosis|indication|finding|complaint|symptom|notes?)\b|\bwhy\b[^?]{0,60}\breferred\b|\b(?:reason|diagnosis|indication|complaint)\b[^?]{0,40}\breferral\b|\b(?:what|which)\b[^?]{0,60}\b(?:document|letter|report|statement)\b[^?]{0,20}\b(?:say|states?|gives?|shows?|notes?|reads?)\b/i;

/** A field question about the patient's own field can be a near miss: someone else's phone (the
 *  provider's, the emergency contact's), a yes/no or what-kind-of question, a referral's destination
 *  instead of its source, an invoice's payments or total instead of what is still owed. Answering
 *  those with the patient's field / the balance is a wrong answer, so they skip. */
const NEAR_MISS: Record<string, RegExp> = {
  "patient.phone": /\b(provider|doctor|dr\.?|physician|pcp|primary care|emergency|next of kin|contact person|pharmacy|employer|insurer|insurance|payer|practice|referr\w*|guarantor|spouse|parent|guardian|mother|father|caregiver|fax)\b|^\s*(?:(?:is|are|does|has|was|were|when|why|who|how)\b|(?:do|can)\b(?!\s+you\b))|\b(updated|changed|verified|added|confirmed|previous|old|former)\b/i,
  "patient.referral-source": /\breferred to\b|\breferr(al|ing) to\b|\bbeing referred\b|\bwho (?:is|was) (?:the patient |\w+ )?referred to\b/i,
  "invoice.balance": /^\s*(?:(?:is|are|has|have|was|were|did|does)\b|do\b(?!\s+you\b))|\bpaid so far\b|\bbeen paid\b|\bamount paid\b|\bhow much (?:was|has been|have we) (?:paid|received|collected)\b|\btotal billed\b|\b(?:amount|originally) billed\b|\bissued\b|\bdue date\b|\bacross all\b|\ball (?:of )?(?:\w+'s )?invoices\b/i,
};
/** The plan when a question carries two different field intents (e.g. an invoice balance plus an
 *  aside naming the date of birth): we cannot tell which is asked → skip. */
const SKIP_AMBIGUOUS: Intent = { type: "skip.ambiguous", op: "lookup", answerType: "text", entity: "patient" };
const SKIP_NEAR_MISS: Intent = { type: "skip.near-miss", op: "lookup", answerType: "text", entity: "patient" };

export function classifyIntent(q: string): Intent | null {
  // AGENT_FORM_PROVIDER on: "first and last name" is a stated name form (chartAnswers), not a derived part of a field
  const derived = DERIVED_PART.test(providerMode() === "off" ? q : q.replace(/\bfirst(?: name)? and last name\b|\bfirst-and-last name\b/gi, "full name"));
  const hits = INTENTS.filter(({ test }) => test.test(q)).map((x) => x.intent.type);
  if (new Set(hits).size > 1) return SKIP_AMBIGUOUS;
  for (const { test, intent } of INTENTS) {
    if (!test.test(q)) continue;
    // tested on the question itself (up to its "?"), not on a definition that follows it ("Still owed
    // means the amount billed minus the payments received")
    if (NEAR_MISS[intent.type]?.test(q.split("?")[0])) return SKIP_NEAR_MISS;
    // A known field lookup phrased as "first letter of / domain of / area code of …" → skip,
    // never return the whole field or a format-guessed fragment. Non-field intents (referral,
    // new/established, specialty, next-appointment) are answered normally — their own regexes
    // don't collide with the derived cues.
    if (DERIVABLE.has(intent.type) && derived) return SKIP_DERIVED;
    return intent;
  }
  // Generic chart questions no intent above takes (chartAnswers.ts: MRN, sex, primary provider, home
  // location, last/first appointment by status, counts in a stated window, latest document of a type).
  if (!derived) { const cq = chartQuestion(q); if (cq) return { type: `chart.${cq.kind}`, op: "lookup", answerType: "text", entity: "patient" }; }
  if (/\bhow many\b|\bnumber of\b|\bcount of\b/i.test(q)) {
    const entity = countEntity(q);
    if (!entity) return null; // unknown count target → model tier (don't guess)
    return { type: `aggregate.count.${entity}`, op: "count", entity, answerType: "whole" };
  }
  // A value INSIDE a document (lab result, report number, ordering provider, …). These live in
  // a rendered PDF, so the solver screenshots the doc and reads it with a vision model.
  if (DOC_CONTENT.test(q)) return { type: "document.content", op: "document", answerType: "text", entity: "document" };
  // A derived-of-a-field question that matched no intent (e.g. "what year was X born", "how
  // old is X") → skip, rather than let the model tier guess and dump a full/misformatted value.
  if (derived) return SKIP_DERIVED;
  return null; // → memoized template → model-translate (schema-constrained)
}

/** Full deterministic parse of a question (the hot-path understanding step). */
export function parse(q: string): { slots: Slots; intent: Intent | null } {
  return { slots: extractSlots(q), intent: classifyIntent(q) };
}

// ── Self-test against the 4 real example questions from gettingStarted.md ──
if (process.argv[1]?.endsWith("parse.ts")) {
  const cases = [
    "Is Jack Williams a new patient or established for the visit with Logan Brown, MD on 2026-10-29?",
    "Billing question: Guadalupe Driscoll, visit with Sharon Morales, MD on 2025-11-05. Is that a new or an established patient visit?",
    "Referral letter received on 2025-11-10 for patient Randy Singh (born 1939-12-04): which practice made the referral?",
    "What phone number do we have on file for patient Julie Martínez (born 2010-01-10)?",
  ];
  for (const q of cases) {
    const { slots, intent } = parse(q);
    console.log(`\nQ: ${q}`);
    console.log(`  intent: ${intent?.type ?? "(novel → model)"}  op=${intent?.op} field=${intent?.field ?? ""}`);
    console.log(`  patient=${slots.patient ?? "-"} dob=${slots.dob ?? "-"} provider=${slots.provider ? slots.provider.name + " " + slots.provider.title : "-"} dates=[${slots.dates}]`);
  }
}
