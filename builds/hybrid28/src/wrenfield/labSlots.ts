/**
 * Paraphrase-robust slot extraction for lab-report triage questions (family `lab-report-triage`):
 * panel, patient name, DOB (optional), received date — by meaning, not by Set 1 wording. Used when a
 * question isn't one of the exact Set 1 phrasings (families.ts). Every slot must be found
 * unambiguously or the result is null (→ the solver skips). A question that names a lab report but
 * doesn't ask what to DO with it (who ordered it, when it came in, a single value…) is not triage.
 */

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MON_RE = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => {
  if (!(y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d)); if (dt.getUTCMonth() !== m - 1) return null; // Feb 30 etc.
  return `${y}-${pad(m)}-${pad(d)}`;
};
const monthNum = (s: string) => { const k = s.toLowerCase().slice(0, 3); const i = MONTHS.findIndex((m) => m.startsWith(k)); return i + 1; };

export interface DateHit { iso: string; start: number; end: number }
/** Every date in the text: ISO (2026-01-23), US numeric (01/23/2026, 1-23-2026), written (Jan 23, 2026 /
 *  January 23rd 2026 / 23 January 2026). */
export function findDates(text: string): DateHit[] {
  const out: DateHit[] = [];
  const add = (v: string | null, m: RegExpExecArray) => { if (v) out.push({ iso: v, start: m.index, end: m.index + m[0].length }); };
  let m: RegExpExecArray | null;
  const r1 = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g; while ((m = r1.exec(text))) add(iso(+m[1], +m[2], +m[3]), m);
  const r2 = /\b(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})\b/g; while ((m = r2.exec(text))) add(iso(+m[3], +m[1], +m[2]), m);
  const r3 = new RegExp(`\\b(${MON_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "gi"); while ((m = r3.exec(text))) add(iso(+m[3], monthNum(m[1]), +m[2]), m);
  const r4 = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MON_RE})\\.?,?\\s+(\\d{4})\\b`, "gi"); while ((m = r4.exec(text))) add(iso(+m[3], monthNum(m[2]), +m[1]), m);
  // drop overlaps (keep the first-found / longest)
  out.sort((a, b) => a.start - b.start || b.end - a.end);
  return out.filter((d, i) => !out.slice(0, i).some((e) => d.start < e.end && e.start < d.end));
}

const DOB_CUE = /(?:\bdob\b|\bd\.o\.b\.?|\bborn\b|date of birth|birth ?date|birthday)[\s:,(]*(?:on\s+)?$/i;
const RECV_CUE = /\b(?:received|receipt|filed|came in|arrived|logged|got|dated|posted|scanned|uploaded|entered|hit the chart|landed in the chart|added to the chart)\b[^.;?!]{0,30}$/i;
/** Triage intent: what to do with the report (call / review / release / next step / handle). */
const INTENT = /call (?:the |a )?(?:provider|doctor|physician)|nurse review|release (?:it )?to the patient|\brelease\b|what (?:happens|should (?:we|i) do|do (?:we|i) do|to do)|next step|\btriage\b|\bdecide\b|\bdisposition\b|how should (?:we|i) (?:handle|route)|\bhandle[ds]?\b|\bhandling\b|\broute[ds]?\b|\brouting\b|where does .{0,40} go|what'?s the (?:call|plan|disposition)|\bact on\b/i;
/** Asking for something else about the report → not a triage task. */
const OTHER_Q = /\b(?:who (?:ordered|signed|sent)|which (?:lab|provider|doctor)|when was|what time|how many|reference range|what (?:was|is|were) (?:the |her |his |their )?(?:[a-z]+ )?(?:value|result|level|count|number)|ordering provider|fax|phone)\b/i;

const PANEL_ABBR: Record<string, string> = { cbc: "Complete blood count", bmp: "Basic metabolic panel", cmp: "Comprehensive metabolic panel" };
const PANEL_STOP = new Set(["the", "a", "an", "this", "that", "for", "of", "her", "his", "their", "patient", "lab", "labs", "report", "new", "latest", "recent", "on", "to", "with", "and", "about", "from", "is", "was", "what", "which", "my", "our", "its", "your", "do", "we", "i"]);
/** The panel named in the text ("Basic metabolic panel", "Complete blood count", CBC/BMP), or null if none/several. */
export function findPanel(text: string): { panel: string; start: number; end: number } | null {
  const hits: Array<{ panel: string; start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  const cbc = /\bcomplete blood counts?\b/gi; while ((m = cbc.exec(text))) hits.push({ panel: "Complete blood count", start: m.index, end: m.index + m[0].length });
  const ab = /\b(CBC|BMP|CMP)\b/g; while ((m = ab.exec(text))) hits.push({ panel: PANEL_ABBR[m[1].toLowerCase()], start: m.index, end: m.index + m[0].length });
  const pr = /\bpanel\b/gi;
  while ((m = pr.exec(text))) {
    const before = text.slice(0, m.index).split(/\s+/).filter(Boolean); const words: string[] = [];
    for (let i = before.length - 1; i >= 0 && words.length < 3; i--) {
      const w = before[i]; if (!/^[A-Za-z]+$/.test(w) || PANEL_STOP.has(w.toLowerCase())) break; words.unshift(w);
    }
    if (!words.length) continue;
    const phrase = words.join(" ") + " panel"; const start = m.index - (words.join(" ").length + 1);
    hits.push({ panel: phrase.charAt(0).toUpperCase() + phrase.slice(1).toLowerCase(), start, end: m.index + 5 });
  }
  const distinct = [...new Set(hits.map((h) => h.panel.toLowerCase()))];
  return distinct.length === 1 ? hits[0] : null;
}

const NOT_NAME = new Set(["please", "does", "do", "did", "what", "whats", "next", "could", "can", "would", "should", "patient", "lab", "report", "dob", "born", "received", "triage", "the", "for", "a", "an", "i", "we", "hi", "hey", "quick", "question", "need", "help", "decide", "call", "nurse", "release", "provider", "complete", "basic", "thyroid", "panel", "blood", "count", "metabolic", "result", "results", "chart", "today", "re", "regarding", "about", "on", "mr", "mrs", "ms", "dr", ...MONTHS, ...MONTHS.map((x) => x.slice(0, 3))]);
const TOKEN = "[A-Z\\u00C0-\\u00DE][\\p{L}'’\\-]*";
const PARTICLE = "(?:de|del|de la|da|di|van|von|der|le|la|du|dos|das|bin|al)";
const NAME_FIRST_LAST = new RegExp(`${TOKEN}(?:\\s+(?:${PARTICLE}\\s+)?${TOKEN}){1,3}`, "gu");
const NAME_LAST_FIRST = new RegExp(`(${TOKEN}(?:[ \\-]${TOKEN})?),\\s+(${TOKEN}(?:\\s+${TOKEN})?)`, "gu");
const tokOk = (t: string) => !NOT_NAME.has(t.toLowerCase().replace(/['’]s$/, ""));
const key = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[,]/g, " ").split(/\s+/).filter(Boolean).sort().join(" ");

/** The patient name: "Last, First" or "First [Middle] Last" (particles allowed); exactly one distinct candidate. */
export function findName(masked: string): string | null {
  const cands: string[] = [];
  let m: RegExpExecArray | null;
  const lf = new RegExp(NAME_LAST_FIRST.source, "gu");
  while ((m = lf.exec(masked))) {
    const last = m[1], first = m[2].replace(/['’]s$/, "").split(/\s+/).filter(tokOk); // "Anderson, Evelyn's panel" → Evelyn
    if (!tokOk(last.split(/[ \-]/)[0]) || !first.length || first.length !== m[2].split(/\s+/).length) continue;
    cands.push(`${last}, ${first.join(" ")}`);
  }
  const fl = new RegExp(NAME_FIRST_LAST.source, "gu");
  while ((m = fl.exec(masked))) {
    let toks = m[0].replace(/['’]s$/, "").split(/\s+/);
    while (toks.length && !tokOk(toks[0])) toks = toks.slice(1);
    while (toks.length && !tokOk(toks[toks.length - 1])) toks = toks.slice(0, -1);
    if (toks.length < 2 || toks.some((t) => /^[A-Z]/.test(t) && !tokOk(t))) continue;
    const s = toks.join(" ");
    // a "Last, First" hit already covers these words
    if (cands.some((c) => key(c) === key(s) || key(c).includes(key(s)))) continue;
    cands.push(s);
  }
  const distinct = [...new Map(cands.map((c) => [key(c), c])).values()];
  return distinct.length === 1 ? distinct[0] : null;
}

export interface LabSlots { panel: string; name: string; dob?: string; received: string }
/** Slots of a lab-triage question in any phrasing, or null when it isn't one / a slot is unclear. */
export function extractLabSlots(text: string): LabSlots | null {
  const t = text.replace(/\s+/g, " ").trim();
  if (!/\blab(?:oratory)?\b|\bpanel\b|\bblood count\b|\b(?:CBC|BMP)\b/i.test(t)) return null;
  if (!INTENT.test(t) || OTHER_Q.test(t)) return null;
  const panel = findPanel(t); if (!panel) return null;
  const dates = findDates(t);
  const dobs = dates.filter((d) => DOB_CUE.test(t.slice(Math.max(0, d.start - 30), d.start)));
  const rest = dates.filter((d) => !dobs.includes(d));
  if (dobs.length > 1 || [...new Set(dobs.map((d) => d.iso))].length > 1) return null;
  let recv = rest.filter((d) => RECV_CUE.test(t.slice(Math.max(0, d.start - 45), d.start)));
  if (!recv.length && rest.length === 1 && /\b(?:received|filed|came in|arrived|in the chart|logged|hit the chart)\b/i.test(t)) recv = rest;
  if ([...new Set(recv.map((d) => d.iso))].length !== 1 || rest.length !== recv.length) return null;
  // mask panel and dates (and their cue words) so they can't be read as name words
  let masked = t;
  const spans = [panel, ...dates].sort((a, b) => b.start - a.start);
  for (const s of spans) masked = masked.slice(0, s.start) + " ~ ".padEnd(s.end - s.start, " ") + masked.slice(s.end);
  masked = masked.replace(/\b(?:DOB|D\.O\.B\.?|Date of birth|born|received|Lab report|lab report)\b/g, " ~ ");
  const name = findName(masked); if (!name) return null;
  return { panel: panel.panel, name, dob: dobs[0]?.iso, received: recv[0].iso };
}
