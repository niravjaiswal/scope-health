/**
 * THE patient resolver. Every family that names a patient (lab triage, filing deadline, good-faith
 * estimate, tetanus, claim next step, phone/invoice/referral lookups, the generalist) goes through
 * resolvePatient — live via index-builder's ensurePatient / LiveIndex.resolvePatient, which call this.
 *
 *  - DOB given: the date-of-birth search (every patient with that DOB, all locations, no paging); the
 *    one row carrying every word of the name. Unchanged from the 158 run.
 *  - Name only: the sorted, sound-alike last-name search read across pages until the list is past the
 *    name (nameResolve.ts); exactly one row with the name, else decline. "Last, First" searches on Last;
 *    a compound surname is also tried whole; a 2-letter surname the search ignores is retried padded.
 *    A namesake with any badge makes the name ambiguous; a lone restricted / deleted / test match is a
 *    decline (restricted charts are never opened). Merged-away rows are dropped by the row parser (they
 *    open the surviving chart), the same rule the DOB path has always used.
 *
 * Pure apart from the `PatientSearch` it is handed, so it is unit-tested on simulated paged lists
 * (test-patientResolve.ts).
 */
import * as NR from "./nameResolve.js";
import { cacheMode, cacheGet, cachePut } from "./readCache.js";
import { mayBreakGlass, breakGlassPolicy } from "./glassPolicy.js";

export type FoundRow = { name: string; href: string; mrn?: string; dob?: string; sex?: string; flags?: string[] };
/** The two searches the clinic's patient page offers (Crawler implements both). */
export interface PatientSearch {
  searchByDob(dobISO: string): Promise<FoundRow[]>;
  searchPatientsPaged(lastName: string, isPast: (rowName: string) => boolean): Promise<{ rows: FoundRow[]; complete: boolean; pages: number }>;
}
export type PatientResolution = {
  chosen: FoundRow | null;
  /** why it declined (empty when chosen) */
  why: string;
  via: "dob" | "name";
  /** every row read, rows carrying the name, extra pages read, terms searched (diagnostics) */
  results: number; matches: number; pages: number; terms: string[];
  /** name-only: the charts of the rows carrying the name (contextResolve narrows several to one) */
  matchHrefs?: string[];
};

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[.,]/g, "").replace(/\s+/g, " ").trim();
const parts = (s: string) => new Set(norm(s.replace(",", " ")).split(" ").filter(Boolean));

/**
 * AGENT_CACHE: the two searches with their proven-complete, non-empty results remembered for the shift (readCache.ts "patients").
 * A DOB list is the same list for every name on it. A last-name list is read only as far as the asked name; it serves another
 * name only when its LAST row is already past that name (the stop rule of the live walk), so it never answers from a list that
 * stops short of the name. Off (default): the search itself.
 */
function cachedSearch(s: PatientSearch): PatientSearch {
  if (cacheMode() === "off") return s;
  return {
    async searchByDob(dob) {
      const hit = cacheGet<FoundRow[]>("patients", `dob:${dob}`); if (hit) return hit.v;
      const t = Date.now(); const rows = await s.searchByDob(dob);
      if (rows.length) cachePut("patients", `dob:${dob}`, rows, Date.now() - t);
      return rows;
    },
    async searchPatientsPaged(term, isPast) {
      const key = `last:${term.trim().toLowerCase()}`; // not accent-folded: "García" and "Garcia" are two searches until the site is shown to answer them alike
      const hit = cacheGet<{ rows: FoundRow[] }>("patients", key, (v) => v.rows.length > 0 && isPast(v.rows[v.rows.length - 1].name));
      if (hit) return { rows: hit.v.rows, complete: true, pages: 1 };
      const t = Date.now(); const r = await s.searchPatientsPaged(term, isPast);
      if (r.complete && r.rows.length) cachePut("patients", key, { rows: r.rows }, Date.now() - t);
      return r;
    },
  };
}

export async function resolvePatient(live: PatientSearch, name: string, dob?: string): Promise<PatientResolution> {
  const search = cachedSearch(live);
  if (dob) {
    // DOB path — byte-for-byte the 158 rule: every DOB result shares the DOB, so match on the name's words.
    let results: FoundRow[];
    try { results = await search.searchByDob(dob); } catch { return { chosen: null, why: "DOB search failed", via: "dob", results: 0, matches: 0, pages: 1, terms: [] }; }
    const want = parts(name);
    const matches = results.filter((r) => { const rp = parts(r.name.replace(/,/g, " ")); return [...want].every((p) => rp.has(p)); });
    const chosen = matches.length === 1 ? matches[0] : (matches.find((m) => m.dob === dob) ?? null);
    if (chosen && (chosen.flags ?? []).some((f) => /^restricted$/i.test(f)) && !mayBreakGlass("dob"))
      return { chosen: null, why: `the ${name} record is restricted and AGENT_BREAK_GLASS=${breakGlassPolicy()} (chart not opened)`, via: "dob", results: results.length, matches: matches.length, pages: 1, terms: [] };
    return { chosen, why: chosen ? "" : matches.length ? `${matches.length} patients named ${name} born ${dob}` : `no patient named ${name} born ${dob}`, via: "dob", results: results.length, matches: matches.length, pages: 1, terms: [] };
  }
  // Name only.
  const terms = NR.searchTerms(name);
  let complete = terms.length > 0; const rowsAll: FoundRow[] = []; let pages = 1; const tried: string[] = [];
  for (const term of terms) {
    let r: { rows: FoundRow[]; complete: boolean; pages: number } | null = null;
    for (const t of [term, ...NR.shortTermAlternates(term)]) {
      tried.push(t);
      try { r = await search.searchPatientsPaged(t, (rowName) => NR.sortsAfter(rowName, name, term)); }
      catch { r = null; break; }
      if (r.rows.length) break;                               // a short surname listed nothing → padded retry
    }
    if (!r) { complete = false; continue; }
    rowsAll.push(...r.rows); pages += r.pages - 1; if (!r.complete) complete = false;
    if (complete && NR.resolveByName(rowsAll, name, true, mayBreakGlass("name")).chosen) break; // settled under this term; others only widen the net
  }
  const matches = rowsAll.filter((r) => NR.rowMatches(r.name, name)).length;
  const res = NR.resolveByName(rowsAll, name, complete, mayBreakGlass("name"));
  const chosen = res.chosen ? (rowsAll.find((r) => r.href === res.chosen!.href) ?? null) : null;
  const matchHrefs = [...new Set(rowsAll.filter((r) => NR.rowMatches(r.name, name)).map((r) => r.href))];
  return { chosen, why: res.chosen ? "" : res.why, via: "name", results: rowsAll.length, matches, pages, terms: tried, matchHrefs };
}
