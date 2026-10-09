/**
 * Compiler bench: per message of the corpus, write two independent Plans, verify them on the worked example
 * world, check agreement on mutated worlds, and report success / the failure reason. Real models.
 *   LLM_BASE_URL=https://openrouter.ai/api/v1 LLM_API_KEY=… npx tsx src/wrenfield/solver/bench.ts \
 *     [--ids set1-1,practice-new-established] [--variants orig,restyle] [--budget 4] [--out bench/solver/run.json]
 * Models: SOLVER_PLAN_MODELS (default sonnet-5.5,sonnet-5.5 at temps 0 / 0.8), SOLVER_WORLD_MODEL (sonnet-5.5),
 * SOLVER_INPUT_MODEL (haiku-5.5), classify = haiku-5.5 + sonnet-5.5 agreeing.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { corpus } from "./corpus.js";
import { compileVerified, type Verdict } from "./verify.js";
import { usage, modelClassifier } from "./compile.js";
import type { World } from "./exec.js";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const PRICE: Record<string, [number, number]> = { "anthropic/claude-haiku-5.5": [0.1, 0.5], "anthropic/claude-sonnet-5.5": [2, 10], "anthropic/claude-opus-5.5": [4, 20] };
const planModels = (process.env.SOLVER_PLAN_MODELS ?? "anthropic/claude-sonnet-5.5,anthropic/claude-sonnet-5.5").split(",") as [string, string];
const worldModel = process.env.SOLVER_WORLD_MODEL ?? "anthropic/claude-sonnet-5.5";
const inputModel = process.env.SOLVER_INPUT_MODEL ?? "anthropic/claude-haiku-5.5";
const budget = Number(arg("--budget") ?? 4);
const out = arg("--out") ?? new URL(`../../../bench/solver/run-${Date.now()}.json`, import.meta.url).pathname;
const worldDir = new URL("../../../fixtures/solver/worlds/", import.meta.url).pathname;

const est = () => usage.cost || (usage.inTok * 2 + usage.outTok * 10) / 1e6;
(async () => {
  if (!process.env.LLM_BASE_URL || !process.env.LLM_API_KEY) { console.error("needs LLM_BASE_URL / LLM_API_KEY"); process.exit(2); }
  const ids = arg("--ids")?.split(","); const variants = arg("--variants")?.split(",");
  const C = corpus(variants).filter((c) => !ids || ids.includes(c.id) || ids.includes(c.base));
  const worldCache = new Map<string, { world: World | null; why: string }>();
  // Worlds are cached on disk per base message (an example's facts don't change with rewording).
  mkdirSync(worldDir, { recursive: true });
  const classify = modelClassifier([inputModel, "anthropic/claude-sonnet-5.5"]);
  const rows: Array<Record<string, unknown>> = [];
  for (const c of C) {
    if (est() > budget) { rows.push({ id: c.id, ok: false, reason: "budget exhausted, not run" }); continue; }
    const wf = `${worldDir}${c.base}.json`;
    const world: World | undefined = existsSync(wf) ? JSON.parse(readFileSync(wf, "utf8")) : undefined;
    const t0 = Date.now();
    let v: Verdict;
    try { v = await compileVerified(c.text, { planModels, worldModel, inputModel, worldCache, world, classify, mutations: 40 }); }
    catch (e) { v = { title: c.id, ok: false, reason: "crash: " + (e as Error).message }; }
    if (!world && v.world) writeFileSync(wf, JSON.stringify(v.world, null, 1));
    const row = { id: c.id, base: c.base, variant: c.variant, ok: v.ok, reason: v.reason, want: v.example?.answer, gotA: v.a?.got ?? null, gotB: v.b?.got ?? null, stageA: v.a?.stage, stageB: v.b?.stage, repairsA: v.a?.repairs, repairsB: v.b?.repairs, agree: v.agree, s: Math.round((Date.now() - t0) / 1000), planA: v.a?.plan ?? null, planB: v.b?.plan ?? null };
    rows.push(row);
    console.log(`${v.ok ? "ACCEPT" : "reject"}  ${c.id.padEnd(40)} want=${row.want ?? "-"} A=${row.stageA ?? "-"}:${row.gotA ?? "-"} B=${row.stageB ?? "-"}:${row.gotB ?? "-"} agree=${v.agree ? `${v.agree.same}/${v.agree.n} (both answered ${v.agree.answered}, ${v.agree.distinct} distinct)` : "-"} $${est().toFixed(2)}  ${v.ok ? "" : v.reason.slice(0, 220)}`);
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ when: new Date().toISOString(), planModels, worldModel, inputModel, usage: { ...usage, est: est() }, rows }, null, 1));
  const acc = rows.filter((r) => r.ok).length;
  console.log(`\naccepted ${acc}/${rows.length}; calls ${usage.calls}; ~$${est().toFixed(2)} → ${out}`);
})();
