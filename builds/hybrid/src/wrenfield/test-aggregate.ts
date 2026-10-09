/**
 * Aggregate capability tests (no live site): `npx tsx src/wrenfield/test-aggregate.ts`
 *
 *  1. parser — the 10 Set 1 texts, ≥5 paraphrases per family NOT copied from Set 1, hard negatives;
 *  2. Set 1 routing — every Set 1 task keeps the family the 158 run logged (no answered task re-routed);
 *  3. recon DOM — the Set 1 appointment-list page and chart (fixtures/set1/*.html, cut from recon-158.txt)
 *     through the real browser-side extractors under jsdom, rows checked by hand against the recon text;
 *  4. live reader — ApptList against a simulated Wrenfield list (pager buttons, rows-per-page, 200+
 *     totals, URL-ignored filters, capped lists, duplicated pages, column order, merged/restricted charts);
 *  5. engine — hand-worked cases: boundaries, time zones, flags, ties, inactive providers, decline paths.
 * Exit 1 on any failure.
 */
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
// the simulated lists here have no request budget: the governor (siteBudget.ts) would only sleep between hundreds of reads (tested in siteBudget.test / byDay.test)
process.env.AGENT_LIST_PACE_MS = "0";
import { parseAggQuery, solveAggregate, type AggQuery, type AggSource, type ApptRow, type ResolvedRecord, type ReadFilter } from "./aggregate.js";
import { ApptList, resetBusy, PAGE_EXTRACT, FORM_EXTRACT, parseListPage, mapForm, rangeOf, type RawPage, type RawControl } from "./apptList.js";
import { familyMatch, FAMILY_PATTERNS } from "./families.js";
const plans: string[] = [];

let pass = 0, fail = 0;
const ok = (c: unknown, m: string) => { if (c) { pass++; if (process.env.TA_VERBOSE) console.log("✓ " + m.slice(0, 160)); } else { fail++; console.error("✗ " + m); } };
const fx = (p: string) => readFileSync(new URL("../../fixtures/" + p, import.meta.url), "utf8");

// ───────────────────────── 1. parser ─────────────────────────
const P = (t: string) => parseAggQuery(t);
const Q = (t: string): AggQuery | null => P(t).q;
const fam = (t: string) => { const r = P(t); return r.q ? r.family : null; };

// Set 1 texts (verbatim) → the catalog family, with the fields the answer depends on
{
  const t = "How many patients had at least one completed visit at Willow Creek in August 2025? Count each person once even if they are registered more than once, and leave out test records and deleted records.";
  const q = Q(t)!; ok(q && fam(t) === "location-month-distinct-patients", "set1 distinct: family");
  ok(q?.status === "Completed" && q.scope.kind === "location" && q.scope.location === "Willow Creek" && "from" in q.window && q.window.from === "2025-08-01" && q.window.to === "2025-08-31" && q.exclude.test && q.exclude.deleted, "set1 distinct: fields");
  const s = Q("How many patients have at least one scheduled appointment at Front Range in December 2026? Count each person once even if they are registered more than once, and leave out test records and deleted records.")!;
  ok(s?.status === "Scheduled" && s.scope.kind === "location" && s.scope.location === "Front Range" && "to" in s.window && s.window.to === "2026-12-31", "set1 distinct scheduled: fields");
  for (const [loc, mon] of [["Northgate", "May 2025"], ["Highline", "August 2025"], ["Willow Creek", "November 2025"], ["Eastside", "December 2024"], ["Northgate", "September 2026"]])
    ok(fam(`How many patients had at least one completed visit at ${loc} in ${mon}? Count each person once even if they are registered more than once, and leave out test records and deleted records.`) === "location-month-distinct-patients", `set1 distinct ${loc} ${mon}`);
  ok(fam("How many patients have at least one scheduled appointment at Lakeside in December 2026? Count each person once even if they are registered more than once, and leave out test records and deleted records.") === "location-month-distinct-patients", "set1 distinct Lakeside");
  const b = Q("How many completed visits at Cedar Hollow on 2026-07-27 started before 14:00 local time? Leave out appointments of patients whose record is a test record or has been deleted.")!;
  ok(b && fam("How many completed visits at Cedar Hollow on 2026-07-27 started before 14:00 local time? Leave out appointments of patients whose record is a test record or has been deleted.") === "location-completed-before-time", "set1 before-time: family");
  ok(b?.measure === "appointments" && b.time?.op === "<" && b.time.minute === 840 && b.time.tz === undefined && "from" in b.window && b.window.from === "2026-07-27" && b.exclude.test && b.exclude.deleted, "set1 before-time: fields");
  const tp = "Which three providers had the most completed visits across all locations in January 2025? List them with the most first, by first and last name. Only providers who are active today count. Leave out appointments of patients whose record is a test record or has been deleted. If any are tied, put them in alphabetical order by last name, then first name.";
  const tq = Q(tp)!; ok(tq && fam(tp) === "top-providers-completed-month", "set1 top: family");
  ok(tq?.k === 3 && tq.scope.kind === "all" && tq.activeOnly && tq.tieRule === "last-first" && tq.names === "first-last" && "from" in tq.window && tq.window.from === "2025-01-01", "set1 top: fields");
}

// ≥5 paraphrases per family, written for this test (not Set 1 wording)
const PARA: Array<[string, string, (q: AggQuery) => boolean]> = [
  ["location-month-distinct-patients", "How many different patients were seen at Willow Creek during August 2025? Each person counts once even if they have two charts; leave out test and deleted records.", (q) => q.status === "Completed" && q.exclude.test && q.exclude.deleted],
  ["location-month-distinct-patients", "Number of unique patients with a completed appointment at Northgate in Sept 2026 (exclude test records and deleted records)?", (q) => "from" in q.window && q.window.from === "2026-09-01" && q.window.to === "2026-09-30"],
  ["location-month-distinct-patients", "For Highline, count the distinct patients who had a completed visit in 08/2025. Don't include test or deleted records.", (q) => q.scope.kind === "location" && q.scope.location === "Highline" && "from" in q.window && q.window.from === "2025-08-01" && q.exclude.test],
  ["location-month-distinct-patients", "In December 2026, how many people have a scheduled appointment at Lakeside? Count a person once even if registered twice. Skip test records and deleted ones.", (q) => q.status === "Scheduled" && q.scope.kind === "location" && q.scope.location === "Lakeside"],
  ["location-month-distinct-patients", "At Eastside in December 2024, how many individual patients completed at least one visit? Leave out test and deleted records.", (q) => q.status === "Completed" && "to" in q.window && q.window.to === "2024-12-31"],
  ["location-month-distinct-patients", "How many patients had a completed visit at Willow Creek last month? Count each person once; exclude test records and deleted records.", (q) => "relative" in q.window && q.window.relative === "last-month"],
  ["location-completed-before-time", "How many visits were completed at Cedar Hollow on July 27, 2026 that started before 2 PM local time? Leave out test records and deleted records.", (q) => q.time?.minute === 840 && q.time.op === "<"],
  ["location-completed-before-time", "Count the completed appointments at Northgate on 2026-10-01 starting earlier than 10:30 AM. Exclude test and deleted records.", (q) => q.time?.minute === 630 && q.time.op === "<"],
  ["location-completed-before-time", "At Highline on 07/27/2026, how many completed visits began before noon? Don't count test or deleted patients.", (q) => q.time?.minute === 720 && "from" in q.window && q.window.from === "2026-07-27" && q.exclude.test && q.exclude.deleted],
  ["location-completed-before-time", "Number of completed visits at Cedar Hollow on 27 July 2026 with a start time before 14:00 (local)? Leave out test and deleted records.", (q) => q.time?.minute === 840 && "from" in q.window && q.window.from === "2026-07-27"],
  ["location-completed-before-time", "How many completed visits at Stonebrook on 2026-10-14 started before 9:00 AM MDT? Exclude test records and deleted records.", (q) => q.time?.minute === 540 && q.time.tz === "MDT"],
  ["top-providers-completed-month", "Which 3 providers completed the most visits across all locations in January 2025? Most first, first and last name. Only count providers who are active today. Leave out test records and deleted records. Break ties alphabetically by last name, then first name.", (q) => q.k === 3 && q.tieRule === "last-first" && q.activeOnly],
  ["top-providers-completed-month", "Who were the top two providers by completed visits at any location in March 2025? Only active providers; exclude test and deleted records.", (q) => q.k === 2 && q.scope.kind === "all" && !q.tieRule],
  ["top-providers-completed-month", "Name the five clinicians with the most completed appointments across all of our locations during May 2025. Active providers only, please. Leave out test records and deleted records. Ties: alphabetical by last name, then first name.", (q) => q.k === 5 && q.tieRule === "last-first"],
  ["top-providers-completed-month", "Which provider had the most completed visits across all locations last month? Only providers active today count; leave out test and deleted records.", (q) => q.k === 1 && "relative" in q.window],
  ["top-providers-completed-month", "List the 4 busiest providers (completed visits, all locations) in 2025-02. Active today only. Exclude test records and deleted records. If tied, alphabetical by last name then first name.", (q) => q.k === 4 && "from" in q.window && q.window.from === "2025-02-01" && q.window.to === "2025-02-28"],
  ["top-providers-completed-month", "Rank the top 3 providers for completed visits across every location in April 2025. Only active providers count. Leave out test and deleted records. Alphabetical by last name, then first name if tied.", (q) => q.k === 3 && q.tieRule === "last-first"],
  // same capability, other shapes
  ["aggregate-appointment-count", "How many no-show appointments were there at Riverbend in March 2025? Leave out test records and deleted records.", (q) => q.status === "No-show" && q.measure === "appointments"],
  ["aggregate-appointment-count", "How many late cancellations were there at Prairie View on 2026-09-03? Exclude test and deleted records.", (q) => q.status === "Late cancel"],
  ["aggregate-appointment-count", "How many completed visits did Dr. Roy Nelson have across all locations on 2026-10-13? Leave out test and deleted records.", (q) => q.provider === "Roy Nelson" && q.scope.kind === "all"],
  ["aggregate-distinct-patients", "How many different patients had a cancelled appointment across all locations on 2026-09-30? Exclude test records and deleted records.", (q) => q.status === "Cancelled" && q.scope.kind === "all"],
];
for (const [f, t, chk] of PARA) { const r = P(t); ok(r.q && r.family === f && chk(r.q), `paraphrase → ${f}: ${t.slice(0, 70)} :: ${r.q ? r.family : r.why}`); }

// hard negatives: similar wording, a different question (must not parse)
const NEG = [
  "How many completed visits did Amy Fuller, NP have on 2026-05-16?",                                 // no scope stated (provider-day family words it its own way)
  "Count Aaron Garcia's completed appointments.",                                                      // a patient's own appointments
  "How many open slots are there for Diana Anderson at Northgate on 2026-05-16?",
  "How many patients are left to notify about the recall of lot AB123?",
  "How many completed visits at Cedar Hollow on 2026-07-27 started by 14:00?",                        // inclusive/exclusive not stated
  "How many completed visits at Cedar Hollow on 2026-07-27 started until 2 PM local time?",
  "How many completed visits at Cedar Hollow on 2026-07-27 ended before 14:00?",                      // end time, not start
  "How many completed visits at Cedar Hollow on 2026-07-27 started before 3:00?",                     // 3:00 AM or PM?
  "How many completed visits at Cedar Hollow on 2026-07-27 started around 2 PM?",
  "How many patients had a completed visit at Willow Creek in August?",                               // no year
  "How many patients had a completed visit at Willow Creek in August 2025 or September 2025?",
  "How many visits at Northgate in May 2025?",                                                        // no status
  "Which three providers had the fewest completed visits across all locations in January 2025?",
  "What is the average number of completed visits per day at Northgate in May 2025?",
  "How many new patients did Northgate see in May 2025?",
  "How many invoices were issued at Northgate in May 2025?",
  "How many completed visits did Northgate have between May 1, 2025 and May 15, 2025?",
  "How many patients had both a completed and a cancelled visit at Northgate in May 2025?",
  "Which three providers had the most completed visits at Northgate and Eastside in January 2025?",
  "How many completed visits for Maria Lopez (DOB 1980-01-01) at Northgate in May 2025?",
  "How many telehealth visits were completed at Northgate in May 2025?",
  "Is Judith Jackson (born 2004-11-12) new or established for Kenneth Sullivan, NP on 2028-07-20?",
  "How many patients had a completed visit in May 2025?",                                            // scope not stated
  "Which three providers had the most completed visits across all locations in January 2025? List them as last name, first name.",
  "How many completed visits did Northgate have in the week of May 4, 2025?",
  "Which three inactive providers had the most completed visits across all locations in January 2025?",
  "What phone number do we have on file for patient Carol Jones (born 1982-09-07)?",
  "How many completed visits did Maria Lopez have at Northgate in May 2025?",                          // a patient named without DOB
];
for (const t of NEG) { const r = P(t); ok(!r.q, `negative must not parse: ${t.slice(0, 80)} → ${r.q ? r.family : "ok"}`); }

// ───────────────────────── 2. Set 1 routing unchanged ─────────────────────────
{
  // The 158 run's family per task: from its log when present (gitignored), else from the catalog patterns
  // alone (unchanged since 158), over the committed Set 1 queue.
  const regexFamily = (t: string) => { for (const [f, ps] of FAMILY_PATTERNS as Array<[string, RegExp[]]>) if (ps.some((p) => p.test(t.trim()))) return f; return null; };
  let log: Array<{ text: string; family: string | null; result: any }>;
  try { log = fx("set1/run-158-set1.log").split("\n").filter((l) => l.startsWith('{"event":"item"')).map((l) => JSON.parse(l)).filter((r) => r.kind === "task"); }
  catch { log = fx("set1-items.jsonl").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.kind === "task").map((r) => ({ text: r.text, family: regexFamily(r.text), result: r.result })); console.log("(158 log not present: families from the catalog patterns)"); }
  let same = 0; const target = new Set(["location-month-distinct-patients", "location-completed-before-time", "top-providers-completed-month"]);
  for (const r of log) {
    const f = familyMatch(r.text)?.family ?? null;
    if (f === r.family) same++; else ok(false, `Set 1 task re-routed: ${r.family} → ${f}: ${String(r.text).slice(0, 80)}`);
    if (r.result && "answer" in r.result) ok(f === r.family && !target.has(f ?? ""), `answered Set 1 task must keep its family: ${String(r.text).slice(0, 60)}`);
    if (/^provider-day-(scheduled|completed)-count$/.test(r.family ?? "")) {
      // the general parser understands these too (provider + day + all locations); the catalog pattern still routes them first
      const pq = parseAggQuery(r.text).q;
      ok(pq && pq.measure === "appointments" && pq.provider && pq.scope.kind === "all" && pq.window.kind === "day" && pq.status === (r.family!.includes("scheduled") ? "Scheduled" : "Completed"), `provider-day text reads as the same aggregate: ${String(r.text).slice(0, 70)}`);
    } else if (!target.has(r.family ?? "")) ok(!parseAggQuery(r.text).q, `non-aggregate Set 1 text parsed as aggregate: ${String(r.text).slice(0, 80)}`);
    else { const p = parseAggQuery(r.text); ok(p.q && (p as any).family === r.family, `Set 1 aggregate text parses to its family: ${String(r.text).slice(0, 60)}`); if (p.q) plans.push(`${r.family}: ${JSON.stringify({ status: p.q.status, scope: p.q.scope, window: p.q.window, time: p.q.time, k: p.q.k })}`); }
  }
  ok(log.length === 224 && same === 224, `Set 1 routing: ${same}/${log.length} tasks keep the 158 family`);
  console.log("Set 1 aggregate tasks planned offline:\n  " + plans.join("\n  "));
}

// ───────────────────────── 3. recon DOM (Set 1) via jsdom ─────────────────────────
const runIn = <T>(doc: Document, Ev: typeof Event, js: string): T => new Function("doc", "Event", js)(doc, Ev) as T;
{
  const dom = new JSDOM(fx("set1/appt-list-158.html"));
  const raw = runIn<RawPage>(dom.window.document, dom.window.Event as any, PAGE_EXTRACT);
  const pg = parseListPage(raw);
  // Recon text, first rows of /schedule/appointments?start=2026-10-14&end=2026-10-14&status=1:
  //   Oct 14, 2026 | 9:20 AM to 10:20 AM CDT Recurring | Johnson, Elena | Roy Nelson, MD | Northgate | Behavioral health session | Scheduled
  //   Oct 14, 2026 | 9:30 AM to 10:15 AM CDT | Walker, Elizabeth | Diana Diaz, DO | Riverbend | Physical therapy session | Scheduled
  //   … | 8:40 AM to 9:20 AM MDT | Hoffman, Mason | Garrett Espinoza, MD | Stonebrook | New patient visit | Scheduled
  ok(pg.problems.length === 0, "recon page parses without problems: " + pg.problems.join("; "));
  ok(pg.heading?.from === "2026-10-14" && pg.heading?.to === "2026-10-14", "recon heading 'Appointments from Oct 14, 2026 to Oct 14, 2026'");
  const r0 = pg.rows[0];
  ok(r0 && r0.dateISO === "2026-10-14" && r0.start === 560 && r0.end === 620 && r0.tz === "CDT" && r0.patientName === "Johnson, Elena" && r0.patientId === "73284k4465" && r0.provider === "Roy Nelson, MD" && r0.location === "Northgate" && r0.visitType === "Behavioral health session" && r0.status === "Scheduled" && r0.flags.length === 0 && !r0.unknownBadge, "recon row 1 (recurring) read by labels");
  const hoff = pg.rows.find((r) => r.patientName === "Hoffman, Mason");
  ok(hoff && hoff.start === 520 && hoff.tz === "MDT" && hoff.location === "Stonebrook", "recon Stonebrook row keeps its MDT label");
  ok(pg.rows.length === 6 && new Set(pg.rows.map((r) => r.key)).size === 6, `recon fragment: 6 complete rows with distinct keys (got ${pg.rows.length})`);
  // Hand-worked on those 6 rows: scheduled at Northgate = Johnson Elena, Graham Brian, Gomez Susan → 3 people.
  ok(pg.rows.filter((r) => r.location === "Northgate").map((r) => r.patientId).length === 3, "recon: 3 Northgate rows");
  // column order must not matter: reverse the header and every row
  const rev: RawPage = { ...raw, tables: raw.tables.map((t) => ({ ...t, headers: [...t.headers].reverse(), rows: t.rows.map((r) => [...r].reverse()) })) };
  const pr = parseListPage(rev);
  ok(pr.problems.length === 0 && JSON.stringify(pr.rows) === JSON.stringify(pg.rows), "reordered columns give identical rows");
  // a missing Status column is a problem, not a guess
  const noStatus: RawPage = { ...raw, tables: raw.tables.map((t) => ({ ...t, headers: t.headers.map((h) => h === "Status" ? "Notes" : h) })) };
  ok(parseListPage(noStatus).problems.length > 0, "no Status column → problem");
  // the filter form: controls by label (Set 1 names start/end; roster grouped Active/Inactive)
  const f = runIn<{ controls: RawControl[] }>(dom.window.document, dom.window.Event as any, FORM_EXTRACT);
  const m = mapForm(f.controls);
  ok(m.from?.name === "start" && m.to?.name === "end" && m.status?.name === "status" && m.location?.name === "location" && m.provider?.name === "provider", "Set 1 form mapped by label (start/end/status/location/provider)");
  ok(m.location!.options.filter((o) => o.value).length === 10 && m.location!.options.some((o) => o.text === "Cedar Hollow"), "10 locations offered");
  const act = m.provider!.options.filter((o) => o.group === "Active").length, inact = m.provider!.options.filter((o) => o.group === "Inactive").length;
  ok(act === 72 && inact === 8, `roster groups Active ${act} / Inactive ${inact} (recon: 72 / 8)`);
  ok(m.status!.options.find((o) => o.text === "Completed")?.value === "2", "status Completed = 2 on Set 1");
  // Set 1 chart page: resolve() reads the record id from the chart-section links and the DOB
  const cdom = new JSDOM(fx("set1/chart-158.html"));
  const fake: any = { today: "2026-10-14", navTo: async () => true, evalTop: async () => "", pickerLabel: async () => "", ensureAllLocations: async () => true, trace: () => {}, evalApp: async (js: string) => runIn(cdom.window.document, cdom.window.Event as any, js) };
  const al = new ApptList(fake); al.begin(10000);
  const rec = await al.resolve("73284k4465");
  ok(rec?.canonicalId === "73284k4465" && rec.dobISO === "2000-10-02" && rec.flags.length === 0 && !rec.mergedBanner && rec.name === "Johnson, Elena", "Set 1 chart: id, name, DOB 10/02/2000, no badges");
}

// ───────────────────────── 4. live reader vs a simulated list ─────────────────────────
type SimRow = { date: string; time: string; tz: string; pid: string; name: string; badges?: string; prov: string; loc: string; type: string; status: string };
/** `more`: the Set 1 list (run 146): "Showing 20 of about 1,000 appointments" + a "Show more" button that appends
 *  `step` rows. `approxOver`: totals above it are shown as "about N" (rounded to `round`, shifted by `bias`);
 *  `endExact`: once everything is loaded the footer says "Showing N of N"; `silentCap`: past capAt the button just
 *  disappears (no "No more results"); `reorderOnMore`: a load re-sorts rows already shown. */
type MoreOpts = { step: number; approxOver: number; round?: number; bias?: number; endExact?: boolean; silentCap?: boolean; reorderOnMore?: boolean; set1?: boolean; busyAt?: number[];
  /** the site's footer once a CUT list ends takes the finished form ("about N appointments", no button) — what the patient search did in run 146 */ cutShowsEnd?: boolean;
  /** the finished-list estimate differs from the first page's by this much */ driftEnd?: number;
  /** the first n list loads are the degraded "Wrenfield is busy … fewer rows than usual" page (40 rows, Show more does nothing) */ busyFirst?: number };
/** `set1` (run 164, real Set 1 pages): when everything is loaded the footer becomes "about N appointments" (no
 *  "Showing", no button); at the cap the button is still offered and pressing it only takes the button away
 *  ("Showing 300 of about 1,000" stays). `busyAt`: those presses fail once with "Wrenfield is not responding". */
type SimOpts = { /** from the n-th page load on, the list page is the app's "This account is suspended" page (run 265) */ refuseFrom?: number; provs?: Array<[string, string]>; more?: MoreOpts; emptyAfterCap?: boolean; reloadOnClick?: number; dropLocWhenFiltered?: boolean; perPageOpts?: number[]; urlIgnored?: boolean; plusOver?: number; capAt?: number; dupPage2?: boolean; params?: "set1" | "practice"; columns?: string[]; top?: string; charts?: Record<string, { name: string; dob: string; badges?: string; mergedInto?: string; restricted?: boolean }> };
const LOCS = ["Northgate", "Willow Creek", "Cedar Hollow", "Stonebrook"];
const PROVS: Array<[string, string]> = [["Angel Aguilar, PA", "Active"], ["Barrett Brooks, MD", "Active"], ["Carlos Chen, NP", "Active"], ["Ana Cruz, NP", "Active"], ["Danielle Castro, NP", "Inactive"]];
const STAT = ["Scheduled", "Completed", "Cancelled", "Late cancel", "No-show"];
const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const longDate = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return `${mon[m - 1]} ${d}, ${y}`; };
class SimSite {
  dom = new JSDOM("<!doctype html><html><body></body></html>");
  path = "/"; st = { from: "2026-10-14", to: "2026-10-14", status: "", location: "", provider: "", page: 1, per: 25 };
  navs = 0; clicks = 0; visited: string[] = []; busyLeft = 0; degraded = false;
  constructor(public rows: SimRow[], public o: SimOpts = {}) { this.busyLeft = o.more?.busyFirst ?? 0; }
  get doc() { return this.dom.window.document; }
  get provs() { return this.o.provs ?? PROVS; }
  names() { return this.o.params === "practice" ? { from: "from", to: "to" } : { from: "start", to: "end" }; }
  filtered() {
    const s = this.st;
    return this.rows.filter((r) => r.date >= s.from && r.date <= s.to && (!s.status || STAT[+s.status - 1] === r.status) && (!s.location || LOCS[+s.location - 1] === r.loc) && (!s.provider || this.provs[+s.provider - 1][0] === r.prov))
      .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.pid.localeCompare(b.pid));
  }
  nav(path: string) {
    this.navs++; this.visited.push(path); const u = new URL("http://x" + path); this.path = u.pathname + u.search;
    if (u.pathname === "/schedule/appointments" && this.o.refuseFrom !== undefined && this.navs >= this.o.refuseFrom) {
      this.doc.body.innerHTML = `<section role="alert"><h1>This account is suspended</h1><p>You cannot use Wrenfield with this account at the moment. Try again later, or ask your practice administrator.</p></section><div role="status" hidden>Wrenfield is not responding. Try again in a moment.</div>`;
    } else if (u.pathname === "/schedule/appointments") {
      const n = this.names(); const q = u.searchParams;
      if (!this.o.urlIgnored) this.st = { ...this.st, from: q.get(n.from) ?? "2026-10-14", to: q.get(n.to) ?? "2026-10-14", status: q.get("status") ?? "", location: q.get("location") ?? "", provider: q.get("provider") ?? "", page: 1 };
      else this.st = { ...this.st, page: 1 };
      this.degraded = this.busyLeft > 0; if (this.degraded) this.busyLeft--;
      this.renderList();
    } else if (u.pathname.startsWith("/patients/")) this.renderChart(u.pathname.split("/")[2]);
    else this.doc.body.innerHTML = "<h1>Schedule</h1><p>Today</p>";
  }
  renderChart(id: string) {
    const c = this.o.charts?.[id]; const d = this.doc;
    if (!c) { d.body.innerHTML = "<h1>This page is not available</h1>"; return; }
    if (c.restricted) { d.body.innerHTML = `<section><h1>This chart is restricted</h1><p>Give a reason to open it.</p></section>`; return; }
    const sid = c.mergedInto ?? id; const s = this.o.charts![sid];
    if (s.restricted) { d.body.innerHTML = `<section><h1>This chart is restricted</h1></section>`; return; }
    d.body.innerHTML = `${c.mergedInto ? `<p>The record with MRN HG1 was merged into this record</p><p>What was filed under it is shown here.</p>` : ""}<header><div><h1>${s.name}</h1>${s.badges ? `<span>${s.badges}</span>` : ""}</div><dl><dt>MRN</dt><dd>HG2</dd><dt>Date of birth</dt><dd>${s.dob.slice(5, 7)}/${s.dob.slice(8)}/${s.dob.slice(0, 4)} (40 years)</dd></dl></header><nav aria-label="Chart sections"><a href="/patients/${sid}">Demographics</a><a href="/patients/${sid}/appointments">Appointments</a></nav>`;
  }
  renderMore(m: MoreOpts) {
    const d = this.doc, s = this.st, n = this.names();
    const all = this.filtered(); const cap = this.o.capAt ?? Infinity; const visible = all.slice(0, cap);
    const loads = s.page; const shown = visible.slice(0, this.degraded ? Math.min(loads * m.step, 40) : loads * m.step);
    const pressedPastCap = !!m.set1 && visible.length < all.length && (loads - 1) * m.step >= visible.length;
    if (m.reorderOnMore && loads > 1) shown.reverse();
    const total = all.length; const about = total > m.approxOver;
    const est = Math.round((total + (m.bias ?? 0)) / (m.round ?? 25)) * (m.round ?? 25);
    const allIn = shown.length >= visible.length;
    const capped = visible.length < all.length && allIn;
    const pastCap = capped && !m.silentCap && !m.set1 && loads * m.step > visible.length + m.step - 1;
    if (pastCap) { // the press after the cap: an empty "No more results"
      d.body.innerHTML = `<h1>Schedule</h1><section><h2><span>Appointments from ${longDate(s.from)} to ${longDate(s.to)}</span></h2><p>No more results.</p><p>about ${est} appointments</p><button type="button" disabled>Show more</button></section>`;
      return;
    }
    const endForm = !this.degraded && m.set1 && about && allIn && (!capped || !!m.cutShowsEnd);
    // Set 1: a finished list under the "about" threshold states its exact count ("84 appointments", probe-278-appts-northgate-exact89)
    const endExact = !this.degraded && m.set1 && !about && allIn && !capped && total > 0;
    const footer = total === 0 ? "No appointments match" : endForm ? `about ${(est + (m.driftEnd ?? 0)).toLocaleString("en-US")} appointments` : endExact ? `${total} appointments` : about && !(allIn && !capped && m.endExact) ? `Showing ${shown.length} of about ${est.toLocaleString("en-US")} appointments` : `Showing ${shown.length} of ${total.toLocaleString("en-US")} appointments`;
    const offerMore = this.degraded ? true : endForm || endExact ? false : m.set1 ? (!allIn || (capped && !pressedPastCap)) : !allIn || (capped && !m.silentCap);
    const cols = ["Date", "Time", "Patient", "Provider", "Visit type", "Status", ...(s.location ? [] : ["Location"])];
    const cell = (r: SimRow, c: string) => ({ Date: `<a href="/patients/${r.pid}/appointments/${r.pid}${r.date}${r.time.replace(/\W/g, "")}">${longDate(r.date)}</a>`, Time: `${r.time} <span>${r.tz}</span>`,
      Patient: `<a href="/patients/${r.pid}">${r.name}</a> ${r.badges ? `<span>${r.badges}</span>` : ""}`, Provider: r.prov, Location: r.loc, "Visit type": r.type, Status: `<span>${r.status}</span>` } as Record<string, string>)[c];
    const opt = (v: string, t: string, cur: string) => `<option value="${v}"${v === cur ? " selected" : ""}>${t}</option>`;
    d.body.innerHTML = `<h1>Schedule</h1><form aria-label="Filter appointments">
      <label for="start">From</label><input id="start" name="${n.from}" type="date" value="${s.from}"><label for="end">To</label><input id="end" name="${n.to}" type="date" value="${s.to}">
      <label for="location">Location</label><select id="location" name="location">${opt("", "All locations", s.location)}${LOCS.map((l, i) => opt(String(i + 1), l, s.location)).join("")}</select>
      <label for="provider">Provider</label><select id="provider" name="provider">${opt("", "All providers", s.provider)}<optgroup label="Active">${this.provs.map((p, i) => p[1] === "Active" ? opt(String(i + 1), p[0], s.provider) : "").join("")}</optgroup><optgroup label="Inactive">${this.provs.map((p, i) => p[1] === "Inactive" ? opt(String(i + 1), p[0], s.provider) : "").join("")}</optgroup></select>
      <label for="status">Status</label><select id="status" name="status">${opt("", "All statuses", s.status)}${STAT.map((x, i) => opt(String(i + 1), x, s.status)).join("")}</select>
      <button type="submit">Show appointments</button></form>
      <section><h2><span>Appointments from ${longDate(s.from)} to ${longDate(s.to)}</span></h2>
      <table><caption>Appointments, earliest first</caption><thead><tr>${cols.map((c) => `<th>${c}</th>`).join("")}</tr></thead>
      <tbody>${shown.map((r) => `<tr>${cols.map((c) => `<td>${cell(r, c)}</td>`).join("")}</tr>`).join("")}</tbody></table>
      ${this.degraded ? `<p role="status">Wrenfield is busy, so this list shows fewer rows than usual. Open it again in a moment to see all of them.</p>` : ""}
      <div><p aria-live="polite">${footer}</p>${offerMore ? `<div><button type="button">Show more</button></div>` : ""}</div></section>
      <div aria-hidden="true"><button>Show more</button></div>`;
    const more = [...d.querySelectorAll("section button")].find((x) => x.textContent === "Show more");
    more?.addEventListener("click", () => {
      this.clicks++;
      if (m.busyAt?.includes(this.clicks)) { const st = d.createElement("div"); st.setAttribute("role", "status"); st.textContent = "Wrenfield is not responding. Try again in a moment."; d.body.appendChild(st); return; }
      this.st.page++; this.renderList();
    });
  }
  renderList() {
    if (this.o.more) return this.renderMore(this.o.more);
    const d = this.doc, s = this.st, n = this.names();
    const all = this.filtered(); const cap = this.o.capAt ?? Infinity; const visible = all.slice(0, cap);
    const start = (s.page - 1) * s.per; let pageRows = visible.slice(start, start + s.per);
    if (this.o.dupPage2 && s.page === 2) pageRows = visible.slice(0, s.per);
    const total = all.length; const plus = this.o.plusOver !== undefined && total > this.o.plusOver;
    let cols = this.o.columns ?? ["Date", "Time", "Patient", "Provider", "Location", "Visit type", "Status"];
    if (this.o.dropLocWhenFiltered && s.location) cols = cols.filter((c) => c !== "Location"); // practice: one location → no Location column
    const cell = (r: SimRow, c: string) => ({
      Date: `<a href="/patients/${r.pid}/appointments/${r.pid}${r.date}${r.time.replace(/\W/g, "")}">${longDate(r.date)}</a>`, Time: `${r.time} <span>${r.tz}</span>`,
      Patient: `<a href="/patients/${r.pid}">${r.name}</a> ${r.badges ? `<span>${r.badges}</span>` : ""}`, Provider: r.prov, Location: r.loc, "Visit type": r.type, Status: `<span>${r.status}</span>`, Notes: "",
    } as Record<string, string>)[c];
    const opt = (v: string, t: string, cur: string) => `<option value="${v}"${v === cur ? " selected" : ""}>${t}</option>`;
    const b = start + pageRows.length;
    const footer = total === 0 ? "No appointments match" : total <= 25 && !(this.o.perPageOpts && s.per !== 25) && s.per >= total ? `${total} appointments` : `Showing ${start + 1} to ${b} of ${plus ? this.o.plusOver + "+" : total} appointments`;
    const lastPage = b >= visible.length && !(this.o.emptyAfterCap && visible.length < all.length && pageRows.length > 0);
    if (this.o.emptyAfterCap && pageRows.length === 0 && s.page > 1) { // practice: past the cap, an empty page
      d.body.innerHTML = `<h1>Schedule</h1><section><h2><span>Appointments from ${longDate(s.from)} to ${longDate(s.to)}</span></h2><p>No more results.</p><p>${this.o.plusOver}+ appointments</p><button type="button">Previous</button><button type="button" disabled>Next</button></section>`;
      return;
    }
    d.body.innerHTML = `<h1>Schedule</h1><form aria-label="Filter appointments">
      <label for="start">From</label><input id="start" name="${n.from}" type="date" value="${s.from}"><label for="end">To</label><input id="end" name="${n.to}" type="date" value="${s.to}">
      <label for="location">Location</label><select id="location" name="location">${opt("", "All locations", s.location)}${LOCS.map((l, i) => opt(String(i + 1), l, s.location)).join("")}</select>
      <label for="provider">Provider</label><select id="provider" name="provider">${opt("", "All providers", s.provider)}<optgroup label="Active">${PROVS.map((p, i) => p[1] === "Active" ? opt(String(i + 1), p[0], s.provider) : "").join("")}</optgroup><optgroup label="Inactive">${PROVS.map((p, i) => p[1] === "Inactive" ? opt(String(i + 1), p[0], s.provider) : "").join("")}</optgroup></select>
      <label for="status">Status</label><select id="status" name="status">${opt("", "All statuses", s.status)}${STAT.map((x, i) => opt(String(i + 1), x, s.status)).join("")}</select>
      <button type="submit">Show appointments</button></form>
      <section><h2><span>Appointments from ${longDate(s.from)} to ${longDate(s.to)}</span></h2>
      <table><caption>Appointments, earliest first</caption><thead><tr>${cols.map((c) => `<th>${c === "Date" ? `<button>Date<span>, earliest first. Change the order</span></button>` : c}</th>`).join("")}</tr></thead>
      <tbody>${pageRows.map((r) => `<tr>${cols.map((c) => `<td>${cell(r, c)}</td>`).join("")}</tr>`).join("")}</tbody></table>
      <p>${footer}</p>
      ${this.o.perPageOpts ? `<label>Rows per page <select>${this.o.perPageOpts.map((v) => opt(String(v), `${v} per page`, String(s.per))).join("")}</select></label>` : ""}
      ${total > s.per ? `<button type="button"${s.page === 1 ? " disabled" : ""}>Previous</button><button type="button">1</button><button type="button"${lastPage ? " disabled" : ""}>Next</button>` : ""}</section>
      <div aria-hidden="true"><button>Next</button></div>`;
    const next = [...d.querySelectorAll("section button")].find((x) => x.textContent === "Next");
    next?.addEventListener("click", () => {
      this.clicks++; if ((next as HTMLButtonElement).disabled) return;
      // practice session expiry: this click reloads the app — the list is back on page 1 at 25 rows
      if (this.o.reloadOnClick !== undefined && this.clicks === this.o.reloadOnClick) { this.st.page = 1; this.st.per = 25; this.renderList(); return; }
      this.st.page++; this.renderList();
    });
    const pp = d.querySelector("label select") as HTMLSelectElement | null;
    pp?.addEventListener("change", () => { this.st.per = Number(pp.value); this.st.page = 1; this.renderList(); });
    const form = d.querySelector("form")!;
    d.querySelector("form button")!.addEventListener("click", () => {
      const v = (nm: string) => (form.querySelector(`[name="${nm}"]`) as HTMLInputElement).value;
      this.st = { ...this.st, from: v(n.from), to: v(n.to), status: v("status"), location: v("location"), provider: v("provider"), page: 1 }; this.renderList();
    });
  }
  crawler(): any {
    return {
      today: "2026-10-14", trace: () => {},
      navTo: async (p: string) => { this.nav(p); return true; },
      evalTop: async (js: string) => /pathname/.test(js) ? this.path : (this.o.top ?? "Location: All locations. Change location"),
      evalApp: async (js: string) => runIn(this.doc, this.dom.window.Event as any, js),
      // the simulated session picker can't be repaired: a stuck single-location picker stays stuck
      pickerLabel: async () => this.o.top ?? "Location: All locations. Change location",
      ensureAllLocations: async () => /all locations/i.test(this.o.top ?? "All locations"),
    };
  }
}
// deterministic people
let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const word = (n: number) => Array.from({ length: n }, () => "bcdfghjklmnprstvwz"[Math.floor(rnd() * 18)] + "aeiou"[Math.floor(rnd() * 5)]).join("");
const cap1 = (s: string) => s[0].toUpperCase() + s.slice(1);
const row = (p: Partial<SimRow> & { pid: string; name: string }): SimRow => ({ date: "2025-08-05", time: "9:00 AM to 9:20 AM", tz: "CDT", prov: "Angel Aguilar, PA", loc: "Willow Creek", type: "Office visit", status: "Completed", ...p });

{
  // Willow Creek, August 2025, Completed — worked by hand:
  //   a1 Adams, Keith ×3 → 1 · b1 Brown, Lisa → 1 · c1 Carter, Karen + c2 "Carter, Karin" (Merged into c1) → 1
  //   d1 Diaz, Omar (Test record) → 0 · e1 Evans, Mia (Deleted) → 0 · f1 Farrell, Megan (Restricted) → 1
  //   g1 Green, Paul (1970-01-01) + g2 Green, Paul (1985-05-05) → 2 different people
  //   h1 Hill, Ann only Jul 31 and Sep 1 → 0 · i1 Ito, Ken only Cancelled → 0 · j1 Jones, Amy at Northgate → 0
  //   + 40 one-visit patients with unrelated names → 40.   Expected: 1+1+1+1+2+40 = 46.
  const rows: SimRow[] = [
    row({ pid: "a1", name: "Adams, Keith", date: "2025-08-01", time: "7:00 AM to 7:20 AM" }), row({ pid: "a1", name: "Adams, Keith", date: "2025-08-12" }), row({ pid: "a1", name: "Adams, Keith", date: "2025-08-31", time: "4:40 PM to 5:00 PM" }),
    row({ pid: "b1", name: "Brown, Lisa", date: "2025-08-02" }),
    row({ pid: "c1", name: "Carter, Karen", date: "2025-08-03" }), row({ pid: "c2", name: "Carter, Karin", badges: "Merged", date: "2025-08-20" }),
    row({ pid: "d1", name: "Diaz, Omar", badges: "Test record", date: "2025-08-04" }), row({ pid: "e1", name: "Evans, Mia", badges: "Deleted", date: "2025-08-06" }),
    row({ pid: "f1", name: "Farrell, Megan", badges: "Restricted", date: "2025-08-07" }),
    row({ pid: "g1", name: "Green, Paul", date: "2025-08-08" }), row({ pid: "g2", name: "Green, Paul", date: "2025-08-09" }),
    row({ pid: "h1", name: "Hill, Ann", date: "2025-07-31" }), row({ pid: "h1", name: "Hill, Ann", date: "2025-09-01" }),
    row({ pid: "i1", name: "Ito, Ken", date: "2025-08-10", status: "Cancelled" }), row({ pid: "j1", name: "Jones, Amy", date: "2025-08-11", loc: "Northgate" }),
  ];
  for (let i = 0; i < 40; i++) rows.push(row({ pid: "z" + i, name: `${cap1(word(4))}, ${cap1(word(3))}`, date: `2025-08-${String(1 + (i % 28)).padStart(2, "0")}`, time: `${8 + (i % 4)}:00 AM to ${8 + (i % 4)}:20 AM` }));
  const charts: SimOpts["charts"] = { c1: { name: "Carter, Karen", dob: "1960-02-02" }, c2: { name: "Carter, Karin", dob: "1960-02-03", mergedInto: "c1" }, g1: { name: "Green, Paul", dob: "1970-01-01" }, g2: { name: "Green, Paul", dob: "1985-05-05" }, f1: { name: "Farrell, Megan", dob: "1990-01-01", restricted: true } };
  for (const r of rows) charts![r.pid] ??= { name: r.name, dob: "1950-01-01" };
  const q = Q("How many patients had at least one completed visit at Willow Creek in August 2025? Count each person once even if they are registered more than once, and leave out test records and deleted records.")!;
  const run = async (o: SimOpts, budget = 60000) => { const site = new SimSite(rows, { charts, ...o }); const al = new ApptList(site.crawler()); al.begin(budget); const out = await solveAggregate(q, al); return { out, site, al }; };

  let r = await run({});
  ok("answer" in r.out && r.out.answer === "46", `sim distinct, 25/page, Set 1 param names: ${JSON.stringify(r.out).slice(0, 160)}`);
  ok(r.al.lastStats?.pages === 3 && r.al.lastStats.rows === 53, `read Jul 31..Sep 1 at Willow Creek, Completed: 13 named + 40 one-visit rows = 53 rows in 3 pages (got ${JSON.stringify(r.al.lastStats)})`);
  r = await run({ perPageOpts: [25, 50, 100] });
  ok("answer" in r.out && r.out.answer === "46" && r.al.lastStats?.pages === 1 && r.al.lastStats.pageSize === 100, `rows-per-page raised to 100 → 1 page (${JSON.stringify(r.al.lastStats)})`);
  r = await run({ params: "practice" });
  ok("answer" in r.out && r.out.answer === "46", "practice param names (frto) found by label");
  r = await run({ urlIgnored: true });
  ok("answer" in r.out && r.out.answer === "46" && r.al.lastStats?.via === "form", `URL ignored → form filled and submitted (${JSON.stringify(r.al.lastStats)})`);
  r = await run({ columns: ["Status", "Patient", "Visit type", "Location", "Time", "Provider", "Date"] });
  ok("answer" in r.out && r.out.answer === "46", "reordered columns on the live list");
  r = await run({ columns: ["Date", "Time", "Patient", "Provider", "Location", "Visit type", "Status", "Notes"] });
  ok("answer" in r.out && r.out.answer === "46", "extra column tolerated");
  // practice list: filtered to one location it drops the Location column (live 2026-10-08, Cedar Hollow 2026-07-27)
  r = await run({ dropLocWhenFiltered: true, params: "practice", perPageOpts: [25, 50, 100] });
  ok("answer" in r.out && r.out.answer === "46", `Location column dropped on a location-filtered list → rows take the filtered location (${JSON.stringify(r.out).slice(0, 140)})`);
  {
    const tq2 = Q("How many different patients had a completed appointment across all locations on 2025-08-31? Exclude test records and deleted records.")!;
    const site = new SimSite(rows, { charts, columns: ["Date", "Time", "Patient", "Provider", "Visit type", "Status"] }); const al = new ApptList(site.crawler()); al.begin(60000);
    const out = await solveAggregate(tq2, al);
    ok("why" in out && /no location column/.test(out.why), `no Location column on an all-locations read → decline (${JSON.stringify(out).slice(0, 140)})`);
  }
  r = await run({ plusOver: 20 });
  ok("answer" in r.out && r.out.answer === "46", `"of 20+" totals: walked to the end (${JSON.stringify(r.out).slice(0, 120)})`);
  // a list capped at its own "40+" bound: the month is read again one day at a time (each day's list is short and exact)
  r = await run({ plusOver: 40, capAt: 40 });
  ok("answer" in r.out && r.out.answer === "46" && r.al.lastStats?.via === "by-day", `list capped at its own "40+" bound → read by day → 46 (${JSON.stringify(r.out).slice(0, 140)} ${JSON.stringify(r.al.lastStats)})`);
  r = await run({ plusOver: 1, capAt: 1 });
  ok("why" in r.out && /by day/.test(r.out.why), `every list capped at 1 row (days with 2+ rows too) → decline (${JSON.stringify(r.out).slice(0, 160)})`);
  r = await run({ capAt: 40 });
  ok("why" in r.out && /only 40 of 53|no next page/.test(r.out.why), `list stops before its own total → decline (${JSON.stringify(r.out).slice(0, 140)})`);
  // practice: past the 500-row cap Next leads to an empty "No more results" page → decline at once (not a 9 s wait)
  r = await run({ plusOver: 40, capAt: 40, emptyAfterCap: true });
  ok("answer" in r.out && r.out.answer === "46" && r.al.lastStats?.via === "by-day", `empty page after the cap → read by day → 46 (${JSON.stringify(r.out).slice(0, 140)})`);
  r = await run({ plusOver: 1, capAt: 1, emptyAfterCap: true });
  ok("why" in r.out && /by day.*capped/.test(r.out.why), `empty page after a 1-row cap, also by day → decline (${JSON.stringify(r.out).slice(0, 160)})`);
  // practice session expiry: a click reloads the list on page 1 → one retry on a fresh load reads it all
  r = await run({ reloadOnClick: 1 });
  ok("answer" in r.out && r.out.answer === "46", `list reloaded to page 1 mid-walk → retried on a fresh load (${JSON.stringify(r.out).slice(0, 140)})`);
  r = await run({ dupPage2: true });
  ok("why" in r.out, `page 2 repeats page 1 → decline (${JSON.stringify(r.out).slice(0, 140)})`);
  r = await run({}, 1);
  ok("why" in r.out && /pacer|budget/.test(r.out.why), `no budget → decline (${JSON.stringify(r.out).slice(0, 120)})`);
  // same name AND same date of birth, not linked by a merge → can't tell → decline
  r = await (async () => { const site = new SimSite(rows, { charts: { ...charts, g2: { name: "Green, Paul", dob: "1970-01-01" } } }); const al = new ApptList(site.crawler()); al.begin(60000); return { out: await solveAggregate(q, al), site, al }; })();
  ok("answer" in r.out && r.out.answer === "45", `same name AND same DOB on two records → one person registered twice → 45 (${JSON.stringify(r.out).slice(0, 120)})`);
  // "Carter, Karin" NOT merged (no badge, own chart) with a DOB one day from Karen's → looks like one person twice → decline
  const unmerged = { ...charts, c2: { name: "Carter, Karin", dob: "1960-02-03" } };
  r = await (async () => { const site = new SimSite(rows.map((x) => x.pid === "c2" ? { ...x, badges: undefined } : x), { charts: unmerged }); const al = new ApptList(site.crawler()); al.begin(60000); return { out: await solveAggregate(q, al), site, al }; })();
  ok("why" in r.out && /may be one person/.test(r.out.why), `unmerged misspelled near-twin (DOB 1 day apart) → decline (${JSON.stringify(r.out).slice(0, 140)})`);
  // the same near names with DOBs decades apart are two people → 47
  r = await (async () => { const site = new SimSite(rows.map((x) => x.pid === "c2" ? { ...x, badges: undefined } : x), { charts: { ...unmerged, c2: { name: "Carter, Karin", dob: "1995-07-07" } } }); const al = new ApptList(site.crawler()); al.begin(60000); return { out: await solveAggregate(q, al), site, al }; })();
  ok("answer" in r.out && r.out.answer === "47", `near names, distant DOBs → two people, 47 (${JSON.stringify(r.out).slice(0, 140)})`);
  // same name, one record Restricted (its chart is never opened, so its DOB is unknown) → can't tell → decline
  r = await (async () => { const site = new SimSite([...rows, row({ pid: "k1", name: "Kim, Lee", badges: "Restricted", date: "2025-08-14" }), row({ pid: "k2", name: "Kim, Lee", date: "2025-08-15" })], { charts: { ...charts, k1: { name: "Kim, Lee", dob: "1980-01-01", restricted: true }, k2: { name: "Kim, Lee", dob: "1990-01-01" } } }); const al = new ApptList(site.crawler()); al.begin(60000); return { out: await solveAggregate(q, al), site, al }; })();
  ok("why" in r.out && /date of birth unknown/.test(r.out.why) && !r.site.visited.some((v) => v.includes("/patients/k1")), `same name with a restricted record → decline, restricted chart never opened (${JSON.stringify(r.out).slice(0, 120)})`);
  // a Merged row whose surviving chart is restricted can't be resolved without break-the-glass → decline
  r = await (async () => { const site = new SimSite(rows.map((x) => x.pid === "c2" ? { ...x, badges: "Merged Restricted" } : x), { charts }); const al = new ApptList(site.crawler()); al.begin(60000); return { out: await solveAggregate(q, al), site, al }; })();
  ok("why" in r.out && /restricted/i.test(r.out.why), `restricted Merged row → decline (${JSON.stringify(r.out).slice(0, 120)})`);
  // a badge we have never seen → decline
  r = await (async () => { const site = new SimSite(rows.map((x) => x.pid === "b1" ? { ...x, badges: "Deceased" } : x), { charts }); const al = new ApptList(site.crawler()); al.begin(60000); return { out: await solveAggregate(q, al), site, al }; })();
  ok("why" in r.out && /unknown badge/.test(r.out.why), "unknown badge → decline");
  // the session's location picker on one location → all-location reads decline
  const tq = Q("How many different patients had a completed appointment across all locations on 2025-08-31? Exclude test records and deleted records.")!;
  { const site = new SimSite(rows, { charts, top: "Location: Northgate. Change location" }); const al = new ApptList(site.crawler()); al.begin(60000); const o = await solveAggregate(tq, al); ok("why" in o && /picker/.test(o.why), "all-locations read with a single-location picker → decline"); }
  // practice run 8: picker stuck on Northgate, list filtered to another location showed 0 rows → "0" answered (−1).
  { const site = new SimSite(rows, { charts, top: "Location: Northgate. Change location" }); const al = new ApptList(site.crawler()); al.begin(60000);
    const lq = Q("How many completed appointments were there at Willow Creek in August 2025? Leave out appointments of patients whose record is a test record or has been deleted.");
    const o = lq ? await solveAggregate(lq, al) : { why: "picker (unparsed)" }; ok("why" in o && /picker/.test((o as any).why), "location-filtered read with a single-location picker → decline, never 0"); }
  { const site = new SimSite(rows, { charts }); const al = new ApptList(site.crawler()); al.begin(60000); const o = await solveAggregate(tq, al); ok("answer" in o && o.answer === "1", `all locations on 2025-08-31: only Adams, Keith (got ${JSON.stringify(o).slice(0, 100)})`); }
  // relative month: clinic today 2026-10-14 → "last month" = September 2026 (nothing at Willow Creek then → 0, proven by "No appointments match")
  const lm = Q("How many patients had a completed visit at Willow Creek last month? Count each person once; exclude test records and deleted records.")!;
  { const site = new SimSite(rows, { charts }); const al = new ApptList(site.crawler()); al.begin(60000); const o = await solveAggregate(lm, al); ok("answer" in o && o.answer === "0" && (o.detail as any).from === "2026-09-01" && (o.detail as any).to === "2026-09-30", `last month = Sep 2026 → 0 (${JSON.stringify(o).slice(0, 140)})`); }
}
{
  // scale: a busy location-month (Northgate, May 2025): 1,600 completed rows, 900 patients, "200+" totals, 25/50/100 per page
  const big: SimRow[] = []; const people = Array.from({ length: 900 }, (_, i) => ({ pid: "n" + i, name: `${cap1(word(3))}${i}, ${cap1(word(3))}` }));
  for (let i = 0; i < 1600; i++) { const p = people[i % 900]; big.push(row({ ...p, loc: "Northgate", date: `2025-05-${String(1 + (i % 31)).padStart(2, "0")}`, time: `${8 + (i % 4)}:${String((i * 7) % 60).padStart(2, "0")} AM to 11:59 AM` })); }
  for (let i = 0; i < 300; i++) big.push(row({ pid: "c" + i, name: `Can${i}, Celled`, loc: "Northgate", date: "2025-05-10", status: "Cancelled" }));
  const site = new SimSite(big, { perPageOpts: [25, 50, 100], plusOver: 200, charts: Object.fromEntries(people.map((p) => [p.pid, { name: p.name, dob: "1970-01-01" }])) });
  const al = new ApptList(site.crawler()); al.begin(60000); const t0 = Date.now();
  const o = await solveAggregate(Q("How many patients had at least one completed visit at Northgate in May 2025? Count each person once even if they are registered more than once, and leave out test records and deleted records.")!, al);
  ok("answer" in o && o.answer === "900", `scale: 1,600 rows / 900 people → 900 (${JSON.stringify(o).slice(0, 120)})`);
  // a "200+" bound never proves the end, however far past it the pager stops (listFooter.isComplete): the month is read
  // again one day at a time, each day an exact list (was: 16 pages of 100 accepted as complete at "1501 to 1600 of 200+")
  ok(al.lastStats?.via === "by-day" && al.lastStats.rows === 1600, `scale: "200+" walked to a disabled Next is still unproven → the month's 33 filter days read as exact lists (${JSON.stringify(al.lastStats)}, ${Date.now() - t0} ms in the simulator)`);
  // the pacer projects the remaining pages from date progress under "200+" and stops early
  const al2 = new ApptList(new SimSite(big, { perPageOpts: [25], plusOver: 200 }).crawler()); al2.begin(1500);
  const o2 = await solveAggregate(Q("How many completed visits were there at Northgate in May 2025? Leave out test records and deleted records.")!, al2);
  ok("why" in o2 && /pacer/.test(o2.why), `pacer: 64 pages at 25/page don't fit 1.5 s → decline early (${JSON.stringify(o2).slice(0, 160)})`);
}

{
  // Set 1 (run 146): the appointment list is a "Show more" list with an estimated total — "Showing 20 of about
  // 1,000 appointments" — and no pager; the 146 reader took "1,000 appointments" for an exact count and declined
  // all 10 aggregate tasks with "page shows 20 rows for 'Showing 1 to 1000'".
  //   Willow Creek, August 2025, Completed: 330 rows (Jul 31..Sep 1, 10/day) over 200 patients (scaled down: jsdom is slow); hand count:
  //   patients with ≥1 visit Aug 1..31 = the generator's distinct pids inside the month (computed independently below).
  const people = Array.from({ length: 200 }, (_, i) => ({ pid: "w" + i, name: `${cap1(word(3))}${i}, ${cap1(word(3))}` }));
  const days = Array.from({ length: 33 }, (_, i) => new Date(Date.parse("2025-07-31T00:00:00Z") + i * 86400000).toISOString().slice(0, 10));
  const rows: SimRow[] = []; for (let i = 0; i < 330; i++) { const p = people[(i * 7) % 200]; rows.push(row({ ...p, date: days[i % 33], time: `${8 + (i % 4)}:${String((i * 13) % 60).padStart(2, "0")} AM to 11:59 AM` })); }
  for (let i = 0; i < 40; i++) rows.push(row({ pid: "x" + i, name: `Other${i}, Loc`, loc: "Northgate", date: "2025-08-10" }));
  const inMonth = new Set(rows.filter((x) => x.loc === "Willow Creek" && x.date >= "2025-08-01" && x.date <= "2025-08-31").map((x) => x.pid)).size;
  const charts = Object.fromEntries(people.map((p) => [p.pid, { name: p.name, dob: "1970-01-01" }]));
  const q = Q("How many patients had at least one completed visit at Willow Creek in August 2025? Count each person once even if they are registered more than once, and leave out test records and deleted records.")!;
  const go = async (m: MoreOpts, o: Partial<SimOpts> = {}, budget = 60000) => { const site = new SimSite(rows, { charts, more: m, ...o }); const al = new ApptList(site.crawler()); al.begin(budget); return { out: await solveAggregate(q, al), al, site }; };
  let r = await go({ step: 20, approxOver: 100, endExact: true }, {}, 120000);
  ok("answer" in r.out && r.out.answer === String(inMonth) && /more/.test(r.al.lastStats?.via ?? ""), `Show more to the end, exact total at the end → ${inMonth} (${JSON.stringify(r.out).slice(0, 100)} ${JSON.stringify(r.al.lastStats)})`);
  r = await go({ step: 20, approxOver: 100, bias: 8 }, {}, 120000);
  ok("answer" in r.out && r.out.answer === String(inMonth), `Show more to the end, "about" estimate met, no more offered → ${inMonth} (${JSON.stringify(r.out).slice(0, 100)} ${JSON.stringify(r.al.lastStats)})`);
  // the list is cut at 160 rows with "No more results" (the patient search's cap in run 146) → read by day; days are exact
  r = await go({ step: 20, approxOver: 100 }, { capAt: 60 });
  ok("answer" in r.out && r.out.answer === String(inMonth) && r.al.lastStats?.via === "by-day", `capped at 60 → by day (each ~10 rows, exact) → ${inMonth} (${JSON.stringify(r.out).slice(0, 120)})`);
  // cut silently (the button just goes away) far below the estimate → by day
  r = await go({ step: 20, approxOver: 100, silentCap: true }, { capAt: 60 });
  ok("answer" in r.out && r.out.answer === String(inMonth) && r.al.lastStats?.via === "onward", `silent cut at 60 of about 325 → onward by date → ${inMonth} (${JSON.stringify(r.out).slice(0, 120)} ${JSON.stringify(r.al.lastStats)})`);
  // run 164 (real Set 1): the button stays offered at the 300-row cap and the press only removes it; the end footer
  // is "about N appointments". Scaled: cap 60, 10 rows a day → onward parts of ~6 days each.
  // A list that only ever states an estimate ("about N appointments" once everything is loaded, every part and every day
  // alike) is NEVER proven complete (listFooter.isComplete): a count from it would be an absence answer over an unproven
  // read. The cut list is still walked onward (the part from the last day loads whole), and that part's end footer is
  // where the read stops. (Until footer the estimate within a tolerance was accepted as the end.)
  r = await go({ step: 20, approxOver: 0, set1: true }, { capAt: 60 });
  ok("why" in r.out && /onward from .*estimate/.test(r.out.why), `Set 1 cap (press removes the button) → onward → the whole part's "about N" end footer is no proof → decline (${JSON.stringify(r.out).slice(0, 160)})`);
  r = await go({ step: 20, approxOver: 0, set1: true }, {}, 120000);
  ok("why" in r.out && /estimate/.test(r.out.why) && !/onward|by day/.test(r.out.why), `Set 1 end footer "about N appointments" → no exact total anywhere → decline without a re-read (${JSON.stringify(r.out).slice(0, 160)})`);
  r = await go({ step: 20, approxOver: 0, set1: true, busyAt: [3] }, { capAt: 60 });
  ok("why" in r.out && /onward from .*estimate/.test(r.out.why) && (r.site as any).clicks > 3, `"not responding" on a press → pressed again, walk continued past it, then the estimate end → decline (${JSON.stringify(r.out).slice(0, 140)}; ${(r.site as any).clicks} presses)`);
  r = await go({ step: 20, approxOver: 0, set1: true, bias: 60 }, {}, 120000);
  ok("why" in r.out, `end footer far from the rows read (about N+60) → decline (${JSON.stringify(r.out).slice(0, 140)})`);
  r = await go({ step: 20, approxOver: 0, set1: true }, { capAt: 8 });
  ok("why" in r.out && /one day/.test(r.out.why), `a cap shorter than one day's rows → decline (${JSON.stringify(r.out).slice(0, 140)})`);
  // days themselves estimated ("about") and every list cut silently at 20: never an answer
  r = await go({ step: 20, approxOver: 0, silentCap: true }, { capAt: 5 });
  ok("why" in r.out, `every list cut silently at 5 rows (days hold ~10), all totals estimated → decline (${JSON.stringify(r.out).slice(0, 160)})`);
  // an estimate far from what the list delivered (the cut lies within tolerance of nothing) → decline, never a count
  r = await go({ step: 20, approxOver: 0, bias: 400, silentCap: true });
  ok("why" in r.out, `"about" estimate 400 off the rows delivered → decline (${JSON.stringify(r.out).slice(0, 160)})`);
  // a load that re-sorts rows already read → decline
  r = await go({ step: 20, approxOver: 100, endExact: true, reorderOnMore: true });
  ok("why" in r.out && /changed after Show more/.test(r.out.why), `rows re-ordered by Show more → decline (${JSON.stringify(r.out).slice(0, 140)})`);
  // the pacer declines a list it can't finish (top-providers: about 16,950 rows all locations) without pressing 800 times
  { const big: SimRow[] = []; for (let i = 0; i < 17000; i++) big.push(row({ pid: "t" + (i % 3000), name: `T${i % 3000}, X`, loc: LOCS[i % 4], date: `2025-01-${String(1 + (i % 31)).padStart(2, "0")}` }));
    const site = new SimSite(big, { more: { step: 20, approxOver: 100 } }); const al = new ApptList(site.crawler()); al.begin(3000); const t0 = Date.now();
    const tq = Q("Which three providers had the most completed visits across all locations in January 2025? List them with the most first, by first and last name. Only providers who are active today count. Leave out appointments of patients whose record is a test record or has been deleted. If any are tied, put them in alphabetical order by last name, then first name.");
    ok(!!tq, "top-providers text parses");
    const o = tq ? await solveAggregate(tq, al) : { why: "unparsed" };
    ok("why" in o && /pacer/.test((o as any).why) && site.clicks < 30, `about 16,950 rows in a 3 s budget → pacer declines after ${site.clicks} presses, ${Date.now() - t0} ms (${JSON.stringify(o).slice(0, 160)})`); }
}
{
  // The real Set 1 page (run 146 skip_probe, Willow Creek Aug 2025): page 1 now parses as a Show-more list with an estimate.
  const log = fx("set1/run-146-set1.log").split("\n").filter((l) => l.startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const probes = log.filter((e: any) => e.event === "skip_probe" && /page shows 20 rows/.test(e.why));
  ok(probes.length === 5, `run 146: 5 appointment-list skip probes (got ${probes.length})`);
  for (const p of probes) {
    const dom = new JSDOM(p.html); const raw = runIn<RawPage>(dom.window.document, dom.window.Event as any, PAGE_EXTRACT); const pg = parseListPage(raw);
    const want = String(p.why).match(/to (\d+)"/)![1];
    ok(pg.problems.length === 0 && pg.rows.length === 20 && pg.range?.cumulative && pg.range.approx && pg.range.b === 20 && String(pg.range.total) === want && raw.more?.present && !raw.more.disabled && !raw.next.present,
      `146 probe (${p.family}): 20 rows, "Showing 20 of about ${want}", Show more offered (${JSON.stringify(pg.range)} ${pg.problems.join("; ")})`);
  }
}

{
  // Run 164 (real Set 1 pages after the failed press): the Cedar Hollow 3-day list fully loaded shows the end footer
  // "about 250 appointments" (no "Showing", no button); the location-month lists stop at 300 rows with "Showing 300 of
  // about N" and no button (cut). The probe HTML is cut in the middle (rows), so only footer + button are checked here.
  const log = fx("set1/run-164-set1.log").split("\n").filter((l) => l.startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const probes = log.filter((e: any) => e.event === "skip_probe" && /Show more \d+ did not load/.test(e.why));
  ok(probes.length === 4, `run 164: 4 Show-more skip probes (items 83 115 130 151; 165/195 not probed) (got ${probes.length})`);
  for (const p of probes) {
    const dom = new JSDOM(p.html); const raw = runIn<RawPage>(dom.window.document, dom.window.Event as any, PAGE_EXTRACT);
    const r = rangeOf(raw.footer);
    const cedar = p.family === "location-completed-before-time";
    ok(!raw.more?.present && !raw.notResponding && !!r && r.cumulative === true && r.approx === true && (cedar ? r.end === true && r.total === 250 : !r.end && r.b === 300 && r.total > 300),
      `164 probe (${p.family}): footer "${raw.footer}" → ${cedar ? "end form" : "cut at 300"}, no button, hidden "not responding" ignored (${JSON.stringify(r)})`);
  }
}

// ───────────────────────── 4b. Set 1 finished-list "about N" footer: NEVER a proof; short ranges re-read by day ─────────────────────────
// Run 278 skipped 10 aggregates on "about N" footers. s2 integration (run 265) and s3 integration (run 304) accepted the footer under plausibility
// checks (endFormProof) — and each had Set 3's one wrong answer. s3 keeps the rule (LESSONS §C.4): an estimate never proves a list end
// (run 304's Set 1 log answered 0 tasks on it). The Set 1 site states an EXACT count for a finished list under 100 rows ("84 appointments":
// 81 such footers in run 278), so a short range (≤ BY_DAY_MAX_DAYS) that ends on an estimate is re-read one day at a time and each day
// proves itself; a longer range, or a day that is itself ≥ 100 rows, declines. begin({endEstimate}) now only marks the aggregate engine's
// read (request cap, busy cooldown, no futile press at the 300-row cut).
{
  // The Set 1 image defaults (AGG_MAX_REQ 17, AGG_TABS 1, no busy retries, 60 s cooldown) are tested at the end of this block (4c);
  // everything from here to there exercises the machinery that a larger AGG_MAX_REQ / AGG_TABS / AGG_BUSY_RETRIES switches back on.
  Object.assign(process.env, { AGG_MAX_REQ: "100000", AGG_TABS: "3", AGG_BUSY_RETRIES: "2", AGG_BUSY_COOLDOWN_S: "0" }); resetBusy();
  // simulated Set 1 lists
  const people = Array.from({ length: 700 }, (_, i) => ({ pid: "w" + i, name: `${cap1(word(3))}${i}, ${cap1(word(3))}` }));
  const fmtT = (m: number) => `${(m / 60 | 0) % 12 || 12}:${String(m % 60).padStart(2, "0")} ${m / 60 >= 12 ? "PM" : "AM"}`;
  const days = Array.from({ length: 33 }, (_, i) => new Date(Date.parse("2025-07-31T00:00:00Z") + i * 86400000).toISOString().slice(0, 10));
  const month: SimRow[] = []; for (let i = 0; i < 990; i++) { const p = people[(i * 11) % 700]; const m0 = 420 + ((i * 17) % 600); month.push(row({ ...p, date: days[i % 33], time: `${fmtT(m0)} to ${fmtT(m0 + 20)}` })); }
  for (let i = 0; i < 60; i++) month.push(row({ pid: "n" + i, name: `Other${i}, Loc`, loc: "Northgate", date: days[i % 33] }), row({ pid: "s" + i, name: `Sched${i}, Loc`, status: "Scheduled", date: days[i % 33] }));
  const inMonth = new Set(month.filter((x) => x.loc === "Willow Creek" && x.status === "Completed" && x.date >= "2025-08-01" && x.date <= "2025-08-31").map((x) => x.pid)).size;
  const charts = Object.fromEntries([...people, ...Array.from({ length: 60 }, (_, i) => ({ pid: "n" + i, name: `Other${i}, Loc` }))].map((p) => [p.pid, { name: p.name, dob: "1970-01-01" }]));
  const q = Q("How many patients had at least one completed visit at Willow Creek in August 2025? Count each person once even if they are registered more than once, and leave out test records and deleted records.")!;
  /** `tabs`: spawn extra simulated tabs (each its own SimSite over the rows it is handed) → the parallel chunk read. */
  const go = async (rows: SimRow[], m: MoreOpts, o: Partial<SimOpts> = {}, opts: { endEstimate?: boolean; gate?: (s: number) => boolean } | null = { endEstimate: true }, budget = 120000, query = q, tabs?: ((rows: SimRow[]) => SimRow[]) | "fail") => {
    const mk = (rr: SimRow[]) => new SimSite(rr, { charts, more: m, ...o }); const spawned: SimSite[] = [];
    const site = mk(rows); const al = new ApptList(site.crawler(), undefined, tabs ? async () => { if (tabs === "fail") return null; const t = mk(tabs(rows)); spawned.push(t); return t.crawler(); } : undefined);
    al.begin(budget, opts ?? undefined); const t0 = Date.now(); return { out: await solveAggregate(query, al), al, site, spawned, ms: Date.now() - t0 };
  };
  // the real site's footers: an exact count for a finished list under 100 rows, "about N" (25-row grid) from 100 rows
  const S1 = { step: 20, approxOver: 99, set1: true };
  // the month shape: 990 completed rows over 33 filter days, every list cut at 300 → onward parts; the last part ends on "about N" → decline (as run 278)
  let r = await go(month, S1, { capAt: 300 });
  ok("why" in r.out && /never proves/.test(r.out.why) && !/parallel/.test(r.out.why), `Set 1 month (990 rows, 300-row cuts, the last part a finished list "about N") → decline, the estimate is no proof (${JSON.stringify(r.out).slice(0, 160)})`);
  r = await go(month, S1, { capAt: 300 }, null);
  ok("why" in r.out && /never proves/.test(r.out.why), `the same without the aggregate opt-in → the same decline (${JSON.stringify(r.out).slice(0, 120)})`);
  // Cedar Hollow 2026-07-27 (run 278 item 83; run 265's answer 85 rested on the estimate): 252 completed rows over the widened 3 days,
  // 70 / 95 / 87 a day → the whole range ends on "about 250" (no proof); each day under 100 rows ends on its exact count → proven by day
  const mkCedar = (per: Array<[string, number]>) => { const out: SimRow[] = []; let nn = 0;
    for (const [d, n] of per) for (let i = 0; i < n; i++, nn++) { const m0 = 420 + ((i * 11) % 780); out.push(row({ pid: "c" + nn, name: `Cd${nn}, Pat`, loc: "Cedar Hollow", date: d, time: `${fmtT(m0)} to ${fmtT(m0 + 15)}`, ...(nn % 41 === 3 ? { badges: "Deleted" } : nn % 53 === 5 ? { badges: "Test record" } : {}) })); }
    return out; };
  const cedar = mkCedar([["2026-07-26", 70], ["2026-07-27", 95], ["2026-07-28", 87]]);
  const cq = Q("How many completed visits at Cedar Hollow on 2026-07-27 started before 14:00 local time? Leave out appointments of patients whose record is a test record or has been deleted.")!;
  const chartsOf = (rows: SimRow[]) => Object.fromEntries(rows.map((x) => [x.pid, { name: x.name, dob: "1980-01-01" }]));
  const cchart = chartsOf(cedar);
  const before14 = (rows: SimRow[]) => rows.filter((x) => x.date === "2026-07-27" && !x.badges && ((): boolean => { const mt = x.time.match(/^(\d+):(\d+) (AM|PM)/)!; return ((+mt[1] % 12) + (mt[3] === "PM" ? 12 : 0)) * 60 + +mt[2] < 840; })()).length;
  const wantExact = before14(cedar);
  r = await go(cedar, S1, { charts: cchart }, { endEstimate: true }, 60000, cq);
  ok("answer" in r.out && r.out.answer === String(wantExact) && r.al.lastStats?.via === "by-day-exact" && r.al.lastStats.pages === 3, `Cedar Hollow (252 rows in 3 days, "about 250" at the end) → re-read by day, each day exact → ${wantExact} (${JSON.stringify(r.out).slice(0, 110)} ${JSON.stringify(r.al.lastStats)}; ${r.site.navs} loads, ${r.site.clicks} presses)`);
  ok(r.site.navs >= 4 && r.site.navs <= 6, `the by-day re-read costs the 3 day loads on top of the whole-range read (${r.site.navs} loads)`);
  const baseNavs = r.site.navs;
  r = await go(cedar, S1, { charts: cchart }, null, 60000, cq);
  ok("answer" in r.out && r.out.answer === String(wantExact) && r.al.lastStats?.via === "by-day-exact", `no opt-in: the by-day re-read is the plain reader's own (${JSON.stringify(r.al.lastStats)})`);
  // ── negatives: each must decline, never count ──
  r = await go(month, { ...S1, bias: 60 }, { capAt: 300 });
  ok("why" in r.out, `finished-list estimate 60 off the rows delivered → decline (${JSON.stringify(r.out).slice(0, 150)})`);
  r = await go(cedar, { ...S1, bias: 40 }, { charts: cchart }, { endEstimate: true }, 60000, cq);
  ok("why" in r.out && /whole range shows about/.test(r.out.why), `Cedar list, estimate 'about 300' for 252 rows: the days are exact but do not add up to the range's own statement → decline (${JSON.stringify(r.out).slice(0, 150)})`);
  r = await go(cedar, { ...S1, round: 10, bias: 8 }, { charts: cchart }, { endEstimate: true }, 60000, cq);
  ok("answer" in r.out && r.out.answer === String(wantExact) && r.al.lastStats?.via === "by-day-exact", `an off-grid estimate ("about 260") no longer matters: the days are the proof → ${wantExact} (${JSON.stringify(r.out).slice(0, 110)})`);
  r = await go(cedar, { ...S1, driftEnd: 25 }, { charts: cchart }, { endEstimate: true }, 60000, cq);
  ok("answer" in r.out && r.out.answer === String(wantExact) && r.al.lastStats?.via === "by-day-exact", `an estimate that drifts between the first page and the end: the days are the proof → ${wantExact} (${JSON.stringify(r.out).slice(0, 110)})`);
  const cedarBig = mkCedar([["2026-07-26", 70], ["2026-07-27", 120], ["2026-07-28", 62]]);
  r = await go(cedarBig, S1, { charts: chartsOf(cedarBig) }, { endEstimate: true }, 60000, cq);
  ok("why" in r.out && /by day: 2026-07-27/.test(r.out.why) && /never proves/.test(r.out.why), `a day of 120 rows ends on "about 125" itself → that day cannot be proven → decline (${JSON.stringify(r.out).slice(0, 170)})`);
  const tenDays = mkCedar(Array.from({ length: 10 }, (_, i) => [new Date(Date.parse("2026-07-20T00:00:00Z") + i * 86400000).toISOString().slice(0, 10), 25] as [string, number]));
  const tq10 = Q("How many patients had at least one completed visit at Cedar Hollow in July 2026? Count each person once even if they are registered more than once, and leave out test records and deleted records.")!;
  r = await go(tenDays, S1, { charts: chartsOf(tenDays) }, { endEstimate: true }, 60000, tq10);
  ok("why" in r.out && /daywise re-read limit/.test(r.out.why) && r.al.lastStats === null, `a 10-day range (250 rows) ending on "about 250" → over the daywise re-read limit → decline (${JSON.stringify(r.out).slice(0, 150)})`);
  r = await go(cedar, S1, { charts: cchart }, { endEstimate: true }, 2500, cq);
  ok("why" in r.out && /pacer/.test(r.out.why), `the by-day re-read needs ~1.5 s a day: no budget for it → decline (${JSON.stringify(r.out).slice(0, 150)})`);
  // a CUT list (patient-search style: 160 rows of "about 250"): the onward part from the last day shown holds 182 rows and ends on "about 175" → no proof
  r = await go(cedar, S1, { charts: cchart, capAt: 160 }, { endEstimate: true }, 60000, cq);
  ok("answer" in r.out && r.out.answer === String(wantExact) && r.al.lastStats?.via === "onward", `list cut at 160 rows ("Showing 160 of about 250", button gone): onward parts, the last one (07-28, 87 rows) ends on its exact count → ${wantExact} (${JSON.stringify(r.out).slice(0, 110)} ${JSON.stringify(r.al.lastStats)})`);
  r = await go(cedar, { ...S1, cutShowsEnd: true }, { charts: cchart, capAt: 160 }, { endEstimate: true }, 60000, cq);
  ok("answer" in r.out && r.out.answer === String(wantExact) && r.al.lastStats?.via === "by-day-exact", `cut at 160 but the footer takes the finished form 'about 250' (run 146's short patient search): never trusted — the by-day re-read reads every row → ${wantExact} (${JSON.stringify(r.al.lastStats)})`);
  // the degraded page (AGG_BUSY_RETRIES=2 here): read again from a fresh load (transient), or decline (persistent); rows of a busy page are never counted
  r = await go(cedar, { ...S1, busyFirst: 2 }, { charts: cchart }, { endEstimate: true }, 60000, cq); // the first list load is the form read (loadForm); the second is the read's own
  ok("answer" in r.out && r.out.answer === String(wantExact) && r.site.navs > baseNavs, `site busy on the first load → read again from a fresh load → ${wantExact} (${JSON.stringify(r.out).slice(0, 110)}; ${r.site.navs} navs vs ${baseNavs})`);
  r = await go(cedar, { ...S1, busyFirst: 50 }, { charts: cchart }, { endEstimate: true }, 60000, cq);
  ok("why" in r.out && /busy/.test(r.out.why), `site busy on every load → decline after the retries (${JSON.stringify(r.out).slice(0, 150)}; ${r.site.navs} navs)`);
  // unknown badge on a row of a day's list (row 75 = 2026-07-27, 7:55 AM)
  r = await go(cedar.map((x, i) => i === 75 ? { ...x, badges: "Deceased" } : x), S1, { charts: cchart }, { endEstimate: true }, 60000, cq);
  ok("why" in r.out && /unknown badge/.test(r.out.why), `unknown badge among the hits → decline (${JSON.stringify(r.out).slice(0, 120)})`);
  // ── parallel chunks on several tabs (AGG_TABS=3 in this block): every ≤ 7-day chunk ends on an estimate and is proven day by day ──
  {
    r = await go(month, S1, { capAt: 300 }, { endEstimate: true }, 120000, q, (x) => x);
    const presses = r.site.clicks + r.spawned.reduce((t, x) => t + x.clicks, 0);
    ok("answer" in r.out && r.out.answer === String(inMonth) && /^parallel×3$/.test(r.al.lastStats?.via ?? "") && r.spawned.length === 2 && r.spawned.every((x) => x.clicks > 0) && r.site.clicks > 0,
      `3 tabs: the 33-day month read as day chunks in parallel, each chunk by day → ${inMonth} (${JSON.stringify(r.out).slice(0, 100)} ${JSON.stringify(r.al.lastStats)}; presses ${r.site.clicks}+${r.spawned.map((x) => x.clicks).join("+")} = ${presses})`);
    // a tab that never opens → the ordinary sequential read, which declines the month (33 days > the by-day limit)
    r = await go(month, S1, { capAt: 300 }, { endEstimate: true }, 120000, q, "fail");
    ok("why" in r.out && /never proves/.test(r.out.why), `tabs unavailable → the sequential read, which declines the month (${JSON.stringify(r.out).slice(0, 100)})`);
    // a tab that sees 20 rows fewer than the first tab (a chunk silently short): the chunks no longer add up to the whole range's estimate → decline
    const drop = new Set(month.filter((x) => x.loc === "Willow Creek" && x.status === "Completed").slice(100, 120).map((x) => x.pid + x.date + x.time));
    r = await go(month, S1, { capAt: 300 }, { endEstimate: true }, 120000, q, (x) => x.filter((y) => !drop.has(y.pid + y.date + y.time)));
    ok("why" in r.out && /whole range says about/.test(r.out.why), `a tab 20 rows short → chunks do not add up to the whole range's estimate → decline (${JSON.stringify(r.out).slice(0, 170)})`);
    // the degraded page on a tab's first chunk: that chunk is read again; the answer is unchanged
    r = await go(month, { ...S1, busyFirst: 2 }, { capAt: 300 }, { endEstimate: true }, 120000, q, (x) => x);
    ok(!("answer" in r.out) || r.out.answer === String(inMonth), `busy pages on the tabs → the chunks are read again or the task declines (the size probe met the busy page → the sequential read, which declines the month); never a wrong count (${JSON.stringify(r.out).slice(0, 100)} ${JSON.stringify(r.al.lastStats)})`);
    // gate asked once with the parallel estimate (smaller than the sequential one)
    { let asked = 0, est = 0; r = await go(month, S1, { capAt: 300 }, { endEstimate: true, gate: (v) => { asked++; est = v; return true; } }, 120000, q, (x) => x);
      ok("answer" in r.out && asked === 1 && est > 3 && est < 20, `parallel: gate asked once with ~${Math.round(est)} s for ~1,000 rows on 3 tabs (sequential ~20 s)`); }
    // a list whose days are too big to chunk (about 270 rows a day on average: a day would be cut at 300) → decline, no reading
    { const big: SimRow[] = []; for (let i = 0; i < 9000; i++) big.push(row({ pid: "t" + i, name: `T${i}, X`, date: days[i % 33], time: `${8 + (i % 8)}:${String(i % 60).padStart(2, "0")} AM to 11:59 PM` }));
      r = await go(big, S1, { capAt: 300 }, { endEstimate: true }, 120000, q, (x) => x);
      ok("why" in r.out && /rows a day on average/.test(r.out.why) && r.site.clicks === 0, `9,000 rows in 33 days: declined before any press (${JSON.stringify(r.out).slice(0, 150)})`); }
  }
  // ── top-k providers over a month (aggregate.topByEstimate): each provider's January list (~250 rows) ends on "about N" and a month is over
  // the by-day limit, so no provider list can be proven → the task DECLINES (it did in runs 278 / 304 too: item 108 was never answered).
  // Set 1's one such task is given up rather than answered on an estimate; the per-provider path is kept for a clinic whose lists are exact.
  {
    const TP: Array<[string, string]> = [["Alice Adams, MD", "Active"], ["Brian Baker, DO", "Active"], ["Carol Clark, NP", "Active"], ["Dan Davis, MD", "Active"], ["Erin Evans, PA", "Active"], ["Fay Foster, MD", "Active"],
      ["Gus Green, NP", "Active"], ["Hal Hayes, MD", "Active"], ["Ida Irwin, DO", "Active"], ["Jon Jones, MD", "Active"], ["Ken King, MD", "Inactive"], ["Lou Lane, NP", "Inactive"]];
    const tq = Q("Which three providers had the most completed visits across all locations in January 2025? List them with the most first, by first and last name. Only providers who are active today count. Leave out appointments of patients whose record is a test record or has been deleted. If any are tied, put them in alphabetical order by last name, then first name.")!;
    const mkTop = (counts: number[]) => {
      const rows: SimRow[] = [];
      counts.forEach((n, p) => {
        for (let i = 0; i < n; i++) rows.push(row({ pid: `p${p}_${i}`, name: `Pt${p}x${i}, T`, prov: TP[p][0], loc: LOCS[i % 4], date: `2025-01-${String(1 + (i % 31)).padStart(2, "0")}` }));
        for (const d of ["2024-12-31", "2024-12-31", "2025-02-01", "2025-02-01"]) rows.push(row({ pid: `pad${p}${d}${rows.length}`, name: `Pad${p}, T`, prov: TP[p][0], date: d }));
      });
      return rows;
    };
    const topGo = async (rows: SimRow[], tabs = true) => {
      const mk = () => new SimSite(rows, { provs: TP, more: S1 }); const spawned: SimSite[] = [];
      const site = mk(); const al = new ApptList(site.crawler(), undefined, tabs ? async () => { const t = mk(); spawned.push(t); return t.crawler(); } : undefined);
      al.begin(120000, { endEstimate: true }); const out = await solveAggregate(tq, al);
      return { out, al, site, spawned, clicks: site.clicks + spawned.reduce((t, x) => t + x.clicks, 0) };
    };
    let r = await topGo(mkTop([255, 252, 244, 243, 225, 210, 190, 170, 140, 110, 300, 299]));
    ok("why" in r.out && /never proves/.test(r.out.why), `top 3 by per-provider lists (each ~250 rows, "about N" at the end): no list proven → decline, never an answer on the estimate (${JSON.stringify(r.out).slice(0, 160)})`);
    r = await topGo(mkTop([255, 252, 244, 243, 225, 210, 190, 170, 140, 110, 300, 299]), false);
    ok("why" in r.out && /never proves/.test(r.out.why), `no tabs → the same decline (${r.clicks} presses)`);
    r = await topGo(mkTop([40, 30, 25, 20, 15, 10, 5, 4, 3, 2, 35, 36]));
    ok("why" in r.out && /never proves/.test(r.out.why), `a small clinic (whole range ~225 rows, "about 225" at the end): the one-read path declines too (${JSON.stringify(r.out).slice(0, 140)})`);
    r = await topGo(mkTop([12, 8, 5, 2, 1, 1, 1, 1, 1, 1, 3, 3])); // 39 January rows + 48 padding rows = 87 < 100
    ok("answer" in r.out && r.out.answer === "Alice Adams, Brian Baker, Carol Clark", `a clinic whose whole range is under 100 rows ends on its exact count → the one read answers (${JSON.stringify(r.out).slice(0, 120)})`);
  }
  // time budget: the pacer gate is asked once, from the first page; false → no press at all
  r = await go(month, S1, { capAt: 300 }, { endEstimate: true, gate: () => false });
  ok("why" in r.out && /pacer: no slack/.test(r.out.why) && r.site.clicks === 0, `gate says no slack → decline before any Show more press (${JSON.stringify(r.out).slice(0, 140)}; ${r.site.clicks} presses)`);
  { let asked = 0, est = 0; r = await go(month, S1, { capAt: 300 }, { endEstimate: true, gate: (s) => { asked++; est = s; return true; } });
    ok("why" in r.out && asked === 1 && est > 10 && est < 80, `gate asked once with a whole-read estimate (${asked}×, ~${Math.round(est)} s for ~1,000 rows)`); }
  // too many rows for the budget: declined from the first page, ~0 presses
  r = await go(month, S1, { capAt: 300 }, { endEstimate: true }, 3000);
  ok("why" in r.out && /pacer/.test(r.out.why) && r.site.clicks <= 3, `1,000 rows in a 3 s budget → pacer decline after ${r.site.clicks} presses (${JSON.stringify(r.out).slice(0, 120)})`);

  // ── 4c. the image defaults: the site takes ~15 list requests in a row (run 265: 3 tabs, 50+ busy pages, a 503, then "account suspended") ──
  for (const k of ["AGG_MAX_REQ", "AGG_TABS", "AGG_BUSY_RETRIES", "AGG_BUSY_COOLDOWN_S", "AGG_PRESS_GAP_MS", "AGG_TOPK"]) delete process.env[k]; resetBusy();
  // a month list needing ~51 requests: declined from its first page, one list load, no press, no second tab
  r = await go(month, S1, { capAt: 300 }, { endEstimate: true }, 120000, q, (x) => x);
  ok("why" in r.out && /AGG_MAX_REQ/.test(r.out.why) && r.site.clicks === 0 && r.spawned.length === 0 && r.site.navs <= 2, `default: ~1,000 rows = ~51 requests → declined from the first page (${r.site.navs} navs, ${r.site.clicks} presses, ${r.spawned.length} extra tabs): ${JSON.stringify(r.out).slice(0, 150)}`);
  // item 83's kind: one day list of 252 rows = 13 presses fits and still answers
  r = await go(cedar, S1, { charts: cchart }, { endEstimate: true }, 60000, cq);
  ok("answer" in r.out && r.out.answer === String(wantExact) && r.al.lastStats?.via === "by-day-exact" && r.site.clicks <= 30, `default: Cedar Hollow (252 rows over 3 days, ${r.site.clicks} presses incl. the by-day re-read) still answers ${wantExact}`);
  // no opt-in (context reads): the cap does not apply
  r = await go(month, S1, { capAt: 300 }, null);
  ok(!/AGG_MAX_REQ/.test(JSON.stringify(r.out)), "the request cap is the aggregate engine's only (begin({endEstimate}))");
  // a busy page is a stop sign: no second load of the same list, and no aggregate list for the next 60 s
  resetBusy();
  r = await go(cedar, { ...S1, busyFirst: 2 }, { charts: cchart }, { endEstimate: true }, 60000, cq);
  ok("why" in r.out && /busy/.test(r.out.why) && r.site.navs === 2, `default: busy list → decline, not re-read (${r.site.navs} navs: the form read + the one list load): ${JSON.stringify(r.out).slice(0, 120)}`);
  r = await go(cedar, S1, { charts: cchart }, { endEstimate: true }, 60000, cq);
  ok("why" in r.out && /was busy .* ago/.test(r.out.why) && r.site.navs <= 1 && !r.site.visited.some((v) => /start=/.test(v)), `default: next aggregate within the cooldown → instant decline, no list load (${r.site.navs} nav: the form read only): ${JSON.stringify(r.out).slice(0, 140)}`);
  resetBusy();
  r = await go(cedar, S1, { charts: cchart }, { endEstimate: true }, 60000, cq);
  ok("answer" in r.out && r.out.answer === String(wantExact), "after the cooldown the same read answers again");
  // the site's own refusal (run 265: nginx 503, then "This account is suspended"): named in the why, the form is not submitted for 8 s more, cooldown follows
  resetBusy();
  r = await go(cedar, S1, { charts: cchart, refuseFrom: 2 }, { endEstimate: true }, 60000, cq);
  ok("why" in r.out && /refuses the list.*This account is suspended/.test(r.out.why) && r.site.navs === 2, `default: "This account is suspended" page → decline naming it, no form fallback (${r.site.navs} navs): ${JSON.stringify(r.out).slice(0, 150)}`);
  r = await go(cedar, S1, { charts: cchart }, { endEstimate: true }, 60000, cq);
  ok("why" in r.out && /was busy .* ago/.test(r.out.why) && !r.site.visited.some((v) => /start=/.test(v)), "after a refusal the next aggregate declines at once");
  // a context read (no opt-in) that meets a busy page is not stopped by the cooldown and keeps its retries
  resetBusy();
  r = await go(month, { ...S1, busyFirst: 2 }, { capAt: 300 }, null);
  ok(r.site.navs > 3, `context reads keep their busy retries (${r.site.navs} navs)`);
  resetBusy();
  // the experiment levers: a larger AGG_MAX_REQ reads the month as before (on ONE tab: AGG_TABS stays 1), AGG_PRESS_GAP_MS spaces the presses after the 12th
  process.env.AGG_MAX_REQ = "100000";
  const logs: any[] = [];
  { const site = new SimSite(month, { charts, more: S1, capAt: 300 }); const al = new ApptList(site.crawler(), (e) => logs.push(e), async () => { throw new Error("a tab was spawned"); }); al.begin(120000, { endEstimate: true });
    const o = await solveAggregate(q, al);
    ok("why" in o && /never proves/.test(o.why) && !logs.some((e) => e.event === "aggregate-read" && /parallel/.test(String(e.why ?? ""))), `AGG_MAX_REQ raised: the month is read in cut parts on one tab and still declines on the last part's estimate (${JSON.stringify(o).slice(0, 120)})`);
    const lat = logs.filter((e) => e.event === "aggregate-read" && e.lat).flatMap((e) => e.lat as number[]);
    ok(lat.length >= 14 && lat.every((x) => Number.isFinite(x) && x >= 0), `each aggregate-read logs the ms of every press (lat: ${lat.length} presses)`); }
  process.env.AGG_PRESS_GAP_MS = "100";
  { const site = new SimSite(month, { charts, more: S1, capAt: 300 }); const al = new ApptList(site.crawler()); al.begin(120000, { endEstimate: true }); const t1 = Date.now();
    const o = await solveAggregate(q, al); const took = Date.now() - t1;
    ok("why" in o && took >= 300, `AGG_PRESS_GAP_MS=100: presses 13+ of a part wait (3 in the first part → ${took} ms, the sim alone is ~100)`); }
  delete process.env.AGG_PRESS_GAP_MS; delete process.env.AGG_MAX_REQ;
  // top-k over a big range is off unless asked: solvers.aggregate passes topBig=false → the whole range is read once, which the request cap declines at its first page
  {
    const TP2: Array<[string, string]> = [["Alice Adams, MD", "Active"], ["Brian Baker, DO", "Active"], ["Carol Clark, NP", "Active"], ["Dan Davis, MD", "Active"]];
    const big: SimRow[] = []; for (let i = 0; i < 1200; i++) big.push(row({ pid: "t" + i, name: `T${i}, X`, prov: TP2[i % 4][0], loc: LOCS[i % 4], date: `2025-01-${String(1 + (i % 31)).padStart(2, "0")}` }));
    const tq = Q("Which three providers had the most completed visits across all locations in January 2025? List them with the most first, by first and last name. Only providers who are active today count. Leave out appointments of patients whose record is a test record or has been deleted. If any are tied, put them in alphabetical order by last name, then first name.")!;
    const site = new SimSite(big, { provs: TP2, charts, more: S1 }); const al = new ApptList(site.crawler(), undefined, async () => site.crawler()); al.begin(120000, { endEstimate: true });
    const o = await solveAggregate(tq, al, { topBig: false });
    ok("why" in o && /AGG_MAX_REQ/.test(o.why) && site.clicks === 0 && !site.visited.some((v) => /provider=/.test(v)), `top-k, AGG_TOPK off: one first page, no per-provider list (${site.navs} navs, ${site.clicks} presses): ${JSON.stringify(o).slice(0, 130)}`);
  }
}

// ───────────────────────── 5. engine cases on a fixture source ─────────────────────────
const src = (rows: ApptRow[], o: { roster?: Array<{ label: string; active: boolean | null }>; resolve?: Record<string, ResolvedRecord> } = {}): AggSource & { reads: ReadFilter[] } => {
  const reads: ReadFilter[] = [];
  return { reads, todayISO: () => "2026-10-14", locations: async () => LOCS, roster: async () => o.roster ?? PROVS.map(([label, g]) => ({ label, active: g === "Active" })),
    read: async (f) => { reads.push(f); return { rows: rows.filter((r) => r.status === f.status && r.dateISO >= f.from && r.dateISO <= f.to && (!f.location || r.location === f.location) && (!f.provider || r.provider === f.provider)) }; },
    resolve: async (id) => o.resolve?.[id] ?? { canonicalId: id, flags: [] } };
};
let kk = 0;
const ar = (p: Partial<ApptRow>): ApptRow => ({ key: "k" + kk++, dateISO: "2026-07-27", start: 600, end: 620, tz: "CDT", patientName: "Q, P" + kk, patientId: "p" + kk, flags: [], provider: "Angel Aguilar, PA", location: "Cedar Hollow", visitType: "Office visit", status: "Completed", ...p });
{
  // Cedar Hollow 2026-07-27, Completed, start before 14:00 local — by hand:
  //   13:59 ✓ · 14:00 ✗ (not before) · 08:00 ✓ · 13:30 Test record ✗ · 12:00 Deleted ✗ · 09:00 Restricted ✓ · 10:00 Cancelled ✗ · 2026-07-28 09:00 ✗ → 3
  const rows = [ar({ start: 839 }), ar({ start: 840 }), ar({ start: 480 }), ar({ start: 810, flags: ["Test record"] }), ar({ start: 720, flags: ["Deleted"] }), ar({ start: 540, flags: ["Restricted"] }), ar({ start: 600, status: "Cancelled" }), ar({ start: 540, dateISO: "2026-07-28" })];
  const base = "How many completed visits at Cedar Hollow on 2026-07-27 started before 14:00 local time? Leave out appointments of patients whose record is a test record or has been deleted.";
  const s1 = src(rows); let o = await solveAggregate(Q(base)!, s1);
  ok("answer" in o && o.answer === "3", `before 14:00: 3 (got ${JSON.stringify(o)})`);
  ok(s1.reads[0].from === "2026-07-26" && s1.reads[0].to === "2026-07-28" && s1.reads[0].location === "Cedar Hollow" && s1.reads[0].status === "Completed", "narrowest server filter: location + status + day ±1");
  o = await solveAggregate(Q(base.replace("before 14:00", "at or before 14:00"))!, src(rows));
  ok("answer" in o && o.answer === "4", `at or before 14:00: 4 (got ${JSON.stringify(o)})`);
  o = await solveAggregate(Q(base.replace("before 14:00 local time", "after 13:59"))!, src(rows));
  ok("answer" in o && o.answer === "1", `after 13:59: only the 14:00 visit (got ${JSON.stringify(o)})`);
  o = await solveAggregate(Q("How many completed visits at Cedar Hollow on 2026-07-27 started before 14:00 local time?")!, src(rows));
  ok("why" in o && /test record/.test(o.why), "silent about test/deleted while such rows are hits → decline");
  o = await solveAggregate(Q("How many completed visits at Cedar Hollow on 2026-07-27 started before 8:00 AM?")!, src(rows));
  ok("answer" in o && o.answer === "0", "silent about test/deleted but none among the hits → answer (0)");
  o = await solveAggregate(Q(base.replace("Cedar Hollow", "Juniper Flats"))!, src(rows));
  ok("why" in o && /not exactly one of the site's locations/.test(o.why), "unknown location → decline");
  // time zones: a Stonebrook (MDT) visit at 8:40 AM local is 9:40 AM CDT
  const st = [ar({ location: "Stonebrook", start: 520, tz: "MDT" })];
  const sq = (b: string) => Q(`How many completed visits at Stonebrook on 2026-07-27 started before ${b}? Exclude test records and deleted records.`)!;
  o = await solveAggregate(sq("9:45 AM CDT"), src(st)); ok("answer" in o && o.answer === "1", "8:40 MDT is before 9:45 CDT");
  o = await solveAggregate(sq("9:40 AM CDT"), src(st)); ok("answer" in o && o.answer === "0", "8:40 MDT (= 9:40 CDT) is not before 9:40 CDT");
  o = await solveAggregate(sq("9:00 AM"), src(st)); ok("answer" in o && o.answer === "1", "no zone named = the location's own clock");
  o = await solveAggregate(sq("9:41 AM Central time"), src(st)); ok("answer" in o && o.answer === "1", "generic Central takes daylight time from the row (CDT)");
  // filters the site ignored are caught client-side
  const leaky: AggSource = { ...src(rows), read: async () => ({ rows: [...rows.filter((x) => x.status === "Completed"), ar({ location: "Northgate" })] }) };
  o = await solveAggregate(Q(base)!, leaky); ok("why" in o && /location filter not applied/.test(o.why), "row from another location → decline");
  const leaky2: AggSource = { ...src(rows), read: async () => ({ rows }) };
  o = await solveAggregate(Q(base)!, leaky2); ok("why" in o && /status filter not applied/.test(o.why), "row with another status → decline");
  const failing: AggSource = { ...src(rows), read: async () => ({ fail: "pacer: too many pages" }) };
  o = await solveAggregate(Q(base)!, failing); ok("why" in o && /pacer/.test(o.why), "read failure → decline with its reason");
}
{
  // Top providers, January 2025, all locations, Completed — by hand:
  //   Aguilar 5 · Brooks 5 real + 1 Test record → 5 · Chen 4 real + 2 Deleted → 4 · Cruz 3 · Castro (Inactive) 6
  //   active only, ties by last name → Aguilar (5), Brooks (5), Chen (4)
  const mk = (prov: string, n: number, extra: Partial<ApptRow> = {}) => Array.from({ length: n }, (_, i) => ar({ provider: prov, dateISO: `2025-01-${String(2 + i).padStart(2, "0")}`, location: LOCS[i % 4], ...extra }));
  const rows = [...mk("Angel Aguilar, PA", 5), ...mk("Barrett Brooks, MD", 5), ...mk("Barrett Brooks, MD", 1, { flags: ["Test record"] }), ...mk("Carlos Chen, NP", 4), ...mk("Carlos Chen, NP", 2, { flags: ["Deleted"] }), ...mk("Ana Cruz, NP", 3), ...mk("Danielle Castro, NP", 6), ...mk("Ana Cruz, NP", 9, { status: "Cancelled" }), ...mk("Ana Cruz, NP", 9, { dateISO: "2025-02-01" })];
  const T = (k: string, tail = " If any are tied, put them in alphabetical order by last name, then first name.", active = " Only providers who are active today count.") => Q(`Which ${k} providers had the most completed visits across all locations in January 2025? List them with the most first, by first and last name.${active} Leave out appointments of patients whose record is a test record or has been deleted.${tail}`)!;
  let o = await solveAggregate(T("three"), src(rows)); ok("answer" in o && o.answer === "Angel Aguilar, Barrett Brooks, Carlos Chen", `top 3 → ${JSON.stringify(o)}`);
  o = await solveAggregate(T("four"), src(rows)); ok("answer" in o && o.answer === "Angel Aguilar, Barrett Brooks, Carlos Chen, Ana Cruz", `top 4 → ${JSON.stringify(o)}`);
  o = await solveAggregate(T("two"), src(rows)); ok("answer" in o && o.answer === "Angel Aguilar, Barrett Brooks", "top 2: tie inside, broken by last name");
  o = await solveAggregate(T("two", ""), src(rows)); ok("why" in o && /no tie rule/.test(o.why), "tie inside the top places with no tie rule → decline");
  const one = Q("Which provider had the most completed visits across all locations in January 2025? Only providers active today count; leave out test and deleted records.")!;
  o = await solveAggregate(one, src(rows)); ok("why" in o && /tie at place 1/.test(o.why), "tie at the k-th place → decline");
  o = await solveAggregate(T("three", " If any are tied, put them in alphabetical order by last name, then first name.", ""), src(rows)); ok("why" in o && /inactive/.test(o.why), "inactive provider in the top and 'active' not said → decline");
  o = await solveAggregate(T("six"), src(rows)); ok("why" in o && /only 4 providers/.test(o.why), "fewer providers than asked → decline");
  o = await solveAggregate(T("three"), src(rows, { roster: PROVS.map(([label]) => ({ label, active: null })) })); ok("why" in o && /active/.test(o.why), "roster without Active/Inactive → decline");
  o = await solveAggregate(T("three"), src(rows.map((r) => r.provider === "Ana Cruz, NP" ? { ...r, provider: "Zed Unknown, MD" } : r))); ok("why" in o && /not on the roster/.test(o.why), "provider not on the roster → decline");
  // Brooks' test-record visit would make him 6 if counted: the exclusion decides the order
  const withTest = rows.map((r) => r.flags.includes("Test record") ? { ...r, flags: [] as any } : r);
  o = await solveAggregate(T("three"), src(withTest)); ok("answer" in o && o.answer === "Barrett Brooks, Angel Aguilar, Carlos Chen", "without the test flag Brooks leads with 6");
}
{
  // distinct patients on a fixture source: Merged row leading back to itself without a banner → decline
  const rows = [ar({ patientId: "m1", patientName: "Lee, Ann", flags: ["Merged"], dateISO: "2025-08-02", location: "Northgate" })];
  const q = Q("How many patients had at least one completed visit at Northgate in August 2025? Count each person once even if they are registered more than once, and leave out test records and deleted records.")!;
  let o = await solveAggregate(q, src(rows)); ok("why" in o && /surviving chart/.test(o.why), "Merged row that opens itself without a merge banner → decline");
  o = await solveAggregate(q, src(rows, { resolve: { m1: { canonicalId: "m9", flags: ["Deleted"] } } })); ok("answer" in o && o.answer === "0", "Merged row whose surviving record is deleted → left out");
  o = await solveAggregate(q, src([ar({ patientId: "x1", patientName: "Lee, Ann", dateISO: "2025-08-02", location: "Northgate" }), ar({ patientId: "x1", patientName: "Lee, Ann", dateISO: "2025-08-09", location: "Northgate" })])); ok("answer" in o && o.answer === "1", "two visits, one record → 1");
}

console.log(`\n${fail ? "✗" : "✓"} aggregate: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
