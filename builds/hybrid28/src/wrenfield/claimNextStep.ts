/**
 * Claim next-step decision engine (family `claim-next-step`). PURE over (a) a ClaimPolicy parsed from
 * the billing supervisor's governing message + later amendment messages, and (b) a ClaimContext the
 * live reader (claimReader.ts) builds from the claim detail page and the payer's contract page.
 * Returns `{ answer }` or `{ decline: why }` (→ skip). No I/O, proven offline:
 *   npx tsx src/wrenfield/claimNextStep.ts
 *
 * Never-wrong contract:
 *  - every rule constant (today, denial reasons, priority, PR reasons, the remark table, the NCCI
 *    table, the answer tokens) comes from the message; the message's own worked date examples are
 *    re-computed and must agree with this engine's date arithmetic, or the policy is refused;
 *  - money is integer cents end to end (no float sums), formatted "1250.50";
 *  - anything the rule cannot place (an unknown group or reason code, an unknown remark code, a
 *    line that does not balance billed = paid + adjustments, two payments on the latest date, a
 *    reversal that names no payment, a scanned remittance with no keyed lines, a note we cannot read
 *    with certainty) declines rather than guesses. A skip is 0, a wrong answer −1.
 */
import { dateSpans } from "./pageSnapshot.js";
import { todayIn, tableWith, colIdx } from "./policyText.js";

// ════════════════════════════ types ════════════════════════════

export interface Adjustment { group: string; reason: number; cents: number }
export interface RemitLine { line: number | null; procedure: string; modifiers: string[]; adjustments: Adjustment[]; remarks: string[]; billedCents: number | null; paidCents: number | null }
export interface Remittance {
  trace: string; paymentDateISO: string;
  kind: "payment" | "reversal"; reverses: string | null;   // a reversal names the payment it takes back
  scanned: boolean;                                        // paper remittance whose lines are an image, not keyed
  lines: RemitLine[] | null;                               // this claim's lines on the remittance (null: not keyed)
}
export interface Submission { result: string; resultDateISO: string | null }
export interface Authorization {
  payer: string; procedure: string; fromISO: string; toISO: string;
  status?: string;          // the table's Status, when shown ("Approved")
  unmapped?: boolean;       // a Service we could not map to exactly one billed procedure code (procedure "")
  service?: string;
}
export interface AccountNote { atISO: string; text: string }   // atISO: full timestamp, for ordering
export interface BilledLine { line: number | null; procedure: string; modifiers: string[] }
export interface PlanRef { payer: string; plan: string }
export interface ClaimContext {
  serviceDateISO: string;
  payer: string;
  plan?: string | null;
  contract: { appealDays: number | null; filingDays: number | null };
  remittances: Remittance[];          // every remittance shown on THIS claim
  billedLines: BilledLine[];          // the claim's service lines as billed
  submissions: Submission[];
  authorizations: Authorization[];    // the Authorizations panel (patient-wide)
  notes: AccountNote[];               // the claim's account notes
  knownPlans?: PlanRef[] | null;      // every payer's plans (for reason 22); null when not read
  mergedRecord?: boolean;             // a merged duplicate record is involved: authorizations may be incomplete
}

export type Decision = { answer: string } | { decline: string };
const D = (why: string): Decision => ({ decline: "claim: " + why });

export interface ClaimPolicy {
  todayISO: string;
  denialReasons: number[];            // CO + one of these = denied line
  priority: number[];                 // work the first present
  patientReasons: number[];           // PR reasons summed for BILL_PATIENT
  knownReasons: Set<number>;          // the message's reason table
  remarkFields: Array<[string, string]>; // table order
  knownRemarks: Set<string>;          // table codes + codes the message names (MA130)
  ncci: Array<{ col1: string; col2: string; indicator: 0 | 1 }>;
  appealNotes: Array<{ payer: string; days: number; inWrenfield: boolean }>; // later messages, in order
  blocks: Array<{ payer: string | null; why: string }>;                       // later messages we cannot apply
  // Statements the engine relies on (true when the message states them; read by the branch that needs them).
  tokens?: string[];                  // answer tokens the message defines
  co45?: boolean;                     // "CO-45 is not a denial"
  appealCutoff?: boolean;             // "last day is today or later" → appeal, else write off
  authInclusive?: boolean;            // authorization first and last valid days both count
  noteRecency?: boolean;              // only the most recent insurance note counts
  filingExampleOk?: boolean;          // the message's filing example re-computes (or there is none)
  appealExampleOk?: boolean;          // the message's appeal example re-computes (or there is none)
}

// ════════════════════════════ helpers ════════════════════════════

export const normName = (s: string) => (s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
export const fmtCents = (c: number) => { const s = c < 0 ? "-" : ""; const a = Math.abs(c); return `${s}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`; };
/** "$1,250.50" / "1250.5" / "-$12.00" / "($12.00)" → cents; null when not exactly a money amount. */
export function parseCents(s: string): number | null {
  const t = (s || "").trim().replace(/−/g, "-");
  const m = t.match(/^(-|\()?\s*\$?\s*(-)?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*\)?$/);
  if (!m) return null;
  const neg = !!(m[1] || m[2]);
  const whole = parseInt(m[3].replace(/,/g, ""), 10);
  const frac = m[4] ? parseInt(m[4].padEnd(2, "0"), 10) : 0;
  const v = whole * 100 + frac;
  return neg ? -v : v;
}
export function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number); const dt = new Date(Date.UTC(y, m - 1, d)); dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

// ════════════════════════════ the governing message ════════════════════════════

const TOKENS = ["AWAIT_PAYER", "NO_ACTION", "BILL_PATIENT:", "BILL_OTHER:", "CONTACT_PATIENT", "RESUBMIT:", "CALL_PAYER", "APPEAL:", "WRITE_OFF:"];
/** Is this message the claim next-step rule? (paraphrase-tolerant signature: its answer set) */
export const isClaimPolicy = (raw: string) => /AWAIT_PAYER/.test(raw) && /BILL_PATIENT/.test(raw) && /WRITE_OFF/.test(raw) && /remittance/i.test(raw);
const nums = (s: string) => [...s.matchAll(/\d+/g)].map((m) => +m[0]);

export const CLAIM_FIELDS = ["todayISO", "tokens", "denialReasons", "priority", "patientReasons", "co45", "knownReasons", "remarkFields", "knownRemarks", "ncci", "appealCutoff", "authInclusive", "noteRecency", "filingExampleOk", "appealExampleOk"] as const;
/** The claim rule field by field (tables found by their column labels, as markdown or as bullet rows;
 *  "Today is" in its rewordings). A field the message does not state clearly is absent and `why` says
 *  why; the engine declines only the answers whose branch reads it (solvers.ts tracks the reads). */
export function parseClaimFields(raw: string, later: string[] = []): { fields: Partial<ClaimPolicy> & Pick<ClaimPolicy, "appealNotes" | "blocks">; why: string[] } {
  const why: string[] = [];
  const { appealNotes, blocks } = claimAmendments(later);
  const f: Partial<ClaimPolicy> & Pick<ClaimPolicy, "appealNotes" | "blocks"> = { appealNotes, blocks };
  f.tokens = TOKENS.filter((t) => raw.includes(t));
  if (f.tokens.length < TOKENS.length) why.push(`answer token(s) ${TOKENS.filter((t) => !raw.includes(t)).join(", ")} not in the message`);
  const today = todayIn(raw);
  if (today) f.todayISO = today; else why.push(today === null ? "'Today is' dates disagree" : "no single 'Today is <date>'");
  const t = raw.replace(/\s+/g, " ");
  const den = t.match(/line is denied when it has an adjustment with group `?CO`? and (?:a )?reasons? ([\d,\sor]+)/i);
  if (den) f.denialReasons = nums(den[1]); else why.push("denial definition not found");
  const pri = t.match(/(?:comes|is) first in this order:?\s*([\d,\s]+)/i) ?? t.match(/\bin this order(?: of priority)?:\s*([\d,\s]+)/i);
  if (pri) f.priority = nums(pri[1]); else why.push("denial priority order not found");
  if (f.priority && f.denialReasons && (f.priority.length !== f.denialReasons.length || !f.priority.every((r) => f.denialReasons!.includes(r)))) { why.push("priority order and denial reasons disagree"); delete f.priority; delete f.denialReasons; }
  const pr = t.match(/`?PR`? adjustments with reasons? ([\d,\sor]+)/i);
  if (pr) f.patientReasons = nums(pr[1]); else why.push("patient-responsibility reasons not found");
  if (/`?CO-45`? is not a denial/i.test(t)) f.co45 = true; else why.push("CO-45 statement not found");
  // tables by their column labels
  const rt = tableWith(raw, /^reason(?: code)?$/i, /meaning|description/i);
  if (rt) {
    const ri = colIdx(rt, /^reason(?: code)?$/i);
    f.knownReasons = new Set(rt.rows.filter((r) => /^\d+$/.test(r[ri] ?? "")).map((r) => +r[ri]));
    const needR = [...(f.denialReasons ?? []), ...(f.patientReasons ?? []), 45].filter((r) => !f.knownReasons!.has(r));
    if (needR.length) { why.push(`reason ${needR.join(", ")} missing from the reason table`); delete f.knownReasons; }
  } else why.push("reason table not found");
  const mt = tableWith(raw, /remark/i, /^field$/i);
  if (mt) {
    const ci = colIdx(mt, /remark/i), fi = colIdx(mt, /^field$/i);
    const rf = mt.rows.map((r) => [r[ci] ?? "", r[fi] ?? ""] as [string, string]);
    if (rf.length >= 3 && rf.every(([c, x]) => /^[A-Z]{1,2}\d{1,4}$/.test(c) && /^[A-Z_]+$/.test(x))) {
      f.remarkFields = rf; f.knownRemarks = new Set(rf.map(([c]) => c));
      for (const m of t.matchAll(/Remark code ([A-Z]{1,2}\d{1,4}) only says/gi)) f.knownRemarks.add(m[1].toUpperCase());
    } else why.push("remark-code table not understood");
  } else why.push("remark-code table not found");
  const nt = tableWith(raw, /column 1/i, /column 2/i, /indicator/i);
  if (nt) {
    const a = colIdx(nt, /column 1/i), b = colIdx(nt, /column 2/i), c = colIdx(nt, /indicator/i);
    const rows = nt.rows.map((r) => ({ col1: r[a] ?? "", col2: r[b] ?? "", ind: r[c] ?? "" }));
    if (rows.length && rows.every((r) => /^\d{5}$/.test(r.col1) && /^\d{5}$/.test(r.col2) && /^[01]$/.test(r.ind))) f.ncci = rows.map((r) => ({ col1: r.col1, col2: r.col2, indicator: +r.ind as 0 | 1 }));
    else why.push("bundling (NCCI) table not understood");
  } else why.push("bundling (NCCI) table not found");
  // The message's own worked date examples must agree with this engine's arithmetic (written dates too).
  const ex = (re: RegExp) => { let ok = true; for (const m of t.matchAll(re)) { const ds = dateSpans(m[0]).map((d) => d.iso); if (ds.length !== 2 || addDays(ds[0], +m[1]) !== ds[1]) ok = false; } return ok; };
  f.filingExampleOk = ex(/with (\d+) days, a service on [^;]{6,24}? had to be filed by [^.;]{6,24}?(?=[.;]|$| We\b)/gi); if (!f.filingExampleOk) { why.push("filing example disagrees with date arithmetic"); delete f.filingExampleOk; }
  f.appealExampleOk = ex(/with (\d+) days, a remittance paid on [^;]{6,24}? can be appealed through [^.;]{6,24}?(?=[.;]|$| If\b)/gi); if (!f.appealExampleOk) { why.push("appeal example disagrees with date arithmetic"); delete f.appealExampleOk; }
  if (/last day is today or later/i.test(t)) f.appealCutoff = true; else why.push("appeal cut-off (today or later) not stated");
  if (/first and last valid days both count/i.test(t)) f.authInclusive = true; else why.push("authorization date bounds not stated as inclusive");
  if (/most recent note/i.test(t)) f.noteRecency = true; else why.push("account-note recency rule not found");
  return { fields: f, why };
}

export function parseClaimPolicy(raw: string, later: string[] = []): ClaimPolicy | { decline: string } {
  const no = (why: string) => ({ decline: "claim policy: " + why });
  if (!isClaimPolicy(raw)) return no("message is not the claim next-step rule");
  const { fields, why } = parseClaimFields(raw, later);
  if (why.length) return no(why[0]);
  return fields as ClaimPolicy;
}

/** Messages after the rule that change it: "<Payer> accepts appeals within N days of the remittance
 *  date. This isn't in Wrenfield yet. Go by this note." (pending) / "This is in Wrenfield now: …"
 *  (the site has it). Anything else that talks about appeals, remittances, denials, filing limits or
 *  authorizations is a block (we cannot apply it). Other families' rules are not amendments. */
export function claimAmendments(later: string[]): { appealNotes: ClaimPolicy["appealNotes"]; blocks: ClaimPolicy["blocks"] } {
  const appealNotes: ClaimPolicy["appealNotes"] = [], blocks: ClaimPolicy["blocks"] = [];
  for (const m of later) {
    if (isClaimPolicy(m)) { blocks.push({ payer: null, why: "a second claim next-step rule arrived" }); continue; }
    if (/good faith estimate/i.test(m) && /business days?/i.test(m)) continue;                      // good-faith rule
    if (/\bfil(e|ing)\b/i.test(m) && /\boriginal\b/i.test(m) && /\bsecondary\b/i.test(m) && /\bcorrected\b/i.test(m) && /(deadline|last day)/i.test(m)) continue; // filing-deadline rule
    const a = m.match(/^\s*(?:This is in Wrenfield now:\s*)?(.+?) accepts appeals within (\d+) (?:calendar )?days (?:of|from|after) the (?:remittance|payment) date\b/i);
    if (a) {
      const rest = m.slice(a.index! + a[0].length);
      const pending = /(isn'?t|is not|not yet) in Wrenfield|go by this note/i.test(m);
      const live = /in Wrenfield now/i.test(m);
      if (pending === live || /\b(except|unless|only|but)\b/i.test(rest)) { blocks.push({ payer: a[1].trim(), why: `appeal note not understood: "${m.slice(0, 80)}"` }); continue; }
      appealNotes.push({ payer: a[1].trim(), days: +a[2], inWrenfield: live });
      continue;
    }
    if (/\bappeal|\bremittances?\b|\bdenial|\bdenied\b|write[- ]?off|\bresubmi|\bauthoriz|\bbundl|\bNCCI\b|modifier 59|coordination of benefits|other insurance|accepts? (original |new )?claims|filing (limit|window)|timely filing|claim(s)? (must|can) be (filed|submitted)/i.test(m)) {
      const payer = (m.match(/^\s*([A-Z][\w&'’.-]*(?:\s+(?:[A-Z][\w&'’.-]*|of|the|and|for))*\s+(?:Health|Plan|Care|Fund|Mutual|Assistance|Insurance|Life and Health|of the Plains|Medicare|Medicaid)\b)/) ?? [])[1] ?? null;
      blocks.push({ payer, why: `a later message may change the claim rule: "${m.slice(0, 80)}"` });
    }
  }
  return { appealNotes, blocks };
}

// ════════════════════════════ account notes (reason 22) ════════════════════════════

export type NoteClass =
  | { kind: "unrelated" }                       // says nothing about the patient's other insurance
  | { kind: "none" }                            // patient has no other insurance
  | { kind: "plan"; plan: string; covers: boolean }
  | { kind: "unclear"; why: string };

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const INS = /\binsur\w*|\bcoverage\b|\bcovered\b|\bcovers\b|\bpolicy\b|\bplan\b|\bpayer\b|\bsecondary\b|\bprimary\b|\bCOB\b|coordination of benefits|\bmedicare\b|\bmedicaid\b|\bsubscriber\b|\bmember id\b|\bdependent\b|\benroll\w*/i;
const NO_CHANGE = /^\s*(?:[^.]*\.\s*)?no change(s)? to (the )?(patient'?s )?insurance\.?\s*$/i;
const NONE = /\b(no|not any|doesn'?t have any|does not have any|doesn'?t have|does not have|has no|denies(?: having)?(?: any)?|without)\s+(other|another|secondary|additional|second)\s+(health\s+)?(insurance|coverage|plan|policy)\b|\bno other (health )?(insurance|coverage)\b|\bnot covered by any other\b|\bonly (has|insurance is)\b/i;
const NEG_COVER = /\b(not covered|isn'?t covered|is not covered|was not covered|wasn'?t covered|does(?:n'?t| not) cover (?:the )?(?:patient|her|him|them)|not on (?:the|that|this|his|her|their) (?:plan|policy)|is(?:n'?t| not) (?:a |listed as a )?(?:member|dependent|enrolled|on (?:the|that|this|his|her|their) (?:plan|policy))|not (?:a )?(?:member|dependent|enrolled)|not eligible|ineligible|only covers|in (?:his|her|their) own name only|someone else'?s|another person'?s|belongs to (?:someone|another|a different))\b/i;
const POS_COVER = /\b(?:patient|pt|she|he|they)\s+(?:is|are|was|has been|remains)\s+(?:also\s+)?(?:covered|insured|enrolled)\b|\bcovers (?:the )?patient\b|\bas a dependent\b|\b(?:patient|pt|she|he|they)\s+(?:also\s+)?ha(?:s|ve)\s+(?:secondary|other|additional)?\s*(?:coverage|insurance)\b/i;
const PERSON = /\b(spouse|husband|wife|partner|mother|mom|father|dad|parent|son|daughter|child|sibling|brother|sister|guardian|roommate|someone else|another person|family member|employer)\b/i;
const END_CUE = /(ended|ends|ending|end date|terminated|terminates|termed|lapsed|expired|expires|until|through|thru|cancel+ed|stopped|ran out|last day|coverage end\w*|no longer [a-z ]{0,20} (after|since|as of))\s*(on|was|is|:)?\s*$/i;
const START_CUE = /(effective|starting|started|starts|start date|since|as of|from|began|begins|beginning|enrolled|new as of|active)\s*(on|date|:)?\s*$/i;
// "… and was covered by it on 2025-12-24." — an affirmative statement that the plan covered the patient on that very date
const COVERED_ON = /\b(?:was|were|is|had been)\s+(?:also\s+)?(?:covered|insured|enrolled|active|in effect)(?:\s+(?:by|under|with)\s+(?:it|that plan|the plan|this plan|them))?\s+on\s*$/i;
const PAST_NO_DATE = /\b(ended|terminated|termed|lapsed|expired|cancel+ed|no longer|dropped|discontinued|former|formerly|previous|previously|used to|old plan)\b/i;

/** One account note → what it says about the patient's OTHER insurance on the date of service. */
export function classifyNote(text: string, dosISO: string, plans: PlanRef[]): NoteClass {
  const t = (text || "").replace(/\s+/g, " ").trim();
  const namedPlans = plans.filter((p) => new RegExp(`(^|[^\\w])${esc(p.plan)}(?![\\w])`, "i").test(t));
  const planNames = [...new Set(namedPlans.map((p) => normName(p.plan)))];
  const payersNamed = [...new Set(plans.map((p) => p.payer))].filter((py) => new RegExp(`(^|[^\\w])${esc(py)}(?![\\w])`, "i").test(t));
  // "the payer" alone is the claim's payer, not other insurance (Set 1 n≈190: "Patient called about a letter
  // from the payer. Told the patient billing is reviewing the claim.")
  if (!planNames.length && !payersNamed.length && !INS.test(t.replace(/\b(the|this|that) payer('s)?\b/gi, " "))) return { kind: "unrelated" };
  if (!planNames.length && !payersNamed.length && NO_CHANGE.test(t)) return { kind: "unrelated" };
  if (NONE.test(t)) {
    if (!planNames.length) return { kind: "none" };
    // "had <plan> until <date before the DOS>. No other insurance was active on <DOS>." (run 146, n=140):
    // the named plan, read WITHOUT the denying sentence(s), must itself not cover the DOS — then both say
    // the patient had no other coverage on the DOS. Anything else (plan covers, unclear) stays a decline.
    const rest = t.split(/(?<=[.;!?])\s+/).filter((x) => !NONE.test(x)).join(" ");
    const r = rest !== t && !NONE.test(rest) ? classifyNote(rest, dosISO, plans) : null;
    if (r && r.kind === "plan" && !r.covers) return { kind: "none" };
    return { kind: "unclear", why: `note both denies other insurance and names a plan ("${t.slice(0, 240)}")` };
  }
  if (planNames.length !== 1) return { kind: "unclear", why: planNames.length ? `note names ${planNames.length} plans` : `note talks about insurance without a known plan ("${t.slice(0, 240)}")` };
  const m = t.match(new RegExp(`(^|[^\\w])(${esc(namedPlans[0].plan)})(?![\\w])`, "i"))!;
  const plan = m[2];
  const neg = NEG_COVER.test(t), pos = POS_COVER.test(t);
  if (neg && pos) return { kind: "unclear", why: "note says both covered and not covered" };
  if (neg) return { kind: "plan", plan, covers: false };
  if (PERSON.test(t) && !pos) return { kind: "unclear", why: `note names a plan with another person but does not say the patient is covered ("${t.slice(0, 240)}")` };
  let start: string | null = null, end: string | null = null, assertedOnDos = false;
  for (const d of dateSpans(t)) {
    const before = t.slice(Math.max(0, d.start - 40), d.start);
    // "… and it was active on the date of service, March 18, 2026." (Set 1): the date names the DOS itself
    if (/\b(?:was|is)\s+active\s+on\s+the\s+date\s+of\s+service,?\s*$/i.test(before)) {
      if (d.iso !== dosISO) return { kind: "unclear", why: `note calls ${d.iso} the date of service, the claim's is ${dosISO}` };
      continue;
    }
    // a stated "covered on <date>" is the DOS only when it IS the DOS (any other date says nothing about the DOS → falls through to unclear)
    if (COVERED_ON.test(before) && d.iso === dosISO) { assertedOnDos = true; continue; }
    const isEnd = END_CUE.test(before), isStart = START_CUE.test(before);
    if (isEnd === isStart) return { kind: "unclear", why: `date ${d.iso} in the note is neither a clear start nor end of coverage ("${t.slice(0, 240)}")` };
    if (isEnd) { if (end) return { kind: "unclear", why: "two end dates" }; end = d.iso; }
    else { if (start) return { kind: "unclear", why: "two start dates" }; start = d.iso; }
  }
  if (!end && PAST_NO_DATE.test(t)) return { kind: "unclear", why: "coverage ended without a date" };
  if (/\b(pending|applied|applying|will start|starting soon|waiting|not yet active|to be confirmed|unverified|verify|checking|might|maybe|possibly|thinks|believes)\b/i.test(t)) return { kind: "unclear", why: `note is tentative ("${t.slice(0, 240)}")` };
  const covers = (!start || start <= dosISO) && (!end || dosISO <= end);
  if (assertedOnDos && !covers) return { kind: "unclear", why: `note says covered on ${dosISO} but also gives dates that exclude it ("${t.slice(0, 240)}")` };
  return { kind: "plan", plan, covers };
}

// ════════════════════════════ decision ════════════════════════════

/** The current remittance (or why there is none / it is ambiguous). */
export function currentRemittance(rems: Remittance[]): { cur: Remittance | null } | { decline: string } {
  const pays = rems.filter((r) => r.kind === "payment"), revs = rems.filter((r) => r.kind === "reversal");
  if (new Set(pays.map((p) => p.trace)).size !== pays.length) return { decline: "claim: two payments share a trace number" };
  const reversed = new Set<string>();
  for (const r of revs) {
    if (!r.reverses) return { decline: `claim: reversal ${r.trace} does not name the payment it reverses` };
    const hit = pays.filter((p) => p.trace === r.reverses);
    if (hit.length !== 1) return { decline: `claim: reversal ${r.trace} reverses ${r.reverses}, which is not a payment on this claim` };
    reversed.add(r.reverses);
  }
  const live = pays.filter((p) => !reversed.has(p.trace));
  if (!live.length) return { cur: null };
  const latest = live.map((p) => p.paymentDateISO).sort().at(-1)!;
  const top = live.filter((p) => p.paymentDateISO === latest);
  if (top.length > 1) return { decline: `claim: ${top.length} unreversed payments share the latest payment date ${latest}` };
  return { cur: top[0] };
}

/** The denial reason the rule works (the first present in priority order), or null when nothing is denied. */
export function workedReason(lines: RemitLine[], p: ClaimPolicy): number | null {
  const present = new Set(lines.flatMap((l) => l.adjustments).filter((a) => a.group === "CO" && p.denialReasons.includes(a.reason)).map((a) => a.reason));
  return p.priority.find((r) => present.has(r)) ?? null;
}

/** Validate the current remittance's lines against the message's vocabulary + 835 balancing. */
export function checkLines(lines: RemitLine[], p: ClaimPolicy): string | null {
  if (!lines.length) return "the current remittance has no lines for this claim";
  for (const l of lines) {
    for (const a of l.adjustments) {
      if (a.group !== "CO" && a.group !== "PR") return `adjustment group ${a.group} is not CO or PR`;
      if (!p.knownReasons.has(a.reason)) return `reason code ${a.reason} is not in the message's reason table`;
      if (!Number.isInteger(a.cents)) return "adjustment amount unreadable";
    }
    for (const r of l.remarks) if (!p.knownRemarks.has(r)) return `remark code ${r} is not one the message defines`;
    if (l.billedCents == null || l.paidCents == null) return `line ${l.line ?? "?"} has no billed/paid amount`;
    const adj = sum(l.adjustments.map((a) => a.cents));
    if (l.billedCents - adj !== l.paidCents) return `line ${l.line ?? "?"} does not balance (billed ${fmtCents(l.billedCents)} − adjustments ${fmtCents(adj)} ≠ paid ${fmtCents(l.paidCents)})`;
  }
  return null;
}

/** The declines that need none of the current remittance's lines: a later message that blocks the payer, a remittance paid before the
 *  date of service, a rule that never says CO-45 is no denial. decideClaim makes these checks before it reads the lines; the live
 *  reader asks first, so the image of a scanned remittance is not read for a claim that declines whatever it shows. */
export function declineBeforeLines(payer: string, cur: Remittance, serviceDateISO: string, p: ClaimPolicy): Decision | null {
  const payerBlock = p.blocks.find((b) => b.payer === null || normName(b.payer) === normName(payer));
  if (payerBlock) return D(payerBlock.why);
  if (cur.paymentDateISO < serviceDateISO) return D(`current remittance ${cur.paymentDateISO} is before the date of service`);
  if (!p.co45) return D("the message does not say CO-45 is not a denial");
  return null;
}

export function decideClaim(c: ClaimContext, p: ClaimPolicy): Decision {
  const payerBlock = p.blocks.find((b) => b.payer === null || normName(b.payer) === normName(c.payer));
  if (payerBlock) return D(payerBlock.why);
  const cr = currentRemittance(c.remittances);
  if ("decline" in cr) return cr;
  const cur = cr.cur;
  if (!cur) return { answer: "AWAIT_PAYER" };
  if (cur.scanned || !cur.lines) return D(`current remittance ${cur.trace} (${cur.paymentDateISO}) is a scanned paper remittance with no keyed lines`);
  const early = declineBeforeLines(c.payer, cur, c.serviceDateISO, p); if (early) return early;
  const lines = cur.lines;
  const bad = checkLines(lines, p); if (bad) return D(bad);

  const reason = workedReason(lines, p);
  if (reason === null) {
    const pr = sum(lines.flatMap((l) => l.adjustments).filter((a) => a.group === "PR" && p.patientReasons.includes(a.reason)).map((a) => a.cents));
    if (pr < 0) return D("patient responsibility total is negative");
    return { answer: pr > 0 ? `BILL_PATIENT:${fmtCents(pr)}` : "NO_ACTION" };
  }
  const denied = sum(lines.flatMap((l) => l.adjustments).filter((a) => a.group === "CO" && a.reason === reason).map((a) => a.cents));
  if (denied <= 0) return D(`denied amount for reason ${reason} is not positive`);
  const writeOff = { answer: `WRITE_OFF:${fmtCents(denied)}` };
  const reasonLines = lines.filter((l) => l.adjustments.some((a) => a.group === "CO" && a.reason === reason));

  const appeal = (): Decision => {
    const notes = p.appealNotes.filter((n) => normName(n.payer) === normName(c.payer));
    const last = notes.at(-1);
    let days: number | null;
    if (last && !last.inWrenfield) days = last.days;                       // "go by this note until it is"
    else {
      days = c.contract.appealDays;
      if (days == null) return D(`${c.payer} contract shows no appeal window`);
      if (last && last.inWrenfield && days !== last.days) return D(`${c.payer} contract says ${days} appeal days, the note says ${last.days} is now in Wrenfield`);
    }
    if (!p.appealCutoff || !p.appealExampleOk) return D("the message's appeal cut-off / appeal example is not clear");
    const lastDay = addDays(cur.paymentDateISO, days);
    return lastDay >= p.todayISO ? { answer: `APPEAL:${lastDay}` } : writeOff;
  };

  switch (reason) {
    case 29: {
      if (!p.filingExampleOk) return D("the message's filing example is not clear");
      if (c.contract.filingDays == null) return D(`${c.payer} contract shows no claim filing limit`);
      const lastToFile = addDays(c.serviceDateISO, c.contract.filingDays);
      let proof = false;
      for (const s of c.submissions) {
        const r = normName(s.result);
        if (/clearinghouse/.test(r) && !/reject/.test(r)) return D(`submission result "${s.result}" (clearinghouse) not understood`);
        if (/reject|denied|returned|failed|error/.test(r)) continue;          // a rejected submission never counts
        if (/^accepted by (the )?payer$/.test(r)) { if (!s.resultDateISO) return D("accepted submission without a result date"); if (s.resultDateISO <= lastToFile) proof = true; continue; }
        if (/accept/.test(r)) return D(`submission result "${s.result}" not understood`);
      }
      return proof ? appeal() : writeOff;
    }
    case 22: {
      if (!p.noteRecency) return D("the message's account-note recency rule is not clear");
      if (!c.knownPlans) return D("payer plans not read (needed to read the account notes)");
      if (c.notes.some((n) => !/^\d{4}-\d{2}-\d{2}T/.test(n.atISO))) return D("an account note has no readable timestamp");
      const notes = c.notes.slice().sort((a, b) => (a.atISO < b.atISO ? 1 : a.atISO > b.atISO ? -1 : 0));
      for (let i = 0; i < notes.length; i++) {
        const k = classifyNote(notes[i].text, c.serviceDateISO, c.knownPlans);
        if (k.kind === "unrelated") continue;
        if (i + 1 < notes.length && notes[i + 1].atISO === notes[i].atISO && classifyNote(notes[i + 1].text, c.serviceDateISO, c.knownPlans).kind !== "unrelated") return D("two insurance notes share the latest timestamp");
        if (k.kind === "unclear") return D("account note: " + k.why);
        if (k.kind === "none") return { answer: "CONTACT_PATIENT" };
        if (c.plan && normName(k.plan) === normName(c.plan)) return D(`the latest insurance note names the claim's own plan ${k.plan}`);
        return k.covers ? { answer: `BILL_OTHER:${k.plan}` } : { answer: "CONTACT_PATIENT" };
      }
      return { answer: "CONTACT_PATIENT" };
    }
    case 16: {
      const remarks = new Set(reasonLines.flatMap((l) => l.remarks));
      const hit = p.remarkFields.find(([code]) => remarks.has(code));
      return hit ? { answer: `RESUBMIT:${hit[1]}` } : { answer: "CALL_PAYER" };
    }
    case 197: {
      if (!p.authInclusive) return D("the message's authorization date bounds are not clear");
      const onDOS = (a: Authorization) => normName(a.payer) === normName(c.payer) && a.fromISO <= c.serviceDateISO && c.serviceDateISO <= a.toISO;
      const covering = (l: RemitLine) => c.authorizations.filter((a) => onDOS(a) && !a.unmapped && a.procedure === l.procedure);
      for (const l of reasonLines) for (const a of covering(l)) if (a.status !== undefined && !/^(approved|active)$/i.test(a.status.trim())) return D(`authorization for ${l.procedure} has status "${a.status}"`);
      if (reasonLines.every((l) => covering(l).length > 0)) return appeal();
      const um = c.authorizations.find((a) => onDOS(a) && a.unmapped);
      if (um) return D(`authorization for service "${um.service ?? "?"}" (valid on the date of service) does not map to one billed procedure code`);
      if (c.mergedRecord) return D("authorization not found, and a merged duplicate record's authorizations may not be shown");
      return writeOff;
    }
    case 97: {
      const billedOf = (l: RemitLine): BilledLine | null => {
        const byLine = l.line != null ? c.billedLines.filter((b) => b.line === l.line) : [];
        if (byLine.length === 1) return byLine[0].procedure === l.procedure ? byLine[0] : null;
        const same = c.billedLines.filter((b) => b.procedure === l.procedure);
        return same.length === 1 ? same[0] : null;
      };
      for (const l of reasonLines) if (!billedOf(l)) return D(`denied line ${l.procedure} not matched to one billed service line`);
      const grounds = (l: RemitLine) => {
        const b = billedOf(l)!;
        if (!b.modifiers.includes("59")) return false;
        return p.ncci.some((row) => row.indicator === 1 && row.col2 === l.procedure && c.billedLines.some((o) => o !== b && o.procedure === row.col1));
      };
      return reasonLines.every(grounds) ? appeal() : writeOff;
    }
  }
  return D(`no rule for denial reason ${reason}`);
}

/** Final guard: the answer is one the message allows, in its format. */
export const ANSWER_RE = /^(AWAIT_PAYER|NO_ACTION|CONTACT_PATIENT|CALL_PAYER|BILL_PATIENT:\d+\.\d{2}|WRITE_OFF:\d+\.\d{2}|APPEAL:\d{4}-\d{2}-\d{2}|RESUBMIT:[A-Z_]+|BILL_OTHER:\S.*)$/;

// ── self-check: the message's worked example (full suite: claimReader.test.ts) ──
if (process.argv[1]?.endsWith("claimNextStep.ts")) {
  const { readFileSync } = await import("node:fs");
  const raw = readFileSync(new URL("../../fixtures/set1-items.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((i: any) => i.n === 120).text;
  const p = parseClaimPolicy(raw, []);
  if ("decline" in p) { console.error("✗ policy: " + p.decline); process.exit(1); }
  const L = (procedure: string, adj: Adjustment[], billed: number, paidC: number): RemitLine => ({ line: null, procedure, modifiers: [], adjustments: adj, remarks: [], billedCents: billed, paidCents: paidC });
  const ctx: ClaimContext = { serviceDateISO: "2026-07-06", payer: "P", contract: { appealDays: 120, filingDays: 90 }, billedLines: [{ line: 1, procedure: "20610", modifiers: [] }], submissions: [], notes: [],
    authorizations: [{ payer: "P", procedure: "20610", fromISO: "2026-07-06", toISO: "2026-07-06" }],
    remittances: [{ trace: "A", paymentDateISO: "2026-07-20", kind: "payment", reverses: null, scanned: false, lines: [L("20610", [{ group: "PR", reason: 2, cents: 100 }], 100, 0)] },
      { trace: "B", paymentDateISO: "2026-08-01", kind: "reversal", reverses: "A", scanned: false, lines: [] },
      { trace: "CHK4578491", paymentDateISO: "2026-08-17", kind: "payment", reverses: null, scanned: false, lines: [L("20610", [{ group: "CO", reason: 197, cents: 19000 }], 19000, 0)] }] };
  const v = decideClaim(ctx, p);
  if (!("answer" in v) || v.answer !== "APPEAL:2026-12-15") { console.error("✗ worked example: " + JSON.stringify(v)); process.exit(1); }
  console.log("✓ worked example → APPEAL:2026-12-15\nALL PASS");
}
