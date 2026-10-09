/**
 * operate.ts on captured Set 1 pages (fixtures/set1/recon-158.txt) and small synthetic pages, in jsdom.
 *   npx tsx src/wrenfield/operate-test.ts
 * Live counterpart (practice site, read-only): bench/operate-live.ts.
 */
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { runOn, OPERATE_LIB } from "./operate.js";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail: unknown = "") => { cond ? pass++ : fail++; if (!cond) console.log(`FAIL ${name} ${JSON.stringify(detail).slice(0, 300)}`); };
const dom = (html: string) => new JSDOM(`<!doctype html><body>${html}</body>`).window.document;

/** Pages of a recon dump: "@@@@ <template> :: …" / "==== …" heads, each followed by "---- HTML ----". */
function sections(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of raw.split(/^(?=@@@@ |==== )/m)) {
    const head = p.split("\n")[0].replace(/@@@@/g, "").replace(/^====\s*/, "").split("::")[0].trim();
    const i = p.indexOf("---- HTML ----"); if (i < 0) continue;
    let html = p.slice(i + 15); const j = html.search(/^---- [A-Z]/m); if (j > 0) html = html.slice(0, j);
    if (!out.has(head)) out.set(head, html);
  }
  return out;
}
const recon = sections(readFileSync(new URL("../../fixtures/set1/recon-158.txt", import.meta.url), "utf8"));
const page = (t: string) => { const h = recon.get(t); if (!h) throw new Error("no captured page " + t); return new JSDOM(h).window.document; };

// ── captured Set 1 pages ──
{ // /documents: filter form by label, Show more, sort toggle
  const d = page("/documents");
  const inv = runOn<any>(d, "inventory(doc)");
  ok("documents: Show more listed", inv.more.includes("Show more"), inv.more);
  ok("documents: Filter documents form with Type select", inv.forms.some((f: any) => f.name === "Filter documents" && f.fields.some((x: any) => x.label === "Type" && x.kind === "select")), inv.forms);
  const s = runOn<any>(d, `setField(doc,"Type","Lab report")`);
  ok("documents: set Type = Lab report", s.ok, s);
  ok("documents: Type select now holds the lab option", runOn<string>(d, `[...doc.querySelectorAll('select')].find(e=>accName(e)==='Type').selectedOptions[0].textContent.trim()`) === "Lab report");
  ok("documents: inexact option refused", !runOn<any>(d, `setField(doc,"Type","Lab")`).ok);
  ok("documents: unknown label refused", !runOn<any>(d, `setField(doc,"Kind","Lab report")`).ok);
  ok("documents: Show more pressable", runOn<any>(d, `press(doc,"Show more",{exact:true})`).ok);
  ok("documents: sort toggle by its trailing words", runOn<any>(d, `press(doc,"Change the order")`).ok);
  ok("documents: GET filter submits", runOn<any>(d, `submitNear(doc,"Type","Apply")`).ok);
}
{ // the restricted-chart gate (captured on Garcia, Adam's insurance tab): never pressed from here
  const d = page("POPULATED insurance (authorizations / not-yet-filed)");
  const inv = runOn<any>(d, "inventory(doc)");
  ok("gate: inventory sees the gate", inv.gates.length > 0, inv.gates);
  const r = runOn<any>(d, `press(doc,"Request access")`);
  ok("gate: Request access refused by press()", !r.ok && /access gate/.test(r.why), r);
  const sb = runOn<any>(d, `submitNear(doc,"Reason for access")`);
  ok("gate: form submit refused", !sb.ok, sb);
}
{ // appointment list: Filter appointments form fields by label
  const d = page("/schedule/appointments");
  const inv = runOn<any>(d, "inventory(doc)");
  const f = inv.forms.find((x: any) => x.name === "Filter appointments");
  ok("appointments: filter form labels", !!f && ["From", "To", "Location", "Provider", "Status", "Visit type"].every((l) => f.fields.some((x: any) => x.label === l)), f);
  ok("appointments: Status = Completed", runOn<any>(d, `setField(doc,"Status","Completed")`).ok);
  ok("appointments: From date set", runOn<any>(d, `setField(doc,"From","2026-10-01")`).value === "2026-10-01");
}
{ // every captured page: inventory runs, nothing in a page's main area is both a gate and pressable
  let pages = 0;
  for (const [t, h] of recon) { const d = new JSDOM(h).window.document; const inv = runOn<any>(d, "inventory(doc)"); pages++; for (const b of inv.buttons) if (b.gate) ok(`${t}: gate button refused`, !runOn<any>(d, `press(doc,${JSON.stringify(b.name)},{exact:true})`).ok); }
  ok("inventory ran on every captured page", pages >= 40, pages);
}

// ── synthetic pages ──
{
  const d = dom(`<main><button>Delete appointment</button><button>Save</button><button>View</button><button>View</button>
    <button hidden>Show more</button><button disabled>Next</button><details><summary>Older notes</summary><p>x</p></details>
    <button aria-label="Show 20 more results">More</button><div role="tab" aria-selected="false">Storage</div>
    <label><input type="checkbox"> Include cancelled</label><form method="post"><label for="r">Reason</label><input id="r"><button>Go</button></form></main>`);
  ok("write control refused", /may change/.test(runOn<any>(d, `press(doc,"Delete appointment")`).why));
  ok("write control allowed only when named", runOn<any>(d, `press(doc,"Save",{allowWrite:["Save"]})`).ok);
  ok("two controls with one name refused", /2 controls/.test(runOn<any>(d, `press(doc,"View")`).why));
  ok("hidden control not found", /no visible/.test(runOn<any>(d, `press(doc,"Show more",{exact:true})`).why));
  ok("disabled control refused", /disabled/.test(runOn<any>(d, `press(doc,"Next",{exact:true})`).why));
  ok("details opened by summary", runOn<any>(d, `press(doc,"Older notes")`).ok && runOn<boolean>(d, `doc.querySelector('details').open`));
  ok("aria-label names the control", runOn<any>(d, `press(doc,"Show 20 more results",{exact:true})`).ok);
  ok("role=tab pressable", runOn<any>(d, `press(doc,"Storage",{exact:true})`).ok);
  ok("checkbox by wrapping label", runOn<any>(d, `setField(doc,"Include cancelled","yes")`).value === "true");
  ok("POST form never submitted", /method=post/.test(runOn<any>(d, `submitNear(doc,"Reason")`).why));
  const inv = runOn<any>(d, "inventory(doc)");
  ok("inventory flags write buttons", inv.buttons.some((b: any) => b.name === "Save" && b.write));
}
{ // pager forms
  const P = (t: string) => runOn<any>(dom(`<main><p>${t}</p></main>`), "pagerOf(doc)");
  ok("pager exact", JSON.stringify(P("Showing 1 to 25 of 1,204 appointments")) === JSON.stringify({ from: 1, to: 25, total: 1204, approx: false, kind: "exact", cumulative: false, text: "Showing 1 to 25 of 1,204 appointments" }), P("Showing 1 to 25 of 1,204 appointments"));
  ok("pager plus is a bound (kind), never exact", P("Showing 476 to 500 of 500+ invoices").kind === "plus" && P("Showing 476 to 500 of 500+ invoices").approx === true);
  ok("pager grammar is the shared one (listFooter.ts)", /^\s*function listFooter\(/m.test(OPERATE_LIB));
  ok("pager plus is approximate", P("Showing 26 to 50 of 200+").approx === true);
  ok("pager about is approximate", P("Showing 20 of about 1,000").approx === true && P("Showing 20 of about 1,000").to === 20);
  ok("no pager", P("Nothing here") === null);
}

console.log(`operate: ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
