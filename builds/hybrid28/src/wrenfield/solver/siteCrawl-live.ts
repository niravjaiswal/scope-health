/**
 * Read-only practice-site crawl for the site model: visits seed pages, follows in-app links breadth-first
 * (at most PER_TEMPLATE pages per URL template, MAX pages in all) and writes one PAGE_READ_JS reading per
 * page as JSON lines. Never presses a control, never opens a restricted chart (navigation only; a gated
 * page is recorded as gated), never follows write-looking links.
 *
 *   npx tsx src/wrenfield/solver/siteCrawl-live.ts [out.jsonl]   (inside the agent image; see README)
 */
import { writeFileSync, appendFileSync } from "node:fs";
import { Crawler } from "../crawl.js";
import { PAGE_READ_JS, type PageRead } from "./pageRead.js";
import { templateKey } from "./siteModel.js";

process.env.AGENT_BREAK_GLASS = "never";
const out = process.argv[2] ?? "/out/practice-crawl.jsonl";
const MAX = Number(process.env.CRAWL_MAX ?? 140), PER_TEMPLATE = Number(process.env.CRAWL_PER_TEMPLATE ?? 2);
const SEEDS = ["/", "/schedule", "/schedule/appointments", "/schedule/slot-finder", "/documents", "/billing", "/claims", "/claims/remittances",
  "/vaccines", "/payers", "/audit-log", "/settings", "/settings/clinic-calendar", "/settings/care-teams", "/settings/procedures",
  "/settings/no-charge-visit-types", "/patients", "/patients?lastName=Garcia", "/patients?lastName=Smith", "/reports", "/inbox", "/tasks", "/referrals"];
const WRITE = /\/(new|edit|delete|cancel|logout|sign-?out|merge|void)(\/|$|\?)/i;

const c = new Crawler(process.env.SITE_URL || "https://practice.speedrun.scopehealth.com");
await c.launch(); await c.login(process.env.SITE_USERNAME, process.env.SITE_PASSWORD);
writeFileSync(out, "");
const perT = new Map<string, number>(); const seen = new Set<string>(); const queue = [...SEEDS];
let pages = 0;
while (queue.length && pages < MAX) {
  const url = queue.shift()!;
  if (seen.has(url) || WRITE.test(url)) continue;
  seen.add(url);
  const t = templateKey(url);
  if ((perT.get(t) ?? 0) >= PER_TEMPLATE) continue;
  const ok = await c.navTo(url, /\S{3}/, 12000, true).catch(() => false);
  await new Promise((r) => setTimeout(r, 1200));
  const read = await c.evalApp<PageRead>(PAGE_READ_JS).catch((e) => { console.error("read fail", url, String(e).slice(0, 80)); return null; });
  const links = await c.evalApp<string[]>(`return [...doc.querySelectorAll('a[href^="/"]')].map(a=>a.getAttribute('href'))`).catch(() => [] as string[]);
  const finalUrl = await c.evalTop<string>("location.pathname+location.search").catch(() => url);
  if (!read || (!read.tables.length && !read.dls.length && !read.forms.length && !read.h1)) { console.error("empty", url, ok); continue; }
  perT.set(t, (perT.get(t) ?? 0) + 1); pages++;
  appendFileSync(out, JSON.stringify({ url: finalUrl || url, asked: url, read }) + "\n");
  console.error(`page ${pages}: ${url} → ${templateKey(finalUrl || url)} tables=${read.tables.length} dls=${read.dls.length} gates=${read.gates.length}`);
  for (const l of links) if (l && !seen.has(l) && !WRITE.test(l) && (perT.get(templateKey(l)) ?? 0) < PER_TEMPLATE) queue.push(l);
}
console.error(`done: ${pages} pages, ${perT.size} templates`);
await c.close();
process.exit(0);
