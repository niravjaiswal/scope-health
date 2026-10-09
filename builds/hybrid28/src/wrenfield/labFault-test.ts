// Fault injection (offline, stubbed fetch): the lab primary (haiku-5.5) fails on its first call, on 2 of every 3
// calls, permanently, answers empty, or hangs; and the run-r4 case: a hung gemini leg holds the proxy's one request
// slot when the next read starts. Every lab read must still answer every field correctly through a fallback
// (0 wrong, 0 unknown); referral (askDocument) must still answer; a model is rested only after 3 consecutive
// failures and re-probed after 10 tasks. Scenarios 1-5 run with 1 and with 4 requests in flight. With 4 (the image
// default): hung text calls never starve an image read (one reserved slot), 429 concurrency_limit backs off without
// resting the model, 402 cost_cap_reached ends model reads at once, 504 is a failed call (retried once), and a hedged
// duplicate of a slow call only replaces it (never a second reader).
// Run: npx tsx src/wrenfield/labFault-test.ts   (in gates.sh)
process.env.LLM_BASE_URL = "http://proxy.invalid/v1"; process.env.LLM_API_KEY = "test";
process.env.AGENT_FAULT_SLOW_MS = "400"; process.env.AGENT_LAB_RETRY_WAIT_MS = "1500"; process.env.AGENT_HANG_MS = "4000";
const { readLab } = await import("./labRead.js");
const { askDocument } = await import("./llm.js");
const F = await import("./failover.js");
const S = await import("./spend.js");
export {};
let pass = 0, fail = 0; const ok = (c: boolean, m: string) => { if (c) { pass++; console.log("✓ " + m); } else { fail++; console.log("✗ " + m); } };
const H5 = "anthropic/claude-haiku-5.5", H4 = "anthropic/claude-haiku-4.5", G = "google/gemini-3.8-flash";
const VOCAB = ["Sodium", "Potassium", "Creatinine"];
const need = { tests: VOCAB, meta: ["collected", "report", "record"] as any, allRows: true };
const TRUTH = { values: { Sodium: 145, Potassium: 5.0, Creatinine: 1.17 }, collected: "2025-11-04", report: "LR1", record: "MR9" };
const json = { collected: "2025-11-04", report_number: "LR-1", record_number: "MR-9", rows: [{ test: "Sodium", result: "145" }, { test: "Potassium", result: "5.0" }, { test: "Creatinine", result: "1.17" }] };
const calls: string[] = []; let hangGemini = 0;
// the proxy's concurrency cap (scenarios 13-14): with `proxyCap` requests already in progress the next one answers 429
// concurrency_limit at once (the judged practice proxy: 2-3 ms), as docs/shift.md describes for its 32nd request
let proxyCap = 0, proxyInFlight = 0, proxy429 = 0;
// scenario 15: gemini hangs until the client aborts the request (the transport's hard timeout); aborts are counted
let hangGeminiUntilAbort = false, aborts = 0;
(globalThis as any).fetch = async (_url: string, init: any) => {
  const body = JSON.parse(init.body); const m = body.model as string;
  const resp = (status: number, j: any) => ({ ok: status === 200, status, json: async () => j, headers: new Map() as any });
  if (proxyCap && proxyInFlight >= proxyCap) { proxy429++; return resp(429, { error: { code: "concurrency_limit" } }); }
  calls.push(m); proxyInFlight++;
  try {
    if (m === G && hangGeminiUntilAbort) {
      await new Promise<void>((_, rej) => { const s: AbortSignal | undefined = init.signal; const err = Object.assign(new Error("aborted"), { name: "AbortError" }); if (s?.aborted) rej(err); else s?.addEventListener("abort", () => { aborts++; rej(err); }, { once: true }); });
    }
    if (m === G && hangGemini > 0) { hangGemini--; await new Promise((r) => setTimeout(r, 1200)); }
    if (JSON.stringify(body).includes("hang-me")) await new Promise((r) => setTimeout(r, 1500)); // a hung text (generalist) call
    if (proxyCap) await new Promise((r) => setTimeout(r, 60)); // a served call takes a moment, so concurrent callers overlap
    const isDoc = String(body.messages?.[0]?.content ?? "").includes("extract a single exact value");
    return resp(200, { model: m, choices: [{ message: { content: isDoc ? JSON.stringify({ value: "Knee pain with suspected meniscal tear" }) : JSON.stringify(json) } }] });
  } finally { proxyInFlight--; }
};
// tesseract misses Potassium (prints "5.O") and the report number: those fields need two models to agree.
const tess = () => Promise.resolve({ values: { Sodium: 145, Creatinine: 1.17 }, collected: "2025-11-04", record: "MR9", ms: 1 });
const exact = (r: any) => Object.keys(r.read.values).length === 3 && Object.entries(TRUTH.values).every(([k, v]) => r.read.values[k] === v) && r.read.collected === TRUTH.collected && r.read.report === TRUTH.report && r.read.record === TRUTH.record;
const wrongOf = (r: any) => Object.entries(r.read.values).filter(([k, v]) => (TRUTH.values as any)[k] !== v).length + (["collected", "report", "record"] as const).filter((k) => r.read[k] !== undefined && r.read[k] !== (TRUTH as any)[k]).length;

async function shift(name: string, fault: string, reads = 12) {
  F._setListed([H5, H4, G]); F._resetHealth(); F._resetFaults(); process.env.AGENT_FAULT = fault; calls.length = 0;
  let right = 0, wrong = 0; const pairs = new Set<string>();
  for (let i = 0; i < reads; i++) {
    F.taskTick();
    const r = await readLab("x", need, VOCAB, { tess: tess() });
    if (exact(r)) right++; wrong += wrongOf(r);
    pairs.add(`${r.trace.primary ?? "primary"}`);
  }
  ok(wrong === 0 && right === reads, `${name}: ${right}/${reads} reads fully answered, ${wrong} wrong fields (primaries used: ${[...pairs].join(",")})`);
  return [...calls, ...Array(F._faultCallCount(H5)).fill("inj:" + H5)];
}

let c: string[] = [];
for (const mif of ["1", "4"]) {
process.env.AGENT_MAX_IN_FLIGHT = mif; console.log(`── ${mif} in flight`);
// 1. first call fails: retried, haiku-5.5 stays the primary for the rest of the shift
c = await shift("haiku-5.5 first call fails", `${H5}=first`);
ok(c.filter((m) => m === H5).length >= 12 && !c.includes(H4) && F.usable(H5), "first-call failure: retry on haiku-5.5 answers, no substitute, never rested");
// 2. two of every three calls fail: each read retries or substitutes; never rested (no 3 consecutive failures)
c = await shift("haiku-5.5 fails 2 of 3 calls", `${H5}=twoOfThree`);
ok(c.filter((m) => m === "inj:" + H5).length > 12 && F.usable(H5), "2-of-3 failures: haiku-5.5 still asked every read (not demoted)");
// 3. permanently down: substitute haiku-4.5 + gemini tiebreak; rested after 3 reads (6 failed calls), re-probed after 10 tasks
c = await shift("haiku-5.5 permanently down", `${H5}=down`, 25);
const h5 = c.filter((m) => m === "inj:" + H5).length;
ok(h5 >= 6 && h5 <= 12, `down: haiku-5.5 asked ${h5}× in 25 reads (rested after 3 failed reads, re-probed after 10 tasks)`);
ok(c.filter((m) => m === H4).length >= 22, "down: haiku-4.5 reads in its place");
// 4. empty replies count as failures the same way
await shift("haiku-5.5 answers empty", `${H5}=empty`);
// 5. slow (never answers within the read's wait): bounded — retry + substitute
const t5 = Date.now(); await shift("haiku-5.5 hangs", `${H5}=slow`, 4); ok(Date.now() - t5 < 20000, `slow: 4 reads in ${Date.now() - t5} ms (bounded)`);
}
// 6. the r4 case (1 in flight): an abandoned gemini leg still holds the single slot when the next haiku-5.5 read starts
process.env.AGENT_MAX_IN_FLIGHT = "1";
F._setListed([H5, H4, G]); F._resetHealth(); process.env.AGENT_FAULT = ""; hangGemini = 1; calls.length = 0;
const bg = F.chat({ messages: [] }, { primary: G, fallbacks: [], waitMs: 100 }); // caller gives up at 100 ms; leg runs 1.2 s
ok((await bg) === null, "a caller stops waiting for a hung gemini leg (the leg keeps the slot)");
const r6 = await readLab("x", need, VOCAB, { tess: tess() });
ok(exact(r6) && r6.trace.primary === undefined, "next read waits for the slot and haiku-5.5 answers (no failure, no demote)");
ok(F.transportState.bad.has(H5) === false && F.usable(H5), "haiku-5.5 still usable");
// 7. referral letters: the cross-provider pair (haiku-5.5 + gemini, haiku-4.5 substitute) must agree; a transport failure of
//    one reader is retried on it, then the substitute reads — an answer comes back; a failed read never fails over INSIDE
//    one call (fallbacks: [] — two reads of one model are never a pair)
{
  const { askDocumentPair } = await import("./llm.js");
  for (const [nm, f, sub] of [["haiku-5.5 first call fails", `${H5}=first`, false], ["gemini 2 of 3", `${G}=twoOfThree`, false], ["gemini down", `${G}=down`, true], ["haiku-5.5 down", `${H5}=down`, true]] as Array<[string, string, boolean]>) {
    F._setListed([H5, H4, G]); F._resetHealth(); F._resetFaults(); process.env.AGENT_FAULT = f; F.transportState.switchedUntil = 0; F.transportState.bad.clear(); calls.length = 0;
    const a = await askDocumentPair("What reason does it give for the referral?", "x");
    ok(a === "Knee pain with suspected meniscal tear", `referral pair, ${nm}: the pair agrees (${a}); substitute used: ${calls.includes(H4)} (expected ${sub})`);
    ok(calls.includes(H4) === sub, `referral pair, ${nm}: haiku-4.5 read only as the substitute`);
  }
  F._resetHealth(); F._resetFaults(); process.env.AGENT_FAULT = `${H4}=down`; calls.length = 0;
  const a = await askDocument("What reason does it give for the referral?", "x");
  ok(a === null && calls.length === 0, "a single document read of a down model fails over to NO other model (the pair rule owns the substitute)");
}
// the slot case for referral: a hung leg holds the slot → the read waits instead of "first read found no value"
process.env.AGENT_FAULT = ""; hangGemini = 1; F.transportState.switchedUntil = 0;
await F.chat({ messages: [] }, { primary: G, fallbacks: [], waitMs: 100 });
ok((await askDocument("What reason does it give for the referral?", "x")) === "Knee pain with suspected meniscal tear", "referral read waits for the slot held by a hung leg");
// ── 4 in flight (the image default) ──
process.env.AGENT_MAX_IN_FLIGHT = "4"; process.env.AGENT_FAULT = ""; F._setListed([H5, H4, G]); F._resetHealth(); F._resetFaults(); F.transportState.switchedUntil = 0;
// 8. three hung text calls hold 3 slots: an image read still starts at once on the reserved slot; a 4th text call waits
{
  const hung = [1, 2, 3].map(() => F.chat({ messages: [{ role: "user", content: "hang-me" }] }, { primary: G, fallbacks: [], waitMs: 5000 }));
  await new Promise((r) => setTimeout(r, 20));
  const t = Date.now(); const r = await readLab("x", need, VOCAB, { tess: tess() }); const dt = Date.now() - t;
  ok(exact(r) && dt < 1000, `3 hung text calls: the lab read answers in ${dt} ms on the reserved image slot`);
  const t2 = Date.now(); await F.chat({ messages: [] }, { primary: G, fallbacks: [], waitMs: 5000 }); const dt2 = Date.now() - t2;
  ok(dt2 >= 1000, `a 4th text call waits for a text slot (${dt2} ms): image reads keep theirs`);
  await Promise.all(hung);
}
// 9. 429 concurrency_limit on haiku-5.5's first call: short backoff + retry inside chat; never counted against the model
{
  F._resetHealth(); F._resetFaults(); F._resetLimit(); process.env.AGENT_FAULT = `${H5}=429`; calls.length = 0;
  const r = await readLab("x", need, VOCAB, { tess: tess() });
  ok(exact(r) && r.trace.primary === undefined && !calls.includes(H4), "429 concurrency_limit: backoff, the same call answers (no substitute)");
  F._resetHealth(); F._resetFaults(); process.env.AGENT_FAULT = `${H5}=429`;
  for (let i = 0; i < 4; i++) { F._resetFaults(); await readLab("x", need, VOCAB, { tess: tess() }); }
  ok(F.usable(H5), "repeated 429s never rest haiku-5.5");
  F._resetLimit(); // an injected 429 with one request in flight learns a cap of 1; forget it for the next scenarios
}
// 10. 504 upstream_timeout on the first call = a failed call: retried (chat's second attempt), answers
{
  F._resetHealth(); F._resetFaults(); process.env.AGENT_FAULT = `${H5}=504`; calls.length = 0;
  const r = await readLab("x", need, VOCAB, { tess: tess() });
  ok(exact(r) && !calls.includes(H4), "504 upstream_timeout: retried on haiku-5.5, answers");
}
// 11. hedged duplicate: haiku-5.5's first call hangs; chat races a duplicate of the SAME call after the hang threshold.
//     It only replaces the slow call: Potassium/report (tesseract missed them) still need the gemini tiebreak.
{
  F._resetHealth(); F._resetFaults(); F._resetLimit(); process.env.AGENT_FAULT = `${H5}=hangFirst`; process.env.AGENT_FAULT_SLOW_MS = "6000"; process.env.AGENT_HANG_MS = "300"; calls.length = 0;
  const t = Date.now(); const r = await readLab("x", need, VOCAB, { tess: tess() }); const dt = Date.now() - t;
  ok(exact(r) && dt < 3000, `hung first call: the hedged duplicate answers in ${dt} ms`);
  ok(calls.includes(G) && r.trace.agreedTb?.primaryTb === 2 && r.trace.agreed1 === 4, `the duplicate is not a second reader: the 2 fields tesseract missed were agreed only with the gemini tiebreak (agreed1 ${r.trace.agreed1}, agreedTb ${JSON.stringify(r.trace.agreedTb)})`);
  process.env.AGENT_FAULT_SLOW_MS = "400"; process.env.AGENT_HANG_MS = "4000";
  await new Promise((r) => setTimeout(r, 6200)); // let the hung leg settle
}
// 12. 402 cost_cap_reached: every model path is off for the shift; a read ends at once (tesseract alone never answers)
{
  F._resetHealth(); F._resetFaults(); process.env.AGENT_FAULT = `${H5}=402,${H4}=402,${G}=402`;
  const t = Date.now(); const r = await readLab("x", need, VOCAB, { tess: tess() }); const dt = Date.now() - t;
  ok(F.transportState.exhausted && Object.keys(r.read.values).length === 0 && !r.read.collected && dt < 1000, `402: model unavailable for the shift, read ends in ${dt} ms with every field unknown (engine skips)`);
  ok(F.usable(H5), "402 does not rest a model (the whole budget is gone, not the model)");
  ok((await askDocument("What reason does it give for the referral?", "x")) === null, "402: referral read returns no value (skip)");
  F.transportState.exhausted = false;
}
// 13-14. the judged practice proxy (fixtures/practice-s1-tdb7020293b3d.log): a concurrency cap of 1 (and 2), far below the
//        documented 32. Starting at 4 in flight, a lab read (tesseract ∥ haiku-5.5, gemini tiebreak), a referral read and a
//        text call start together: the 429s are busy slots, never failed models — the limit is learned down to the cap,
//        every call waits for its slot and retries the SAME model, the fallback chain never fires, nothing is lost.
for (const cap of [1, 2]) {
  process.env.AGENT_MAX_IN_FLIGHT = "4"; process.env.AGENT_FAULT = ""; F._setListed([H5, H4, G]); F._resetHealth(); F._resetFaults(); F._resetLimit(); F.transportState.exhausted = false; F.transportState.switchedUntil = 0;
  S._reset(); // scenario 12's 402 marked the spend governor exhausted too
  proxyCap = cap; proxy429 = 0; calls.length = 0;
  const t = Date.now();
  const [lab, ref, txt] = await Promise.all([
    readLab("x", need, VOCAB, { tess: tess() }),
    askDocument("What reason does it give for the referral?", "x"),
    F.chat({ max_tokens: 20, messages: [{ role: "user", content: "a text call" }] }, { primary: H4, waitMs: 8000 }),
  ]);
  const dt = Date.now() - t;
  ok(exact(lab) && wrongOf(lab) === 0, `cap ${cap}: the lab read is fully answered, 0 wrong (${dt} ms)`);
  ok(ref === "Knee pain with suspected meniscal tear" && !!txt, `cap ${cap}: the referral read and the text call both answer (nothing lost)`);
  ok(proxy429 >= 1 && F.maxInFlight() === cap, `cap ${cap}: ${proxy429} busy answers, the in-flight limit learned down to ${F.maxInFlight()}`);
  ok(!calls.includes("openai/gpt-6-luna") && calls.filter((m) => m === H4).length === 2, `cap ${cap}: a busy slot never fired the fallback chain (haiku-4.5 served its 2 calls, luna never asked)`);
  ok(F.usable(H5) && F.usable(H4) && F.usable(G), `cap ${cap}: no model rested`);
  // the next read starts under the learned limit without a single busy answer
  proxy429 = 0; const r2 = await readLab("x", need, VOCAB, { tess: tess() });
  ok(exact(r2) && proxy429 === 0, `cap ${cap}: the next lab read queues behind the learned limit — 0 busy answers`);
  proxyCap = 0; F._resetLimit();
}
// 15. judged practice td750384c4e29: cap 1, a background gemini vote (the executor's eager example gate) HANGS and holds the
//     single slot; a referral read (the cross-provider pair haiku-5.5 + gemini, haiku-4.5 substitute) starts. The hard
//     timeout aborts the hung request and releases the slot; the referral's own gemini leg hangs too, is aborted, retried,
//     and the substitute answers: the pair agrees within the read's cap, 0 wrong, nothing left in flight.
{
  process.env.AGENT_MAX_IN_FLIGHT = "4"; process.env.AGENT_FAULT = ""; F._setListed([H5, H4, G]); F._resetHealth(); F._resetFaults(); F._resetLimit(); F.transportState.exhausted = false; F.transportState.switchedUntil = 0; S._reset();
  process.env.AGENT_HARD_TIMEOUT_TEXT_MS = "700"; process.env.AGENT_HARD_TIMEOUT_IMAGE_MS = "700"; process.env.AGENT_HARD_TIMEOUT_BACKGROUND_MS = "700";
  proxyCap = 1; proxy429 = 0; calls.length = 0; hangGeminiUntilAbort = true; aborts = 0;
  const { askDocumentPair } = await import("./llm.js");
  const bg = F.chat({ max_tokens: 20, messages: [{ role: "user", content: "example gate vote" }] }, { primary: G, fallbacks: [], attempts: 1, waitMs: 60000, cls: "background" }); // holds the slot, hangs
  await new Promise((r) => setTimeout(r, 30));
  const t = Date.now(); let why = ""; const ref = await askDocumentPair("What reason does it give for the referral?", "x", (w) => { why = w; }); const dt = Date.now() - t;
  const bgRes = await bg;
  ok(ref === "Knee pain with suspected meniscal tear" && dt < 6000, `cap 1 + hung gemini: the referral pair answers via the substitute in ${dt} ms (${why || "no decline"})`);
  ok(bgRes === null && aborts >= 2 && F.transportState.inFlight === 0, `the hung requests were aborted at the hard timeout (${aborts} aborts), their slots released, nothing in flight`);
  ok(calls.filter((m) => m === H5).length === 1 && calls.filter((m) => m === H4).length === 1 && calls.filter((m) => m === G).length >= 2, `the pair was haiku-5.5 + (gemini → hung twice →) haiku-4.5: calls ${calls.join(",")}`);
  ok(F.maxInFlight() === 1 && F.usable(H5) && F.usable(H4), "limit learned to 1; the readers' models never rested");
  hangGeminiUntilAbort = false; proxyCap = 0; F._resetLimit(); delete process.env.AGENT_HARD_TIMEOUT_TEXT_MS; delete process.env.AGENT_HARD_TIMEOUT_IMAGE_MS; delete process.env.AGENT_HARD_TIMEOUT_BACKGROUND_MS;
}
console.log(`${fail ? "✗" : "✓"} labFault: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
