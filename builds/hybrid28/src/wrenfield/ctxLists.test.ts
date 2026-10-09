/**
 * Name-only context lists on Set 1's list behaviour (run 278 skips: 11 visit / lab tasks whose day list stated only
 * "about N" and 3 whose pacer budget was zero), on simulated pages built from the captured forms:
 *   - listFooter.endSealed: the bare "about N …" end of a finished Show-more list (control gone) seals it; every other
 *     form (the cap's "Showing 300 of about 1,000", an empty "No more results" page, "N+", a list far from its estimate,
 *     the control still offered) does not;
 *   - apptList: "89 appointments" (exact bare end footer after Show more) is no "pager form change"; sealed reads end on
 *     "about 125 appointments"; the aggregate path (not sealed) still declines both estimate cases;
 *   - apptDayContext: ALL locations are read (a namesake at another location counts), their rows add up to the
 *     all-locations estimate (a location the filter does not offer is a gap → decline), a cut list or a list that stopped
 *     short of its estimate declines;
 *   - labDocContext: a day's lab reports ("about 100 documents") read to the sealed end; the same negatives;
 *   - pickByContext on those rows: one exact chart wins; two namesakes both on the day, a badge, a thin read decline;
 *   - the pacer's context allowance (ctxAdmit): a Set-1-style "behind" opening still admits the first few reads.
 */
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
// the simulated lists here have no request budget: the governor (siteBudget.ts) would only add sleeps (tested in siteBudget.test)
process.env.AGENT_LIST_PACE_MS = "0";
import { endSealed, isComplete, listFooter } from "./listFooter.js";
import { ApptList, PAGE_EXTRACT, rangeOf, type RawPage } from "./apptList.js";
import { apptDayContext, labDocContext, pickByContext, DOCS_EXTRACT, docFooter, type CtxRow, type DocsRaw } from "./contextResolve.js";
import { parsePatientRows } from "./pageScripts.js";
import { resolvePatient, type PatientSearch } from "./patientResolve.js";
import { Pacer } from "./pacer.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? pass++ : fail++; if (!c) console.log("FAIL " + m); };
const eq = (got: unknown, want: unknown, what: string) => { const g = JSON.stringify(got), w = JSON.stringify(want); ok(g === w, `${what}\n  got  ${g}\n  want ${w}`); };

// ── 1. endSealed truth table ──
const sealed = (rows: number, footer: string, st: Parameters<typeof endSealed>[2] = { more: "none" }) => endSealed(rows, listFooter(footer), st).complete;
ok(sealed(112, "about 100 appointments"), 'the Set 1 end form: 112 rows, "about 100 appointments", no control → sealed');
ok(sealed(252, "about 250 appointments"), "run 164 Cedar Hollow: 252 rows, about 250 → sealed");
ok(sealed(97, "about 100 documents"), "documents end form");
ok(!sealed(112, "Showing 112 of about 125 appointments"), "cumulative form with the control gone is the CUT form → not sealed");
ok(!sealed(300, "Showing 300 of about 1,000 appointments"), "the 300-row cap → not sealed");
ok(!sealed(160, "about 250 patients", { more: "none", empty: true }), 'the patient search\'s empty "No more results" page shows a bare estimate too → not sealed');
ok(!sealed(112, "about 100 appointments", { more: "enabled" }), "control still offered → not sealed");
ok(!sealed(60, "about 125 appointments"), "rows far below the estimate (a list that stopped short) → not sealed");
ok(!sealed(0, "about 100 appointments"), "no rows → not sealed");
ok(!sealed(500, "500+ appointments"), '"N+" lower bound → not sealed');
ok(!sealed(89, "89 appointments"), "an exact bare count is the generic rule's business, not endSealed's");
ok(!sealed(20, "Showing 1 to 20 of about 350 patients"), "paged estimate → not sealed");

// ── 2. a Set-1-like multi-location appointment list ──
const LOCS = ["Northgate", "Front Range", "Eastside", "Stonebrook", "Lakeside", "Riverbend"];
type R = { date: string; loc: string; start: number; name: string; pid: string; badges?: string };
const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const longDate = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return `${mon[m - 1]} ${d}, ${y}`; };
const hhmm = (min: number) => { const h = Math.floor(min / 60), m = min % 60; return `${(h + 11) % 12 + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };
const r25 = (n: number) => Math.round(n / 25) * 25;
/** `exactBelow`: totals under it are stated exactly ("89 appointments"); from it on "about N" (nearest 25). `cap`: the site's cut. */
type SimOpts = { step?: number; cap?: number; exactBelow?: number; hideLoc?: string; endFooter?: (shown: number, total: number) => string | null; noMoreAtCap?: boolean };
class DaySim {
  dom = new JSDOM("<!doctype html><html><body></body></html>"); st = { from: "", to: "", location: "", status: "", provider: "", page: 1 }; path = "/"; clicks = 0;
  constructor(public rows: R[], public o: SimOpts = {}) {}
  get doc() { return this.dom.window.document; }
  list() { const s = this.st; return this.rows.filter((r) => r.date >= s.from && r.date <= s.to && (!s.location || LOCS[+s.location - 1] === r.loc)).sort((a, b) => a.date.localeCompare(b.date) || a.start - b.start || a.pid.localeCompare(b.pid)); }
  nav(p: string) { const u = new URL("http://x" + p); this.path = u.pathname + u.search; if (u.pathname === "/schedule/appointments") { const q = u.searchParams; this.st = { from: q.get("start") ?? "", to: q.get("end") ?? "", location: q.get("location") ?? "", status: q.get("status") ?? "", provider: q.get("provider") ?? "", page: 1 }; this.render(); } else this.doc.body.innerHTML = "<h1>Schedule</h1>"; }
  render() {
    const d = this.doc, s = this.st, step = this.o.step ?? 20, cap = this.o.cap ?? 300, xb = this.o.exactBelow ?? 100;
    const all = this.list(), vis = all.slice(0, cap), shown = vis.slice(0, s.page * step), allIn = shown.length >= vis.length, cut = vis.length < all.length;
    const est = (n: number) => (n < xb ? n.toLocaleString("en-US") : "about " + r25(n).toLocaleString("en-US"));
    let footer = all.length === 0 ? "No appointments match"
      : !allIn ? `Showing ${shown.length} of ${est(all.length)} appointments`
        : cut ? `Showing ${shown.length} of ${est(all.length)} appointments`
          : (this.o.endFooter?.(shown.length, all.length) ?? `${est(all.length)} appointments`);
    if (this.o.noMoreAtCap && cut && allIn && s.page * step > vis.length + step) footer = "about 1,000 appointments";
    const cols = ["Date", "Time", "Patient", "Provider", "Visit type", "Status", ...(s.location ? [] : ["Location"])];
    const cell = (r: R, c: string) => ({ Date: `<a href="/patients/${r.pid}/appointments/${r.pid}x${r.start}">${longDate(r.date)}</a>`, Time: `${hhmm(r.start)} to ${hhmm(r.start + 20)} <span>CST</span>`, Patient: `<a href="/patients/${r.pid}">${r.name}</a> ${r.badges ? `<span>${r.badges}</span>` : ""}`, Provider: "Renee Lopez, MD", "Visit type": "Follow-up visit", Status: "<span>Completed</span>", Location: r.loc } as Record<string, string>)[c];
    const opt = (v: string, t: string, cur: string) => `<option value="${v}"${v === cur ? " selected" : ""}>${t}</option>`;
    d.body.innerHTML = `<h1>Schedule</h1><form aria-label="Filter appointments">
      <label for="start">From</label><input id="start" name="start" type="date" value="${s.from}"><label for="end">To</label><input id="end" name="end" type="date" value="${s.to}">
      <label for="location">Location</label><select id="location" name="location">${opt("", "All locations", s.location)}${LOCS.map((l, i) => l === this.o.hideLoc ? "" : opt(String(i + 1), l, s.location)).join("")}</select>
      <label for="provider">Provider</label><select id="provider" name="provider">${opt("", "All providers", s.provider)}<optgroup label="Active">${opt("1", "Renee Lopez, MD", s.provider)}</optgroup></select>
      <label for="status">Status</label><select id="status" name="status">${opt("", "All statuses", s.status)}${opt("2", "Completed", s.status)}</select>
      <button type="submit">Show appointments</button></form>
      <section><h2><span>Appointments from ${longDate(s.from)} to ${longDate(s.to)}</span></h2>
      <table><caption>Appointments, earliest first</caption><thead><tr>${cols.map((c) => `<th>${c}</th>`).join("")}</tr></thead>
      <tbody>${shown.map((r) => `<tr>${cols.map((c) => `<td>${cell(r, c)}</td>`).join("")}</tr>`).join("")}</tbody></table>
      <div><p aria-live="polite">${footer}</p>${allIn ? "" : `<div><button type="button">Show more</button></div>`}</div></section>`;
    [...d.querySelectorAll("section button")].find((x) => x.textContent === "Show more")?.addEventListener("click", () => { this.clicks++; this.st.page++; this.render(); });
  }
  crawler(): any {
    return { today: "2026-10-14", trace: () => {}, navTo: async (p: string) => { this.nav(p); return true; }, evalTop: async (js: string) => /pathname/.test(js) ? this.path : "Location: All locations. Change location",
      evalApp: async (js: string) => new Function("doc", "Event", js)(this.doc, this.dom.window.Event), pickerLabel: async () => "Location: All locations. Change location", ensureAllLocations: async () => true };
  }
}
const DAY = "2026-01-02";
let pidn = 0;
const fill = (loc: string, n: number, date = DAY, who: Array<[string, string]> = []): R[] => {
  const out: R[] = who.map(([name, pid], i) => ({ date, loc, start: 420 + i * 20, name, pid }));
  for (let i = out.length; i < n; i++) out.push({ date, loc, start: 420 + (i % 40) * 20, name: `Fill${pidn}, Pat${i}`, pid: "f" + pidn++ });
  return out;
};
const day = (extra: Partial<Record<string, [number, Array<[string, string]>]>> = {}, o: SimOpts = {}, more: R[] = []) => {
  const sizes: Record<string, [number, Array<[string, string]>]> = { Northgate: [112, []], "Front Range": [89, []], Eastside: [0, []], Stonebrook: [130, []], Lakeside: [101, []], Riverbend: [60, []], ...extra } as any;
  return new DaySim([...LOCS.flatMap((l) => fill(l, sizes[l][0], DAY, sizes[l][1])), ...more], o);
};
const run = async (site: DaySim, budget = 60000) => { const al = new ApptList(site.crawler()); al.begin(budget); return { out: await apptDayContext(al as any, DAY, budget), al }; };

{ // Ana Sanchez's visit is at Lakeside; another Ana Sanchez has a visit on a different day; nothing else shares the name
  const site = day({ Lakeside: [101, [["Sanchez, Ana", "anaB"]]] }, {}, [{ date: "2026-02-13", loc: "Northgate", start: 500, name: "Sanchez, Ana", pid: "anaA" }]);
  const { out } = await run(site);
  ok("rows" in out, `all six locations read to their (sealed or exact) ends: ${JSON.stringify(out).slice(0, 200)}`);
  if ("rows" in out) {
    eq(out.rows.length, 112 + 89 + 0 + 130 + 101 + 60, "every location's rows (89 = exact bare end footer, 0 = empty list, the rest sealed estimates)");
    eq(pickByContext(out.rows, "Ana Sanchez", { among: ["/patients/anaA", "/patients/anaB"] }).chosen?.href ?? null, "/patients/anaB", "two namesakes on the search list; only one has the visit that day → that one");
    eq(pickByContext(out.rows, "Ana Sanchez", { among: ["/patients/anaA", "/patients/anaC"] }).chosen, null, "the visit's patient is not one of the search's namesakes → decline");
  }
  ok(site.clicks > 20, "the long lists were walked with Show more");
}
{ // both namesakes have a visit that day (at different locations) → the day cannot tell them apart
  const site = day({ Lakeside: [101, [["Sanchez, Ana", "anaB"]]], Northgate: [112, [["Sanchez, Ana", "anaA"]]] });
  const { out } = await run(site);
  ok("rows" in out && pickByContext(out.rows, "Ana Sanchez", { among: ["/patients/anaA", "/patients/anaB"] }).chosen === null, "both namesakes on the day (different locations) → decline");
}
{ // a namesake at the LAST location only: reading a single location (the 278 run's Northgate) would have picked the wrong Cole
  const site = day({ Northgate: [112, [["Cole, María", "cole1"]]], Riverbend: [60, [["Cole, María", "cole2"]]] });
  const { out } = await run(site);
  ok("rows" in out && pickByContext(out.rows, "María Cole").chosen === null, "same name at two locations → decline (every location is read)");
}
{ // the exact bare end footer after Show more is no "pager form change" (run 278 item 127: "89 appointments")
  const site = day({ "Front Range": [89, [["Wells, Harold", "w1"]]] });
  const { out } = await run(site);
  ok("rows" in out && pickByContext(out.rows, "Harold Wells").chosen?.href === "/patients/w1", `"89 appointments" end footer reads through: ${JSON.stringify(out).slice(0, 160)}`);
}
{ // the aggregate path (not sealed) still declines the estimate end and accepts the exact one
  const site = day();
  const al = new ApptList(site.crawler()); al.begin(60000);
  const est = await al.read({ from: DAY, to: DAY, status: "any", location: "Northgate" });
  ok("fail" in est && /estimate/.test(est.fail), `unsealed read of "about 100 appointments" still declines: ${JSON.stringify(est).slice(0, 120)}`);
  const exact = await al.read({ from: DAY, to: DAY, status: "any", location: "Front Range" });
  ok("rows" in exact && exact.rows.length === 89, "unsealed read of an exact bare count is complete (it was a 'pager form' failure before)");
  const sealedR = await al.read({ from: DAY, to: DAY, status: "any", location: "Northgate", sealed: true });
  ok("rows" in sealedR && sealedR.rows.length === 112, "sealed read of the same list is complete");
}
{ // the cap: a location with more rows than the site shows keeps "Showing 300 of about N" → decline
  const { out } = await run(day({ Stonebrook: [340, []] }));
  ok("fail" in out && /Stonebrook/.test(out.fail), `a location cut at the cap declines: ${JSON.stringify(out).slice(0, 200)}`);
}
{ // a list that stops short of its stated size: bare "about N" with far fewer rows
  const { out } = await run(day({}, { endFooter: (shown, total) => total === 130 ? "about 250 appointments" : null }));
  ok("fail" in out && /Stonebrook/.test(out.fail), `bare estimate far above the rows read declines: ${JSON.stringify(out).slice(0, 200)}`);
}
{ // a location the filter does not offer: the six locations' rows fall short of the all-locations list
  const { out } = await run(day({ Riverbend: [150, []] }, { hideLoc: "Riverbend" }));
  ok("fail" in out && /all-locations/.test(out.fail), `a location missing from the filter shows as a gap: ${JSON.stringify(out).slice(0, 200)}`);
}
{ // a badge on the day's row (merged / test record / deleted) keeps the pick from answering
  const site = day({ Eastside: [10, [["Bell, Astrid", "b1"]]] }, {}, []); site.rows.find((r) => r.pid === "b1")!.badges = "Test record";
  const { out } = await run(site);
  ok("rows" in out && pickByContext(out.rows, "Astrid Bell").chosen === null, "a Test record row → decline");
}
{ // good-faith: the asked time must be the patient's row
  const site = day({ Eastside: [10, [["Watkins, Patrick", "pw"]]] });
  const { out } = await run(site);
  ok("rows" in out && pickByContext(out.rows, "Patrick Watkins", { start: 420 }).chosen?.href === "/patients/pw" && pickByContext(out.rows, "Patrick Watkins", { start: 780 }).chosen === null, "asked time must be the patient's row (07:00 yes, 13:00 no)");
}

// ── 3. a day's lab reports (Documents filtered by type + received date) ──
class DocSim {
  dom = new JSDOM("<!doctype html><html><body></body></html>"); st = { kind: "", from: "", to: "", page: 1 }; clicks = 0;
  constructor(public docs: Array<{ date: string; kind: string; title: string; name: string; pid: string }>, public o: { step?: number; cap?: number; endFooter?: (n: number, total: number) => string | null } = {}) {}
  get doc() { return this.dom.window.document; }
  nav(p: string) { const u = new URL("http://x" + p); if (u.pathname === "/documents") { const q = u.searchParams; this.st = { kind: q.get("kind") ?? "", from: q.get("from") ?? "", to: q.get("to") ?? "", page: 1 }; this.render(); } else this.doc.body.innerHTML = "<h1>Patients</h1>"; }
  render() {
    const d = this.doc, s = this.st, step = this.o.step ?? 20, cap = this.o.cap ?? 300;
    const all = this.docs.filter((x) => (!s.kind || x.kind === s.kind) && (!s.from || x.date >= s.from) && (!s.to || x.date <= s.to)), vis = all.slice(0, cap), shown = vis.slice(0, s.page * step), allIn = shown.length >= vis.length, cut = vis.length < all.length;
    const est = (n: number) => (n < 100 ? String(n) : "about " + r25(n));
    const footer = all.length === 0 ? "No documents match" : !allIn || cut ? `Showing ${shown.length} of ${est(all.length)} documents` : (this.o.endFooter?.(shown.length, all.length) ?? `${est(all.length)} documents`);
    const opt = (v: string, t: string, cur: string) => `<option value="${v}"${v === cur ? " selected" : ""}>${t}</option>`;
    d.body.innerHTML = `<h1>Documents</h1><form aria-label="Filter documents"><label for="kind">Type</label><select id="kind" name="kind">${opt("", "All types", s.kind)}${opt("lab_report", "Lab report", s.kind)}${opt("referral_letter", "Referral letter", s.kind)}</select>
      <label for="from">Received from</label><input id="from" name="from" type="date" value="${s.from}"><label for="to">Received to</label><input id="to" name="to" type="date" value="${s.to}"><button type="submit">Apply</button></form>
      <table><caption>Documents received, newest first</caption><thead><tr><th>Received</th><th>Type</th><th>Title</th><th>Patient</th><th><span>Actions</span></th></tr></thead>
      <tbody>${shown.map((x) => `<tr><td>${longDate(x.date)}</td><td>${x.kind === "lab_report" ? "Lab report" : "Referral letter"}</td><td>${x.title}</td><td><span><a href="/patients/${x.pid}">${x.name}</a>   </span></td><td><a href="/documents/d${x.pid}${x.title.length}">View</a></td></tr>`).join("")}</tbody></table>
      <div><p aria-live="polite">${footer}</p>${allIn ? "" : `<div><button type="button">Show more</button></div>`}</div>`;
    [...d.querySelectorAll("button")].find((x) => x.textContent === "Show more")?.addEventListener("click", () => { this.clicks++; this.st.page++; this.render(); });
  }
  crawler(): any {
    return { navTo: async (p: string) => { this.nav(p); return true; }, ensureAllLocations: async () => true, evalApp: async (js: string) => new Function("doc", "Event", js)(this.doc, this.dom.window.Event) };
  }
}
const labs = (n: number, who: Array<[string, string, string]> = []) => {
  const out = who.map(([name, pid, panel]) => ({ date: "2026-09-30", kind: "lab_report", title: `Lab report: ${panel}`, name, pid }));
  for (let i = out.length; i < n; i++) out.push({ date: "2026-09-30", kind: "lab_report", title: `Lab report: ${["Complete blood count", "Basic metabolic panel", "Hemoglobin A1c"][i % 3]}`, name: `Fill, Doc${i}`, pid: "q" + i });
  return out;
};
const other = [{ date: "2026-09-29", kind: "lab_report", title: "Lab report: Complete blood count", name: "Murphy, Teresa", pid: "old" }, { date: "2026-09-30", kind: "referral_letter", title: "Referral letter: X", name: "Murphy, Teresa", pid: "old2" }];
{
  const site = new DocSim([...labs(97, [["Murphy, Teresa", "tm", "Complete blood count"]]), ...other]);
  const out = await labDocContext(site.crawler(), "2026-09-30", "Complete blood count", 30000);
  ok("rows" in out, `97 lab reports ("about 100 documents") read to the sealed end: ${JSON.stringify(out).slice(0, 160)}`);
  if ("rows" in out) eq(pickByContext(out.rows, "Teresa Murphy").chosen?.href ?? null, "/patients/tm", "Teresa Murphy's CBC that day → her chart (the other day's report and the referral letter are filtered out)");
}
{ // a namesake with the same report that day is ambiguous
  const site = new DocSim(labs(97, [["Murphy, Teresa", "tm", "Complete blood count"], ["Murphy, Teresa", "tm2", "Complete blood count"]]));
  const out = await labDocContext(site.crawler(), "2026-09-30", "Complete blood count", 30000);
  ok("rows" in out && pickByContext(out.rows, "Teresa Murphy").chosen === null, "two Teresa Murphys with the report that day → decline");
}
{ // a list that stopped short of its stated size
  const site = new DocSim(labs(97, [["Murphy, Teresa", "tm", "Complete blood count"]]), { endFooter: () => "about 250 documents" });
  const out = await labDocContext(site.crawler(), "2026-09-30", "Complete blood count", 30000);
  ok("fail" in out, `bare estimate far from the 97 rows → decline: ${JSON.stringify(out).slice(0, 120)}`);
}
{ // a cut list ("Showing 300 of about 400 documents", no control)
  const site = new DocSim(labs(400, [["Murphy, Teresa", "tm", "Complete blood count"]]));
  const out = await labDocContext(site.crawler(), "2026-09-30", "Complete blood count", 30000);
  ok("fail" in out, `a list cut at the site's cap → decline: ${JSON.stringify(out).slice(0, 120)}`);
}
{ // a short day: exact total still works
  const site = new DocSim(labs(12, [["Murphy, Teresa", "tm", "Complete blood count"]]));
  const out = await labDocContext(site.crawler(), "2026-09-30", "Complete blood count", 30000);
  ok("rows" in out && pickByContext(out.rows, "Teresa Murphy").chosen?.href === "/patients/tm", "a 12-report day (exact total) still resolves");
}

// ── 3b. captured Set 1 pages (run 278 skip probes; the capture keeps the head and the tail of the page, so rows are
// partial and only footers, controls and the patient list are asserted) ──
{
  const fx = (p: string) => readFileSync(new URL("../../fixtures/set1/" + p, import.meta.url), "utf8");
  // jsdom has no innerText (a browser separates text nodes by line breaks, which the footer greps rely on): one text node a line
  const dom1 = (html: string) => { const d = new JSDOM(html); Object.defineProperty(d.window.HTMLElement.prototype, "innerText", { get() { const w = d.window.document.createTreeWalker(this, 4); const out: string[] = []; while (w.nextNode()) out.push(w.currentNode.textContent ?? ""); return out.join("\n"); } }); return d; };
  const pageOf = (f: string) => { const dom = dom1(fx(f)); return new Function("doc", "Event", PAGE_EXTRACT)(dom.window.document, dom.window.Event) as RawPage; };
  const a100 = pageOf("probe-278-appts-northgate-about100.html");
  eq([a100.footer, a100.more?.present, a100.next.present, a100.empty], ["about 100 appointments", false, false, false], "item 174's Northgate list (2026-01-02): the bare estimate end, no control, no 'No more results'");
  const r100 = rangeOf(a100.footer);
  eq([r100?.end, r100?.approx, r100?.total, r100?.cumulative], [true, true, 100, true], "…parses as an end footer with an estimate");
  ok(endSealed(112, listFooter(a100.footer), { more: "none" }).complete && !isComplete(112, listFooter(a100.footer), { more: "none" }).complete, "…sealed for a context read (112 rows), never complete under the generic rule");
  const a89 = pageOf("probe-278-appts-northgate-exact89.html");
  eq([a89.footer, a89.more?.present], ["89 appointments", false], "item 127's Northgate list (2026-07-24): the exact bare end footer");
  const r89 = rangeOf(a89.footer);
  eq([r89?.end, r89?.approx, r89?.total, r89?.cumulative], [true, undefined, 89, undefined], "…an END footer (it was 'list changed its pager form after Show more' before)");
  ok(isComplete(89, listFooter(a89.footer), { more: "none" }).complete && !isComplete(88, listFooter(a89.footer), { more: "none" }).complete, "…complete at 89 rows, not at 88");
  const ddom = dom1(fx("probe-278-docs-lab-about100.html"));
  const draw = new Function("doc", DOCS_EXTRACT)(ddom.window.document) as DocsRaw;
  const dfoot = docFooter(draw.footer);
  eq([draw.footer, draw.more.present, draw.next.present, draw.noMore, dfoot && dfoot.approx, dfoot && dfoot.cumulative], ["about 100 documents", false, false, false, true, true], "item 10's Documents list (lab reports 2026-09-30): the bare estimate end");
  ok(!!dfoot && endSealed(97, dfoot.footer, { more: "none" }).complete, "…sealed at ~97 rows");

  // item 223: two charts named Ana Sanchez on the (complete) search list; the visit that day names one of them
  const sdom = new JSDOM(fx("probe-278-patients-sanchez.html")); const sd = sdom.window.document;
  const prow = [...sd.querySelectorAll("tbody tr")].map((tr) => ({ name: tr.querySelector("a")!.textContent!.trim(), href: tr.querySelector("a")!.getAttribute("href")!, row: [...tr.children].map((td) => td.textContent!.replace(/\s+/g, " ").trim()).join("\t"), cells: [...tr.children].map((td) => td.textContent!.replace(/\s+/g, " ").trim()), head: [...sd.querySelectorAll("thead th")].map((th) => th.textContent!.trim()) }));
  const found = parsePatientRows(prow);
  const search: PatientSearch = { searchByDob: async () => [], searchPatientsPaged: async () => ({ rows: found, complete: true, pages: 1 }) };
  const res = await resolvePatient(search, "Ana Sanchez");
  eq([res.chosen, res.why, res.matchHrefs?.length], [null, "2 patients named Ana Sanchez", 2], "item 223: the search finds two charts named Ana Sanchez");
  const [h1, h2] = res.matchHrefs!;
  const visit = (href: string): CtxRow[] => [{ name: "Cunningham, Patricia", href: "/patients/zz1" }, { name: "Sanchez, Ana", href, start: 600 }, { name: "Sanchez, Ahmed", href: "/patients/ah1" }];
  eq(pickByContext(visit(h2), "Ana Sanchez", { among: res.matchHrefs }).chosen?.href ?? null, h2, "…the one with the visit that day wins");
  eq(pickByContext([...visit(h2), { name: "Sanchez, Ana", href: h1, start: 700 }], "Ana Sanchez", { among: res.matchHrefs }).chosen, null, "…both with a visit that day: decline");
  eq(pickByContext(visit("/patients/other9"), "Ana Sanchez", { among: res.matchHrefs }).chosen, null, "…a third Ana Sanchez with the visit (not a namesake the search listed): decline");
}

// ── 4. the pacer's context allowance ──
{
  let t = 5; const p = new Pacer(900, 0, 8, 20, 6, 3, 0.08, 0.5, () => t * 1000);
  for (let i = 0; i < 25; i++) { p.begin(900 - t); p.end("lab-report-triage", 12000, true); t += 12; } // Set 1's opening: labs at 12 s
  p.begin(900 - t);
  ok(!p.extraOk(2) && p.extraSlackS() === 0, "Set-1-style opening projects 'behind': the pace slack is 0");
  const a = p.ctxAdmit(2); ok(!!a, "…but a lab context read is admitted by the allowance");
  a?.done(1.5);
  const b = p.ctxAdmit(15); ok(!!b, "…and so is the first visit-day read");
  b?.done(10);
  const c = p.ctxAdmit(15); ok(!!c, "…and a second (13.5 of 45 s spent)");
  c?.done(30);
  ok(p.ctxAdmit(15) === null, "…the allowance (5 % of the shift) is then spent: refused");
  const late = new Pacer(900, 0, 8, 20, 6, 3, 0.08, 0.5, () => 880 * 1000); late.begin(20);
  ok(late.ctxAdmit(2) !== null, "no history: allowed (Infinity slack)");
  let t2 = 5; const q = new Pacer(900, 0, 8, 20, 6, 3, 0.08, 0.5, () => t2 * 1000);
  for (let i = 0; i < 25; i++) { q.begin(900 - t2); q.end("lab-report-triage", 12000, true); t2 += 12; }
  t2 = 880; q.begin(20);
  ok(q.ctxAdmit(2) === null, "20 s left and behind: refused (needs the extras reserve)");
}

console.log(`\nctxLists: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
