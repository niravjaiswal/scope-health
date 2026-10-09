/**
 * Per-shift cache of PAGE READS (patient-search rows, context lists, payer terms). Never an answer.
 *
 * AGENT_CACHE=off (default: every call is a no-op) | shadow (puts, counts the hits it WOULD have served and the
 * seconds they would have saved, serves nothing, changes nothing) | on (serves hits, applies invalidations).
 *
 * Domains and what ends an entry:
 *  - patients: last-name / DOB search rows. Static data; ended by a message about registrations / merges.
 *  - payers:   contract / filing / plan pages (the modules holding their own maps register `onDrop`). Ended by a message
 *              about a payer's terms ("This is in Wrenfield now: …", "… isn't in Wrenfield yet").
 *  - lists:    the visit-day / lab-by-date context lists. TTL 5 min, ended AND held off for 5 min by a message that says
 *              appointments or documents are changing ("some appointments will be cancelled in the next few minutes").
 *  - invoices: nothing is cached (balances are read live, every time); listed so its message is recognised, not "unknown".
 * A short message that announces a change but names no known topic ends every domain (unknown live data: forget all).
 * A key is the read's own parameters (URL template + filters), a value is only stored from a read that PROVED itself complete.
 */
import { fontMemoStats } from "./fontDecode.js";
export type Domain = "patients" | "payers" | "lists" | "invoices";
type Entry = { v: unknown; ms: number; at: number };

const TTL_MS: Record<Domain, number> = { patients: Infinity, payers: Infinity, lists: 300_000, invoices: 0 };
const HOLD_MS = 300_000;
const store = new Map<string, Entry>();
const heldUntil = new Map<Domain, number>();
const dropFns = new Map<Domain, Array<() => void>>();
const stat = { hits: {} as Record<string, number>, misses: {} as Record<string, number>, savedMs: {} as Record<string, number>, drops: [] as string[] };

export const cacheMode = (): "off" | "shadow" | "on" => { const m = (process.env.AGENT_CACHE ?? "off").toLowerCase(); return m === "on" || m === "shadow" ? m : "off"; };
const inc = (o: Record<string, number>, k: string, n = 1) => { o[k] = (o[k] ?? 0) + n; };

/** A cached read for (domain, key) that `ok(value)` accepts, or undefined. Shadow mode counts the would-be hit (and logs it) and returns undefined. */
export function cacheGet<T>(domain: Domain, key: string, ok: (v: T) => boolean = () => true, now = Date.now()): { v: T } | undefined {
  const mode = cacheMode(); if (mode === "off") return undefined;
  const e = store.get(`${domain}:${key}`);
  if (!e || now - e.at > TTL_MS[domain] || now < (heldUntil.get(domain) ?? 0) || !ok(e.v as T)) { inc(stat.misses, domain); return undefined; }
  inc(stat.hits, domain); inc(stat.savedMs, domain, Math.round(e.ms));
  try { process.stdout.write(JSON.stringify({ event: mode === "on" ? "cache_hit" : "cache_would_hit", domain, key: key.slice(0, 60), savedMs: Math.round(e.ms) }) + "\n"); } catch {}
  return mode === "on" ? { v: e.v as T } : undefined;
}
/** Remember a read that proved itself complete; `ms` is what it cost (credited to every later hit). */
export function cachePut(domain: Domain, key: string, v: unknown, ms: number, now = Date.now()) {
  if (cacheMode() === "off" || now < (heldUntil.get(domain) ?? 0)) return;
  store.set(`${domain}:${key}`, { v, ms, at: now });
}
/** A module that keeps its own per-shift map of a domain registers how to empty it. */
export function onDrop(domain: Domain, fn: () => void) { const l = dropFns.get(domain) ?? []; l.push(fn); dropFns.set(domain, l); }

const CUE = /\b(now|soon|shortly|yet|next (few )?(minutes?|hours?)|in a (few )?(minutes?|moments?)|working through|(is|are) (posting|being)|will be)\b/i;
const TOPIC: Array<[Domain, RegExp]> = [
  ["payers", /\b(payers?|contracts?|plans?|appeals?|accepts|filing (limit|window))\b|in wrenfield (now|yet)/i],
  ["patients", /\b(regist\w+|merg\w+|duplicates?|new patients?|transfer\w*|patient records?)\b/i],
  ["lists", /\b(appointments?|schedule|cancel\w*|resched\w*|book\w*|visits?|documents?|lab reports?|scan\w*|upload\w*)\b/i],
  ["invoices", /\b(payments?|invoices?|balances?|ledger|posting|refunds?)\b/i],
];
/** Domains a short live-data message touches ([] for noise and for long workflow messages). Pure. */
export function liveEffects(text: string): Domain[] {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length > 320 || !CUE.test(t)) return [];
  const hit = TOPIC.filter(([, re]) => re.test(t)).map(([d]) => d);
  return hit.length ? hit : ["patients", "payers", "lists", "invoices"];
}
/** Call for every message item. Returns the domains it ended (also logged as one `cache` event). */
export function cacheNoteMessage(text: string, now = Date.now()): Domain[] {
  const mode = cacheMode(); if (mode === "off") return [];
  const ds = liveEffects(text); if (!ds.length) return [];
  if (mode === "on") for (const d of ds) {
    for (const k of [...store.keys()]) if (k.startsWith(d + ":")) store.delete(k);
    for (const f of dropFns.get(d) ?? []) f();
    if (d === "lists") heldUntil.set(d, now + HOLD_MS);
  }
  stat.drops.push(ds.join("+"));
  try { process.stdout.write(JSON.stringify({ event: "cache", msg: text.slice(0, 80), ends: ds, applied: mode === "on" }) + "\n"); } catch {}
  return ds;
}
export const cacheSummary = () => ({ event: "cache_summary", mode: cacheMode(), ...stat, entries: store.size, fontMemo: { ...fontMemoStats } });
export function cacheReset() { store.clear(); heldUntil.clear(); stat.hits = {}; stat.misses = {}; stat.savedMs = {}; stat.drops = []; } // keeps the onDrop registrations (made once, at import)

