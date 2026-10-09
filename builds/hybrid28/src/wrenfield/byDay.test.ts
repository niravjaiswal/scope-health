/**
 * Month-range aggregates over the one-burst request cap (AGG_MAX_REQ = 17) read one day at a time under the request governor
 * (apptList.readSeq0 → readByDay with `exactOnly`): a Set 1 day list under 100 rows ends on its EXACT count, so every day proves
 * itself and no "about N" footer is accepted anywhere in the read. On a simulated site with the fitted request bucket (bucketSim.ts):
 *   - run s3a item 130 (Front Range, December 2026, "about 425" scheduled): 31 days of 10-20 rows → by day, exact, 0 busy pages,
 *     every row, within the task budget; item 195 (Lakeside, "about 625"): the same at ~20 a day;
 *   - a month with one day of 100+ rows (its footer "about 125") fails — the estimate is refused inside the by-day read;
 *   - a range whose paced cost does not fit the task budget declines from the first page (no day is loaded);
 *   - a single-day range over the cap is not split (nothing smaller to read); a range the site serves in one burst (≤ 17 requests)
 *     is read as before (the whole-list path, untouched).
 *   npx tsx src/wrenfield/byDay.test.ts
 */
import { ApptList } from "./apptList.js";
import { BucketSim, fill, type R } from "./bucketSim.js";
import { resetBudget, budgetStats } from "./siteBudget.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? pass++ : fail++; if (!c) console.log("FAIL " + m); };
process.env.AGG_MAX_REQ = "17";

const addDay = (iso: string) => new Date(Date.parse(iso + "T00:00:00Z") + 86400000).toISOString().slice(0, 10);
/** `perDay(d)` rows at one location for every day of [from, to] (0 on the weekend when `weekends` is false) */
const month = (loc: string, from: string, to: string, perDay: (i: number) => number, status = "Scheduled"): R[] => {
  const rows: R[] = []; let i = 0;
  for (let d = from; d <= to; d = addDay(d), i++) { const dow = new Date(d + "T00:00:00Z").getUTCDay(); const n = dow === 0 || dow === 6 ? 0 : perDay(i); rows.push(...fill(loc, n, d).map((r) => ({ ...r, status }))); }
  return rows;
};
const WINDOW = { from: "2026-11-30", to: "2027-01-01" }; // the engine pads a month by a day either side
const run = async (site: BucketSim, budgetMs: number, status: "Scheduled" | "Completed" = "Scheduled", location = "Front Range") => {
  resetBudget(); const al = new ApptList(site.crawler()); al.begin(budgetMs, { endEstimate: true });
  const t0 = Date.now(); const out = await al.read({ ...WINDOW, status, location }); return { out, ms: Date.now() - t0, al };
};

{ // s3a 130: Front Range, December 2026, ~425 scheduled rows (10-20 a weekday) → by day, exact
  const rows = month("Front Range", WINDOW.from, WINDOW.to, (i) => 10 + (i % 11));
  const site = new BucketSim(rows); const { out, ms, al } = await run(site, 60000);
  ok("rows" in out && out.rows.length === rows.length, `425-row month by day: every row read (${"rows" in out ? out.rows.length : out.fail}; ${site.loads} loads + ${site.presses} presses, ${site.busyPages} busy, max lat ${site.maxLat}, waited ${budgetStats().sleptMs} ms, ${ms} ms)`);
  ok(site.busyPages === 0, "no busy page under the governor");
  ok(al.lastStats?.via === "by-day-exact", `via by-day-exact: ${al.lastStats?.via}`);
  ok(ms < 60000, `fits the 60 s task budget (${ms} ms)`);
  ok(site.loads >= 34 && site.loads <= 37, `one load per day of the padded window + the form page (${site.loads})`);
  console.log(`  425-row month by day: ${site.loads} loads + ${site.presses} presses, waited ${budgetStats().sleptMs} ms in ${budgetStats().waits} waits, ${ms} ms`);
}
{ // s3a 195: Lakeside, ~625 rows (≈20 a weekday: one press on most days) = 33 loads + ~27 presses ≈ 60 paced requests: projected ~44 s,
  // within the 60 s task budget → read by day, exact
  const rows = month("Lakeside", WINDOW.from, WINDOW.to, (i) => 17 + (i % 9));
  const site = new BucketSim(rows); const { out, ms, al } = await run(site, 60000, "Scheduled", "Lakeside");
  ok("rows" in out && out.rows.length === rows.length && site.busyPages === 0 && ms < 60000 && al.lastStats?.via === "by-day-exact", `625-row month at a 60 s budget: every row read (${"rows" in out ? out.rows.length : out.fail}; ${site.loads} loads + ${site.presses} presses, ${site.busyPages} busy, max lat ${site.maxLat}, ${ms} ms)`);
  console.log(`  625-row month by day at 60 s: ${site.loads} loads + ${site.presses} presses, waited ${budgetStats().sleptMs} ms, ${ms} ms`);
}
{ // s3a 115 / 165 (~1,000-1,100 rows): 33 loads + ~50-55 presses ≈ 85 paced requests ≈ 63 s projected → declined up front (60 s budget; also the 50 s by-day cap)
  const rows = month("Lakeside", WINDOW.from, WINDOW.to, (i) => 40 + (i % 7), "Completed");
  const site = new BucketSim(rows); const { out, ms } = await run(site, 60000, "Completed", "Lakeside");
  ok("fail" in out && /by day: 33 day loads \+ ~\d\d presses need ~\d\d s \(paced\), over the (?:task budget|50 s by-day cap)/.test(out.fail) && site.loads === 2 && ms < 3000, `~1,000-row month at a 60 s budget: declined up front by the paced projection (${site.loads} loads, ${ms} ms): ${JSON.stringify(out).slice(0, 220)}`);
}
{ // a day of 100+ rows ends on "about 125": refused inside the by-day read → the month fails (no estimate anywhere)
  const rows = month("Front Range", WINDOW.from, WINDOW.to, (i) => (i === 10 ? 120 : 12));
  const site = new BucketSim(rows); const { out } = await run(site, 60000);
  ok("fail" in out && /by day: 2026-12-1\d: /.test(out.fail) && /estimate|about/.test(out.fail), `a 120-row day fails the month: ${JSON.stringify(out).slice(0, 200)}`);
}
{ // the paced cost does not fit: declined from the first page, no day loaded
  const rows = month("Front Range", WINDOW.from, WINDOW.to, () => 15);
  const site = new BucketSim(rows); const { out, ms } = await run(site, 8000);
  ok("fail" in out && /by day: 33 day loads .* over the task budget/.test(out.fail), `too little budget (8 s): declined up front: ${JSON.stringify(out).slice(0, 200)}`);
  ok(site.loads === 2 && ms < 3000, `only the form page and the first page were loaded (${site.loads} loads, ${ms} ms)`);
}
{ // a single day over the cap is not split
  const rows = fill("Front Range", 420, "2026-12-15").map((r) => ({ ...r, status: "Scheduled" }));
  const site = new BucketSim(rows); resetBudget(); const al = new ApptList(site.crawler()); al.begin(60000, { endEstimate: true });
  const out = await al.read({ from: "2026-12-15", to: "2026-12-15", status: "Scheduled", location: "Front Range" });
  ok("fail" in out && /over the 17/.test(out.fail) && !/by day/.test(out.fail) && site.loads === 2, `a 420-row day: the cap declines it, nothing smaller to read: ${JSON.stringify(out).slice(0, 160)}`);
}
{ // under the cap: the whole-list path as before (252 rows in 14 requests) — but s4 keeps s3's estimate rule OFF: a single day that
  // ends on "about 250" is never proven and has nothing smaller to read → declined (a multi-day range is re-read by day: test-aggregate 4b)
  const rows = fill("Riverbend", 252, "2026-07-27").map((r) => ({ ...r, status: "Completed" }));
  const site = new BucketSim(rows); resetBudget(); const al = new ApptList(site.crawler()); al.begin(60000, { endEstimate: true });
  const out = await al.read({ from: "2026-07-27", to: "2026-07-27", status: "Completed", location: "Riverbend" });
  ok("fail" in out && /never proves a list complete/.test(out.fail) && /a single day: nothing smaller to read/.test(out.fail) && site.busyPages === 0 && site.requests <= 16, `252 rows in one burst, estimate end refused (estimate rule OFF), no busy page (${site.requests} requests, ${site.busyPages} busy): ${JSON.stringify(out).slice(0, 200)}`);
}
{ // without the aggregate opt-in (a context read) the cap does not apply and nothing is split (unchanged)
  const rows = month("Front Range", WINDOW.from, WINDOW.to, () => 12);
  const site = new BucketSim(rows); resetBudget(); const al = new ApptList(site.crawler()); al.begin(60000);
  const out = await al.read({ ...WINDOW, status: "Scheduled", location: "Front Range", sealed: true });
  ok("fail" in out && !/by day/.test(out.fail) || "rows" in out, `a sealed (context) read is not the aggregate path: ${JSON.stringify(out).slice(0, 120)}`);
}

console.log(`byDay: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
