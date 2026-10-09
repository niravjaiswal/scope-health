/**
 * Message-driven new-vs-established parameters. The governing message states the window, the
 * statuses that count, the services that never count and whether the provider / specialty match;
 * this reads them from the message instead of applying built-in defaults. Any part that cannot be
 * read unambiguously, or a worked window example that our window arithmetic does not reproduce,
 * returns { params: null, why } → the compiler records the workflow as uncompiled → tasks decline.
 */
export type NEParams = { windowYears: number; excluded: string[]; statuses: string[]; matchProvider: boolean; matchSpecialty: boolean };

const NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const toNum = (s: string) => (/^\d+$/.test(s) ? Number(s) : NUM[s.toLowerCase()] ?? NaN);
const KNOWN_STATUSES = ["Completed", "Scheduled", "Cancelled", "Canceled", "Late cancel", "No-show", "Checked in", "Checked out", "Arrived", "In progress", "Rescheduled"];
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Window [start, end] for a visit, as the evaluator in run.ts computes it. */
export function neWindow(visitISO: string, years: number): [string, string] {
  const [vy, vm, vd] = visitISO.split("-").map(Number);
  const feb29 = vm === 2 && vd === 29;
  const s = new Date(Date.UTC(vy - years, vm - 1, feb29 ? 28 : vd) + 86400000).toISOString().slice(0, 10);
  const e = new Date(Date.UTC(vy, vm - 1, vd) - 86400000).toISOString().slice(0, 10);
  return [s, e];
}

function splitList(s: string): string[] {
  return s.replace(/\.\s*$/, "").split(/,\s*(?:and\s+|or\s+)?|\s+and\s+|\s+or\s+/).map((x) => x.trim().replace(/^(?:a|an|the)\s+/i, "")).filter(Boolean);
}

export function parseNEMessage(raw: string): { params: NEParams | null; why: string } {
  const fail = (why: string) => ({ params: null, why });
  const t = raw.replace(/\r/g, "");
  // ── window years: every "N years/N-year" stated must agree
  const yrs = new Set<number>();
  for (const m of t.matchAll(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)[- ]years?\b/gi)) { const n = toNum(m[1]); if (n) yrs.add(n); }
  if (yrs.size !== 1) return fail(`window years: ${yrs.size ? [...yrs].join("/") : "none"} stated`);
  const windowYears = [...yrs][0];
  if (windowYears < 1 || windowYears > 10) return fail("window years out of range");
  // ── services that never count
  const ex = t.match(/(?:services?|visit types?|appointment types?)[^:\n]{0,80}\b(?:never|do not|don't|does not|doesn't|cannot|can't)\b[^:\n]{0,60}:\s*([^\n]+)/i);
  if (!ex) return fail("excluded-services list not found");
  const excluded = splitList(ex[1]);
  if (excluded.length < 1 || excluded.some((s) => s.split(" ").length > 4)) return fail("excluded-services list unreadable");
  // ── statuses that count: "Its status is Completed" / "status is Completed or Checked out"
  const st = t.match(/\bstatus (?:is|must be|was|of)\s+([A-Z][A-Za-z -]*?(?:(?:,\s*|\s+or\s+)[A-Z][A-Za-z -]*?)*)\s*[.;\n]/);
  if (!st) return fail("counting status not stated");
  const statuses = splitList(st[1]);
  if (!statuses.length || statuses.some((s) => !KNOWN_STATUSES.some((k) => norm(k) === norm(s)))) return fail("counting status unknown: " + st[1]);
  // A sentence listing statuses that do NOT count must not overlap the counting ones.
  const notc = t.match(/([A-Z][^.\n]*?)\s+appointments? do(?:es)? not count/);
  if (notc) for (const s of statuses) if (new RegExp(`\\b${s.replace(/[-]/g, "\\-")}\\b`, "i").test(notc[1])) return fail("status both counts and does not: " + s);
  // ── provider / specialty matching
  const matchProvider = /\bsame provider\b/i.test(t);
  const matchSpecialty = /\b(?:same|that) specialty\b/i.test(t);
  if (!matchProvider) return fail("same-provider rule not stated");
  if (/\bnot\b[^.\n]{0,30}\bsame specialty\b|\bspecialty (?:does not|doesn't) matter\b/i.test(t)) return fail("specialty rule worded unexpectedly");
  // ── boundary rules we implement: visit date and later never count; Feb 29 → Feb 28
  if (/\bon the visit date\b[^.\n]{0,30}\b(?:count|counts)\b(?![^.\n]*\bnot\b)/i.test(t) && !/on the visit date or after it do not count/i.test(t)) return fail("visit-date boundary differs");
  const leap = t.match(/February 29[^.\n]*?earlier is (February 28|March 1)/i);
  if (leap && !/February 28/i.test(leap[1])) return fail("Feb 29 rule differs");
  // ── a stated window example must reproduce
  for (const m of t.matchAll(/visit on (\d{4}-\d{2}-\d{2})[^.\n]{0,40}?window is (\d{4}-\d{2}-\d{2}) (?:through|to|until|-|–) (\d{4}-\d{2}-\d{2})/gi)) {
    const [s, e] = neWindow(m[1], windowYears);
    if (s !== m[2] || e !== m[3]) return fail(`window example ${m[1]} → ${m[2]}..${m[3]}, computed ${s}..${e}`);
  }
  // ── answer format: NEW / ESTABLISHED:<date> (what the evaluator outputs)
  if (!/`NEW`/.test(t) || !/`ESTABLISHED:/.test(t)) return fail("answer tokens differ from NEW / ESTABLISHED:<date>");
  if (!/most recent/i.test(t)) return fail("which date to give is not 'the most recent'");
  return { params: { windowYears, excluded, statuses: statuses.map(norm), matchProvider, matchSpecialty }, why: "" };
}
