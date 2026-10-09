/**
 * Claim-page fixtures shared by claimReader.test.ts and claim-differential.ts: the captured García claim
 * page (Baseline Set 1 dump), and synthetic claims built FROM that real markup (its sections, remittance
 * groups, lines table header, obfuscated-font spans) for every branch of the rule.
 */
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import type { PlanRef } from "./claimNextStep.js";

const here = (p: string) => new URL(p, import.meta.url);
export const items = readFileSync(here("../../fixtures/set1-items.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { n: number; kind: string; text: string });
export const msg = (n: number) => items.find((i) => i.n === n)!.text;
const dump = readFileSync(here("../../fixtures/set1/claim-dump-baseline.txt"), "utf8");
export function htmlAfter(header: string): string {
  const lines = dump.split("\n"); const i = lines.findIndex((l) => l.startsWith(header)); if (i < 0) throw new Error("no " + header);
  let j = i + 1; while (lines[j] !== "---- HTML ----") j++;
  const out: string[] = []; for (let k = j + 1; k < lines.length && !/^(====|@@@@|\[nav\]|\{"event")/.test(lines[k]); k++) out.push(lines[k]);
  return out.join("\n");
}
export const CLAIM_HTML = htmlAfter("==== CLAIM DETAIL");
export const dom = (h: string) => new JSDOM(`<!doctype html><html><head><style>.wvwjwgvc{font-family:Scr}</style></head>${h}</html>`).window.document;

export const PLANS: PlanRef[] = [
  { payer: "Tallgrass Health Plan", plan: "Bronze 6000" }, { payer: "Tallgrass Health Plan", plan: "Gold 1000" }, { payer: "Tallgrass Health Plan", plan: "Silver 3500" },
  { payer: "Senior Advantage of the Plains", plan: "Senior Complete" }, { payer: "Senior Advantage of the Plains", plan: "Senior Basic" },
  { payer: "Northfield Life and Health", plan: "Northfield Choice" },
];

export type Line = { proc: string; mod?: string; billed: string; adj: string[]; remarks?: string; paid: string; line?: number };
export type Rem = { trace: string; date: string; type: string; lines?: Line[]; scanned?: boolean };
export type Claim = { dos?: string; dosISO?: string; payer?: string; service?: Array<{ proc: string; mod?: string; desc?: string }>; rems?: Rem[]; auths?: Array<{ payer: string; proc: string; from: string; to: string }>;
  /** Authorizations in the layout of the real Set 1 table (chart Insurance tab): Number | Payer | Service | Valid from | Valid through | Visits approved | Status. */
  authsReal?: Array<{ payer: string; service: string; from: string; to: string; status?: string }>; notes?: Array<{ at: string; text: string }>; subs?: Array<{ sent: string; result: string; rdate: string }> };

const realDoc = dom(CLAIM_HTML);
const LINES_THEAD = realDoc.querySelector("section[aria-label=Remittances] thead")!.outerHTML;
export const span = (s: string) => `<span class="wvwjwgvc">${s}</span>`;
const rowHtml = (l: Line, i: number, dos: string) => `<tr><td>${l.line ?? i + 1}</td><td>${dos}</td><td>${span(l.proc)}</td><td>${l.mod ? span(l.mod) : ""}</td><td class="lllrstph">1</td><td class="lllrstph">${l.billed}</td><td class="lllrstph">${l.paid}</td><td>${l.adj.map((a) => { const [code, amt] = a.split(" "); return `<div>${span(code)} ${amt}</div>`; }).join("")}</td><td>${l.remarks ? span(l.remarks) : ""}</td><td class="lllrstph">${l.paid}</td></tr>`;
const groupHtml = (r: Rem, dos: string) => `<div role="group" aria-label="Remittance ${r.trace}"><div class="xfbbprtq"><div><a class="xjp1lbj5 wvwjwgvc" aria-label="Remittance ${r.trace}" href="/claims/remittances/${r.trace.toLowerCase()}">${r.trace}</a> <span class="kpsl3z72">·</span> ${r.date} <span class="kpsl3z72">·</span> ${r.type}</div></div>` +
  (r.scanned ? `<div class="pfxg2vwr"><p>Paper remittance, scanned. Lines are not keyed.</p><img src="/v/abc/def" alt="Scanned remittance ${r.trace}"></div>` :
    `<div class="pfxg2vwr"><table class="mtzq8trn"><caption class="mqnxm17z">Lines of remittance ${r.trace} for this claim</caption>\n${LINES_THEAD}<tbody>${(r.lines ?? []).map((l, i) => rowHtml(l, i, dos)).join("")}</tbody></table></div>`) + `</div>`;

/** The captured García claim page with the given parts replaced (same markup as the real page). */
export function claimDoc(c: Claim): Document {
  const d = dom(CLAIM_HTML);
  const dosTxt = c.dos ?? "Jul 14, 2026";
  const sec = (label: string) => d.querySelector(`section[aria-label="${label}"]`)!;
  for (const dt of d.querySelectorAll("dt")) if (dt.textContent === "Service date") dt.nextElementSibling!.textContent = dosTxt;
  if (c.payer) for (const dt of d.querySelectorAll("dt")) if (dt.textContent === "Payer") { const a = dt.nextElementSibling!.querySelector("a")!; a.textContent = c.payer; a.setAttribute("aria-label", "Contract of " + c.payer); }
  if (c.service) sec("Service lines").querySelector("tbody")!.innerHTML = c.service.map((s, i) => `<tr><td>${i + 1}</td><td>${span(s.proc)}</td><td class="sfkzx559">${s.desc ?? "Procedure"}</td><td>${s.mod ? span(s.mod) : ""}</td><td class="lllrstph">1</td><td class="lllrstph">$100.00</td></tr>`).join("");
  if (c.rems) sec("Remittances").innerHTML = `<h2 class="d11sqzp4">Remittances</h2>` + (c.rems.length ? c.rems.map((r) => groupHtml(r, dosTxt)).join("") : `<p class="f1ln62p1 kpsl3z72">No remittances received for this claim yet.</p>`);
  if (c.auths) sec("Authorizations").innerHTML = `<h2 class="d11sqzp4">Authorizations</h2>` + (c.auths.length ? `<div class="pfxg2vwr"><table class="mtzq8trn"><caption class="mqnxm17z">Authorizations on file for this patient</caption><thead><tr><th scope="col">Payer</th><th scope="col">Procedure</th><th scope="col">Valid from</th><th scope="col">Valid to</th><th scope="col">Visits</th></tr></thead><tbody>${c.auths.map((a) => `<tr><td>${a.payer}</td><td>${span(a.proc)}</td><td>${a.from}</td><td>${a.to}</td><td>1</td></tr>`).join("")}</tbody></table></div>` : `<p class="f1ln62p1 kpsl3z72">No authorizations on file for this patient.</p>`);
  if (c.authsReal) sec("Authorizations").innerHTML = `<h2 class="d11sqzp4">Authorizations</h2><div class="pfxg2vwr"><table class="mtzq8trn"><caption class="mqnxm17z">Authorizations, newest first</caption><thead><tr><th scope="col">Number</th><th scope="col">Payer</th><th scope="col">Service</th><th scope="col">Valid from</th><th scope="col">Valid through</th><th scope="col">Visits approved</th><th scope="col">Status</th></tr></thead><tbody>${c.authsReal.map((a, i) => `<tr><td>${span(String(672556721 + i))}</td><td>${a.payer}</td><td>${a.service}</td><td>${a.from}</td><td>${a.to}</td><td>2</td><td>${a.status ?? "Approved"}</td></tr>`).join("")}</tbody></table></div>`;
  if (c.notes) sec("Account notes").innerHTML = `<h2 class="d11sqzp4">Account notes</h2><div class="dbgpxh26">${c.notes.map((n) => `<article class="brjmj1h9"><header class="jhpg79p2"><span class="ckdr8s9t">Wei Nguyen</span><time datetime="${n.at}" class="kpsl3z72 hwcw8wmg">${n.at}</time></header><p class="zphjwzh2">${n.text}</p></article>`).join("")}</div>`;
  if (c.subs) sec("Submissions").querySelector("tbody")!.innerHTML = c.subs.map((s) => `<tr><td>${s.sent}</td><td>Original</td><td>Electronic</td><td>${s.result}</td><td>${s.rdate}</td><td class="sfkzx559">ICN 1</td></tr>`).join("");
  return d;
}
export const paid = (trace = "EFT1000001", date = "Aug 20, 2026"): Rem => ({ trace, date, type: "Payment", lines: [{ proc: "99396", billed: "$230.00", adj: ["CO-45 $80.48", "PR-2 $20.00"], paid: "$129.52" }] });
export const deny = (reason: number, amt: string, extra: Partial<Line> = {}, trace = "CHK4578491", date = "Aug 17, 2026"): Rem => ({ trace, date, type: "Payment", lines: [{ proc: "20610", billed: amt, adj: [`CO-${reason} ${amt}`], paid: "$0.00", ...extra }] });
export const SVC = [{ proc: "99396" }, { proc: "20610" }];
export const A = (from: string, to: string, payer = "Senior Advantage of the Plains", proc = "20610") => [{ payer, proc, from, to }];
/** A payer contract page in the Claims area ("Contract of <payer>"): a dl of terms. */
export const contractDoc = (body: string, payer = "Senior Advantage of the Plains") => dom(`<body><div><header><h1>Contract of ${payer}</h1></header><section aria-label="Contract terms"><h2>Contract terms</h2>${body}</section></div></body>`);
