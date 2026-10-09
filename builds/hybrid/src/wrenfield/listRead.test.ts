/**
 * ListReader (listRead.ts) against a fake list app in jsdom: the real browser-side extractors and the real walker.
 *   - URL filters taken (Documents-like): filters verified on the controls, Rows per page raised, Next walked, exact total;
 *   - URL filters ignored (Billing-like): the GET form filled by label and submitted; "31 invoices" one-page footer;
 *   - Show more (Set 1 Documents-like): append-only presses to an exact total / the "about N" end form;
 *   - a list that stops early, a page that repeats rows, an estimate-only footer → failures (never an answer).
 *   npx tsx src/wrenfield/listRead.test.ts
 */
import { JSDOM } from "jsdom";
import { ListReader } from "./listRead.js";
import type { ListRow } from "./listQuery.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("FAIL", m); } };

type Row = { date: string; type?: string; loc?: string; status?: string; name: string; badge?: string; num?: string };
type Mode = { kind: "documents" | "invoices"; url: boolean; pager: "next" | "more"; size: number; stopAt?: number; repeat?: boolean; approx?: boolean; endForm?: boolean };
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmt = (d: string) => `${MON[+d.slice(5, 7) - 1]} ${+d.slice(8)}, ${d.slice(0, 4)}`;

/** (jsdom has no innerText: the extractors read textContent, so the markup keeps the line breaks a browser's innerText would.)
 *  A tiny list app: renders the filter form + table + footer from its state; Next / Show more / Apply re-render. */
class FakeApp {
  dom = new JSDOM("<!doctype html><body></body>"); doc = this.dom.window.document;
  st: Record<string, string> = {}; page = 1; shown = 0; path = "/"; picker = "All locations";
  constructor(public m: Mode, public rows: Row[]) {}
  matches() {
    const s = this.st; const k = this.m.kind;
    return this.rows.filter((r) => k === "documents"
      ? (!s.kind || r.type === s.kind) && (!s.from || r.date >= s.from) && (!s.to || r.date <= s.to)
      : (!s.location || r.loc === s.location) && (!s.status || r.status === s.status) && (!s.issuedFrom || r.date >= s.issuedFrom) && (!s.issuedTo || r.date <= s.issuedTo));
  }
  nav(pathQs: string) {
    const [p, q] = pathQs.split("?"); this.path = p; this.page = 1; this.shown = this.m.size;
    this.st = {}; if (q && this.m.url) for (const kv of q.split("&")) { const [k, v] = kv.split("=").map(decodeURIComponent); this.st[k] = v; }
    if (this.st.size) { this.m.size = +this.st.size; this.shown = this.m.size; delete this.st.size; }
    this.render();
  }
  render() {
    const d = this.doc, m = this.m, all = this.matches();
    const sel = (name: string, label: string, opts: Array<[string, string]>) => `<label for="${name}">${label}</label><select id="${name}" name="${name}">${opts.map(([v, t]) => `<option value="${v}"${this.st[name] === v ? " selected" : ""}>${t}</option>`).join("")}</select>`;
    const inp = (name: string, label: string) => `<input type="date" id="${name}" name="${name}" aria-label="${label}" value="${this.st[name] ?? ""}">`;
    const form = m.kind === "documents"
      ? sel("kind", "Type", [["", "All types"], ["Referral letter", "Referral letter"], ["Lab report", "Lab report"], ["Statement", "Statement"]]) + `<label for="from">Received from</label>` + inp("from", "") + `<label for="to">Received to</label>` + inp("to", "")
      : sel("location", "Location", [["", "All locations"], ["Northgate", "Northgate"], ["Eastside", "Eastside"]]) + sel("status", "Status", [["", "All statuses"], ["Open", "Open"], ["Paid", "Paid"], ["Void", "Void"]]) + inp("issuedFrom", "Issued date from") + inp("issuedTo", "Issued date to") + inp("serviceFrom", "Service date from") + inp("serviceTo", "Service date to");
    let list: Row[]; let footer: string; let next = "", more = "";
    if (m.pager === "next") {
      const a = (this.page - 1) * m.size; list = all.slice(a, a + m.size);
      if (m.stopAt !== undefined && a >= m.stopAt) list = [];
      if (m.repeat && this.page === 2) list = all.slice(0, m.size);
      footer = all.length <= m.size ? `${all.length} ${m.kind}` : m.approx ? `Showing ${a + 1} to ${a + list.length} of about ${all.length + 40} ${m.kind}` : `Showing ${a + 1} to ${a + list.length} of ${all.length} ${m.kind}`;
      const hasNext = a + m.size < all.length && !(m.stopAt !== undefined && a + m.size >= m.stopAt);
      next = `<nav aria-label="Pagination"><button type="button" id="prev">Previous</button><button type="button" id="next"${hasNext ? "" : " disabled"}>Next</button></nav>`;
    } else {
      list = all.slice(0, this.shown);
      const done = this.shown >= all.length;
      footer = done && m.endForm ? `about ${Math.round(all.length / 10) * 10} ${m.kind}` : `Showing ${list.length} of ${m.approx ? "about " : ""}${m.approx ? Math.round(all.length / 10) * 10 : all.length} ${m.kind}`;
      if (!done) more = `<button type="button" id="more">Show more</button>`;
    }
    const head = m.kind === "documents" ? ["Received", "Type", "Title", "Patient", "Actions"] : ["Invoice", "Patient", "Location", "Service date", "Issued", "Total", "Status"];
    const tr = (r: Row) => m.kind === "documents"
      ? `<tr><td>${fmt(r.date)}</td><td>${r.type}</td><td>${r.type}: x</td><td><span>${r.name}</span>${r.badge ? ` <span>${r.badge}</span>` : ""}</td><td><a href="/documents/x">View</a></td></tr>`
      : `<tr><td><a href="/billing/invoices/${r.num}">${r.num}</a></td><td><span>${r.name}</span>${r.badge ? ` <span>${r.badge}</span>` : ""}</td><td>${r.loc}</td><td>${fmt(r.date)}</td><td>${fmt(r.date)}</td><td>$10.00</td><td><span>${r.status}</span></td></tr>`;
    d.body.innerHTML = `<main><h1>${m.kind === "documents" ? "Documents" : "Billing"}</h1><form aria-label="Filters" method="get">${form}<button type="submit">Apply</button><button type="button">Clear filters</button></form>
      <table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${list.map(tr).join("\n")}</tbody></table>\n<p>${footer}</p>\n${more}${next}
      <label for="size">Rows per page</label><select id="size" name="size">${[25, 50, 100].map((n) => `<option value="${n}"${n === m.size ? " selected" : ""}>${n} per page</option>`).join("")}</select></main>`;
    const q = (id: string) => d.getElementById(id);
    q("next")?.addEventListener("click", () => { this.page++; this.render(); });
    q("more")?.addEventListener("click", () => { this.shown += this.m.size; this.render(); });
    q("size")?.addEventListener("change", (e: any) => { this.m.size = +e.target.value; this.page = 1; this.shown = this.m.size; this.render(); });
    d.querySelector("form")!.addEventListener("submit", (e) => { e.preventDefault(); this.st = {}; for (const el of [...d.querySelectorAll("form select, form input")] as any[]) if (el.value) this.st[el.name] = el.value; this.page = 1; this.shown = this.m.size; this.render(); });
  }
}
/** The Crawler surface ListReader uses, over the fake app. */
const crawlerFor = (app: FakeApp): any => ({
  today: "2026-10-14",
  navTo: async (p: string) => { app.nav(p); return true; },
  evalApp: async (js: string) => new Function("doc", "Event", js)(app.doc, app.dom.window.Event),
  evalTop: async () => app.path,
  ensureAllLocations: async () => app.picker === "All locations", pickerLabel: async () => app.picker,
  trace: () => {},
});
const docRows = (n: number, date = "2026-10-12", type = "Lab report"): Row[] => Array.from({ length: n }, (_, i) => ({ date, type, name: `Doe${i}, Jane`, badge: i === 3 ? "Restricted" : undefined }));
const invRows = (n: number, date = "2026-10-12", loc = "Northgate"): Row[] => Array.from({ length: n }, (_, i) => ({ date, loc, status: i % 5 === 0 ? "Void" : "Paid", name: `Roe${i}, Jim`, num: String(10000000 + i) }));

(async () => {
  const run = async (m: Mode, rows: Row[], f: any) => { const app = new FakeApp(m, rows); const r = new ListReader(crawlerFor(app)); r.begin(20000); return r.read(f); };
  const D = { list: "documents", dateField: "received", from: "2026-10-12", to: "2026-10-12", type: "Lab report" } as const;
  const rowsOf = (x: any): ListRow[] => ("rows" in x ? x.rows : []);
  {
    const all = [...docRows(130), ...docRows(7, "2026-10-12", "Statement"), ...docRows(9, "2026-10-11")];
    const x = await run({ kind: "documents", url: true, pager: "next", size: 25 }, all, D);
    ok("rows" in x && rowsOf(x).length === 130 && rowsOf(x).every((r) => r.type === "Lab report" && r.date.received === "2026-10-12"), `URL filters + Rows per page + Next: ${JSON.stringify("fail" in x ? x : { n: rowsOf(x).length, proof: x.proof })}`);
    ok(rowsOf(x).filter((r) => r.flags.includes("Restricted")).length === 1, "badge read from the patient cell");
  }
  {
    const all = [...invRows(31), ...invRows(12, "2026-10-12", "Eastside"), ...invRows(5, "2026-10-11")];
    const x = await run({ kind: "invoices", url: false, pager: "next", size: 100 }, all, { list: "invoices", dateField: "issued", from: "2026-10-12", to: "2026-10-12", location: "Northgate" });
    ok("rows" in x && rowsOf(x).length === 31 && /form/.test(x.proof), `URL ignored → form filled by label, "31 invoices" footer: ${JSON.stringify("fail" in x ? x : x.proof)}`);
    const y = await run({ kind: "invoices", url: false, pager: "next", size: 25 }, [...invRows(70), ...invRows(40, "2026-10-12", "Eastside"), ...invRows(9, "2026-10-11")], { list: "invoices", dateField: "issued", from: "2026-10-12", to: "2026-10-12" });
    ok("rows" in y && rowsOf(y).length === 110, `all locations, form + Rows per page: ${JSON.stringify("fail" in y ? y : y.proof)}`);
  }
  {
    const x = await run({ kind: "documents", url: true, pager: "more", size: 20 }, docRows(57), D);
    ok("rows" in x && rowsOf(x).length === 57, `Show more to an exact total: ${JSON.stringify("fail" in x ? x : x.proof)}`);
    const y = await run({ kind: "documents", url: true, pager: "more", size: 20, approx: true, endForm: true }, docRows(57), D);
    ok("rows" in y && rowsOf(y).length === 57, `Show more to the "about N" end form: ${JSON.stringify("fail" in y ? y : y.proof)}`);
  }
  {
    const x = await run({ kind: "documents", url: true, pager: "next", size: 25, stopAt: 75 }, docRows(130), D);
    ok("fail" in x, `a list that stops early → fail: ${JSON.stringify(x).slice(0, 120)}`);
    const y = await run({ kind: "documents", url: true, pager: "next", size: 25, repeat: true }, docRows(130), D);
    ok("fail" in y, `a page that repeats rows → fail: ${JSON.stringify(y).slice(0, 120)}`);
    { const app = new FakeApp({ kind: "documents", url: true, pager: "next", size: 25 }, docRows(30)); app.picker = "Northgate"; const r = new ListReader(crawlerFor(app)); r.begin(20000); const w = await r.read(D); ok("fail" in w && /picker/.test(w.fail), `session picker on one location → fail: ${JSON.stringify(w).slice(0, 120)}`); }
    const z = await run({ kind: "documents", url: true, pager: "next", size: 25, approx: true }, docRows(130), D);
    ok("fail" in z, `only an estimate in the footer → fail: ${JSON.stringify(z).slice(0, 120)}`);
  }
  console.log(`listRead: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
