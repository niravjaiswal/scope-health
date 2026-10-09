import { listFooter, isComplete, type ListFooter } from "./listFooter.js";
/**
 * Name-only patient resolution, pure (no browser): which last-name search term(s) to use, when a paged
 * result list has been read far enough to see every namesake, and whether exactly one row is the
 * patient. Driven by patientResolve.ts (the one resolver every family uses) for tasks that name a
 * patient without a DOB.
 *
 * The clinic's patient search lists "sorted by last name, then first name" (a sound-alike search: a
 * "Wells" search also lists "Wallace"), 20-25 rows a page. A name-only task is answerable only when
 * the WHOLE relevant part of that list has been read and exactly one row carries the name — so
 * namesakes on a later page can't be missed (the 158 run read page 1 only: 10 lab tasks skipped).
 */

/** Lower-case, accents folded, apostrophes/periods dropped ("O'Brien" → "obrien", "Noëlle" → "noelle"). */
export const fold = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/['’`.]/g, "");
/** Name tokens in any order: "Last, First" and "First Last" give the same set. */
export const nameTokens = (s: string) => fold(s).split(/[\s,\-]+/).filter(Boolean);
const letters = (s: string) => fold(s).replace(/[^a-z]/g, "");

/** The (first, last) split of a task's name: "Last, First Middle" or "First Middle Last". */
export function splitName(name: string): { first: string; last: string } | null {
  const n = name.trim().replace(/\s+/g, " ");
  if (!n) return null;
  if (n.includes(",")) { const [l, ...f] = n.split(","); const first = f.join(" ").trim(), last = l.trim(); return first && last ? { first, last } : null; }
  const t = n.split(" "); if (t.length < 2) return null;
  return { first: t.slice(0, -1).join(" "), last: t[t.length - 1] };
}

/** Last-name search terms to try. "Last, First" → Last. "First Last" → Last; with 3+ words also every
 *  word after the first (a compound surname: "Maria De la Cruz", "Ana García López"). A middle initial
 *  ("Mary A. Turner") is a given name, never part of a surname. */
export function searchTerms(name: string): string[] {
  const n = name.trim().replace(/\s+/g, " ");
  if (n.includes(",")) { const l = n.split(",")[0].trim(); return l ? [l] : []; }
  const t = n.split(" "); if (t.length < 2) return [];
  const out = [t[t.length - 1]];
  if (t.length >= 3 && letters(t[1]).length >= 2) out.push(t.slice(1).join(" "));
  return out;
}

/** A row is a candidate when every full word (2+ letters) of the asked name is in the row's name (the 158
 *  rule: a middle name on the chart still matches; two such rows → ambiguous → skip). A middle INITIAL in
 *  the ask ("Mary A. Turner") never narrows the field on its own: it matches a row whose extra words
 *  include one starting with that letter, or a row with no extra words (the chart may carry no middle
 *  name). An initial-only first name ("J. Rivera") is not a name. */
export function rowMatches(rowName: string, asked: string): boolean {
  const want = nameTokens(asked), full = want.filter((w) => w.length >= 2), inits = want.filter((w) => w.length === 1);
  if (full.length < 2) return false;
  const have = nameTokens(rowName), hs = new Set(have);
  if (!full.every((w) => hs.has(w))) return false;
  const extra = have.filter((t) => !full.includes(t));
  return inits.every((i) => extra.length === 0 || extra.some((t) => t.startsWith(i)));
}

/** Sort key of a "Last, First" row as the list sorts it (letters only, accents folded). */
export function rowKey(rowName: string): [string, string] | null {
  const i = rowName.indexOf(","); if (i < 0) return null;
  return [letters(rowName.slice(0, i)), letters(rowName.slice(i + 1))];
}

/** The asked name split around the surname that was searched: with `term` ("De la Cruz") the surname is
 *  the term and the given names are the words before it; otherwise splitName's split. */
export function splitFor(asked: string, term?: string): { first: string; last: string } | null {
  const s = splitName(asked); if (!s || !term) return s;
  const n = asked.trim().replace(/\s+/g, " ");
  if (n.includes(",")) return s;
  const words = n.split(" "), tw = term.trim().split(/\s+/);
  const tail = words.slice(-tw.length);
  if (tw.length < words.length && tail.map(letters).join(" ") === tw.map(letters).join(" ")) return { first: words.slice(0, -tw.length).join(" "), last: tail.join(" ") };
  return s;
}

/** True when `rowName` sorts strictly after every row that could be the asked patient — i.e. the list,
 *  sorted by last then first name, has been read past every namesake. A row whose order can't be
 *  placed (no comma) never proves anything. `term` is the surname that was searched (a compound-surname
 *  search compares against that surname, not the last word). The first-name bound is the FIRST given
 *  name only: "Turner, Mary Ann" and "Turner, Mary" are both candidates for "Mary A. Turner". */
export function sortsAfter(rowName: string, asked: string, term?: string): boolean {
  const k = rowKey(rowName), s = splitFor(asked, term); if (!k || !s) return false;
  const [rl, rf] = k, tl = letters(s.last), tf = letters(s.first.trim().split(/\s+/)[0] ?? "");
  if (!tl || !tf) return false;
  // A different last name proves the end only when it sorts after the asked one and neither is a prefix
  // of the other: whether "Martin, Zoe" sorts before or after "Martinez, Adam" depends on the collation.
  if (rl !== tl) return rl > tl && !rl.startsWith(tl) && !tl.startsWith(rl);
  // same last name: past once the first name sorts after the asked first name and isn't an extension
  // of it ("Ana" → "Ana Maria" rows would still be candidates).
  return rf > tf && !rf.startsWith(tf);
}

/** The clinic's last-name search lists nothing for a 2-letter surname ("Li": 0 rows in the 151 and 158
 *  runs, although a sound-alike "Lee" and a prefix "Lindqvist" are on file — the term itself was not
 *  searched). A short surname is retried padded to 3 letters with a vowel the sound-alike match ignores
 *  ("Li" → "Lie", same sound code L000). The rows it lists are still checked against the exact name and
 *  the list must still be read past it, so the padding can only find the patient, never pick another. */
export function shortTermAlternates(term: string): string[] {
  const t = term.trim(), n = letters(t);
  if (!n || n.length >= 3 || /\s/.test(t)) return [];
  return [t + "e".repeat(3 - n.length)];
}

/** "Showing a to b of N" / "of N+" / "of about N" footer of a paged list (listFooter's grammar; a Show-more
 *  "Showing N of M" counts as rows 1..N). Count-only and "Page x of y" footers carry no range → undefined. */
export type PageRange = { a: number; b: number; total: number; plus: boolean; approx: boolean; footer: ListFooter };
export function pageRange(footer: string): PageRange | undefined {
  const f = listFooter(footer); if (!f || f.none || f.end || f.page !== undefined) return undefined;
  return { a: f.from, b: f.to, total: f.total, plus: f.kind === "plus", approx: f.kind === "approx", footer: f };
}
/** How a newly shown page relates to the last one read: the next page ("next"), the list started over at
 *  row 1 ("restart": the app reloaded — the practice session expires a few seconds after a page load and
 *  the reload drops the pager and the page size), or anything else ("gap": a skipped or repeated range).
 *  Without footers on both pages nothing is proven ("unknown"). */
export function pageStep(prev: PageRange | undefined, cur: PageRange | undefined): "next" | "restart" | "gap" | "unknown" {
  if (!prev || !cur) return "unknown";
  if (cur.a === prev.b + 1 && cur.b >= cur.a) return "next";
  if (cur.a === 1) return "restart";
  return "gap";
}
/** The list is read to its end: the range reaches an EXACT total. An "N+" total never proves the end
 *  (practice caps lists at 300 / 500 rows, then shows an empty page or starts over), and neither does an
 *  estimate: Set 1 (run 146) shows "about 600 patients" and stops at 160 rows with "No more results." — a
 *  "Showing 41 to 55 of about 50" page would otherwise pass as the end with namesakes still unread. */
export function rangeEnded(r: PageRange | undefined): boolean { return !!r && isComplete(r.b, r.footer).complete; }

export interface Row { name: string; href: string; dob?: string; flags?: string[] }
export type Resolution = { chosen: Row } | { chosen: null; why: string };
/** Decide from the rows read and whether the read is complete for this name. Namesakes count whatever
 *  their badge (a deleted or restricted namesake still makes the name ambiguous). A single match that is
 *  a restricted chart (never opened by a name-only resolution), a deleted record or a test record is a
 *  decline, not an answer. */
export function resolveByName(rows: Row[], asked: string, complete: boolean, allowRestricted = false): Resolution {
  const seen = new Set<string>(); const m: Row[] = [];
  for (const r of rows) if (rowMatches(r.name, asked) && !seen.has(r.href)) { seen.add(r.href); m.push(r); }
  if (m.length > 1) return { chosen: null, why: `${m.length} patients named ${asked}` };
  if (!complete) return { chosen: null, why: `search list not read past ${asked} (more pages)` };
  if (!m.length) return { chosen: null, why: `no patient named ${asked}` };
  // allowRestricted: only under AGENT_BREAK_GLASS=always (glassPolicy.ts); deleted / test records never.
  const bad = (m[0].flags ?? []).find((f) => (allowRestricted ? /^(deleted|test record)$/i : /^(restricted|deleted|test record)$/i).test(f));
  if (bad) return { chosen: null, why: `the only ${asked} record is ${bad.toLowerCase()}${/restricted/i.test(bad) ? " (chart not opened)" : ""}` };
  return { chosen: m[0] };
}
