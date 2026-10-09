/**
 * Lookup path: a plain question about ONE patient's chart ("Every other task is a question about the clinic's
 * data", shift.md), answered from one labelled value or one count over a proven-complete chart list read by
 * solver/toolkit.ts. No model. Runs only for a task no family, keyword plan, chart answerer or workflow took.
 *
 *   question → patient (name, DOB) + entity (by noun) → rows of that chart list (toolkit, completeness proof)
 *            → rows narrowed by values the question names (a cell value whose words all appear in it), a date,
 *              a window, first / last → the one column it names (or "when" → the date column) → the cell as shown
 *
 * Never-wrong rules: every content word of the question must be accounted for (name, DOB, dates, the entity
 * noun, a header, a filter value read from the rows, window / first-last / count words) or the task declines;
 * one row (or rows that agree); a date answer comes only from a date column; a count only from a list the page
 * itself proves complete; no yes/no, why, next/upcoming, time-of-day; masked, empty or titled-name values decline.
 */
import type { Crawler } from "./crawl.js";
import { Toolkit, type Row } from "./solver/toolkit.js";
import type { Entity } from "./solver/siteModel.js";
import { parseDate } from "./solver/dates.js";
import { extractSlots } from "./parse.js";
import { windowOf } from "./chartAnswers.js";
import { norm } from "./pageSnapshot.js";
import { providerAnswer, providerFormCue, dateTimeOn, dateTime, namedZone } from "./formFlags.js";
import { guard } from "./guards.js";

export type LookupOut = { answer: string } | { why: string };
export type LookupSpec = { patient: string; dob?: string; entity: Entity | "chart-fields" | "insurance-fields"; count: boolean; text: string };

const STOP = new Set(("a an the of for on in at to by with from and or is are was were be been it its this that what whats which who whom whose " +
  "when where did does do has have had please me give tell find look up show get need i we our us you your their they them his her he she s " +
  "patient patients chart charts record records file on there any about can could would kindly quick check per listed according shown").split(" "));
const COUNT = /\b(?:how many|number of|count of|count)\b/i;
const WHEN = /\b(?:when|what date|which date|what day|which day|date)\b/i;
const LAST = /\b(?:last|latest|most recent|newest|recent|recently)\b/i;
const FIRST = /\b(?:first|earliest|oldest)\b/i;
const NEVER = /^\s*(?:is|are|was|were|does|do|did|has|have|had|can|could|should|will|would)\b(?![^?]*\b(?:when|what|which|who|how many)\b)|\bwhy\b|\bhow (?:long|old|soon|much)\b|\bnext\b|\bupcoming\b|\bfuture\b|\bwhat time\b|\baverage\b|\btotal\b|\bsum\b|\baltogether\b|\bpercent/i;
const TITLED = /,\s*(?:MD|DO|NP|PA|PA-C|CNM|RN|DPM|DDS|PhD|LCSW|PT|OT)\b/;

/** Entity by the noun the question uses; chart-level label blocks for demographics / insurance. */
const NOUNS: Array<[LookupSpec["entity"], RegExp]> = [
  ["appointment", /\b(?:appointments?|visits?)\b/i],
  ["document", /\b(?:documents?|paperwork|reports?|letters?|forms?|summar(?:y|ies)|scans?)\b/i],
  ["invoice", /\b(?:invoices?|bills?)\b/i],
  ["problem", /\b(?:problems?|conditions?|diagnos[ie]s|onset|start(?:ed)?|beg[ia]n|begun|diagnosed)\b/i],
  ["activity", /\b(?:activity|user|staff user)\b|\bcreated (?:the |their |her |his )?(?:record|chart)\b/i],
  ["immunization", /\b(?:immuni[sz]ations?|vaccines?|vaccinations?|shots?|doses?)\b/i],
  ["allergy", /\b(?:allerg(?:y|ies)|allergic)\b/i],
  ["insurance-fields", /\b(?:insurance|insurer|payer|plan|member id|group number|subscriber)\b/i],
];
/** words that name a column without being its label */
const COL_SYN: Array<[RegExp, RegExp]> = [
  [/\b(?:start(?:ed)?|beg[ia]n|begun|diagnosed)\b/i, /^onset$/i],
  [/\b(?:come|came) in\b|\barrived?\b/i, /^received$/i],
  [/\b(?:type of visit|kind of visit|visit type)\b/i, /^(?:visit )?type$/i],
  [/\b(?:where)\b/i, /^location$/i],
];
const ENTITY_WORDS = /^(?:appointments?|visits?|documents?|paperwork|invoices?|bills?|problems?|conditions?|diagnos[ie]s|activity|immuni[sz]ations?|vaccines?|vaccinations?|shots?|doses?|allerg(?:y|ies)|insurance|insurer|list|on|file)$/;

/** A date as questions write it: ISO, month/day/year, "Mon D, YYYY" (capturing group 1). */
const DATE_SRC = "(\\d{4}-\\d{2}-\\d{2}|\\d{1,2}\\/\\d{1,2}\\/\\d{4}|[A-Z][a-z]{2,8}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4})";
const toks = (s: string) => norm(s).split(" ").filter(Boolean);
const stem = (w: string) => w.length > 3 ? w.replace(/(?:ies)$/, "y").replace(/(?:es|s)$/, "") : w;
const content = (s: string) => toks(s).filter((w) => !STOP.has(w));

/** Pure: what the question asks, or why it is not a lookup. */
export function lookupSpec(text: string): LookupSpec | { why: string } {
  const q = text.split("\n")[0].replace(/\bdate of birth\b:?/gi, "DOB");
  if (NEVER.test(q)) return { why: "lookup: yes/no, why, next, time, total or other derived question" };
  // a list question needs every item (the judge splits a string at commas): lookup answers one value, never a list
  // (Assumption Breaker seed 94631: "List the exact two names …" answered "Mara Vale,")
  if (/^\W*list\b|\blist\s+(?:the|all|each|every|of|them|their|any)\b|\b(?:two|three|four|five|both|all|each)\s+(?:of\s+(?:the|their)\s+)?(?:names|patients|providers|users|ids|dates|values|items)\b|\bnames\b/i.test(q)) return { why: "lookup: asks for a list (one value only)" };
  // a list cell "Sep 30, 2026, 2:20 PM MDT" answered as a bare date is the wrong form for "date and time" (guards.ts LOOKUP_TIME)
  if (guard("LOOKUP_TIME") && /\btime\b/i.test(q) && !dateTimeOn()) return { why: "lookup: the question asks for a time of day (a date-only answer would be the wrong form)" };
  const s = extractSlots(q.replace(/(\w)['’]s\b/g, "$1"));
  // "in Soto, Julia's chart (born …)": a "Last, First" pair the slot parser misses, only beside a stated DOB
  const lf = !s.patient && s.dob ? q.match(/\b([A-Z][\p{L}'’-]+),\s+([A-Z][\p{L}-]+)(?:['’]s)?\b/u) : null;
  if (lf) s.patient = `${lf[2]} ${lf[1]}`;
  if (!s.patient) return { why: "lookup: names no patient" };
  // a person's name has no digits ("Reserve P04974" is a label and a record id, not a name: Assumption Breaker sites)
  if (/\d/.test(s.patient)) return { why: "lookup: the named patient is not a person's name" };
  const hits = NOUNS.filter(([, re]) => re.test(q.replace(/\b(?:date of birth|born|DOB)\b/gi, " ")));
  // a problem verb ("start", "onset") names the problem list only when no other record kind is named
  let ents = [...new Set(hits.map(([e]) => e))];
  if (ents.length > 1 && ents.includes("problem") && !/\b(?:problems?|conditions?|diagnos[ie]s)\b/i.test(q)) ents = ents.filter((e) => e !== "problem");
  if (ents.length !== 1) return { why: `lookup: ${ents.length ? "several record kinds named (" + ents.join(", ") + ")" : "no record kind named"}` };
  return { patient: s.patient.replace(/['’]s\b/g, "").trim(), dob: s.dob, entity: ents[0], count: COUNT.test(q), text: q };
}

/** The question's words with the patient name, DOB and every date taken out. */
function residue(q: string, patient: string): string[] {
  const dateRe = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{4}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b|\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+\d{4}\b/gi;
  const name = new Set(toks(patient));
  return content(q.replace(dateRe, " ").replace(/\bD\.O\.B\.?/gi, " ").replace(/\b(?:date of birth|born|DOB)\b/gi, " ")).filter((w) => !name.has(w));
}

/** Pure: the answer from the rows of the entity's chart list. `explained` collects accounted words. */
export function answerFromRows(spec: LookupSpec, headers: string[], rows: Row[], proofStrength: "page" | "model"): LookupOut {
  const q = spec.text; const left = new Set(residue(q, spec.patient).map(stem));
  const explain = (s: string) => { for (const w of content(s)) left.delete(stem(w)); };
  for (const w of [...left]) if (ENTITY_WORDS.test(w)) left.delete(w);
  const qset = new Set(content(q).map(stem));
  const named = (v: string) => { const c = content(v).map(stem); return c.length > 0 && c.some((w) => w.length >= 3) && c.every((w) => qset.has(w)); };
  const dateCols = headers.filter((h) => /date|when|received|onset|issued|given|written|recorded|ordered|^time$/i.test(h));
  // 1. the answer column: a header the question names (or a synonym), else "when" → the one date column
  // a synonym of a DATE column ("diagnosed", "arrived") names that column only when the question asks when/what date: "what was X diagnosed
  // with first?" asks for the condition, not the onset date. (guards.ts LOOKUP_SYN_DATE)
  const syn = (h: string) => COL_SYN.some(([word, col]) => word.test(q) && col.test(h)) && (!guard("LOOKUP_SYN_DATE") || !dateCols.includes(h) || WHEN.test(q));
  let answerCol: string | undefined; const namedCols = headers.filter((h) => !/^actions?$/i.test(h) && (named(h) || syn(h)));
  // 2. filters: a categorical value the question names (all its words appear), never in the answer column
  let pool = rows.slice(); const used: string[] = []; const usedVals: string[] = [];
  for (const h of headers) {
    if (dateCols.includes(h) || /^actions?$/i.test(h)) continue;
    // categorical values and record numbers (5+ digits); never amounts, short numbers or dates
    const vals = [...new Set(rows.map((r) => r.cells[h] ?? "").filter((v) => v && (/^\d{5,}$/.test(v) || !/^\$?[\d.,]+$/.test(v)) && !parseDate(v)))];
    const hit = vals.filter(named);
    if (!hit.length) continue;
    const top = hit.filter((v) => !hit.some((o) => o !== v && content(o).length > content(v).length && content(v).every((w) => content(o).includes(w))));
    if (top.length > 1) return { why: `lookup: the question names ${top.length} values of ${h} (${top.join(" | ")})` };
    pool = pool.filter((r) => r.cells[h] === top[0]); used.push(h); usedVals.push(top[0]); explain(top[0]);
  }
  // The chart's activity log gets a row for every chart OPEN, including ours (getPatient opened this chart a moment ago): a count,
  // a last/first or a "who" over unfiltered or "opened" rows reads our own footprint. Only an entry kind our opens cannot be
  // (created the record, changed the phone number…) is safe to answer from. (guards.ts LOOKUP_ACTIVITY)
  if (spec.entity === "activity" && guard("LOOKUP_ACTIVITY")) {
    const wh = headers.find((h) => /^(?:what|what changed|action|change|event)$/i.test(h.trim()));
    const kind = wh && used.includes(wh) ? usedVals[used.indexOf(wh)] : "";
    if (!kind || /\b(?:open(?:ed|ing)?|view(?:ed)?|access(?:ed)?|read|look(?:ed)?)\b/i.test(kind)) return { why: "lookup: activity-log rows without a named entry kind (or the 'opened' kind) include our own chart opens" };
  }
  // a header that is only the record's own noun ("Invoice" for an invoice question) is the answer only when nothing else is named
  const cand0 = namedCols.filter((h) => !used.includes(h));
  const cand = cand0.some((h) => !content(h).every((w) => ENTITY_WORDS.test(w))) ? cand0.filter((h) => !content(h).every((w) => ENTITY_WORDS.test(w))) : cand0;
  if (spec.count) answerCol = undefined;
  else if (cand.length === 1) answerCol = cand[0];
  else if (cand.length > 1) { const best = cand.filter((h) => !cand.some((o) => o !== h && content(o).length > content(h).length && content(h).every((w) => content(o).includes(w)))); if (best.length !== 1) return { why: `lookup: names several columns (${cand.join(" | ")})` }; answerCol = best[0]; }
  else if (WHEN.test(q)) { if (dateCols.length !== 1) return { why: `lookup: "when" with ${dateCols.length} date columns (${dateCols.join(" | ")})` }; answerCol = dateCols[0]; }
  else if (/\bwho\b|\bwhich user\b/i.test(q)) { const p = headers.filter((h) => /^(?:user|by|provider|author|given by|written by)$/i.test(h)); if (p.length !== 1) return { why: "lookup: who — no single person column" }; answerCol = p[0]; }
  if (!spec.count && !answerCol) return { why: `lookup: no column named (headers ${headers.join(" | ")})` };
  if (answerCol) explain(answerCol);
  for (const h of namedCols) explain(h);
  for (const [word] of COL_SYN) { const m = q.match(word); if (m) explain(m[0]); }
  const win = windowOf(q);
  if (win === null) return { why: "lookup: a time window it cannot read" };
  // 3. a date in the question selects rows on the date column only as "on <date>" / "dated <date>"; any other
  // date that is not the DOB declines (practice held-out: an unread "date of birth 08/04/1999" counted 0 rows)
  const DATE = DATE_SRC;
  const onDates = [...q.matchAll(new RegExp(`\\b(?:on|dated)\\s+(?:the\\s+)?${DATE}`, "g"))].map((m) => parseDate(m[1])).filter(Boolean) as string[];
  const allDates = [...q.matchAll(new RegExp(DATE, "g"))].map((m) => parseDate(m[1])).filter((d) => d && d !== spec.dob) as string[];
  if (!win && allDates.some((d) => !onDates.includes(d))) return { why: "lookup: a date that is neither the DOB nor \"on <date>\"" };
  const dq = [...new Set(onDates)].filter((d) => d !== spec.dob);
  const dcol = dateCols.length === 1 ? dateCols[0] : dateCols.find((h) => h !== answerCol && dateCols.length === 2 && /date and time|^date$|received|when/i.test(h));
  const dOf = (r: Row) => dcol ? parseDate((r.cells[dcol] ?? "").split(/,\s*\d{1,2}:\d{2}/)[0]) : undefined;

  if (dq.length || win || LAST.test(q) || FIRST.test(q)) {
    if (!dcol) return { why: "lookup: a date or order with no single date column" };
    if (pool.some((r) => !dOf(r))) return { why: `lookup: a row with no readable ${dcol}` };
  }
  if (win) { pool = pool.filter((r) => dOf(r)! >= win.from && dOf(r)! <= win.to); for (const y of new Set([win.from.slice(0, 4), win.to.slice(0, 4)])) left.delete(y); for (const w of ["in", "during", "between", "from", "to", "and", "through", "inclusive", "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december", "year"]) left.delete(w); }
  else if (dq.length > 1) return { why: "lookup: several dates" };
  else if (dq.length === 1) pool = pool.filter((r) => dOf(r) === dq[0]);
  if (spec.count) {
    if (proofStrength !== "page") return { why: "lookup: count over a list the page does not prove complete" };
    for (const w of ["how", "many", "number", "count"]) left.delete(w);
    if (left.size) return { why: `lookup: words not accounted for: ${[...left].join(", ")}` };
    return { answer: String(pool.length) };
  }
  for (const w of ["when", "who", "user", "date", "day", "most", "recent", "recently", "last", "latest", "newest", "first", "earliest", "oldest", "where"]) left.delete(w);
  if (left.size) return { why: `lookup: words not accounted for: ${[...left].join(", ")}` };
  if (LAST.test(q) || FIRST.test(q)) {
    if (LAST.test(q) && FIRST.test(q)) return { why: "lookup: both first and last" };
    if (!pool.length) return { why: "lookup: no row left to order" };
    const sorted = pool.slice().sort((a, b) => dOf(a)!.localeCompare(dOf(b)!));
    const edge = LAST.test(q) ? dOf(sorted[sorted.length - 1])! : dOf(sorted[0])!;
    pool = sorted.filter((r) => dOf(r) === edge);
    // "last / first appointment" with no status named: the newest row may be a booked (future), cancelled or missed one, and whether
    // "last" means that row or the last visit that happened is the asker's. Answer only when both readings agree: the edge row is a
    // Completed visit. (chartAnswers.ts makes the same demand: an extreme needs a named status.) (guards.ts LOOKUP_EDGE)
    if (spec.entity === "appointment" && guard("LOOKUP_EDGE")) {
      const sc = headers.find((h) => /^status$/i.test(h.trim()));
      if (sc && !used.includes(sc) && pool.some((r) => !/^completed$/i.test((r.cells[sc] ?? "").trim()))) return { why: "lookup: the first/last appointment is not a Completed visit and the question names no status (which one 'last' means is ambiguous)" };
    }
  }
  const vals = [...new Set(pool.map((r) => (r.cells[answerCol!] ?? "").trim()))];
  if (pool.length === 0) return { why: "lookup: no row matches" };
  // "the appointment on <date>" is one row; only a first / last tie may hold several rows that agree
  if (!(LAST.test(q) || FIRST.test(q)) && pool.length !== 1) return { why: `lookup: ${pool.length} rows match` };
  if (vals.length !== 1) return { why: `lookup: ${pool.length} rows with different ${answerCol}` };
  return finish(vals[0], dateCols.includes(answerCol!), q);
}

/** Pure: a label → value answer from a chart page's label blocks (demographics, insurance). */
export function answerFromBlocks(spec: LookupSpec, blocks: Array<{ heading: string; pairs: Array<[string, string]> }>): LookupOut {
  const q = spec.text; const left = new Set(residue(q, spec.patient).map(stem));
  const qset = new Set(content(q).map(stem));
  const named = (v: string) => { const c = content(v).map(stem); return c.length > 0 && c.every((w) => qset.has(w)); };
  // The insurance page shows the coverage on file NOW. A question about a date other than the DOB ("who covered X on 2025-05-01") or a
  // past / former coverage would be answered with today's payer. (guards.ts LOOKUP_INS_DATE)
  if (guard("LOOKUP_INS_DATE")) {
    const other = [...q.matchAll(new RegExp(DATE_SRC, "g"))].map((m) => parseDate(m[1])).filter((d) => d && d !== spec.dob);
    if (other.length || /\b(?:previous(?:ly)?|prior|former(?:ly)?|old|older|earlier|before|after|since|until|ended|expired|terminated|lapsed|inactive|used to|at the time)\b/i.test(q)) return { why: "lookup: the insurance page shows today's coverage; the question is about another date or a past coverage" };
  }
  const labels = [...new Set(blocks.flatMap((b) => b.pairs.map((p) => p[0])))].filter(named);
  const top = labels.filter((l) => !labels.some((o) => o !== l && content(o).length > content(l).length && content(l).every((w) => content(o).includes(w))));
  if (top.length !== 1) return { why: `lookup: ${top.length} labels named (${top.join(" | ") || "none"})` };
  let bs = blocks.filter((b) => b.pairs.some((p) => p[0] === top[0]));
  const byHead = bs.filter((b) => content(b.heading).some((w) => qset.has(stem(w)) && !/^(?:insurance|coverage)$/.test(w)));
  if (byHead.length) { bs = byHead; for (const b of byHead) for (const w of content(b.heading)) left.delete(stem(w)); }
  const vals = [...new Set(bs.flatMap((b) => b.pairs.filter((p) => p[0] === top[0]).map((p) => p[1].trim())))];
  if (vals.length !== 1) return { why: `lookup: "${top[0]}" shows ${vals.length} values across blocks` };
  for (const w of content(top[0])) left.delete(stem(w));
  for (const w of ["insurance", "insurer", "on", "file", "what", "which", "who", "plan", "payer", "cover", "covers", "covered", "covering"]) left.delete(stem(w));
  if (left.size) return { why: `lookup: words not accounted for: ${[...left].join(", ")}` };
  return finish(vals[0], false, q);
}

function finish(v: string, isDate: boolean, q = ""): LookupOut {
  if (!v || /^(?:—|-|–|n\/a|none|not on file|unknown)$/i.test(v)) return { why: "lookup: the value is empty" };
  if (/[•*]{2,}/.test(v)) return { why: "lookup: the value is masked" };
  if (TITLED.test(v)) { // a name shown with a title: AGENT_FORM_PROVIDER decides the form (off = decline)
    const r = providerAnswer(v, providerFormCue(q)); return "answer" in r ? r : { why: "lookup: a name shown with a title (form not provable)" };
  }
  // practice: member IDs drawn in a scrambled font carry decoy digits the DOM read cannot tell apart (3 wrong)
  if (!isDate && /\d/.test(v)) return { why: "lookup: a value with digits (may be drawn in a scrambled font)" };
  if (isDate) {
    const head = v.split(/,\s*\d{1,2}:\d{2}/)[0], d = parseDate(head);
    if (!d) return { why: `lookup: date cell not readable: ${v}` };
    const dt = dateTimeOn() ? dateTime(d, v.slice(head.length), namedZone(q)) : undefined; // AGENT_FORM_DATETIME: the cell's clock time rides along
    return { answer: dt ?? d };
  }
  return { answer: v };
}

/** Does the appointments tab show a recurring series? (`links`: anchors to /recurring/… on the page.) Unreadable text counts as yes. */
export function hasRecurringSeries(text: string, links: number): boolean {
  if (links > 0) return true;
  if (!text) return true;
  if (/\b0 recurring appointments?\b/i.test(text)) return false;
  return /\brecurring appointments?\b/i.test(text) || /^\s*every\s+\d*\s*(?:weeks?|days?|months?|years?|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/im.test(text);
}

/** Live: resolve the patient, read the one chart list (or label blocks), answer or decline. */
export async function lookup(text: string, crawler: Crawler, budgetMs = 15000, log: (r: Record<string, unknown>) => void = (r) => { try { process.stdout.write(JSON.stringify(r) + "\n"); } catch {} }, opts: { isProvider?: (name: string) => boolean } = {}): Promise<LookupOut> {
  const t0 = Date.now(); const spec = lookupSpec(text);
  const done = (out: LookupOut, extra: Record<string, unknown> = {}) => { log({ event: "lookup", ms: Date.now() - t0, entity: "why" in spec ? null : spec.entity, ...extra, ...out }); return out; };
  if ("why" in spec) return done(spec);
  // A name with no DOB that is also a clinic provider ("How many appointments did Hannah Ramos have …": a provider written without
  // the credential) may be a patient namesake of the provider: the question is then about the provider, not that chart. (guards.ts LOOKUP_PROVIDER)
  if (!spec.dob && guard("LOOKUP_PROVIDER") && opts.isProvider?.(spec.patient)) return done({ why: "lookup: the named person without a DOB is also a provider of the clinic" });
  const tk = new Toolkit(crawler);
  const p = await tk.getPatient(spec.patient, spec.dob);
  if (!p.ok) return done({ why: "lookup: " + p.why });
  if (spec.entity === "insurance-fields" || spec.entity === "chart-fields") {
    const href = p.value.href.replace(/\/$/, "") + (spec.entity === "insurance-fields" ? "/insurance" : "");
    if (!(await crawler.navTo(href, /\S{3}/, 12000, true).catch(() => false))) return done({ why: `lookup: ${href} did not load` });
    const r = await tk.settled().catch(() => null);
    if (!r) return done({ why: "lookup: page not readable" });
    if (r.gates.length) return done({ why: "lookup: restricted chart" });
    if (r.tables.length) return done({ why: "lookup: insurance shown as a table (coverage list), not label blocks" });
    return done(answerFromBlocks(spec, r.dls.map((d) => ({ heading: d.heading, pairs: d.pairs as Array<[string, string]> }))));
  }
  const l = await tk.listEntities(spec.entity, "patient", {}, { patientHref: p.value.href, budgetMs: Math.max(3000, budgetMs - (Date.now() - t0)) });
  if (!l.ok) return done({ why: "lookup: " + l.why });
  // A chart's Appointments tab lists one-off appointments in its table and recurring series ("Every 2 weeks on Friday … 1 recurring
  // appointment", links /recurring/…) in a block above it: the occurrences are appointments too (crawl.fetchAppointments expands them)
  // but no row of the table. A count, an edge or a date over the table alone is wrong for such a chart (5 of 36 practice charts).
  if (spec.entity === "appointment" && guard("LOOKUP_RECURRING")) {
    const rec = await crawler.evalApp<{ links: number; text: string }>(`return { links: doc.querySelectorAll('a[href*="/recurring/"]').length, text: (doc.body?doc.body.innerText:'')||'' };`).catch(() => null);
    if (!rec) return done({ why: "lookup: the appointments page could not be re-read for recurring series" });
    if (hasRecurringSeries(rec.text, rec.links)) return done({ why: "lookup: the chart has recurring appointment series (their occurrences are not rows of the table)" });
  }
  return done(answerFromRows(spec, l.value.headers, l.value.rows, l.proof.strength), { rows: l.value.rows.length, proof: l.proof.strength });
}
