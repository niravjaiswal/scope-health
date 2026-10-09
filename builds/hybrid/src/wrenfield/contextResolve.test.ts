/**
 * contextResolve.ts: name-only patients resolved from the task's own context (lab reports received that day,
 * the day's appointment list) when the patient search can't settle the name.
 *   1. pickByContext never-guess rules (exact name, namesakes, badges, time, the search's namesakes);
 *   2. the Set 1 documents page (recon-158, real HTML) read by label: rows, patient links, footer — and an
 *      unfiltered list is refused as context (rows on other dates / other types);
 *   3. the run-164 cluster: every "patient not resolved" skip of a name-only lab / filing / good-faith /
 *      tetanus / claim task is one the context path is tried on; DOB tasks and other skips never are;
 *   4. wiring: each family passes its context to patientFor.
 */
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { pickByContext, minutesOf, DOCS_EXTRACT, docRows, docFooter, labRowsToContext, type CtxRow, type DocsRaw } from "./contextResolve.js";

let pass = 0, fail = 0;
const eq = (got: unknown, want: unknown, what: string) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++; if (!ok) console.log(`FAIL ${what}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); };
const fx = (p: string) => readFileSync(new URL("../../fixtures/" + p, import.meta.url), "utf8");

// ── 1. pick ──
const R = (name: string, id: string, extra: Partial<CtxRow> = {}): CtxRow => ({ name, href: `/patients/${id}`, ...extra });
const ok = (rows: CtxRow[], asked: string, o = {}) => pickByContext(rows, asked, o).chosen?.href ?? null;
const day = [R("Li, Barbara", "a1", { start: 500 }), R("Lee, Barbara", "a2"), R("Li, Bruce", "a3"), R("Wells, Matthew", "b1", { start: 600 }), R("Wells, Matthew", "b1", { start: 900 })];
eq(ok(day, "Barbara Li"), "/patients/a1", "one exact row");
eq(ok(day, "Li, Barbara"), "/patients/a1", "Last, First ask");
eq(ok(day, "Matthew Wells"), "/patients/b1", "same chart twice on the day = one patient");
eq(ok(day, "Matthew Wells", { start: 900 }), "/patients/b1", "time matches one of the patient's rows");
eq(ok(day, "Matthew Wells", { start: 905 }), null, "asked time not on the patient's rows → decline");
eq(ok([...day, R("Li, Barbara", "a9")], "Barbara Li"), null, "two charts with the name → decline");
eq(ok([R("Li, Barbara Ann", "a1")], "Barbara Li"), null, "row has an extra given name (not exactly the name) → decline");
eq(ok([R("Li, Barbara", "a1"), R("Li, Barbara Ann", "a4")], "Barbara Li"), null, "exact row + a superset namesake → decline");
eq(ok([R("Li, Barbara", "a1", { badge: "Merged" })], "Barbara Li"), null, "badge on the row → decline");
eq(ok([R("Li, Barbara", "a1", { badge: "Test record" })], "Barbara Li"), null, "test record → decline");
eq(ok([R("García, George", "g1")], "George Garcia"), "/patients/g1", "accents folded");
eq(ok([R("Garcia, George", "g1")], "George García"), "/patients/g1", "accents folded (ask)");
eq(ok([R("Martinez, Noelle", "n1")], "Noëlle Martinez"), "/patients/n1", "diaeresis folded");
eq(ok([R("O'Brien, Adam", "o1")], "Adam OBrien"), "/patients/o1", "apostrophe folded");
eq(ok([R("Sanchez, Ana", "s2")], "Ana Sanchez", { among: ["/patients/s1", "/patients/s2"] }), "/patients/s2", "ambiguous search: context picks one of the namesakes");
eq(ok([R("Sanchez, Ana", "s3")], "Ana Sanchez", { among: ["/patients/s1", "/patients/s2"] }), null, "context patient not among the search's namesakes → decline");
eq(ok([], "Ana Sanchez"), null, "empty context → decline");
eq(ok([R("Bell, Astrid", "x")], "Astrid"), null, "a one-word ask is not a name");
eq(ok([R("Bell, Astrid", "x")], "A. Bell"), null, "an initial is not a first name");
eq(ok([R("Bell, Astrid", "/../x")], "Astrid Bell"), null, "odd chart link → decline");
eq([minutesOf("08:20"), minutesOf("13:00"), minutesOf("1:00 PM"), minutesOf("12:15 am"), minutesOf("25:00"), minutesOf("")], [500, 780, 780, 15, undefined, undefined], "times");

// ── 2. Set 1 documents page (recon-158, real HTML) ──
const recon = fx("set1/recon-158.txt");
const sec = recon.split(/\n(?=@@@@ )/).find((s) => s.startsWith("@@@@ /documents ::"))!;
const html = sec.slice(sec.indexOf("---- HTML ----") + 15);
const dom = new JSDOM(html);
const raw = new Function("doc", DOCS_EXTRACT)(dom.window.document) as DocsRaw;
eq(raw.footer, "Showing 20 of about 100,750 documents", "Set 1 footer found");
const df = (s: string) => { const d = docFooter(s); return d && (({ footer: _f, ...rest }) => rest)(d); }; // without the shared footer object
eq(df(raw.footer), { a: 1, shown: 20, total: 100750, approx: true, plus: false, cumulative: true }, "Set 1 footer parsed (Show more list, estimate)");
eq([raw.more.present, raw.next.present, raw.noMore], [true, false, false], "Show more control found by its text");
const dr = docRows(raw);
eq("rows" in dr ? dr.rows.length : dr.problem, 20, "20 document rows by header label");
if ("rows" in dr) {
  eq(dr.rows[0], { receivedISO: "2026-11-10", type: "Immunization record", title: "Immunization record: Dunmore County Health Department", patient: "Santos, Timothy", href: "/patients/5hvdfdt25q", docHref: "/documents/14jmdv3kpw" }, "first row by label");
  eq(dr.rows.every((r) => /^\/patients\/\w+$/.test(r.href) && !r.badge), true, "every row: one patient link, no badge");
  const c1 = labRowsToContext(dr.rows, "2026-11-10", "Complete blood count");
  eq("fail" in c1 ? c1.fail.slice(0, 31) : "rows", "documents filter not applied (a", "unfiltered list (other dates/types) is refused as context");
  // the same page with the rows re-dated/typed as the filter would show them
  const labs = dr.rows.map((r, i) => ({ ...r, receivedISO: "2026-10-14", type: "Lab report", title: i % 2 ? "Lab report: Basic metabolic panel" : "Lab report: Complete blood count" }));
  const c2 = labRowsToContext(labs, "2026-10-14", "Basic metabolic panel");
  eq("rows" in c2 ? c2.rows.length : c2.fail, 10, "only the panel's reports are context");
  if ("rows" in c2) {
    eq(pickByContext(c2.rows, "Wei Thomas").chosen?.href ?? null, "/patients/71f8hfxbwb", "pick from the documents rows");
    eq(pickByContext(c2.rows, "Nicholas Fernandez").chosen?.href ?? null, "/patients/5vlq1kng17", "same chart on several reports = one patient");
    eq(pickByContext(c2.rows, "Timothy Santos").chosen, null, "patient whose report is another panel → decline");
  }
  eq(labRowsToContext([], "2026-10-14", "Basic metabolic panel"), { fail: "no lab reports listed as received 2026-10-14" }, "empty list proves nothing");
}
eq(df("4 documents"), { a: 1, shown: -1, total: 4, approx: false, plus: false, cumulative: true }, "practice footer (exact count)");
eq(df("Showing 1 to 25 of 98 documents"), { a: 1, shown: 25, total: 98, approx: false, plus: false, cumulative: false }, "paged footer");
eq(df("Showing 476 to 500 of 500+ documents"), { a: 476, shown: 500, total: 500, approx: false, plus: true, cumulative: false }, "capped footer keeps its + (the audit's false-completeness case)");
eq(df("No documents match"), { a: 0, shown: 0, total: 0, approx: false, plus: false, cumulative: false, none: true }, "empty footer");
eq(df("documents"), undefined, "no count → unreadable");
// a badge next to the patient link is kept (→ decline)
{
  const d2 = new JSDOM(html.replace(">Santos, Timothy</a>   </span>", ">Santos, Timothy</a> <span>Merged</span></span>"));
  const r2 = docRows(new Function("doc", DOCS_EXTRACT)(d2.window.document) as DocsRaw);
  eq("rows" in r2 ? r2.rows[0].badge : r2.problem, "Merged", "badge text beside the patient link is read");
}

// ── 3. run-164 cluster: which skips the context path is tried on ──
const CTX_FAMILIES: Record<string, string> = { "lab-report-triage": "lab", "filing-deadline": "filing", "good-faith-estimate": "good-faith", "tetanus-wound": "tetanus", "claim-next-step": "claim" };
const tries = (why: string) => /not read past/.test(why) || /^\d+ patients named/.test(why);
const items = fx("set1/run-164-set1.log").split("\n").filter((l) => l.startsWith('{"event":"item"')).map((l) => JSON.parse(l));
const cluster = items.filter((x) => x.kind === "task" && x.result?.skip && /patient not resolved/.test(x.why ?? ""));
const resolveWhy = (w: string) => (w.match(/patient not resolved \((.*)\)$/) ?? [, ""])[1]!;
const tried = cluster.filter((x) => CTX_FAMILIES[x.family] && !x.slots?.dob && tries(resolveWhy(x.why)));
eq(cluster.length, 16, "run 164: 16 'patient not resolved' skips");
eq(tried.map((x) => x.n), cluster.map((x) => x.n), "every one of them is tried on its context");
eq(Object.fromEntries(Object.entries(tried.reduce((a: Record<string, number>, x) => (a[x.family] = (a[x.family] ?? 0) + 1, a), {})).sort()), { "claim-next-step": 1, "filing-deadline": 3, "good-faith-estimate": 3, "lab-report-triage": 7, "tetanus-wound": 2 }, "by family");
eq(tried.every((x) => (x.family === "lab-report-triage" ? x.slots.received && x.slots.panel : x.slots.dos || x.slots.date || x.slots.visit)), true, "each carries the date its context needs");
eq(tries("no patient named Ana Sanchez"), false, "a complete search with no such patient is never overridden by context");
eq(tries("the only Ana Sanchez record is restricted (chart not opened)"), false, "a restricted lone match is never overridden");
eq(items.filter((x) => x.result && !x.result.skip && x.kind === "task").length > 0, true, "answered tasks present (their resolution never reaches the context path: the search chose)");

// ── 4. wiring ──
const ib = readFileSync(new URL("./index-builder.ts", import.meta.url), "utf8");
for (const [fam, ctx] of [["filing", "visitCtx(dob, dosISO)"], ["claim", "visitCtx(dob, dosISO)"], ["good-faith", "visitCtx(dob, apptDateISO, time)"], ["tetanus", "visitCtx(d, visitISO, undefined, \"wound\")"], ["lab", "ctx)"]] as const)
  eq(new RegExp(`patientFor\\("${fam}"[^\\n]*${ctx.replace(/[()]/g, "\\$&")}`).test(ib), true, `${fam}: patientFor gets its context`);
eq(/cache\.set\(k, rec\); if \(!viaCtx\) cache\.set\(key\(name\), rec\)/.test(ib), true, "a context-chosen record is cached under its context only");

console.log(`\ncontextResolve: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
