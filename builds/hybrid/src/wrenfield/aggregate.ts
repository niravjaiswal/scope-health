/**
 * Aggregate queries over the clinic's appointments: ONE capability for "how many appointments",
 * "how many different patients" and "which k providers had the most", whatever the filters.
 *
 *   text ──parseAggQuery──▶ AggQuery {measure, status, scope, provider, window, time, exclusions, ordering}
 *        ──solveAggregate(q, source)──▶ answer | decline (why)
 *
 * The source (live: apptList.ts over the appointment list; tests: fixtures) hands back a PROVEN-COMPLETE
 * set of rows for the narrowest server-side filter (status + location + provider + dates), and the
 * engine re-applies every filter client-side, so a filter the site silently ignored can't widen the count.
 *
 * Never-wrong rules (each → decline with a why):
 *  - a question shape, filter, unit or aggregation this file does not know (parser returns null);
 *  - boundary wording whose inclusivity isn't stated ("by 2 PM", "until 14:00", "between …");
 *  - a row the question is silent about that would change the answer (a test/deleted record when the
 *    question doesn't say to leave them out; an inactive provider in the top k when "active" isn't said);
 *  - ties at the k-th place, or ties inside the top k without a tie rule;
 *  - distinct people that can't be told apart: a Merged row that can't be resolved, or two records
 *    with the same name and date of birth that are not linked by a merge.
 *
 * Pure (no browser): `npx tsx src/wrenfield/test-aggregate.ts` exercises it end to end on fixtures.
 */

export const STATUSES = ["Scheduled", "Completed", "Cancelled", "Late cancel", "No-show"] as const;
export type Status = (typeof STATUSES)[number];
export type Measure = "appointments" | "distinct-patients" | "top-providers";
export type TimeOp = "<" | "<=" | ">" | ">=";
export type Window = { from: string; to: string; kind: "day" | "month" } | { relative: "last-month" | "this-month"; kind: "month" };

export interface AggQuery {
  measure: Measure;
  k?: number;
  status: Status;
  scope: { kind: "location"; location: string } | { kind: "all" };
  provider?: string;
  window: Window;
  /** Filter on the appointment's START time, minutes after midnight, in `tz` (undefined = the location's local time). */
  time?: { op: TimeOp; minute: number; tz?: string };
  /** What the question says about records to leave out. Silent → rows with that flag must not change the answer. */
  exclude: { test: boolean; deleted: boolean };
  /** top-providers: "only providers who are active today count". */
  activeOnly: boolean;
  /** top-providers: tie order the question states (only "last name, then first name" is known). */
  tieRule?: "last-first";
  names: "first-last" | "first-last-credential";
}

// ── small text helpers ──
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MON_RE = "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?";
const monthIdx = (s: string) => MONTHS.findIndex((m) => m.startsWith(s.toLowerCase().replace(/\.$/, "").slice(0, 3))) + 1;
const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const dim = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export function validISO(d: string): boolean {
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/); if (!m) return false;
  const y = +m[1], mo = +m[2], da = +m[3];
  return mo >= 1 && mo <= 12 && da >= 1 && da <= dim(y, mo);
}
export function addDays(isoDate: string, n: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + n * 86400000);
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}
export function monthWindow(y: number, m: number): { from: string; to: string } { return { from: iso(y, m, 1), to: iso(y, m, dim(y, m)) }; }
export const normName = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[.]/g, "").replace(/\s+/g, " ").trim();
const CRED_RE = /,?\s+(MD|M\.D\.|DO|D\.O\.|NP|PA-C|PA|RN|CNM|CRNA|DNP|FNP|APRN|PhD|PsyD)\.?$/i;
/** "Roy Nelson, MD" / "Dr. Roy Nelson" → "Roy Nelson". */
export const stripCred = (s: string) => s.trim().replace(/^Dr\.?\s+/i, "").replace(CRED_RE, "").trim();

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const kOf = (w: string | undefined): number | undefined => { if (!w) return undefined; const n = /^\d+$/.test(w) ? +w : NUMBER_WORDS[w.toLowerCase()]; return n && n >= 1 && n <= 20 ? n : undefined; };

/** "14:00", "2:00 PM", "2 PM", "noon" → minutes. 24-hour "H:MM" with H in 1..6 is ambiguous for a clinic (→ undefined). */
export function parseClock(s: string): number | undefined {
  const t = s.trim().toLowerCase().replace(/\s+/g, " ");
  if (/^(noon|midday|12 noon)$/.test(t)) return 720;
  let m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?$/);
  if (m) { const h = +m[1], mi = +(m[2] ?? 0); if (h < 1 || h > 12 || mi > 59) return undefined; return (h % 12 + (m[3] === "p" ? 12 : 0)) * 60 + mi; }
  m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (m) { const h = +m[1], mi = +m[2]; if (h > 23 || mi > 59 || (h >= 1 && h <= 6)) return undefined; return h * 60 + mi; }
  return undefined;
}
const TIME_RE = "(noon|midday|\\d{1,2}:\\d{2}(?:\\s*[AaPp]\\.?\\s*[Mm]\\.?)?|\\d{1,2}\\s*[AaPp]\\.?\\s*[Mm]\\.?)";
const TZ_RE = "(local(?: time)?|(?:in )?(?:the )?(?:location's|clinic's|site's) (?:local )?time|[CMEP][SD]?T|UTC|GMT|Central|Mountain|Eastern|Pacific)(?: time)?";

/** UTC offset in hours for a zone label. Generic zones ("Central") take daylight time from `dstHint`. */
export function tzOffset(label: string, dstHint?: boolean): number | undefined {
  const l = label.trim().toUpperCase().replace(/ TIME$/, "");
  const fixed: Record<string, number> = { CDT: -5, CST: -6, MDT: -6, MST: -7, EDT: -4, EST: -5, PDT: -7, PST: -8, UTC: 0, GMT: 0 };
  if (l in fixed) return fixed[l];
  const generic: Record<string, number> = { CT: -6, CENTRAL: -6, MT: -7, MOUNTAIN: -7, ET: -5, EASTERN: -5, PT: -8, PACIFIC: -8 };
  if (l in generic) return dstHint === undefined ? undefined : generic[l] + (dstHint ? 1 : 0);
  return undefined;
}
const isDST = (label: string) => /^[A-Z]DT$/.test(label.trim().toUpperCase());

// ── parser ──
/** Words that put a question outside this capability (another family's subject, or a shape we don't do). */
const HARD_NEGATIVE = new RegExp([
  "\\blab(?:oratory)?\\b", "\\breports?\\b", "\\binvoices?\\b", "\\bowed?\\b", "\\bbalance\\b", "\\bbill(?:ed|ing)?\\b", "\\breferr(?:al|als|ed|ing)\\b",
  "\\bphone\\b", "\\bclaims?\\b", "\\bfiling\\b", "\\bdeadline\\b", "\\bestimate\\b", "\\brecall(?:ed)?\\b", "\\blots?\\b", "\\btetanus\\b",
  "\\bvaccin\\w*", "\\bimmuniz\\w*", "\\bDOB\\b", "\\bborn\\b", "\\bdate of birth\\b", "\\bestablished\\b", "\\bremittance\\b", "\\bopen slots?\\b",
  "\\bslots?\\b", "\\bpayments?\\b", "\\bdollars?\\b", "\\$", "\\baverage\\b", "\\bpercent(?:age)?\\b", "\\bratio\\b", "\\bmedian\\b", "\\btotal (?:length|minutes|hours|time)\\b",
  "\\bminutes\\b", "\\bhours\\b", "\\blongest\\b", "\\bshortest\\b", "\\bfewest\\b", "\\bthe least\\b", "\\bleast (?:number|visits|appointments)\\b", "\\blowest\\b", "\\bweeks?\\b", "\\bquarter\\b", "\\bbetween\\b",
  "\\bthrough\\b", "\\bsince\\b", "\\bfrom \\S+ to\\b", "\\byear to date\\b", "\\bper (?:day|month|provider|location)\\b", "\\beach (?:day|month|provider|location)\\b",
  "\\bnew patients?\\b", "\\bfirst[- ]time\\b", "\\bvisit types?\\b", "\\btelehealth\\b", "\\brecurring\\b", "\\bspecialt(?:y|ies)\\b", "\\bdepartments?\\b",
  "\\bended\\b", "\\bending\\b", "\\bfinish(?:ed|ing)? (?:before|after|by)\\b", "\\bcheck(?:ed)?[- ]in\\b", "\\bwait(?:ing)?\\b", "\\bnotes?\\b", "\\bdocuments?\\b",
  "\\binactive\\b", "\\bfirst name only\\b", "\\bat most\\b", "\\bat least (?!one\\b)\\w+",
].join("|"), "i");

const STATUS_WORDS: Array<[Status, RegExp]> = [
  ["Late cancel", /\blate[- ]?cancel(?:l?ed|l?ations?|s)?\b/i],
  ["No-show", /\bno[- ]?shows?\b|\bdid(?:n'?t| not) show(?: up)?\b|\bfailed to show\b/i],
  ["Cancelled", /\bcancell?ed\b|\bcancell?ations?\b|\bcancels?\b/i],
  ["Completed", /\bcompleted?\b|\bfinished\b|\battended\b|\b(?:were|was|been|being) seen\b|\bpatients seen\b/i],
  ["Scheduled", /\bscheduled\b|\bstill on the (?:books|schedule)\b/i],
];
function statusOf(t: string): Status | null {
  // "Late cancel" contains "cancel": test it first and blank it out before looking for the others.
  let rest = t; const found = new Set<Status>();
  for (const [s, re] of STATUS_WORDS) { if (re.test(rest)) { found.add(s); rest = rest.replace(new RegExp(re.source, "gi"), " "); } }
  return found.size === 1 ? [...found][0] : null;
}

/** Capitalised words we expect in a question that are not names (sentence openers, months, weekdays, units). */
const OK_CAPS = new Set(["how", "which", "what", "who", "count", "leave", "list", "only", "if", "please", "can", "could", "would", "give", "tell", "i", "i'm", "i'd", "we", "we're", "our",
  "the", "in", "at", "on", "for", "of", "make", "just", "so", "include", "exclude", "excluding", "don't", "do", "does", "did", "and", "or", "also", "then", "list", "name", "rank",
  "put", "skip", "ignore", "out", "across", "among", "during", "within", "a", "an", "is", "are", "were", "was", "hey", "hi", "quick", "question", "find", "need", "want", "looking",
  "any", "all", "every", "each", "patients", "patient", "providers", "provider", "appointments", "appointment", "visits", "visit", "completed", "scheduled", "cancelled",
  "canceled", "no-show", "late", "number", "total", "by", "with", "from", "to", "local", "time", "noon", "count", "counting", "people", "person", "record", "records", "test",
  "deleted", "let", "me", "know", "us", "it", "that", "this", "those", "these", "there", "here", "ok", "okay", "thanks", "thank", "you", "first", "last", "alphabetical",
  "order", "use", "using", "sort", "same", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "top", "most", "busiest", "highest", "as", "of", "now",
  "today", "currently", "active", "still", "considering", "consider", "show", "showing", "report", "where", "when", "they", "them", "their", "with", "without", "not", "no",
  "registered", "more", "than", "once", "duplicate", "duplicates", "registrations", "even", "different", "distinct", "unique", "individual", "separate", "had", "have", "has", "had", "be", "should", "must", "who",
  "after", "before", "started", "starting", "start", "began", "beginning", "earlier", "later", "am", "pm", "a.m.", "p.m.", "ties", "tied", "tie", "break", "names", "full",
  "starting", "highest", "number", "most", "greatest", "biggest", "largest", "dr", "doctor", "mr", "ms", "mrs", "seen", "booked", "help", "figure", "work", "out", "check",
  "remember", "note", "both", "either", "neither", "about", "around", "regarding", "re", "fyi", "ask", "asking", "wondering", "curious", "pull", "up", "get", "got",
  ...MONTHS, ...MONTHS.map((m) => m.slice(0, 3)), "sept", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "cdt", "cst", "mdt", "mst", "edt", "est", "pdt", "pst", "ct", "mt", "et", "pt", "utc", "gmt", "central", "mountain", "eastern", "pacific", "md", "do", "np", "pa", "pa-c"]);

export type ParseResult = { q: AggQuery; family: string } | { q: null; why: string };

/** Text → typed aggregate query, or a reason it isn't one we can answer. Conservative by design. */
export function parseAggQuery(text: string): ParseResult {
  const no = (why: string): ParseResult => ({ q: null, why });
  const t = text.replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
  if (!/\b(how many|number of|count|which|what|who|name|list|top|rank)\b/i.test(t)) return no("not a count/rank question");
  const neg = t.match(HARD_NEGATIVE); if (neg) return no(`outside aggregate scope ("${neg[0]}")`);

  // measure
  let measure: Measure | null = null, k: number | undefined;
  const NUM = "(\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)";
  const many = t.match(new RegExp(`\\b${NUM}\\s+(?:(?:busiest|leading|top)\\s+)?(?:providers|clinicians)\\b`, "i"));
  const single = /\b(?:which|what)\s+(?:single\s+|one\s+)?(?:provider|clinician)\b(?!s)|\bthe (?:busiest|top) (?:provider|clinician)\b(?!s)/i.test(t);
  const mostWord = /\b(?:most|highest number|largest number|greatest number|busiest|top)\b/i.test(t);
  if ((many || single) && mostWord && /\b(?:which|what|who|name|list|rank|top|tell|give)\b/i.test(t)) {
    measure = "top-providers";
    k = many ? kOf(many[1]) : 1;
    if (k === undefined) return no("top-providers: no number of providers");
  } else if (/\b(?:how many|number of|count(?: up)?|tally)\s+(?:the\s+|all\s+)?(?:(?:different|distinct|unique|individual|separate)\s+)?(?:patients|people|persons)\b/i.test(t)
    || /^(?:the\s+)?(?:different|distinct|unique|individual|separate)\s+(?:patients|people|persons)\b[^?.]{0,140}[:,]\s*how many\?/i.test(t)) measure = "distinct-patients";
  else if (/\b(?:how many|number of|count(?: up)?|tally)\s+(?:the\s+|all\s+|of\s+the\s+)?(?:[\w-]+\s+){0,2}(?:visits|appointments|cancell?ations|no-shows|no shows)\b/i.test(t)) measure = "appointments";
  if (!measure) return no("no known aggregation (count of appointments, count of different patients, top-k providers)");
  if (measure === "appointments" && /\bpatients?\b/i.test(t.replace(/\b(?:appointments|records?|visits) of patients\b|\bpatients whose record\b|\bpatients? (?:with|who have|that have) (?:a )?test\b/gi, " "))) {
    // "How many appointments did patients …" style mixes: only accept the patient-exclusion clause
    if (!/\bleave out\b|\bexclud|\bskip\b|\bdon'?t count\b|\bignore\b/i.test(t)) return no("appointments count mentioning patients in an unknown way");
  }

  // status
  const status = statusOf(t.replace(/\b(?:test records?|deleted|registered)\b/gi, " "));
  if (!status) return no("status not stated exactly once (completed / scheduled / cancelled / late cancel / no-show)");

  // scope
  let scope: AggQuery["scope"] | null = null;
  const all = /\b(?:across|at|in|for)\s+(?:all|any|every)(?:\s+of)?\s+(?:our\s+|the\s+)?(?:locations|location|clinics|clinic|sites|site|offices)\b|\b(?:group|practice|clinic|system|organization)[- ]wide\b|\ball (?:of )?(?:our )?locations\b/i.test(t);
  const W = "[A-Z][\\p{L}'’-]*";
  const locRe = new RegExp(`\\b(?:[Aa]t|[Ii]n|[Ff]or)\\s+(?:the\\s+)?(${W}(?:\\s+${W}){0,3})(?:\\s+(?:location|clinic|office|site|campus))?\\b`, "gu");
  const locs: string[] = [];
  for (const m of t.matchAll(locRe)) {
    const cand = m[1].trim();
    const first = cand.split(/\s+/)[0].toLowerCase().replace(/[.,]$/, "");
    if (MONTHS.includes(first) || MONTHS.map((x) => x.slice(0, 3)).includes(first) || first === "sept" || /^(all|any|every|our|local|least|most|one|dr|doctor|patients?|providers?|each|the|this|last|which|who|ties?)$/i.test(first)) continue;
    locs.push(cand.replace(/\s+(?:Location|Clinic|Office|Site|Campus)$/, ""));
  }
  if (all && locs.length) return no("both all-locations and a named location");
  if (locs.length > 1) return no(`several locations named (${locs.join(", ")})`);
  if (all) scope = { kind: "all" };
  else if (locs.length === 1) scope = { kind: "location", location: locs[0] };
  if (!scope) return no("location scope not stated (a named location, or all locations)");

  // provider filter (only with a title or credential: a bare name could be a patient)
  let provider: string | undefined;
  const pm = t.match(new RegExp(`\\b(?:Dr\\.?\\s+(${W}(?:\\s+${W}){0,2})|(${W}(?:\\s+${W}){1,2}),?\\s+(?:MD|DO|NP|PA-C|PA|M\\.D\\.|D\\.O\\.))\\b`, "u"));
  if (pm) provider = stripCred((pm[1] ?? pm[2]).trim());
  if (provider && measure === "top-providers") return no("top-providers question names a provider");

  // window
  const days: string[] = [], months: Array<{ y: number; m: number }> = [];
  let mm: RegExpExecArray | null;
  const rDayIso = /\b(\d{4})-(\d{2})-(\d{2})\b/g; while ((mm = rDayIso.exec(t))) days.push(iso(+mm[1], +mm[2], +mm[3]));
  const rDayUs = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g; while ((mm = rDayUs.exec(t))) days.push(iso(+mm[3], +mm[1], +mm[2]));
  const rDayMon = new RegExp(`\\b${MON_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "gi"); while ((mm = rDayMon.exec(t))) days.push(iso(+mm[3], monthIdx(mm[1]), +mm[2]));
  const rDayDM = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MON_RE},?\\s+(\\d{4})\\b`, "gi"); while ((mm = rDayDM.exec(t))) days.push(iso(+mm[3], monthIdx(mm[2]), +mm[1]));
  const tNoDays = t.replace(rDayMon, " ").replace(rDayDM, " ");
  const rMon = new RegExp(`\\b${MON_RE}\\s+(?:of\\s+)?(\\d{4})\\b`, "gi"); while ((mm = rMon.exec(tNoDays))) months.push({ y: +mm[2], m: monthIdx(mm[1]) });
  const rMonIso = /\b(\d{4})-(\d{2})\b(?!-\d)/g; while ((mm = rMonIso.exec(t))) months.push({ y: +mm[1], m: +mm[2] });
  const rMonUs = /\b(\d{1,2})\/(\d{4})\b/g; while ((mm = rMonUs.exec(t.replace(rDayUs, " ")))) months.push({ y: +mm[2], m: +mm[1] });
  const rel = t.match(/\b(last|previous|prior|this|the current|current)\s+(?:calendar\s+)?month\b/i);
  const bareMonth = new RegExp(`\\b(?:in|during|for|of)\\s+(?:the month of\\s+)?${MON_RE}(?!\\s*(?:\\d|of\\s+\\d))\\b`, "i").test(tNoDays);
  const mentions = days.length + months.length + (rel ? 1 : 0);
  if (mentions !== 1) return no(mentions ? "more than one date or month mentioned" : (bareMonth ? "month without a year" : "no date or month"));
  let window: Window;
  if (days.length) { if (!validISO(days[0])) return no(`invalid date ${days[0]}`); window = { from: days[0], to: days[0], kind: "day" }; }
  else if (months.length) { const { y, m } = months[0]; if (m < 1 || m > 12 || y < 1900) return no("invalid month"); window = { ...monthWindow(y, m), kind: "month" }; }
  else window = { relative: /^(this|the current|current)$/i.test(rel![1]) ? "this-month" : "last-month", kind: "month" };

  // time-of-day bound on the start time
  let time: AggQuery["time"];
  const tm = t.match(new RegExp(`\\b(at or before|on or before|no later than|at or after|on or after|no earlier than|before|after|earlier than|later than|prior to|by|until|till|up to|as late as|around|about)\\s+${TIME_RE}(?:\\s+${TZ_RE})?`, "i"));
  const anyClock = new RegExp(`\\b${TIME_RE}`, "i").test(t.replace(/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{4}\b/g, " "));
  if (tm) {
    const word = tm[1].toLowerCase();
    const op: TimeOp | null = /^(before|earlier than|prior to)$/.test(word) ? "<" : /^(after|later than)$/.test(word) ? ">" : /^(at or before|on or before|no later than)$/.test(word) ? "<=" : /^(at or after|on or after|no earlier than)$/.test(word) ? ">=" : null;
    if (!op) return no(`time bound "${tm[0]}" does not say whether the boundary is included`);
    const minute = parseClock(tm[2]); if (minute === undefined) return no(`unreadable or ambiguous time "${tm[2]}"`);
    const tzw = tm[3]?.trim();
    const tz = !tzw || /local|location's|clinic's|site's/i.test(tzw) ? undefined : tzw.replace(/^in\s+(?:the\s+)?/i, "").replace(/\s+time$/i, "");
    if (tz && tzOffset(tz, true) === undefined) return no(`unknown time zone "${tzw}"`);
    time = { op, minute, tz };
  } else if (anyClock) return no("a clock time without a known before/after bound");

  // exclusions, provider activity, ordering
  const exclude = { test: /\btest\b(?:\s+(?:or|and|\/)\s+deleted)?[\s-]*(?:records?|patients?|charts?|accounts?|data|ones)\b/i.test(t), deleted: /\bdeleted\b/i.test(t) };
  const activeOnly = /\bactive\b/i.test(t);
  if (activeOnly && measure !== "top-providers") return no("'active' qualifier outside a providers ranking");
  let tieRule: AggQuery["tieRule"];
  if (/\bties?\b|\btied\b/i.test(t)) {
    if (/\blast name\b[^.]*\bfirst name\b/i.test(t) && /\balphabetical/i.test(t)) tieRule = "last-first";
    else return no("tie rule other than alphabetical by last name then first name");
  }
  if (measure === "top-providers") {
    if (/\b(?:fewest|the least|ascending|lowest first|smallest first)\b/i.test(t)) return no("ascending order");
    if (/\blast name,? first name\b(?![^.]*\btie)/i.test(t.replace(/alphabetical order by last name, then first name/gi, ""))) return no("name format Last, First");
  }
  const names: AggQuery["names"] = /\bcredentials?\b|\bwith (?:their )?(?:titles?|degrees?)\b/i.test(t) ? "first-last-credential" : "first-last";
  // "Roy Nelson, MD, Ana Ruiz, NP" is split by the judge at EVERY comma (shift.md: an item with a comma goes in a JSON list) -> never a wrong list
  if (measure === "top-providers" && names === "first-last-credential" && (k ?? 1) > 1) return no("credentials in a list of names: a comma-joined string is split at every comma");

  // Leftover capitalised words must be explained (location, provider, months…): an unexplained name could be a patient.
  const explained = new Set<string>([...(scope.kind === "location" ? scope.location.split(/\s+/) : []), ...(provider ? provider.split(/\s+/) : [])].map((w) => w.toLowerCase()));
  const words = t.replace(/\b(?:Dr\.?)\s*/g, " ").split(/[^\p{L}'’.-]+/u).filter(Boolean);
  for (const w of words) {
    const lw = w.toLowerCase().replace(/[.'’]+$/, "").replace(/'s$/, "");
    if (!/^\p{Lu}/u.test(w) || OK_CAPS.has(lw) || explained.has(lw) || explained.has(lw.replace(/'s$/, ""))) continue;
    return no(`unexplained name-like word "${w}" (could be a patient)`);
  }

  const q: AggQuery = { measure, k, status, scope, provider, window, time, exclude, activeOnly, tieRule, names };
  return { q, family: familyOf(q) };
}

/** Workflow-family id for logs and the family gate. Set 1's three shapes keep their catalog ids. */
export function familyOf(q: AggQuery): string {
  if (q.measure === "distinct-patients") return q.scope.kind === "location" && q.window.kind === "month" && !q.provider && !q.time ? "location-month-distinct-patients" : "aggregate-distinct-patients";
  if (q.measure === "top-providers") return q.scope.kind === "all" && q.window.kind === "month" && q.status === "Completed" && !q.time ? "top-providers-completed-month" : "aggregate-top-providers";
  return q.scope.kind === "location" && q.window.kind === "day" && q.status === "Completed" && q.time?.op === "<" && !q.provider ? "location-completed-before-time" : "aggregate-appointment-count";
}
export const AGGREGATE_FAMILIES = ["location-month-distinct-patients", "location-completed-before-time", "top-providers-completed-month", "aggregate-distinct-patients", "aggregate-top-providers", "aggregate-appointment-count"];

// ── rows the source hands back ──
export type Flag = "Test record" | "Deleted" | "Restricted" | "Merged";
export const KNOWN_FLAGS: Flag[] = ["Test record", "Deleted", "Restricted", "Merged"];
export interface ApptRow {
  key: string; dateISO: string; start: number; end: number; tz: string;
  patientName: string; patientId: string; flags: Flag[]; unknownBadge?: string;
  provider: string; location: string; visitType: string; status: string;
}
/** A patient record opened to resolve a merge / tell same-named people apart. */
export interface ResolvedRecord { canonicalId: string; name?: string; flags: Flag[]; dobISO?: string; gated?: boolean; /** the chart says another record was merged into it */ mergedBanner?: boolean }
/** status "any": the list's own "All statuses" choice (patient-context reads, contextResolve.ts). */
export type ReadFilter = { from: string; to: string; status: Status | "any"; location?: string; provider?: string;
  /** Context reads only (contextResolve): a finished Show-more list whose footer is the bare "about N …" end form with
   *  the control gone is complete (listFooter.endSealed). Aggregates never set it: an estimate is no exact count. */
  sealed?: boolean;
  /** Context reads only: the list's "Visit type" filter, set by option LABEL ("Wound care"); every row read back must show it. */
  visitType?: string;
  /** Context reads only (good-faith estimate): the list is ordered by start time, so read it only until a row starts after this
   *  (minutes after midnight). The rows returned are a PREFIX of the list (every row starting at or before this is in it). */
  upToStart?: number };
export interface AggSource {
  todayISO(): string;
  /** Location names the site offers (filter options), or null if unreadable. */
  locations(): Promise<string[] | null>;
  /** Provider roster with Active/Inactive (null when the page doesn't say), or null if unreadable. */
  roster(): Promise<Array<{ label: string; active: boolean | null }> | null>;
  /** Visit types the list filter offers (option labels), or null when it has no such filter. Optional (context reads only). */
  visitTypes?(): Promise<string[] | null>;
  /** Every appointment matching the filter, proven complete — or why not. */
  read(filter: ReadFilter): Promise<{ rows: ApptRow[] } | { fail: string }>;
  /** Open one patient record (never a restricted one). null = could not read it. */
  resolve(patientId: string): Promise<ResolvedRecord | null>;
  /** The size the list states for each filter without reading it ("Showing 20 of about 750"; `exact` when the site states an exact
   *  total) — several at once. A fail says why no size is known. Optional: sources without it keep the one-big-read path. */
  estimates?(filters: ReadFilter[]): Promise<Array<{ total: number; exact: boolean } | { fail: string }>>;
  /** Several proven-complete reads at once (extra tabs). Optional, with `estimates`. */
  readMany?(filters: ReadFilter[]): Promise<Array<{ rows: ApptRow[] } | { fail: string }>>;
}
/** A list states "about N" on a 25-row grid: the true number of rows is within 12 of it (nearest-25 rounding; apptList.endFormProof
 *  validates that on every list it reads to its end). An unread list is bounded from above by N + 24 (twice the rounding, so a
 *  different rounding rule still holds). */
export const EST_UPPER = 24;
/** Above this many rows for the whole range, top-providers is answered provider by provider (see topByEstimate). */
export const TOP_ONE_READ_MAX = 600;
export type AggOut = { answer: string; detail: Record<string, unknown> } | { why: string };

const minutesAt = (row: ApptRow, q: NonNullable<AggQuery["time"]>): number | undefined => {
  if (!q.tz) return row.start;
  const rowOff = tzOffset(row.tz); const qOff = tzOffset(q.tz, isDST(row.tz));
  if (rowOff === undefined || qOff === undefined) return undefined;
  return row.start + Math.round((qOff - rowOff) * 60); // the row's start expressed on the question's clock
};
const timeOk = (v: number, op: TimeOp, b: number) => op === "<" ? v < b : op === "<=" ? v <= b : op === ">" ? v > b : v >= b;

/** "Smith, John A." → {last:"smith", first:"john a"} */
function splitPatient(name: string): { last: string; first: string } {
  const [l, ...f] = name.split(","); return { last: normName(l ?? ""), first: normName(f.join(" ")) };
}
function lev(a: string, b: string): number {
  if (a === b) return 0; if (Math.abs(a.length - b.length) > 2) return 3;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
/** Two display names that could be the same person registered twice (exact, or a misspelling of one part). */
export function nearName(a: string, b: string): boolean {
  const x = splitPatient(a), y = splitPatient(b);
  return (x.last === y.last && lev(x.first, y.first) <= 2) || (x.first === y.first && x.first !== "" && lev(x.last, y.last) <= 2);
}

/** Answer a parsed query from a source. Never throws; every doubt is a `why`. */
export async function solveAggregate(q: AggQuery, src: AggSource, opts: { maxResolves?: number; /** top-k over a big range reads ~80 provider lists + the close ones to the end (100+ requests): false = never (solvers.aggregate: AGG_TOPK=on) */ topBig?: boolean } = {}): Promise<AggOut> {
  const no = (why: string): AggOut => ({ why: "aggregate: " + why });
  try {
    // window
    let from: string, to: string;
    if ("relative" in q.window) {
      const today = src.todayISO(); if (!validISO(today)) return no("clinic today unknown for a relative month");
      const [y, m] = today.split("-").map(Number);
      const [yy, mo] = q.window.relative === "this-month" ? [y, m] : m === 1 ? [y - 1, 12] : [y, m - 1];
      ({ from, to } = monthWindow(yy, mo));
    } else ({ from, to } = q.window);

    // location / provider names → the site's own labels (exact, normalised)
    let location: string | undefined;
    if (q.scope.kind === "location") {
      const ls = await src.locations(); if (!ls?.length) return no("location list unreadable");
      const hit = ls.filter((l) => normName(l) === normName(q.scope.kind === "location" ? q.scope.location : ""));
      if (hit.length !== 1) return no(`location "${q.scope.location}" is not exactly one of the site's locations`);
      location = hit[0];
    }
    let roster: Array<{ label: string; active: boolean | null }> | null = null;
    let provider: string | undefined;
    if (q.provider || q.measure === "top-providers") {
      roster = await src.roster(); if (!roster?.length) return no("provider roster unreadable");
    }
    if (q.provider) {
      const hit = roster!.filter((r) => normName(stripCred(r.label)) === normName(q.provider!));
      if (hit.length !== 1) return no(`provider "${q.provider}" is not exactly one roster entry`);
      provider = hit[0].label;
    }

    // top-providers over a big range: one filtered list per active provider instead of every row of the clinic (16,950 in a month)
    if (q.measure === "top-providers" && q.activeOnly && !q.time && !provider && opts.topBig !== false && src.estimates && src.readMany) {
      const whole = (await src.estimates([{ from: addDays(from, -1), to: addDays(to, 1), status: q.status, location }]))[0];
      if (whole && !("fail" in whole) && whole.total > TOP_ONE_READ_MAX) return await topByEstimate(q, src, roster!, from, to, location, no);
    }

    // one proven-complete read, one day wider each side (the site's date filter may not be the location's calendar day)
    const r = await src.read({ from: addDays(from, -1), to: addDays(to, 1), status: q.status, location, provider });
    if ("fail" in r) return no(r.fail);
    const rows = r.rows;
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.key)) return no(`row read twice (${row.key})`); seen.add(row.key);
      if (row.status !== q.status) return no(`status filter not applied (row "${row.status}")`);
      if (location && normName(row.location) !== normName(location)) return no(`location filter not applied (row at "${row.location}")`);
      if (provider && normName(stripCred(row.provider)) !== normName(stripCred(provider))) return no(`provider filter not applied (row "${row.provider}")`);
      if (!validISO(row.dateISO) || row.dateISO < addDays(from, -1) || row.dateISO > addDays(to, 1)) return no(`row date ${row.dateISO} outside the requested range`);
    }
    let hits = rows.filter((x) => x.dateISO >= from && x.dateISO <= to);
    if (q.time) {
      const out: ApptRow[] = [];
      for (const x of hits) { const v = minutesAt(x, q.time); if (v === undefined) return no(`time zone "${x.tz}" or "${q.time.tz}" unknown`); if (timeOk(v, q.time.op, q.time.minute)) out.push(x); }
      hits = out;
    }
    const unk = hits.find((x) => x.unknownBadge); if (unk) return no(`unknown badge "${unk.unknownBadge}" on ${unk.patientName}`);
    // test / deleted records: leave out when the question says so; when it is silent they must not matter
    const isTest = (x: { flags: Flag[] }) => x.flags.includes("Test record"), isDel = (x: { flags: Flag[] }) => x.flags.includes("Deleted");
    if (!q.exclude.test && hits.some(isTest)) return no("a test record is among the hits and the question doesn't say whether to count it");
    if (!q.exclude.deleted && hits.some(isDel)) return no("a deleted record is among the hits and the question doesn't say whether to count it");
    hits = hits.filter((x) => !(q.exclude.test && isTest(x)) && !(q.exclude.deleted && isDel(x)));
    const detail: Record<string, unknown> = { from, to, read: rows.length, hits: hits.length };

    if (q.measure === "appointments") return { answer: String(hits.length), detail };

    if (q.measure === "distinct-patients") {
      // canonical record per patient id: resolve Merged rows, and any id whose name is close to another id's
      const names = new Map<string, string>(); const merged = new Set<string>(); const restricted = new Set<string>();
      for (const x of hits) { names.set(x.patientId, x.patientName); if (x.flags.includes("Merged")) merged.add(x.patientId); if (x.flags.includes("Restricted")) restricted.add(x.patientId); }
      const ids = [...names.keys()];
      const need = new Set<string>(merged);
      const byLast = new Map<string, string[]>(), byFirst = new Map<string, string[]>();
      for (const id of ids) { const s = splitPatient(names.get(id)!); (byLast.get(s.last) ?? byLast.set(s.last, []).get(s.last)!).push(id); (byFirst.get(s.first) ?? byFirst.set(s.first, []).get(s.first)!).push(id); }
      // near-name pairs (same last name and first name ≤2 edits apart, or the reverse): open both records
      for (const id of ids) {
        const s = splitPatient(names.get(id)!);
        for (const o of byLast.get(s.last)!) if (o !== id && nearName(names.get(id)!, names.get(o)!)) { need.add(id); need.add(o); }
        for (const o of byFirst.get(s.first) ?? []) if (o !== id && nearName(names.get(id)!, names.get(o)!)) { need.add(id); need.add(o); }
      }
      const cap = opts.maxResolves ?? 150;
      if (need.size > cap) return no(`${need.size} records need opening to tell people apart (cap ${cap})`);
      const canon = new Map<string, ResolvedRecord>();
      for (const id of need) {
        if (restricted.has(id)) {
          if (merged.has(id)) return no(`restricted Merged record ${names.get(id)} can't be resolved without opening a restricted chart`);
          canon.set(id, { canonicalId: id, flags: ["Restricted"] }); continue; // never break the glass; a restricted record is itself
        }
        const rec = await src.resolve(id);
        if (!rec) return no(`could not open record ${names.get(id)}`);
        if (rec.gated) return no(`record ${names.get(id)} opened onto a restricted chart`);
        if (merged.has(id) && rec.canonicalId === id && !rec.mergedBanner) return no(`Merged record ${names.get(id)} did not lead to a surviving chart`);
        canon.set(id, rec);
      }
      const people = new Map<string, { name: string; dob?: string; checked: boolean }>();
      for (const id of ids) {
        const c = canon.get(id);
        const cid = c?.canonicalId ?? id;
        if (c && ((q.exclude.test && c.flags.includes("Test record")) || (q.exclude.deleted && c.flags.includes("Deleted")))) continue; // the surviving record is a test/deleted record
        if (c && ((!q.exclude.test && c.flags.includes("Test record")) || (!q.exclude.deleted && c.flags.includes("Deleted")))) return no("surviving record is test/deleted and the question is silent");
        if (!people.has(cid)) people.set(cid, { name: c?.name ?? names.get(id)!, dob: c?.dobISO, checked: !!c });
      }
      // "Count each person once even if they are registered more than once": two unlinked records with the SAME
      // name and the SAME date of birth are one person registered twice → counted once. Records whose names match
      // or differ by a misspelling with dates of birth that are close but not equal (merged duplicates on this site
      // look like that: "Ahmed"/"Amed", 09/12 vs 09/11) can't be told apart → decline. Same name with one date of
      // birth unknown (a restricted chart is never opened) → decline.
      const parent = new Map<string, string>(); const root = (x: string): string => { const p = parent.get(x) ?? x; if (p === x) return x; const r = root(p); parent.set(x, r); return r; };
      const ppl = [...people.entries()].filter(([, p]) => p.checked); // near-name records were all opened (or are restricted)
      for (let i = 0; i < ppl.length; i++) for (let j = i + 1; j < ppl.length; j++) {
        const [ia, a] = ppl[i], [ib, b] = ppl[j];
        if (!nearName(a.name, b.name)) continue;
        const same = normName(a.name) === normName(b.name);
        if (!a.dob || !b.dob) { if (same) return no(`two records named ${a.name}, one date of birth unknown`); continue; }
        if (same && a.dob === b.dob) { parent.set(root(ib), root(ia)); continue; }
        if (Math.abs(Date.parse(a.dob) - Date.parse(b.dob)) <= 31 * 86400000) return no(`two unlinked records that may be one person: ${a.name} (${a.dob}) and ${b.name} (${b.dob})`);
      }
      const persons = new Set([...people.keys()].map((id) => root(id)));
      return { answer: String(persons.size), detail: { ...detail, patientIds: ids.length, opened: need.size, records: people.size, people: persons.size } };
    }

    // top-providers
    const k = q.k!;
    const act = new Map<string, boolean | null>(); for (const p of roster!) act.set(normName(stripCred(p.label)), p.active);
    const counts = new Map<string, { label: string; n: number }>();
    for (const x of hits) { const key = normName(stripCred(x.provider)); const c = counts.get(key) ?? { label: x.provider, n: 0 }; c.n++; counts.set(key, c); }
    for (const key of counts.keys()) if (!act.has(key)) return no(`provider "${counts.get(key)!.label}" is not on the roster`);
    let ranked = [...counts.entries()].map(([key, v]) => ({ key, label: v.label, n: v.n, active: act.get(key) ?? null }));
    if (q.activeOnly) { if (ranked.some((p) => p.active === null)) return no("roster doesn't say who is active"); ranked = ranked.filter((p) => p.active); }
    ranked.sort((a, b) => b.n - a.n);
    if (ranked.length < k) return no(`only ${ranked.length} providers with ${q.status.toLowerCase()} visits`);
    if (!q.activeOnly && ranked.slice(0, k + 1).some((p) => p.active === false)) return no("an inactive provider is in the top places and the question doesn't say whether they count");
    if (ranked.length > k && ranked[k].n === ranked[k - 1].n) return no(`tie at place ${k} (${ranked[k - 1].label} and ${ranked[k].label}, ${ranked[k].n} each)`);
    const topK = ranked.slice(0, k);
    const nm = (label: string) => { const parts = stripCred(label).split(/\s+/); return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1], tokens: parts.length }; };
    for (let i = 1; i < topK.length; i++) if (topK[i].n === topK[i - 1].n) {
      if (q.tieRule !== "last-first") return no("tie inside the top places and no tie rule");
      if (nm(topK[i].label).tokens !== 2 || nm(topK[i - 1].label).tokens !== 2) return no("tied provider with a name whose last name is unclear");
    }
    topK.sort((a, b) => b.n - a.n || nm(a.label).last.localeCompare(nm(b.label).last) || nm(a.label).first.localeCompare(nm(b.label).first));
    const out = topK.map((p) => q.names === "first-last-credential" ? p.label.trim() : stripCred(p.label));
    return { answer: out.join(", "), detail: { ...detail, ranked: ranked.slice(0, k + 2).map((p) => `${p.label}:${p.n}`) } };
  } catch (e) { return no("threw " + String(e).slice(0, 120)); }
}

/** Top-k providers by visits over a range too big to read whole. Every ACTIVE provider's filtered list states its size ("about N");
 *  that bounds what the provider can have (N + EST_UPPER). Providers are read to the end (proven, exact count after the question's
 *  exclusions) from the largest bound down, until every unread provider's bound is strictly below the k-th exact count: none of them
 *  can be in the top k nor tie at place k. The rest of the ranking, ties and name format are the one-read path's. Any list whose size
 *  is not stated, or that cannot be proven complete, declines the question. */
async function topByEstimate(q: AggQuery, src: AggSource, roster: Array<{ label: string; active: boolean | null }>, from: string, to: string, location: string | undefined, no: (why: string) => AggOut): Promise<AggOut> {
  const k = q.k!;
  if (roster.some((p) => p.active === null)) return no("roster doesn't say who is active");
  const actives = roster.filter((p) => p.active === true);
  if (actives.length < k) return no(`only ${actives.length} active providers`);
  const pf = addDays(from, -1), pt = addDays(to, 1);
  const filt = (label: string): ReadFilter => ({ from: pf, to: pt, status: q.status, location, provider: label });
  const est = await src.estimates!(actives.map((p) => filt(p.label)));
  const ub = new Map<string, number>(); // label → upper bound of the rows the provider's list holds
  for (let i = 0; i < actives.length; i++) {
    const e = est[i]; if (!e || "fail" in e) return no(`size of ${actives[i].label}'s list unknown (${e ? e.fail : "no answer"})`);
    ub.set(actives[i].label, e.exact ? e.total : e.total + EST_UPPER);
  }
  const isTest = (x: { flags: Flag[] }) => x.flags.includes("Test record"), isDel = (x: { flags: Flag[] }) => x.flags.includes("Deleted");
  const counts = new Map<string, number>();
  const readBatch = async (labels: string[]): Promise<string | null> => {
    const res = await src.readMany!(labels.map(filt));
    for (let i = 0; i < labels.length; i++) {
      const r = res[i]; const label = labels[i];
      if (!r || "fail" in r) return `${label}'s list: ${r ? r.fail : "not read"}`;
      const seen = new Set<string>();
      for (const row of r.rows) {
        if (seen.has(row.key)) return `row read twice (${row.key})`; seen.add(row.key);
        if (row.status !== q.status) return `status filter not applied (row "${row.status}")`;
        if (location && normName(row.location) !== normName(location)) return `location filter not applied (row at "${row.location}")`;
        if (normName(stripCred(row.provider)) !== normName(stripCred(label))) return `provider filter not applied (row "${row.provider}" in ${label}'s list)`;
        if (!validISO(row.dateISO) || row.dateISO < pf || row.dateISO > pt) return `row date ${row.dateISO} outside the requested range`;
      }
      if (r.rows.length > ub.get(label)!) return `${label}'s list holds ${r.rows.length} rows, more than its stated size allows (${ub.get(label)})`;
      let hits = r.rows.filter((x) => x.dateISO >= from && x.dateISO <= to);
      const unk = hits.find((x) => x.unknownBadge); if (unk) return `unknown badge "${unk.unknownBadge}" on ${unk.patientName}`;
      if (!q.exclude.test && hits.some(isTest)) return "a test record is among the hits and the question doesn't say whether to count it";
      if (!q.exclude.deleted && hits.some(isDel)) return "a deleted record is among the hits and the question doesn't say whether to count it";
      hits = hits.filter((x) => !(q.exclude.test && isTest(x)) && !(q.exclude.deleted && isDel(x)));
      counts.set(label, hits.length);
    }
    return null;
  };
  const byBound = actives.map((p) => p.label).sort((a, b) => ub.get(b)! - ub.get(a)! || a.localeCompare(b));
  let batch = byBound.slice(0, k + 3);
  for (let round = 0; ; round++) {
    if (round > 6 || counts.size + batch.length > 40) return no(`too many providers close to the top places (${counts.size} read)`);
    const bad = await readBatch(batch); if (bad) return no(bad);
    const kth = [...counts.values()].sort((a, b) => b - a)[k - 1];
    batch = byBound.filter((l) => !counts.has(l) && ub.get(l)! >= kth).slice(0, 8);
    if (!batch.length) break;
  }
  const nm = (label: string) => { const parts = stripCred(label).split(/\s+/); return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1], tokens: parts.length }; };
  const ranked = [...counts.entries()].map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n);
  if (ranked.length > k && ranked[k].n === ranked[k - 1].n) return no(`tie at place ${k} (${ranked[k - 1].label} and ${ranked[k].label}, ${ranked[k].n} each)`);
  const topK = ranked.slice(0, k);
  for (let i = 1; i < topK.length; i++) if (topK[i].n === topK[i - 1].n) {
    if (q.tieRule !== "last-first") return no("tie inside the top places and no tie rule");
    if (nm(topK[i].label).tokens !== 2 || nm(topK[i - 1].label).tokens !== 2) return no("tied provider with a name whose last name is unclear");
  }
  topK.sort((a, b) => b.n - a.n || nm(a.label).last.localeCompare(nm(b.label).last) || nm(a.label).first.localeCompare(nm(b.label).first));
  const out = topK.map((p) => q.names === "first-last-credential" ? p.label.trim() : stripCred(p.label));
  return { answer: out.join(", "), detail: { from, to, providers: actives.length, read: counts.size, ranked: ranked.slice(0, k + 2).map((p) => `${p.label}:${p.n}`), via: "per-provider lists" } };
}
