/**
 * Set 1 ledger, mechanical part: for every Set 1 task, what baseline does with it OFFLINE (family,
 * keyword plan, slots, and the reader action traced through the real handleItem against the
 * instrumented fake clinic of harness.ts) next to what the logged runs did with it (158 and 151:
 * answer or skip + why, item ms, and the patient-search rows the resolver saw before the item).
 *
 *   npx tsx src/wrenfield/variants/ledgerBase.ts > /tmp/ledger-base.jsonl
 *
 * The forecast columns of fixtures/set1/ledger.jsonl (outcome, probabilities, reason) are added by
 * hand-worked evidence per family on top of this (see SET1-FORECAST.md).
 */
import { readFileSync } from "node:fs";
import { loadItems, storesByPrefix, messagesBefore, trace, actionOf, familyMatch, FIX, type LogItem } from "./harness.js";
import { toPlan } from "../run.js";
import { extractSlots } from "../parse.js";

type Resolve = { name: string; dob?: string; results: number; matches: number; chosen: boolean; rows?: string[] };
/** Per item n: the log's item record + the resolve events printed since the previous item. */
function readRun(file: string): Map<number, { item: LogItem; resolves: Resolve[] }> {
  const out = new Map<number, { item: LogItem; resolves: Resolve[] }>();
  let pending: Resolve[] = [];
  for (const line of readFileSync(FIX + "set1/" + file, "utf8").split("\n")) {
    if (!line.startsWith("{")) continue;
    let d: any; try { d = JSON.parse(line); } catch { continue; }
    if (d.event === "crawl" && d.step === "resolve") pending.push({ name: d.name, dob: d.dob, results: d.results, matches: d.matches, chosen: d.chosen, rows: d.rows });
    if (d.event === "item") { out.set(d.n, { item: d, resolves: pending }); pending = []; }
  }
  return out;
}

const items = loadItems();
const r158 = readRun("run-158-set1.log"), r151 = readRun("run-151-set1.log");
const log158 = [...r158.values()].map((x) => x.item);
const stores = await storesByPrefix(items, log158);
const before = messagesBefore(items);
const res = (r?: { item: LogItem }) => r?.item.result && "answer" in r.item.result ? r.item.result.answer! : null;
const short = (rs: Resolve[]) => rs.map((r) => ({ name: r.name, dob: r.dob ?? null, results: r.results, matches: r.matches, chosen: r.chosen, firstRow: r.rows?.[0] ?? null, lastRow: r.rows?.at(-1) ?? null }));
for (let i = 0; i < items.length; i++) {
  const it = items[i], n = i + 1;
  if (it.kind !== "task") continue;
  const fam = familyMatch(it.text);
  const slots = fam?.slots ?? extractSlots(it.text);
  const t = await trace(it.text, stores[before[i]], Object.fromEntries(Object.entries(fam?.slots ?? {}).map(([k, v]) => [k, String(v)])));
  const a = r158.get(n), b = r151.get(n);
  console.log(JSON.stringify({
    n, family: fam?.family ?? null, text: it.text, plan: toPlan(it.text)?.type ?? null, slots, action: actionOf(t), why_offline: t.why ?? null,
    run158: { answer: res(a), why: a?.item.why ?? null, ms: a?.item.ms ?? null, resolves: short(a?.resolves ?? []) },
    run151: { answer: res(b), why: b?.item.why ?? null, ms: b?.item.ms ?? null, resolves: short(b?.resolves ?? []) },
  }));
}
