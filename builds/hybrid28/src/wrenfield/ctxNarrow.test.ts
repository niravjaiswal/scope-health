/**
 * Name-only visit-day contexts that read LESS of the day (run 265: the whole-day read of 6 visit tasks took 10-35 s each and
 * ran out of its 11-15 s allowance at location 5 of 10, or met the site's "account suspended" page), on simulated Show-more
 * lists built from the captured Set 1 appointment-list form (Visit type select `type`=wound "Wound care"; start-time order):
 *   - a tetanus question is about a wound visit → the list's Wound care filter, ONE all-locations read; every row read back must
 *     show the type; no single Wound-care option, a site that ignores the filter, no type column, a cut list → the whole day or a decline;
 *   - a good-faith question names the booked time → each location read only up to that time (the order is proven on the rows read),
 *     only the rows AT that time returned; a list that is not in time order, or never reaches the time, declines;
 *   - the whole-day read of ten locations runs on the extra tabs (readMany) and gives the very rows the sequential read gives;
 *   - a context read keeps no 4 s "open the records afterwards" reserve (it opens none);
 *   - pacer.ctxAdmit funds a 16 s read with 22 s, not the flat 15 s.
 */
import { JSDOM } from "jsdom";
// these sims have no request budget: the governor (siteBudget.ts, tested in siteBudget.test) would only add waits to the timing cases
process.env.AGENT_LIST_PACE_MS = "0";
import { ApptList } from "./apptList.js";
import { apptDayContext, pickByContext, pickFromContext, type CtxRead } from "./contextResolve.js";
import { Pacer } from "./pacer.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? pass++ : fail++; if (!c) console.log("FAIL " + m); };
const eq = (got: unknown, want: unknown, what: string) => { const g = JSON.stringify(got), w = JSON.stringify(want); ok(g === w, `${what}\n  got  ${g}\n  want ${w}`); };

const LOCS = ["Northgate", "Front Range", "Eastside", "Stonebrook", "Lakeside", "Riverbend", "Highline", "Prairie View", "Cedar Hollow", "Willow Creek"];
type R = { date: string; loc: string; start: number; name: string; pid: string; type?: string; badges?: string };
const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const longDate = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return `${mon[m - 1]} ${d}, ${y}`; };
const hhmm = (min: number) => { const h = Math.floor(min / 60), m = min % 60; return `${(h + 11) % 12 + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };
const r25 = (n: number) => Math.round(n / 25) * 25;
const TYPES: Array<[string, string]> = [["followup", "Follow-up visit"], ["sick", "Sick visit"], ["wound", "Wound care"]];
type SimOpts = { cap?: number; noTypeControl?: boolean; twoWound?: boolean; ignoreType?: boolean; noTypeColumn?: boolean; unsorted?: boolean; slow?: number; pressMs?: number };
let live = 0, maxLive = 0;
class Sim {
  dom = new JSDOM("<!doctype html><html><body></body></html>"); st = { from: "", to: "", location: "", status: "", provider: "", type: "", page: 1 }; path = "/"; clicks = 0; loads = 0;
  constructor(public rows: R[], public o: SimOpts = {}) {}
  get doc() { return this.dom.window.document; }
  list() {
    const s = this.st; const tv = TYPES.find(([v]) => v === s.type)?.[1];
    const l = this.rows.filter((r) => r.date >= s.from && r.date <= s.to && (!s.location || LOCS[+s.location - 1] === r.loc) && (this.o.ignoreType || !tv || (r.type ?? "Follow-up visit") === tv));
    return this.o.unsorted ? l.sort((a, b) => a.pid.localeCompare(b.pid)) : l.sort((a, b) => a.date.localeCompare(b.date) || a.start - b.start || a.pid.localeCompare(b.pid));
  }
  nav(p: string) { this.loads++; const u = new URL("http://x" + p); this.path = u.pathname + u.search; if (u.pathname === "/schedule/appointments") { const q = u.searchParams; this.st = { from: q.get("start") ?? "", to: q.get("end") ?? "", location: q.get("location") ?? "", status: q.get("status") ?? "", provider: q.get("provider") ?? "", type: q.get("type") ?? "", page: 1 }; this.render(); } else this.doc.body.innerHTML = "<h1>Schedule</h1>"; }
  render() {
    const d = this.doc, s = this.st, step = 20, cap = this.o.cap ?? 300;
    const all = this.list(), vis = all.slice(0, cap), shown = vis.slice(0, s.page * step), allIn = shown.length >= vis.length, cut = vis.length < all.length;
    const est = (n: number) => (n < 100 ? String(n) : "about " + r25(n).toLocaleString("en-US"));
    const footer = all.length === 0 ? "No appointments match" : !allIn || cut ? `Showing ${shown.length} of ${est(all.length)} appointments` : `${est(all.length)} appointments`;
    const cols = ["Date", "Time", "Patient", "Provider", ...(this.o.noTypeColumn ? [] : ["Visit type"]), "Status", ...(s.location ? [] : ["Location"])];
    const cell = (r: R, c: string) => ({ Date: `<a href="/patients/${r.pid}/appointments/${r.pid}x${r.start}">${longDate(r.date)}</a>`, Time: `${hhmm(r.start)} to ${hhmm(r.start + 20)} <span>CST</span>`, Patient: `<a href="/patients/${r.pid}">${r.name}</a> ${r.badges ? `<span>${r.badges}</span>` : ""}`, Provider: "Renee Lopez, MD", "Visit type": r.type ?? "Follow-up visit", Status: "<span>Completed</span>", Location: r.loc } as Record<string, string>)[c];
    const opt = (v: string, t: string, cur: string) => `<option value="${v}"${v === cur ? " selected" : ""}>${t}</option>`;
    const types = this.o.noTypeControl ? "" : `<label for="type">Visit type</label><select id="type" name="type">${opt("", "All visit types", s.type)}${TYPES.map(([v, t]) => opt(v, t, s.type)).join("")}${this.o.twoWound ? opt("wound2", "Wound check", s.type) : ""}</select>`;
    d.body.innerHTML = `<h1>Schedule</h1><form aria-label="Filter appointments">
      <label for="start">From</label><input id="start" name="start" type="date" value="${s.from}"><label for="end">To</label><input id="end" name="end" type="date" value="${s.to}">
      <label for="location">Location</label><select id="location" name="location">${opt("", "All locations", s.location)}${LOCS.map((l, i) => opt(String(i + 1), l, s.location)).join("")}</select>
      <label for="provider">Provider</label><select id="provider" name="provider">${opt("", "All providers", s.provider)}<optgroup label="Active">${opt("1", "Renee Lopez, MD", s.provider)}</optgroup></select>
      <label for="status">Status</label><select id="status" name="status">${opt("", "All statuses", s.status)}${opt("2", "Completed", s.status)}</select>${types}
      <button type="submit">Show appointments</button></form>
      <section><h2><span>Appointments from ${longDate(s.from)} to ${longDate(s.to)}</span></h2>
      <table><caption>Appointments, earliest first</caption><thead><tr>${cols.map((c) => `<th>${c}</th>`).join("")}</tr></thead>
      <tbody>${shown.map((r) => `<tr>${cols.map((c) => `<td>${cell(r, c)}</td>`).join("")}</tr>`).join("")}</tbody></table>
      <div><p aria-live="polite">${footer}</p>${allIn ? "" : `<div><button type="button">Show more</button></div>`}</div></section>`;
    [...d.querySelectorAll("section button")].find((x) => x.textContent === "Show more")?.addEventListener("click", () => { this.clicks++; const go = () => { this.st.page++; this.render(); }; if (this.o.pressMs) setTimeout(go, this.o.pressMs); else go(); });
  }
  crawler(): any {
    return { today: "2026-10-14", trace: () => {}, navTo: async (p: string) => { live++; maxLive = Math.max(maxLive, live); try { if (this.o.slow) await new Promise((r) => setTimeout(r, this.o.slow)); this.nav(p); } finally { live--; } return true; },
      evalTop: async (js: string) => /pathname/.test(js) ? this.path : "Location: All locations. Change location",
      evalApp: async (js: string) => new Function("doc", "Event", js)(this.doc, this.dom.window.Event), pickerLabel: async () => "Location: All locations. Change location", ensureAllLocations: async () => true };
  }
}
const DAY = "2026-01-02";
let pidn = 0;
/** ~`n` fill rows at a location: starts 07:00.. in 20-minute steps, about three at each start. */
const fill = (loc: string, n: number, date = DAY): R[] => Array.from({ length: n }, (_, i) => ({ date, loc, start: 420 + Math.floor(i / 3) * 20, name: `Fill${pidn}, Pat${i}`, pid: "f" + pidn++ }));
const SIZES: Record<string, number> = { Northgate: 105, "Front Range": 74, Eastside: 90, Stonebrook: 73, Lakeside: 46, Riverbend: 125, Highline: 60, "Prairie View": 85, "Cedar Hollow": 40, "Willow Creek": 55 };
const FILL = LOCS.flatMap((l) => fill(l, SIZES[l]));
const base = (extra: R[] = [], o: SimOpts = {}) => new Sim([...FILL, ...extra], o);
const al = (site: Sim, tabs: Sim[] = []) => { const q = [...tabs]; return new ApptList(site.crawler(), () => {}, async () => { const t = q.shift(); return t ? t.crawler() : null; }); };
const W = (name: string, pid: string, loc: string, start = 500, type = "Wound care"): R => ({ date: DAY, loc, start, name, pid, type });
const WOUND = { type: /\bwound\b/i };

// ── 1. tetanus: the Wound care filter ──
{
  const site = base([W("García, Jean", "gj", "Eastside"), W("Doe, Ann", "da", "Northgate"), W("Roe, Bo", "rb", "Willow Creek", 900)]);
  const out = await apptDayContext(al(site), DAY, 30000, WOUND);
  ok("rows" in out, `typed read: ${JSON.stringify(out).slice(0, 160)}`);
  if ("rows" in out) {
    eq(out.rows.length, 3, "only the Wound care rows of ALL locations (one read)");
    ok(/Wound care/.test(out.what), "…named in what");
    eq(pickByContext(out.rows, "Jean García", { what: out.what }).chosen?.href ?? null, "/patients/gj", "the one Jean García on the Wound care list → her chart");
  }
  ok(site.clicks === 0 && site.loads <= 3, `no Show more, ${site.loads} page loads (the whole day is ~45 presses): clicks ${site.clicks}`);
  const whole = base([W("García, Jean", "gj", "Eastside")]); await apptDayContext(al(whole), DAY, 60000);
  ok(whole.clicks > 20, `(the whole-day read of the same site: ${whole.clicks} presses)`);
}
{ // a namesake with a Wound care visit at another location → ambiguous
  const site = base([W("García, Jean", "gj", "Eastside"), W("García, Jean", "gj2", "Highline", 700)]);
  const out = await apptDayContext(al(site), DAY, 30000, WOUND);
  ok("rows" in out && pickByContext(out.rows, "Jean García").chosen === null, "two Jean Garcías with a wound visit that day → decline");
}
{ // the patient's visit that day was another kind: not on the Wound care list → decline (never a guess)
  const site = base([W("García, Jean", "gj", "Eastside", 500, "Sick visit"), W("Doe, Ann", "da", "Northgate")]);
  const out = await apptDayContext(al(site), DAY, 30000, WOUND);
  ok("rows" in out && pickByContext(out.rows, "Jean García").chosen === null, "a Sick-visit Jean García is not on the Wound care list → decline");
}
{ // the site ignores the type filter: rows of other types come back → fail
  const site = base([W("García, Jean", "gj", "Eastside")], { ignoreType: true, cap: 400 });
  const out = await apptDayContext(al(site), DAY, 30000, WOUND);
  ok("fail" in out, `a site that ignores the filter fails: ${JSON.stringify(out).slice(0, 200)}`);
}
{ // no Visit type column: the filter cannot be checked
  const site = base([W("García, Jean", "gj", "Eastside")], { noTypeColumn: true });
  const out = await apptDayContext(al(site), DAY, 30000, WOUND);
  ok("fail" in out && /no Visit type column/.test(out.fail), `no type column → fail: ${JSON.stringify(out).slice(0, 200)}`);
}
{ // no Visit type filter at all → the whole day is read (the pre-existing path)
  const site = base([W("García, Jean", "gj", "Eastside")], { noTypeControl: true });
  const out = await apptDayContext(al(site), DAY, 60000, WOUND);
  ok("rows" in out && out.rows.length > 700 && out.wide === true && pickByContext(out.rows, "Jean García").chosen?.href === "/patients/gj", "no type control: whole day (flagged wide), same pick");
}
{ // two options say "wound" → no single type: whole day
  const site = base([W("García, Jean", "gj", "Eastside")], { twoWound: true });
  const out = await apptDayContext(al(site), DAY, 60000, WOUND);
  ok("rows" in out && out.rows.length > 700, "two Wound options: whole day");
}
{ // a Wound care list the site cuts (400 rows) → decline
  const site = new Sim(Array.from({ length: 400 }, (_, i) => W(`Fill, W${i}`, "w" + i, LOCS[i % 10], 420 + (i % 40) * 20)));
  const out = await apptDayContext(al(site), DAY, 60000, WOUND);
  ok("fail" in out, `a cut typed list declines: ${JSON.stringify(out).slice(0, 160)}`);
}

// ── 2. good faith: each location read only up to the booked time ──
{
  const site = base([{ date: DAY, loc: "Lakeside", start: 500, name: "George, Bryan", pid: "bg" }, { date: DAY, loc: "Lakeside", start: 1000, name: "George, Bryan", pid: "bg2" }]);
  const out = await apptDayContext(al(site), DAY, 30000, { startMin: 500 });
  ok("rows" in out, `timed read: ${JSON.stringify(out).slice(0, 160)}`);
  if ("rows" in out) {
    ok(out.rows.every((r) => r.start === 500), "only the rows AT 08:20 come back");
    eq(pickByContext(out.rows, "Bryan George", { start: 500, what: out.what }).chosen?.href ?? null, "/patients/bg", "…a namesake booked at 16:40 is not the 08:20 visit → the 08:20 Bryan George");
    ok(/at 08:20/.test(out.what), "…named in what");
  }
  ok(site.clicks <= LOCS.length, `${site.clicks} Show more presses for ten locations (the whole day: ~45)`);
  const full = base([]); await apptDayContext(al(full), DAY, 60000);
  ok(full.clicks > site.clicks * 3, `(whole day: ${full.clicks} presses)`);
}
{ // a later time needs more pages, still far fewer than the whole day
  const site = base([{ date: DAY, loc: "Riverbend", start: 780, name: "Watkins, Patrick", pid: "pw" }]);
  const out = await apptDayContext(al(site), DAY, 30000, { startMin: 780 });
  ok("rows" in out && pickByContext(out.rows, "Patrick Watkins", { start: 780 }).chosen?.href === "/patients/pw", `13:00: ${JSON.stringify(out).slice(0, 120)}`);
  ok(site.clicks > 10 && site.clicks < 40, `13:00 reads about half of each list: ${site.clicks} presses`);
}
{ // the same name booked at the same time at another location → ambiguous
  const site = base([{ date: DAY, loc: "Lakeside", start: 500, name: "George, Bryan", pid: "bg" }, { date: DAY, loc: "Northgate", start: 500, name: "George, Bryan", pid: "bg2" }]);
  const out = await apptDayContext(al(site), DAY, 30000, { startMin: 500 });
  ok("rows" in out && pickByContext(out.rows, "Bryan George", { start: 500 }).chosen === null, "two Bryan Georges at 08:20 → decline");
}
{ // the list is not in start-time order → decline (the prefix proves nothing)
  const site = base([{ date: DAY, loc: "Lakeside", start: 500, name: "George, Bryan", pid: "bg" }], { unsorted: true });
  const out = await apptDayContext(al(site), DAY, 30000, { startMin: 500 });
  ok("fail" in out && /time order/.test(out.fail), `an unsorted list declines: ${JSON.stringify(out).slice(0, 200)}`);
}
{ // no appointment at that time anywhere
  const site = base([]);
  const out = await apptDayContext(al(site), DAY, 30000, { startMin: 505 });
  ok("fail" in out && /no appointment at 08:25/.test(out.fail), `nothing at the asked time → decline: ${JSON.stringify(out).slice(0, 160)}`);
}
{ // a time after every row: the lists are read to their ends (sealed) before anything is concluded
  const site = base([]);
  const out = await apptDayContext(al(site), DAY, 60000, { startMin: 1300 });
  ok("fail" in out && /no appointment at 21:40/.test(out.fail) && site.clicks > 20, `a time past the last row reads to the ends then finds nothing (${site.clicks} presses): ${JSON.stringify(out).slice(0, 120)}`);
}

// ── 3. the whole day on extra tabs (opt-in: AGG_TABS defaults to 1 since run 265's suspension; these cases set 3) ──
process.env.AGG_TABS = "3";
{
  const extra = [{ date: DAY, loc: "Stonebrook", start: 600, name: "Wells, Harold", pid: "hw" }];
  const seq = base(extra); const a = await apptDayContext(al(seq), DAY, 60000);
  const main = base(extra, { slow: 3 }), t1 = base(extra, { slow: 3 }), t2 = base(extra, { slow: 3 });
  maxLive = 0;
  const b = await apptDayContext(al(main, [t1, t2]), DAY, 60000);
  ok("rows" in a && "rows" in b, `both read: ${JSON.stringify(a).slice(0, 80)} / ${JSON.stringify(b).slice(0, 80)}`);
  if ("rows" in a && "rows" in b) {
    eq(b.rows.map((r) => r.href + r.start).sort(), a.rows.map((r) => r.href + r.start).sort(), "the tabs give exactly the rows the sequential read gives");
    eq(pickByContext(b.rows, "Harold Wells").chosen?.href ?? null, "/patients/hw", "…and the same pick");
  }
  ok(t1.clicks > 0 && t2.clicks > 0 && main.clicks > 0, `all three tabs worked (${main.clicks} / ${t1.clicks} / ${t2.clicks} presses)`);
  ok(maxLive >= 2, `reads overlapped (max ${maxLive} page loads at once)`);
  process.env.CTX_PARALLEL = "0";
  const m2 = base(extra), u1 = base(extra);
  const c = await apptDayContext(al(m2, [u1]), DAY, 60000);
  ok("rows" in c && u1.clicks === 0, "CTX_PARALLEL=0: one tab only"); delete process.env.CTX_PARALLEL;
}

// the same ten locations with a press costing 25 ms and a page load 40 ms (a scale model of ~300 ms / ~500 ms): the tabs cut the time
{
  const mk = (n: number) => Array.from({ length: n }, () => base([], { pressMs: 25, slow: 40 }));
  const seq = mk(1)[0]; let t0 = Date.now(); const a = await apptDayContext(al(seq), DAY, 60000); const tSeq = Date.now() - t0;
  const [m, t1, t2] = mk(3); t0 = Date.now(); const b = await apptDayContext(al(m, [t1, t2]), DAY, 60000); const tPar = Date.now() - t0;
  ok("rows" in a && "rows" in b && a.rows.length === b.rows.length, "same rows with and without tabs");
  ok(tPar < tSeq * 0.9, `three tabs cut the whole-day read: ${tSeq} ms → ${tPar} ms`);
  console.log(`  (scale model: whole day, one tab ${tSeq} ms, three tabs ${tPar} ms, ratio ${(tPar / tSeq).toFixed(2)})`);
}
delete process.env.AGG_TABS;

// ── 4. a context read keeps no resolve reserve ──
{
  const site = base([]);
  const a = al(site); const ctx = await apptDayContext(a, DAY, 3500, { startMin: 480 });
  ok("rows" in ctx || /no appointment at/.test(ctx.fail), `3.5 s budget, sealed/timed: not a pacer failure (${JSON.stringify(ctx).slice(0, 100)})`);
  const s2 = base([]); const b = al(s2); b.begin(3500);
  const r = await b.read({ from: DAY, to: DAY, status: "any", location: "Northgate" });
  ok("fail" in r && /pacer/.test(r.fail), `(an aggregate-style read with the same budget still keeps its 4 s reserve: ${JSON.stringify(r).slice(0, 100)})`);
  const s3 = base([]); const c3 = al(s3); c3.begin(3500);
  const r3 = await c3.read({ from: DAY, to: DAY, status: "any", location: "Northgate", sealed: true });
  ok("rows" in r3, `a sealed read with 3.5 s completes: ${JSON.stringify(r3).slice(0, 100)}`);
}

// ── 4b. a suspended account fails fast (run 265 item 127: 23 s of waiting for a form that could not come) ──
{
  const dom = new JSDOM("<!doctype html><html><body></body></html>"); let navs = 0;
  const c: any = { today: "2026-10-14", trace: () => {}, navTo: async () => { navs++; dom.window.document.body.innerHTML = "<section role='alert'><h1>This account is suspended</h1><p>You cannot use Wrenfield with this account at the moment.</p></section>"; return false; },
    evalTop: async () => "", evalApp: async (js: string) => new Function("doc", "Event", js)(dom.window.document, dom.window.Event), pickerLabel: async () => "", ensureAllLocations: async () => true };
  const t0 = Date.now(); const out = await apptDayContext(new ApptList(c), DAY, 30000, { startMin: 500 });
  ok("fail" in out && /suspended/.test(out.fail), `a suspended account is named: ${JSON.stringify(out).slice(0, 200)}`);
  ok(navs <= 2 && Date.now() - t0 < 3000, `…after ${navs} page load(s), not four tries`);
}

// ── 5. the pacer funds a long read with more than a flat 15 s ──
{
  let t = 5; const p = new Pacer(900, 0, 8, 20, 6, 3, 0.08, 0.5, () => t * 1000);
  for (let i = 0; i < 25; i++) { p.begin(900 - t); p.end("lab-report-triage", 12000, true); t += 12; } // Set 1's opening: behind pace
  p.begin(900 - t);
  const a = p.ctxAdmit(16); ok(!!a && Math.abs(a.budgetMs - 22400) < 1, `a 16 s read is funded with 22.4 s: ${a?.budgetMs}`);
  const b = p.ctxAdmit(3); ok(!!b && b.budgetMs === 15000, `a 3 s read keeps 15 s: ${b?.budgetMs}`);
}


// ── 6. the wider read is tried only when the narrow list does not name the patient at all ──
{
  const rows = (...names: string[]): CtxRead => ({ rows: names.map((n, i) => ({ name: n, href: "/patients/p" + i })), what: "the list" });
  const mk = (narrow: CtxRead, whole?: CtxRead) => { const calls: string[] = []; return { calls, src: { locate: async () => (calls.push("narrow"), narrow), ...(whole ? { fallback: async () => (calls.push("whole"), whole) } : {}) } }; };
  { const m = mk(rows("García, Jean", "Doe, Ann"), rows("García, Jean")); const r = await pickFromContext(m.src, "Jean García");
    eq([r.pick.chosen?.href, r.part, m.calls], ["/patients/p0", "", ["narrow"]], "the narrow list names her: no wider read"); }
  { const m = mk(rows("Doe, Ann", "García, Jorge"), rows("Doe, Ann", "García, Jean")); const r = await pickFromContext(m.src, "Jean García");
    eq([r.pick.chosen?.href, r.part, m.calls, r.reads.length, r.reads[0].near], ["/patients/p1", ":whole", ["narrow", "whole"], 2, ["García, Jorge"]], "not on the narrow list → the whole day names her (':whole'); the miss logs the rows sharing her last name"); }
  { const m = mk({ rows: [], what: "x" } as any, rows("García, Jean")); const r = await pickFromContext(m.src, "Jean García");
    eq([r.part, m.calls], [":whole", ["narrow", "whole"]], "an empty narrow list counts as 'not on it'"); }
  { const m = mk({ fail: "no Wound care appointments listed on 2025-08-21" }, rows("García, Jean")); const r = await pickFromContext(m.src, "Jean García");
    eq([r.pick.chosen?.href, r.part], ["/patients/p0", ":whole"], "'no Wound care appointments listed on D' → the whole day"); }
  { const m = mk({ fail: "Wound care appointments 2025-08-21: list busy at Show more 2" }, rows("García, Jean")); const r = await pickFromContext(m.src, "Jean García");
    eq([r.pick.chosen, m.calls], [null, ["narrow"]], "a FAILED narrow read (busy, budget) is not 'not on the list': no wider read"); }
  { const m = mk(rows("García, Jean", "García, Jean"), rows("García, Jean")); m.src.locate = async () => (m.calls.push("narrow"), { rows: [{ name: "García, Jean", href: "/patients/a" }, { name: "García, Jean", href: "/patients/b" }], what: "the list" });
    const r = await pickFromContext(m.src, "Jean García");
    eq([r.pick.chosen, m.calls], [null, ["narrow"]], "two Jean Garcías on the narrow list: ambiguous, never widened"); }
  { const m = mk(rows("Doe, Ann"), rows("Doe, Ann")); const r = await pickFromContext(m.src, "Jean García");
    eq([r.pick.chosen, m.calls.length, /^no Jean García on /.test(r.pick.why ?? "")], [null, 2, true], "absent from both → decline with the whole list's reason"); }
  { const m = mk(rows("Doe, Ann")); const r = await pickFromContext(m.src, "Jean García");
    eq([r.pick.chosen, m.calls], [null, ["narrow"]], "no fallback offered (CTX_WOUND_WHOLE=0, or a lab / good-faith context): one read"); }
  { const m = mk({ rows: [{ name: "Doe, Ann", href: "/patients/d" }], what: "the whole day", wide: true }, rows("García, Jean")); const r = await pickFromContext(m.src, "Jean García");
    eq([r.pick.chosen, m.calls], [null, ["narrow"]], "a narrow read that was the whole day already (no single Wound option) is not read twice"); }
  { const m = mk(rows("Doe, Ann"), rows("García, Jean", "García, Jean M")); const r = await pickFromContext(m.src, "Jean García");
    eq(r.pick.chosen, null, "the whole day shows two near names (García, Jean and García, Jean M): decline (pickByContext's rule is unchanged)"); }
}

console.log(`\nctxNarrow: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
