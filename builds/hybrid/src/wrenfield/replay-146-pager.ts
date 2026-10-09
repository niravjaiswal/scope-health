/**
 * Replay check for the run-146 pager skips (fixtures/set1/run-146-set1.log): `npx tsx src/wrenfield/replay-146-pager.ts`
 *
 *  (a) aggregates — every captured "page shows 20 rows" skip_probe page is re-read by the CURRENT extractor/parser:
 *      it must parse as a Show-more list with an estimated total (page 1 is no longer a decline). Whether the task is
 *      then answered depends on pages the probe did not capture (the end of the list / each day), so the replay
 *      reports the plan (whole range by Show more, then by day) and the estimated work, not an answer.
 *  (b) name-only resolution — every "search list not read past" skip: the captured page is the 5th page of the walk,
 *      an empty "No more results." page with Previous enabled and "about N patients" far above the ~160 rows read.
 *      That is the site's cap, not the end of the list: those tasks stay declined (no list reading reaches past it).
 * Exit 1 if a probe no longer parses the way the plan needs.
 */
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { PAGE_EXTRACT, parseListPage, type RawPage } from "./apptList.js";
import { pageRange, rangeEnded } from "./nameResolve.js";

const log = readFileSync(new URL("../../fixtures/set1/run-146-set1.log", import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) as any[];
const runIn = <T>(doc: Document, Ev: typeof Event, js: string): T => new Function("doc", "Event", js)(doc, Ev) as T;
let bad = 0;
console.log("(a) aggregate skips (run 146) and their captured page 1:");
const items = log.filter((e) => e.event === "item" && /page shows \d+ rows/.test(e.why ?? ""));
const probes = log.filter((e) => e.event === "skip_probe" && /page shows \d+ rows/.test(e.why ?? ""));
for (const it of items) {
  const p = probes.find((x) => x.why === it.why.replace(/^aggregate: /, "aggregate: "));
  const est = Number(String(it.why).match(/to (\d+)"/)?.[1]);
  let line = `  i${it.n} ${it.family}: about ${est} rows`;
  if (p) {
    const raw = runIn<RawPage>(new JSDOM(p.html).window.document, Event as any, PAGE_EXTRACT); const pg = parseListPage(raw);
    const okp = !pg.problems.length && pg.range?.cumulative && pg.range.approx && raw.more?.present;
    if (!okp) bad++;
    line += ` | probe: ${okp ? "parses" : "PROBLEM " + pg.problems.join("; ")} (${pg.rows.length} rows, "Showing ${pg.range?.b} of about ${pg.range?.total}", Show more ${raw.more?.present ? "offered" : "absent"})`;
  } else line += " | (no probe captured: same page form)";
  line += ` | plan: ~${Math.ceil(est / 20)} Show more presses${est > 3000 ? " → pacer declines (too many rows)" : ", by day if the list is cut"}`;
  console.log(line);
}
console.log("(b) name-only skips (\"search list not read past\"):");
for (const it of log.filter((e) => e.event === "crawl" && e.step === "resolve" && /not read past/.test(e.why ?? ""))) {
  const t = String(it.empty ?? ""); const about = t.match(/about ([\d,]+) patients/)?.[1];
  const capped = /No more results/.test(t);
  console.log(`  ${it.name}: ${it.results} rows in ${it.pages} pages; ${capped ? `then "No more results." with about ${about} patients → site cap, stays declined` : "last page had rows (no capture of its pager) → stays declined"}`);
  if (capped && rangeEnded(pageRange(`Showing 1 to ${it.results} of about ${about!.replace(/,/g, "")} patients`))) bad++;
}
console.log(bad ? `✗ ${bad} problems` : "✓ replay consistent");
process.exit(bad ? 1 : 0);
