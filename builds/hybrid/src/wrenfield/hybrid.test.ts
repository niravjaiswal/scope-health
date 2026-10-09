// npx tsx src/wrenfield/hybrid.test.ts — routing, and split mode end to end over HTTP with a fake real queue and two fake agents.
import assert from "node:assert";
import { route, pick, Lane, serve, dispatch, splitEnv, validAnswer, type Close } from "./hybrid.js";
import { detectSet } from "./profile.js";

const R = { set1: "ours", set2: "tool", set3: "split", practice: "split", default: "ours" };
assert.equal(route(R, "set2"), "tool"); assert.equal(route(R, "set3"), "split"); assert.equal(route(R, "set1"), "ours");
assert.equal(route({ practice: "split-alt" }, "practice"), "split"); assert.equal(route(R, null), "ours"); assert.equal(route({}, "set2"), "ours"); assert.equal(route({ default: "bogus" }, "set3"), "ours");
assert.equal(detectSet(900, { kind: "task", text: "x" } as any).set, "set2"); assert.equal(detectSet(3600, undefined).set, null);
assert.equal(pick("What phone number do we have on file for patient Carol Jones (born 1982-09-07)?"), "ours");
assert.equal(pick("Is Laura Torres (born 2001-02-20) new or established for Elena Gutierrez, NP on 2025-12-30?"), "ours");
assert.equal(pick("Which of our vendors restocked the vending machine last, and was the invoice approved by facilities?"), "tool");

assert.deepEqual(splitEnv('{"AGENT_BEST_EFFORT":"off","AGENT_PROFILES":"{}","n":1}'), { AGENT_BEST_EFFORT: "off", AGENT_PROFILES: "{}" });
assert.deepEqual(splitEnv("not json"), {}); assert.deepEqual(splitEnv(""), {});

// fake real queue
const items = [
  { id: "m1", kind: "message", text: "memo" }, { id: "t1", kind: "task", text: "F: ours answers" }, { id: "t2", kind: "task", text: "N: tool answers" },
  { id: "t3", kind: "task", text: "F: ours skips" }, { id: "t4", kind: "task", text: "N: tool hangs" }, { id: "t5", kind: "task", text: "F: after the hang" },
];
let i = 0; const closed: Close[] = [];
const state = () => (i < items.length ? { status: "open", item: items[i], seconds_left: 500 } : { status: "ended", reason: "queue_finished" });
const q = { get: async () => state(), close: async (c: Close) => { assert.equal(c.id, items[i].id, "closes the open item"); closed.push(c); i++; return state(); } };

// fake agents: the queue contract from the agent's side
const seen: Record<string, string[]> = { ours: [], tool: [] };
async function agent(name: "ours" | "tool", url: string, act: (t: string) => Promise<Close["answer"] | "skip" | "hang">) {
  const call = async (method: string, path: string, body?: unknown) => { const r = await fetch(url + path, { method, ...(body ? { body: JSON.stringify(body) } : {}) }); return [r.status, await r.json()] as [number, any]; };
  let [, s] = await call("GET", "/item");
  while (s.status === "open") {
    const it = s.item; seen[name].push(it.id);
    if (it.kind === "message") { [, s] = await call("POST", "/item/close", { id: it.id, acknowledge: true }); continue; }
    const a = await act(it.text);
    if (a === "hang") { await new Promise((r) => setTimeout(r, 400)); const [code, b] = await call("POST", "/item/close", { id: it.id, answer: "late" }); assert.equal(code, 409); assert.ok(["not_current", "ended"].includes(b.error.code), b.error.code); s = b.state; continue; }
    const [code, b] = await call("POST", "/item/close", a === "skip" ? { id: it.id, skip: true } : { id: it.id, answer: a }); assert.equal(code, 200); s = b;
  }
  return s;
}
const lanes = { ours: new Lane("ours"), tool: new Lane("tool") };
const [so, sn] = await Promise.all([serve(lanes.ours), serve(lanes.tool)]);
// wrong action is refused and leaves the item open
const ends = Promise.all([
  agent("ours", so.url, async (t) => (t.includes("skips") ? "skip" : "O:" + t)),
  agent("tool", sn.url, async (t) => (t.includes("hangs") ? "hang" : "N:" + t)),
]);
const end = await dispatch(q, lanes, { pick: (t) => (t.startsWith("F:") ? "ours" : "tool"), taskMs: 150, msgMs: 1000, quiet: true });
const [eo, en] = await ends;
assert.equal(end.status, "ended"); assert.equal(eo.status, "ended"); assert.equal(en.status, "ended");
assert.deepEqual(closed, [
  { id: "m1", acknowledge: true },
  { id: "t1", answer: "O:F: ours answers" },
  { id: "t2", answer: "N:N: tool answers" },
  { id: "t3", answer: "N:F: ours skips" },       // ours skipped → the tool-loop agent's fallback answered
  { id: "t4", skip: true },                     // the tool-loop agent hung past taskMs → skipped, queue moved on
  { id: "t5", answer: "O:F: after the hang" },
]);
assert.deepEqual(seen.ours, ["m1", "t1", "t3", "t5"]); assert.deepEqual(seen.tool, ["m1", "t2", "t3", "t4"]);
// a lane refuses a wrong action and keeps the item
const l = new Lane("ours"); const p = l.give({ status: "open", item: { id: "x", kind: "message", text: "m" } }, 1000);
assert.equal((await l.close({ id: "x", answer: "no" }))[0], 422);
const ok = l.close({ id: "x", acknowledge: true }); assert.deepEqual(await p, { id: "x", acknowledge: true }); l.end({ status: "ended" }); assert.equal((await ok)[1].status, "ended");
// a dead agent's items go to the other one
const l2 = { ours: new Lane("ours"), tool: new Lane("tool") }; l2.tool.die();
let j = 0; const its = [{ id: "a", kind: "task", text: "N: x" }]; const got: Close[] = [];
const q2 = { get: async () => (j < 1 ? { status: "open", item: its[0], seconds_left: 100 } : { status: "ended" }), close: async (c: Close) => { got.push(c); j++; return { status: "ended" }; } };
const s2 = await serve(l2.ours); const a2 = agent("ours", s2.url, async () => "ours-took-it");
await dispatch(q2, l2, { pick: () => "tool", taskMs: 500, quiet: true }); await a2;
assert.deepEqual(got, [{ id: "a", answer: "ours-took-it" }]);
so.server.close(); sn.server.close(); s2.server.close();
// ── review fixes ──
assert.ok(validAnswer("ESTABLISHED:2025-08-14") && validAnswer(85) && validAnswer(["a", 2]));
assert.ok(!validAnswer(true) && !validAnswer(false) && !validAnswer(null) && !validAnswer({}) && !validAnswer("") && !validAnswer([]) && !validAnswer([true]) && !validAnswer(NaN));
// a fake real queue that refuses booleans like the judge and can be told to fail a close once
function fakeQueue(list: any[], failAnswerOnce = false) {
  let k = 0; const closes: Close[] = []; let failed = false;
  const st = () => (k < list.length ? { status: "open", item: list[k], seconds_left: 500 } : { status: "ended", reason: "queue_finished" });
  return { closes, q: { get: async () => st(), close: async (c: Close) => {
    if (c.answer !== undefined && (typeof c.answer === "boolean" || (failAnswerOnce && !failed))) { failed = true; throw new Error("POST /item/close: 400 bad_request"); }
    closes.push(c); k++; return st();
  } } };
}
async function run(list: any[], acts: Record<"ours" | "tool", (t: string) => any>, opts: any = {}, failAnswerOnce = false) {
  const lz = { ours: new Lane("ours"), tool: new Lane("tool") }; const sv = await Promise.all([serve(lz.ours), serve(lz.tool)]);
  const fq = fakeQueue(list, failAnswerOnce);
  const agents = (["ours", "tool"] as const).map((w, i) => (acts[w] ? agent(w, sv[i].url, async (t) => acts[w](t)) : Promise.resolve(null)));
  const endState = await dispatch(fq.q, lz, { quiet: true, taskMs: 150, msgMs: 300, ...opts }); await Promise.all(agents); sv.forEach((x) => x.server.close());
  return { endState, closes: fq.closes, lz };
}
{ // the tool agent answers true: closed as a skip, the shift goes on
  const r = await run([{ id: "a", kind: "task", text: "N: x" }, { id: "b", kind: "task", text: "N: y" }], { ours: () => "o", tool: (t: string) => (t.includes("x") ? true : "fine") }, { pick: () => "tool" });
  assert.deepEqual(r.closes, [{ id: "a", skip: true }, { id: "b", answer: "fine" }]); assert.equal(r.endState.status, "ended");
}
{ // the real queue refuses an answer once: retried as a skip, the shift goes on
  const r = await run([{ id: "a", kind: "task", text: "F: x" }, { id: "b", kind: "task", text: "F: y" }], { ours: () => "o", tool: () => "t" }, { pick: () => "ours" }, true);
  assert.deepEqual(r.closes, [{ id: "a", skip: true }, { id: "b", answer: "o" }]);
}
{ // an agent that never answers is cut off after breakAfter time-outs; the rest go to the other agent
  const list = ["a", "b", "c", "d"].map((id) => ({ id, kind: "task", text: "N: " + id }));
  const r = await run(list, { ours: () => "ours-did", tool: () => "hang" }, { pick: () => "tool", breakAfter: 2, fallback: false });
  assert.deepEqual(r.closes.map((c) => c.answer ?? "skip"), ["skip", "skip", "ours-did", "ours-did"]); assert.equal(r.lz.tool.alive, false);
}
{ // an agent that connects late still gets the memo it missed, before its next task
  const lz = { ours: new Lane("ours"), tool: new Lane("tool") }; const sv = await Promise.all([serve(lz.ours), serve(lz.tool)]);
  const fq = fakeQueue([{ id: "m1", kind: "message", text: "memo" }, { id: "t1", kind: "task", text: "N: x" }]);
  seen.tool = []; seen.ours = [];
  const a1 = agent("ours", sv[0].url, async () => "o");
  const a2 = new Promise((r) => setTimeout(r, 400)).then(() => agent("tool", sv[1].url, async () => "t"));
  await dispatch(fq.q, lz, { quiet: true, taskMs: 2000, msgMs: 100, pick: () => "tool" }); await Promise.all([a1, a2]); sv.forEach((x) => x.server.close());
  assert.deepEqual(seen.tool, ["m1", "t1"]); assert.deepEqual(fq.closes, [{ id: "m1", acknowledge: true }, { id: "t1", answer: "t" }]);
}
console.log("hybrid: review fixes ok (invalid answers, refused close, breaker, missed memo)");

console.log("hybrid: ok (routing + split over HTTP: messages to both, family/other routing, fallback, hang timeout, dead agent, wrong action)");
