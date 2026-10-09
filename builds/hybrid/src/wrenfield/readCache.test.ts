/**
 * The per-shift read cache (readCache.ts): off is inert, shadow counts without serving, on serves and ends entries on the
 * Set 1 live-data messages; the patient-search wrapper never answers from a list that stops short of the asked name.
 *   npx tsx src/wrenfield/readCache.test.ts
 */
import { readFileSync } from "node:fs";
import { cacheGet, cachePut, cacheNoteMessage, cacheReset, cacheSummary, liveEffects, onDrop } from "./readCache.js";
import { resolvePatient } from "./patientResolve.js";
import type { FoundRow, PatientSearch } from "./patientResolve.js";
import { buildDigitMap, fontKinds, fontMemoStats } from "./fontDecode.js";
import { noteRequest, noteMiss, noteArrived, isSuspendedText, siteWatchSummary, siteWatchReset } from "./siteWatch.js";

let pass = 0, fail = 0;
const eq = (got: unknown, want: unknown, label: string) => { const g = JSON.stringify(got), w = JSON.stringify(want); if (g === w) { pass++; console.log("✓ " + label); } else { fail++; console.error(`✗ ${label}\n    got  ${g}\n    want ${w}`); } };
const mode = (m: string) => { process.env.AGENT_CACHE = m; cacheReset(); };
const quiet = process.stdout.write.bind(process.stdout);
const silently = <T>(f: () => T): T => { process.stdout.write = (() => true) as any; try { return f(); } finally { process.stdout.write = quiet as any; } };

console.log("── modes ──");
mode("off"); cachePut("patients", "k", 1, 100); eq(cacheGet("patients", "k"), undefined, "off: nothing stored, nothing served");
mode("shadow"); cachePut("patients", "k", 1, 100); eq(silently(() => cacheGet("patients", "k")), undefined, "shadow: not served");
eq([cacheSummary().hits, cacheSummary().savedMs], [{ patients: 1 }, { patients: 100 }], "shadow: the would-be hit and its seconds are counted");
mode("on"); cachePut("patients", "k", 1, 100); eq(silently(() => cacheGet("patients", "k")), { v: 1 }, "on: served");
eq(silently(() => cacheGet("patients", "k", (v: number) => v > 1)), undefined, "on: a value the caller rejects is a miss");

console.log("── lists: TTL, message ends and holds off ──");
mode("on"); cachePut("lists", "visit:2026-01-02", "rows", 5000, 1_000);
eq(silently(() => cacheGet("lists", "visit:2026-01-02", () => true, 100_000)), { v: "rows" }, "lists: served inside the TTL");
eq(silently(() => cacheGet("lists", "visit:2026-01-02", () => true, 1_000 + 300_001)), undefined, "lists: gone after 5 min");
cachePut("lists", "a", 1, 10, 1_000); cachePut("patients", "p", 2, 10, 1_000);
eq(silently(() => cacheNoteMessage("We're working through today's cancellation requests at the front desk, so some appointments on the schedule will be cancelled in the next few minutes.", 2_000)), ["lists"], "n=44 ends the lists domain");
eq(silently(() => cacheGet("lists", "a", () => true, 3_000)), undefined, "lists dropped by the message");
cachePut("lists", "b", 1, 10, 3_000); eq(silently(() => cacheGet("lists", "b", () => true, 3_100)), undefined, "lists held off after the message (no put, no hit)");
cachePut("lists", "c", 1, 10, 2_000 + 300_000 + 1); eq(silently(() => cacheGet("lists", "c", () => true, 2_000 + 300_000 + 2)), { v: 1 }, "lists usable again after the hold-off");
eq(silently(() => cacheGet("patients", "p", () => true, 4_000)), { v: 2 }, "patients untouched by an appointments message");

console.log("── payers: onDrop and the Northfield pair ──");
mode("on"); let dropped = 0; onDrop("payers", () => { dropped++; });
eq(silently(() => cacheNoteMessage("Northfield Life and Health accepts appeals within 180 days of the remittance date. This isn't in Wrenfield yet. Go by this note until it is.")), ["payers"], "n=132 ends payers");
eq(silently(() => cacheNoteMessage("This is in Wrenfield now: Northfield Life and Health accepts appeals within 180 days of the remittance date.")), ["payers"], "n=164 ends payers");
eq(dropped, 2, "the modules' own payer maps are emptied each time");
mode("shadow"); dropped = 0; silently(() => cacheNoteMessage("This is in Wrenfield now: Northfield Life and Health accepts appeals within 180 days of the remittance date."));
eq(dropped, 0, "shadow: the live maps are not touched");

console.log("── every Set 1 message ──");
const items = readFileSync(new URL("../../fixtures/set1-items.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const by: Record<string, number[]> = {};
for (const m of items.filter((x) => x.kind === "message")) (by[liveEffects(m.text).join("+") || "none"] ??= []).push(m.n);
eq(by, { none: [1, 5, 16, 30, 62, 76, 96, 118, 120, 150, 198, 212], lists: [44], payers: [132, 164], invoices: [176] }, "only 44 (lists), 132 / 164 (payers) and 176 (invoices) are live data; workflows and noise end nothing");
eq(liveEffects("Reception is updating something right now."), ["patients", "payers", "lists", "invoices"], "a change announcement with no known topic ends everything");
eq(liveEffects("The front desk is registering walk-ins now, so new patients will appear in the list."), ["patients"], "registrations end the patient rows");

console.log("── patient search rows, through the one resolver ──");
const row = (name: string, dob = "2000-01-01"): FoundRow => ({ name, href: "/patients/" + name.replace(/\W/g, ""), dob });
const SORTED = ["Wells, Alan", "Wells, Harold", "Wells, Matthew", "Wells, Zed"].map((n) => row(n));
let calls = { dob: 0, last: 0 };
const fake = (rows: FoundRow[], complete = true): PatientSearch => ({
  async searchByDob() { calls.dob++; return rows; },
  async searchPatientsPaged(_t, isPast) { calls.last++; const out: FoundRow[] = []; for (const r of rows) { out.push(r); if (isPast(r.name)) return { rows: out, complete: true, pages: 3 }; } return { rows: out, complete, pages: 5 }; },
});
const chosen = async (s: PatientSearch, name: string, dob?: string) => (await silently(() => resolvePatient(s, name, dob))).chosen?.name ?? null;
mode("off"); calls = { dob: 0, last: 0 };
{ const s = fake(SORTED); await chosen(s, "Matthew Wells"); await chosen(s, "Matthew Wells"); }
eq(calls.last, 2, "off: every search is live");
mode("on"); calls = { dob: 0, last: 0 };
{
  const s = fake(SORTED);
  const a = await chosen(s, "Matthew Wells");     // reads to Zed (the first row past Matthew)
  const b = await chosen(s, "Harold Wells");      // Harold sorts before the last row read -> served from the first read
  const c = await chosen(s, "Zed Wells");         // the last row read (Zed) is not past Zed -> a live read
  eq([calls.last, a, b, c], [2, "Wells, Matthew", "Wells, Harold", "Wells, Zed"], "a last-name list serves a name only when its last row is already past that name");
}
mode("on"); calls = { dob: 0, last: 0 };
{
  const e = fake([]);
  await chosen(e, "Ann Nobody", "1980-01-01"); await chosen(e, "Ann Nobody", "1980-01-01"); await chosen(e, "Ann Nobody"); await chosen(e, "Ann Nobody");
  eq([calls.dob, calls.last], [2, 2], "an empty result is never kept (a failed read must not poison the next task)");
  calls = { dob: 0, last: 0 }; const t = fake(SORTED, false);
  await chosen(t, "Zoe Wells"); await chosen(t, "Zoe Wells");
  eq(calls.last, 2, "an incomplete list (the name sorts past its end) is never kept");
  calls = { dob: 0, last: 0 }; const u = fake(SORTED.map((r) => row(r.name, "1980-01-01")));
  const d1 = await chosen(u, "Alan Wells", "1980-01-01"); const d2 = await chosen(u, "Harold Wells", "1980-01-01");
  eq([calls.dob, d1, d2], [1, "Wells, Alan", "Wells, Harold"], "a DOB list is read once and serves every name on it");
  silently(() => cacheNoteMessage("The front desk is registering walk-ins now, so new patients will appear in the list."));
  await chosen(u, "Alan Wells", "1980-01-01");
  eq(calls.dob, 2, "a registration message ends the remembered rows");
}

console.log("── font memo (pure speed-up: same maps, same kinds) ──");
{
  const num = readFileSync(new URL("../../bench/set1-replica/fonts/num.woff", import.meta.url)), scr = readFileSync(new URL("../../bench/set1-replica/fonts/scr.woff", import.meta.url));
  const junk = Buffer.from("not a font");
  process.env.AGENT_FONT_MEMO = "off";
  const t0 = Date.now(); const m0 = buildDigitMap([num, scr, junk]), k0 = fontKinds([num, scr, junk]); const coldMs = Date.now() - t0;
  eq(k0, { identity: 1, scrambled: 1 }, "reference kinds: one identity, one scrambled, junk ignored");
  process.env.AGENT_FONT_MEMO = "verify";
  const m1 = buildDigitMap([num, scr, junk]), k1 = fontKinds([num, scr, junk]);
  const m2 = buildDigitMap([scr, num]), k2 = fontKinds([scr]);   // second pass: every font is a (verified) hit
  eq([m1, k1, m2, k2], [m0, k0, m0, { identity: 0, scrambled: 1 }], "verify mode: remembered rasters equal fresh parses, maps and kinds unchanged");
  process.env.AGENT_FONT_MEMO = "on";
  const t1 = Date.now(); const m3 = buildDigitMap([num, scr, junk]); const warmMs = Date.now() - t1;
  eq(m3, m0, "on: same map"); eq(warmMs < Math.max(20, coldMs / 4), true, `on: a remembered page costs ${warmMs} ms against ${coldMs} ms cold`);
  eq(fontMemoStats.hits > 0 && fontMemoStats.misses === 3, true, "stats: 3 fonts parsed once, the rest hits");
  delete process.env.AGENT_FONT_MEMO;
}
console.log("── site watch (log only) ──");
{
  siteWatchReset();
  for (let i = 0; i < 30; i++) noteRequest(1_000 + i * 100);                      // 30 requests in 3 s
  noteMiss("Patients\nLast name", "goto /patients", 5_000);
  eq(siteWatchSummary().episodes.length, 0, "a marker miss on an ordinary page opens nothing");
  silently(() => noteMiss("Wrenfield\nThis account is suspended\n\nYou cannot use Wrenfield with this account at the moment.", "goto /patients", 5_000));
  noteMiss("Wrenfield\nThis account is suspended", "goto /patients", 6_000);
  silently(() => noteArrived(66_000));
  const s = siteWatchSummary();
  eq([s.reqTotal, s.peak10s, s.episodes.length, s.episodes[0].req10s, s.episodes[0].durS, s.stillSuspended], [30, 30, 1, 30, 61, false], "one episode: the requests before it, how long the product was down");
  eq(isSuspendedText("Wrenfield is not responding. Try again in a moment."), true, "the not-responding page counts as down");
}
mode("off");
console.log(fail ? `\n✗ readCache: ${pass} passed, ${fail} failed` : `\n✓ readCache: ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
