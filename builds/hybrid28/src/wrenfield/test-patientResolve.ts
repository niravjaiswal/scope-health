/** The one patient resolver (patientResolve.ts) on simulated paged searches, and a per-family check that
 *  every family reaches a patient through it.   npx tsx src/wrenfield/test-patientResolve.ts */
import { readFileSync, readdirSync } from "node:fs";
import { resolvePatient, type FoundRow, type PatientSearch } from "./patientResolve.js";
import { fold, pageRange, pageStep, rangeEnded } from "./nameResolve.js";
import { listFooter, isComplete } from "./listFooter.js";

let pass = 0, fail = 0;
const eq = (got: unknown, want: unknown, label: string) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log("✓ " + label); } else { fail++; console.error(`✗ ${label}\n    got  ${g}\n    want ${w}`); }
};

// ── a simulated clinic search: sound-alike (Soundex) last-name match, sorted by last then first name with
// accents folded, N rows a page, a pager that ends; a 2-letter term lists nothing (the "Li" behaviour) ──
const letters = (s: string) => fold(s).replace(/[^a-z]/g, "");
function soundex(s: string): string {
  const t = letters(s); if (!t) return "";
  const code: Record<string, string> = {}; for (const [d, cs] of Object.entries({ 1: "bfpv", 2: "cgjkqsxz", 3: "dt", 4: "l", 5: "mn", 6: "r" })) for (const c of cs) code[c] = d;
  let out = t[0].toUpperCase(), prev = code[t[0]] ?? "";
  for (const c of t.slice(1)) { const d = code[c] ?? ""; if (d && d !== prev) out += d; if (c !== "h" && c !== "w") prev = d; if (out.length === 4) break; }
  return out.padEnd(4, "0");
}
type P = { name: string; dob: string; flags?: string[] };
class SimSearch implements PatientSearch {
  calls: string[] = []; pagesRead = 0;
  private rows: FoundRow[];
  constructor(pts: P[], private size = 20, private maxPages = 15) {
    this.rows = pts.map((p, i) => ({ name: p.name, href: `/patients/${i}`, dob: p.dob, flags: p.flags ?? [] }))
      .sort((a, b) => { const [al, af] = a.name.split(","), [bl, bf] = b.name.split(","); return letters(al).localeCompare(letters(bl)) || letters(af).localeCompare(letters(bf)); });
  }
  async searchByDob(dob: string) { this.calls.push(`dob:${dob}`); return this.rows.filter((r) => r.dob === dob); }
  async searchPatientsPaged(term: string, isPast: (rowName: string) => boolean) {
    this.calls.push(`name:${term}`);
    const hits = letters(term).length < 3 ? [] : this.rows.filter((r) => soundex(r.name.split(",")[0]) === soundex(term));
    const got: FoundRow[] = []; let p = 0;
    for (; p * this.size < hits.length && p < this.maxPages; p++) {
      const page = hits.slice(p * this.size, (p + 1) * this.size); got.push(...page); this.pagesRead++;
      if (isPast(page[page.length - 1].name)) return { rows: got, complete: true, pages: p + 1 };
    }
    return { rows: got, complete: p * this.size >= hits.length && hits.length > 0, pages: Math.max(p, 1) };
  }
}
const firsts = ["Abigail", "Adam", "Ahmed", "Alexander", "Amanda", "Amy", "Andrew", "Angela", "Anthony", "Barbara", "Betty", "Brian", "Camila", "Carol", "Charles", "Christopher", "Daniel", "David", "Deborah", "Dennis", "Donald", "Donna", "Edward", "Elizabeth", "Emily", "Eric", "Frank", "Gary", "George", "Helen", "Jacob", "James", "Jason", "Jennifer", "Jessica", "John", "Joseph", "Karen", "Kenneth", "Laura", "Linda", "Lisa", "Mark", "Mary", "Matthew", "Michael", "Nancy", "Patricia", "Paul", "Rebecca", "Richard", "Robert", "Sandra", "Sarah", "Steven", "Susan", "Thomas", "Timothy", "William"];
const fam = (last: string, skip: string[] = []) => firsts.filter((f) => !skip.includes(f)).map((f, i) => ({ name: `${last}, ${f}`, dob: `19${50 + (i % 40)}-0${1 + (i % 9)}-1${i % 10}` }));
const pick = async (s: SimSearch, name: string, dob?: string) => { const r = await resolvePatient(s, name, dob); return r.chosen ? r.chosen.name : `SKIP: ${r.why}`; };

// unique match deep in the list
{
  const s = new SimSearch([...fam("Murphy"), { name: "Murphy, Teresa", dob: "1971-02-03" }, ...fam("Morphy").slice(0, 10)]);
  eq(await pick(s, "Teresa Murphy"), "Murphy, Teresa", "unique match on page 4 of a sound-alike list (Morphy/Murphy) → resolved");
  eq(s.pagesRead > 1, true, "…the list was paged, not read from page 1 only");
  eq(await pick(new SimSearch([...fam("Murphy"), { name: "Murphy, Teresa", dob: "1971-02-03" }], 20, 2), "Teresa Murphy"), "SKIP: search list not read past Teresa Murphy (more pages)", "page budget runs out before the name → skip");
}
// namesake on the next page
{
  const s = new SimSearch([...fam("Murphy"), { name: "Murphy, Christopher", dob: "1980-01-01" }], 17);
  eq(await pick(s, "Christopher Murphy"), "SKIP: 2 patients named Christopher Murphy", "namesake on the next page → skip");
  eq(await pick(new SimSearch([...fam("Murphy"), { name: "Murphy, Christopher", dob: "1980-01-01", flags: ["Deleted"] }]), "Christopher Murphy"), "SKIP: 2 patients named Christopher Murphy", "a deleted namesake still makes the name ambiguous");
  eq(await pick(new SimSearch([...fam("Murphy"), { name: "Murphy, Christopher Lee", dob: "1980-01-01" }]), "Christopher Murphy"), "SKIP: 2 patients named Christopher Murphy", "a namesake carrying a middle name → skip");
}
// name order and accents
{
  const s = new SimSearch([...fam("Martin"), ...fam("Martinez", ["Nancy"]), { name: "Martínez, Noëlle", dob: "1990-05-05" }, ...fam("Martins").slice(0, 5)]);
  eq(await pick(s, "Noëlle Martinez"), "Martínez, Noëlle", "accents in task and chart (Martin rows first, Martinez on later pages)");
  eq(await pick(s, "Noelle Martinez"), "Martínez, Noëlle", "accent only on the chart");
  eq(await pick(s, "Martinez, Noelle"), "Martínez, Noëlle", "\"Last, First\"");
  eq(await pick(s, "Martínez, Noëlle"), "Martínez, Noëlle", "\"Last, First\" with accents");
  const g = new SimSearch([{ name: "García, Abigail", dob: "1952-04-03" }, { name: "Garcia, Abigail", dob: "2012-04-11" }, { name: "García, Adam", dob: "1960-07-09" }, { name: "Garcia, George", dob: "1977-07-07" }, ...fam("Garcia", ["Abigail", "Adam", "George"])]);
  eq(await pick(g, "George García"), "Garcia, George", "García / Garcia interleaved, one George");
  eq(await pick(g, "Abigail Garcia"), "SKIP: 2 patients named Abigail Garcia", "García, Abigail and Garcia, Abigail are namesakes");
}
// middle initials
{
  const t = (rows: string[]) => new SimSearch([...fam("Turner", ["Mary"]), ...rows.map((n, i) => ({ name: n, dob: `1960-01-0${i + 1}` }))]);
  eq(await pick(t(["Turner, Mary Ann"]), "Mary A. Turner"), "Turner, Mary Ann", "middle initial matches the chart's middle name");
  eq(await pick(t(["Turner, Mary Ann", "Turner, Mary Beth"]), "Mary A Turner"), "Turner, Mary Ann", "a different middle name is a different person");
  eq(await pick(t(["Turner, Mary Ann", "Turner, Mary"]), "Mary A. Turner"), "SKIP: 2 patients named Mary A. Turner", "a chart without a middle name may be her → skip");
  eq(await pick(t(["Turner, Mary A.", "Turner, Mary Ann"]), "Mary Turner"), "SKIP: 2 patients named Mary Turner", "no initial asked: both Marys are candidates");
  eq(await pick(t(["Turner, Mary A."]), "Turner, Mary A"), "Turner, Mary A.", "\"Last, First M\"");
  eq(await pick(t(["Turner, Mary Ann"]), "J. Turner"), "SKIP: no patient named J. Turner", "an initial-only first name is not a name");
}
// hyphenated and two-word surnames
{
  const s = new SimSearch([...fam("Smith"), { name: "Smith-Jones, Ann", dob: "1985-03-03" }, ...fam("Smithson").slice(0, 4)]);
  eq(await pick(s, "Ann Smith-Jones"), "Smith-Jones, Ann", "hyphenated surname");
  eq(await pick(s, "Smith-Jones, Ann"), "Smith-Jones, Ann", "hyphenated surname, Last, First");
  const c = new SimSearch([...fam("Cruz").slice(0, 10), ...fam("De la Cruz", ["Maria"]), { name: "De la Cruz, Maria", dob: "1999-09-09" }]);
  eq(await pick(c, "Maria De la Cruz"), "De la Cruz, Maria", "two-word surname found under the compound term (on page 3)");
  eq(c.calls, ["name:Cruz", "name:De la Cruz"], "…searched Cruz, then the compound surname");
  const c2 = new SimSearch([...fam("De la Cruz", ["Maria"]), { name: "De la Cruz, Maria", dob: "1999-09-09" }, { name: "De la Cruz, Maria Elena", dob: "1999-01-09" }]);
  eq(await pick(c2, "Maria De la Cruz"), "SKIP: 2 patients named Maria De la Cruz", "compound-surname list read past the name, not stopped on page 1 (namesake on page 3)");
  eq(await pick(c2, "De la Cruz, Maria Elena"), "De la Cruz, Maria Elena", "compound surname \"Last, First Middle\"");
}
// short surnames: the 2-letter term lists nothing; padded to a sound-alike 3-letter term
{
  const lee = [...fam("Lee").slice(0, 25), ...fam("Low").slice(0, 10), { name: "Lindqvist, Ronald", dob: "1949-07-11" }];
  const s = new SimSearch([...lee, { name: "Li, Barbara", dob: "1966-06-06" }, { name: "Li, Wei", dob: "1970-01-01" }]);
  eq(await pick(s, "Barbara Li"), "Li, Barbara", "Barbara Li: \"Li\" lists nothing → \"Lie\" (same sound code) → one Barbara Li");
  eq(s.calls, ["name:Li", "name:Lie"], "…searched Li, then the padded term");
  eq(await pick(new SimSearch([...lee, { name: "Li, Barbara", dob: "1966-06-06" }, { name: "Li, Barbara", dob: "1988-08-08" }]), "Li, Barbara"), "SKIP: 2 patients named Li, Barbara", "two Barbara Li → skip");
  eq(await pick(new SimSearch(lee), "Barbara Li"), "SKIP: no patient named Barbara Li", "no Barbara Li on file → skip (a Lee is never taken for a Li)");
  eq(await pick(new SimSearch([...fam("Ng"), { name: "Ng, Kevin", dob: "1980-02-02" }]), "Kevin Ng"), "Ng, Kevin", "Kevin Ng: \"Ng\" → \"Nge\", across pages");
  eq(await pick(new SimSearch([...fam("Ng"), { name: "Ng, Kevin", dob: "1980-02-02" }, { name: "Ng, Kevin", dob: "1991-02-02" }]), "Kevin Ng"), "SKIP: 2 patients named Kevin Ng", "two Kevin Ng → skip");
  eq(await pick(new SimSearch([...fam("Wu"), { name: "Wu, Helen Mei", dob: "1980-02-02" }]), "Helen Wu"), "SKIP: 2 patients named Helen Wu", "Wu: Helen and Helen Mei → skip");
}
// badges and the DOB path
{
  eq(await pick(new SimSearch([...fam("Nguyen", ["Aaron"]), { name: "Nguyen, Aaron", dob: "1964-05-03", flags: ["Restricted"] }]), "Aaron Nguyen"), "SKIP: the only Aaron Nguyen record is restricted (chart not opened)", "lone restricted match → skip, chart never opened");
  eq(await pick(new SimSearch([...fam("Patterson", ["Abigail"]), { name: "Patterson, Abigail", dob: "2004-08-22", flags: ["Deleted"] }]), "Abigail Patterson"), "SKIP: the only Abigail Patterson record is deleted", "lone deleted match → skip");
  eq(await pick(new SimSearch([...fam("Diaz"), { name: "Diaz, Zztest", dob: "1990-01-01", flags: ["Test record"] }]), "Zztest Diaz"), "SKIP: the only Zztest Diaz record is test record", "lone test record → skip");
  // AGENT_BREAK_GLASS (glassPolicy.ts): dob-only (default) above; always lets a lone restricted name match be
  // chosen; never also declines a restricted record on the DOB path. Deleted / test records never.
  const restr = () => new SimSearch([...fam("Nguyen", ["Aaron"]), { name: "Nguyen, Aaron", dob: "1964-05-03", flags: ["Restricted"] }]);
  const prevBG = process.env.AGENT_BREAK_GLASS;
  process.env.AGENT_BREAK_GLASS = "always";
  eq(await pick(restr(), "Aaron Nguyen"), "Nguyen, Aaron", "AGENT_BREAK_GLASS=always: lone restricted name match is chosen");
  eq(await pick(new SimSearch([...fam("Patterson", ["Abigail"]), { name: "Patterson, Abigail", dob: "2004-08-22", flags: ["Deleted"] }]), "Abigail Patterson"), "SKIP: the only Abigail Patterson record is deleted", "always: deleted still skipped");
  process.env.AGENT_BREAK_GLASS = "never";
  eq(await pick(restr(), "Aaron Nguyen", "1964-05-03"), "SKIP: the Aaron Nguyen record is restricted and AGENT_BREAK_GLASS=never (chart not opened)", "AGENT_BREAK_GLASS=never: restricted record on the DOB path → skip");
  process.env.AGENT_BREAK_GLASS = "dob-only";
  eq(await pick(restr(), "Aaron Nguyen", "1964-05-03"), "Nguyen, Aaron", "dob-only: restricted record on the DOB path is chosen (158 behaviour)");
  if (prevBG === undefined) delete process.env.AGENT_BREAK_GLASS; else process.env.AGENT_BREAK_GLASS = prevBG;
  const d = new SimSearch([{ name: "Bassett, Thomas", dob: "1989-09-06" }, { name: "O'Brien, Adam", dob: "1989-09-06" }, { name: "O'Brien, Adam", dob: "1990-01-01" }]);
  eq(await pick(d, "Adam O'Brien", "1989-09-06"), "O'Brien, Adam", "DOB path: the DOB search, the row with the name (158 rule)");
  eq(d.calls, ["dob:1989-09-06"], "DOB path never runs a name search");
  eq(await pick(d, "Adam O'Brien", "1975-01-01"), "SKIP: no patient named Adam O'Brien born 1975-01-01", "DOB path: nobody with that DOB → skip");
  eq(await pick(new SimSearch([{ name: "Kim, Lee", dob: "1980-01-01" }, { name: "Kim, Lee", dob: "1980-01-01" }]), "Lee Kim", "1980-01-01"), "Kim, Lee", "DOB path unchanged: same name + same DOB takes the first row (the 158 rule)");
}

// ── per family: every family reaches its patient through the one resolver ──
{
  const src = (f: string) => readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
  const ib = src("index-builder.ts");
  // a context is an inline `name: async (…) => {…},` or a factory call `name: labLive({…}),`
  const block = (name: string) => { const m = new RegExp(`${name}: (?:async|\\w+\\()`).exec(ib); if (!m) return ""; const e = /\n    \}\)?,/g; e.lastIndex = m.index; const j = e.exec(ib); return ib.slice(m.index, j ? j.index : undefined); };
  for (const [ctx, family] of [["filingContext", "filing"], ["goodFaithContext", "good-faith"], ["labContext", "lab"], ["tetanusContext", "tetanus"]] as const) {
    const b = block(ctx);
    eq([b.length > 0, b.includes(`patientFor("${family}"`), /ensurePatient\(|cache\.get\(/.test(b)], [true, true, false], `${family}: ${ctx} resolves the patient through patientFor (the shared resolver), nothing else`);
  }
  // claim-next-step (built on its own branch): its context, once wired here, must use patientFor too
  const claim = block("claimContext");
  eq(!claim || (claim.includes(`patientFor(`) && !/ensurePatient\(|cache\.get\(/.test(claim)), true, "claim-next-step: claimContext (when present) resolves through patientFor");
  const ens = ib.slice(ib.indexOf("async function ensurePatient"), ib.indexOf("async function patientFor"));
  eq([ens.includes("await resolvePatient(crawler, name, dob)"), /searchByDob|searchPatientsPaged|searchPatients\(/.test(ens)], [true, false], "ensurePatient (phone / invoice / referral / generalist / every family) calls resolvePatient and no search directly");
  eq(/ensurePatient|findPatient/.test(src("immunizationsLive.ts").slice(src("immunizationsLive.ts").indexOf("export function tetanusReader"))), false, "tetanus reader is handed patientFor, not ensurePatient/findPatient");
  // nobody else runs a patient search: only the resolver (and the recon diagnostics) call the crawler's searches
  const callers = readdirSync(new URL(".", import.meta.url)).filter((f) => f.endsWith(".ts") && !/^test-patientResolve\.ts$/.test(f))
    .filter((f) => /\.(searchByDob|searchPatientsPaged|searchPatients)\(/.test(src(f)));
  eq(callers.sort(), ["crawl.ts", "patientResolve.ts", "recon.ts"], "patient searches are called only by patientResolve.ts (crawl.ts defines them; recon.ts is diagnostics)");
}

// ── pager proof (live practice 2026-10-08): footers, restarts after a session reload, capped "N+" lists ──
{
  const R = (f: string) => pageRange(f);
  const P = (r: ReturnType<typeof pageRange>) => r && (({ footer: _f, ...rest }) => rest)(r); // the range without the shared footer object
  eq(P(R("Showing 26 to 50 of 123 patients")), { a: 26, b: 50, total: 123, plus: false, approx: false }, "footer parsed");
  eq(P(R("Showing 201 to 268 of 200+ patients")), { a: 201, b: 268, total: 200, plus: true, approx: false }, "capped footer keeps its +");
  eq(pageStep(R("Showing 1 to 100 of 200+ patients"), R("Showing 101 to 200 of 200+ patients")), "next", "continues → next");
  eq(pageStep(R("Showing 76 to 100 of 123 patients"), R("Showing 1 to 25 of 123 patients")), "restart", "back at row 1 (app reloaded) → restart");
  eq(pageStep(R("Showing 1 to 25 of 123 patients"), R("Showing 1 to 25 of 123 patients")), "restart", "page 1 shown again → restart, never counted as new rows");
  eq(pageStep(R("Showing 26 to 50 of 123 patients"), R("Showing 76 to 100 of 123 patients")), "gap", "skipped range → gap");
  eq(pageStep(R("Showing 201 to 300 of 200+ patients"), undefined), "unknown", "empty 'No more results' page after the cap → unknown");
  eq(P(R("Showing 41 to 55 of about 50 patients")), { a: 41, b: 55, total: 50, plus: false, approx: true }, "estimated total kept as approx");
  eq(rangeEnded(R("Showing 41 to 55 of about 50 patients")), false, "an estimate never proves the end (run 146: about 600 patients, cut at 160)");
  eq([rangeEnded(R("Showing 101 to 123 of 123 patients")), rangeEnded(R("Showing 201 to 268 of 200+ patients")), rangeEnded(undefined)], [true, false, false], "only an exact total proves the end");
  // a search always starts on a fresh load (a previous walk left the list on page N with 100 rows: practice run 4
  // read the empty capped page 4 of "Smith" as a complete, empty list → "no patient named David Smith")
  const csrc = readFileSync(new URL("./crawl.ts", import.meta.url), "utf8");
  // the end of the list is listFooter.isComplete's verdict, which an empty "No more results" page (`empty`) never passes
  eq([/lastName=\$\{encodeURIComponent\(lastName\)\}`, Crawler\.RESULTS, 12000, true\)/.test(csrc), /isComplete\(rowsRead, footerOf\(s\), \{ next: s\.next, empty: s\.empty \}\)/.test(csrc), /Date\.now\(\) - this\.loadedAt < Crawler\.FRESH_MS/.test(csrc)], [true, true, true], "search loads fresh; an empty capped page never ends a list; a stale page is reloaded before reuse");
  // the crawler's walk uses these (and raises Rows per page first)
  const cs = readFileSync(new URL("./crawl.ts", import.meta.url), "utf8"); const cw = cs.slice(cs.indexOf("async searchPatientsPaged"));
  eq([/NR\.pageStep\(/.test(cw), /"restart"/.test(cw), /raisePageSize/.test(cw), /!unproven && ended\(st, got\.length\)/.test(cw)], [true, true, true, true], "searchPatientsPaged checks continuity, restarts on a reload, raises the page size, and an unplaceable page (empty capped page, disabled Next) never proves the end");
  eq([isComplete(25, listFooter("Showing 1 to 25 of 25 patients"), { next: "disabled" }).complete, isComplete(0, listFooter(""), { next: "disabled" }).complete, isComplete(25, listFooter("Showing 1 to 25 of 25 patients"), { next: "disabled", empty: true }).complete, isComplete(96, listFooter("96 patients"), { next: "none" }).complete, isComplete(95, listFooter("96 patients"), { next: "none" }).complete],
    [true, false, false, true, false], "end proofs: exact range reached; a disabled Next with no count proves nothing; an empty capped page never; the list's own count only when every row was read");
}

console.log(`\n${fail ? "✗" : "✓"} test-patientResolve: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
