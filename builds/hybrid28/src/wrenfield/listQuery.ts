/**
 * Clinic-wide list counts: "how many <documents of a type> were received on <date>", "how many <status> invoices
 * <location> issued on <date>". ONE capability over the clinic's own lists (Documents, Billing), whatever the
 * phrasing, answered only when every part of the question maps to a labelled filter control or a column and the read
 * is proven complete (listRead.ts).
 *
 *   text ──parseListQuery──▶ ListQuery {list, typePhrase, status, location, dateField, window, exclude}
 *   messages ──listPolicy──▶ ListPolicy (the governing count workflow's rules, or defaults; anything unknown → decline)
 *   ListQuery + ListPolicy + ListSource ──solveListQuery──▶ answer | why
 *
 * Never-wrong rules (each → decline with a why):
 *  - any word of the question this parser does not account for (an unknown qualifier may narrow the count);
 *  - an unexplained capitalised word (a patient, a provider, a type or location the list does not offer);
 *  - a relative or open window ("today", "this week", "since", "between"), two dates, a window not yet over;
 *  - a type / status / location phrase that is not exactly one option of the list's own filter (read time);
 *  - rows the question is silent about that would change the count: Test / Deleted / Merged / unknown badges,
 *    Void invoices when no status is named (unless the governing message says how to treat them);
 *  - a governing count message with a rule this file does not know, answer tokens it does not know, or a later
 *    note about the same list.
 *
 * Pure (no browser): `npx tsx src/wrenfield/listQuery.test.ts`.
 */

/** AGENT_LIST_COUNT: "on" (default) answers; "shadow" routes, reads and logs `list_count` but skips; "off" never routes. */
export function listMode(): "on" | "shadow" | "off" { const v = (process.env.AGENT_LIST_COUNT ?? "on").toLowerCase(); return v === "off" || v === "0" ? "off" : v === "shadow" ? "shadow" : "on"; }

export type ListKind = "documents" | "invoices";
export type DateField = "received" | "issued" | "service";
export type InvStatus = "Open" | "Partly paid" | "Paid" | "Void";
export interface ListQuery {
  list: ListKind;
  /** documents: the type as asked ("referral letters"); undefined = every type. Mapped to a Type option at read time. */
  typePhrase?: string;
  status?: InvStatus;
  /** as asked; mapped to a Location option at read time */
  location?: string;
  dateField: DateField;
  window: { from: string; to: string; kind: "day" | "month" };
  /** what the question says to leave out */
  exclude: { test: boolean; deleted: boolean };
}
export type ListParse = { q: ListQuery } | { q: null; why: string };

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MON_RE = "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?";
const monthIdx = (s: string) => MONTHS.findIndex((m) => m.startsWith(s.toLowerCase().replace(/\.$/, "").slice(0, 3))) + 1;
const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const dim = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const validISO = (d: string) => { const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/); return !!m && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= dim(+m[1], +m[2]); };
export const normText = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();

/** Nouns that name a kind of document (the head of "referral letters", "lab reports", "eligibility responses"…). */
const DOC_HEAD = /^(documents?|docs?|letters?|reports?|statements?|responses?|orders?|questionnaires?|records?|eobs?|benefits|faxe?s|scans?|forms?|notices?|results?)$/i;
const STATUS_RE: Array<[InvStatus, RegExp]> = [
  ["Partly paid", /\bpart(?:ly|ially)[- ]paid\b/i],
  ["Void", /\bvoid(?:ed)?\b/i],
  ["Paid", /\b(?:fully )?paid\b/i],
  ["Open", /\bopen\b|\bunpaid\b/i],
];

/** Words a plain list-count question uses (beyond the list, its type/status/location/date and the exclusion clause). */
const VOCAB = new Set(("how many number count counts counting tally total the a an all our we us i did do does were was are is be been have has had there " +
  "in on at by for from with of as that please tell me can could would you give what what's whats it its altogether combined in total overall " +
  "received receive came come arrived arrive get got gotten issued issue issuing invoices invoice documents document docs type types kind kinds status " +
  "date dated location locations clinic clinics office offices site sites only just across any every each whole practice all-locations " +
  "of up into so far list into same day this that those these they them their need know want find out quick question ok okay thanks thank hi hey " +
  "filed logged entered showed show shown take took taken through added went go goes sent stats statistics metrics were there").split(/\s+/));
/** A leading context clause ("For the billing report:", "Quick question:") is not part of the question. */
const LEAD_CTX = /^(?:(?:for|re|about)\s+(?:the|our|today's|this)?\s*(?:daily|weekly|morning|monthly)?\s*(?:billing|front desk|him|hie|records|huddle|management|office|[A-Z]{2,5})?\s*(?:report|huddle|numbers|tally|count|log|review|stats|statistics|metrics)|quick (?:question|one|check)|question|hi|hey|fyi)\s*[:,-]\s*/i;
/** Months and other capitalised words that are not names. */
const OK_CAPS = new Set(["how", "what", "what's", "count", "number", "please", "can", "could", "would", "give", "tell", "on", "in", "at", "for", "of", "the", "by",
  "and", "or", "did", "do", "does", "were", "was", "is", "are", "we", "our", "i", "total", "leave", "exclude", "excluding", "ignore", "skip", "don't", "not", "only", "just",
  "all", "any", "every", "across", "type", "status", "invoice", "invoices", "documents", "document", "issued", "received", "for", "from", "with", "as", "a", "an",
  "quick", "question", "hi", "hey", "re", "fyi", "so", "also", "then", "thanks", "ok", "okay", "it", "that", "this", "there", "how many",
  ...MONTHS, ...MONTHS.map((m) => m.slice(0, 3)), "sept", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]);

/** The exclusion clause ("leave out test records and deleted records"): only Test / Deleted are understood. */
const EXCL_CLAUSE = /\b(?:leave out|leaving out|excluding|exclude|don'?t count|do not count|not counting|ignore|ignoring|skip|skipping|without)\b[^.;?!]*/gi;
const EXCL_WORDS = new Set("leave leaving out excluding exclude don't dont do not count counting ignore ignoring skip skipping without any the a an or and nor invoices documents ones those them of for belonging to patients patient whose record records is are has have been test tests deleted chart charts marked as account accounts".split(" "));
const INCL_RESTRICTED = /\b(?:includ(?:e|ing)|count(?:ing)?)\b[^.;?!]*\brestricted\b[^.;?!]*|\brestricted (?:charts?|records?|patients?|ones?)\b[^.;?!]{0,20}\b(?:too|included|count|as well)\b/gi;

function findDates(t: string): { days: string[]; months: Array<{ y: number; m: number }>; rest: string } {
  const days: string[] = [], months: Array<{ y: number; m: number }> = []; let mm: RegExpExecArray | null;
  let rest = t;
  const rIso = /\b(\d{4})-(\d{2})-(\d{2})\b/g; while ((mm = rIso.exec(t))) days.push(iso(+mm[1], +mm[2], +mm[3]));
  const rUs = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g; while ((mm = rUs.exec(t))) days.push(iso(+mm[3], +mm[1], +mm[2]));
  const rMon = new RegExp(`\\b${MON_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "gi"); while ((mm = rMon.exec(t))) days.push(iso(+mm[3], monthIdx(mm[1]), +mm[2]));
  const rDM = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MON_RE},?\\s+(\\d{4})\\b`, "gi"); while ((mm = rDM.exec(t))) days.push(iso(+mm[3], monthIdx(mm[2]), +mm[1]));
  rest = rest.replace(rIso, " ").replace(rUs, " ").replace(rMon, " ").replace(rDM, " ");
  const rM = new RegExp(`\\b${MON_RE}\\s+(?:of\\s+)?(\\d{4})\\b`, "gi"); while ((mm = rM.exec(rest))) months.push({ y: +mm[2], m: monthIdx(mm[1]) });
  rest = rest.replace(rM, " ");
  return { days, months, rest };
}

export function parseListQuery(text: string): ListParse {
  const no = (why: string): ListParse => ({ q: null, why: "list: " + why });
  let t = text.replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
  t = t.replace(LEAD_CTX, "");
  // "Total referral letters received on …?" — a leading "Total" before a plural noun is the count cue (an amount is refused below)
  t = t.replace(/\b(?:count|tell me|find out|check|see)\s+how many\b/gi, "how many"); // "could you count how many …"
  // "I'm doing the intake tally for 10/12/2026. How many referral letters did we get?" — the date of a stated task context
  // sentence belongs to the question that follows it (only this shape; anything else in the context sentence declines)
  { const m = t.match(/^(?:I'm|I am|we're|we are)\s+(?:doing|working on|putting together|preparing|finishing|running)\s+(?:the|our|a|an)\s+(?:[\w-]+\s+){0,3}(?:tally|report|count|numbers|stats|log|totals)\s+for\s+([^.?!]+?)\.\s+(.+\?)\s*$/i);
    if (m && !/\d/.test(m[2])) t = m[2].replace(/\?\s*$/, ` on ${m[1]}?`); }
  t = t.replace(/^\s*(?:the\s+)?total\s+(?!(?:amount|value|sum|dollars?|charges?|billed|owed|due|cost)\b)(?=(?:[\p{L}'-]+\s+){0,3}[\p{L}'-]+s\b)/iu, "How many ");
  const lt = t.toLowerCase();
  // ── the question must be a count ──
  if (!/\bhow many\b|\bnumber of\b|\bcount\b|\btally\b|\bwhat(?:'s| is) the (?:total )?(?:count|number)\b/i.test(t)) return no("not a count question");
  if (/\b(which|who|whose|when|where|why|list (?:them|the|all)|name (?:them|the)|show me)\b/i.test(t)) return no("asks for something other than a number");
  if (/\bhow much\b|\$|\bdollars?\b|\bamounts?\b|\bbalances?\b|\bowed?\b|\bowing\b|\boutstanding\b|\boverdue\b|\bpayments?\b|\bpaid (?:on|in|by|during|so far)\b|\baverage\b|\bmedian\b|\bpercent|\bratio\b|\bper\b|\beach (?:day|location|type|patient|month)\b/i.test(t)) return no("asks for an amount, a payment date or a rate");
  if (/\btoday\b|\byesterday\b|\btomorrow\b|\b(?:this|last|next|past|previous|current) (?:week|month|year|quarter|few)\b|\bweek\b|\bquarter\b|\byear to date\b|\bbetween\b|\bthrough\b|\bthru\b|\bsince\b|\buntil\b|\btill\b|\bbefore\b|\bafter\b|\bprior to\b|\bfrom \S+ (?:to|-)\b|\bso far\b|\bas of\b/i.test(t)) return no("relative or open-ended window");
  if (/\b(?:not|n't|never|no longer|still|yet|unread|unreviewed|unsigned|reviewed|signed|pending|awaiting|filed by|more than|less than|fewer|at least|at most|over|under|other than|except|duplicates?|unique|distinct|different)\b/i.test(t.replace(EXCL_CLAUSE, " "))) return no("a qualifier the list does not filter on");
  if (/\bDOB\b|\bborn\b|\bdate of birth\b|\bpatient (?:named|called)\b|\bfor (?:patient|mr|mrs|ms|dr)\b|\b(?:mr|mrs|ms|dr)\.?\s+[A-Z]/i.test(t)) return no("names a patient or a person");
  // ── exclusions ──
  const exclude = { test: false, deleted: false };
  let u = t;
  for (const m of t.match(EXCL_CLAUSE) ?? []) {
    const ws = m.toLowerCase().split(/[^a-z']+/).filter(Boolean);
    if (!ws.every((w) => EXCL_WORDS.has(w))) return no(`exclusion clause not understood ("${m.trim().slice(0, 60)}")`);
    if (/\btest/i.test(m)) exclude.test = true;
    if (/\bdeleted\b/i.test(m)) exclude.deleted = true;
    if (!exclude.test && !exclude.deleted) return no(`exclusion clause names nothing known ("${m.trim().slice(0, 60)}")`);
    u = u.replace(m, " ");
  }
  if (/\btest\b|\bdeleted\b|\bmerged\b/i.test(u)) return no("mentions test / deleted / merged records outside an exclusion clause");
  let restrictedSaid = false;
  u = u.replace(INCL_RESTRICTED, () => { restrictedSaid = true; return " "; });
  if (/\brestricted\b/i.test(u)) return no("mentions restricted charts in a way not understood");
  // ── dates ──
  const d = findDates(u);
  if (new RegExp(`\\b(?:in|on|during|for|of)\\s+${MON_RE}(?!\\s*\\d)`, "i").test(d.rest)) return no("a month or day without a year");
  if (/\b\d{1,2}\/\d{1,2}\b(?!\/)/.test(d.rest) || /\b\d{4}-\d{2}\b/.test(d.rest)) return no("a partial date");
  const n = d.days.length + d.months.length;
  if (n !== 1) return no(n ? "more than one date" : "no date");
  let window: ListQuery["window"];
  if (d.days.length) { if (!validISO(d.days[0])) return no(`invalid date ${d.days[0]}`); window = { from: d.days[0], to: d.days[0], kind: "day" }; }
  else { const { y, m } = d.months[0]; if (m < 1 || y < 1900) return no("invalid month"); window = { from: iso(y, m, 1), to: iso(y, m, dim(y, m)), kind: "month" }; }
  u = d.rest;
  if (/\b\d+\b/.test(u)) return no("a number the list does not filter on");
  u = u.replace(/\b(?:of|in|across) (?:any|all|every) (?:types?|kinds?)\b|\b(?:of )?(?:all|any) (?:types?|kinds?)\b/gi, " "); // "documents of any type" = no type filter
  // ── which list ──
  const inv = /\binvoices?\b/i.test(u);
  // the noun phrase after the count cue
  // "Invoices issued 10/11/2026 by Prairie View: how many?" — the counted noun before a trailing "how many"
  const TAIL_CUE = /\s*[:,—–-]?\s*(?:how many(?: (?:were|are) there| did we (?:get|have|receive|issue))?|what(?:'s| is) the (?:total )?(?:count|number))\s*\??\s*$/i;
  const tail = new RegExp(`^\\s*(?:the\\s+)?((?:[\\p{L}'-]+\\s+){0,4}?(?:invoices|documents|letters|reports|statements|responses|orders|questionnaires|records))\\b[^?]*?${TAIL_CUE.source}`, "iu").exec(u);
  if (tail) u = `how many ${tail[1]} ` + u.slice(tail[1].length + (tail.index ?? 0)).replace(TAIL_CUE, "?");
  let np = (u.match(/\b(?:how many|number of|count of|count(?: up)? (?:the|all|every)|count|tally of|tally)\s+(?:the\s+|all\s+(?:the\s+)?|our\s+)?((?:[\p{L}'-]+\s+){0,5}?[\p{L}'-]+?)(?=\s+(?:were|was|did|do|does|came|come|have|has|got|arrived|received|issued|on|in|at|for|from|by|with|that|which|are|is|dated|of type|of status|we|showed|show|shown|went|go|goes|sent|took|take|taken)\b|\s*[?,.:;]|\s*$)/iu)?.[1] ?? "").trim();
  if (!np) return no("no counted noun");
  const npw = np.split(/\s+/);
  let list: ListKind; let typePhrase: string | undefined; let status: InvStatus | undefined;
  if (inv) {
    if (!/\binvoices?\b/i.test(np)) return no(`counted noun "${np}" is not invoices`);
    // the counted noun ends at "invoices": what follows ("… invoices Northgate issued", "… invoices marked Paid") is read below
    np = np.replace(/(\binvoices?\b)[\s\S]*$/i, "$1");
    let rest = np.replace(/\binvoices?\b/i, " ");
    for (const [s, re] of STATUS_RE) if (re.test(rest)) { if (status) return no("two statuses"); status = s; rest = rest.replace(re, " "); }
    if (rest.trim() && !/^\s*(?:the|all|of)?\s*$/i.test(rest)) return no(`invoice qualifier "${rest.trim()}" not understood`);
    list = "invoices";
  } else {
    const head = npw[npw.length - 1];
    if (!DOC_HEAD.test(head) && !/^benefits$/i.test(head)) return no(`counted noun "${np}" is not a kind of document`);
    if (/^(?:records?|results?)$/i.test(head) && npw.length === 1) return no(`"${np}" alone is not a document type`);
    let tp = np.replace(/\s+(?:documents?|docs?)$/i, "").trim();
    if (/^(?:documents?|docs?)$/i.test(tp)) tp = "";
    list = "documents"; typePhrase = tp || undefined;
  }
  // "documents of type X" / "invoices with status X"
  const ofType = u.match(/\b(?:of|with) (?:the )?type\s+"?([\p{L}'][\p{L}' -]*?)"?(?=\s+(?:were|was|did|that|which|came|received|on|in|we)\b|\s*[?,.]|$)/iu);
  if (ofType) { if (list !== "documents" || typePhrase) return no("a type named twice or on invoices"); typePhrase = ofType[1].trim(); u = u.replace(ofType[0], " "); }
  const withStatus = u.match(/\b(?:with (?:a |the )?status(?: of)?|(?:that are|which are) (?:marked |in status )?|marked|in status|status:?)\s+"?(open|partly paid|partially paid|paid|void|voided)"?/i) ?? u.match(/\b(?:in|with|of|having) (?:an? |the )?"?(open|partly paid|partially paid|paid|void|voided)"? status\b/i);
  if (withStatus) { if (list !== "invoices") return no("a status on documents"); const s = STATUS_RE.find(([, re]) => re.test(withStatus[1]))![0]; if (status && status !== s) return no("two statuses"); status = s; u = u.replace(withStatus[0], " "); }
  // ── date field ──
  let dateField: DateField;
  if (list === "documents") {
    if (!/\b(?:received|receive|came in|come in|came through|arrived|arrive|did we get|did we got|we got|were filed|got in|logged|entered|showed up|show up|shown up|take in|took in|taken in|were added)\b/i.test(u)) return no("documents: the date is not said to be the received date");
    dateField = "received";
  } else {
    const svc = /\bservice dates?\b|\bdates? of service\b|\bDOS\b|\bfor (?:services?|visits?) (?:on|in|dated)\b/i.test(u);
    const iss = /\bissued?\b|\bissue dates?\b|\bissuing\b|\b(?:went|go|goes|were sent|was sent|sent) out\b/i.test(u);
    if (svc === iss) return no(svc ? "both the issued and the service date" : "invoices: neither the issued nor the service date is named");
    dateField = svc ? "service" : "issued";
    u = u.replace(/\bservice dates?\b|\bdates? of service\b|\bDOS\b|\bfor (?:services?|visits?)\b/gi, " ");
  }
  // ── location (invoices only) ──
  const W = "[A-Z][\\p{L}'’-]*";
  const locs = new Set<string>();
  const locPats = [
    new RegExp(`\\b(?:[Aa]t|[Bb]y|[Ff]or|[Ff]rom|[Ii]n)\\s+(?:the\\s+|our\\s+)?(${W}(?:\\s+${W}){0,3})(?:\\s+(?:location|clinic|office|site))?\\b`, "gu"),
    new RegExp(`\\((${W}(?:\\s+${W}){0,3})\\)`, "gu"),
    new RegExp(`\\binvoices\\s+(?:the\\s+)?(${W}(?:\\s+${W}){0,3})\\s+(?:location\\s+|clinic\\s+|office\\s+)?(?:issued|issues)\\b`, "gu"),
    new RegExp(`\\bdid\\s+(?:the\\s+)?(${W}(?:\\s+${W}){0,3})\\s+(?:location\\s+|clinic\\s+|office\\s+)?issue\\b`, "gu"),
    new RegExp(`[,(]\\s*(${W}(?:\\s+${W}){0,3})\\s+(?:only|location only)\\b`, "gu"),
    new RegExp(`\\b(${W}(?:\\s+${W}){0,3})\\s+(?:location|clinic|office|site)(?:'s)?\\b`, "gu"),
  ];
  for (const re of locPats) for (const m of u.matchAll(re)) {
    const cand = m[1].replace(/'s$/, "").trim();
    const first = cand.split(/\s+/)[0].toLowerCase();
    if (MONTHS.includes(first) || OK_CAPS.has(first) || STATUS_RE.some(([, r]) => r.test(cand))) continue;
    if (typePhrase && normText(typePhrase).includes(normText(cand))) continue;
    locs.add(cand);
  }
  if (locs.size > 1) return no(`several locations named (${[...locs].join(", ")})`);
  const location = [...locs][0];
  if (location && list !== "invoices") return no("a location on documents (the Documents list has no location)");
  if (location && /\b(?:all|every|any) (?:of (?:our|the) )?(?:locations|clinics|offices|sites)\b/i.test(u)) return no("both a location and all locations");
  if (list === "invoices") for (const [, re] of STATUS_RE) u = u.replace(new RegExp(re.source, "gi"), (m) => m.toLowerCase()); // "Partly paid" is a status, not a name
  // ── every capitalised word explained ──
  const explained = new Set([...(location ? location.split(/\s+/) : []), ...(typePhrase ? typePhrase.split(/\s+/) : [])].map((w) => normText(w)));
  for (const w of u.split(/[^\p{L}'’-]+/u).filter(Boolean)) {
    const lw = normText(w).replace(/'s$/, "");
    if (!/^\p{Lu}/u.test(w) || OK_CAPS.has(lw) || explained.has(lw) || explained.has(normText(w))) continue;
    if (STATUS_RE.some(([, r]) => r.test(w)) && list === "invoices") continue;
    if (DOC_HEAD.test(w)) continue;
    return no(`unexplained capitalised word "${w}" (a name, a type or a place not understood)`);
  }
  // ── every remaining word is one a plain count uses ──
  let rest = " " + normText(u) + " ";
  for (const p of [location, typePhrase, np].filter(Boolean) as string[]) rest = rest.split(normText(p)).join(" ");
  for (const [, re] of STATUS_RE) rest = rest.replace(new RegExp(re.source, "gi"), " ");
  const unknown = rest.split(/[^a-z']+/).filter((w) => w.length > 1 && !VOCAB.has(w) && !VOCAB.has(w.replace(/'s$/, "")));
  if (unknown.length) return no(`words a plain count does not use: ${unknown.slice(0, 4).join(", ")}`);
  void restrictedSaid; void lt;
  return { q: { list, typePhrase, status, location, dateField, window, exclude } };
}

// ── the governing message ──
export interface ListPolicy {
  /** a count workflow message governs this list */
  governed: boolean;
  /** "count Void ones only when the question asks about Void invoices" */
  voidUnlessAsked?: boolean;
  /** "Count documents of restricted charts too" (true) / "leave out restricted" (false) */
  restricted?: boolean;
  /** "leave out test / deleted records" said by the message */
  exclude?: { test: boolean; deleted: boolean };
  /** the message's default date field for invoices ("the Issued date, not the service date") */
  invoiceDate?: DateField;
  /** the answer for zero ("If none …, answer `0`") */
  zero?: string;
}
const SENT_SPLIT = /(?<=[.!?;])\s+|\n+/;
/** Sentence parts a count rule may contain and what they mean. Anything with a TRIGGER word left after these are
 *  removed is a rule we do not know → the whole message is not understood. */
const TRIGGER = /\b(only|unless|except|exclud\w*|leave out|leaving out|don'?t|do not|never|not|instead|rather|treat\w*|consider\w*|counts? as|separately|twice|once|duplicates?|merged|test|deleted|void\w*|restricted|cancel\w*|credit\w*|refund\w*|adjust\w*|before|after|between|business days?|weekends?|holidays?|time ?zone|local time|midnight|cut-?off|round\w*|decimals?|format|answer|respond|reply|report it as|write|spell|digits?|leading|zero)\b/i;
export function listPolicy(messages: string[], list: ListKind, statusAsked = false): ListPolicy | { why: string } {
  const noun = list === "invoices" ? /\binvoices?\b/i : /\bdocuments?\b|\b(?:referral |lab |immunization )?(?:letters?|reports?|statements?)\b/i;
  const isCountMsg = (m: string) => m.length >= 200 && noun.test(m) && (list === "invoices" ? /\b(?:how many|count(?:ing)?|number of)\s+(?:\w+\s+){0,3}invoices?\b/i : /\b(?:how many|count(?:ing)?|number of)\s+(?:\w+\s+){0,3}(?:documents?|letters?|reports?|statements?)\b/i).test(m);
  let gi = -1; for (let i = 0; i < messages.length; i++) if (isCountMsg(messages[i])) gi = i;
  // a short note about the same list (after the governing message, or anywhere when none governs) may change the rows
  // (an amendment that names answer tokens belongs to a token workflow, not to the list; a note on payments / balances
  // only moves invoices between statuses, so it blocks a count by status only)
  const later = messages.slice(gi + 1).filter((m) => m.length < 400 && !isCountMsg(m) && !/`[A-Z][A-Z_]{2,}`|\b[A-Z]{2,}_[A-Z_]{2,}\b/.test(m)
    && (list === "invoices" ? /\binvoices?\b|\bbilling\b|\bpayments?\b|\bvoid/i : /\bdocuments?\b|\bfax|\bscann|\breferral letters?\b|\blab reports?\b|\bstatements?\b/i).test(m)
    && (list === "invoices" ? /\b(?:void\w*|delet\w*|remov\w*|duplicat\w*|re-?issu\w*|re-?dated|cancel\w*|credit\w*|refund\w*|count\w*|issued|missing|wrong|moved|merged|payments?|balances?|status\w*)\b/i : /\b(?:received|receiv\w+|came in|arriv\w+|scann\w*|fax\w*|upload\w*|delet\w*|remov\w*|duplicat\w*|misfiled|moved|re-?dated|count\w*|missing|lost|wrong|backlog|late|dated?)\b/i).test(m)
    && (statusAsked || list !== "invoices" || !/^[^.]*\b(?:posting|posted|post)\b[^.]*\bpayments?\b[^.]*\b(?:balances?|owed?)\b[^.]*\.?\s*$/i.test(m.trim())));
  if (later.length) return { why: `list: a later note about ${list} may change the rows ("${later[later.length - 1].slice(0, 70)}")` };
  if (gi < 0) return { governed: false };
  const raw = messages[gi];
  const tokens = [...raw.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()).filter((x) => !/^\d+(?:\.\d+)?$/.test(x));
  const p: ListPolicy = { governed: true };
  const body = raw.split(/\n#+\s*(?:worked )?examples?\b/i)[0].split("\n").slice(1).join("\n"); // title line and examples are not rules
  for (const s0 of body.split(SENT_SPLIT).map((s) => s.trim()).filter(Boolean)) {
    if (/^#+\s/.test(s0) || /^\|/.test(s0)) { if (/^\|/.test(s0)) return { why: "list: the count message has a table of answers" }; continue; }
    let s = s0;
    const take = (re: RegExp, f: () => void) => { if (re.test(s)) { f(); s = s.replace(re, " "); } };
    take(/\bcount(?: the)? (?:documents|invoices|ones|those|them|rows)? ?(?:of|for|on|belonging to) restricted (?:charts?|records?|patients?)(?: too| as well)?\b|\brestricted (?:charts?|records?|patients?)(?:'s)? (?:documents|invoices)? ?(?:count|are counted|are included)(?: too| as well)?\b|\binclud(?:e|ing) (?:those of )?restricted (?:charts?|records?|patients?)\b/gi, () => (p.restricted = true));
    take(/\b(?:leave out|exclude|don'?t count|do not count) (?:documents |invoices |those |ones )?(?:of |for )?restricted (?:charts?|records?|patients?)\b/gi, () => (p.restricted = false));
    take(/\bcount void (?:ones|invoices) only when the question asks (?:about|for) void (?:ones|invoices)\b|\bvoid (?:ones|invoices) (?:count|are counted) only (?:when|if) (?:the question|asked)\w*(?: about them| for them)?\b|\b(?:don'?t|do not) count void (?:ones|invoices) unless (?:the question|asked)\w*(?: asks)?(?: (?:about|for) them)?\b/gi, () => (p.voidUnlessAsked = true));
    take(/\b(?:leave out|exclude|don'?t count|do not count|skip) (?:any )?(?:documents |invoices |ones )?(?:of |for )?(?:patients whose record is )?(?:a )?test records?(?: (?:and|or) (?:has been )?deleted(?: records?)?)?\b/gi, () => { p.exclude = { test: true, deleted: /deleted/i.test(s0) }; });
    take(/\(?\s*the issued date,? not the service date\s*\)?|\bby (?:the )?issued? date\b/gi, () => (p.invoiceDate = "issued"));
    take(/\bat every location unless a location is named\b|\bat all locations unless (?:a|one) (?:location )?is named\b|\bevery location unless (?:one|a location) is named\b/gi, () => {});
    take(/\banswer with the number alone(?:,? for example `\d+`)?|\banswer with (?:just |only )?(?:the|a) (?:whole )?number(?:,? for example `\d+`)?/gi, () => {});
    take(/\bif (?:none|no (?:invoice|document|invoices|documents|row|rows)) (?:were|was|is|are)? ?(?:received|issued|matches?|match|found)?,? answer `0`/gi, () => (p.zero = "0"));
    take(/\b(?:statuses|the statuses) are open, partly paid, paid,? and void\b/gi, () => {});
    take(/\btypes are the ones in the documents list\b[^.;]*/gi, () => {});
    take(/\b(?:you'll|you will) be asked (?:for |about )?how many [^.;]*/gi, () => {});
    if (TRIGGER.test(s)) return { why: `list: a rule in the count message is not understood ("${s0.slice(0, 80)}")` };
  }
  if (tokens.length) return { why: `list: the count message names answer tokens (${tokens.slice(0, 3).join(", ")})` };
  // The message's own worked example questions must be ones this parser reads as a count of the same list (LESSONS C.6:
  // a path that can't read its workflow's example doesn't understand the workflow).
  const ex = raw.split(/\n#+\s*(?:worked )?examples?\b/i)[1] ?? "";
  for (const m of ex.matchAll(/["“]([^"”]{10,200}\?)["”]/g)) {
    const r = parseListQuery(m[1]);
    if (!r.q || r.q.list !== list) return { why: `list: the count message's example "${m[1].slice(0, 60)}" is not read as a ${list} count (${r.q ? r.q.list : (r as { why: string }).why})` };
  }
  return p;
}

// ── solving over a proven-complete read ──
export type ListFlag = "Test record" | "Deleted" | "Restricted" | "Merged";
export interface ListRow { key: string; date: Partial<Record<DateField, string>>; type?: string; status?: string; location?: string; flags: ListFlag[]; unknownBadge?: string }
export interface ListOptions { type?: string[]; status?: string[]; location?: string[] }
export type ListFilter = { list: ListKind; dateField: DateField; from: string; to: string; type?: string; status?: string; location?: string };
export interface ListSource {
  todayISO(): string;
  /** The list's own filter options by label (Type / Status / Location), read from the form. null → the list or form was not found. */
  options(list: ListKind): Promise<ListOptions | { fail: string }>;
  /** Every row of the list under these filters, proven complete (pager / Show-more proofs), or a failure. */
  read(f: ListFilter): Promise<{ rows: ListRow[]; proof: string } | { fail: string }>;
}
export type ListOut = { answer: string; detail: Record<string, unknown> } | { why: string };

const singular = (w: string) => w.replace(/ies$/i, "y").replace(/(ch|sh|x|ss)es$/i, "$1").replace(/(?<!s)s$/i, "");
/** The one option equal to the phrase (case, accents, plural of the first or last word, a trailing "documents"). */
export function optionFor(phrase: string, options: string[]): string | null {
  const p = normText(phrase).replace(/\s+(?:documents?|docs?)$/, "");
  const ws = p.split(" ");
  const forms = new Set([p, [...ws.slice(0, -1), singular(ws[ws.length - 1])].join(" "), [singular(ws[0]), ...ws.slice(1)].join(" "), ws.map(singular).join(" ")]);
  if (/^eobs?$/.test(p)) forms.add("explanation of benefits");
  const hits = options.filter((o) => forms.has(normText(o)) || forms.has(normText(o).replace(/\s+(?:documents?|docs?)$/, "")));
  return hits.length === 1 ? hits[0] : null;
}

export async function solveListQuery(q: ListQuery, policy: ListPolicy, src: ListSource): Promise<ListOut> {
  const today = src.todayISO();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) return { why: "list: clinic's today unknown (a window not yet over can't be told)" };
  if (q.window.to >= today) return { why: `list: the window ends ${q.window.to}, not before today ${today} (rows may still arrive)` };
  const dateField: DateField = q.dateField;
  if (q.list === "invoices" && policy.invoiceDate && policy.invoiceDate !== dateField) return { why: `list: the message counts by the ${policy.invoiceDate} date, the question by the ${dateField} date` };
  const opts = await src.options(q.list);
  if ("fail" in opts) return { why: "list: " + opts.fail };
  const f: ListFilter = { list: q.list, dateField, from: q.window.from, to: q.window.to };
  if (q.typePhrase) { const o = optionFor(q.typePhrase, opts.type ?? []); if (!o) return { why: `list: "${q.typePhrase}" is not one Type option (${(opts.type ?? []).slice(0, 10).join(" | ")})` }; f.type = o; }
  if (q.status) { const o = (opts.status ?? []).filter((x) => normText(x) === normText(q.status!)); if (o.length !== 1) return { why: `list: status "${q.status}" is not one Status option` }; f.status = o[0]; }
  if (q.location) { const o = optionFor(q.location, opts.location ?? []); if (!o) return { why: `list: "${q.location}" is not one Location option` }; f.location = o; }
  const r = await src.read(f);
  if ("fail" in r) return { why: "list: " + r.fail };
  // client-side re-filter: a filter the site silently ignored can't widen the count
  const hits = r.rows.filter((x) => {
    const d = x.date[dateField]; if (!d) return true; // checked below
    return d >= f.from && d <= f.to && (!f.type || normText(x.type ?? "") === normText(f.type)) && (!f.status || normText(x.status ?? "") === normText(f.status)) && (!f.location || normText(x.location ?? "") === normText(f.location));
  });
  // every row of a filtered read must satisfy the filter: a row outside it means the page shown was not (only) this
  // filter's result — a stale page, a filter the site ignored — and its count proves nothing (practice: a stale page of
  // the previous filter was read as "0 matching")
  if (hits.length !== r.rows.length) return { why: `list: ${r.rows.length - hits.length} of ${r.rows.length} rows read are outside the requested filter (the list did not apply it)` };
  if (hits.some((x) => !x.date[dateField])) return { why: `list: a row without a readable ${dateField} date` };
  if (f.type && hits.some((x) => x.type === undefined)) return { why: "list: rows without a Type" };
  if (f.status && hits.some((x) => x.status === undefined)) return { why: "list: rows without a Status" };
  if (f.location && hits.some((x) => !x.location)) return { why: "list: rows without a Location" };
  const ex = { test: q.exclude.test || !!policy.exclude?.test, deleted: q.exclude.deleted || !!policy.exclude?.deleted };
  let kept = hits;
  const unk = kept.find((x) => x.unknownBadge); if (unk) return { why: `list: a row with an unknown badge "${unk.unknownBadge}"` };
  if (kept.some((x) => x.flags.includes("Merged"))) return { why: "list: a Merged record among the rows (one person may be counted twice)" };
  const test = kept.filter((x) => x.flags.includes("Test record")), del = kept.filter((x) => x.flags.includes("Deleted"));
  if (test.length && !ex.test) return { why: `list: ${test.length} test-record row(s) and the question doesn't say whether they count` };
  if (del.length && !ex.deleted) return { why: `list: ${del.length} deleted-record row(s) and the question doesn't say whether they count` };
  kept = kept.filter((x) => !(ex.test && x.flags.includes("Test record")) && !(ex.deleted && x.flags.includes("Deleted")));
  if (policy.restricted === false) kept = kept.filter((x) => !x.flags.includes("Restricted"));
  let voids = 0;
  if (q.list === "invoices" && !f.status) {
    voids = kept.filter((x) => normText(x.status ?? "") === "void").length;
    if (kept.some((x) => x.status === undefined)) return { why: "list: invoice rows without a Status" };
    if (voids && !policy.voidUnlessAsked) return { why: `list: ${voids} Void invoice(s) and the question doesn't say whether they count` };
    kept = kept.filter((x) => normText(x.status ?? "") !== "void");
  }
  const n = kept.length;
  const answer = n === 0 && policy.zero ? policy.zero : String(n);
  return { answer, detail: { filter: f, rowsRead: r.rows.length, matched: hits.length, counted: n, voidsLeftOut: voids, proof: r.proof, governed: policy.governed } };
}
