/**
 * Name-only visit tasks resolved from the invoice list (contextResolve.invoiceContext), on a simulated billing page built from the
 * captured Set 1 markup (fixtures/set1/recon-158.txt: the /billing filter form — Find invoice, Patient, Service date frto, Location,
 * Status — the Invoices table with Invoice / Patient / Location / Service date / Issued / Total / Status, the "Showing 1 to 20 of
 * about 200,200 invoices" footer, and the invoice page header "Garcia, Peter · Cedar Hollow · Service on Oct 14, 2026" + "Open chart"):
 *   - the filter applied (controls echo it, an exact total the rows reach, every row on the date with the name): the rows' invoice
 *     pages name the patient and link ONE chart → that chart (run s3a items 127, 174, 175, 186, 223: claims / filing questions with a
 *     DOS whose ten-location day reads died on busy pages);
 *   - two charts invoiced under the name that day → decline; a Restricted badge → decline; the chart must be one of the search's
 *     namesakes when it listed several (223: two Ana Sanchez);
 *   - an "about N" footer (the filter was not applied), a row off the date, a foreign name, a page that is busy → FAIL (the day
 *     read follows: pickFromContext's onFail stage); no rows → a clean miss ("no <name> on …"), the day read follows too;
 *   - pickFromContext over stages: invoice (onFail) → day: the day read runs after a failed or empty invoice read, not after a decline.
 *   npx tsx src/wrenfield/invoiceCtx.test.ts
 */
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { invoiceContext, invoiceRows, invoicePagePatient, pickByContext, pickFromContext, INVOICES_EXTRACT, INVOICE_PAGE_EXTRACT, type InvoicesRaw, type InvoicePageRaw, type CtxRead } from "./contextResolve.js";
import { resetBudget } from "./siteBudget.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? pass++ : fail++; if (!c) console.log("FAIL " + m); };
const eq = (got: unknown, want: unknown, what: string) => { const g = JSON.stringify(got), w = JSON.stringify(want); ok(g === w, `${what}\n  got  ${g}\n  want ${w}`); };

// ── 0. the captured markup reads through the extractors ──
{
  const recon = readFileSync(new URL("../../fixtures/set1/recon-158.txt", import.meta.url), "utf8");
  // a recon page: the "<body" line nearest before `at`, up to the next "@@@@" / "# " marker line
  const page = (at: number) => { const ls = recon.split("\n"); let i = recon.slice(0, at).split("\n").length - 1; while (i > 0 && !ls[i].startsWith("<body")) i--; let k = i; while (k < ls.length && !/^(@@@@|# |----)/.test(ls[k])) k++; return ls.slice(i, k).join("\n"); };
  // the recon's HTML dump is cut at 14,000 chars (mid-row): keep the rows that are whole and close the table
  const billing0 = page(recon.indexOf('name="serviceFrom"'));
  const billing = billing0.slice(0, billing0.lastIndexOf("</tr>") + 5) + "</tbody></table></section></div>";
  const dom = new JSDOM(`<!doctype html><html>${billing}</html>`);
  const raw = new Function("doc", INVOICES_EXTRACT)(dom.window.document) as InvoicesRaw;
  const r = invoiceRows(raw);
  ok("rows" in r && r.rows.length >= 10, `recon /billing: the invoice table reads (${"rows" in r ? r.rows.length + " rows" : r.problem})`);
  if ("rows" in r) {
    eq(r.rows[0], { invoiceHref: "/billing/invoices/6b4qj5d9m3", number: "36618337", patient: "Garcia, Peter", badge: undefined, location: "Cedar Hollow", serviceISO: "2026-10-14", status: "Paid" }, "recon row 1");
    const restricted = r.rows.find((x) => x.badge);
    ok(!!restricted && /restricted/i.test(restricted.badge!) && restricted.patient === "Turner, Daniel", `a Restricted badge is split from the name: ${JSON.stringify(restricted)}`);
  }
  // the footer sits past the cut: the recon's text dump has it — "Showing 1 to 20 of about 200,200 invoices" — an estimate, never complete
  { const { listFooter, isComplete } = await import("./listFooter.js"); const f = listFooter("Showing 1 to 20 of about 200,200 invoices", /invoices?/i);
    ok(!!f && f.kind === "approx" && !isComplete(20, f, { next: "enabled" }).complete && !isComplete(20, f, { next: "disabled" }).complete, `recon footer: an estimate is never complete: ${JSON.stringify(f)}`); }
  const inv = page(recon.indexOf("<body", recon.indexOf("# ok=true url=/billing/invoices/6b4qj5d9m3")) + 1);
  const dom2 = new JSDOM(`<!doctype html><html>${inv}</html>`);
  const praw = new Function("doc", INVOICE_PAGE_EXTRACT)(dom2.window.document) as InvoicePageRaw;
  eq(invoicePagePatient(praw, "36618337", "2026-10-14"), { name: "Garcia, Peter", href: "/patients/2fw5ksx91m" }, "recon invoice page: patient + Open chart");
  ok("problem" in invoicePagePatient(praw, "36618337", "2026-10-13"), "the invoice page's service date must be the asked one");
  ok("problem" in invoicePagePatient(praw, "99999999", "2026-10-14"), "the invoice page must be the invoice the row linked");
}

// ── 1. a simulated billing site ──
type Inv = { n: string; id: string; patient: string; pid: string; loc: string; svc: string; badge?: string };
const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const longDate = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return `${mon[m - 1]} ${d}, ${y}`; };
type Opts = { ignorePatient?: boolean; ignoreDate?: boolean; busy?: boolean; estimateFooter?: boolean; perPage?: number };
class BillingSim {
  dom = new JSDOM("<!doctype html><html><body></body></html>"); path = "/"; q = new URLSearchParams(); page = 1; loads = 0;
  constructor(public invs: Inv[], public o: Opts = {}) {}
  get doc() { return this.dom.window.document; }
  list() { const p = (this.q.get("patient") ?? "").toLowerCase(), f = this.q.get("serviceFrom") ?? "", t = this.q.get("serviceTo") ?? ""; return this.invs.filter((i) => (this.o.ignorePatient || !p || i.patient.toLowerCase().includes(p)) && (this.o.ignoreDate || !f || (i.svc >= f && i.svc <= t))); }
  nav(p: string) {
    const u = new URL("http://x" + p); this.path = u.pathname + u.search; this.loads++;
    const m = u.pathname.match(/^\/billing\/invoices\/([^/]+)$/);
    if (m) { const i = this.invs.find((x) => x.id === m[1])!; this.doc.body.innerHTML = `<div><header><div><h1>Invoice <span>${i.n}</span></h1><span>Paid</span></div><p>${i.patient} · ${i.loc} · Service on ${longDate(i.svc)}</p><div><a href="/billing/accounts/${i.pid}">Patient account</a><a href="/patients/${i.pid}">Open chart</a></div></header><section><h2>Ledger</h2></section></div>`; return; }
    if (u.pathname !== "/billing") { this.doc.body.innerHTML = "<h1>Schedule</h1>"; return; }
    this.q = u.searchParams; this.page = 1; this.render();
  }
  render() {
    const all = this.list(), per = this.o.perPage ?? 20, shown = all.slice((this.page - 1) * per, this.page * per);
    const v = (k: string) => this.q.get(k) ?? "";
    const footer = this.o.busy ? "Showing 1 to 3 of 12 invoices" : all.length === 0 ? "No invoices match the filters." : this.o.estimateFooter ? `Showing ${(this.page - 1) * per + 1} to ${(this.page - 1) * per + shown.length} of about ${Math.round(all.length / 25) * 25 || 25} invoices` : `Showing ${(this.page - 1) * per + 1} to ${(this.page - 1) * per + shown.length} of ${all.length} invoices`;
    this.doc.body.innerHTML = `<h1>Billing</h1><form><label for="number">Find invoice</label><input id="number" name="number" type="text" value="">
      <label for="patient">Patient</label><input id="patient" name="patient" type="text" value="${v("patient")}">
      <label for="location">Location</label><select id="location" name="location"><option value="" selected>All locations</option><option value="1">Northgate</option></select>
      <label for="status">Status</label><select id="status" name="status"><option value="" selected>All statuses</option><option value="open">Open</option></select>
      <fieldset><legend>Service date</legend><input type="date" id="serviceFrom" name="serviceFrom" aria-label="Service date from" value="${v("serviceFrom")}"><span>to</span><input type="date" id="serviceTo" name="serviceTo" aria-label="Service date to" value="${v("serviceTo")}"></fieldset>
      <fieldset><legend>Issued date</legend><input type="date" id="issuedFrom" name="issuedFrom" aria-label="Issued date from" value=""><input type="date" id="issuedTo" name="issuedTo" aria-label="Issued date to" value=""></fieldset>
      <button type="submit">Apply</button></form>
      <section aria-label="Invoices"><h2>Invoices</h2>${this.o.busy ? `<p role="status">Wrenfield is busy, so this list shows fewer rows than usual. Open it again in a moment.</p>` : ""}
      <table><caption>Invoices matching the filters</caption><thead><tr><th>Invoice</th><th>Patient</th><th>Location</th><th>Service date</th><th>Issued</th><th>Total</th><th>Status</th></tr></thead>
      <tbody>${shown.map((i) => `<tr><td><a aria-label="Invoice ${i.n}" href="/billing/invoices/${i.id}">${i.n}</a></td><td><span>${i.patient}</span> ${i.badge ? `<span><svg></svg>${i.badge}</span>` : ""}</td><td>${i.loc}</td><td>${longDate(i.svc)}</td><td>${longDate(i.svc)}</td><td>$100.00</td><td><span>Paid</span></td></tr>`).join("")}</tbody></table>
      <p aria-live="polite">${footer}</p><div><button type="button"${this.page <= 1 ? " disabled" : ""}>Previous</button><button type="button"${this.page * per >= all.length ? " disabled" : ""}>Next</button></div></section>`;
    [...this.doc.querySelectorAll("section button")].find((x) => x.textContent === "Next")?.addEventListener("click", () => { this.page++; this.loads++; this.render(); });
  }
  crawler(): any {
    return { trace: () => {}, navTo: async (p: string) => { this.nav(p); return true; }, evalApp: async (js: string) => new Function("doc", "Event", js)(this.doc, this.dom.window.Event), ensureAllLocations: async () => true };
  }
}
const DOS = "2026-07-24";
let idn = 0;
const inv = (patient: string, pid: string, svc = DOS, extra: Partial<Inv> = {}): Inv => ({ n: String(10000000 + idn), id: "inv" + idn++, patient, pid, loc: "Riverbend", svc, ...extra });
const base = (extra: Inv[] = [], o: Opts = {}) => new BillingSim([inv("Wells, Harold", "hw1"), inv("Wells, Brian", "bw1"), inv("Wells, Harold", "hw1", "2026-07-10"), inv("Walls, Harold", "wh1"), ...extra], o);
const run = async (site: BillingSim, name = "Harold Wells") => { resetBudget(); return { out: await invoiceContext(site.crawler(), name, DOS, 15000), site }; };

{ // the plain case: one invoice with the name on the DOS → its chart; the other rows (a Wells on the day, Harold on another day, Walls) are not it
  const { out, site } = await run(base());
  ok("rows" in out, `invoice list read: ${JSON.stringify(out).slice(0, 160)}`);
  if ("rows" in out) {
    eq(pickByContext(out.rows, "Harold Wells", { what: out.what }).chosen, { name: "Wells, Harold", href: "/patients/hw1" }, "exactly one chart invoiced under the name on the DOS → chosen");
    ok(out.rows.length === 2 && out.rows.some((r) => r.name === "Wells, Brian"), "the day's other Wells row is on the list (a namesake check), rows off the date are not listed by the site");
  }
  ok(site.loads <= 4, `2-4 page loads (${site.loads})`);
}
{ // two invoices of the same chart that day (two visits) → still one chart
  const { out } = await run(base([inv("Wells, Harold", "hw1")]));
  ok("rows" in out && pickByContext(out.rows, "Harold Wells").chosen?.href === "/patients/hw1", "two invoices, one chart → chosen");
}
{ // two charts invoiced under the exact name that day → decline (never a guess)
  const { out } = await run(base([inv("Wells, Harold", "hw2")]));
  ok("rows" in out && pickByContext(out.rows, "Harold Wells").chosen === null && /2 patients/.test(pickByContext(out.rows, "Harold Wells").why ?? ""), `two charts → decline: ${JSON.stringify("rows" in out ? pickByContext(out.rows, "Harold Wells") : out)}`);
}
{ // the search listed two namesakes (223: two Ana Sanchez): the invoiced chart must be one of them
  const site = new BillingSim([inv("Sanchez, Ana", "anaB", "2026-02-13"), inv("Sanchez, Aisha", "ai1", "2026-02-13")]);
  resetBudget(); const out = await invoiceContext(site.crawler(), "Ana Sanchez", "2026-02-13");
  ok("rows" in out && pickByContext(out.rows, "Ana Sanchez", { among: ["/patients/anaA", "/patients/anaB"] }).chosen?.href === "/patients/anaB", "one of the two namesakes has the invoice → that one");
  ok("rows" in out && pickByContext(out.rows, "Ana Sanchez", { among: ["/patients/anaA", "/patients/anaC"] }).chosen === null, "an invoiced chart that is neither namesake → decline");
}
{ // a Restricted badge on the row → the pick declines (the chart is not opened by a name-only resolution)
  const { out } = await run(base([], {}).invs.length ? new BillingSim([inv("Wells, Harold", "hw1", DOS, { badge: "Restricted" })]) : base());
  ok("rows" in out && pickByContext(out.rows, "Harold Wells").chosen === null && /Restricted/.test(pickByContext(out.rows, "Harold Wells").why ?? ""), "a badge → decline");
}
{ // a name that merely contains the words ("Wells, Harold James") is a namesake, not the patient
  const { out } = await run(new BillingSim([inv("Wells, Harold James", "hj1")]));
  ok("rows" in out && pickByContext(out.rows, "Harold Wells").chosen === null, "a longer name on the invoice is not exactly the name → decline");
}
{ // the site ignores the Patient filter (200,200-invoice list, "about N"): nothing is proven → FAIL (the day read follows)
  const { out } = await run(base([], { ignorePatient: true, estimateFooter: true }));
  ok("fail" in out && /about|estimate|complete|total/i.test(out.fail), `estimate footer → fail: ${JSON.stringify(out)}`);
  const { out: o2 } = await run(base([], { ignorePatient: true }));
  ok("fail" in o2 && /not applied/.test(o2.fail), `a row for another name with an exact total → fail (filter not applied): ${JSON.stringify(o2)}`);
  const { out: o3 } = await run(base([], { ignoreDate: true }));
  ok("fail" in o3 && /not applied/.test(o3.fail), `a row off the date → fail: ${JSON.stringify(o3)}`);
}
{ // a busy page → fail at once (no retry here: the day read follows after the governor's wait)
  const { out } = await run(base([], { busy: true }));
  ok("fail" in out && /busy/.test(out.fail), `busy → fail: ${JSON.stringify(out)}`);
}
{ // no invoice under the name that day → a clean miss, not a failure
  const { out } = await run(new BillingSim([inv("Wells, Brian", "bw1")]));
  ok("rows" in out && pickByContext(out.rows, "Harold Wells", { what: out.what }).chosen === null && /^no Harold Wells on /.test(pickByContext(out.rows, "Harold Wells", { what: out.what }).why ?? ""), "no invoice → clean miss");
  const { out: o0 } = await run(new BillingSim([]));
  ok("rows" in o0 && o0.rows.length === 0, "an empty list is a clean miss (rows: [])");
}
{ // a paged list (2 pages at 2 per page) is read to its exact end
  const { out, site } = await run(base([inv("Wells, Harold", "hw1"), inv("Wells, Carl", "cw1")], { perPage: 2 }));
  ok("rows" in out && out.rows.length === 4 && pickByContext(out.rows, "Harold Wells").chosen?.href === "/patients/hw1", `two pages read to the exact total: ${JSON.stringify(out).slice(0, 120)}`);
  ok(site.loads >= 3, "the second page was read");
}

// ── 2. pickFromContext over stages ──
{
  const mk = (invoice: () => Promise<CtxRead>, day: () => Promise<CtxRead>) => ({ locate: day, stages: [{ part: ":invoice", onFail: true, read: invoice }, { part: ":whole", read: day }] });
  let dayReads = 0;
  const day = async (): Promise<CtxRead> => { dayReads++; return { rows: [{ name: "Wells, Harold", href: "/patients/hw1" }], what: "the appointments on 2026-07-24 at 10 locations" }; };
  let r = await pickFromContext(mk(async () => ({ fail: "invoice list: the filter was not applied" }), day), "Harold Wells");
  ok(r.pick.chosen?.href === "/patients/hw1" && r.part === ":whole" && dayReads === 1 && r.reads.length === 2, `invoice FAILED → the day read runs and picks: ${JSON.stringify(r.reads)}`);
  dayReads = 0; r = await pickFromContext(mk(async () => ({ rows: [], what: "the invoices …" }), day), "Harold Wells");
  ok(r.pick.chosen?.href === "/patients/hw1" && dayReads === 1, "invoice list EMPTY (clean miss) → the day read runs");
  dayReads = 0; r = await pickFromContext(mk(async () => ({ rows: [{ name: "Wells, Harold", href: "/patients/hw1" }, { name: "Wells, Harold", href: "/patients/hw2" }], what: "the invoices …" }), day), "Harold Wells");
  ok(r.pick.chosen === null && dayReads === 0 && /2 patients/.test(r.pick.why), "invoice list shows two charts → decline, the day read does NOT run");
  dayReads = 0; r = await pickFromContext(mk(async () => ({ rows: [{ name: "Wells, Harold", href: "/patients/hw1" }], what: "the invoices …" }), day), "Harold Wells");
  ok(r.pick.chosen?.href === "/patients/hw1" && r.part === ":invoice" && dayReads === 0, "invoice list names the chart → chosen from it, the day read is not needed");
  // the old locate / fallback pair still walks the same way
  r = await pickFromContext({ locate: async () => ({ rows: [], what: "the Wound care appointments on 2026-07-24" }), fallback: day }, "Harold Wells");
  ok(r.pick.chosen?.href === "/patients/hw1" && r.part === ":whole", "locate miss → fallback (unchanged)");
  r = await pickFromContext({ locate: async () => ({ fail: "list busy" }), fallback: day }, "Harold Wells");
  ok(r.pick.chosen === null && /busy/.test(r.pick.why), "locate FAILED → no fallback without onFail (unchanged)");
}

console.log(`invoiceCtx: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
