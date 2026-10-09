/** Provider-day parser on the REAL Set 1 provider-day page captured in Baseline dump
 *  (/schedule/providers/6j8lklkf15?date=2026-10-14) — an EMPTY day ("Nothing scheduled on this day").
 *  It must parse as a day with no sections (count 0), not decline. No populated Set 1 day page was captured.
 *   npx tsx src/wrenfield/providerDay-live-test.ts */
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { PROVIDER_DAY_JS, parseProviderDay } from "./pageScripts.js";
const dump = readFileSync(new URL("../../fixtures/set1/claim-dump-baseline.txt", import.meta.url), "utf8");
const start = dump.indexOf("@@@@ /schedule/providers/{id}");
const h0 = dump.indexOf("---- HTML ----", start) + "---- HTML ----".length;
const h1 = dump.indexOf("\n@@@@", h0);
const html = dump.slice(h0, h1 < 0 ? undefined : h1).split("\n[nav]")[0];
const dom = new JSDOM(`<!doctype html><html>${html}</html>`);
const win = dom.window as any;
// jsdom has no layout: innerText falls back to textContent
Object.defineProperty(win.HTMLElement.prototype, "innerText", { get() { return this.textContent; } });
const pg = new Function("doc", "window", PROVIDER_DAY_JS)(win.document, win);
(pg as any).date = "2026-10-14";
const day = parseProviderDay(pg, "2026-10-14");
const rows = day?.sections.flatMap((s) => s.rows) ?? [];
const by = (st: string) => rows.filter((r) => !r.open && r.status.toLowerCase() === st).length;
console.log(JSON.stringify({ sections: day?.sections.map((s) => [s.location, s.rows.length]), scheduled: by("scheduled"), completed: by("completed"), open: rows.filter((r) => r.open).length }));
if (!day || day.sections.length || rows.length) { console.log("✗ provider-day: the real Set 1 empty day was declined or misread"); process.exit(1); }
console.log("✓ provider-day: the real Set 1 empty day parses as empty");
