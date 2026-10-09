/**
 * PAGE-VARIANT GENERATOR. Takes Set 1 page structures (fixtures/set1/recon-158.txt; the provider-day
 * page, captured only empty in Set 1, is rebuilt from the same chrome in the shape the reader
 * expects) and perturbs them the way another clinic version might: reordered / renamed / extra
 * columns, other date and money formats, renamed labels and headings, other status words, flags in
 * their own column, pagination, missing wrappers, empty states. The live readers' own in-page
 * scripts (pageScripts.ts) run on each variant under jsdom, followed by the same pure code the
 * solvers use. Each reader must return the base value, or decline (null), or the value the variant
 * itself defines; any OTHER value is a would-be −1 and is flagged DIFFERENT.
 *
 *   npx tsx src/wrenfield/variants/pageVariants.ts [--all]
 */
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { INVOICE_PAGE_JS, PROVIDER_DAY_JS, DOCUMENT_ROWS_JS, PATIENT_ROWS_JS, parseInvoicePage, parseProviderDay, parseDocumentRows, parsePatientRows, type RawInvoicePage, type RawProviderDay } from "../pageScripts.js";
import { invoiceBalance, dayCount, openSlots } from "../solvers.js";
import type { ClinicIndex } from "../inference.js";
import { FIX } from "./harness.js";

// ── jsdom with an innerText close to a browser's (jsdom has none) ──
const BLOCK = new Set(["DIV", "P", "SECTION", "ARTICLE", "HEADER", "FOOTER", "MAIN", "NAV", "ASIDE", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "DL", "DT", "DD", "TABLE", "THEAD", "TBODY", "TFOOT", "CAPTION", "FORM", "FIELDSET", "SEARCH", "TR", "BLOCKQUOTE", "PRE", "FIGURE"]);
function inner(el: any): string {
  const walk = (n: any): string => {
    if (n.nodeType === 3) return n.nodeValue.replace(/\s+/g, " ");
    if (n.nodeType !== 1) return "";
    if (n.hasAttribute("hidden") || /display\s*:\s*none/i.test(n.getAttribute("style") || "") || n.tagName === "SCRIPT" || n.tagName === "STYLE") return "";
    if (n.tagName === "BR") return "\n";
    if (n.tagName === "TR") return "\n" + [...n.children].filter((c: any) => /^T[DH]$/.test(c.tagName)).map((c: any) => walk(c).replace(/\n+/g, " ").trim()).join("\t") + "\n";
    const body = [...n.childNodes].map(walk).join("");
    return BLOCK.has(n.tagName) ? "\n" + body + "\n" : body;
  };
  return walk(el).split("\n").map((l) => l.replace(/[ ]+/g, " ").replace(/^ | $/g, "")).join("\n").replace(/\n{2,}/g, "\n").replace(/^\n|\n$/g, "");
}
export function domOf(html: string) {
  const dom = new JSDOM(html);
  Object.defineProperty(dom.window.HTMLElement.prototype, "innerText", { get() { return inner(this); }, configurable: true });
  return dom.window.document;
}
/** Run one of the live readers' in-page scripts against a document, as Crawler.evalApp does. */
export const runScript = <T>(js: string, doc: Document): T => new Function("doc", js)(doc) as T;

// ── base pages ──
function reconPage(template: string): string {
  const t = readFileSync(FIX + "set1/recon-158.txt", "utf8");
  const i = t.indexOf(`@@@@ ${template} ::`); if (i < 0) throw new Error("recon page missing: " + template);
  const h = t.indexOf("---- HTML ----", i); const end = t.indexOf("\n@@@@ ", h);
  return t.slice(h + "---- HTML ----".length, end < 0 ? undefined : end).replace(/\n\[nav\][^\n]*/g, "");
}
const PROVIDER_DAY_BASE = `<body><div><div><button type="button" aria-label="Previous day">‹</button><button type="button">Today</button><label><span>Date</span><input type="date" name="date" value="2026-11-27"></label></div>
<div><h2>Ethan Holmes, NP </h2><p>Family Medicine · Friday, November 27, 2026</p></div>
<label><span>Provider</span><select name="provider"><option value="1pgb59q2cs" selected>Ethan Holmes, NP</option></select></label>
<section aria-labelledby="loc-1"><h3 id="loc-1">Northgate <span>Times in CST</span></h3><ul><li>Working 9:00 AM to 12:00 PM</li></ul>
<table><caption>Ethan Holmes at Northgate</caption><thead><tr><th scope="col">Time</th><th scope="col">Patient</th><th scope="col">Visit type</th><th scope="col">Status</th></tr></thead><tbody>
<tr><td>9:00 AM to 9:30 AM</td><td><a href="/patients/p1">Cook, Ingrid</a></td><td>Office visit</td><td><span>Completed</span></td></tr>
<tr><td>9:30 AM to 9:50 AM</td><td><a href="/patients/p2">Patient, Zztest</a>  <span>Test record</span></td><td>Office visit</td><td><span>Completed</span></td></tr>
<tr><td>9:50 AM to 10:10 AM</td><td>Open slot</td></tr>
<tr><td>10:10 AM to 10:40 AM</td><td><a href="/patients/p3">Rodriguez, Hiroshi</a></td><td>Follow-up visit</td><td><span>Scheduled</span></td></tr>
<tr><td>10:40 AM to 11:00 AM</td><td><a href="/patients/p4">Johnson, Amanda</a>  <span>Deleted</span></td><td>Office visit</td><td><span>Scheduled</span></td></tr>
<tr><td>11:00 AM to 11:20 AM</td><td>Open slot</td></tr>
<tr><td>11:20 AM to 11:50 AM</td><td><a href="/patients/p5">Nguyen, Paula</a></td><td>Office visit</td><td><span>Cancelled</span></td></tr>
<tr><td>11:40 AM to 12:00 PM</td><td>Open slot</td></tr>
</tbody></table></section>
<section aria-labelledby="loc-2"><h3 id="loc-2">Eastside <span>Times in CST</span></h3><ul><li>Working 1:00 PM to 3:00 PM</li></ul>
<table><caption>Ethan Holmes at Eastside</caption><thead><tr><th scope="col">Time</th><th scope="col">Patient</th><th scope="col">Visit type</th><th scope="col">Status</th></tr></thead><tbody>
<tr><td>1:00 PM to 1:30 PM</td><td><a href="/patients/p6">Baker, Lee</a></td><td>Office visit</td><td><span>Scheduled</span></td></tr>
<tr><td>1:30 PM to 2:00 PM</td><td><a href="/patients/p7">Price, Abigail</a></td><td>Annual physical</td><td><span>Scheduled</span></td></tr>
<tr><td>2:00 PM to 2:20 PM</td><td>Open slot</td></tr>
<tr><td>2:20 PM to 3:00 PM</td><td><a href="/patients/p8">Diaz, Omar</a></td><td>Office visit</td><td><span>Completed</span></td></tr>
</tbody></table></section></body>`;
const PATIENT_ROWS_BASE = `<body><h1>Patients</h1><p>3 patients found</p><table><caption>Results</caption><thead><tr><th>Name</th><th>MRN</th><th>Date of birth</th><th>Sex</th><th>Location</th></tr></thead><tbody>
<tr><td><a href="/patients/a1">Wallace, Abigail</a></td><td></td><td>12/16/1978 (47 y)</td><td>Female</td><td>Northgate</td></tr>
<tr><td><a href="/patients/a2">Wallace, Aisha</a></td><td></td><td>06/16/1996 (30 y)</td><td>Female</td><td>Eastside</td></tr>
<tr><td><a href="/patients/a3">Wallace, Alexander</a></td><td></td><td>01/13/1976 (50 y)</td><td>Male</td><td>Lakeside</td></tr></tbody></table></body>`;

// ── DOM perturbations ──
type Doc = Document;
const tables = (d: Doc) => [...d.querySelectorAll("table")];
const rowsOf = (t: Element) => [...t.querySelectorAll("tr")];
/** Permute every table's columns (th and td alike) by `perm` (new index → old index); rows with
 *  fewer cells (an open-slot row) keep their cells. */
function permuteCols(d: Doc, perm: number[], pick?: (t: Element) => boolean) {
  for (const t of tables(d).filter((t) => !pick || pick(t))) for (const tr of rowsOf(t)) {
    const cells = [...tr.children].filter((c) => /^T[DH]$/.test(c.tagName));
    if (cells.length < perm.length) continue;
    const re = perm.map((i) => cells[i]);
    for (const c of cells.slice(0, perm.length)) c.remove();
    const rest = [...tr.children]; for (const c of re) tr.insertBefore(c, rest[0] ?? null);
  }
}
function insertCol(d: Doc, at: number, header: string, value: (i: number, tr: Element) => string, pick?: (t: Element) => boolean) {
  for (const t of tables(d).filter((t) => !pick || pick(t))) rowsOf(t).forEach((tr, i) => {
    const cells = [...tr.children].filter((c) => /^T[DH]$/.test(c.tagName));
    if (cells.length < at) return;
    const isHead = cells[0]?.tagName === "TH" && tr.closest("thead");
    const isFoot = !!tr.closest("tfoot");
    if (isFoot) { const th = tr.querySelector("th[colspan]"); if (th) th.setAttribute("colspan", String(Number(th.getAttribute("colspan")) + 1)); return; }
    const c = d.createElement(isHead ? "th" : "td"); c.textContent = isHead ? header : value(i, tr);
    tr.insertBefore(c, cells[at] ?? null);
  });
}
const replaceText = (d: Doc, from: RegExp, to: string | ((m: string, ...a: string[]) => string)) => {
  const w = d.createTreeWalker(d.body, 4); const ns: Text[] = []; while (w.nextNode()) ns.push(w.currentNode as Text);
  for (const n of ns) n.nodeValue = n.nodeValue!.replace(from, to as any);
};
const MON: Record<string, string> = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
const toISO = (d: Doc) => replaceText(d, /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}), (\d{4})\b/g, (_m, mo, dd, y) => `${y}-${MON[mo]}-${dd.padStart(2, "0")}`);
const toUS = (d: Doc) => replaceText(d, /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}), (\d{4})\b/g, (_m, mo, dd, y) => `${MON[mo]}/${dd.padStart(2, "0")}/${y}`);
const toDMY = (d: Doc) => replaceText(d, /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}), (\d{4})\b/g, (_m, mo, dd, y) => `${dd} ${mo} ${y}`);
const relabel = (d: Doc, sel: string, from: RegExp, to: string) => { for (const e of d.querySelectorAll(sel)) if (from.test(e.textContent || "")) { const span = e.querySelector("span"); if (sel === "th" || !span) e.textContent = to; else e.firstChild!.nodeValue = to; } };

// ── readers under test ──
type Reader = { name: string; read: (doc: Doc) => Promise<string | null> };
const idx = (over: Partial<ClinicIndex>): ClinicIndex => ({ findPatient: () => null, appointments: [], providers: new Map(), byDate: () => [], ...over });
const INVOICE_ASK = { invoice: "36618337", name: "Peter Garcia", dos: "2026-10-14" };
const invoiceReader: Reader = { name: "invoice-balance", read: async (doc) => { const pg = parseInvoicePage(runScript<RawInvoicePage>(INVOICE_PAGE_JS, doc)); return invoiceBalance(idx({ invoicePage: async () => pg }), INVOICE_ASK.invoice, INVOICE_ASK.name, INVOICE_ASK.dos); } };
const dayIdx = (doc: Doc) => idx({ providerDay: async (_p, date) => parseProviderDay(runScript<RawProviderDay>(PROVIDER_DAY_JS, doc), date) });
const dayReaders: Reader[] = [
  { name: "provider-day-scheduled-count", read: (doc) => dayCount(dayIdx(doc), "Ethan Holmes, NP", "2026-11-27", "scheduled") },
  { name: "provider-day-completed-count", read: (doc) => dayCount(dayIdx(doc), "Ethan Holmes, NP", "2026-11-27", "completed") },
  { name: "provider-open-slots@Northgate", read: (doc) => openSlots(dayIdx(doc), "Ethan Holmes, NP", "Northgate", "2026-11-27") },
  { name: "provider-open-slots@Eastside", read: (doc) => openSlots(dayIdx(doc), "Ethan Holmes, NP", "Eastside", "2026-11-27") },
];
/** referral-source as exec reads it: the referral letter received on the asked date → its source. */
const docReaders: Reader[] = [
  { name: "referral-source@2025-03-30", read: async (doc) => parseDocumentRows(runScript(DOCUMENT_ROWS_JS, doc)).find((d) => /referral/i.test(d.kind) && d.receivedISO === "2025-03-30")?.source ?? null },
  { name: "doc-href lab@2024-12-16", read: async (doc) => { const ds = parseDocumentRows(runScript(DOCUMENT_ROWS_JS, doc)).filter((d) => /lab report/i.test(d.kind) && d.receivedISO === "2024-12-16"); return ds.length === 1 ? ds[0].docHref ?? null : null; } },
];
const patientReaders: Reader[] = [
  { name: "patient-search dob(Wallace, Aisha)", read: async (doc) => parsePatientRows(runScript(PATIENT_ROWS_JS, doc)).find((r) => /Aisha/.test(r.name))?.dob ?? null },
  { name: "patient-search rows", read: async (doc) => String(parsePatientRows(runScript(PATIENT_ROWS_JS, doc)).length) },
];

// ── variants per page: [name, mutate, expected override per reader ("decline" | value)] ──
type PV = { name: string; mutate: (d: Doc) => void; expect?: Record<string, string | "decline"> };
const ledger = (t: Element) => /ledger/i.test(t.querySelector("caption")?.textContent || "");
const INVOICE_VARIANTS: PV[] = [
  { name: "ledger columns reordered (Payments before Charges)", mutate: (d) => permuteCols(d, [0, 1, 3, 2], ledger) },
  { name: "ledger columns reordered (Description first)", mutate: (d) => permuteCols(d, [1, 0, 2, 3], ledger) },
  { name: "ledger headers renamed", mutate: (d) => { relabel(d, "th", /^Charges$/, "Amount"); relabel(d, "th", /Payments and adjustments/, "Credits"); relabel(d, "th", /^Description$/, "Item"); } },
  { name: "ledger extra column 'Reference' before Payments", mutate: (d) => insertCol(d, 3, "Reference", (i) => `PMT-00${40 + i}`, ledger) },
  { name: "ledger extra column 'Posted by' first", mutate: (d) => insertCol(d, 0, "Posted by", () => "J. Smith", ledger) },
  { name: "no 'Amount owed' footer", mutate: (d) => d.querySelectorAll("tfoot").forEach((f) => f.remove()) },
  { name: "extra 'Reference' column + no footer", mutate: (d) => { insertCol(d, 3, "Reference", (i) => `PMT-00${40 + i}`, ledger); d.querySelectorAll("tfoot").forEach((f) => f.remove()); } },
  { name: "payments shown negative", mutate: (d) => replaceText(d, /^\$(37\.24|100\.76)$/, (m) => "-" + m) },
  { name: "payments shown negative + no footer", mutate: (d) => { replaceText(d, /^\$(37\.24|100\.76)$/, (m) => "-" + m); d.querySelectorAll("tfoot").forEach((f) => f.remove()); } },
  { name: "dates as ISO", mutate: toISO },
  { name: "dates as US", mutate: toUS },
  { name: "dates as D Mon YYYY", mutate: toDMY },
  { name: "detail labels renamed (Invoice total / Date of service / Patient name)", mutate: (d) => { relabel(d, "dt", /^Total$/, "Invoice total"); relabel(d, "dt", /^Service date$/, "Date of service"); relabel(d, "dt", /^Patient$/, "Patient name"); } },
  { name: "ledger caption renamed 'Transactions'", mutate: (d) => replaceText(d, /Ledger of this invoice, oldest first/, "Transactions, oldest first") },
  { name: "payment line described 'Payment - card'", mutate: (d) => replaceText(d, /^Payment received$/, "Payment - card") },
  { name: "status 'Voided' (ledger unchanged, footer $0.00)", mutate: (d) => replaceText(d, /^Paid$/, "Voided"), expect: { "invoice-balance": "0.00" } },
  { name: "money as '138.00 USD'", mutate: (d) => replaceText(d, /^\$([\d,]+\.\d\d)$/, "$1 USD") },
];
const DAY_VARIANTS: PV[] = [
  { name: "columns reordered (Status second)", mutate: (d) => permuteCols(d, [0, 3, 1, 2]) },
  { name: "columns reordered (Patient first)", mutate: (d) => permuteCols(d, [1, 0, 2, 3]) },
  { name: "headers renamed (Visit / State)", mutate: (d) => { relabel(d, "th", /^Visit type$/, "Visit"); relabel(d, "th", /^Status$/, "State"); } },
  { name: "extra column 'Room' after Time", mutate: (d) => insertCol(d, 1, "Room", (i) => `Room ${i}`) },
  { name: "extra column 'Notes' at end", mutate: (d) => insertCol(d, 4, "Notes", () => "") },
  { name: "status words 'Booked' / 'Checked out'", mutate: (d) => { replaceText(d, /^Scheduled$/, "Booked"); replaceText(d, /^Completed$/, "Checked out"); } },
  { name: "flags in their own 'Record' column", mutate: (d) => { for (const sp of [...d.querySelectorAll("td span")]) if (/Test record|Deleted/.test(sp.textContent || "")) { const td = sp.closest("tr")!; const flag = sp.textContent!; sp.remove(); const c = d.createElement("td"); c.textContent = flag; td.appendChild(c); } } },
  { name: "open slots rendered with 4 cells", mutate: (d) => { for (const tr of [...d.querySelectorAll("tr")]) { const tds = tr.querySelectorAll("td"); if (tds.length === 2 && /Open slot/.test(tds[1].textContent || "")) for (let i = 0; i < 2; i++) tr.appendChild(d.createElement("td")); } } },
  { name: "open slots labelled 'Available'", mutate: (d) => replaceText(d, /^Open slot$/, "Available") },
  { name: "open slots carry a 'Book' link", mutate: (d) => { for (const td of [...d.querySelectorAll("td")]) if (/^Open slot$/.test(td.textContent || "")) { const a = d.createElement("a"); a.setAttribute("href", "/book"); a.textContent = "Book"; td.append(" ", a); } } },
  { name: "time cell links to the appointment", mutate: (d) => { for (const tr of [...d.querySelectorAll("tbody tr")]) { const td = tr.querySelector("td"); if (td && tr.querySelectorAll("td").length > 2) { const a = d.createElement("a"); a.setAttribute("href", "/appointments/x"); a.textContent = td.textContent; td.textContent = ""; td.appendChild(a); } } } },
  { name: "paginated (first rows only, 'Showing 1 to 4 of 8')", mutate: (d) => { const t = d.querySelector("table")!; const rs = [...t.querySelectorAll("tbody tr")]; rs.slice(4).forEach((r) => r.remove()); const p = d.createElement("p"); p.textContent = "Showing 1 to 4 of 8 appointments"; t.after(p); const b = d.createElement("button"); b.textContent = "Next"; p.after(b); } },
  { name: "sections as <div> not <section>", mutate: (d) => { for (const s of [...d.querySelectorAll("section")]) { const div = d.createElement("div"); div.innerHTML = s.innerHTML; s.replaceWith(div); } } },
  { name: "location heading 'Northgate clinic'", mutate: (d) => replaceText(d, /^Northgate $/, "Northgate clinic ") },
  { name: "location heading 'Location: Northgate'", mutate: (d) => replaceText(d, /^Northgate $/, "Location: Northgate ") },
  { name: "working hours worded 'Hours 9:00 AM to 12:00 PM'", mutate: (d) => replaceText(d, /^Working /, "Hours ") },
  { name: "flag badge as block element", mutate: (d) => { for (const sp of [...d.querySelectorAll("td span")]) if (/Test record|Deleted/.test(sp.textContent || "")) { const div = d.createElement("div"); div.textContent = sp.textContent; sp.replaceWith(div); } } },
  { name: "empty day ('Nothing scheduled')", mutate: (d) => { d.querySelectorAll("section").forEach((s) => s.remove()); const p = d.createElement("p"); p.textContent = "Nothing scheduled on this day"; d.body.appendChild(p); },
    expect: { "provider-day-scheduled-count": "0", "provider-day-completed-count": "0", "provider-open-slots@Northgate": "decline", "provider-open-slots@Eastside": "decline" } },
  { name: "provider heading in h1 (no h2)", mutate: (d) => { const h = d.querySelector("h2")!; const h1 = d.createElement("h1"); h1.textContent = h.textContent; h.replaceWith(h1); } },
];
const DOC_VARIANTS: PV[] = [
  { name: "columns reordered (Received, Type, Title)", mutate: (d) => permuteCols(d, [2, 1, 0]) },
  { name: "columns reordered (Type, Title, Received)", mutate: (d) => permuteCols(d, [1, 0, 2]) },
  { name: "headers renamed (Document / Category / Date received)", mutate: (d) => { relabel(d, "th", /^Title$/, "Document"); relabel(d, "th", /^Type$/, "Category"); relabel(d, "th", /^Received$/, "Date received"); } },
  { name: "extra column 'Uploaded by' before Received", mutate: (d) => insertCol(d, 2, "Uploaded by", () => "Front desk") },
  { name: "extra date column 'Date of service' before Received", mutate: (d) => insertCol(d, 2, "Date of service", (i) => ["Dec 16, 2024", "Mar 30, 2025", "Nov 4, 2024"][i % 3]) },
  { name: "dates as ISO", mutate: toISO },
  { name: "dates as US", mutate: toUS },
  { name: "title worded 'Referral from …'", mutate: (d) => replaceText(d, /^Referral letter from /, "Referral from ") },
  { name: "caption renamed 'Files'", mutate: (d) => replaceText(d, /Documents in this chart, newest first/, "Files") },
];
const PATIENT_VARIANTS: PV[] = [
  { name: "columns reordered (DOB first)", mutate: (d) => permuteCols(d, [2, 0, 1, 3, 4]) },
  { name: "DOB as ISO", mutate: (d) => replaceText(d, /^(\d\d)\/(\d\d)\/(\d{4}) \(\d+ y\)$/, (_m, mm, dd, y) => `${y}-${mm}-${dd}`) },
  { name: "DOB as 'Jun 16, 1996'", mutate: (d) => replaceText(d, /^(\d\d)\/(\d\d)\/(\d{4}) \(\d+ y\)$/, (_m, mm, dd, y) => `${Object.keys(MON)[Number(mm) - 1]} ${Number(dd)}, ${y}`) },
  { name: "extra 'Last visit' date column before DOB", mutate: (d) => insertCol(d, 2, "Last visit", () => "09/01/2026") },
  { name: "name shown 'First Last'", mutate: (d) => replaceText(d, /^Wallace, (\w+)$/, "$1 Wallace") },
];

export type PageFinding = { page: string; variant: string; reader: string; base: string | null; got: string | null; expected: string; verdict: "SAME" | "DECLINE" | "DIFFERENT" | "EXPECTED" };
export type PageReport = { findings: PageFinding[]; bases: Record<string, string | null> };

async function runPage(page: string, html: string, readers: Reader[], variants: PV[], out: PageFinding[], bases: Record<string, string | null>) {
  const base: Record<string, string | null> = {};
  for (const r of readers) { base[r.name] = await r.read(domOf(html)).catch(() => null); bases[`${page}: ${r.name}`] = base[r.name]; }
  for (const v of variants) {
    const doc = domOf(html); v.mutate(doc); const h2 = doc.documentElement.outerHTML;
    for (const r of readers) {
      const got = await r.read(domOf(h2)).catch(() => null);
      const exp = v.expect?.[r.name];
      const expected = exp === undefined ? (base[r.name] ?? "decline") : exp;
      let verdict: PageFinding["verdict"];
      if (exp !== undefined) verdict = (exp === "decline" ? got === null : got === exp) ? "EXPECTED" : got === null ? "DECLINE" : "DIFFERENT";
      else verdict = got === base[r.name] ? "SAME" : got === null ? "DECLINE" : "DIFFERENT";
      out.push({ page, variant: v.name, reader: r.name, base: base[r.name], got, expected: String(expected), verdict });
    }
  }
}

export async function runPageVariants(): Promise<PageReport> {
  const findings: PageFinding[] = []; const bases: Record<string, string | null> = {};
  await runPage("invoice detail (recon)", reconPage("/billing/invoices/{id}"), [invoiceReader], INVOICE_VARIANTS, findings, bases);
  await runPage("provider day (rebuilt)", PROVIDER_DAY_BASE, dayReaders, DAY_VARIANTS, findings, bases);
  await runPage("chart documents (recon)", reconPage("/patients/{id}/files"), docReaders, DOC_VARIANTS, findings, bases);
  await runPage("patient search (rebuilt)", PATIENT_ROWS_BASE, patientReaders, PATIENT_VARIANTS, findings, bases);
  return { findings, bases };
}

export function printPageVariants(rep: PageReport, all = false) {
  console.log(`\n== Page-variant readers (each must return the base value or decline) ==`);
  for (const [k, v] of Object.entries(rep.bases)) console.log(`  base ${k} = ${v ?? "(declines on the base page!)"}`);
  const byReader = new Map<string, { n: number; same: number; decline: number; diff: number }>();
  for (const f of rep.findings) { const r = byReader.get(f.reader) ?? { n: 0, same: 0, decline: 0, diff: 0 }; byReader.set(f.reader, r); r.n++; if (f.verdict === "DIFFERENT") r.diff++; else if (f.verdict === "DECLINE") r.decline++; else r.same++; }
  console.log(`  ${"reader".padEnd(36)} vars  same decl DIFF`);
  for (const [k, r] of byReader) console.log(`  ${k.padEnd(36)} ${String(r.n).padStart(4)} ${String(r.same).padStart(5)} ${String(r.decline).padStart(4)} ${String(r.diff).padStart(4)}`);
  const diffs = rep.findings.filter((f) => f.verdict === "DIFFERENT");
  console.log(`  ${diffs.length ? "✗" : "✓"} DIFFERENT-value page variants (would-be −1): ${diffs.length}`);
  for (const f of diffs) console.log(`     ${f.reader} on "${f.variant}": got ${f.got} (expected ${f.expected})`);
  if (all) for (const f of rep.findings.filter((f) => f.verdict !== "DIFFERENT")) console.log(`     [${f.verdict}] ${f.reader} on "${f.variant}": ${f.got}`);
}

if (process.argv[1]?.endsWith("pageVariants.ts")) {
  const rep = await runPageVariants();
  printPageVariants(rep, process.argv.includes("--all"));
  process.exit(0);
}
