/**
 * Log-only watch on how hard the agent leans on the clinic product, and whether the product pushes back.
 * Run 265 lost 271 s and its last 25 tasks to "This account is suspended … Wrenfield is not responding" (twice), after 29
 * "Wrenfield is busy" lists; the trigger was never isolated because no log said how many requests preceded it. Every document /
 * XHR / fetch request of every tab is counted here (crawl.ts `wire`), and a suspended page seen at a marker miss opens an
 * episode (closed by the next page that arrives). Changes no behaviour; summarised in the `site_watch` event at the end of the shift.
 */
const reqs: number[] = [];
const episodes: Array<{ atS: number; durS?: number; req10s: number; req60s: number; reqTotal: number }> = [];
const t0 = Date.now();
let open: (typeof episodes)[number] | null = null, openAt = 0, total = 0, peak10 = 0, peak60 = 0;
const inWindow = (now: number, w: number) => { let n = 0; for (let i = reqs.length - 1; i >= 0 && now - reqs[i] <= w; i--) n++; return n; };

export function noteRequest(now = Date.now()) {
  total++; reqs.push(now); if (reqs.length > 20000) reqs.splice(0, 10000);
  const a = inWindow(now, 10_000), b = inWindow(now, 60_000); if (a > peak10) peak10 = a; if (b > peak60) peak60 = b;
}
export const isSuspendedText = (t: string) => /\baccount is suspended\b/i.test(t) || /\bWrenfield is not responding\b/i.test(t);
/** A marker never arrived and the page says what it says: open an episode (once) when it is the suspended page. */
export function noteMiss(pageText: string, action: string, now = Date.now()) {
  if (open || !isSuspendedText(pageText)) return;
  open = { atS: Math.round((now - t0) / 1000), req10s: inWindow(now, 10_000), req60s: inWindow(now, 60_000), reqTotal: total }; openAt = now; episodes.push(open);
  try { process.stdout.write(JSON.stringify({ event: "site_state", state: "suspended", action: action.slice(0, 60), ...open }) + "\n"); } catch {}
}
/** A page arrived on its marker: the product answers again. */
export function noteArrived(now = Date.now()) {
  if (!open) return;
  open.durS = Math.round((now - openAt) / 1000);
  try { process.stdout.write(JSON.stringify({ event: "site_state", state: "ok", downS: open.durS }) + "\n"); } catch {}
  open = null;
}
export const siteWatchSummary = () => ({ event: "site_watch", reqTotal: total, peak10s: peak10, peak60s: peak60, episodes: episodes.map((e) => ({ ...e })), stillSuspended: !!open });
export function siteWatchReset() { reqs.length = 0; episodes.length = 0; open = null; total = peak10 = peak60 = 0; }
