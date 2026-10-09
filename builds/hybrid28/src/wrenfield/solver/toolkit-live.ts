/**
 * The toolkit on the live practice site, each answer checked against an INDEPENDENT oracle: raw page text
 * (innerText) read and paged by this file's own code (own regexes, own Next / Show-more clicks, own form
 * filling by control name) — none of pageRead / listJudge / operate / patientResolve. Read-only.
 *   AGENT_BREAK_GLASS=never npx tsx src/wrenfield/solver/toolkit-live.ts   (inside the agent image)
 * Prints one line per check; "WRONG" = the toolkit answered (ok) and the oracle disagrees. Exit 1 on any WRONG.
 */
import { Crawler } from "../crawl.js";
import { Toolkit, type Row } from "./toolkit.js";
import { parseDate } from "./dates.js";

process.env.AGENT_BREAK_GLASS = "never";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const c = new Crawler(process.env.SITE_URL || "https://practice.speedrun.scopehealth.com");
await c.launch(); await c.login(process.env.SITE_USERNAME, process.env.SITE_PASSWORD);
const tk = new Toolkit(c);
let right = 0, wrong = 0, declined = 0, oracleFail = 0;
const res = (name: string, r: { ok: boolean; why?: string }, agree: boolean | null, detail: unknown = "") => {
  if (agree === null) { oracleFail++; console.log(`ORACLE? ${name} ${JSON.stringify(detail).slice(0, 300)}`); return; }
  if (!r.ok) { declined++; console.log(`DECLINE ${name}: ${r.why}`); return; }
  if (agree) { right++; console.log(`ok      ${name} ${JSON.stringify(detail).slice(0, 200)}`); } else { wrong++; console.log(`WRONG   ${name} ${JSON.stringify(detail).slice(0, 600)}`); }
};

// ── the oracle: raw text, own paging ──
const text = () => c.evalApp<string>(`return (doc.body?doc.body.innerText:'')||''`);
const footerOf = (t: string) => (t.match(/Showing [^\n]*/) || t.match(/^\s*(\d[\d,]*) (?:[a-z]+)\s*$/m) || [""])[0].trim();
async function clickBtn(re: string): Promise<boolean> {
  return c.evalApp<boolean>(`const b=[...doc.querySelectorAll('button')].find(x=>new RegExp(${JSON.stringify(re)},'i').test((x.textContent||'').trim())&&!x.closest('[aria-hidden="true"]')&&!x.closest('form')); if(b&&!b.disabled){b.click();return true} return false;`);
}
/** Lines of the oracle's table rows: every line of the page that starts with a date-ish or row-ish token,
 *  collected over all pages; returns the stated total and the row lines. */
async function oracleWalk(rowRe: RegExp, maxPages = 40): Promise<{ total: number | null; lines: string[]; footer: string } | null> {
  const lines: string[] = []; let footer = "";
  for (let page = 1; page <= maxPages; page++) {
    const t = await text(); footer = footerOf(t);
    const m = footer.match(/Showing (\d+) to (\d+) of ([\d,]+)(\+?)/), s = footer.match(/Showing (\d+) of ([\d,]+)/), k = footer.match(/^(\d[\d,]*) [a-z]+$/);
    if (s && !m) { // Show more: press until gone, then read once
      for (let i = 0; i < 60 && (await clickBtn("^(show|load) more")); i++) { await sleep(900); }
      const t2 = await text(); footer = footerOf(t2);
      return { total: Number((footer.match(/of ([\d,]+)/) || ["", "NaN"])[1].replace(/,/g, "")), lines: t2.split("\n").filter((l) => rowRe.test(l)), footer };
    }
    lines.push(...t.split("\n").filter((l) => rowRe.test(l)));
    if (k) return { total: Number(k[1].replace(/,/g, "")), lines, footer };
    if (!m) return { total: /^No [a-z ]+ (on file|found|in this chart|on this account|recorded)\.?$/im.test(t) && !/^No single/im.test(t) ? 0 : null, lines, footer };
    if (!m[4] && Number(m[2]) >= Number(m[3].replace(/,/g, ""))) return { total: Number(m[3].replace(/,/g, "")), lines, footer };
    const a0 = m[1];
    if (!(await clickBtn("^next$"))) return null;
    let moved = false; for (let i = 0; i < 100; i++) { await sleep(100); const f = footerOf(await text()); const a1 = (f.match(/Showing (\d+)/) || [])[1]; if (a1 && a1 !== a0) { moved = true; break; } }
    if (!moved) return null;
  }
  return null;
}
const dateLine = /^(?:[A-Z][a-z]{2}, )?[A-Z][a-z]{2} \d{1,2}, \d{4}/;

// ── 1. patients: the oracle reads search result rows itself ──
const pats: Array<{ name: string; href: string; row: string }> = [];
for (const ln of ["Garcia", "Smith", "Ward"]) {
await c.navTo(`/patients?lastName=${ln}`, /Showing|patients/i, 12000, true); await sleep(1500);
pats.push(...await c.evalApp<Array<{ name: string; href: string; row: string }>>(`return [...doc.querySelectorAll('a[href^="/patients/"]')].map(a=>({name:(a.textContent||'').trim(),href:a.getAttribute('href'),row:((a.closest('tr')||a).innerText||'').replace(/\\s+/g,' ')})).filter(x=>/^[A-Z][^,]+, [A-Z]/.test(x.name)&&!/Restricted|Deleted|Test|Merged/.test(x.row))`).then((xs) => xs.slice(0, 3)));
}
const picks = pats.filter((p, i, a) => a.findIndex((q) => q.name === p.name) === i);
for (const p of picks) {
  const dob = parseDate((p.row.match(/\b\d{2}\/\d{2}\/\d{4}\b/) || [""])[0]);
  const [last, first] = p.name.split(", ");
  const r = await tk.getPatient(`${first} ${last}`, dob);
  res(`getPatient ${p.name} ${dob}`, r, dob ? (r.ok ? r.value.href === p.href : true) : null, r.ok ? { got: r.value.href, want: p.href } : "");
}

// ── 2. per-patient lists vs the oracle walk ──
const chartIds = [...new Set(picks.map((p) => p.href))].slice(0, 6);
const tabs: Array<["appointment" | "document" | "invoice" | "problem" | "immunization" | "claim" | "activity", string, RegExp]> = [
  ["appointment", "Appointments", /^[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2}/],
  ["document", "Documents", /\t[A-Z][a-z]{2} \d{1,2}, \d{4}\t/],
  ["invoice", "Invoices", /^\d{8}\t/],
  ["problem", "Problems", /^[A-Z]\d{2}(\.\d+)?\t/],
  ["activity" as any, "Activity", /^[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2}/],
];
for (const href of chartIds) for (const [entity, tab, rowRe] of tabs) {
  const r = await tk.listEntities(entity, "patient", {}, { patientHref: href, budgetMs: 60000 });
  // oracle: open the chart, follow the tab's link by its text, walk raw text
  await c.navTo(href, /MRN|Date of birth/, 12000, true); await sleep(800);
  const tabHref = await c.evalApp<string>(`const a=[...doc.querySelectorAll('a[href^="/"]')].filter(a=>(a.textContent||'').trim()===${JSON.stringify(tab)}); return a.length===1?a[0].getAttribute('href'):''`);
  if (!tabHref) { res(`${entity} ${href}`, r, r.ok ? null : true, "oracle: no tab"); continue; }
  await c.navTo(tabHref, /\S/, 12000, true); await sleep(1500);
  const o = await oracleWalk(rowRe);
  if (!o || o.total === null) { res(`${entity} ${href}`, r, r.ok ? null : true, { oracle: o?.footer }); continue; }
  const n = r.ok ? r.value.rows.length : -1;
  const agree = r.ok ? n === o.total && (o.total === o.lines.length || entity === "invoice" || entity === "document") : true;
  res(`${entity} list ${href}`, r, agree, { toolkit: n, oracleTotal: o.total, oracleLines: o.lines.length, proof: r.ok ? r.proof.how : "" });
  // dates of rows agree (appointments: the oracle's row lines start with the date)
  if (r.ok && entity === "appointment" && o.lines.length === n) {
    const got = r.value.rows.map((x: Row) => parseDate(Object.values(x.cells)[0] ?? "")).sort().join();
    const want = o.lines.map((l) => parseDate(l)).sort().join();
    res(`appointment dates ${href}`, r, got === want, { n });
  }
}

// ── 3. a detail page's fields vs the oracle's dt/dd text ──
{
  await c.navTo("/billing", /Showing|invoices/i, 12000, true); await sleep(1500);
  const invHrefs = await c.evalApp<string[]>(`return [...doc.querySelectorAll('a[href^="/billing/invoices/"]')].map(a=>a.getAttribute('href')).slice(0,3)`);
  for (const h of invHrefs) {
    const r = await tk.getFields("invoice", h, ["status", "total", "serviceDate", "location"]);
    await c.navTo(h, /Invoice/, 12000, true); await sleep(800);
    const dd = await c.evalApp<Record<string, string>>(`const o={}; for(const dt of doc.querySelectorAll('dt')){ const d=dt.nextElementSibling; if(d) o[(dt.textContent||'').trim()]=(d.innerText||d.textContent||'').trim(); } return o;`);
    res(`invoice fields ${h}`, r, r.ok ? r.value.status === dd["Status"] && r.value.total === dd["Total"] && r.value.serviceDate === dd["Service date"] && r.value.location === dd["Location"] : true, r.ok ? { got: r.value, want: dd } : "");
  }
}

// ── 4. a clinic-wide filtered list vs the oracle filling the same form by control NAME ──
{
  const day = "2026-10-05";
  const r = await tk.listEntities("document", "clinic", { type: "Lab report", from: day, to: day }, { budgetMs: 90000 });
  await c.navTo("/documents", /Showing|documents/i, 12000, true); await sleep(1500);
  const filled = await c.evalApp<string>(`const f=[...doc.querySelectorAll('form')].find(fm=>[...fm.querySelectorAll('select')].some(s=>[...s.options].some(o=>o.text.trim()==='Lab report'))); if(!f) return 'noform';
    const s=[...f.querySelectorAll('select')].find(s=>[...s.options].some(o=>o.text.trim()==='Lab report')); s.value=[...s.options].find(o=>o.text.trim()==='Lab report').value; s.dispatchEvent(new Event('change',{bubbles:true}));
    const ds=[...f.querySelectorAll('input[type=date]')]; if(ds.length!==2) return 'dates'; for(const d of ds){ const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(d,'${day}'); d.dispatchEvent(new Event('input',{bubbles:true})); d.dispatchEvent(new Event('change',{bubbles:true})); }
    const b=[...f.querySelectorAll('button')].find(x=>/apply/i.test(x.textContent||'')); if(!b) return 'nobtn'; b.click(); return 'ok';`);
  await sleep(2500);
  const o = filled === "ok" ? await oracleWalk(/^[A-Z][a-z]{2} \d{1,2}, \d{4}\tLab report\t/) : null;
  const n = r.ok ? r.value.rows.length : -1;
  res(`documents Lab report ${day}`, r, o && o.total !== null ? (r.ok ? n === o.total && o.lines.length === o.total && r.value.rows.every((x) => x.cells["Type"] === "Lab report" && parseDate(x.cells["Received"]) === day) : true) : null, { toolkit: n, oracle: o?.total, lines: o?.lines.length, filled, why: r.ok ? r.proof.how : "" });
}

// ── 5. clinic activity for one day (label route: practice /activity, Set 1 /audit-log) ──
{
  const day = "2026-10-12";
  const r = await tk.listEntities("activity", "clinic", { from: day, to: day }, { budgetMs: 90000 });
  const n = r.ok ? r.value.rows.length : -1;
  const allIn = r.ok ? r.value.rows.every((x) => parseDate(x.cells["Time"] ?? x.cells["When"] ?? "") === day) : true;
  res(`activity ${day} rows dated in range`, r, allIn, { n, why: r.ok ? r.proof.how : "" });
}

console.log(`toolkit-live: ${right} right, ${wrong} WRONG, ${declined} declined, ${oracleFail} oracle-unavailable`);
await c.close();
process.exit(wrong ? 1 : 0);
