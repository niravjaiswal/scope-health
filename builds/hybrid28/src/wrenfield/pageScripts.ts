/**
 * The in-page extraction scripts of the live readers (run in the app iframe via Crawler.evalApp,
 * `doc` = the app document) and the pure post-processing of what they return. Kept here, apart from
 * the CDP crawler, so the exact same scripts run offline under jsdom against captured and perturbed
 * pages (src/wrenfield/variants/pageVariants.ts): a reader must return the same value or decline on
 * a page variant, never a different value.
 *
 * The scripts only collect raw cells, links and table headers; the TypeScript below finds columns
 * by their header text (falling back to Set 1's positions when a table has no header row) and
 * declines on anything it cannot vouch for (an unknown status word, a paginated or unstructured
 * day, a ledger it cannot find).
 */
import type { InvoicePage, ProviderDay } from "./inference.js";
import { why } from "./why.js";

export const INVOICE_PAGE_JS = `const dl={}; for(const dt of doc.querySelectorAll('dt')){ const dd=dt.nextElementSibling; if(dd) dl[dt.innerText.trim()]=dd.innerText.trim(); }
      const t=[...doc.querySelectorAll('table')].find(x=>/ledger/i.test((x.querySelector('caption')||{}).innerText||''));
      const rows=t?[...t.querySelectorAll('tbody tr')].map(tr=>[...tr.querySelectorAll('td')].map(td=>td.innerText.trim())):[];
      const foot=t?[...t.querySelectorAll('tr')].find(tr=>/amount owed/i.test(tr.innerText||'')):null;
      return { h1:(doc.querySelector('h1')||{}).innerText||'', dl, rows, owed: foot?(foot.querySelector('td')||{}).innerText||'':'', status:[...doc.querySelectorAll('[role=status]')].map(e=>e.innerText||'').join(' '),
        ledger: !!t, headers: t?[...t.querySelectorAll('thead th')].map(th=>th.innerText.trim()):[] }`;

export const PROVIDER_DAY_JS = `const d=doc.querySelector('input[type=date]'); const T=e=>e?(e.innerText||'').trim():'';
      const secs=[...doc.querySelectorAll('section')].filter(s=>s.querySelector('h3')&&s.querySelector('table')).map(s=>{
        const h3=T(s.querySelector('h3')); const li=[...s.querySelectorAll('li')].map(T).find(x=>/working/i.test(x))||'';
        const headers=[...s.querySelectorAll('thead th, thead td')].map(T);
        const raw=[...s.querySelectorAll('tbody tr')].map(tr=>{ const td=[...tr.querySelectorAll('td')]; return { cells: td.map(T), links: td.map(x=>{ const a=x.querySelector('a'); return a?T(a):''; }), text: T(tr) }; });
        return { location: h3.replace(/\\s*Times in.*$/i,'').trim(), working: li, headers, raw }; });
      return { date: d?d.value:'', provider: T(doc.querySelector('h2')), sections: secs, tables: doc.querySelectorAll('table').length, text: T(doc.body).slice(0, 4000) }`;

export const DOCUMENT_ROWS_JS = `return [...doc.querySelectorAll('tr')].map(tr=>{ const c=[...tr.querySelectorAll('td')].map(td=>td.innerText.trim()); const ls=[...tr.querySelectorAll('a[href]')]; const a=tr.querySelector('a[href*="/documents/"]')||ls.find(x=>/\\b(view|open)\\b/i.test((x.getAttribute('aria-label')||'')+' '+(x.textContent||'')))||ls.find(x=>/\\/(files?|docs?|attachments?|documents?)\\//i.test(x.getAttribute('href')||'')); const tb=tr.closest('table'); return {cells:c, docHref:a?a.getAttribute('href'):'', head: tb?[...tb.querySelectorAll('thead th')].map(th=>th.innerText.trim()):[]}; }).filter(r=>r.cells.length>=3)`;

export const PATIENT_ROWS_JS = `return [...doc.querySelectorAll('a[href^="/patients/"]')].map(a=>{ const tr=a.closest('tr'); const tb=tr&&tr.closest('table'); return {name:a.innerText.trim(), href:a.getAttribute('href'), row:(tr||a).innerText.replace(/\\n/g,'\\t'), cells: tr?[...tr.querySelectorAll('td')].map(td=>td.innerText.trim()):[], head: tb?[...tb.querySelectorAll('thead th')].map(th=>th.innerText.trim()):[]}; })`;

const MON: Record<string, string> = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
/** "Oct 14, 2026" → ISO (the documents table's received date). */
export function monthDate(s: string): string | undefined { const m = s.match(/([A-Z][a-z]{2}) (\d{1,2}), (\d{4})/); return m && MON[m[1]] ? `${m[3]}-${MON[m[1]]}-${m[2].padStart(2, "0")}` : undefined; }
/** "October 15, 2026" or "Oct 15, 2026" (full or abbreviated month) → YYYY-MM-DD. */
export function monthDateFull(s: string): string | undefined {
  const m = s.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (!m) return undefined;
  const mo = MON[m[1].slice(0, 1).toUpperCase() + m[1].slice(1, 3).toLowerCase()];
  return mo ? `${m[3]}-${mo}-${m[2].padStart(2, "0")}` : undefined;
}
/** A date of birth in any common display form → YYYY-MM-DD (MM/DD/YYYY, YYYY-MM-DD, "Mar 21, 1952", "March 21, 1952"). */
export function normDob(s: string): string | undefined {
  let m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  m = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return monthDateFull(s);
}
export function stripTitle(p: string) { return p.replace(/,?\s*(MD|DO|PA-C|PA|NP|RN|CNM|CRNA|PhD|PsyD)\.?$/i, "").trim(); }
/** Index of the first header matching `re` (and not one of `taken`), or -1. */
const col = (headers: string[], re: RegExp, taken: number[] = []) => headers.findIndex((h, i) => re.test(h) && !taken.includes(i));

export type RawInvoicePage = { h1: string; dl: Record<string, string>; rows: string[][]; owed: string; status: string; ledger?: boolean; headers?: string[] };
/** INVOICE_PAGE_JS's result → the invoice record, or null when the page shows no invoice number.
 *  Ledger columns are found by header (Set 1: Date | Description | Charges | Payments and
 *  adjustments); a missing ledger or payments column becomes an `other` line, so the balance declines. */
export function parseInvoicePage(pg: RawInvoicePage): InvoicePage | null {
  const h = pg.h1.match(/Invoice\s+(\d+)/i); if (!h) return null;
  const amt = (x?: string) => { const m = (x || "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/); return m ? Number(m[0]) : undefined; };
  const payments: number[] = [], other: string[] = [];
  const heads = pg.headers ?? [];
  const di = heads.length ? col(heads, /descr|item|detail|memo|activity/i) : 1;
  const pi = heads.length ? col(heads, /payment|credit|paid/i) : 3;
  if (pg.ledger === false) other.push("no ledger table on the page");
  else if (di < 0 || pi < 0) other.push(`ledger columns not recognised: ${heads.join(" | ")}`);
  else for (const r of pg.rows) {
    const desc = (r[di] || "").trim();
    if (/^charge for services/i.test(desc)) continue;
    if (/^payment received$/i.test(desc)) { const v = amt(r[pi]); if (v !== undefined) payments.push(v); else other.push(desc); continue; }
    other.push(desc);
  }
  const status = pg.dl["Status"] || "";
  return { invoice: h[1], patient: pg.dl["Patient"] || "", dosISO: monthDateFull(pg.dl["Service date"] || ""), total: amt(pg.dl["Total"]), payments, other, status, owed: amt(pg.owed), void: /^void$/i.test(status) || /this invoice is void/i.test(pg.status) };
}

type RawRow = { cells: string[]; links: string[]; text: string };
export type RawProviderDay = { date: string; provider: string; sections: Array<{ location: string; working: string; headers?: string[]; raw?: RawRow[]; rows?: ProviderDay["sections"][number]["rows"] }>; tables?: number; text?: string };
/** Appointment statuses whose meaning we know. Any other word (a site's "Booked", "Checked out")
 *  might be a synonym of one we count, so the whole day declines rather than miscount. */
const KNOWN_STATUS = /^(scheduled|completed|cancell?ed|late cancel(?:led|lation)?|no[- ]?show)$/i;
const FLAG = /\b(test record|deleted)\b/gi;
/** PROVIDER_DAY_JS's result → the provider's day, or null (declined, with why) unless the page
 *  rendered that date as a complete, understood day. */
export function parseProviderDay(pg: RawProviderDay, dateISO: string): ProviderDay | null {
  if (pg.date !== dateISO || !pg.provider) return null;
  const text = pg.text ?? "";
  const shown = text.match(/\bshowing\s+\d+\s*(?:to|-|–)\s*(\d+)\s+of\s+(\d+)/i), pages = text.match(/\bpage\s+\d+\s+of\s+(\d+)/i);
  if ((shown && Number(shown[1]) < Number(shown[2])) || (pages && Number(pages[1]) > 1) || /\b(show|load) more\b/i.test(text)) { why("provider-day: the day is paginated; a partial day cannot be counted"); return null; }
  if (!pg.sections.length && (pg.tables ?? 0) > 0) { why("provider-day: tables on the page but no location sections were recognised"); return null; }
  if (!pg.sections.length && pg.text !== undefined && !/nothing scheduled|no working hours|no appointments/i.test(text)) { why("provider-day: no sections and no empty-day notice"); return null; }
  const sections: ProviderDay["sections"] = [];
  for (const s of pg.sections) {
    if (!s.raw) { sections.push({ location: s.location, working: s.working, rows: s.rows ?? [] }); continue; } // legacy shape
    const hd = s.headers ?? [];
    let ti = 0, pi = 1, yi = 2, si = 3;                                          // Set 1 positions (no header row)
    if (hd.length) {
      pi = col(hd, /patient|name/i); si = col(hd, /status|state/i);
      ti = col(hd, /time|start|when/i, [pi, si]); yi = col(hd, /type|visit|service|reason|appointment/i, [pi, si, ti]);
      if (pi < 0 || si < 0) { pi = 1; si = 3; ti = 0; yi = 2; }               // unrecognised headers: positions, then validated
    }
    const rows: ProviderDay["sections"][number]["rows"] = [];
    for (const r of s.raw) {
      const c = r.cells;
      const st = (c[si] || "").trim(), anyLink = r.links.some(Boolean);
      // Set 1: an open slot is a 2-cell row reading "Open slot" (kept as is); also accept one spread
      // over the columns, or labelled "Available" / "Open" on a row with no patient link.
      const open = (c.length <= 2 && /open slot/i.test(c[1] ?? "")) || (!KNOWN_STATUS.test(st) && (/\bopen slot\b/i.test(r.text) || (!anyLink && /\bopen\b|\bavailable\b|\bfree slot\b/i.test(r.text))));
      if (open) { rows.push({ time: c[ti] ?? c[0] ?? "", patient: "", flags: [], type: "", status: "", open: true }); continue; }
      const full = c[pi] ?? "", name = r.links[pi] || full;
      const flags = new Set(full.replace(name, "").split(/\s{2,}|\n/).map((x) => x.trim()).filter(Boolean));
      for (const m of r.text.matchAll(FLAG)) flags.add(m[1].replace(/^./, (x) => x.toUpperCase()));
      const status = (c[si] ?? "").trim();
      if (!name.trim()) { why(`provider-day: a booked row at ${s.location} has no patient`); return null; }
      if (!KNOWN_STATUS.test(status)) { why(`provider-day: unknown status "${status.slice(0, 30)}" at ${s.location}`); return null; }
      rows.push({ time: c[ti] ?? "", patient: name, flags: [...flags], type: yi >= 0 ? c[yi] ?? "" : "", status, open: false });
    }
    sections.push({ location: s.location, working: s.working, rows });
  }
  return { provider: stripTitle(pg.provider.trim()), dateISO, sections };
}

export type DocumentRow = { title: string; kind: string; source?: string; receivedISO?: string; docHref?: string };
/** DOCUMENT_ROWS_JS's rows → the chart's documents (rows without a received date are dropped).
 *  Columns by header (Set 1 chart tab: Title | Type | Received), else Set 1's positions. */
export function parseDocumentRows(rows: Array<{ cells: string[]; docHref: string; head?: string[] }>): DocumentRow[] {
  const out: DocumentRow[] = [];
  for (const r of rows) {
    const hd = r.head ?? [];
    let ti = 0, yi = 1, ri = 2;
    if (hd.length) {
      const a = col(hd, /received/i), b = col(hd, /title|document|name|description/i), k = col(hd, /type|category|kind/i);
      if (a >= 0 && b >= 0 && k >= 0) { ri = a; ti = b; yi = k; }
    }
    const title = r.cells[ti] ?? "", type = r.cells[yi] ?? "", received = r.cells[ri] ?? "";
    const iso = received.match(/^\s*(\d{4})-(\d{2})-(\d{2})\s*$/);
    const receivedISO = monthDate(received) ?? (iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : undefined);
    if (!receivedISO) continue; // skip header / non-date rows
    const m = title.match(/\bfrom\s+(.+?)\s*$/i);
    out.push({ title: title.trim(), kind: type.trim().toLowerCase(), source: m ? m[1].trim() : undefined, receivedISO, docHref: r.docHref || undefined });
  }
  return out;
}

export type PatientRow = { name: string; href: string; mrn?: string; dob?: string; sex?: string; flags?: string[] };
/** Record badges a search row can carry (outside the name link): a restricted chart is never opened by a
 *  name-only resolution; deleted / test-record rows are still namesakes. */
export const ROW_FLAGS = /\b(Restricted|Deleted|Merged|Test record)\b/gi;
/** PATIENT_ROWS_JS's rows → patient search results, minus widget rows (no DOB) and merged-away duplicates. */
export function parsePatientRows(rows: Array<{ name: string; href: string; row: string; cells?: string[]; head?: string[] }>): PatientRow[] {
  return rows
    .map((r) => {
      const c = r.row.split("\t").map((x: string) => x.trim()).filter(Boolean);
      // DOB from the "Date of birth" column when the table has one; else from whichever cell parses
      // as a date (at a scored clinic the MRN column was EMPTY, so fixed positions failed).
      const bi = r.head && r.cells && r.head.length === r.cells.length ? col(r.head, /birth|\bdob\b|born/i) : -1;
      const dob = bi >= 0 ? normDob(r.cells![bi]) : c.slice(1).map((x: string) => normDob(x)).find(Boolean);
      const rest = r.row.startsWith(r.name) ? r.row.slice(r.name.length) : r.row.replace(r.name, "");
      const flags = [...new Set([...rest.matchAll(ROW_FLAGS)].map((m) => m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()))];
      return { name: r.name, href: r.href, mrn: c[1], dob, sex: c[3], flags, merged: /\bMerged\b/.test(r.row) } as PatientRow & { merged: boolean };
    })
    .filter((p) => !!p.dob && !p.merged); // real rows carry a DOB ("Restricted chart requests" rows don't); merged-away duplicates open the surviving chart
}

// ── self-check: Set 1's shapes read as before ──
if (process.argv[1]?.endsWith("pageScripts.ts")) {
  const assert = (c: unknown, m: string) => { if (!c) { console.error("✗ " + m); process.exit(1); } console.log("✓ " + m); };
  const inv = parseInvoicePage({ h1: "Invoice 92214993", dl: { Patient: "Garcia, Peter MRN", Total: "$138.00", Status: "Partly paid", "Service date": "Oct 14, 2026" }, rows: [["Oct 14, 2026", "Charge for services on Oct 14, 2026", "$138.00", ""], ["Oct 14, 2026", "Payment received", "", "$37.24"]], owed: "$100.76", status: "", ledger: true, headers: ["Date", "Description", "Charges", "Payments and adjustments"] })!;
  assert(inv.payments.join() === "37.24" && !inv.other.length && inv.total === 138 && inv.dosISO === "2026-10-14", "Set 1 ledger: payment found by header");
  assert(parseInvoicePage({ h1: "Invoice 1", dl: {}, rows: [], owed: "", status: "", ledger: false, headers: [] })!.other.length === 1, "no ledger table → an 'other' line (balance declines)");
  const legacy = parseInvoicePage({ h1: "Invoice 1", dl: {}, rows: [["d", "Payment received", "", "$5.00"]], owed: "", status: "" })!;
  assert(legacy.payments.join() === "5", "old raw shape (no headers) keeps Set 1 positions");
  const sec = (headers: string[], raw: RawRow[]) => ({ date: "2026-05-16", provider: "Diana Anderson, MD", tables: 1, text: "", sections: [{ location: "Northgate", working: "Working 9:00 AM to 1:00 PM", headers, raw }] });
  const H = ["Time", "Patient", "Visit type", "Status"];
  const day = parseProviderDay(sec(H, [
    { cells: ["9:40 AM", "Cook, Ingrid", "Diabetes management", "Completed"], links: ["", "Cook, Ingrid"], text: "9:40 AM\tCook, Ingrid\tDiabetes management\tCompleted" },
    { cells: ["11:20 AM", "Patient, Zztest Test record", "Office visit", "Completed"], links: ["", "Patient, Zztest"], text: "11:20 AM\tPatient, Zztest Test record\tOffice visit\tCompleted" },
    { cells: ["12:00 PM", "Open slot"], links: ["", ""], text: "12:00 PM\tOpen slot" },
  ]), "2026-05-16")!;
  assert(day.sections[0].rows.length === 3 && day.sections[0].rows[2].open && day.sections[0].rows[1].flags.includes("Test record"), "Set 1 day: open slot + test-record flag");
  const book = parseProviderDay(sec(H, [{ cells: ["12:00 PM", "Open slot Book"], links: ["", "Book"], text: "12:00 PM\tOpen slot Book" }, { cells: ["12:20 PM", "Open slot", "", ""], links: ["", "", "", "Book"], text: "12:20 PM\tOpen slot\t\t\tBook" }]), "2026-05-16")!;
  assert(book.sections[0].rows.every((r) => r.open), "open-slot rows carrying a 'Book' link are still open slots");
  assert(parseProviderDay(sec(H, [{ cells: ["9:40 AM", "Cook, Ingrid", "Office visit", "Booked"], links: ["", "Cook, Ingrid"], text: "x" }]), "2026-05-16") === null, "unknown status word → decline");
  assert(parseProviderDay({ ...sec(H, []), text: "Showing 1 to 10 of 14 appointments" }, "2026-05-16") === null, "paginated day → decline");
  assert(parseProviderDay({ date: "2026-05-16", provider: "X, MD", sections: [], tables: 0, text: "Nothing scheduled on this day" }, "2026-05-16")?.sections.length === 0, "empty day notice → an empty day");
  assert(parseProviderDay({ date: "2026-05-16", provider: "X, MD", sections: [], tables: 2, text: "" }, "2026-05-16") === null, "tables but no sections → decline");
  const docs = parseDocumentRows([{ cells: ["Mar 30, 2025", "Referral letter", "Referral letter from Harbor Glen Medical Group"], docHref: "/f/1", head: ["Received", "Type", "Title"] }]);
  assert(docs[0]?.source === "Harbor Glen Medical Group" && docs[0].receivedISO === "2025-03-30", "documents: columns found by header in another order");
  const pts = parsePatientRows([{ name: "Wallace, Aisha", href: "/patients/a", row: "Wallace, Aisha\t09/01/2026\t06/16/1996 (30 y)", cells: ["Wallace, Aisha", "09/01/2026", "06/16/1996 (30 y)"], head: ["Name", "Last visit", "Date of birth"] }]);
  assert(pts[0]?.dob === "1996-06-16", "patient search: DOB from the Date of birth column, not an earlier date");
  const fl = parsePatientRows([
    { name: "Nguyen, Aaron", href: "/patients/r", row: "Nguyen, Aaron\t\t05/03/1964 (62 y)\tMale\t\tRestricted" },
    { name: "Patterson, Abigail", href: "/patients/d", row: "Patterson, Abigail\t\t08/22/2004 (22 y)\tFemale\tDeleted" },
    { name: "Silva, Ambeer", href: "/patients/m", row: "Silva, Ambeer\t\t01/14/1958 (68 y)\tFemale\t\tMerged" },
    { name: "Zztest, Patient", href: "/patients/t", row: "Zztest, Patient\t\t01/01/1990 (36 y)\tFemale\tTest record" },
    { name: "Deleted, Restricted", href: "/patients/n", row: "Deleted, Restricted\t\t01/01/1990 (36 y)\tFemale\t" }]);
  assert(JSON.stringify(fl.map((p) => p.flags)) === JSON.stringify([["Restricted"], ["Deleted"], ["Test record"], []]), "patient search: row badges read outside the name (merged rows dropped)");
  console.log("ALL PASS");
}
