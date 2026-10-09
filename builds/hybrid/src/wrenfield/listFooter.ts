/**
 * ONE list-footer grammar and ONE completeness rule for every list the agent walks.
 *
 * Why one: the agent carried five footer grammars (pageSnapshot.pagerOf, contextResolve.docFooter, apptList.rangeOf,
 * nameResolve.pageRange, operate.pagerOf) plus two more (immunizations.pageInfo, crawl.fetchAppointments). Two of them
 * read "Showing 476 to 500 of 500+ invoices" as an EXACT total of 500 and the walks built on them called a capped list
 * complete (GENERALIZATION-AUDIT.md §5.1). An absence answer ("no self-pay note", "no closure", "0") after such a read
 * is a wrong answer. Every reader now parses with `listFooter` and decides with `isComplete`.
 *
 * Grammar (`listFooter`): what a footer phrase states about the list's size.
 *   "Showing 1 to 25 of 98 entries"        paged, exact total                        kind "exact"
 *   "Showing 476 to 500 of 500+ invoices"  paged, lower bound (the site caps counts)  kind "plus"
 *   "Showing 1 to 25 of about 500 …"       paged, estimate                           kind "approx"
 *   "Showing 15 of 148 appointments"       Show-more list, 15 loaded of an exact 148  cumulative
 *   "Showing 20 of about 1,000 …"          Show-more list, estimate                  cumulative, kind "approx"
 *   "8 notes" / "0 notes"                  the whole list's own count, nothing paged  end
 *   "about 250 appointments"               a finished Show-more list's estimate      end, kind "approx" (to = -1)
 *   "500+ invoices"                        a count that is only a lower bound        end, kind "plus"   (to = -1)
 *   "Page 2 of 7"                          page numbers only (no row count)          page / pages
 *   "No appointments match" / "No notes"   an empty list                             none
 *   "No more results"                      NOT a footer: the empty page past a cap (callers pass it as `empty`)
 *
 * Rule (`isComplete`): a read is complete only when
 *   (a) an EXACT total is stated and reached: the range ends at it, the rows read equal it, nothing more is offered; or
 *   (b) an exact count with no range ("8 notes") equals the rows read, nothing more offered; or
 *   (c) the pager's own page count is reached ("Page 7 of 7"), nothing more offered; or
 *   (d) the list says it is empty and no rows were read.
 *   A "+" (lower bound) or "about" (estimate) total NEVER proves the end — practice caps lists at 300 / 500 rows and then
 *   shows an empty "No more results" page or just takes the control away; Set 1 shows "about 600 patients" and stops at
 *   160 rows (run 146). Nor does a disabled Next on its own: with no exact count there is nothing to reach. A walk that
 *   stops on such a footer is CUT (`capped: true`), and the caller may re-read it in smaller exact pieces (apptList reads
 *   the range day by day) or decline — never answer an absence from it.
 *
 * The grammar is plain JS (LIST_FOOTER_JS): the in-page OPERATE_LIB (operate.pagerOf) runs the very function the
 * TypeScript readers run (`listFooter` below is built from the same source), so the two hosts cannot drift apart.
 *
 * TODO(ListWalker): extract one list walker from apptList (settle on filter values + two agreeing reads, table by
 * header labels, Rows-per-page raise, Next / Show-more / link pagers, range continuity a = prev b + 1, restart on the
 * app's session reload (≤ 2 fresh loads of the same URL), the filter re-check on every row) and crawl.searchPatientsPaged
 * (the same restart rule, `past()` early stop) so that patient search, the Documents context, the notes / calendar /
 * payer walks (familyReaders.allPages) and immunizationsLive.readAllPages become thin callers: each supplies the route,
 * the header synonyms, the pager noun and a row parser, and gets settle + continuity + `isComplete` + restart for free.
 * Plan: `listWalker.ts` with `walk(c, {url, headers, noun, parseRow, filter?, deadline})` → `{rows, verdict: Completeness,
 * pages, restarted}`; apptList.readOnce and searchPatientsPaged move first (their tests — test-aggregate's SimSite and
 * test-patientResolve — already cover restart, cap, dup-page and page-size cases), then allPages and labDocContext.
 */

export type FooterKind = "exact" | "plus" | "approx";
export type ListFooter = {
  /** Row range on the page (1-based); `to = -1` when the footer states a count but not how many rows are shown. */
  from: number; to: number;
  /** The stated total; its meaning is `kind`. -1 for a "Page x of y" footer. */
  total: number; kind: FooterKind;
  /** A Show-more list ("Showing N of M"): rows are appended, `to` is the rows loaded so far. */
  cumulative: boolean;
  /** The list's own count with no range ("8 notes", "about 250 appointments"). */
  end: boolean;
  /** "No appointments match": an empty list. */
  none: boolean;
  /** The noun after the total ("notes", "invoices"), lower-cased; "" when absent. */
  noun: string;
  /** "Page x of y" footers only. */
  page?: number; pages?: number;
  /** The footer line the statement was read from. */
  text: string;
};

/** The grammar, as browser-side JS (also run by the TS `listFooter` below). `listFooter(text, nounRe?)`: the first
 *  line of `text` that states a list size (and whose noun matches `nounRe`, a RegExp, when given — a footer without a
 *  noun always passes). Null when nothing does. */
export const LIST_FOOTER_JS = String.raw`
function listFooter(text, nounRe){
  var lines=String(text==null?'':text).split(/\n/);
  var num=function(s){ return Number(String(s).replace(/,/g,'')); };
  var kindOf=function(ap,plus){ return plus?'plus':(ap?'approx':'exact'); };
  var nounOk=function(n){ return !nounRe||!n||nounRe.test(n); };
  for(var i=0;i<lines.length;i++){
    var t=lines[i].replace(/\s+/g,' ').trim(); if(!t) continue;
    var m, f=null;
    // paged: "Showing a to b of N" (also "a–b of N" without "Showing": a pager's own range)
    m=t.match(/(?:^|[^\w.,:$])(?:showing\s+)?([\d,]+)\s*(?:to|-|–|—|through)\s*([\d,]+)\s+of\s+(?:(about|approx\.?|approximately|around|roughly|~)\s*)?([\d,]+)(?:\s*(\+))?(?:\s+([a-z][a-z-]*))?/i);
    if(m) f={from:num(m[1]),to:num(m[2]),total:num(m[4]),kind:kindOf(m[3],m[5]),cumulative:false,end:false,none:false,noun:(m[6]||'').toLowerCase(),text:t};
    // Show-more list: "Showing N of M" — N rows loaded so far
    if(!f){ m=t.match(/\bshowing\s+([\d,]+)\s+of\s+(?:(about|approx\.?|approximately|around|roughly|~)\s*)?([\d,]+)(?:\s*(\+))?(?:\s+([a-z][a-z-]*))?/i);
      if(m) f={from:num(m[1])?1:0,to:num(m[1]),total:num(m[3]),kind:kindOf(m[2],m[4]),cumulative:true,end:false,none:false,noun:(m[5]||'').toLowerCase(),text:t}; }
    // page numbers only: "Page 2 of 7"
    if(!f){ m=t.match(/\bpage\s+([\d,]+)\s+of\s+([\d,]+)\b/i);
      if(m) f={from:-1,to:-1,total:-1,kind:'exact',cumulative:false,end:false,none:false,noun:'',page:num(m[1]),pages:num(m[2]),text:t}; }
    // the list's own count, the whole line: "8 notes", "about 250 appointments", "500+ invoices"
    if(!f){ m=t.match(/^(?:(about|approx\.?|approximately|around|roughly|~)\s*)?([\d,]+)(?:\s*(\+))?\s+([a-z][a-z-]*)\b/i);
      if(m){ var n=num(m[2]); var k=kindOf(m[1],m[3]); f={from:n?1:0,to:k==='exact'?n:-1,total:n,kind:k,cumulative:k!=='exact',end:true,none:false,noun:m[4].toLowerCase(),text:t}; } }
    // an empty list: "No appointments match …", "No notes", "Nothing recorded" — never "No more results" (a cut list)
    if(!f&&/^(no\s+[a-z]|nothing\s+(recorded|on file|found|to show|listed))/i.test(t)&&!/^no\s+more\b/i.test(t)){
      m=t.match(/^no\s+([a-z][a-z-]*)/i); f={from:0,to:0,total:0,kind:'exact',cumulative:false,end:true,none:true,noun:m?m[1].toLowerCase():'',text:t}; }
    if(f&&nounOk(f.noun)) return f;
  }
  return null;
}`;

// eslint-disable-next-line no-new-func
const impl = new Function("text", "nounRe", `${LIST_FOOTER_JS}\nreturn listFooter(text, nounRe);`) as (text: string, nounRe?: RegExp) => ListFooter | null;
/** Parse a footer phrase, a pager line or a whole page text (first matching line). */
export function listFooter(text: string | null | undefined, nounRe?: RegExp): ListFooter | null { return impl(text ?? "", nounRe); }

/** What the page offers after the rows: its Next / Show more controls, and whether it is the empty "No more results"
 *  page past a cap. Unknown controls may be left out (treated as not offered). */
export type NextState = { next?: "enabled" | "disabled" | "none"; more?: "enabled" | "disabled" | "none"; empty?: boolean };
export type Completeness =
  | { complete: true; proof: "exact-total" | "exact-count" | "last-page" | "empty" | "sealed-end" }
  | { complete: false; why: string; capped: boolean };

/** Is a list read complete? `rowsRead`: every row read so far (all pages). See the rule in the header. */
export function isComplete(rowsRead: number, f: ListFooter | null | undefined, st: NextState = {}): Completeness {
  const no = (why: string, capped = false): Completeness => ({ complete: false, why, capped });
  if (st.empty) return no('an empty "No more results" page: the list was cut, not ended', true);
  if (!f) return no("no footer states the list's size");
  if (f.none) return rowsRead === 0 ? { complete: true, proof: "empty" } : no(`${rowsRead} rows under an empty-list footer "${f.text}"`);
  if (f.kind === "plus") return no(`the total is a lower bound ("${f.text}"): the end is never stated`, true);
  if (f.kind === "approx") return no(`the total is an estimate ("${f.text}"): the end is never proven`, true);
  if (st.next === "enabled" || st.more === "enabled") return no(`the list still offers more ("${f.text}")`);
  if (f.page !== undefined) return f.page >= (f.pages ?? 0) ? { complete: true, proof: "last-page" } : no(`page ${f.page} of ${f.pages}`);
  const to = f.to < 0 ? rowsRead : f.to;
  if (to < f.total) return no(`${to} of ${f.total} shown ("${f.text}")`);
  if (to > f.total) return no(`the range ends past the total ("${f.text}")`);
  if (rowsRead !== f.total) return no(`${rowsRead} rows read for a total of ${f.total} ("${f.text}")`);
  return { complete: true, proof: f.end ? "exact-count" : "exact-total" };
}

/** CONTEXT READS ONLY (contextResolve: a day's appointment list per location, one day's lab reports) — never the generic
 *  rule above. Set 1 shows "about N" (N a multiple of 25) for every filtered list of 100+ rows, so a day at ONE location
 *  ("about 125 appointments") or a day's lab reports ("about 100 documents") can never state an exact total, and the
 *  exact-total rule declined all of them (run 278: 11 name-only visit/lab tasks). What the site does show:
 *    - a list the site CUT (300-row cap) keeps the cumulative form "Showing 300 of about 1,000 appointments" and loses
 *      its Show more control — never the bare form;
 *    - a list that was loaded to its end switches to the BARE form "about 250 appointments" (no "Showing") and loses
 *      the control (run 164: Cedar Hollow, 12 presses, 252 rows read, "about 250");
 *    - the patient search's empty "No more results" page also shows a bare "about N patients": `st.empty` excludes it.
 *  So the end is sealed by all of: the bare estimate form, nothing more offered, no "No more results", at least one row,
 *  and the rows read within the estimate's own rounding of it (approxTol; a list that stopped short of its estimate is
 *  not sealed). Callers use it only where a wrong "complete" can at worst skip or pick a patient the exact-name rule
 *  still checks (pickByContext: exactly one chart carries the name on the whole list). */
export function endSealed(rowsRead: number, f: ListFooter | null | undefined, st: NextState = {}): Completeness {
  const no = (why: string): Completeness => ({ complete: false, why, capped: true });
  if (st.empty) return no('an empty "No more results" page: the list was cut, not ended');
  if (!f || !f.end || f.none || f.page !== undefined || f.kind !== "approx") return no("not the bare end footer of a finished list");
  if (st.next === "enabled" || st.more === "enabled") return no(`the list still offers more ("${f.text}")`);
  if (rowsRead < 1 || f.total < 1) return no("no rows read");
  if (Math.abs(rowsRead - f.total) > approxTol(f.total)) return no(`${rowsRead} rows read, far from "${f.text}"`);
  return { complete: true, proof: "sealed-end" };
}

/** How many rows a "+" or "about" footer's walk may still owe when the caller projects work — never a proof. */
export const approxTol = (total: number) => Math.max(25, Math.ceil(total * 0.05));
