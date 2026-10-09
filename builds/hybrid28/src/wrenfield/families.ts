import { parseAggQuery, AGGREGATE_FAMILIES } from "./aggregate.js";
import { parseListQuery, listMode } from "./listQuery.js";
/**
 * Task-family classifier: which workflow a task belongs to, BEFORE any keyword intent runs.
 * Generated from vision-baseline/fixtures/set1/task-families.json (Set 1: 224/224 tasks classified)
 * plus the practice new-vs-established workflow. Ordered; first match wins.
 * Regenerate rather than hand-edit the pattern list.
 */
import { extractLabSlots } from "./labSlots.js";
import { tetanusSlots, recallSlots } from "./immunizations.js";
import { looseFiling, looseGoodFaith, looseClaim } from "./familySlots.js";
import { extractSlots } from "./parse.js";
import { normDob } from "./pageScripts.js";

export const FAMILY_PATTERNS: Array<[string, RegExp[]]> = [
 [
  "lab-report-triage",
  [
   "^Does the (?<panel>.+?) lab report for (?<name>.+?) \\((?:DOB|born) (?<dob>\\d{4}-\\d{2}-\\d{2})\\), received on (?<received>\\d{4}-\\d{2}-\\d{2}), need a call to the provider, a nurse review, or release to the patient\\?$",
   "^Please decide what to do with the (?<panel>.+?) lab report received on (?<received>\\d{4}-\\d{2}-\\d{2}) for (?<name>.+?)\\.$",
   "^What happens to the (?<panel>.+?) lab report for (?<name>.+?) \\((?:DOB|born) (?<dob>\\d{4}-\\d{2}-\\d{2})\\), received (?<received>\\d{4}-\\d{2}-\\d{2})\\?$",
   "^Next step for a lab report: (?<name>.+?), (?<panel>[A-Z][a-z].+? panel|Complete blood count), received (?<received>\\d{4}-\\d{2}-\\d{2})\\.$",
   "\\blab report\\b"
  ]
 ],
 [
  "tetanus-wound",
  [
   "^What should (?<name>.+?) have gotten for tetanus when they came in with a wound on (?<visit>\\d{4}-\\d{2}-\\d{2})\\?$",
   "^Doing chart review on wound visits\\. (?<name>.+?), DOB (?<dob>\\d{4}-\\d{2}-\\d{2}), came in on (?<visit>\\d{4}-\\d{2}-\\d{2})\\. What was due for tetanus\\?$",
   "^I want to make sure we got the tetanus part right for (?<name>.+?) \\(born (?<dob>\\d{4}-\\d{2}-\\d{2})\\), seen (?<visit>\\d{4}-\\d{2}-\\d{2})\\.$",
   "^Tetanus for (?<name>.+?) on (?<visit>\\d{4}-\\d{2}-\\d{2}): vaccine, vaccine and TIG, or nothing\\?$",
   "\\btetanus\\b"
  ]
 ],
 [
  "vaccine-lot-recall",
  [
   "^How many patients are left to notify about the recall of lot (?<lot>[A-Z0-9]+)\\?$",
   "^Recall, lot (?<lot>[A-Z0-9]+): patients left to notify\\?$",
   "^Could you count how many of our patients still haven't been told about the recall of vaccine lot (?<lot>[A-Z0-9]+)\\?$",
   "^We've had a recall notice for vaccine lot (?<lot>[A-Z0-9]+)\\. How many patients still need to be told\\?$",
   "\\brecall\\b.*\\blot\\b"
  ]
 ],
 [
  "claim-next-step",
  [
   "^Next step on claim: (?<name>.+?), DOB (?<dob>\\d{4}-\\d{2}-\\d{2}), service date (?<dos>\\d{4}-\\d{2}-\\d{2})$",
   "^I'm going through the claim for (?<name>.+?) with the date of service (?<dos>\\d{4}-\\d{2}-\\d{2})\\. Where does it go from here\\?$",
   "^Could you look at the claim for (?<name>.+?), born (?<dob>\\d{4}-\\d{2}-\\d{2}), with the date of service (?<dos>\\d{4}-\\d{2}-\\d{2}), and tell me the next step\\?$",
   "^What's next for the claim for (?<name>.+?), date of service (?<dos>\\d{4}-\\d{2}-\\d{2})\\?$"
  ]
 ],
 [
  "filing-deadline",
  [
   "^(?<name>.+?), DOB (?<dob>\\d{4}-\\d{2}-\\d{2}), date of service (?<dos>\\d{4}-\\d{2}-\\d{2})\\. We haven't billed this one yet\\. What's the deadline to file\\?$",
   "^Can we still file for (?<name>.+?)'s visit on (?<dos>\\d{4}-\\d{2}-\\d{2})\\? If so, until when\\?$",
   "^Filing deadline for (?<name>.+?), DOS (?<dos>\\d{4}-\\d{2}-\\d{2})\\?$",
   "^(?<name>.+?), born (?<dob>\\d{4}-\\d{2}-\\d{2}), has a visit from (?<dos>\\d{4}-\\d{2}-\\d{2}) on the not-yet-filed list\\. Could you work out the filing deadline before I send it\\?$"
  ]
 ],
 [
  "good-faith-estimate",
  [
   "^(?<name>.+?) is on the books for (?<date>\\d{4}-\\d{2}-\\d{2}) at (?<time>\\d{2}:\\d{2})\\. Do we owe them a good faith estimate, and by when\\?$",
   "^Good faith estimate question: (?<name>.+?), born (?<dob>\\d{4}-\\d{2}-\\d{2}), (?<time>\\d{2}:\\d{2}) on (?<date>\\d{4}-\\d{2}-\\d{2})\\. Is one required, and if so, when's it due\\?$",
   "^When is the good faith estimate due for (?<name>.+?) \\(DOB (?<dob>\\d{4}-\\d{2}-\\d{2})\\)\\? Appointment (?<date>\\d{4}-\\d{2}-\\d{2}) (?<time>\\d{2}:\\d{2})\\.$",
   "^I'm putting together the paperwork for (?<name>.+?)'s (?<time>\\d{2}:\\d{2}) appointment on (?<date>\\d{4}-\\d{2}-\\d{2})\\. What's the last day to get the good faith estimate to them\\?$"
  ]
 ],
 [
  "new-vs-established",
  [
   "^Is (?<name>.+?) \\(born (?<dob>\\d{4}-\\d{2}-\\d{2})\\) new or established for (?<provider>.+?) on (?<date>\\d{4}-\\d{2}-\\d{2})\\?$",
   "^On (?<date>\\d{4}-\\d{2}-\\d{2}) there is a visit with (?<provider>.+?) for (?<name>.+?), DOB (?<dob>\\d{4}-\\d{2}-\\d{2}), and I need new vs\\. established for it\\.$"
  ]
 ],
 [
  "invoice-balance",
  [
   "^What's still owed on invoice (?<invoice>\\d+) \\(patient (?<name>.+?), service date (?<dos>\\d{4}-\\d{2}-\\d{2})\\), in dollars\\? Still owed means the amount billed minus the payments received, and a voided invoice owes nothing\\.$",
   "^As of now, how much is still owed on invoice (?<invoice>\\d+) \\(patient (?<name>.+?), service date (?<dos>\\d{4}-\\d{2}-\\d{2})\\)\\? Give the amount in dollars\\. Still owed means the amount billed minus the payments received, and a voided invoice owes nothing\\.$"
  ]
 ],
 [
  "patient-phone",
  [
   "^What phone number do we have on file for patient (?<name>.+?) \\(born (?<dob>\\d{4}-\\d{2}-\\d{2})\\)\\?$"
  ]
 ],
 [
  "referral-source",
  [
   "^Referral letter received on (?<received>\\d{4}-\\d{2}-\\d{2}) for patient (?<name>.+?) \\(born (?<dob>\\d{4}-\\d{2}-\\d{2})\\): which practice made the referral\\?$"
  ]
 ],
 [
  "referral-reason",
  [
   "^Referral letter received on (?<received>\\d{4}-\\d{2}-\\d{2}) for patient (?<name>.+?) \\(born (?<dob>\\d{4}-\\d{2}-\\d{2})\\): what reason does it give for the referral\\?$"
  ]
 ],
 [
  "provider-open-slots",
  [
   "^How many open slots are there for (?<provider>.+?) at (?<location>.+?) on (?<date>\\d{4}-\\d{2}-\\d{2})\\? By open slot I mean a bookable time in the provider's working hours at that location that doesn't overlap any time off or any scheduled or completed appointment\\.$"
  ]
 ],
 [
  "provider-day-scheduled-count",
  [
   "^As of now, how many scheduled appointments does (?<provider>.+?) have on (?<date>\\d{4}-\\d{2}-\\d{2}) across all locations\\? Leave out appointments of patients whose record is a test record or has been deleted\\.$",
   "^How many scheduled appointments does (?<provider>.+?) have on (?<date>\\d{4}-\\d{2}-\\d{2}), at any location\\? Leave out appointments of patients whose record is a test record or has been deleted\\.$"
  ]
 ],
 [
  "provider-day-completed-count",
  [
   "^How many completed visits did (?<provider>.+?) have on (?<date>\\d{4}-\\d{2}-\\d{2})\\? Count visits at any location\\. Leave out appointments of patients whose record is a test record or has been deleted\\.$"
  ]
 ],
 [
  "location-completed-before-time",
  [
   "^How many completed visits at (?<location>.+?) on (?<date>\\d{4}-\\d{2}-\\d{2}) started before (?<time>\\d{2}:\\d{2}) local time\\? Leave out appointments of patients whose record is a test record or has been deleted\\.$"
  ]
 ],
 [
  "location-month-distinct-patients",
  [
   "^How many patients had at least one (?<status>completed) visit at (?<location>.+?) in (?<month>[A-Z][a-z]+ \\d{4})\\? Count each person once even if they are registered more than once, and leave out test records and deleted records\\.$",
   "^How many patients have at least one (?<status>scheduled) appointment at (?<location>.+?) in (?<month>[A-Z][a-z]+ \\d{4})\\? Count each person once even if they are registered more than once, and leave out test records and deleted records\\.$"
  ]
 ],
 [
  "top-providers-completed-month",
  [
   "^Which (?<k>\\w+) providers had the most completed visits across all locations in (?<month>[A-Z][a-z]+ \\d{4})\\? List them with the most first, by first and last name\\. Only providers who are active today count\\. Leave out appointments of patients whose record is a test record or has been deleted\\. If any are tied, put them in alphabetical order by last name, then first name\\.$"
  ]
 ],
 [
  "new-vs-established",
  [
   "\\bnew\\b[\\s\\S]{0,60}\\bestablished\\b|\\bestablished\\b[\\s\\S]{0,60}\\bnew\\b"
  ]
 ]
].map(([f, ps]) => [f as string, (ps as string[]).map((p) => new RegExp(p, "i"))]);

export type FamilyMatch = { family: string; slots: Record<string, string>; text?: string };
/** A catalog pattern's `(?<name>.+?)` swallows a DOB written next to the name ("Abigail García (DOB 1952-04-03)",
 *  "García, Abigail, born 04/03/1952"): the name was searched with the date in it and the DOB lost (found by the
 *  Set 1 replica run: tetanus + good-faith tasks declined). Split it off: the name without the clause, the date as
 *  the DOB. A different DOB already captured → no DOB at all (two DOBs: the resolver must not pick either; the
 *  name-only path then has to prove the patient alone). An unparsable date leaves the slots untouched. */
export function nameDobSplit(slots: Record<string, string>): Record<string, string> {
  const n = slots.name; if (!n) return slots;
  const m = n.match(/^(.+?)\s*(?:\(\s*|,\s*|\s+)(?:dob|d\.o\.b\.?|born(?:\s+on)?|date of birth|birth\s*date)\s*[:\-]?\s*([^()]+?)\s*\)?\s*$/i);
  if (!m) return slots;
  const iso = normDob(m[2]);
  if (!iso || !/^\s*(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4}|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})\s*$/.test(m[2])) return slots;
  const out: Record<string, string> = { ...slots, name: m[1].replace(/[,\s]+$/, "") };
  if (slots.dob && slots.dob !== iso) delete out.dob; else out.dob = iso;
  return out;
}

/** The family a task belongs to and the slots its pattern names (empty for the loose fallbacks).
 *  Set 1 phrasings match FAMILY_PATTERNS; other phrasings route by meaning (semanticFamily, the
 *  lab/immunization/filing/good-faith slot extractors). A task no catalog pattern knows is classified by MEANING when it is an aggregate question
 *  (count of appointments / of different patients / top-k providers, any phrasing): aggregate.ts. */
export function familyMatch(text: string): FamilyMatch | null {
  const m = familyMatchAll(text);
  // Benches only (leave-one-workflow-out): AGENT_DISABLE_FAMILIES="claim-next-step,…" makes those families unknown, so the
  // task reaches the paths that answer tasks no family takes. Never set in a shift image.
  if (m && DISABLED().has(m.family)) return null;
  return m;
}
// "*" disables every family (benches of the paths that answer tasks no family takes: lowo, best-effort calibration).
const DISABLED = () => { const v = (process.env.AGENT_DISABLE_FAMILIES ?? "").trim(); return v === "*" ? { has: () => true } : new Set(v.split(",").map((x) => x.trim()).filter(Boolean)); };
export function familyMatchAll(text: string): FamilyMatch | null {
  const t = text.trim();
  for (const [family, ps] of FAMILY_PATTERNS) for (const p of ps) {
    const m = p.exec(t);
    if (m) {
      const slots: Record<string, string> = Object.fromEntries(Object.entries(m.groups ?? {}).filter(([, v]) => v !== undefined).map(([k, v]) => [k, (v as string).trim()]));
      // Lab triage in a phrasing the Set 1 catalog doesn't know: extract the slots by meaning
      // (labSlots.ts); unclear → no slots → the solver skips.
      if (family === "lab-report-triage" && !(slots.panel && slots.name && slots.received)) {
        const x = extractLabSlots(t);
        if (x) { slots.panel = x.panel; slots.name = x.name; slots.received = x.received; if (x.dob) slots.dob = x.dob; }
        // The loose "lab report" pattern: a count / list / date question about lab reports is another
        // workflow's question (bench loop: "how many lab reports were received…" skipped as triage).
        else if (!Object.keys(slots).length && /\bhow many\b|\bnumber of\b|\bcount\b|\blist\b|\bwhich\b|\bwhen\b|\bwhat date\b/i.test(t)) continue;
      }
      // [immunizations] a loose fallback (no slots) for the immunization families: read the
      // slots by meaning (paraphrase-robust; strict gates — a different question gets no slots → skip).
      if (!Object.keys(slots).length && family === "tetanus-wound") { const x = tetanusSlots(t); if (x) return { family, text: t, slots: x as Record<string, string> }; }
      if (!Object.keys(slots).length && family === "vaccine-lot-recall") { const x = recallSlots(t); if (x) return { family, text: t, slots: x }; }
      return { family, text: t, slots: nameDobSplit(slots) };
    }
  }
  // A lab-triage question that doesn't even say "lab report" ("Should the CBC for … go to a nurse?").
  const x = extractLabSlots(t);
  if (x) return { family: "lab-report-triage", text: t, slots: { panel: x.panel, name: x.name, received: x.received, ...(x.dob ? { dob: x.dob } : {}) } };
  const tw = tetanusSlots(t); if (tw) return { family: "tetanus-wound", text: t, slots: tw as Record<string, string> };
  const rc = recallSlots(t); if (rc) return { family: "vaccine-lot-recall", text: t, slots: rc };
  const lf = looseFiling(t) ?? looseGoodFaith(t) ?? looseClaim(t); if (lf) return lf;
  const sf = semanticFamily(t); if (sf) return { ...sf, text: t };
  const agg = parseAggQuery(t);
  if (agg.q) return { family: agg.family, text: t, slots: {} };
  // Clinic-wide list counts (Documents / Billing lists, listQuery.ts): last, so no family above ever loses a task to it.
  if (listMode() !== "off") { const lq = parseListQuery(t); if (lq.q) return { family: "list-count", text: t, slots: {} }; }
  return null;
}

const TITLE = "MD|DO|PA-C|PA|NP|CNM|CRNA|PhD|PsyD";
const LEAD = /^(?:Does|Did|Do|How|What|What's|Whats|Is|Was|For|On|At|As|Count|Number|Provider|Doctor|Dr\.?|Please|Show|Tell|Give|Many|Scheduled|Completed|Open|Free|And|But|The|Of|With)\s+/;
/** The one titled provider a question names ("Ethan Holmes, NP" / "Ethan Holmes NP"), or null when none or several. */
function titledProvider(t: string): string | null {
  const ps = [...t.matchAll(new RegExp(`([A-ZÀ-Þ][\\wÀ-ÿ'’.-]+(?:\\s+[A-ZÀ-Þ][\\wÀ-ÿ'’.-]+)+),?\\s+(${TITLE})\\b`, "g"))]
    .map((m) => { let n = m[1]; while (LEAD.test(n)) n = n.replace(LEAD, ""); return n.split(/\s+/).length >= 2 ? `${n}, ${m[2]}` : null; }).filter(Boolean) as string[];
  const uniq = [...new Set(ps)];
  return uniq.length === 1 ? uniq[0] : null;
}
/** A qualifier that narrows the count to one kind of visit (the solvers count every kind). */
const VISIT_KIND = /\b(new[- ]patient|follow[- ]?ups?|telehealth|virtual|video|in[- ]person|annual|physicals?|consult\w*|procedures?|therapy|counsel\w*|type|kind|sick|well[- ]child)\b/i;
/** The question part: the first sentence that asks (how many / number of / count / invoice), else the
 *  first that carries `cue` — a polite opener or an aside before it, or a definition after it, is
 *  not the question. */
const head = (t: string, cue: RegExp) => {
  const segs = t.split(/\?|(?<=[.:;!])\s+(?=[A-Z])/);
  return segs.find((x) => /\bhow many\b|\bnumber of\b|\bcount\b|\binvoice\b/i.test(x)) ?? segs.find((x) => cue.test(x)) ?? segs[0];
};

/**
 * Meaning-based routing for the families answered from page readers (invoice balance, a provider's
 * day counts, open slots). Requires every slot the solver needs, exactly once, and declines (null →
 * keyword tier / skip) on anything that changes the question: another status or time window, a
 * single location for an all-locations count, test records included, a yes/no or paid-so-far
 * question. The solvers then verify what the page shows (invoice number, patient, service date,
 * provider, date, location) before answering.
 */
const COUNT_WORDS = new Set(("how many number count total the as now for across all any every each location locations does did have has had are was were there what whats provider providers calendar schedule day " +
  "scheduled completed complete appointments appointment visits visit exclude excluding leave leaving out not counting dont don skip without omit ignore patients patient whose record records test tests deleted been " +
  "and that with his her their they them she please can could you tell give need know").split(" "));
const SLOT_WORDS = new Set("open free available unbooked bookable slots slot openings opening left remaining remain still working hours time times".split(" "));
/** Every content word of the question (beyond provider, date and location) is one a plain count
 *  question uses. Any other word ("booked online", "hours of", "combined", "new-patient") may narrow
 *  or change what is counted, so the question is not routed by meaning. */
function plainCount(q: string, strip: string[], slots: boolean): boolean {
  let x = q;
  for (const s of strip) x = x.split(s).join(" ");
  x = x.replace(/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{4}\b|\b[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}\b/g, " ").replace(new RegExp(`\\b(${TITLE})\\b`, "g"), " ");
  return x.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2).every((w) => COUNT_WORDS.has(w) || (slots && SLOT_WORDS.has(w)));
}

export function semanticFamily(t: string): FamilyMatch | null {
  const s = extractSlots(t);
  const q = head(t, /\binvoice\b|\bhow many\b|\bnumber of\b|\bcount\b|\bslots?\b|\bopenings?\b|\b(appointments?|visits?)\b/i);
  // ── invoice balance ──
  const inv = t.match(/\binvoice\s*(?:#|no\.?|number)?\s*(\d{5,})\b/i);
  if (inv && /\b(still owed?|owes?|owed|owing|balance|outstanding|unpaid|remaining|left to pay|still due|amount due)\b/i.test(q)) {
    if (/^\s*(?:(?:is|are|has|have|was|were|did|does)\b|do\b(?!\s+you\b))|\bpaid so far\b|\bbeen paid\b|\bamount paid\b|\bhow much (?:was|has been|have we) (?:paid|received|collected)\b|\btotal billed\b|\b(?:amount|originally) billed\b|\bissued\b|\bdue date\b|\bacross all\b|\ball (?:of )?(?:\w+'s )?invoices\b/i.test(q)) return null;
    if (s.dates.length > 1) return null;
    const slots: Record<string, string> = { invoice: inv[1] };
    if (s.patient) slots.name = s.patient;
    if (s.dates[0]) slots.dos = s.dates[0];
    return { family: "invoice-balance", slots };
  }
  const prov = titledProvider(t);
  if (!prov || s.dates.length !== 1 || /\bpatient\s+[A-ZÀ-Þ]/.test(t)) return null;
  const date = s.dates[0];
  const countCue = /\bhow many\b|\bnumber of\b|\bcount\b/i.test(q);
  // ── open slots at one location ──
  if (/\b(open|free|available|unbooked|bookable)\s+(?:appointment\s+)?(slots?|openings?|times?)\b|\bopenings?\b|\bslots?\b[^.?]{0,20}\b(open|free|available|left)\b/i.test(q)) {
    if (!countCue || /\b(first|next|earliest|latest|what time)\b|\bwhen (is|are|does|do|will|can)\b|\b\d+[- ]?min/i.test(q) || VISIT_KIND.test(q)) return null;
    const provName = prov.replace(/,\s*\S+$/, "");
    const locs = [...new Set([...t.matchAll(/\bat\s+([A-ZÀ-Þ][\wÀ-ÿ'’-]+(?:\s+[A-ZÀ-Þ][\wÀ-ÿ'’-]+){0,2})/g)].map((m) => m[1].trim()).filter((l) => !provName.includes(l) && !/^(Any|All|Every|Each)$/.test(l)))];
    if (locs.length !== 1 || !plainCount(q, [provName, locs[0]], true)) return null;
    return { family: "provider-open-slots", slots: { provider: prov, location: locs[0], date } };
  }
  // ── a provider's scheduled / completed count across all locations ──
  if (!/\b(appointments?|visits?)\b/i.test(q)) return null;
  const sched = /\bscheduled\b/i.test(q), done = /\bcomplete(?:d)?\b/i.test(q);
  if (sched === done) return null;
  if (!countCue && !/\b(scheduled|completed) (appointments?|visits?)\b[^?]*\?\s*$/i.test(t.split("?")[0] + "?")) return null;
  if (/\bcancel|\bno[- ]?shows?\b|\bweek\b|\bmonth\b|\byear\b|\bbetween\b|\bthrough\b|\buntil\b|\bsince\b|\brange\b|\baverage\b|\bpercent|\bslots?\b|\bopen\b|\b(before|after)\s+\d/i.test(q)) return null;
  if ([...t.matchAll(/\bat\s+(?!any\b|all\b|every\b|each\b)([A-ZÀ-Þ][\wÀ-ÿ'’-]+)/g)].some((m) => !prov.includes(m[1]))) return null; // one location named
  if (/\b(only|just)\b/i.test(q) || VISIT_KIND.test(q) || !plainCount(q, [prov.replace(/,\s*\S+$/, "")], false)) return null;
  if (!/\btest\b/i.test(t) || !/\bdelet/i.test(t) || /\binclud(?:e|ing)\b[^.?]{0,30}\b(test|deleted)\b/i.test(t)) return null; // the exclusion defines the answer
  return { family: sched ? "provider-day-scheduled-count" : "provider-day-completed-count", slots: { provider: prov, date } };
}
export function taskFamily(text: string): string | null { return familyMatch(text)?.family ?? null; }

/** Families solved by their own deterministic reader (solvers.ts); the keyword tier never sees them. */
export const FAMILY_SOLVERS = new Set(["lab-report-triage", "invoice-balance", "provider-day-scheduled-count", "provider-day-completed-count", "provider-open-slots", "claim-next-step", "filing-deadline", "tetanus-wound", "good-faith-estimate", "vaccine-lot-recall", "list-count", ...AGGREGATE_FAMILIES]);
/** Families the keyword tier may answer, and the one plan type each must route to. A task of any
 *  other KNOWN family is skipped before any crawl (Set 1: a lab question mentioning "DOB" was
 *  answered with the DOB). A task matching NO family still goes through the keyword tier and the
 *  grounded generalist (handleItem), because the catalog only knows Set 1's phrasings. */
export const KEYWORD_OK: Record<string, string[]> = {
  "new-vs-established": ["billing.new-or-established"],
  "patient-phone": ["patient.phone"],
  "referral-source": ["patient.referral-source"],
  "referral-reason": ["document.content"],
};
export const ANSWERABLE = KEYWORD_OK; // name kept for bench-logic's gating replay
