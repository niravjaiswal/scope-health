/**
 * Per-set flag profiles (profile.ts): set detection, the env override, the pacer reload, the read-at-use flags, and where shiftMain applies it.
 *   npx tsx src/wrenfield/profile.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { detectSet, applyProfile, msgHash, SET1_FIRST_MSG } from "./profile.js";
import { Pacer } from "./pacer.js";
import { Crawler } from "./crawl.js";

let pass = 0, fail = 0;
const ok = (c: unknown, m: string) => { if (c) pass++; else { fail++; console.error("✗ " + m); } };
const eq = (a: unknown, b: unknown, m: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const here = (p: string) => new URL(p, import.meta.url);
const firstItem = (log: string) => JSON.parse(readFileSync(here("../../fixtures/set1/" + log), "utf8").split("\n").find((l) => l.startsWith('{"event":"item"'))!);

// ── the Set 1 hash is the first message of every Set 1 log we hold (146 … 278), and not the practice queue's ──
const logs = readdirSync(here("../../fixtures/set1/")).filter((f) => /^run-.*-set1\.log$/.test(f));
ok(logs.length >= 8, `${logs.length} Set 1 logs`);
for (const f of logs) { const it = firstItem(f); ok(it.kind === "message" && msgHash(it.text) === SET1_FIRST_MSG, `${f}: item 1 is the Set 1 first message`); }
const set1First = firstItem("run-265-set1.log");
const practice = JSON.parse(readFileSync(here("../../fixtures/practice-queue.json"), "utf8")).items[0];
ok(msgHash(practice.text) !== SET1_FIRST_MSG, "the practice queue's first message is not Set 1's");
eq(msgHash(set1First.text.replace(/\n/g, "\r\n") + "  "), SET1_FIRST_MSG, "line endings / trailing spaces do not change the hash");
ok(msgHash(set1First.text + "x") !== SET1_FIRST_MSG && msgHash(set1First.text.replace("lab", "labs")) !== SET1_FIRST_MSG, "an edited message is not Set 1's");

// ── detection ──
const S1 = { kind: "message", text: set1First.text }, OTHER = { kind: "message", text: practice.text }, TASK = { kind: "task", text: "How many patients?" };
eq(detectSet(1800, OTHER).set, "set3", "1800 s = Set 3 whatever the first item"); eq(detectSet(1800, null).set, "set3", "1800 s needs no item");
eq(detectSet(1200, OTHER).set, "practice", "1200 s = practice");
eq(detectSet(900, S1).set, "set1", "900 s + Set 1's first message = Set 1");
eq(detectSet(900, OTHER).set, "set2", "900 s + another first message = Set 2"); eq(detectSet(900, TASK).set, "set2", "900 s + a task first = Set 2 (Set 1 opens with a message)");
eq(detectSet(900, { kind: "task", text: set1First.text }).set, "set2", "the Set 1 text as a task is not Set 1");
eq(detectSet(900, null).set, null, "900 s with no first item: unsure"); eq(detectSet(900, { kind: "message" }).set, null, "900 s with an item without text: unsure");
for (const sh of [3600, 0, NaN, 901, 1799, 600, 1e9]) eq(detectSet(sh, S1).set, null, `SHIFT_SECONDS=${sh}: no set (the final and anything unknown take the default)`);

// ── the override ──
const P = JSON.stringify({ set1: { AGENT_LOOKUP: "on" }, set2: { AGENT_LOOKUP: "off", AGG_TABS: 1 }, set3: { AGG_TABS: "2", AGENT_WF_K: null }, practice: { AGENT_LAB_TIEBREAK: "x/y" }, default: { AGENT_ADAPTIVE: "0" } });
const run = (sh: string | undefined, first: any, profiles: string | null = P, base: Record<string, string> = {}) => {
  const env: Record<string, string | undefined> = { SHIFT_SECONDS: sh, AGENT_PROFILES: profiles ?? undefined, ...base }; return { env, ev: applyProfile(env, first) as any };
};
eq(run("900", S1, null).ev, null, "AGENT_PROFILES unset: nothing, no event"); eq(run("900", S1, "  ").ev, null, "blank: nothing");
{ const { env, ev } = run("900", S1, null, { AGENT_LOOKUP: "off" }); eq(env.AGENT_LOOKUP, "off", "unset: env untouched"); eq(ev, null, "unset: null"); }
{ const { env, ev } = run("900", S1); eq([ev.event, ev.set, ev.entry, ev.flags, ev.msg], ["profile", "set1", "set1", { AGENT_LOOKUP: "on" }, SET1_FIRST_MSG], "Set 1 event"); eq(env.AGENT_LOOKUP, "on", "Set 1 flag set"); ok(env.AGG_TABS === undefined, "Set 1 does not get Set 2's flags"); ok(!JSON.stringify(ev).includes(set1First.text.slice(0, 40)), "the event carries the hash, not the message"); }
{ const { env, ev } = run("900", OTHER); eq([ev.set, env.AGENT_LOOKUP, env.AGG_TABS], ["set2", "off", "1"], "Set 2 arm: strings, numbers become strings"); }
{ const { env, ev } = run("1800", OTHER, P, { AGENT_WF_K: "1", AGG_TABS: "3" }); eq([ev.set, env.AGG_TABS, "AGENT_WF_K" in env], ["set3", "2", false], "Set 3 arm; null unsets"); }
{ const { env, ev } = run("1200", practice); eq([ev.set, env.AGENT_LAB_TIEBREAK], ["practice", "x/y"], "practice arm"); }
{ const { env, ev } = run("3600", S1); eq([ev.set, ev.entry, env.AGENT_ADAPTIVE, env.AGENT_LOOKUP], [null, "default", "0", undefined], "the 3600 s final: default entry only"); }
{ const { env, ev } = run("900", null); eq([ev.set, ev.entry, env.AGENT_ADAPTIVE], [null, "default", "0"], "unsure: default"); }
{ const { env, ev } = run("900", S1, JSON.stringify({ set2: { AGENT_LOOKUP: "off" } })); eq([ev.set, ev.entry, ev.flags, env.AGENT_LOOKUP], ["set1", null, {}, undefined], "no entry and no default: no change"); }
{ const { env, ev } = run("900", S1, JSON.stringify({ set1: {}, default: { AGENT_ADAPTIVE: "0" } })); eq([ev.entry, env.AGENT_ADAPTIVE], ["set1", undefined], "an empty own entry beats the default (no merge)"); }
{ const prof = JSON.stringify({ set2: { LLM_API_KEY: "x", LLM_BASE_URL: "http://evil", SITE_URL: "x", SHIFT_SECONDS: "1", QUEUE_URL: "q", WORK_DIR: "/", PATH: "/", NODE_OPTIONS: "--x", AGENT_PROFILES: "{}", AGENT_GIT_SHA: "z", AGENT_BUILT_AT: "z", agent_x: "1", AGENT_OBJ: { a: 1 }, AGENT_OK: true } });
  const { env, ev } = run("900", OTHER, prof, { LLM_API_KEY: "k" });
  eq(env.LLM_API_KEY, "k", "credentials are not overridable"); eq(env.SHIFT_SECONDS, "900", "SHIFT_SECONDS is not overridable"); ok(env.LLM_BASE_URL === undefined && env.QUEUE_URL === undefined && env.PATH === undefined && env.NODE_OPTIONS === undefined, "other families refused");
  eq(env.AGENT_PROFILES, prof, "AGENT_PROFILES itself is not rewritten"); ok(env.AGENT_GIT_SHA === undefined && env.AGENT_BUILT_AT === undefined && env.agent_x === undefined && env.AGENT_OBJ === undefined, "version stamps, lower case, objects refused");
  eq(env.AGENT_OK, "true", "booleans become strings"); eq(ev.flags, { AGENT_OK: true }, "only the applied flags are logged"); eq(ev.ignored.length, 13, "the refused keys are logged"); }
{ const { env, ev } = run("900", OTHER, "{not json", {}); eq([ev.event, ev.set, ev.flags], ["profile", null, {}], "invalid JSON: nothing applied, no throw"); ok(/not a JSON object/.test(ev.why), "says why"); ok(env.AGENT_LOOKUP === undefined, "env untouched"); }
for (const bad of ["[]", "null", "5", '"x"']) eq(run("900", OTHER, bad).ev.flags, {}, `AGENT_PROFILES=${bad}: nothing applied`);
eq(run("900", OTHER, JSON.stringify({ set4: {}, default: {} })).ev.unknownEntries, ["set4"], "a mistyped entry name is reported");
eq(run("900", S1, JSON.stringify({ set1: null, default: { AGENT_ADAPTIVE: "0" } })).ev.entry, "default", "a null entry counts as missing");

// ── the shipped profile (Dockerfile AGENT_PROFILES): Set 2 = router + best-effort, Set 3 = router only; Set 1 / practice / the final unchanged ──
{
  const docker = readFileSync(here("../../Dockerfile"), "utf8"); const m = docker.match(/^ENV AGENT_PROFILES='(\{.*\})'\s*$/m);
  ok(!!m, "the Dockerfile ships AGENT_PROFILES as one single-quoted JSON object");
  const shipped = m?.[1] ?? "{}"; const image = { AGENT_WF_ROUTER: "jev", AGENT_BEST_EFFORT: "on", AGENT_BEST_EFFORT_MIN_P: "0.85", AGENT_BEST_EFFORT_MAX: "80", AGENT_LEARN: "shadow" };
  const after = (sh: string, first: any) => { const { env, ev } = run(sh, first, shipped, { ...image }); return { ev, be: env.AGENT_BEST_EFFORT, router: env.AGENT_WF_ROUTER, learn: env.AGENT_LEARN, minP: env.AGENT_BEST_EFFORT_MIN_P, max: env.AGENT_BEST_EFFORT_MAX }; };
  const same = { be: "on", router: "jev", learn: "shadow", minP: "0.85", max: "80" };
  { const r = after("900", S1); eq([r.ev.set, r.ev.entry], ["set1", "default"], "224-task Set 1 (900 s + its first message): the default entry"); eq({ ...r, ev: undefined }, { ...same, ev: undefined }, "Set 1: image flags unchanged (no tier can reach a family task anyway)"); }
  { const r = after("900", OTHER); eq([r.ev.set, r.ev.entry], ["set2", "set2"], "226-task Set 2 (900 s + another first item): the Set 2 arm"); eq({ ...r, ev: undefined }, { ...same, ev: undefined }, "Set 2: router + best-effort on, 0.85 / 80"); }
  { const r = after("900", TASK); eq(r.ev.set, "set2", "Set 2 opening with a task: the Set 2 arm"); }
  { const r = after("1800", OTHER); eq([r.ev.set, r.ev.entry], ["set3", "set3"], "458-task Set 3 (1800 s): the Set 3 arm"); eq({ ...r, ev: undefined }, { ...same, be: "off", ev: undefined }, "Set 3: router on, best-effort OFF, everything else unchanged"); }
  { const r = after("1200", practice); eq([r.ev.set, r.ev.entry], ["practice", "default"], "practice (1200 s): the default entry"); eq({ ...r, ev: undefined }, { ...same, ev: undefined }, "practice: image flags unchanged"); }
  { const r = after("3600", OTHER); eq([r.ev.set, r.ev.entry], [null, "default"], "924-task final (3600 s): no set → the default entry"); eq({ ...r, ev: undefined }, { ...same, ev: undefined }, "final: image flags unchanged (router + best-effort on)"); }
  { const r = after("900", null); eq([r.ev.set, r.ev.entry, r.be], [null, "default", "on"], "900 s with no first item: unsure → default (best-effort stays on)"); }
  // the tier flags are read at use, after the profile is applied (not cached at module load)
  const src = (f: string) => readFileSync(here(f), "utf8");
  ok(/export const beMode = \(\): BeMode => \(\(process\.env\.AGENT_BEST_EFFORT/.test(src("./bestEffort.ts")), "bestEffort reads AGENT_BEST_EFFORT at use");
  ok(/export const routerMode = \(\): RouterMode => \(\(process\.env\.AGENT_WF_ROUTER/.test(src("./wfRoute.ts")), "wfRoute reads AGENT_WF_ROUTER at use");
  ok(/export const learnMode = \(\)/.test(src("./learn/harness.ts")) && /process\.env\.AGENT_LEARN\b/.test(src("./learn/harness.ts")), "the learner reads AGENT_LEARN at use");
  ok(src("./shiftMain.ts").indexOf("applyProfile(process.env") < src("./shiftMain.ts").indexOf("const LEARN = learnMode()"), "shiftMain caches LEARN after the profile is applied");
}

// ── the flags a profile can change are read at use: the pacer (reload), the Crawler timings, AGG_TABS ──
{ const KEYS = ["AGENT_PACER_TIERB_MIN_SEEN", "AGENT_PACER_EXTRA_RESERVE_S", "AGENT_PACER_CTX_SHARE", "AGENT_PACER_MARGIN_S", "AGENT_PACER_MIN_SEEN", "AGENT_PACER_ZERO_TRIES", "AGENT_PACER_RESAMPLE", "AGENT_PACER_KEEP_YPS"];
  const fields = (p: any) => ({ tierB: p.tierBMinSeen, extra: p.extraReserve, ctx: p.ctxShare, margin: p.margin, minSeen: p.minSeen, zero: p.zeroTries, resample: p.resample, keep: p.keepYps });
  for (const k of KEYS) delete process.env[k];
  const live = new Pacer(); eq(fields(live), fields(new Pacer()), "a fresh Pacer has the default fields"); live.reload(); eq(fields(live), fields(new Pacer()), "reload() with no env = the constructor's defaults");
  KEYS.forEach((k, i) => (process.env[k] = String(7 + i)));
  const before = JSON.stringify(fields(live)); live.reload(); const fresh = new Pacer();
  eq(fields(live), fields(fresh), "reload() reads every AGENT_PACER_* knob like a fresh Pacer"); ok(JSON.stringify(fields(live)) !== before && Object.values(fields(live)).every((v, i) => v === 7 + i), "and they changed to the env's values");
  for (const k of KEYS) delete process.env[k]; }
{ delete process.env.AGENT_SETTLE_MIN_MS; delete process.env.AGENT_PAGE_FRESH_MS; eq([Crawler.SETTLE_MIN_MS, Crawler.FRESH_MS], [1500, 4000], "Crawler timings: the defaults");
  process.env.AGENT_SETTLE_MIN_MS = "900"; process.env.AGENT_PAGE_FRESH_MS = "100"; eq([Crawler.SETTLE_MIN_MS, Crawler.FRESH_MS], [900, 100], "Crawler timings are read at use");
  delete process.env.AGENT_SETTLE_MIN_MS; delete process.env.AGENT_PAGE_FRESH_MS; }
{ const src = readFileSync(here("./apptList.ts"), "utf8"); ok(/const parallelTabs = \(\) =>/.test(src) && !/PARALLEL_TABS/.test(src), "apptList reads AGG_TABS at use"); }

// ── shiftMain applies the profile once, before the first task and before it caches ADAPT / SHADOW ──
{ const src = readFileSync(here("./shiftMain.ts"), "utf8"); const at = src.indexOf("applyProfile(process.env");
  ok(at > 0 && src.indexOf("applyProfile(process.env", at + 1) < 0, "applied exactly once"); ok(at > src.indexOf("let state: any = await getItem()"), "after the first item arrives");
  ok(at < src.indexOf("const SHADOW") && at < src.indexOf("const ADAPT") && at < src.indexOf("while (state?.status"), "before the shift loop and the flags it caches");
  ok(/pacer\.reload\(\)/.test(src.slice(at, at + 400)), "the pacer is reloaded with it"); }

console.log(fail ? `✗ profile: ${pass} passed, ${fail} failed` : `✓ profile: ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
