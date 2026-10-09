/**
 * The site's list-request budget and the governor (siteBudget.ts):
 *   1. the model's arithmetic (prediction, decay, the wait before a request, the projected wait of a long read);
 *   2. run s3a's own log: every one of its 33 busy pages came right after a measured press latency at the wall
 *      (≥ 550 ms, or the previous list's last press was), i.e. the governor would have waited before each one;
 *   3. a simulated Wrenfield day list (ctxLists.test's markup) with a request bucket fitted to that log: the whole-day
 *      context read of six locations (~36 requests) meets busy pages with the governor off (the s3a behaviour) and
 *      none with it on — also on a site that refills slower than the model assumes (the measurement corrects the wait);
 *   4. the patient search walk: a degraded (busy) results page is never kept; the walk starts again after the wait.
 *   npx tsx src/wrenfield/siteBudget.test.ts
 */
import { readFileSync } from "node:fs";
import { ApptList } from "./apptList.js";
import { BucketSim, LOCS, fill } from "./bucketSim.js";
import { apptDayContext } from "./contextResolve.js";
import { predictedLat, noteLat, noteBusyPage, paceList, projectedWaitMs, resetBudget, budgetStats, DECAY_MS_PER_S, SLOPE_MS, BUSY_AT_MS } from "./siteBudget.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? pass++ : fail++; if (!c) console.log("FAIL " + m); };

// ── 1. arithmetic ──
{
  resetBudget();
  const t0 = 1_000_000;
  ok(predictedLat(t0) === 0, "quiet start: nothing predicted");
  noteLat(680, t0);
  ok(predictedLat(t0) === 680, "a measured latency is the prediction now");
  ok(Math.round(predictedLat(t0 + 2000)) === 680 - 2 * DECAY_MS_PER_S, "decays at DECAY_MS_PER_S");
  ok(predictedLat(t0 + 60_000) <= 80, "fully refilled after a minute (the flat zone's latency)");
  const w = projectedWaitMs(1, t0);
  ok(Math.round(w) === Math.round(((680 + SLOPE_MS - 400) / DECAY_MS_PER_S) * 1000), `one request from 680 lands at 745 and waits (745-400)/decay s: ${w}`);
  ok(projectedWaitMs(10, t0 + 60_000) === 0, "ten requests from a quiet start wait nothing (inside the burst)");
  const w30 = projectedWaitMs(30, t0 + 60_000);
  // from 0: the first (400/65 ≈ 6) requests are free, each later one waits 65/90 s
  // from quiet: 10 flat + (400-80)/65 ≈ 5 ramp requests are free, each later one waits 65/90 s → ~15 × 0.72 s
  ok(w30 > 9_000 && w30 < 13_000, `thirty requests from quiet wait ~11 s: ${w30}`);
  noteBusyPage(t0);
  ok(predictedLat(t0) === BUSY_AT_MS, "a busy page puts the prediction at the wall");
  noteBusyPage(); // (the real clock from here: paceList sleeps for real)
  const tw = Date.now(); const slept = await paceList(Infinity);
  // the wall is ~20.5 requests; the next request may go once ~14 are left: (21.5 − 14.9) / 1.385 ≈ 4.8 s (run s3a: 3-4.5 s pauses + 2 requests came back at 427-568 ms)
  ok(slept >= 4300 && slept <= 5300 && Date.now() - tw >= slept - 50, `after a busy page the next request waits ~4.8 s (${slept} ms)`);
  resetBudget(); noteLat(500);
  const capped = await paceList(Date.now() + 400);
  ok(capped <= 150, `the wait never runs past the deadline: ${capped} ms`);
  process.env.AGENT_LIST_PACE_MS = "0"; noteLat(690); ok((await paceList()) === 0, "AGENT_LIST_PACE_MS=0: off"); delete process.env.AGENT_LIST_PACE_MS;
  resetBudget();
}

// ── 2. run s3a: busy pages sit on the wall ──
{
  const lines = readFileSync(new URL("../../fixtures/set1/run-s3a-set1.log", import.meta.url), "utf8").split("\n").filter((l) => l.startsWith('{"event":"aggregate-read"')).map((l) => JSON.parse(l));
  let busyN = 0, onWall = 0, prevLast = 0; const low: string[] = [];
  for (const r of lines) {
    const lat: number[] = r.lat ?? [];
    if (r.busy) {
      busyN++;
      const before = lat.length ? lat[lat.length - 1] : prevLast; // busy at press 1: the previous list's last press
      if (before >= 550) onWall++; else low.push(`${r.filter?.location} ${before}`);
    }
    if (lat.length) prevLast = lat[lat.length - 1];
    else if (r.ok && r.ms && r.pages === 1) prevLast = Math.max(0, r.ms - 80); // a single-page read: its load time
    if (r.ok === false && !r.busy && r.ms === 0) continue; // declined without a request
  }
  ok(busyN === 33, `s3a: 33 busy pages in the log (${busyN})`);
  ok(onWall === busyN, `every busy page followed a latency ≥ 550 ms (${onWall}/${busyN}${low.length ? ": " + low.join(", ") : ""})`);
  const served = lines.flatMap((r) => (r.lat ?? []) as number[]);
  ok(Math.max(...served) < BUSY_AT_MS + 20, `no served press slower than the wall (${Math.max(...served)} ms)`);
  // the ramp: in every ok read with ≥ 3 presses the latencies are non-decreasing, i.e. one monotone budget, not noise
  const ramps = lines.filter((r) => r.ok && (r.lat?.length ?? 0) >= 3);
  const mono = ramps.filter((r) => r.lat.every((v: number, i: number) => i === 0 || v >= r.lat[i - 1] - 15)).length;
  ok(mono === ramps.length, `press latencies ramp monotonically within a read (${mono}/${ramps.length})`);
}

// ── 3. simulated list with a request bucket (bucketSim.ts) ──
const DAY_ = "2026-01-02";
const fillDay = (loc: string, n: number, who: Array<[string, string]> = []) => fill(loc, n, DAY_, who);
const DAY = "2026-01-02";
const sizes: Record<string, number> = { Northgate: 112, "Front Range": 89, Eastside: 97, Stonebrook: 130, Lakeside: 101, Riverbend: 60 };
const mkDay = (refill = 1.4) => new BucketSim(LOCS.flatMap((l) => fillDay(l, sizes[l], l === "Riverbend" ? [["Wells, Harold", "w1"]] : [])), refill);
const total = Object.values(sizes).reduce((a, b) => a + b, 0);
{ // governor off: the s3a behaviour — a list is answered busy once the requests outrun the refill (the real reader issued ~3 a second
  // against a refill of 1.4; this jsdom reader manages ~2.7 a second, so the site here refills at 0.7 to keep the same ratio)
  process.env.AGENT_LIST_PACE_MS = "0"; resetBudget();
  const site = mkDay(0.7); const al = new ApptList(site.crawler()); al.begin(60000);
  const t0 = Date.now(); const out = await apptDayContext(al as any, DAY, 60000);
  ok(site.busyPages >= 1, `governor off: the day read meets busy pages (${site.busyPages} busy of ${site.requests} requests, max lat ${site.maxLat}, ${Date.now() - t0} ms): ${JSON.stringify(out).slice(0, 100)}`);
  ok(site.requests >= 18, "busy came after the ~20-request burst");
  delete process.env.AGENT_LIST_PACE_MS;
}
for (const [refill, nm] of [[1.4, "fitted refill 1.4/s"], [1.0, "slower site: refill 1.0/s"], [0.7, "half the fitted refill: 0.7/s"]] as Array<[number, string]>) { // governor on: no busy page, every location read
  resetBudget();
  const site = mkDay(refill); const al = new ApptList(site.crawler()); al.begin(90000);
  const t0 = Date.now(); const out = await apptDayContext(al as any, DAY, 90000); const ms = Date.now() - t0;
  ok("rows" in out && out.rows.length === total, `governor on (${nm}): all ${total} rows read (${site.requests} requests, ${site.busyPages} busy, max lat ${site.maxLat} ms, waited ${budgetStats().sleptMs} ms in ${budgetStats().waits} waits, ${ms} ms): ${JSON.stringify(out).slice(0, 100)}`);
  ok(site.busyPages === 0, `governor on (${nm}): 0 busy pages`);
  ok(site.maxLat < BUSY_AT_MS - 100, `governor on (${nm}): the site never got near the wall (max ${site.maxLat})`);
  ok(ms < 60000, `governor on (${nm}): the read fits a 60 s budget (${ms} ms)`);
  if ("rows" in out) ok(out.rows.some((r) => r.href === "/patients/w1"), "the patient at the last location is on the rows");
}
{ // a busy page met anyway (the bucket is at the wall when the read starts: another read just drained it): the sealed read's retry waits and succeeds
  resetBudget();
  const site = mkDay(); site.used = 19; site.usedAt = Date.now(); noteLat(80); // the governor does not know (a chart-page burst it never saw)
  const al = new ApptList(site.crawler()); al.begin(60000);
  const r = await al.read({ from: DAY, to: DAY, status: "any", location: "Stonebrook", sealed: true });
  ok("rows" in r && r.rows.length === 130, `a busy page the governor did not foresee: the retry waits for the budget and reads the list (${site.busyPages} busy, waited ${budgetStats().sleptMs} ms): ${JSON.stringify(r).slice(0, 100)}`);
  ok(site.busyPages >= 1 && site.busyPages <= 2, `at most two busy pages before the wait pays off (${site.busyPages})`);
}

// ── 4. the patient search walk: a busy results page ──
{
  // (the crawl.ts walk needs a Crawler; its busy rule is the same one: pagerState.busy → noteBusyPage, fresh attempt after paceList, rows never kept)
  const txt = readFileSync(new URL("./crawl.ts", import.meta.url), "utf8");
  ok(/busy:\/\\\\bis busy\\\\b\|fewer rows than usual/.test(txt) && /if \(st\.busy\) \{ noteBusyPage\(\); busyHit = true;/.test(txt), "crawl.searchPatientsPaged detects the degraded results page and restarts the walk after the governor's wait");
}

console.log(`siteBudget: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
