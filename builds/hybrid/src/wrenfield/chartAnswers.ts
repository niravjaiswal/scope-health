/**
 * Generic patient-chart answerers (Set 2 hypothesis: plain chart questions Set 1 does not ask).
 * Deterministic from the pages the patient crawl already reads (chart header + demographics,
 * appointments tab with recurring occurrences, documents tab):
 *   MRN · sex · primary provider · home location
 *   last / first appointment with an explicit status → its date, provider, type or location
 *   count of the patient's appointments with an explicit status in a stated year / month / date range
 *   latest / earliest document of a named type → the date it was received
 *
 * Routing is by meaning, and only for questions no other intent or family takes (classifyIntent
 * calls this last). Every kind declines on: two kinds asked, a near-miss subject (someone else's
 * value, a lab/invoice/claim number), a yes/no question, a value we can't prove (incomplete
 * appointment history, MRN that the search row and chart header don't agree on, empty field).
 */
import type { PatientRecord } from "./inference.js";
import { providerAnswer, providerFormCue, providerMode, dateTimeOn, hhmm, namedZone, zoneOk } from "./formFlags.js";
import { guard } from "./guards.js";

export type ChartKind = "mrn" | "sex" | "primary-provider" | "home-location" | "appt-extreme" | "appt-count" | "doc-extreme";
export type ChartQ = { kind: ChartKind; status?: string; which?: "last" | "first"; want?: "date" | "provider" | "service" | "location"; from?: string; to?: string; docType?: string; form?: "bare" | "titled"; zone?: string };

const MON: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
const STATUS: Array<[string, RegExp]> = [["Completed", /\b(?:completed|attended)\b/i], ["Scheduled", /\b(?:scheduled|booked)\b/i], ["Late cancel", /\blate[- ]cancel(?:s|led|lations?)?\b/i], ["Cancelled", /\b(?<!late[- ])cancell?(?:ed|ations?)\b/i], ["No-show", /\bno[- ]?shows?\b/i]];
const DOC_TYPES: Array<[string, RegExp]> = [["Lab report", /\blab (?:report|result)s?\b/i], ["Referral letter", /\breferral(?: letter)?s?\b/i], ["Imaging report", /\bimaging (?:report|result)s?\b/i], ["Consent form", /\bconsent forms?\b/i], ["Discharge summary", /\bdischarge summar(?:y|ies)\b/i], ["Insurance card", /\binsurance cards?\b/i], ["Statement", /\bstatements?\b/i]];

/** The question part (before a definition/aside that follows the "?"). */
const head = (q: string) => q.split("?")[0];

/** Never route: other subjects, yes/no forms, clinic-wide or provider-scope questions. */
const NEAR = /\b(?:lab report number|report number|invoice|claim|policy|member id|insurance id|payer|referr(?:al|ing) (?:provider|practice)|emergency|guarantor|spouse|parent|guardian|mother|father|next of kin|pharmacy|employer)\b/i;
const YESNO = /^\s*(?:is|are|was|were|does|do|did|has|have|had|can|could|should|will|would)\b/i;
const CLINIC_SCOPE = /\b(?:all (?:of )?(?:our |the )?(?:patients|locations|providers)|across|clinic-wide|every patient|patients (?:who|that|with)|per (?:location|provider)|each (?:location|provider)|which patients|how many patients|top \d+|most(?! recent)|fewest|least)\b/i;

function statusOf(q: string): string | undefined | null {
  const hits = STATUS.filter(([, re]) => re.test(q)).map(([s]) => s);
  if (hits.length > 1) return null; // two statuses → decline
  return hits[0];
}

/** A stated window: "in 2025", "in March 2026", "between A and B" / "from A to B" (inclusive, ISO or written dates). */
export function windowOf(q: string): { from: string; to: string } | null | undefined {
  const iso = (s: string): string | null => {
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/); if (m) return s;
    m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/); if (m && MON[m[1].slice(0, 3).toLowerCase()]) return `${m[3]}-${MON[m[1].slice(0, 3).toLowerCase()]}-${m[2].padStart(2, "0")}`;
    return null;
  };
  const D = "(\\d{4}-\\d{2}-\\d{2}|[A-Z][a-z]{2,8}\\.?\\s+\\d{1,2},?\\s+\\d{4})";
  const rng = q.match(new RegExp(`\\b(?:between|from)\\s+${D}\\s+(?:and|to|through|thru)\\s+${D}`));
  if (rng) {
    const a = iso(rng[1]), b = iso(rng[2]);
    if (!a || !b || a > b) return null;
    if (/\bbetween\b/i.test(rng[0]) && !/\binclusive\b|\bboth (?:dates|days) included\b|\binclud(?:e|ing) both\b/i.test(q)) return null; // inclusivity unstated
    return { from: a, to: b };
  }
  const mon = q.match(/\b(?:in|during)\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/);
  if (mon) { const mm = MON[mon[1].slice(0, 3).toLowerCase()]; const last = new Date(Date.UTC(+mon[2], +mm, 0)).getUTCDate(); return { from: `${mon[2]}-${mm}-01`, to: `${mon[2]}-${mm}-${String(last).padStart(2, "0")}` }; }
  const yr = q.match(/\b(?:in|during)\s+(?:the year\s+|calendar year\s+)?(\d{4})\b(?!-)/);
  if (yr) return { from: `${yr[1]}-01-01`, to: `${yr[1]}-12-31` };
  if (/\b(?:since|after|before|until|by|through|last|this|past|previous|recent(?:ly)?)\s+(?:\d|year|month|week|quarter|[A-Z][a-z]+\s+\d)/i.test(q)) return null; // a window we don't read
  return undefined;
}

export function chartQuestion(q0: string): ChartQ | null {
  const q = head(q0).trim().replace(/\bfirst and last name\b/gi, "full name");
  if (!q || YESNO.test(q) || NEAR.test(q) || CLINIC_SCOPE.test(q)) return null;
  if (/,?\s+(?:MD|DO|NP|PA|PA-C|CNM|RN)\b/.test(q0)) return null; // names a provider: provider-scope questions belong to other families
  const asks = /\b(?:what|which|who|whose|when|give|tell|look up|find|list|need|on what date|how many)\b/i.test(q);
  if (!asks) return null;
  const kinds: ChartQ[] = [];
  // ── demographics
  if (/\b(?:MRN|medical record (?:number|no\.?|#)|chart number|record number)\b/i.test(q) && !/\b(?:reports?|documents?|letters?|scans?|printed)\b/i.test(q)) kinds.push({ kind: "mrn" });
  if (/\b(?:sex|gender)\b/i.test(q) && !/\bsex(?:ual)?\s+(?:health|history|partner)/i.test(q)) kinds.push({ kind: "sex" });
  if (/\b(?:primary (?:care )?(?:provider|doctor|physician|clinician)|\bPCP\b)/i.test(q)) kinds.push({ kind: "primary-provider", form: providerFormCue(q0) ?? undefined }); // the form the question itself states (FORM-THEORIES.md)
  if (/\bhome (?:location|clinic|site|office)\b/i.test(q)) kinds.push({ kind: "home-location" });
  // ── appointments: last/first with an explicit status, or a count in a stated window
  const apptWord = /\b(?:appointments?|visits?)\b/i.test(q);
  if (apptWord && !/\b(?:open )?slots?\b|\bopenings?\b|\bnext\b|\bupcoming\b/i.test(q)) {
    const st = statusOf(q);
    if (/\bhow many\b|\bnumber of\b|\bcount\b/i.test(q)) {
      const w = windowOf(q);
      // Only questions with a window take this route (an exact day stays with the existing count plan).
      if (w) kinds.push({ kind: "appt-count", status: st ?? undefined, from: w.from, to: w.to });
      else if (w === null) kinds.push({ kind: "appt-count" }); // a window we can't read → the solver declines
    } else {
      const which = /\b(?:last|most recent|latest|previous)\b/i.test(q) ? "last" : /\b(?:first|earliest)\b/i.test(q) ? "first" : undefined;
      // a row's "Date and time" cell answered with its bare date is the wrong form for a "date and time" / "what time" question (guards.ts CHART_TIME)
      if (which && !(guard("CHART_TIME") && /\btime\b/i.test(q) && !dateTimeOn())) { // AGENT_FORM_DATETIME=on answers with the clock time, so the guard steps aside
        const want = /\bwhen\b|\bdate\b|\bwhat day\b|\bon what\b/i.test(q) ? "date"
          : /\bwho\b|\bwhich (?:provider|doctor|clinician)\b|\bwith whom\b|\bwhat provider\b/i.test(q) ? "provider"
          : /\bwhat (?:type|kind|service)\b|\bwhich (?:type|kind|service)\b|\bwhat was (?:the )?(?:type|service)\b/i.test(q) ? "service"
          : /\bwhere\b|\b(?:which|what) location\b/i.test(q) ? "location" : undefined;
        const n = [/\bwhen\b|\bdate\b|\bwhat day\b|\bon what\b/i, /\bwho\b|\bwhich (?:provider|doctor|clinician)\b|\bwith whom\b|\bwhat provider\b/i, /\b(?:what|which) (?:type|kind|service)\b/i, /\bwhere\b|\b(?:which|what) location\b/i].filter((re) => re.test(q)).length;
        kinds.push({ kind: "appt-extreme", which, status: st ?? undefined, want: n === 1 ? want : undefined, form: want === "provider" ? providerFormCue(q0) ?? undefined : undefined, zone: namedZone(q0) ?? undefined });
      }
    }
  }
  // ── documents: latest/earliest of a named type → received date
  const dt = DOC_TYPES.filter(([, re]) => re.test(q));
  if (dt.length && /\b(?:received|came in|come in|arrive[d]?|filed|uploaded)\b/i.test(q) && /\bwhen\b|\bdate\b|\bwhat day\b|\bon what\b/i.test(q)) {
    const which = /\b(?:last|most recent|latest|newest)\b/i.test(q) ? "last" : /\b(?:first|earliest|oldest)\b/i.test(q) ? "first" : undefined;
    kinds.push({ kind: "doc-extreme", which, docType: dt.length === 1 ? dt[0][0] : undefined });
  }
  if (kinds.length !== 1) return null; // none, or two different things asked
  return kinds[0];
}

/** The answer, or null with a reason via `why`. `today` = the clinic's current date when known. */
export function chartAnswer(cq: ChartQ, pat: PatientRecord, why: (s: string) => void, today?: string): string | null {
  const demo = pat.demographics ?? {};
  const has = (v: unknown) => typeof v === "string" && v.trim() !== "" && !/^(?:(?:not|none) on file|none|unknown|n\/a|—|-)$/i.test(v.trim());
  switch (cq.kind) {
    case "mrn": { const m = (pat as any).mrn; if (!m) why("chart: MRN not proven (search row and chart header disagree or no MRN)"); return m ?? null; }
    case "sex": { const s = demo.sex; if (!has(s) || !/^(?:male|female|other|unknown|non-?binary|intersex|x)$/i.test(s.trim())) { why("chart: sex field empty or unexpected: " + String(s ?? "")); return null; } return s.trim(); }
    case "primary-provider": { // SKIP unless AGENT_FORM_PROVIDER names the form: the expected title format (with/without credential) is unproven (−1 risk)
      const r = providerAnswer(demo["primary provider"], cq.form); if ("why" in r) { why("chart: primary provider " + r.why); return null; } return r.answer; }
    case "home-location": { const l = demo["home location"]; if (!has(l)) { why("chart: home location empty"); return null; } return l.trim(); }
    case "appt-extreme": case "appt-count": {
      if (pat.appointmentsComplete !== true) { why("chart: appointment history not proven complete"); return null; }
      if (!cq.status) { why("chart: appointment question names no single status"); return null; }
      const rows = pat.appointments.filter((a) => a.status.toLowerCase() === cq.status!.toLowerCase());
      if (pat.appointments.some((a) => !/^(?:completed|scheduled|cancelled|late cancel|no-show)$/i.test(a.status))) { why("chart: an appointment has an unknown status"); return null; }
      if (cq.kind === "appt-count") {
        if (!cq.from || !cq.to) { why("chart: count without a readable window"); return null; }
        // today's rows may still change status → a window holding today with a row on today declines
        if (today && cq.from <= today && today <= cq.to && pat.appointments.some((a) => a.dateISO === today)) { why("chart: a row on today's date inside the window"); return null; }
        return String(rows.filter((a) => a.dateISO >= cq.from! && a.dateISO <= cq.to!).length);
      }
      if (!cq.which || !cq.want) { why("chart: appointment question: which one / what of it unclear"); return null; }
      // The appointment row shows "Name, NP" (the crawl keeps it as providerRaw); which form a question expects is unknown
      // -> never answer the provider from the row unless AGENT_FORM_PROVIDER names the form (or the question states it).
      if (cq.want === "provider" && providerMode() === "off") { why("chart: appointment provider form (with/without title) not provable"); return null; }
      if (!rows.length) { why(`chart: no ${cq.status} appointment`); return null; }
      const sorted = rows.slice().sort((a, b) => a.dateISO.localeCompare(b.dateISO));
      const pick = cq.which === "last" ? sorted[sorted.length - 1] : sorted[0];
      const tie = sorted.filter((a) => a.dateISO === pick.dateISO);
      const provOf = (a: typeof pick): string => { const r = providerAnswer(a.providerRaw, cq.form, providerMode(), a.provider); return "answer" in r ? r.answer : ""; };
      const val = (a: typeof pick) => cq.want === "date" ? a.dateISO : cq.want === "provider" ? provOf(a) : cq.want === "service" ? a.service : a.location;
      if (tie.length > 1 && new Set(tie.map(val)).size > 1) { why("chart: two appointments on the extreme date"); return null; }
      const v = val(pick); if (!has(v)) { why(cq.want === "provider" ? "chart: appointment provider form / title not captured" : "chart: appointment field empty"); return null; }
      // AGENT_FORM_DATETIME: the extreme appointment's clock time rides along ("2026-09-23T14:20"); a Date answer ignores it (shift.md)
      if (cq.want === "date" && dateTimeOn()) { const ts = tie.map((a) => zoneOk(a.time, cq.zone) ? hhmm(a.time) : undefined); if (ts.every(Boolean)) { ts.sort(); return `${pick.dateISO}T${cq.which === "last" ? ts[ts.length - 1] : ts[0]}`; } }
      return v;
    }
    case "doc-extreme": {
      if (!cq.which || !cq.docType) { why("chart: document question: which document unclear"); return null; }
      if ((pat as any).__skipped?.documents) { why("chart: documents tab not read"); return null; }
      const docs = pat.documents.filter((d) => d.kind.toLowerCase() === cq.docType!.toLowerCase());
      if (!docs.length) { why(`chart: no ${cq.docType} on the chart`); return null; }
      if (docs.some((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d.receivedISO))) { why("chart: a document row has no readable received date"); return null; }
      const s = docs.map((d) => d.receivedISO).sort();
      return cq.which === "last" ? s[s.length - 1] : s[0];
    }
  }
}
