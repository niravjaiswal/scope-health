/**
 * The site's list-request budget, and a governor that keeps every list read inside it.
 *
 * What run s3a's log shows (fixtures/set1/run-s3a-set1.log, every `aggregate-read` line carries `lat` = ms per Show-more
 * press; 33 busy pages, all in the six name-only visit-day context reads, none in an aggregate read):
 *  - from a quiet start a list request answers in ~80 ms; after ~10 requests in a row the latency climbs ~65 ms per
 *    request (77, 84, 99 … 181, 294, 379, 472 … 568, 623, 681) and the request after ~700 ms is answered with the
 *    degraded "Wrenfield is busy, so this list shows fewer rows than usual" page (max latency of a served page: 716);
 *  - a pause brings it down at ~90 ms per second (a busy page, 1.5 s + 2 requests → 568; 3 s + 2 requests → 427);
 *  - so the account's budget is ~20 list requests, refilled at ~1.4 a second; at a steady 1 request per 0.72 s nothing
 *    is refused. Chart pages, searches by DOB and document opens are not seen in this ramp.
 * The aggregate lever AGG_MAX_REQ (17) was fitted to the same wall for ONE burst; this governor tracks the budget
 * itself: every list request counts one, the count refills with time, and a measured latency above the flat zone
 * corrects the count upward (the site's own word). Before a request that would land above AGENT_LIST_PACE_MS
 * (400: ~5 requests of headroom) the caller waits for the refill. A busy page still fails the read (LESSONS §B:
 * busy = stop for that read); it also puts the count at the wall so the next list request anywhere waits ~3.3 s.
 *
 * AGENT_LIST_PACE_MS=0 turns the governor off (the s3a behaviour).
 */
const num = (k: string, d: number) => { const v = Number(process.env[k]); return Number.isFinite(v) ? v : d; };
/** ms of latency a request adds past the flat zone */
export const SLOPE_MS = 65;
/** ms of latency a second of quiet takes away */
export const DECAY_MS_PER_S = num("AGENT_LIST_DECAY_MS", 90);
/** latency at which the next request is answered "busy" */
export const BUSY_AT_MS = 700;
/** latency of a request while the budget is still in its flat zone, and the requests that zone holds */
export const BASE_MS = 80, FLAT_REQUESTS = 10;
/** requests the budget refills per second (= the latency decay in requests) */
export const REFILL_PER_S = DECAY_MS_PER_S / SLOPE_MS;
const target = () => num("AGENT_LIST_PACE_MS", 400);
const latOf = (used: number) => BASE_MS + SLOPE_MS * Math.max(0, used - FLAT_REQUESTS);
const usedAt = (lat: number) => FLAT_REQUESTS + Math.max(0, lat - BASE_MS) / SLOPE_MS;
const WALL_USED = usedAt(BUSY_AT_MS) + 1;

let used = 0, at = 0, slept = 0, waits = 0, noted = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const usedNow = (now: number) => Math.max(0, used - (REFILL_PER_S * Math.max(0, now - at)) / 1000);

/** The latency the next list request would see now. */
export function predictedLat(now = Date.now()): number { return used === 0 ? 0 : Math.min(BUSY_AT_MS, latOf(usedNow(now))); }
/** The requests the budget holds right now (the governor's own count, corrected by what the site answered). */
export function usedRequests(now = Date.now()): number { return usedNow(now); }
/** A list request answered in `ms` (press → settled, or load → settled): one more request; a latency past the flat zone says how
 *  many the site really counts (chart pages and other requests it never saw). */
export function noteLat(ms: number, now = Date.now()) {
  if (!Number.isFinite(ms) || ms < 0) return;
  let u = usedNow(now) + 1;
  if (ms > BASE_MS + 15) u = Math.max(u, usedAt(Math.min(BUSY_AT_MS, ms)));
  used = Math.min(WALL_USED, u); at = now; noted++;
}
/** A page LOAD answered in `ms` (navigation → arrival): a load carries ~90 ms more than a press at the same budget (run s3a: single-page
 *  reads 165-181 ms in the quiet state against 77-84 ms presses), so that much is discounted before it is noted. */
export const LOAD_EXTRA_MS = 90;
export function noteLoad(ms: number, now = Date.now()) { noteLat(Math.max(0, ms - LOAD_EXTRA_MS), now); }
/** A busy / degraded page: the budget is at the wall. */
export function noteBusyPage(now = Date.now()) { used = WALL_USED; at = now; }
/** Wait until the predicted latency is at or under the target (never past `deadline` − 300 ms). Returns the ms waited. */
export async function paceList(deadline = Infinity, now = Date.now()): Promise<number> {
  const t = target(); if (!(t > 0)) return 0;
  const u = usedNow(now); if (latOf(u + 1) <= t) return 0;
  let ms = Math.ceil(((u + 1 - usedAt(t)) / REFILL_PER_S) * 1000);
  if (Number.isFinite(deadline)) ms = Math.min(ms, Math.max(0, deadline - now - 300));
  if (ms <= 0) return 0;
  waits++; slept += ms;
  await sleep(ms);
  return ms;
}
/** ms the governor would wait for `n` back-to-back requests from the state now (for a read's own budget projection). */
export function projectedWaitMs(n: number, now = Date.now()): number {
  const t = target(); if (!(t > 0) || n <= 0) return 0;
  let u = usedNow(now), wait = 0;
  for (let i = 0; i < n; i++) {
    if (latOf(u + 1) > t) { wait += ((u + 1 - usedAt(t)) / REFILL_PER_S) * 1000; u = usedAt(t) - 1; }
    u += 1;
  }
  return Math.round(wait);
}
export function budgetStats() { return { lat: Math.round(predictedLat()), used: +usedNow(Date.now()).toFixed(1), waits, sleptMs: slept, noted }; }
/** Test hook. */
export function resetBudget() { used = 0; at = 0; slept = 0; waits = 0; noted = 0; }
