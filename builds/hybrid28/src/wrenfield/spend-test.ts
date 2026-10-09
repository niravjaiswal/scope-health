// Spend governor (spend.ts + failover.ts hooks + wfShadow gates): the cap derived from SHIFT_SECONDS, cost accounting
// from usage / tokens / estimates, the reserve line for image reads, the executor's task gate, the cheap-model
// preference while ahead of pace, and a fault-injected 402 in a real shift loop: deterministic (non-image) families
// still answer and the shift finishes.   npx tsx src/wrenfield/spend-test.ts   (in gates.sh)
process.env.LLM_BASE_URL = "http://proxy.invalid/v1"; process.env.LLM_API_KEY = "test";
process.env.AGENT_HANG_MS = "4000";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
const S = await import("./spend.js");
const F = await import("./failover.js");
const { wfRunModels } = await import("./wfShadow.js");
let pass = 0, fail = 0; const ok = (c: boolean, m: string) => { if (c) { pass++; console.log("✓ " + m); } else { fail++; console.log("✗ " + m); } };
const H5 = "anthropic/claude-haiku-5.5", H4 = "anthropic/claude-haiku-4.5", G = "google/gemini-3.8-flash", SN = "anthropic/claude-sonnet-5.5", L = "openai/gpt-6-luna";
const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;

// 1. the cap from SHIFT_SECONDS (docs/shift.md + arena sets), env override wins
{
  const cap = (sh?: string, env?: string) => { if (sh === undefined) delete process.env.SHIFT_SECONDS; else process.env.SHIFT_SECONDS = sh; if (env === undefined) delete process.env.AGENT_SPEND_CAP_USD; else process.env.AGENT_SPEND_CAP_USD = env; return S.capUsd(); };
  ok(cap("900") === 8 && cap("1800") === 15 && cap("1200") === 1, "cap: 900 s → $8 (Set 1/2), 1800 s → $15 (Set 3), 1200 s → $1 (practice)");
  ok(cap() === 8 && cap("2400") === 15 && cap("1100") === 1 && cap("600") === 8, "cap: unknown lengths take the nearer, lower cap; unset → $8");
  ok(cap("900", "3.5") === 3.5, "AGENT_SPEND_CAP_USD overrides");
  cap("900"); ok(near(S.lineUsd(), 6), "reserve line = cap × (1 − 0.25) = $6 of $8 for text calls");
}
// 2. cost accounting: usage.cost, tokens × price, body estimate (× 1.1 safety)
{
  const body = { max_tokens: 4000, messages: [{ role: "user", content: "x".repeat(3500) }] };
  ok(near(S.costOf(SN, { cost: 0.01, prompt_tokens: 1000 }, body).usd, 0.011) && S.costOf(SN, { cost: 0.01 }, body).source === "cost", "usage.cost is taken as the proxy's accounting (× 1.1)");
  const t = S.costOf(SN, { prompt_tokens: 1000, completion_tokens: 100 }, body);
  ok(t.source === "tokens" && near(t.usd, ((2 * 1000 + 10 * 100) / 1e6) * 1.1), "tokens × the price table when cost is absent");
  const e = S.costOf(SN, null, body); const et = S.estimateTokens(body);
  ok(e.source === "estimate" && et.prompt >= 1000 && et.prompt <= 1020 && et.completion === 1000 && near(e.usd, ((2 * et.prompt + 10 * 1000) / 1e6) * 1.1), "no usage: estimate = chars/3.5 prompt (+ the JSON envelope) + min(max_tokens, 1000) completion");
  const img = { max_tokens: 64, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64," + "A".repeat(40000) } }] }] };
  ok(S.estimateTokens(img).images === 1 && S.estimateTokens(img).prompt < 1800 && S.estimateTokens(img).completion === 64, "an image counts 1600 tokens, its base64 is not text");
  ok(S.priceOf("vendor/unknown-model")[0] === 10 && S.isCheap(H5) && S.isCheap(G) && S.isCheap(L) && !S.isCheap(SN) && !S.isCheap(H4), "unknown model → the most expensive price; cheap = input under $1/M");
}
// 3. the reserve line: text calls stop at it, image reads never do; the executor's task gate
{
  S._reset(); process.env.SHIFT_SECONDS = "900"; delete process.env.AGENT_SPEND_CAP_USD;
  const body = { max_tokens: 1000, messages: [{ role: "user", content: "x".repeat(35000) }] }; // 10k prompt tokens
  for (let i = 0; i < 8; i++) S.noteCall(SN, "text", { cost: 0.7 }, body);                          // $6.16 spent
  ok(S.state.total.usd > 6 && !S.allow("text", 0.01) && S.allow("image", 1), "past the $6 line: a text call is refused, an image read is allowed");
  ok(S.state.gatedCalls === 1 && !S.allowTask().ok && /spend governor/.test(S.allowTask().why) && S.state.gatedTasks === 2, "executor task gate refuses with a why; gated counts kept");
  S._reset(); for (let i = 0; i < 5; i++) S.noteCall(SN, "text", { cost: 1 }, body);               // $5.50
  ok(S.allow("text", 0.3) && !S.allow("text", 0.6), "under the line: a call fits only when spent + estimate ≤ line");
  ok(S.allowTask().ok && S.estTaskUsd() === 0.05, "executor task: prior $0.05 per task before any measurement");
  S.beginTask(1, "workflow-exec"); S.noteCall(H5, "text", { cost: 0.02 }, body); S.noteCall(G, "text", { cost: 0.02 }, body); S.endTask();
  S.beginTask(2, "workflow-exec"); S.noteCall(H5, "text", { cost: 0.03 }, body); S.endTask();
  ok(S.state.wfTasks === 2 && near(S.state.wfTaskUsd!, 0.044 * 0.7 + 0.033 * 0.3) && S.estTaskUsd() === S.state.wfTaskUsd, "executor task spend: EMA of the measured tasks replaces the prior");
  S._reset(); S.noteExhausted(); ok(!S.allow("text", 0) && !S.allowTask().ok && S.allow("image", 0), "after a 402 every text call and executor task is refused (image reads end at the transport)");
}
// 4. ahead of pace → cheaper vote models
{
  S._reset(); process.env.SHIFT_SECONDS = "900"; F._setListed([SN, H5, G]);
  ok(JSON.stringify(wfRunModels()) === JSON.stringify([SN, H5, G]), "on pace: sonnet + haiku-5.5 + gemini");
  const body = { max_tokens: 100, messages: [{ role: "user", content: "x" }] };
  for (let i = 0; i < 10; i++) S.noteCall(SN, "text", { cost: 0.1 }, body);                        // $1.10 text in the first 30 items
  S.tick({ secondsLeft: 850, seen: 30, e1: 240 });
  ok(near(S.projectedTextUsd(), 1.1 * 240 / 30) && S.aheadOfPace() && S.state.cheap, "item projection: $1.10 × 240/30 = $8.80 > $6 line → ahead");
  ok(JSON.stringify(wfRunModels()) === JSON.stringify([H5, G]), "ahead of pace: sonnet dropped, haiku-5.5 + gemini vote");
  F._setListed([SN, H5]); ok(JSON.stringify(wfRunModels()) === JSON.stringify([SN, H5]), "only one cheap model listed: the full set stays (never fewer than 2 runs)");
  process.env.AGENT_WF_CHEAP_WHEN_AHEAD = "0"; F._setListed([SN, H5, G]); ok(wfRunModels().length === 3, "AGENT_WF_CHEAP_WHEN_AHEAD=0 keeps every model"); delete process.env.AGENT_WF_CHEAP_WHEN_AHEAD;
  S._reset(); for (let i = 0; i < 10; i++) S.noteCall(SN, "text", { cost: 0.1 }, body); S.tick({ secondsLeft: 450, seen: 5, e1: 240 });
  ok(near(S.projectedTextUsd(), 2.2) && !S.aheadOfPace(), "time projection before 20 items: $1.10 at half the shift → $2.20, on pace");
  S.tick({ secondsLeft: 100, seen: 100, e1: 240 }); ok(!S.aheadOfPace(), "a bigger seen count (100 of e1 240) scales the projection: $2.64, on pace");
}
// 5. the transport: usage accounted per leg, a text call refused at the line, a 402 marks the shift exhausted
{
  S._reset(); F._resetFaults(); F._resetHealth(); F.transportState.exhausted = false; process.env.SHIFT_SECONDS = "900";
  const body = { max_tokens: 50, messages: [{ role: "user", content: "hello" }] };
  process.env.AGENT_FAULT = `${H4}=empty`;
  const j = await F.chat(body, { primary: H4, fallbacks: [], attempts: 1, waitMs: 2000 });
  ok(!!j && S.state.total.calls === 1 && S.state.sources.estimate === 1 && S.state.total.text > 0, "a served reply without usage is accounted by estimate as a text call");
  S._reset(); S.state.total.usd = 6;
  const r = await F.chat(body, { primary: H4, fallbacks: [], attempts: 1, waitMs: 2000 });
  ok(r === null && /spend governor/.test(F.lastCause) && S.state.gatedCalls === 1 && S.state.total.calls === 0, "a text call at the line is refused before any request");
  const r2 = await F.chat(body, { primary: H4, fallbacks: [], attempts: 1, waitMs: 2000, cls: "image" });
  ok(!!r2 && S.state.total.calls === 1 && S.state.total.image > 0, "an image read at the line still goes out");
  S._reset(); F._resetFaults(); process.env.AGENT_FAULT = `${H4}=402`;
  const r3 = await F.chat(body, { primary: H4, fallbacks: [], attempts: 2, waitMs: 2000 });
  ok(r3 === null && F.transportState.exhausted && S.state.exhausted && S.state.total.calls === 0 && F.usable(H4), "402: transport and governor exhausted, nothing accounted, the model is not rested");
  F.transportState.exhausted = false; S._reset(); delete process.env.AGENT_FAULT;
}
// 6. a real shift under a 402 from the first model call: deterministic families still answer, the shift finishes,
//    one spend line per item
{
  const { runShift } = await import("./shiftMain.js"); const { index } = await import("./run.js");
  const items = [
    { id: "i001", kind: "message", text: JSON.parse(readFileSync(new URL("../../fixtures/practice-queue.json", import.meta.url), "utf8")).items[0].text },
    { id: "i002", kind: "task", text: "Billing question: Guadalupe Driscoll, visit with Sharon Morales, MD on 2025-11-05. Is that a new or an established patient visit?" },
    { id: "i003", kind: "task", text: "What phone number do we have on file for patient Julie Martínez (born 2010-01-10)?" },
    { id: "i004", kind: "task", text: "Referral letter received on 2025-11-10 for patient Randy Singh (born 1939-12-04): which practice made the referral?" },
  ];
  let cur = 0; const closes: any[] = [];
  const stateNow = () => (cur < items.length ? { status: "open", item: items[cur], seconds_left: 800 } : { status: "ended", reason: "queue_finished" });
  const server = createServer((req, res) => {
    const send = (o: any, code = 200) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url === "/item" && req.method === "GET") return send(stateNow());
    if (req.url === "/item/close" && req.method === "POST") { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { const body = JSON.parse(b || "{}"); if (cur >= items.length) return send({ error: { code: "ended" }, state: stateNow() }, 409); if (body.id !== items[cur].id) return send({ error: { code: "not_current" }, state: stateNow() }, 409); closes.push(body); cur++; send(stateNow()); }); return; }
    send({ error: { code: "not_found" } }, 404);
  });
  await new Promise<void>((r) => server.listen(0, r));
  process.env.QUEUE_URL = `http://127.0.0.1:${(server.address() as any).port}`; process.env.SHIFT_SECONDS = "900"; process.env.AGENT_ADAPTIVE = "0"; process.env.AGENT_WORKFLOW_EXEC = "off";
  process.env.AGENT_FAULT = `${H4}=402,${G}=402,${L}=402`; F._resetFaults(); F._resetHealth(); F.transportState.exhausted = false; S._reset();
  // the first model call of the shift (a compile / read of any kind) meets the 402: every later model path is off
  const first = await F.chat({ max_tokens: 20, messages: [{ role: "user", content: "x" }] }, { primary: H4, waitMs: 2000 });
  ok(first === null && F.transportState.exhausted, "the shift's first model call answers 402 cost_cap_reached");
  const lines: string[] = []; const w = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = (s: any) => { const t = String(s); if (t.startsWith('{"event":"spend"')) lines.push(t); return w(s); };
  const { closed } = await runShift(index);
  (process.stdout as any).write = w; server.close();
  const byId = Object.fromEntries(closes.map((c) => [c.id, c]));
  ok(closes.length === 4 && closed === 3 && byId.i001?.acknowledge === true, "the shift closes every item (the last close ends the queue) and finishes after the 402");
  ok(byId.i002?.answer === "NEW" && byId.i003?.answer === "(620) 323-6931", "deterministic families (new/established, phone) still answer with every model path off");
  ok("answer" in (byId.i004 ?? {}) || byId.i004?.skip === true, "the referral task closes (answered from the index or skipped), never left open");
  ok(F.transportState.exhausted && S.state.exhausted, "the 402 marked the transport and the governor exhausted");
  const sp = lines.map((l) => JSON.parse(l)).filter((r) => typeof r.n === "number");
  ok(sp.length === 4 && sp.every((r) => r.cap === 8 && r.line === 6 && typeof r.total?.usd === "number"), `one {"event":"spend"} line per item with cap, line and totals (${sp.length})`);
  delete process.env.AGENT_FAULT; F.transportState.exhausted = false;
}
console.log(`${fail ? "✗" : "✓"} spend-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
