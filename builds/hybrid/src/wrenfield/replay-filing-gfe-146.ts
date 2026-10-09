/**
 * Replay check (run 146, baseline): re-run the filing / good-faith parsers on what the Set 1 log
 * captured for every filing-deadline and good-faith-estimate skip.
 *
 *   npx tsx src/wrenfield/replay-filing-gfe-146.ts
 *
 * What the log holds: NO skip_probe page for either family (the shift's 30-probe budget was spent on
 * lab / recall / claims before item 155 — shiftMain now caps probes per family). It does hold, verbatim
 * in each `why`, the real not-yet-filed header row and the first 70 characters of each dated payment note.
 * So this replay can prove (1) the real Set 1 header row is now recognised for all 11 column skips (a row
 * on the asked DOS is read into type / payer / remittance) and (2) how each captured note opening is
 * classified. The final answers depend on rows and full note bodies the log did not capture.
 */
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { snapshotOf } from "./pageSnapshot.js";
import * as R from "./familyReaders.js";

const here = (p: string) => new URL(p, import.meta.url);
const log = readFileSync(here("../../fixtures/set1/run-146-set1.log"), "utf8").split("\n").filter((l) => l.startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const items = log.filter((e: any) => e.event === "item" && (e.family === "filing-deadline" || e.family === "good-faith-estimate") && e.result?.skip);
let fails = 0;
const out: string[] = [];
const doc = (h: string) => snapshotOf(new JSDOM(`<!doctype html><html><body>${h}</body></html>`).window.document);
const US = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(8)}/${iso.slice(0, 4)}`;

for (const it of items) {
  const why: string = it.why ?? "";
  let now = "unchanged (name-only resolution: pager agent)";
  const cols = why.match(/not-yet-filed columns not recognised \((.*)\)$/);
  if (cols) {
    const head = cols[1].split(" | ");
    const dos: string = it.slots.dos;
    // one Original row on the asked DOS, cells keyed by the REAL labels (values are placeholders)
    const cell = (h: string) => /^date of service$/i.test(h) ? US(dos) : /claim type/i.test(h) ? "Original" : /bill to/i.test(h) ? "Tallgrass Health Plan" : /charge/i.test(h) ? "$125.00" : /claim number/i.test(h) ? "87827990" : /visit/i.test(h) ? "Office visit" : "—";
    const s = doc(`<h1>X</h1><section><h2>Claims not yet filed</h2><table><thead><tr>${head.map((h) => `<th scope="col">${h}</th>`).join("")}</tr></thead><tbody><tr>${head.map((h) => `<td>${cell(h)}</td>`).join("")}</tr></tbody></table></section>`);
    const r = R.parseNotYetFiled(s, dos);
    if (R.isDecline(r)) { fails++; now = "STILL DECLINES: " + r.decline; }
    else now = `columns recognised → ${r.type} / ${r.payer} → payer filing terms read next`;
  } else if (/outside a recognised insurance section/.test(why)) {
    now = "reader accepts a headingless / chart-header 'No insurance on file' (no page captured: verify on the next log's skip_probe)";
  } else {
    const note = why.match(/names this appointment's date \("(.*)"\)$/);
    if (note) {
      const date = it.slots.date;
      const r = R.datedNoteKind(note[1], date);
      now = `captured opening (70 chars) → ${R.isDecline(r) ? "decline (" + r.decline.replace(/^good-faith: /, "").slice(0, 70) + ")" : r}`;
    }
  }
  out.push(`${String(it.n).padStart(3)} ${it.family.padEnd(19)} ${why.slice(0, 60).padEnd(60)} → ${now}`);
}
console.log(out.join("\n"));
const nCols = items.filter((it: any) => /columns not recognised/.test(it.why ?? "")).length;
console.log(`\n${fails ? "✗" : "✓"} replay-filing-gfe-146: ${nCols - fails}/${nCols} filing column skips now read; ${items.length} skips listed`);
process.exit(fails ? 1 : 0);
