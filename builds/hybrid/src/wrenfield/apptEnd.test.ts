/**
 * The finished Show-more list ("about 250 appointments") as the end of an appointment-list read, and the aggregate time budget.
 *   npx tsx src/wrenfield/apptEnd.test.ts
 *
 * Run 278 (Set 1, 185 / 0 wrong / 39 skipped) skipped the 10 appointment-list aggregates: the list shows only "about N" totals, cut
 * lists stop at 300 rows, and a busy site degrades the list. s2 integration and s3 integration accepted a finished list's estimate under a
 * conjunction of plausibility checks (apptList.endFormProof); s3 refuses it always (LESSONS §C.4) and re-reads short ranges by day,
 * where a list under 100 rows states its exact count. This file checks the pages the 278 run ended on (fixtures/set1/probes-278: probe
 * HTML of items 83, 108, 115, 130, 134, 151), that the proof is refused on every one of the old boundary cases, and taskBudgetMs.
 * The simulated-site reads (by-day re-reads, busy stop sign, negatives) are in test-aggregate.ts.
 */
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { PAGE_EXTRACT, parseListPage, rangeOf, endFormProof, taskBudgetMs, setShiftDeadline, SHOW_MORE_CAP, type RawPage } from "./apptList.js";
import { pacer } from "./pacer.js";

let pass = 0, fail = 0;
const ok = (c: unknown, m: string) => { if (c) pass++; else { fail++; console.error("✗ " + m); } };
const fx = (p: string) => readFileSync(new URL("../../fixtures/" + p, import.meta.url), "utf8");
const raw278 = (n: string): RawPage => { const dom = new JSDOM(fx("set1/probes-278/" + n + ".html")); return new Function("doc", "Event", PAGE_EXTRACT)(dom.window.document, dom.window.Event) as RawPage; };

// ── the pages the 278 run ended on ──
const r11 = raw278("11-skip_probe-location-completed-before-time"), r18 = raw278("18-skip_probe-top-providers-completed-month");
const r21 = raw278("21-skip_probe-location-month-distinct-patients"), r23 = raw278("23-skip_probe-location-month-distinct-patients");
const r24 = raw278("24-skip_probe-location-month-distinct-patients"), r25 = raw278("25-skip_probe-location-month-distinct-patients");
const g11 = rangeOf(r11.footer)!, g18 = rangeOf(r18.footer)!, g21 = rangeOf(r21.footer)!, g24 = rangeOf(r24.footer)!;
ok(g11.end && g11.approx && g11.cumulative && g11.total === 250 && !r11.more?.present && !r11.busy && !r11.notResponding, `probe 11 (Cedar Hollow, 3 days): finished-list footer "${r11.footer}", no button, no busy notice, the hidden "not responding" line ignored`);
ok(g18.cumulative && g18.approx && !g18.end && g18.total === 16950 && g18.b === 20 && r18.more?.present && !r18.busy, `probe 18 (top providers, all locations): "${r18.footer}" + Show more (848 presses: stays a pacer decline)`);
ok(g21.cumulative && g21.approx && g21.total === 750 && r21.more?.present && !r21.busy, `probe 21 (Willow Creek Aug 8..Sep 1): "${r21.footer}" + Show more`);
ok(r23.busy === true && r23.more?.present && rangeOf(r23.footer)!.b === 40, `probe 23 (Front Range Dec 21..Jan 1, items 130/195's failure): "Wrenfield is busy … fewer rows than usual", 40 rows, Show more present → busy`);
ok(!r11.busy && !r18.busy && !r21.busy && !r24.busy && !r25.busy, "probes 11 18 21 24 25: no busy notice");
ok(g24.cumulative && g24.approx && g24.total === 2400 && g24.b === 280, `probe 24 (Northgate May 2025): "${r24.footer}"`);
const pg21 = parseListPage(r21), pg23 = parseListPage(r23), pg25 = parseListPage(r25);
ok(pg21.problems.length === 0 && pg21.rows.length === 20 && pg23.problems.length === 0 && pg23.rows.length === 40 && pg25.problems.length === 0 && pg25.rows.length === 20, `probes 21 23 25 parse without problems (20 / 40 / 20 rows; no Location column on a one-location list)`);
ok(pg21.rows.every((x) => x.status === "Completed" && !x.unknownBadge) && pg23.rows.every((x) => x.status === "Scheduled"), "probe rows carry the filtered status and no unknown badges");
// the rows of the probe pages carry the badges the engine excludes on (Deleted / Test record / Restricted / Merged), found by words, not classes
const flagsSeen = new Set(parseListPage(r11).rows.flatMap((x) => x.flags));
ok(flagsSeen.has("Deleted") && flagsSeen.has("Restricted"), `probe 11 rows: badges read from the patient cell (${[...flagsSeen].join(", ")})`);

// ── endFormProof: ALWAYS refused (LESSONS §C.4). s2 integration and s3 integration accepted these; s3 keeps the rule and re-reads short ranges by day ──
const e250 = g11;
const refused = (r: { ok: boolean; why?: string }) => !r.ok && /never proves/.test(r.why ?? "");
ok(refused(endFormProof(252, e250, e250)), "252 rows, 'about 250' on the first page and at the end (run 265 answered item 83 on this) → NOT a proof");
ok(refused(endFormProof(57, e250, e250)) && refused(endFormProof(238, e250, e250)) && refused(endFormProof(274, e250, e250)), "no window of rows around the estimate is a proof (238..274 were accepted in runs 265 / 304)");
ok(refused(endFormProof(300, { ...e250, total: 300 }, { ...e250, total: 300 })), "300 rows (the site's cut) → no");
ok(refused(endFormProof(252, g21, e250)) && refused(endFormProof(252, { ...e250, total: 255 }, { ...e250, total: 255 })), "a changed estimate, an off-grid estimate → no (as before)");
ok(refused(endFormProof(252, g21, rangeOf("Showing 300 of about 1,000 appointments")!)) && refused(endFormProof(252, e250, { ...e250, plus: true })), "the cut form and a '+' bound → no (as before)");
ok(refused(endFormProof(160, { ...e250, total: 600 }, { ...e250, total: 600 })), "160 rows of 'about 600' (run 146's short patient search) → no");
{ const small = rangeOf("about 25 appointments")!; ok(refused(endFormProof(20, small, small)), "a small list on the grid (20 rows of 'about 25') → no: a day's list under 100 rows states its exact count instead"); }
{ const exact = rangeOf("89 appointments")!; ok(exact.end && !exact.approx && !exact.plus && exact.total === 89, `the exact finished-list footer "89 appointments" (probe-278-appts-northgate-exact89) is the proof a day read rests on (${JSON.stringify(exact)})`); }

// ── time budget (run 278: items 225 and 236 got "0 s of task budget left" with ~150 s of the shift to spare) ──
{
  const now = 1_000_000;
  delete process.env.AGG_TASK_BUDGET_S;
  setShiftDeadline(now + 170_000); // 170 s left
  ok(taskBudgetMs(now) === 90_000, `no pace history, 170 s left → the 90 s cap (${taskBudgetMs(now)})`);
  process.env.AGG_TASK_BUDGET_S = "30"; ok(taskBudgetMs(now) === 30_000, "AGG_TASK_BUDGET_S=30 caps one task at 30 s"); delete process.env.AGG_TASK_BUDGET_S;
  setShiftDeadline(now + 10_000); ok(taskBudgetMs(now) === 0, "10 s left → nothing (the last 20 s are kept)");
  setShiftDeadline(now + 25_000); ok(taskBudgetMs(now) === 5_000, "25 s left → 5 s");
  // behind pace (every item 8 s, 100 seen, 170 s left): the old fixed 240 s reserve gave 0; the floor gives a read that fits 15 s
  for (let i = 0; i < 100; i++) pacer.end("lab-report-triage", 8000, true);
  pacer.begin(170); setShiftDeadline(now + 170_000);
  ok(pacer.extraSlackS() <= 0,`behind pace: no slack for extras (${Math.round(pacer.extraSlackS())} s)`);
  ok(taskBudgetMs(now) === 15_000, `behind pace, 170 s left → the 15 s floor, not 0 (${taskBudgetMs(now)})`);
  setShiftDeadline(now + 12_000); ok(taskBudgetMs(now) === 0, "behind pace and 12 s left → 0");
}

console.log(fail ? `✗ apptEnd: ${pass} passed, ${fail} failed` : `✓ apptEnd: ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
