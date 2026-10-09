/**
 * Replay of the one footer rule (listFooter.ts) over the two 0-wrong Set 1 runs (164, 162) and the captured Set 1 pages.
 *   npx tsx src/wrenfield/replay-footer-164.ts          (in gates.sh)
 *
 * Question (GENERALIZATION-AUDIT.md §5.1): until footer, pageSnapshot.pagerOf and contextResolve.docFooter read
 * "of 500+" / "of about N" as an exact total. Which ANSWERED tasks' paths walked a list, what footer does that list state
 * on the real Set 1 pages, and what does the rule say about it now?
 *
 *  1. Captured pages (fixtures/set1/{claim-dump-baseline,recon-158}.txt, /anotherDOMdump.txt, via the replica's dump
 *     loader) → every list footer per page template, parsed by listFooter, with the rows the captured table shows and
 *     the rule's verdict for a fully loaded page.
 *  2. Each run's log → the page templates every task visited (the `[nav] step` lines before its `[item iNNN]` line) and
 *     its answer. A task is LIST-DEPENDENT when a visited template states a list footer on the captured pages. It is
 *     KEPT when every such footer is exact (the rule can prove the walk's end), DECLINED when one states a "+" bound or
 *     an "about" estimate (the walk was never provable; the answer must now be a decline). Name-only resolutions
 *     (patient search, "about N patients") are reported apart: their proof is the sorted list read past the name,
 *     never the footer.
 *  3. The capped lists the runs actually met (skip probes: "Showing 300 of about N", "about N patients" …) and the
 *     rule's verdict on each — all must be "not complete".
 *
 * Exit 1 when any answered task of either run is DECLINED by the rule (a Set 1 point rested on a false completeness
 * proof), or when a capped page the runs met is called complete.
 */
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { listFooter, isComplete, type ListFooter } from "./listFooter.js";
import { snapshotOf } from "./pageSnapshot.js";
import { templateOf } from "./sitemap.js";
// @ts-ignore — the replica's dump loader is plain JS (bench/set1-replica/dumps.mjs)
import { loadPages } from "../../bench/set1-replica/dumps.mjs";

const LIST_NOUN = /^(entr(?:y|ies)|notes?|appointments?|claims?|rows?|results?|records?|documents?|patients?|invoices?|payers?|conditions?|files?|lots?|doses?)$/i;
const SEARCH = /^\/patients\?lastName$/;
/** The lists each family's reader WALKS (reads to the end, by its own completeness proof). A page visited for another
 *  reason — invoice-balance opens /billing only to use its "Find invoice" form; lab opens a document viewer — states a
 *  footer for a list the task never reads; such visits are reported apart, never as list-dependence. */
const WALKS: Record<string, RegExp[]> = {
  "good-faith-estimate": [/^\/patients\/\{id\}\/notes$/, /^\/patients\/\{id\}\/appointments$/, /^\/patients\/\{id\}\/appointments\/\{id\}$/, /clinic-calendar$/],
  "tetanus-wound": [/^\/patients\/\{id\}\/notes$/, /^\/patients\/\{id\}\/immunizations$/, /^\/patients\/\{id\}\/files$/],
  "lab-report-triage": [/^\/patients\/\{id\}\/files$/, /^\/patients\/\{id\}\/problems$/, /^\/documents\?/],
  "claim-next-step": [/^\/patients\/\{id\}\/claims$/, /^\/payers$/],
  "filing-deadline": [/^\/payers$/, /clinic-calendar$/],
  "referral-source": [/^\/patients\/\{id\}\/files$/], "referral-reason": [/^\/patients\/\{id\}\/files$/],
  "vaccine-lot-recall": [/^\/vaccines/, /^\/patients\/\{id\}\/notes$/, /^\/patients\/\{id\}\/immunizations$/],
};
const walks = (family: string, template: string) => (WALKS[family] ?? []).some((re) => re.test(template));
let bad = 0;

// ── 1. captured footers per template ──
type Cap = { template: string; url: string; footer: ListFooter; rows: number | null; verdict: string; source: string };
const caps: Cap[] = [];
const pages = loadPages() as Map<string, { html: string; text: string; source: string; complete: boolean }>;
for (const [url, p] of pages) {
  const template = templateOf(url);
  let rows: number | null = null;
  try { const s = snapshotOf(new JSDOM(p.html).window.document); const t = s.sections.flatMap((x) => x.tables); rows = t.length ? Math.max(...t.map((x) => x.rows.length)) : null; } catch { /* a cut capture */ }
  const seen = new Set<string>();
  for (const line of p.text.split("\n")) {
    const f = listFooter(line, LIST_NOUN); if (!f || f.none || f.page !== undefined || seen.has(f.text)) continue;
    if (f.end && !LIST_NOUN.test(f.noun)) continue;
    seen.add(f.text);
    const v = isComplete(rows ?? (f.to < 0 ? f.total : f.to), f, {});
    caps.push({ template, url, footer: f, rows, verdict: v.complete ? v.proof : `NOT complete (${f.kind})`, source: p.source });
  }
}
const byTemplate = new Map<string, Cap[]>();
for (const c of caps) byTemplate.set(c.template, [...(byTemplate.get(c.template) ?? []), c]);
console.log(`1. captured Set 1 pages: ${pages.size} pages, ${caps.length} list footers on ${byTemplate.size} templates`);
for (const [t, cs] of [...byTemplate].sort()) console.log(`   ${t.padEnd(44)} ${cs.map((c) => `"${c.footer.text}" [${c.footer.kind}${c.footer.cumulative ? ", show-more" : ""}] → ${c.verdict}`).join(" | ")}`);

// ── 2. each run: visited templates per answered task → kept / declined ──
const ABSENCE = /INSURED|NO_WOUND_VISIT|^NONE:|:NONE$|^NO_|NOT_REQUIRED|^0$/;
type Item = { n: number; family: string; answer: string | null; templates: string[]; nameOnly: boolean; viaName: boolean };
function replay(file: string) {
  const lines = readFileSync(new URL(`../../fixtures/set1/${file}`, import.meta.url), "utf8").split("\n");
  const navs: string[] = []; const byEcho = new Map<number, { templates: string[]; nameOnly: boolean }>();
  const events = new Map<number, any>();
  for (const l of lines) {
    const nav = l.match(/^\[nav\] step \d+: goto (\S+)/); if (nav) { navs.push(templateOf(nav[1])); continue; }
    if (/^\[nav\] step \d+: find_patient .*=<UNKNOWN>/.test(l)) { navs.push("(name-only search)"); continue; }
    const echo = l.match(/^\[item i(\d+)\] (task|message)/);
    if (echo) { byEcho.set(+echo[1], { templates: [...new Set(navs)], nameOnly: navs.includes("(name-only search)") }); navs.length = 0; continue; }
    if (l.startsWith('{"event":"item"')) { try { const e = JSON.parse(l); if (e.kind === "task") events.set(e.n, e); } catch { /* cut line */ } }
  }
  const items: Item[] = [];
  for (const [n, e] of events) {
    const v = byEcho.get(n) ?? { templates: [], nameOnly: false };
    items.push({ n, family: e.family ?? "(none)", answer: e.result && "answer" in e.result ? String(e.result.answer) : null, templates: v.templates.filter((t) => t !== "(name-only search)"), nameOnly: v.nameOnly, viaName: v.nameOnly });
  }
  const answered = items.filter((i) => i.answer !== null);
  let listDep = 0, kept = 0, declined = 0, absKept = 0, absDeclined = 0, nameOnlyAnswered = 0;
  const famRows = new Map<string, { answered: number; lists: Set<string>; kinds: Set<string>; visitedOnly: Set<string> }>();
  for (const it of answered) {
    const fr = famRows.get(it.family) ?? { answered: 0, lists: new Set(), kinds: new Set(), visitedOnly: new Set() }; fr.answered++; famRows.set(it.family, fr);
    const footers = it.templates.filter((t) => !SEARCH.test(t) && walks(it.family, t)).flatMap((t) => byTemplate.get(t) ?? []);
    for (const t of it.templates) if (!SEARCH.test(t) && !walks(it.family, t)) for (const c of byTemplate.get(t) ?? []) if (c.footer.kind !== "exact") fr.visitedOnly.add(`${t} "${c.footer.text}"`);
    for (const c of footers) { fr.lists.add(c.template); fr.kinds.add(c.footer.kind); }
    if (it.nameOnly) nameOnlyAnswered++;
    if (!footers.length) continue;
    listDep++;
    const capped = footers.filter((c) => c.footer.kind !== "exact");
    const absence = ABSENCE.test(it.answer!);
    if (capped.length) { declined++; if (absence) absDeclined++; bad++; console.log(`   DECLINED n=${it.n} ${it.family} "${it.answer}": ${capped.map((c) => `${c.template} "${c.footer.text}"`).join(", ")}`); }
    else { kept++; if (absence) absKept++; }
  }
  console.log(`\n2. ${file}: ${answered.length} answered tasks; ${listDep} walked a list the captured pages state a footer for → kept ${kept}, declined ${declined}` +
    `; absence-shaped answers on a walked list: kept ${absKept}, declined ${absDeclined}; name-only resolutions answered: ${nameOnlyAnswered} (proof: the sorted list read past the name — the "about N patients" footer never)`);
  for (const [f, r] of [...famRows].sort()) console.log(`   ${f.padEnd(30)} answered ${String(r.answered).padStart(3)}  walked lists: ${[...r.lists].join(", ") || "(none)"}  kinds: ${[...r.kinds].join(", ") || "-"}${r.visitedOnly.size ? `  (visited for a form, list not read: ${[...r.visitedOnly].join("; ")})` : ""}`);
  // name-only searches the run ended on a capped footer: the rule must not call them complete
  for (const l of lines) {
    if (!l.includes('"step":"resolve"') || !l.includes('"via":"name"')) continue;
    let o: any; try { o = JSON.parse(l); } catch { continue; }
    const t = String(o.empty ?? ""); const about = t.match(/about ([\d,]+) patients/)?.[1];
    if (!about) continue;
    const f = listFooter(`Showing 1 to ${o.results} of about ${about} patients`);
    if (isComplete(o.results, f, { next: "disabled", empty: /No more results/.test(t) }).complete) { bad++; console.log(`   WRONG: "${o.name}" ${o.results} rows of about ${about} called complete`); }
  }
}
replay("run-164-set1.log");
replay("run-162-set1.log");

// ── 3. capped pages the runs met (skip probes) ──
console.log("\n3. capped lists the runs met (skip probes), under the rule:");
let probes = 0;
for (const file of ["run-164-set1.log", "run-162-set1.log"]) {
  for (const l of readFileSync(new URL(`../../fixtures/set1/${file}`, import.meta.url), "utf8").split("\n")) {
    if (!l.startsWith('{"event":"skip_probe"')) continue;
    let p: any; try { p = JSON.parse(l); } catch { continue; }
    let s; try { s = snapshotOf(new JSDOM(p.html).window.document); } catch { continue; }
    const fs = [...new Set(s.text.split("\n").map((x) => listFooter(x, LIST_NOUN)).filter((f): f is ListFooter => !!f && !f.none && f.page === undefined && (!f.end || LIST_NOUN.test(f.noun))).map((f) => f.text))];
    for (const text of fs) {
      const f = listFooter(text)!; const rows = Math.max(0, ...s.sections.flatMap((x) => x.tables).map((t) => t.rows.length));
      const v = isComplete(f.to < 0 ? rows : f.to, f, { next: "none", more: "none", empty: /No more results/.test(s.text) });
      probes++;
      if (f.kind !== "exact" && v.complete) { bad++; console.log(`   WRONG ${file} ${p.family}: "${text}" called complete`); }
      else console.log(`   ${file.slice(4, 7)} ${p.family.padEnd(34)} "${text}" → ${v.complete ? v.proof : "not complete"}`);
    }
  }
}
console.log(`   ${probes} probe footers checked`);
console.log(bad ? `\n✗ replay-footer: ${bad} problem(s)` : "\n✓ replay-footer: every answered 162/164 task on a list is kept by an exact total; no capped list is called complete");
process.exit(bad ? 1 : 0);
