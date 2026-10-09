/**
 * Readers for the filing-deadline and good-faith-estimate families.
 *
 * Pure parsers (exported, tested in familyReaders.test.ts against the captured Set 1 markup and
 * against layout variants) + the live navigation that feeds them (readFiling / readGoodFaith, used by
 * index-builder). Rules:
 *  - pages are read by section heading and column LABEL (synonyms tolerated), never class or index;
 *  - the rule (today, office holidays, business-day bands, answer tokens) comes from the governing
 *    message (parseFilingPolicy / parseGoodFaithPolicy), not from constants;
 *  - anything unexpected → `{ decline: why }`; a skip is 0, a wrong answer −1.
 *
 * Why this exists (151 vs 158 run diff): the 151 image's good-faith reader read only the FIRST page
 * of the chart's notes (10 of n) with a narrow self-pay regex before answering NOT_REQUIRED:INSURED,
 * read one year of the clinic calendar with a fixed 500 ms wait after changing the page size (98
 * entries/year, 25 per page by default), matched the appointment by date alone and took the location
 * from column 4. Its filing reader found the not-yet-filed row by keyword-guessing the payer cell and
 * then looked up the payer link before the payers list had rendered (marker "Payer" was already on the
 * insurance page), so every filing task skipped.
 */
import type { Crawler } from "./crawl.js";
import type { FilingTerms } from "./filingDeadline.js";
import { todayIn, paragraphsIn } from "./policyText.js";
import { SNAPSHOT_JS, type Snapshot, type Table, type Cell, col, norm, sectionsBy, tablesUnder, dlValue, pagerOf, datesIn, oneDate, timeIn, tzFamily, monthDaysIn, MONTH_NAMES } from "./pageSnapshot.js";
import { isComplete } from "./listFooter.js";
import { onDrop } from "./readCache.js";

export type Decline = { decline: string };
export const isDecline = (x: unknown): x is Decline => !!x && typeof x === "object" && "decline" in (x as any);
const D = (why: string): Decline => ({ decline: why });

// ════════════════════════════ governing messages ════════════════════════════

export type FilingPolicy = { todayISO: string; closedISO: string[]; weekendsClosed: boolean };
/** Is this message the filing-deadline policy? (paraphrase-tolerant signature) */
export const isFilingPolicy = (raw: string) => /\bfil(e|ing)\b/i.test(raw) && /(deadline|last day)/i.test(raw) && /\boriginal\b/i.test(raw) && /\bsecondary\b/i.test(raw) && /\bcorrected\b/i.test(raw);
/** The filing rule field by field. A field the message doesn't state clearly is absent and `why` says
 *  why; the solver declines only the answers that need it (NO_FILING_TERMS / AWAITING_PRIMARY need
 *  just their token; a date or EXPIRED needs today, the closures, the roll direction and the anchors). */
export type FilingFields = { todayISO?: string; closedISO?: string[]; weekendsClosed?: boolean; roll?: "earlier" | "later"; anchors?: boolean; tokens: string[] };
export function parseFilingFields(raw: string): { fields: FilingFields; why: string[] } {
  const why: string[] = []; const f: FilingFields = { tokens: ["NO_FILING_TERMS", "AWAITING_PRIMARY", "EXPIRED:"].filter((t) => raw.includes(t)) };
  if (f.tokens.length < 3) why.push(`answer token(s) ${["NO_FILING_TERMS", "AWAITING_PRIMARY", "EXPIRED:"].filter((t) => !f.tokens.includes(t)).join(", ")} not in the message`);
  // Every "Today is <date>" (or a rewording) in the message must name the same date.
  const today = todayIn(raw);
  if (today) f.todayISO = today; else why.push(today === null ? "'Today is' dates disagree or are unreadable" : "no 'Today is <date>' in the message");
  // The office closures: the ONE paragraph naming holidays and closed days (never a whole message or
  // section, whose example and counting dates are not closures).
  const units = paragraphsIn(raw).filter((p) => /holiday/i.test(p) && /\bclosed?\b|\bclosures?\b/i.test(p) && datesIn(p).length);
  if (units.length !== 1) why.push(units.length ? "two paragraphs list office closures" : "no office closures/holidays paragraph");
  else if (/\bfor example\b|\be\.g\.|\bexample\b|\bwould be\b|\bfrom \S+ is\b/i.test(units[0])) why.push("the closures paragraph also carries example dates");
  else {
    f.closedISO = [...new Set(datesIn(units[0]))].sort();
    if (/saturdays?\b[\s\S]{0,60}\bsundays?\b|\bweekends?\b/i.test(units[0])) f.weekendsClosed = true; else why.push("weekend rule not stated");
  }
  // Which way a closed last day moves: the engine implements "nearest earlier open day, never later".
  const s = raw.replace(/\s+/g, " ");
  const earlier = /nearest earlier|earlier (?:open )?day|previous (?:open|business) day|(?:closest|nearest|last) (?:open|business) day before|day before it|never (?:moves?|(?:be |is |gets )?(?:moved|pushed))[^.]{0,25}\blater\b|moves? (?:back|earlier)/i.test(s);
  const later = /next (?:open |business )?day(?: it'?s open| the office is open)?|following (?:open |business )?day|moves? (?:forward|later)|never (?:moves?|(?:be |is |gets )?(?:moved|pushed))[^.]{0,25}\bearlier\b/i.test(s.replace(/never (?:moves?|(?:be |is |gets )?(?:moved|pushed))[^.]{0,25}\blater\b/gi, ""));
  if (earlier && !later) f.roll = "earlier"; else if (later && !earlier) f.roll = "later";
  if (f.roll !== "earlier") why.push(f.roll ? "a closed last day moves later (not implemented)" : "roll direction for a closed last day not stated");
  if (/primary payer'?s remittance/i.test(raw) && /remittance for the original claim|original claim'?s remittance/i.test(raw)) f.anchors = true; else why.push("Secondary/Corrected counting anchors not as expected");
  return { fields: f, why };
}
/** What a filing answer needs from the message (null = everything it needs was given). */
export function filingNeeds(answer: string, f: FilingFields, type: string): string | null {
  if (answer === "NO_FILING_TERMS" || answer === "AWAITING_PRIMARY") return f.tokens.includes(answer) ? null : `answer token ${answer} not in the message`;
  const miss = [!f.todayISO && "today", !f.closedISO && "office closures", !f.weekendsClosed && "weekend rule", f.roll !== "earlier" && "roll direction",
    type !== "Original" && !f.anchors && "counting anchors", answer.startsWith("EXPIRED:") && !f.tokens.includes("EXPIRED:") && "EXPIRED token"].filter(Boolean);
  return miss.length ? `the answer needs ${miss.join(", ")}, which the message does not give clearly` : null;
}
export function parseFilingPolicy(raw: string): FilingPolicy | Decline {
  if (!isFilingPolicy(raw)) return D("filing policy: message is not the filing-deadline rule");
  const { fields: f, why } = parseFilingFields(raw);
  if (why.length) return D("filing policy: " + why[0]);
  return { todayISO: f.todayISO!, closedISO: f.closedISO!, weekendsClosed: f.weekendsClosed! };
}
/** Later messages that could change a filing deadline (a payer limit note, an office closure). */
export function filingAmendmentBlocks(later: string[], payer: string): string | null {
  for (const m of later) {
    if (isGoodFaithPolicy(m) || isFilingPolicy(m)) continue; // another family's rule ("no insurance on file") is not a filing note
    const filingish = /\bfiling (limits?|deadlines?|terms|windows?|rules?)\b|\bfile (a |the |an |original |secondary |corrected )*claims?\b|\bclaims? (must|can|may|should|have to) be (filed|sent|submitted)\b|\baccepts? (original |secondary |corrected |new )*claims\b|\btimely filing\b|\blast day to file\b/i.test(m);
    const officeClosed = /billing office/i.test(m) && /(closed|closure|holiday)/i.test(m);
    if (officeClosed) return `a later message changes billing-office closures: "${m.slice(0, 60)}"`;
    if (filingish && (norm(m).includes(norm(payer)) || !/\b(health|plan|care|fund|medicare|medicaid|assistance|mutual|advantage|insurance)\b/i.test(m)))
      return `a later message may amend filing limits for ${payer}: "${m.slice(0, 60)}"`;
  }
  return null;
}

export type GoodFaithBand = { min: number; max: number; due: "short" | number }; // due = nth business day after scheduling
export type GoodFaithPolicy = { bands: GoodFaithBand[] };
export const isGoodFaithPolicy = (raw: string) => /good faith estimate/i.test(raw) && /business days?/i.test(raw) && /scheduling date|scheduled|booked/i.test(raw);
const ORD: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
const ordinal = (w: string) => ORD[w.toLowerCase()] ?? (/^\d+(st|nd|rd|th)$/i.test(w) ? parseInt(w) : 0);
/** The good-faith rule field by field: NOT_REQUIRED:INSURED needs only its token; a due date or
 *  SHORT_NOTICE needs the counting window, the closures definition and the bands. */
export type GoodFaithFields = { tokens: string[]; window?: boolean; closuresDef?: boolean; bands?: GoodFaithBand[] };
export function parseGoodFaithFields(raw: string): { fields: GoodFaithFields; why: string[] } {
  const why: string[] = []; const f: GoodFaithFields = { tokens: ["NOT_REQUIRED:INSURED", "NOT_REQUIRED:SHORT_NOTICE"].filter((t) => raw.includes(t)) };
  if (f.tokens.length < 2) why.push("an answer token is not in the message");
  if (/(don'?t|do not) count the scheduling date|after the scheduling date|leave out the scheduling date/i.test(raw) && /including the appointment date|through the appointment date|up to and including/i.test(raw)) f.window = true; else why.push("business-day counting window not as expected");
  if (/\bActive\b/.test(raw) && /clinic calendar/i.test(raw)) f.closuresDef = true; else why.push("closures not defined by Active clinic-calendar entries");
  const b = goodFaithBands(raw); if ("decline" in b) why.push(b.decline.replace(/^good-faith policy: /, "")); else f.bands = b.bands;
  return { fields: f, why };
}
export function goodFaithNeeds(answer: string, f: GoodFaithFields): string | null {
  if (answer === "NOT_REQUIRED:INSURED") return f.tokens.includes(answer) ? null : "answer token NOT_REQUIRED:INSURED not in the message";
  const miss = [!f.window && "counting window", !f.closuresDef && "closures definition", !f.bands && "business-day bands", answer === "NOT_REQUIRED:SHORT_NOTICE" && !f.tokens.includes(answer) && "SHORT_NOTICE token"].filter(Boolean);
  return miss.length ? `the answer needs ${miss.join(", ")}, which the message does not give clearly` : null;
}
export function parseGoodFaithPolicy(raw: string): GoodFaithPolicy | Decline {
  if (!isGoodFaithPolicy(raw)) return D("good-faith policy: message is not the good-faith rule");
  const { fields: f, why } = parseGoodFaithFields(raw);
  if (why.length) return D("good-faith policy: " + why[0]);
  return { bands: f.bands! };
}
function goodFaithBands(raw: string): GoodFaithPolicy | Decline {
  const bands: GoodFaithBand[] = [];
  const range = String.raw`(\d+)\s*(?:to|-|–|through)\s*(\d+)\s+business days?`;
  const short = raw.match(new RegExp(range + String.raw`[^\n]{0,40}NOT_REQUIRED:SHORT_NOTICE`, "i"));
  if (short) bands.push({ min: +short[1], max: +short[2], due: "short" });
  for (const m of raw.matchAll(new RegExp(range + String.raw`[^\n]{0,80}?due on the (\w+) business day after the scheduling date`, "gi"))) bands.push({ min: +m[1], max: +m[2], due: ordinal(m[3]) });
  for (const m of raw.matchAll(/(\d+) or more business days?[^\n]{0,80}?due on the (\w+) business day after the scheduling date/gi)) bands.push({ min: +m[1], max: Infinity, due: ordinal(m[2]) });
  bands.sort((a, b) => a.min - b.min);
  if (bands.length < 2 || bands[0].min !== 0 || bands.some((b) => b.due === 0) || bands.at(-1)!.max !== Infinity) return D("good-faith policy: business-day bands not parsed");
  for (let i = 1; i < bands.length; i++) if (bands[i].min !== bands[i - 1].max + 1) return D("good-faith policy: business-day bands are not contiguous");
  return { bands };
}
/** Later messages that could change a good-faith answer (a closure, a self-pay note, a rule change). */
export function goodFaithAmendmentBlocks(later: string[]): string | null {
  for (const m of later) if (/good faith|self-?pay|\bclos(ed|ure|ing)\b|holiday|business days?|clinic calendar/i.test(m)) return `a later message may change the good-faith rule or closures: "${m.slice(0, 60)}"`;
  return null;
}

// ════════════════════════════ filing: pure parsers ════════════════════════════

const cellDate = (c: Cell | undefined): string | null => {
  if (!c) return null;
  if (c.obf) { const t = c.times.filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)); return t.length === 1 ? t[0] : null; } // scrambled digits: only a date-only datetime attribute is trusted
  return oneDate(c.text);
};

export type NotYetFiled = { type: "Original" | "Secondary" | "Corrected"; payer: string; remitISO: string | null };
/** The insurance tab's not-yet-filed list → the claim with this date of service. */
export function parseNotYetFiled(s: Snapshot, dosISO: string): NotYetFiled | Decline {
  const NYF = /not yet (filed|billed|sent|submitted)|unfiled|waiting to be filed|to be filed|claims to file/;
  const secs = sectionsBy(s, NYF);
  if (!secs.length) return D("filing: the chart's insurance page has no not-yet-filed claims section");
  const tables = tablesUnder(s, NYF);
  if (!tables.length) return D(secs.some((x) => /no claims|nothing|none/i.test(x.text)) ? "filing: the not-yet-filed list is empty" : "filing: not-yet-filed section has no table");
  if (tables.length > 1) return D("filing: several tables under the not-yet-filed heading");
  const t = tables[0];
  // A column that names the date of service wins; the generic labels (Service / Visit / Date) are only a
  // fallback — the Set 1 list has both "Date of service" and "Visit" (run 146: 11 filing skips).
  const DOS_AVOID = [/remit|primary|original|received|arriv|created|added/];
  let iDos = col(t.headers, [/date of service|service date|\bdos\b|visit date|date of visit/], DOS_AVOID);
  if (iDos === -1) iDos = col(t.headers, [/^service$|^visit$|^date$/], DOS_AVOID);
  const iType = col(t.headers, [/^type$|claim type|^kind$|^claim kind$/]);
  const iPayer = col(t.headers, [/payer|billed to|bill to|insurer|^insurance$/], [/primary payer.*remit|remit/]);
  if (iDos < 0 || iType < 0 || iPayer < 0) return D(`filing: not-yet-filed columns not recognised (${t.headers.join(" | ") || "no headers"})`);
  const rows = t.rows.filter((r) => cellDate(r[iDos]) === dosISO);
  if (!rows.length) return D(`filing: no not-yet-filed claim with service date ${dosISO} (${t.rows.length} rows)`);
  // Several rows on that date: only harmless if they agree on everything but an id-like number.
  const keyOf = (r: Cell[]) => r.filter((c) => !/^\d{5,}$/.test(c.text.trim())).map((c) => norm(c.text)).join("|");
  if (new Set(rows.map(keyOf)).size > 1) return D(`filing: ${rows.length} not-yet-filed claims share service date ${dosISO}`);
  const r = rows[0];
  const typeTxt = norm(r[iType]?.text ?? "");
  const types = ["original", "secondary", "corrected"].filter((k) => new RegExp(`\\b${k}\\b`).test(typeTxt));
  if (types.length !== 1 || typeTxt.replace(/\b(original|secondary|corrected|claim)\b/g, "").trim()) return D(`filing: claim type "${r[iType]?.text}" not one of Original/Secondary/Corrected`);
  const type = (types[0][0].toUpperCase() + types[0].slice(1)) as NotYetFiled["type"];
  const payer = (r[iPayer]?.text ?? "").split(/\s+[·•|]\s+/)[0].trim();
  if (!payer || /^(none|n\/?a|—|-)$/i.test(payer)) return D("filing: the claim's payer cell is empty");
  let remitISO: string | null = null;
  if (type !== "Original") {
    // The message: a Secondary claim shows when the PRIMARY payer's remittance arrived, a Corrected claim when
    // the ORIGINAL claim's remittance arrived. A list with one column per anchor ("Primary payer remittance",
    // "Original claim remittance", Set 1) is read in the column of this claim's type; otherwise one remittance column.
    const REM = String.raw`.*(remit|eob|paid|payment|received|arriv)`;
    const typed = col(t.headers, [new RegExp((type === "Secondary" ? "primary" : "original") + REM)]);
    const other = col(t.headers, [new RegExp((type === "Secondary" ? "original" : "primary") + REM)]);
    if (typed === -2) return D(`filing: several ${type === "Secondary" ? "primary" : "original"}-remittance columns`);
    const iRemit = typed >= 0 ? typed : other >= 0 ? -3 : col(t.headers, [/remit|primary.*(paid|received|arriv)|original.*(paid|received|arriv)|eob|arrived|received/]);
    if (iRemit === -3) return D(`filing: ${type} claim but only a ${type === "Secondary" ? "original" : "primary"}-remittance column`);
    if (iRemit === -2) return D("filing: several remittance-date columns");
    const pool = iRemit >= 0 ? [r[iRemit]] : r.filter((_, i) => i !== iDos && i !== iPayer && !/^\d{5,}$/.test(r[i]?.text ?? ""));
    const txt = pool.map((c) => c?.text ?? "").join(" ");
    if (pool.some((c) => c?.obf)) { const d = pool.flatMap((c) => c?.times ?? []).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)); if (d.length !== 1) return D("filing: remittance date drawn in scrambled digits"); remitISO = d[0]; }
    else {
      const ds = [...new Set(datesIn(txt))];
      if (ds.length === 1) remitISO = ds[0];
      else if (ds.length === 0 && /(not (yet )?(been )?received|hasn'?t (been )?(received|arrived)|has not (been )?(received|arrived)|awaiting|pending|not arrived|none yet|not in yet)/i.test(txt)) remitISO = null;
      else return D(`filing: ${type} claim's remittance cell unreadable ("${txt.slice(0, 60)}")`);
    }
    if (remitISO && remitISO < dosISO) return D(`filing: remittance date ${remitISO} is before the date of service`);
  }
  return { type, payer, remitISO };
}

type Limit = { days?: number; months?: number; none?: true };
/** "150 days from the date of service" → {days:150}; "6 months …" → {months:6}. Any other unit/anchor → null. */
export function parseLimit(cell: string, kind: "original" | "secondary" | "corrected"): Limit | null {
  const t = norm(cell);
  if (!t || /^(none|n a|na|not accepted|not applicable|no limit|not on file)$/.test(t)) return { none: true };
  const m = t.match(/^(\d+)\s*(calendar\s+)?(days?|months?)\b\s*(.*)$/);
  if (!m) return null;
  const rest = m[4];
  if (/business|working|year/.test(rest)) return null;
  if (rest) {
    if (!/^(from|after)\b/.test(rest)) return null;
    const ok = kind === "original" ? /date of service|service date|\bdos\b|visit/ : kind === "secondary" ? /primary/ : /original/;
    if (!ok.test(rest) || (kind !== "original" && !/remit|eob|payment|paid/.test(rest))) return null;
  }
  const n = +m[1];
  if (/month/.test(m[3])) return kind === "original" ? { months: n } : null;
  return { days: n };
}
/** The payer page's claim-filing terms table → every set (Effective + three limits). */
export function parseFilingTermsPage(s: Snapshot, payer: string): FilingTerms[] | Decline {
  if (norm(s.h1) && !norm(s.h1).includes(norm(payer)) && !norm(s.text).slice(0, 400).includes(norm(payer))) return D(`filing: payer page is not ${payer} (h1 "${s.h1}")`);
  const CF = /claim filing|filing (terms|limits?|rules)|timely filing/;
  const secs = sectionsBy(s, CF).filter((x) => CF.test(norm(x.heading)));
  if (!secs.length) return D(`filing: ${payer} page has no claim-filing section`);
  const tables = tablesUnder(s, CF);
  if (!tables.length) {
    const own = secs.sort((a, b) => b.level - a.level)[0];
    return /\bno\b.*\b(terms|filing|limits?)\b|none on file/i.test(own.text) ? [] : D(`filing: ${payer} claim-filing section has no table and no empty-state`);
  }
  if (tables.length > 1) return D(`filing: ${payer} has several claim-filing tables`);
  const t = tables[0];
  const iEff = col(t.headers, [/effective|in effect|^from$|start|as of|took effect/]);
  const iO = col(t.headers, [/original|initial|first claim/]), iS = col(t.headers, [/secondary/]), iC = col(t.headers, [/corrected|replacement|resubmi/]);
  if (iEff < 0 || iO < 0 || iS < 0 || iC < 0) return D(`filing: ${payer} claim-filing columns not recognised (${t.headers.join(" | ")})`);
  const iEnd = col(t.headers, [/\b(end|ends|ended|through|until|expires?|expired|to)\b/]);
  const out: FilingTerms[] = [];
  for (const r of t.rows) {
    if (iEnd >= 0 && !/^(|none|—|-|n a|ongoing|current)$/.test(norm(r[iEnd]?.text ?? ""))) return D(`filing: ${payer} terms carry an end date ("${r[iEnd]?.text}")`);
    const eff = cellDate(r[iEff]); if (!eff) return D(`filing: ${payer} terms row without a readable effective date ("${r[iEff]?.text}")`);
    if ([iO, iS, iC].some((i) => r[i]?.obf)) return D(`filing: ${payer} limits drawn in scrambled digits`);
    const o = parseLimit(r[iO]?.text ?? "", "original"), sc = parseLimit(r[iS]?.text ?? "", "secondary"), co = parseLimit(r[iC]?.text ?? "", "corrected");
    if (!o || !sc || !co) return D(`filing: ${payer} limit not understood ("${[r[iO]?.text, r[iS]?.text, r[iC]?.text].join(" / ").slice(0, 120)}")`);
    out.push({ effectiveISO: eff, originalDays: o.days, originalMonths: o.months, secondaryDays: sc.days, correctedDays: co.days });
  }
  const effs = out.map((x) => x.effectiveISO);
  if (new Set(effs).size !== effs.length) return D(`filing: ${payer} has two terms sets with the same effective date`);
  return out;
}

// ════════════════════════════ good faith: pure parsers ════════════════════════════

/** Insurance tab → is the chart registered with insurance (payer/plan/member ID) or "No insurance on file"? */
export function parseInsuranceStatus(s: Snapshot): { insured: boolean; payer?: string } | Decline {
  const prim = s.sections.filter((x) => /primary (insurance|coverage)|^insurance( on file)?$|^insurance information$/.test(norm(x.heading)));
  const withPayer = (prim.length ? prim : s.sections).filter((x) => x.dl.some(([k]) => /^payer$|^insurer$|^carrier$|^insurance company$/.test(norm(k))));
  const noIns = /\bno (insurance|coverage) on file\b|\bnot insured\b|\buninsured\b|\bself[- ]pay (patient|account)\b/i;
  if (prim.length > 1) return D("good-faith: several primary-insurance sections");
  const sec = prim[0];
  if (sec && noIns.test(sec.text) && !withPayer.length) return { insured: false };
  if (withPayer.length === 1) {
    const payer = dlValue(withPayer[0], /^payer$|^insurer$|^carrier$|^insurance company$/)!.value;
    const member = dlValue(withPayer[0], /member id|member number|subscriber id|policy (number|id)/);
    if (!payer || /^(none|—|-|n a)$/i.test(norm(payer))) return D("good-faith: insurance payer field empty");
    if (sec && noIns.test(sec.text)) return D("good-faith: insurance section shows both a payer and 'no insurance'");
    if (!member || !member.value.trim()) return D("good-faith: insurance has a payer but no member ID");
    return { insured: true, payer };
  }
  if (!sec && !withPayer.length && /\bno (insurance|coverage) on file\b/i.test(s.text)) return registrationEmptyState(s);
  return D(`good-faith: insurance status not recognised (sections: ${s.sections.map((x) => x.heading).slice(0, 8).join(" | ")})`);
}

/** The insurance tab shows "No insurance on file" but no recognised Primary-insurance heading (run 146: 5
 *  good-faith skips). It is the chart's own registration only when nothing on the page registers a payer
 *  (no Payer field anywhere — checked by the caller), the phrase appears exactly once, and it is not inside a
 *  section about something else (coverage records, secondary/other insurance, authorizations, claims, notes)
 *  or a table cell, and no member ID is shown. Headingless, in the chart header (h1 box), or under a plain
 *  insurance heading → uninsured. Anything else declines with what was seen. */
export function registrationEmptyState(s: Snapshot): { insured: false } | Decline {
  const PHRASE = /\bno insurance on file\b/i;
  const n = (s.text.match(/\bno (insurance|coverage) on file\b/gi) ?? []).length;
  if (n !== 1 || !PHRASE.test(s.text)) return D(`good-faith: 'No insurance/coverage on file' appears ${n} times outside a recognised insurance section`);
  if (s.sections.some((x) => x.tables.some((t) => t.rows.some((r) => r.some((c) => PHRASE.test(c.text)))))) return D("good-faith: 'No insurance on file' is a table cell, not the chart's registration");
  // a payer/member field shown as its own label line (dt/dd, not a table header row) means something is registered
  if (/(^|\n)\s*(payer|insurer|carrier|insurance company|member id|member number|subscriber id|policy (number|id))\s*(\n|$)/i.test(s.text)) return D("good-faith: 'No insurance on file' next to a payer / member ID field");
  const holders = s.sections.filter((x) => PHRASE.test(x.text));
  for (const h of holders) {
    // the smallest boxes say what the phrase belongs to; a holder that contains another holder is a page/column box
    if (holders.some((o) => o !== h && o.text.length < h.text.length && h.text.includes(o.text))) continue;
    const hd = norm(h.heading);
    if (h.level === 1 || !hd || /^(primary )?(insurance|registration|billing)( information| on file| details)?$|^(primary )?payer$/.test(hd)) continue;
    return D(`good-faith: 'No insurance on file' under "${h.heading}"`);
  }
  return { insured: false };
}

const PAY = /self[- ]?pay|out[- ]of[- ]pocket|\bcash\b|\bpay(s|ing|ment)?\b|\bpaid\b|insur|\bbill(s|ed|ing)?\b|\bprice|\bcost|estimate|uninsured|\bcharges?\b|\bfees?\b|coverage|\bcovered\b/i;
const VAGUE = /\b(today|tonight|tomorrow|yesterday|next|upcoming|this (visit|appointment|week|month)|that (visit|appointment)|same day|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\bthe \d{1,2}(st|nd|rd|th)\b/i;
/** A note that names this appointment's date: is it one of the message's look-alikes ("won't self-pay",
 *  "insurance is to be billed") → "insured", a plain self-pay for this visit ("Self-pay for the 1/6/2025
 *  appointment at the patient's request. Do not bill insurance") → "selfpay", or anything else → decline.
 *  Every sentence about paying/insurance must be one of four recognised kinds; another date, a family
 *  member, a price question, "used to", or mixed signals decline (run 146: 215, 222, 233 skipped). */
export function datedNoteKind(body: string, apptISO: string): "insured" | "selfpay" | Decline {
  const md = apptISO.slice(5);
  const others = datesIn(body).filter((d) => d !== apptISO).concat(monthDaysIn(body).filter((x) => x !== md));
  if (others.length) return D(`good-faith: a payment note names this appointment's date and another date ("${body.slice(0, 70)}")`);
  const KIN = /\b(son|daughter|husband|wife|mother|mom|father|dad|child|children|kid|kids|spouse|partner|brother|sister|sibling|grand\w*|family|parent|guardian|aunt|uncle|cousin|friend|someone else|other patient)\b/i;
  if (KIN.test(body)) return D(`good-faith: a payment note naming this date mentions someone else ("${body.slice(0, 70)}")`);
  if (/\b(used to|no longer|previously|formerly|until|price|quote|cost|how much|estimate|asked|ask|wonder|maybe|might|unsure|undecided|if |unless|instead|changed|switch|update|correction|cancel|reversed|later)\b/i.test(body)) return D(`good-faith: a payment note naming this date is conditional or changed ("${body.slice(0, 70)}")`);
  const SP = String.raw`self[- ]?pay`;
  const NEG = new RegExp(String.raw`\b(will not|won'?t|does not|doesn'?t|did not|didn'?t|is not|isn'?t|not going to|declined to|decided not to|chose not to)\s+(want to\s+|be\s+)?${SP}`, "i");
  const INS_BILLED = /^\W*(insurance (is|will be|should be|can be) (to be )?billed|(we will |we'll |please )?bill (her |his |their |the patient'?s )?insurance)( as usual| for (it|this|that|the) (visit|appointment))?( on file)?\W*$/i;
  const SELF = new RegExp(String.raw`^\W*((the )?(patient|pt)( has)? (chose|chosen|decided|elected|wants|will|is going) to (pay (for (it|this|the visit|the appointment) )?(out of pocket|themselves|herself|himself|in cash)|${SP})|${SP}\b)`, "i");
  const NO_INS = /^\W*(do not|don'?t|please do not|never) bill (the )?(patient'?s )?insurance( for (it|this|that|the) (visit|appointment))?\W*$|^\W*insurance (is )?not to be billed( for (it|this|that|the) (visit|appointment))?\W*$|^\W*(do not|don'?t) bill (it|this|this visit) to insurance\W*$|^\W*(does not|doesn'?t|did not|didn'?t|do not|don'?t|will not|won'?t) want (the |her |his |their )?insurance (to be )?billed( for (it|this|that|the (visit|appointment)))?\W*$/i;
  // The appointment's own date inside a clause ("pay for the visit on 1/9/2026 out of pocket") is already checked above (it is this
  // date and no other): dropped so the clause forms read through it. Run s3a item 220: "Patient chose to pay for the visit on 1/9/2026
  // out of pocket and does not want insurance billed for it." = the message's definition (self-pay for this visit + insurance not billed).
  const ON_DATE = /\bon (?:\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{1,2}(?:st|nd|rd|th)?(?:,? \d{4})?)\b/gi;
  // a compound sentence whose second clause is its own payment statement ("… and does not want insurance billed for it") is two clauses
  const CLAUSE_SPLIT = /,?\s+\b(?:and|but)\s+(?=(?:does|do|did|will|would|insurance|please|don'?t|doesn'?t|is)\b)/i;
  const kinds = new Set<string>();
  const sentences = body.split(/(?<=[.;!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
  for (const sent of sentences.flatMap((s) => s.replace(ON_DATE, "").replace(/\s{2,}/g, " ").split(CLAUSE_SPLIT).map((x) => x.trim()).filter(Boolean))) {
    if (!PAY.test(sent)) continue;
    if (NEG.test(sent) && !/\b(and|but|or)\b/i.test(sent.replace(/\bfor the visit on\b|\bfor (the|her|his|their) (visit|appointment)\b/gi, ""))) kinds.add("neg");
    else if (INS_BILLED.test(sent)) kinds.add("billed");
    else if (SELF.test(sent) && !/\b(not|n'?t|never|no)\b/i.test(sent)) kinds.add("self");
    else if (NO_INS.test(sent)) kinds.add("noins");
    else return D(`good-faith: a payment note names this appointment's date ("${body.slice(0, 70)}"); sentence not recognised: "${sent.slice(0, 60)}"`);
  }
  if (kinds.has("neg") && !kinds.has("self") && !kinds.has("noins")) return "insured";
  if (kinds.has("self") && !kinds.has("neg") && !kinds.has("billed")) return "selfpay";
  return D(`good-faith: a payment note names this appointment's date with mixed or unclear signals ("${body.slice(0, 70)}")`);
}

/** Note bodies (all of them) → do any make THIS appointment self-pay? "insured" when no note about
 *  paying/insurance names this appointment's date; a note that names it is classified by datedNoteKind
 *  (look-alike → insured, plain self-pay → selfpay); vague dates, the month alone, or several dated notes
 *  that disagree decline. */
export function notesDecision(bodies: string[], apptISO: string): "insured" | "selfpay" | Decline {
  const md = apptISO.slice(5), month = MONTH_NAMES[+apptISO.slice(5, 7) - 1];
  const kinds = new Set<string>();
  for (const b of bodies) {
    if (!PAY.test(b)) continue;
    if (datesIn(b).includes(apptISO) || monthDaysIn(b).includes(md)) { const k = datedNoteKind(b, apptISO); if (isDecline(k)) return k; kinds.add(k); continue; }
    if (VAGUE.test(b)) return D(`good-faith: a payment/insurance note refers to a visit without a full date ("${b.slice(0, 70)}")`);
    if (new RegExp(`\\b(${month}|${month.slice(0, 3)})\\b`, "i").test(b)) return D(`good-faith: a payment/insurance note mentions ${month} ("${b.slice(0, 70)}")`);
  }
  if (kinds.size > 1) return D("good-faith: notes naming this appointment's date disagree (self-pay and not)");
  return kinds.has("selfpay") ? "selfpay" : "insured";
}
/** The notes list (one item per note): header line(s) then the body. Returns the bodies. */
export function noteBodies(s: Snapshot): string[] | Decline {
  const seen = new Set<string>();
  const lists = s.sections.filter((x) => /\bnotes?\b/.test(norm(x.heading)) && x.items.length).filter((x) => { const k = JSON.stringify(x.items); if (seen.has(k)) return false; seen.add(k); return true; });
  if (lists.length !== 1) return lists.length ? D("good-faith: several notes lists") : (/\bno notes\b/i.test(s.text) ? [] : D("good-faith: notes list not found"));
  return lists[0].items;
}

const WHEN = [/date and time|^when$|^date$|date time|^appointment$|^start/], WHEN_AVOID = [/booked|created|changed|type|reason|provider/];
/** The chart's appointments table → the one-off appointment at this local date + time. */
export function findAppointment(t: Table, dateISO: string, time: string): { href: string; location: string | null } | Decline {
  const iWhen = col(t.headers, WHEN, WHEN_AVOID);
  if (iWhen < 0) return D(`good-faith: appointments columns not recognised (${t.headers.join(" | ")})`);
  const iLoc = col(t.headers, [/location|clinic|site|place/]);
  const hits = t.rows.filter((r) => cellDate(r[iWhen]) === dateISO && !r[iWhen]?.obf && timeIn(r[iWhen]?.text ?? "") === time);
  if (hits.length !== 1) return D(hits.length ? `good-faith: ${hits.length} appointments at ${dateISO} ${time}` : `good-faith: no appointment at ${dateISO} ${time} on the chart`);
  const href = hits[0][iWhen]?.href ?? hits[0].map((c) => c.href).find(Boolean) ?? null;
  if (!href) return D("good-faith: appointment row has no link to its detail");
  if (/recurring|series/i.test(href)) return D("good-faith: the matching row is a recurring series occurrence");
  return { href, location: iLoc >= 0 ? (hits[0][iLoc]?.text ?? null) : null };
}

/** Appointment detail: location, and the scheduling date (latest "Start time moved", else booked). */
export function parseAppointmentDetail(s: Snapshot, dateISO: string, time: string): { location: string; schedulingISO: string } | Decline {
  const all = s.sections;
  const dl = (re: RegExp) => { for (const x of all) { const v = dlValue(x, re); if (v) return v; } return null; };
  const date = dl(/^date$|^visit date$|^appointment date$/), tm = dl(/^time$|^start$|^start time$/), loc = dl(/^location$|^clinic$|^site$/);
  if (!date || oneDate(date.value) !== dateISO) return D(`good-faith: appointment detail date ${date?.value ?? "missing"} is not ${dateISO}`);
  if (!tm || timeIn(tm.value) !== time) return D(`good-faith: appointment detail time ${tm?.value ?? "missing"} is not ${time}`);
  if (!loc || !loc.value) return D("good-faith: appointment detail shows no location");
  const zone = tzFamily(tm.value);
  const bookedAll = all.flatMap((x) => x.dl.filter(([k]) => /^booked on$|^booked$|^scheduled on$|^date booked$/.test(norm(k))));
  const booked = bookedAll.length ? { value: bookedAll[0][1], obf: bookedAll.some((b) => b[2]) } : null;
  const bookedISO = booked ? oneDate(booked.value) : null;
  if (!booked || !bookedISO || booked.obf) return D("good-faith: appointment detail shows no readable booking date");
  if (bookedAll.some((b) => oneDate(b[1]) !== bookedISO)) return D("good-faith: appointment detail shows two different booking dates");
  const sameZone = (txt: string) => { const z = tzFamily(txt); return z === zone || (!z && !zone); };
  if (!sameZone(booked.value)) return D(`good-faith: booking time zone (${booked.value}) differs from the appointment's (${tm.value})`);
  const hist = all.flatMap((x) => (/history|changes|audit|activity/.test(norm(x.heading)) ? x.tables : [])).filter((t, i, a) => a.indexOf(t) === i);
  const moves: string[] = [];
  if (hist.length > 1) return D("good-faith: several history tables");
  if (hist.length) {
    const h = hist[0];
    const iW = col(h.headers, [/^when$|^date$|date and time|^time$|changed on/]), iC = col(h.headers, [/change|event|action|what/]);
    if (iW < 0 || iC < 0) return D(`good-faith: history columns not recognised (${h.headers.join(" | ")})`);
    const pg = pagerOf(s, /entr|change|event/i);
    if (pg) { const v = isComplete(h.rows.length, pg.footer); if (!v.complete) return D(`good-faith: history not completely read: ${v.why}`); }
    for (const r of h.rows) {
      const ch = r[iC]?.text ?? "";
      const c0 = ch.trim();
      const isMove = /\b(moved|rescheduled)\b/i.test(c0) || /^(start time|start|time|date|date and time|appointment time|appointment date)\s+(changed|updated|edited)\b/i.test(c0);
      const known = /^(booked|created|scheduled|status|checked|confirmed|cancel|no-show|reminder|note|provider|location|visit type|type|room|reason|insurance|completed|arrived)\b/i.test(c0);
      if (isMove && known) return D(`good-faith: history entry "${ch.slice(0, 60)}" is ambiguous`);
      if (!isMove && !known && /\b(start|time|date|moved|schedul)/i.test(c0)) return D(`good-faith: history entry "${ch.slice(0, 60)}" may change the time`);
      if (isMove) {
        const d = cellDate(r[iW]); if (!d) return D(`good-faith: history move entry without a readable date ("${r[iW]?.text}")`);
        if (!sameZone(r[iW]?.text ?? "")) return D("good-faith: history entry time zone differs from the appointment's");
        moves.push(d);
      }
    }
  } else if (/moved|rescheduled/i.test(s.text)) return D("good-faith: page mentions a move but no history table was found");
  const schedulingISO = moves.length ? moves.sort().at(-1)! : bookedISO;
  if (schedulingISO > dateISO) return D(`good-faith: scheduling date ${schedulingISO} is after the appointment`);
  return { location: loc.value.trim(), schedulingISO };
}

export type ClosureRow = { dateISO: string; applies: string; active: boolean };
/** One page of the clinic calendar table → rows (date, applies-to, Active?). */
export function parseCalendarTable(t: Table): ClosureRow[] | Decline {
  const iD = col(t.headers, [/^date$|^day$|closure date|^when$/]), iA = col(t.headers, [/applies|location|clinic|site/]), iS = col(t.headers, [/status|state/]);
  if (iD < 0 || iA < 0 || iS < 0) return D(`good-faith: clinic calendar columns not recognised (${t.headers.join(" | ")})`);
  const out: ClosureRow[] = [];
  for (const r of t.rows) {
    const d = cellDate(r[iD]); if (!d) return D(`good-faith: calendar row without a readable date ("${r[iD]?.text}")`);
    const st = norm(r[iS]?.text ?? "");
    if (st !== "active" && st !== "withdrawn") return D(`good-faith: calendar status "${r[iS]?.text}" is neither Active nor Withdrawn`);
    out.push({ dateISO: d, applies: (r[iA]?.text ?? "").trim(), active: st === "active" });
  }
  return out;
}
/** Active closures that apply to all locations or to this one. Unknown applies-to text → decline. */
export function closuresFor(rows: ClosureRow[], location: string, known: string[]): string[] | Decline {
  const L = norm(location), K = new Set(known.map(norm));
  if (K.size && !K.has(L)) return D(`good-faith: appointment location "${location}" is not on the calendar's location list`);
  const out = new Set<string>();
  for (const r of rows) {
    const a = norm(r.applies);
    let hit: boolean;
    if (/^(all|all locations|every location|all clinics|all sites|clinic wide|everywhere)$/.test(a)) hit = true;
    else {
      const parts = r.applies.split(/\s*(?:,|;|\band\b|&)\s*/).map(norm).filter(Boolean);
      if (K.size && parts.some((p) => !K.has(p))) return D(`good-faith: calendar entry applies to "${r.applies}", not a known location`);
      hit = parts.includes(L);
    }
    if (hit && r.active) out.add(r.dateISO);
  }
  return [...out].sort();
}

// ════════════════════════════ live navigation ════════════════════════════

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const snap = (c: Crawler) => c.evalApp<Snapshot>(SNAPSHOT_JS);
const gated = (s: Snapshot) => /chart is restricted|give a reason to open it/i.test(s.text);

/** Poll the page snapshot until `ok` holds (or timeout). */
export async function waitFor(c: Crawler, ok: (s: Snapshot) => boolean, ms = 6000): Promise<Snapshot | null> {
  const t0 = Date.now(); let s: Snapshot | null = null;
  while (Date.now() - t0 < ms) { s = await snap(c).catch(() => null); if (s && ok(s)) return s; await sleep(120); }
  return null;
}
/** Open a chart tab by its LABEL in the chart's own nav (fallback: <chart>/<slug>). */
export async function chartTab(c: Crawler, patHref: string, label: RegExp, slug: string, ready: (s: Snapshot) => boolean): Promise<Snapshot | Decline> {
  let s = await snap(c).catch(() => null);
  const link = s?.links.find((l) => label.test(norm(l.text)) && l.href.startsWith(patHref));
  const target = link?.href ?? `${patHref}/${slug}`;
  await c.navTo(target, /./, 8000).catch(() => false);
  s = await waitFor(c, (x) => ready(x) || gated(x), 8000);
  if (s && gated(s)) { if (!(await c.breakGlass().catch(() => false))) return D("chart is restricted and access was not granted"); await c.navTo(target, /./, 8000).catch(() => false); s = await waitFor(c, ready, 8000); }
  return s ?? D(`chart tab ${slug} did not show what was expected`);
}
/** Paging helper: ask for the largest page size, then click Next until the pager reaches the total. The end is proven
 *  only by an exact total the rows reach (listFooter.isComplete): a list whose footer states a bound ("500+") or an
 *  estimate ("about 500") is declined before any walk — its end can never be shown. */
export async function allPages<T>(c: Crawler, noun: RegExp, read: (s: Snapshot) => T[] | Decline, first: Snapshot, sizeLabel = /rows per page|per page|page size|show/): Promise<T[] | Decline> {
  let s = first; let pg = pagerOf(s, noun);
  if (pg && pg.kind !== "exact") { const v = isComplete(0, pg.footer); return D(`pagination: ${v.complete ? "" : v.why}`); }
  if (pg?.cumulative) {
    // "Showing 15 of 148" + Show more: load until everything is on the page, then read once.
    for (let guard = 0; pg && pg.to < pg.total && guard < 60; guard++) {
      const before = pg.to;
      const clicked = await c.evalApp<boolean>(`const b=[...doc.querySelectorAll('button,a')].find(x=>/^\\s*(show|load) more\\b/i.test(x.textContent||'')&&!x.disabled&&x.getAttribute('aria-disabled')!=='true'); if(b){b.click();return true;} return false;`).catch(() => false);
      if (!clicked) return D("pagination: no enabled Show more control");
      const nx = await waitFor(c, (x) => { const p = pagerOf(x, noun); return !!p && p.to > before; }, 5000);
      if (!nx) return D("pagination: Show more did not load more rows");
      const total0 = pg.total;
      s = nx; pg = pagerOf(s, noun);
      // The finished list drops "Showing N of M" for its own count ("20 appointments", Set 1 n=219). That is the same list
      // only when the stated total is the one we were loading toward; it is accepted as the end (isComplete below then needs
      // rows read == that exact count) and only if no Show more control is left. Any other change of form is a decline.
      if (pg && !pg.cumulative && pg.footer.end && pg.kind === "exact" && pg.total === total0) {
        if (/\b(show|load) more\b/i.test(s.text)) return D("pagination: the finished-list footer still shows a Show more control");
        break;
      }
      if (!pg || !pg.cumulative) return D("pagination: pager changed form after Show more");
    }
    if (!pg || pg.to < pg.total) return D("pagination: could not load every row");
    const rows = read(s); if (isDecline(rows)) return rows;
    const v = isComplete(rows.length, pg.footer); if (!v.complete) return D(`pagination: ${v.why}`);
    return rows;
  }
  if (pg && pg.to < pg.total) {
    const sel = s.selects.find((x) => x.options.length > 1 && x.options.every((o) => /^\d+$/.test(o.value)) && (sizeLabel.test(norm(x.label)) || x.options.some((o) => /per page|rows/i.test(o.text))));
    if (sel) {
      const best = sel.options.reduce((a, o) => (parseInt(o.value) > parseInt(a.value) ? o : a), sel.options[0]);
      await c.evalApp(`const s=[...doc.querySelectorAll('select')].find(x=>(x.name||x.id||'')===${JSON.stringify(sel.name)}&&[...x.options].some(o=>o.value===${JSON.stringify(best.value)})); if(!s) return false; const d=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set; d.call(s,${JSON.stringify(best.value)}); s.dispatchEvent(new Event('input',{bubbles:true})); s.dispatchEvent(new Event('change',{bubbles:true})); return true;`).catch(() => false);
      const want = Math.min(parseInt(best.value) || 0, pg.total);
      s = (await waitFor(c, (x) => { const p = pagerOf(x, noun); return !!p && p.from === 1 && p.to === want; }, 4000)) ?? (await snap(c));
      pg = pagerOf(s, noun);
    }
  }
  const out: T[] = [];
  for (let guard = 0; guard < 40; guard++) {
    const rows = read(s); if (isDecline(rows)) return rows;
    out.push(...rows);
    if (!pg || pg.to >= pg.total) break;
    const before = `${pg.from}-${pg.to}`;
    const clicked = await c.evalApp<boolean>(`const b=[...doc.querySelectorAll('button,a')].find(x=>/^\\s*Next\\s*$/i.test(x.textContent||'')&&!x.disabled&&x.getAttribute('aria-disabled')!=='true'); if(b){b.click();return true;} return false;`).catch(() => false);
    if (!clicked) return D("pagination: no enabled Next control");
    const nx = await waitFor(c, (x) => { const p = pagerOf(x, noun); return !!p && `${p.from}-${p.to}` !== before; }, 5000);
    if (!nx) return D("pagination: page did not advance");
    s = nx; const p2 = pagerOf(s, noun)!;
    if (p2.from !== pg.to + 1 || p2.total !== pg.total || p2.kind !== "exact") return D(`pagination: unexpected page ${p2.from}-${p2.to} of ${p2.total}${p2.kind !== "exact" ? ` (${p2.kind})` : ""} after ${before}`);
    pg = p2;
  }
  if (pg) { const v = isComplete(out.length, pg.footer); if (!v.complete) return D(`pagination: ${v.why}`); }
  return out;
}

export type FilingRead = { type: NotYetFiled["type"]; payer: string; remitISO: string | null; terms: FilingTerms[] };
const termsCache = new Map<string, FilingTerms[]>();
onDrop("payers", () => termsCache.clear()); // AGENT_CACHE=on: a message about payer terms ends what was read
export async function readFiling(c: Crawler, patHref: string, dosISO: string): Promise<FilingRead | Decline> {
  const ins = await chartTab(c, patHref, /^insurance$|^coverage$|^insurance and billing$/, "insurance", (s) => sectionsBy(s, /not yet (filed|billed|sent|submitted)|unfiled|waiting to be filed|to be filed|claims to file/).length > 0);
  if (isDecline(ins)) return D("filing: " + ins.decline);
  const claim = parseNotYetFiled(ins, dosISO); if (isDecline(claim)) return claim;
  let terms = termsCache.get(norm(claim.payer));
  if (!terms) {
    const navLink = ins.links.find((l) => /^payers?$/.test(norm(l.text)));
    await c.navTo(navLink?.href ?? "/payers", /./, 8000).catch(() => false);
    const list = await waitFor(c, (s) => s.sections.some((x) => x.tables.some((t) => col(t.headers, [/^payer$|^payer name$|^name$/]) >= 0)), 8000);
    if (!list) return D("filing: payers list did not load");
    const pg = pagerOf(list, /payer|entr|result/i);
    const links = list.sections.flatMap((x) => x.tables).flatMap((t) => { const i = col(t.headers, [/^payer$|^payer name$|^name$/]); return i < 0 ? [] : t.rows.map((r) => r[i]).filter((x) => x?.href).map((x) => ({ text: x.text, href: x.href! })); });
    const hits = [...new Map(links.filter((l) => norm(l.text) === norm(claim.payer)).map((l) => [l.href, l])).values()];
    if (hits.length !== 1) return D(hits.length ? `filing: ${hits.length} payers named ${claim.payer}` : `filing: payer "${claim.payer}" not on the payers list${pg && !isComplete(links.length, pg.footer).complete ? " (list not completely read)" : ""}`);
    await c.navTo(hits[0].href, /./, 8000).catch(() => false);
    const page = await waitFor(c, (s) => norm(s.h1).includes(norm(claim.payer)) && sectionsBy(s, /claim filing|filing (terms|limits?|rules)|timely filing|prior authorization|plans/).length > 0, 8000);
    if (!page) return D(`filing: ${claim.payer} payer page did not load`);
    const t = parseFilingTermsPage(page, claim.payer); if (isDecline(t)) return t;
    terms = t; termsCache.set(norm(claim.payer), t);
  }
  return { ...claim, terms };
}

export type GoodFaithRead = { insured: true } | { insured: false; schedulingISO: string; closuresISO: string[] };
const calendarCache = new Map<number, ClosureRow[]>();
let calendarLocations: string[] | null = null;
export async function readGoodFaith(c: Crawler, patHref: string, dateISO: string, time: string): Promise<GoodFaithRead | Decline> {
  const ins = await chartTab(c, patHref, /^insurance$|^coverage$|^insurance and billing$/, "insurance", (s) => /no (insurance|coverage) on file/i.test(s.text) || s.sections.some((x) => x.dl.some(([k]) => /^payer$/.test(norm(k)))));
  if (isDecline(ins)) return D("good-faith: " + ins.decline);
  const st = parseInsuranceStatus(ins); if (isDecline(st)) return st;
  if (st.insured) {
    const notes = await chartTab(c, patHref, /^notes?$|^chart notes$|^notes and messages$/, "notes", (s) => s.sections.some((x) => /\bnotes?\b/.test(norm(x.heading)) && x.items.length > 0) || /\bno notes\b/i.test(s.text));
    if (isDecline(notes)) return D("good-faith: " + notes.decline);
    const bodies = await allPages(c, /note/i, (s) => noteBodies(s), notes);
    if (isDecline(bodies)) return D("good-faith: notes: " + bodies.decline);
    const d = notesDecision(bodies, dateISO); if (isDecline(d)) return d;
    if (d === "insured") return { insured: true };
    // a note makes THIS visit self-pay → the estimate is owed: same scheduling-date / closure read as uninsured
  }
  // Uninsured → find the appointment, its scheduling date and location, then the location's closures.
  const appts = await chartTab(c, patHref, /^appointments?$|^visits$/, "appointments", (s) => s.sections.some((x) => x.tables.some((t) => col(t.headers, WHEN, WHEN_AVOID) >= 0 && col(t.headers, [/status/]) >= 0)));
  if (isDecline(appts)) return D("good-faith: " + appts.decline);
  const apptTable = (s: Snapshot) => s.sections.flatMap((x) => x.tables).find((t) => col(t.headers, WHEN, WHEN_AVOID) >= 0 && col(t.headers, [/status/]) >= 0) ?? null;
  let headers: string[] | null = null;
  const rows = await allPages(c, /appointment/i, (s) => { const t = apptTable(s); if (!t) return D("appointments table not found"); if (headers && headers.join("|") !== t.headers.join("|")) return D("appointments columns changed between pages"); headers = t.headers; return t.rows; }, appts);
  if (isDecline(rows)) return D("good-faith: appointments: " + rows.decline);
  if (!headers) return D("good-faith: appointments table not found");
  const merged: Table = { caption: "", headers, rows };
  const hit = findAppointment(merged, dateISO, time); if (isDecline(hit)) return hit;
  await c.navTo(hit.href, /./, 8000).catch(() => false);
  const det = await waitFor(c, (s) => s.sections.some((x) => x.dl.some(([k]) => /^booked on$|^booked$|^scheduled on$/.test(norm(k)))), 8000);
  if (!det) return D("good-faith: appointment detail did not load");
  const ap = parseAppointmentDetail(det, dateISO, time); if (isDecline(ap)) return ap;
  if (hit.location && norm(hit.location) !== norm(ap.location)) return D(`good-faith: list says ${hit.location}, detail says ${ap.location}`);
  const years = [...new Set([+ap.schedulingISO.slice(0, 4), +dateISO.slice(0, 4)])];
  const rowsAll: ClosureRow[] = [];
  for (const y of years) {
    const r = await calendarYear(c, y, det); if (isDecline(r)) return r;
    rowsAll.push(...r);
  }
  const closures = closuresFor(rowsAll, ap.location, calendarLocations ?? []); if (isDecline(closures)) return closures;
  return { insured: false, schedulingISO: ap.schedulingISO, closuresISO: closures };
}

/** Every clinic-calendar entry of a year (all locations), read once per session. */
async function calendarYear(c: Crawler, year: number, from: Snapshot): Promise<ClosureRow[] | Decline> {
  const cached = calendarCache.get(year); if (cached) return cached;
  const isCal = (s: Snapshot) => s.sections.some((x) => x.tables.some((t) => col(t.headers, [/applies|location/]) >= 0 && col(t.headers, [/status/]) >= 0 && col(t.headers, [/^date$|^day$|closure date|^when$/]) >= 0));
  const settings = from.links.find((l) => /^settings$|^clinic settings$|^admin$/.test(norm(l.text)));
  let s: Snapshot | null = null;
  for (const path of [...new Set([settings?.href, "/settings/clinic-calendar", "/settings"].filter(Boolean) as string[])]) {
    await c.navTo(path, /./, 8000).catch(() => false);
    s = await waitFor(c, (x) => isCal(x) || x.links.some((l) => /clinic calendar|closures?|holidays/.test(norm(l.text))), 6000);
    if (s && !isCal(s)) { const l = s.links.find((x) => /clinic calendar|closures?|holidays/.test(norm(x.text))); if (l) { await c.navTo(l.href, /./, 8000).catch(() => false); s = await waitFor(c, isCal, 6000); } }
    if (s && isCal(s)) break;
  }
  if (!s || !isCal(s)) return D("good-faith: clinic calendar not found");
  const ySel = s.selects.find((x) => /year/.test(norm(x.label)) || (x.options.length > 0 && x.options.every((o) => /^(\d{4}|all|every.*)$/i.test(o.text.trim()))));
  const locSel = s.selects.find((x) => /applies|location/.test(norm(x.label)));
  if (locSel) {
    calendarLocations = locSel.options.map((o) => o.text).filter((t) => !/^(every|all|any)\b/i.test(t.trim()));
    const cur = locSel.options.find((o) => o.selected);
    if (cur && cur.value !== "" && !/^(every|all|any)\b/i.test(cur.text)) return D(`good-faith: clinic calendar is filtered to ${cur.text}`);
  }
  if (!ySel) return D("good-faith: clinic calendar has no year selector");
  const opt = ySel.options.find((o) => o.text.trim() === String(year));
  if (!opt) return D(`good-faith: clinic calendar has no year ${year}`);
  const tableOf = (x: Snapshot) => x.sections.flatMap((q) => q.tables).find((t) => col(t.headers, [/applies|location/]) >= 0 && col(t.headers, [/status/]) >= 0) ?? null;
  const inYear = (x: Snapshot) => { const t = tableOf(x); if (!t) return false; const r = parseCalendarTable(t); return !isDecline(r) && (r.length === 0 ? new RegExp(`\\b${year}\\b`).test(x.text) : r.every((q) => +q.dateISO.slice(0, 4) === year)); };
  if (!(opt.selected && inYear(s))) {
    await c.evalApp(`const s=[...doc.querySelectorAll('select')].find(x=>(x.name||x.id||'')===${JSON.stringify(ySel.name)}); if(!s) return false; const d=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set; d.call(s,${JSON.stringify(opt.value)}); s.dispatchEvent(new Event('input',{bubbles:true})); s.dispatchEvent(new Event('change',{bubbles:true})); const f=s.closest('form'); const b=f?[...f.querySelectorAll('button')].find(x=>/apply|filter|show|go|search/i.test(x.textContent||'')||x.type==='submit'):null; if(b) b.click(); else if(f&&f.requestSubmit) f.requestSubmit(); return true;`).catch(() => false);
    s = await waitFor(c, inYear, 6000);
    if (!s) return D(`good-faith: clinic calendar did not switch to ${year}`);
  }
  const rows = await allPages(c, /entr|closure|row|result/i, (x) => { const t = tableOf(x); if (!t) return D("calendar table vanished"); const r = parseCalendarTable(t); if (isDecline(r)) return r; return r.some((q) => +q.dateISO.slice(0, 4) !== year) ? D(`calendar page shows rows outside ${year}`) : r; }, s);
  if (isDecline(rows)) return D("good-faith: clinic calendar: " + rows.decline);
  calendarCache.set(year, rows);
  return rows;
}
/** For tests: clear the session caches. */
export function resetFamilyCaches() { termsCache.clear(); calendarCache.clear(); calendarLocations = null; }
