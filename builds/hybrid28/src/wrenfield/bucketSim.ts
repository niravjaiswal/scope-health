/**
 * A simulated Wrenfield appointment list for tests (ctxLists.test's markup) whose answers slow down as the account's request budget
 * drains, as run s3a's log shows (siteBudget.ts): lat = 80 + 65·max(0, used − 10) ms, `used` refilled at `refillPerS`; a request at
 * lat > 700 is answered with the degraded busy page (no new rows, the notice). Rows carry a date, location, status and patient.
 */
import { JSDOM } from "jsdom";
import { SLOPE_MS, BUSY_AT_MS } from "./siteBudget.js";

export const LOCS = ["Northgate", "Front Range", "Eastside", "Stonebrook", "Lakeside", "Riverbend"];
export type R = { date: string; loc: string; start: number; name: string; pid: string; status?: string; flags?: string };
const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const longDate = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return `${mon[m - 1]} ${d}, ${y}`; };
const hhmm = (min: number) => { const h = Math.floor(min / 60), m = min % 60; return `${(h + 11) % 12 + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };
const r25 = (n: number) => Math.round(n / 25) * 25;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export class BucketSim {
  dom = new JSDOM("<!doctype html><html><body></body></html>"); st = { from: "", to: "", location: "", status: "", page: 1 }; path = "/";
  used = 0; usedAt = Date.now(); requests = 0; busyPages = 0; maxLat = 0; busyShown = false; loads = 0; presses = 0;
  /** `exactBelow`: totals under it are stated exactly ("89 appointments"); from it on "about N" (nearest 25). `cap`: the site's cut. */
  constructor(public rows: R[], public refillPerS = 1.4, public o: { exactBelow?: number; cap?: number } = {}) {}
  get doc() { return this.dom.window.document; }
  /** take one request from the bucket: its latency, or -1 for busy */
  take(): number {
    const now = Date.now(); this.used = Math.max(0, this.used - (this.refillPerS * (now - this.usedAt)) / 1000); this.usedAt = now;
    this.used++; this.requests++;
    const lat = 80 + SLOPE_MS * Math.max(0, this.used - 10);
    if (lat > BUSY_AT_MS) { this.busyPages++; return -1; }
    this.maxLat = Math.max(this.maxLat, lat); return lat;
  }
  list() { const s = this.st; return this.rows.filter((r) => r.date >= s.from && r.date <= s.to && (!s.location || LOCS[+s.location - 1] === r.loc) && (!s.status || (r.status ?? "Completed") === (s.status === "2" ? "Completed" : s.status === "1" ? "Scheduled" : ""))).sort((a, b) => a.date.localeCompare(b.date) || a.start - b.start || a.pid.localeCompare(b.pid)); }
  async nav(p: string) {
    const u = new URL("http://x" + p); this.path = u.pathname + u.search;
    if (u.pathname !== "/schedule/appointments") { this.doc.body.innerHTML = "<h1>Schedule</h1>"; return; }
    const q = u.searchParams; this.st = { from: q.get("start") ?? "", to: q.get("end") ?? "", location: q.get("location") ?? "", status: q.get("status") ?? "", page: 1 };
    this.loads++; const lat = this.take(); await sleep(lat < 0 ? 300 : lat); this.render(lat < 0);
  }
  render(busy = false) {
    const d = this.doc, s = this.st, step = 20, cap = this.o.cap ?? 300, xb = this.o.exactBelow ?? 100;
    const all = this.list(), vis = all.slice(0, cap), shown = vis.slice(0, (busy ? s.page - 1 : s.page) * step), allIn = shown.length >= vis.length, cut = vis.length < all.length;
    const est = (n: number) => (n < xb ? String(n) : "about " + r25(n).toLocaleString("en-US"));
    const footer = all.length === 0 ? "No appointments match" : !allIn || cut ? `Showing ${shown.length} of ${est(all.length)} appointments` : `${est(all.length)} appointments`;
    const cols = ["Date", "Time", "Patient", "Provider", "Visit type", "Status", ...(s.location ? [] : ["Location"])];
    const cell = (r: R, c: string) => ({ Date: `<a href="/patients/${r.pid}/appointments/${r.pid}x${r.date}${r.start}">${longDate(r.date)}</a>`, Time: `${hhmm(r.start)} to ${hhmm(r.start + 20)} <span>CST</span>`, Patient: `<a href="/patients/${r.pid}">${r.name}</a>${r.flags ? ` <span>${r.flags}</span>` : ""}`, Provider: "Renee Lopez, MD", "Visit type": "Follow-up visit", Status: `<span>${r.status ?? "Completed"}</span>`, Location: r.loc } as Record<string, string>)[c];
    const opt = (v: string, t: string, cur: string) => `<option value="${v}"${v === cur ? " selected" : ""}>${t}</option>`;
    this.busyShown = busy;
    d.body.innerHTML = `<h1>Schedule</h1><form aria-label="Filter appointments">
      <label for="start">From</label><input id="start" name="start" type="date" value="${s.from}"><label for="end">To</label><input id="end" name="end" type="date" value="${s.to}">
      <label for="location">Location</label><select id="location" name="location">${opt("", "All locations", s.location)}${LOCS.map((l, i) => opt(String(i + 1), l, s.location)).join("")}</select>
      <label for="status">Status</label><select id="status" name="status">${opt("", "All statuses", s.status)}${opt("1", "Scheduled", s.status)}${opt("2", "Completed", s.status)}</select>
      <button type="submit">Show appointments</button></form>
      <section><h2><span>Appointments from ${longDate(s.from)} to ${longDate(s.to)}</span></h2>
      ${busy ? `<p role="status">Wrenfield is busy, so this list shows fewer rows than usual. Open it again in a moment.</p>` : ""}
      <table><caption>Appointments, earliest first</caption><thead><tr>${cols.map((c) => `<th>${c}</th>`).join("")}</tr></thead>
      <tbody>${shown.map((r) => `<tr>${cols.map((c) => `<td>${cell(r, c)}</td>`).join("")}</tr>`).join("")}</tbody></table>
      <div><p aria-live="polite">${footer}</p>${allIn ? "" : `<div><button type="button">Show more</button></div>`}</div></section>`;
    [...d.querySelectorAll("section button")].find((x) => x.textContent === "Show more")?.addEventListener("click", () => {
      this.presses++; const lat = this.take(); this.st.page++; setTimeout(() => this.render(lat < 0), lat < 0 ? 300 : lat);
    });
  }
  crawler(): any {
    return { today: "2026-10-14", trace: () => {}, navTo: async (p: string) => { await this.nav(p); return true; }, evalTop: async (js: string) => /pathname/.test(js) ? this.path : "Location: All locations. Change location",
      evalApp: async (js: string) => new Function("doc", "Event", js)(this.doc, this.dom.window.Event), pickerLabel: async () => "Location: All locations. Change location", ensureAllLocations: async () => true };
  }
}
let pidn = 0;
/** n rows at `loc` on `date`, the named patients first */
export const fill = (loc: string, n: number, date: string, who: Array<[string, string]> = []): R[] => {
  const out: R[] = who.map(([name, pid], i) => ({ date, loc, start: 420 + i * 20, name, pid }));
  for (let i = out.length; i < n; i++) out.push({ date, loc, start: 420 + (i % 40) * 20, name: `Fill${pidn}, Pat${i}`, pid: "f" + pidn++ });
  return out;
};
