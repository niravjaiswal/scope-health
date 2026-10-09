/**
 * Arrival rules of Crawler navigation, found by the Set 1 replica run (bench/set1-replica):
 *  - two different patients' Documents tabs can read identically (no name on that page, both empty): after a real
 *    navigation (new document) the identical text IS the new page — it used to wait out 2 × 8 s per patient;
 *    without a new document (an in-place swap that changed nothing) identical text is still stale;
 *  - a restricted chart's gate page shows no patient name: the demographics wait accepts the gate too.
 *   npx tsx src/wrenfield/crawl-arrival-test.ts
 */
import { JSDOM } from "jsdom";
import { markerArrived, settledArrival, Crawler } from "./crawl.js";

let fails = 0;
const ok = (c: unknown, m: string) => { if (c) console.log("✓ " + m); else { fails++; console.error("✗ " + m); } };
const re = /MRN|Received|No documents|\d+\s+documents?/; const hit = (t: string) => re.test(t);
const empty = "Documents in this chart, newest first\nTitle\tType\tReceived\tActions\n0 documents";
ok(markerArrived(empty, empty, hit, true, true), "identical empty Documents tab of the next patient, new document → arrived");
ok(!markerArrived(empty, empty, hit, true, false), "identical text in the SAME document → still stale");
ok(markerArrived(empty, "Patients\nLast name", hit, false, false), "marker not on the page left → arrived on first sight");
ok(!markerArrived("Loading…", empty, hit, true, true), "no marker → not arrived, fresh or not");
ok(markerArrived(empty + "\nLab report", empty, hit, true, false), "changed text with the marker → arrived");

const g = Crawler.orGate("Garcia");
ok(g.test("This chart is restricted\nMRN\nGive a reason to open it."), "orGate: the restricted gate page counts as arrival");
ok(g.test("Garcia, Adam\nMRN"), "orGate: the chart itself counts");
ok(!g.test("Patients\nFind a patient"), "orGate: an unrelated page does not");
ok(Crawler.orGate("a.b").test("a.b") && !Crawler.orGate("a.b").test("axb"), "orGate: a string marker is literal");
ok(Crawler.orGate(/claims?/i).test("CLAIMS"), "orGate: a RegExp marker keeps its flags");

// Marker-free arrival (GENERALIZATION-AUDIT §3): the content inventory held still — only after a real navigation,
// only past SETTLE_MIN_MS (the slowest Set 1 marker in runs 162/164 arrived at 850 ms: a marker is never pre-empted).
const sig = JSON.stringify([["Activity"], ["25:Time|User|Action"], 0, 3, 1, "Showing 1 to 25 of 98 entries"]);
ok(Crawler.SETTLE_MIN_MS >= 1200, `settle is consulted only after ${Crawler.SETTLE_MIN_MS} ms (> the slowest Set 1 marker, 850 ms)`);
ok(settledArrival(sig, sig, 300, 1500), "inventory unchanged for the hold time, past the minimum → arrived");
ok(!settledArrival(sig, sig, 300, 900), "before the minimum dwell → not yet (a late marker still wins)");
ok(!settledArrival(sig, sig, 100, 1500), "inventory changed recently → not settled");
ok(!settledArrival(sig, JSON.stringify([["Activity"], ["10:Time|User|Action"], 0, 3, 1, ""]), 300, 1500), "inventory differs from the last poll → not settled");
ok(!settledArrival("", "", 300, 1500), "an empty inventory (nothing content-like, or still loading) never settles");
// the inventory itself (jsdom): data counts, headings alone do not — a 404 / error / loading page or the bare shell can
// never "arrive" in place of the page a reader asked for (fetchAppointments falls back to the tab's link after a miss)
const inv = (html: string) => new Function("doc", Crawler.INVENTORY_JS)(new JSDOM(html).window.document) as string;
ok(inv(`<body><header><h1>Torres, Laura</h1></header><main><nav><ul><li>Notes</li><li>Appointments</li></ul></nav><section><h2>Appointments</h2><table><thead><tr><th>Date</th><th>Status</th></tr></thead><tbody><tr><td>x</td><td>y</td></tr></tbody></table><p>Showing 1 to 1 of 1 appointments</p></section></main></body>`) !== "", "inventory: a tab with a table and its footer is content");
ok(inv(`<body><main><section><h2>Immunizations</h2><table><thead><tr><th>Vaccine</th></tr></thead><tbody></tbody></table><p>No entries match</p></section></main></body>`) !== "", "inventory: an empty table with headers is content (an empty list is a page)");
ok(inv(`<body><main><dl><dt>MRN</dt><dd>HG1</dd></dl></main></body>`) !== "", "inventory: label/value pairs are content");
ok(inv(`<body><main><h1>Not found</h1><p>No such page.</p></main></body>`) === "", "inventory: a 404 page with only a heading is NOT content");
ok(inv(`<body><header><h1>Torres, Angela</h1></header><main><nav><ul><li>Notes</li><li>Appointments</li></ul></nav></main></body>`) === "", "inventory: the chart shell (heading + nav items) before the tab renders is NOT content");
ok(inv(`<body><main><h1>Loading…</h1></main></body>`) === "" && inv(`<body><main><p>Something went wrong.</p><form><input></form></main></body>`) === "", "inventory: loading / error pages are empty even with a form");
ok(inv(`<body><div></div></body>`) === "", "inventory: a blank document is empty");

console.log(fails ? `\n✗ ${fails} failed` : "\nALL PASS");
process.exit(fails ? 1 : 0);
