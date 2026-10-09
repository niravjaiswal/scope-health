/**
 * The one list-footer grammar and the one completeness rule (listFooter.ts), on every footer form the Set 1 and
 * practice clinics show (captured pages, runs 146–164) and the capped forms of the generalization audit.
 *   npx tsx src/wrenfield/listFooter.test.ts
 */
import { listFooter, isComplete, LIST_FOOTER_JS, type ListFooter } from "./listFooter.js";

let pass = 0, fail = 0;
const eq = (got: unknown, want: unknown, label: string) => { const g = JSON.stringify(got), w = JSON.stringify(want); if (g === w) { pass++; console.log("✓ " + label); } else { fail++; console.error(`✗ ${label}\n    got  ${g}\n    want ${w}`); } };
const F = (s: string, noun?: RegExp) => { const f = listFooter(s, noun); return f && (({ text: _t, ...rest }) => rest)(f); };
const K = (s: string) => { const f = listFooter(s); return f ? `${f.kind}${f.cumulative ? " cumulative" : ""}${f.end ? " end" : ""}${f.none ? " none" : ""} ${f.from}-${f.to}/${f.total}${f.page !== undefined ? ` page ${f.page}/${f.pages}` : ""} ${f.noun || "-"}` : null; };

console.log("── grammar: one parse for every footer form ──");
eq(K("Showing 1 to 25 of 98 entries"), "exact 1-25/98 entries", "paged exact (Set 1 clinic calendar)");
eq(K("Showing 1 to 10 of 33 notes"), "exact 1-10/33 notes", "paged exact (Set 1 notes)");
eq(K("Showing 1–10 of 33"), "exact 1-10/33 -", "en-dash range, no noun");
eq(K("Showing 476 to 500 of 500+ invoices"), "plus 476-500/500 invoices", "a '+' total is a lower bound (practice billing cap)");
eq(K("Showing 1 to 25 of 500+ invoices"), "plus 1-25/500 invoices", "'+' on page 1");
eq(K("Showing 1 to 20 of about 200,200 invoices"), "approx 1-20/200200 invoices", "an 'about' total is an estimate (Set 1 billing)");
eq(K("Showing 41 to 55 of about 50 patients"), "approx 41-55/50 patients", "estimate past its own number (run 146 search)");
eq(K("Showing 15 of 148 appointments"), "exact cumulative 1-15/148 appointments", "Show-more list, exact (Set 1 chart appointments)");
eq(K("Showing 20 of about 100,750 documents"), "approx cumulative 1-20/100750 documents", "Show-more list, estimate (Set 1 documents)");
eq(K("Showing 300 of about 1,000 appointments"), "approx cumulative 1-300/1000 appointments", "Show-more list cut at 300 (run 164)");
eq(K("Showing 25 of about 600 patients"), "approx cumulative 1-25/600 patients", "audit footer 4");
eq(K("8 notes"), "exact end 1-8/8 notes", "the list's own count");
eq(K("0 notes"), "exact end 0-0/0 notes", "a zero count");
eq(K("about 250 appointments"), "approx cumulative end 1--1/250 appointments", "finished Show-more list's estimate (run 164 Cedar Hollow): rows unknown");
eq(K("500+ invoices"), "plus cumulative end 1--1/500 invoices", "a bound as the list's own count");
eq(K("Page 2 of 7"), "exact -1--1/-1 page 2/7 -", "page numbers only");
eq(K("No appointments match the filters."), "exact end none 0-0/0 appointments", "empty list");
eq(K("No notes"), "exact end none 0-0/0 notes", "empty list, bare");
eq(K("Nothing recorded"), "exact end none 0-0/0 -", "empty list (immunizations wording)");
eq(K("No more results."), null, "'No more results' is the empty page past a cap, never a footer");
eq(K("Dashboard Oct 14, 2026 Updated 10:00 AM Showing 1 to 25 of 98 entries Rows per page 25"), "exact 1-25/98 entries", "found inside a whole page text (operate.pagerOf)");
eq(K("Patients\nLast name\nShowing 1 to 25 of about 600 patients\nNext"), "approx 1-25/600 patients", "found on its own line of a page text");
eq(K("Appointments today\n882\nScheduled"), null, "a dashboard number is not a count footer");
eq(K(""), null, "empty text");
eq(F("Showing 1 to 10 of 33 notes\n12 documents", /^documents?$/i)?.total, 12, "noun filter: the notes pager is skipped for the documents count");
eq(F("Showing 1–10 of 33\n12 documents", /^notes?$/i)?.total, 33, "noun filter: a footer without a noun passes");
eq(F("Showing 1 to 10 of 33 notes", /^documents?$/i), null, "noun filter: no documents footer → null");
eq(/^\s*function listFooter\(/m.test(LIST_FOOTER_JS), true, "the grammar ships as plain JS for the in-page OPERATE_LIB");

console.log("── rule: only an exact total reached proves an end ──");
const C = (rows: number, s: string, st: Parameters<typeof isComplete>[2] = {}) => { const v = isComplete(rows, listFooter(s), st); return v.complete ? v.proof : `no${v.capped ? " (capped)" : ""}`; };
eq(C(98, "Showing 76 to 98 of 98 entries", { next: "disabled" }), "exact-total", "exact total reached, Next disabled");
eq(C(98, "Showing 76 to 98 of 98 entries", { next: "none" }), "exact-total", "exact total reached, no pager control");
eq(C(98, "Showing 76 to 98 of 98 entries", { next: "enabled" }), "no", "total reached but Next still offered → inconsistent");
eq(C(97, "Showing 76 to 98 of 98 entries", { next: "disabled" }), "no", "a row short of the total");
eq(C(25, "Showing 1 to 25 of 98 entries", { next: "disabled" }), "no", "Next disabled before the total: not the end");
eq(C(500, "Showing 476 to 500 of 500+ invoices", { next: "disabled" }), "no (capped)", "a '+' total never proves the end (audit §5.1)");
eq(C(500, "Showing 476 to 500 of 500+ invoices", { next: "none" }), "no (capped)", "… even with no Next control at all");
eq(C(500, "Showing 1 to 500 of about 500 invoices", { next: "disabled" }), "no (capped)", "an 'about' total never proves the end");
eq(C(55, "Showing 41 to 55 of about 50 patients", { next: "disabled" }), "no (capped)", "an estimate exceeded is still an estimate (run 146)");
eq(C(148, "Showing 148 of 148 appointments", { more: "none" }), "exact-total", "Show-more list fully loaded, exact");
eq(C(148, "Showing 148 of 148 appointments", { more: "enabled" }), "no", "Show-more list at its total but still offering more");
eq(C(15, "Showing 15 of 148 appointments", { more: "enabled" }), "no", "Show-more list, first load");
eq(C(300, "Showing 300 of about 1,000 appointments", { more: "none" }), "no (capped)", "Show-more list cut at 300 of an estimate (run 164)");
eq(C(250, "about 250 appointments", { more: "none" }), "no (capped)", "finished Show-more list stating only an estimate: never proven (was accepted within a tolerance)");
eq(C(8, "8 notes"), "exact-count", "the list's own count equals the rows");
eq(C(7, "8 notes"), "no", "the list's own count exceeds the rows");
eq(C(9, "8 notes"), "no", "more rows than the list's own count");
eq(C(96, "96 patients", { next: "none" }), "exact-count", "whole list on one page (practice search)");
eq(C(0, "No notes"), "empty", "an empty list with no rows");
eq(C(1, "No notes"), "no", "an empty-list footer above a row");
eq(C(7, "Page 7 of 7", { next: "disabled" }), "last-page", "the pager's own page count reached");
eq(C(7, "Page 6 of 7", { next: "enabled" }), "no", "not the last page");
eq(C(25, "", { next: "disabled" }), "no", "no footer: a disabled Next alone proves nothing");
eq(C(0, "", { next: "none" }), "no", "no footer, no rows: nothing proven");
eq(C(500, "Showing 476 to 500 of 500 invoices", { next: "disabled", empty: true }), "no (capped)", "the empty 'No more results' page overrides any footer");
eq(C(501, "Showing 477 to 501 of 500 invoices", { next: "disabled" }), "no", "a range past an exact total is inconsistent");

// every footer the generalization audit's check feeds, through the one grammar: none is exact except the plain one
const AUDIT = ["Showing 1 to 25 of 500+ invoices", "Showing 476 to 500 of 500+ invoices", "Showing 1 to 25 of about 500 invoices", "Showing 25 of about 600 patients", "Showing 1 to 25 of 500 invoices"];
eq(AUDIT.map((s) => (listFooter(s) as ListFooter).kind), ["plus", "plus", "approx", "approx", "exact"], "bench/pager-grammars-check footers");

console.log(fail ? `\n✗ listFooter: ${pass} passed, ${fail} failed` : `\n✓ listFooter: ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
