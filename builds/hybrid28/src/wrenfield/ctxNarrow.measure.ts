/**
 * Not a gate: a real-time scale-1 model of run 265's visit days (rows per location from the logged aggregate-read lines, a press
 * costing 300 ms and a page load 500 ms as the run measured), to print what the whole-day read costs on one tab and on three.
 *   npx tsx src/wrenfield/ctxNarrow.measure.ts
 */
import { JSDOM } from "jsdom";
import { ApptList } from "./apptList.js";
import { apptDayContext, pickByContext } from "./contextResolve.js";

const LOCS = ["Northgate", "Front Range", "Eastside", "Stonebrook", "Lakeside", "Riverbend", "Highline", "Prairie View", "Cedar Hollow", "Willow Creek"];
const r25 = (n: number) => Math.round(n / 25) * 25;
const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const longDate = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return `${mon[m - 1]} ${d}, ${y}`; };
const hhmm = (min: number) => { const h = Math.floor(min / 60), m = min % 60; return `${(h + 11) % 12 + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };
type R = { loc: string; start: number; name: string; pid: string };
class Sim {
  dom = new JSDOM("<!doctype html><html><body></body></html>"); loc = ""; page = 1; clicks = 0;
  constructor(public day: string, public rows: R[], public pressMs: number, public loadMs: number) {}
  get doc() { return this.dom.window.document; }
  render() {
    const d = this.doc, all = this.rows.filter((r) => !this.loc || LOCS[+this.loc - 1] === r.loc).sort((a, b) => a.start - b.start), shown = all.slice(0, this.page * 20), allIn = shown.length >= all.length;
    const est = (n: number) => (n < 100 ? String(n) : "about " + r25(n));
    const footer = !allIn ? `Showing ${shown.length} of ${est(all.length)} appointments` : `${est(all.length)} appointments`;
    const opt = (v: string, t: string, cur: string) => `<option value="${v}"${v === cur ? " selected" : ""}>${t}</option>`;
    d.body.innerHTML = `<h1>Schedule</h1><form aria-label="Filter appointments"><label for="start">From</label><input id="start" name="start" type="date" value="${this.day}"><label for="end">To</label><input id="end" name="end" type="date" value="${this.day}">
      <label for="location">Location</label><select id="location" name="location">${opt("", "All locations", this.loc)}${LOCS.map((l, i) => opt(String(i + 1), l, this.loc)).join("")}</select>
      <label for="status">Status</label><select id="status" name="status">${opt("", "All statuses", "")}${opt("2", "Completed", "")}</select><button type="submit">Show appointments</button></form>
      <section><h2><span>Appointments from ${longDate(this.day)} to ${longDate(this.day)}</span></h2><table><caption>Appointments, earliest first</caption><thead><tr><th>Date</th><th>Time</th><th>Patient</th><th>Provider</th><th>Visit type</th><th>Status</th></tr></thead>
      <tbody>${shown.map((r) => `<tr><td><a href="/patients/${r.pid}/appointments/${r.pid}x">${longDate(this.day)}</a></td><td>${hhmm(r.start)} to ${hhmm(r.start + 20)} <span>CST</span></td><td><a href="/patients/${r.pid}">${r.name}</a></td><td>Renee Lopez, MD</td><td>Office visit</td><td><span>Completed</span></td></tr>`).join("")}</tbody></table>
      <div><p aria-live="polite">${footer}</p>${allIn ? "" : `<div><button type="button">Show more</button></div>`}</div></section>`;
    [...d.querySelectorAll("section button")].find((x) => x.textContent === "Show more")?.addEventListener("click", () => { this.clicks++; setTimeout(() => { this.page++; this.render(); }, this.pressMs); });
  }
  crawler(): any {
    return { today: "2026-10-14", trace: () => {}, navTo: async (p: string) => { await new Promise((r) => setTimeout(r, this.loadMs)); const u = new URL("http://x" + p); this.loc = u.searchParams.get("location") ?? ""; this.page = 1; this.render(); return true; },
      evalTop: async (js: string) => /pathname/.test(js) ? "/" : "Location: All locations", evalApp: async (js: string) => new Function("doc", "Event", js)(this.doc, this.dom.window.Event), pickerLabel: async () => "Location: All locations", ensureAllLocations: async () => true };
  }
}
const days: Array<[string, string, number[]]> = [
  ["item 174 (Astrid Bell, filing, 2026-01-02)", "2026-01-02", [105, 74, 90, 31, 46, 125, 60, 85, 40, 55]],
  ["item 175 (Kenneth Howell, filing, 2025-12-18)", "2025-12-18", [129, 54, 75, 80, 70, 90, 60, 85, 50, 60]],
  ["item 65 (Priya Mitchell, tetanus, 2025-08-21)", "2025-08-21", [136, 56, 87, 73, 90, 110, 70, 95, 60, 80]],
];
for (const [label, day, sizes] of days) {
  const rows: R[] = LOCS.flatMap((l, i) => Array.from({ length: sizes[i] }, (_, k) => ({ loc: l, start: 420 + Math.floor(k / 2) * 20, name: `Fill${i}, P${k}`, pid: `f${i}_${k}` })));
  rows.push({ loc: "Eastside", start: 600, name: "Target, Pat", pid: "target" });
  for (const tabs of [1, 3]) {
    const sims = Array.from({ length: tabs }, () => new Sim(day, rows, 300, 500)); const q = sims.slice(1);
    const al = new ApptList(sims[0].crawler(), () => {}, async () => { const t = q.shift(); return t ? t.crawler() : null; });
    const t0 = Date.now(); const out = await apptDayContext(al, day, 60000);
    console.log(`${label}: ${tabs} tab(s): ${((Date.now() - t0) / 1000).toFixed(1)} s, ${"rows" in out ? out.rows.length + " rows, pick " + (pickByContext(out.rows, "Pat Target").chosen?.href ?? "none") : JSON.stringify(out)}, presses ${sims.map((s) => s.clicks).join("/")}`);
  }
}
process.exit(0);
