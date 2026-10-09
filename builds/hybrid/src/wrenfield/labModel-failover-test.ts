// Offline: the judge proxy rejects / breaks the gemini lab call. Does labRead stay never-wrong?
// Stubs global fetch (no network). Run: npx tsx src/wrenfield/labModel-failover-test.ts (in gates.sh)
process.env.LLM_BASE_URL = "http://proxy.invalid/v1"; process.env.LLM_API_KEY = "test";
const { readLab, modelLab } = await import("./labRead.js");
const { transportState, chat } = await import("./failover.js");
export {};
let pass = 0, fail = 0; const ok = (c: boolean, m: string) => { if (c) { pass++; console.log("✓ " + m); } else { fail++; console.log("✗ " + m); } };
const VOCAB = ["Sodium", "Potassium", "Creatinine"];
const need = { tests: VOCAB, meta: ["collected", "report", "record"] as any };
type Mode = "400" | "500" | "hang" | "ok" | "no-model-echo";
let mode: Record<string, Mode> = {};
const answers: Record<string, any> = {
  "anthropic/claude-haiku-4.5": { collected: "2025-11-04", report_number: "LR-1", record_number: "MR-9", rows: [{ test: "Sodium", result: "145" }, { test: "Potassium", result: "5.9" /* misread */ }, { test: "Creatinine", result: "1.17" }] },
  "google/gemini-3.8-flash": { collected: "2025-11-04", report_number: "LR-1", record_number: "MR-9", rows: [{ test: "Sodium", result: "145" }, { test: "Potassium", result: "5.9" /* same misread */ }, { test: "Creatinine", result: "1.17" }] },
};
const calls: string[] = [];
(globalThis as any).fetch = async (url: string, init: any) => {
  const body = JSON.parse(init.body); const m = body.model as string; calls.push(m + (body.reasoning ? "+reasoning" : ""));
  const md = mode[m] ?? "ok";
  const resp = (status: number, json: any) => ({ ok: status === 200, status, json: async () => json, headers: new Map() as any });
  if (md === "400") return resp(400, { error: { code: "bad_request", message: "unknown field reasoning" } });
  if (md === "500") return resp(502, { error: { code: "upstream_error" } });
  if (md === "hang") return new Promise((_, rej) => init.signal?.addEventListener("abort", () => rej(new Error("AbortError"))));
  const content = JSON.stringify(answers[m]);
  return resp(200, { ...(md === "no-model-echo" ? {} : { model: m }), choices: [{ message: { content } }] });
};
const tessGood = Promise.resolve({ values: { Sodium: 145, Potassium: 5.0, Creatinine: 1.17 }, collected: "2025-11-04", report: "LR1", record: "MR9", ms: 5 });

// 1. gemini 400 (e.g. `reasoning` rejected): gemini marked bad, haiku tiebreak decides against tesseract
mode = { "google/gemini-3.8-flash": "400" };
let r = await readLab("x", need, VOCAB, { tess: tessGood });
ok(transportState.bad.has("google/gemini-3.8-flash"), "400 on gemini marks it unusable for the shift");
ok(r.read.values.Sodium === 145 && r.read.values.Creatinine === 1.17, "fields where tesseract == haiku are kept");
ok(r.read.values.Potassium === undefined && r.trace.unknown.includes("test:Potassium"), "haiku misread (5.9 vs tess 5.0) → unknown, never taken");
ok(r.read.collected === "2025-11-04" && r.read.report === "LR1" && r.read.record === "MR9", "meta agreed by tesseract + haiku");
const g0 = calls.filter((c) => c.startsWith("google")).length;
const t1 = Date.now(); r = await readLab("x", need, VOCAB, { tess: tessGood }); const dt = Date.now() - t1;
ok(dt < 1000 && calls.filter((c) => c.startsWith("google")).length === g0, `later reports don't call gemini again (first report: ${g0} gemini calls; then ${dt} ms)`);

// 2. tesseract missing (binary absent → ok:false → null) + gemini 400: only haiku → nothing kept
r = await readLab("x", need, VOCAB, { tess: Promise.resolve(null) });
ok(Object.keys(r.read.values).length === 0 && !r.read.collected, "no tesseract + no gemini → every field unknown (engine skips)");

// 3. gemini 5xx: fallbacks [] → no other model answers as "gemini"
transportState.bad.clear(); mode = { "google/gemini-3.8-flash": "500" };
const g = await modelLab("x", "google/gemini-3.8-flash", need, VOCAB, 3000);
ok(g === null, "gemini 5xx twice → null (no substitute model)");

// 4. sticky switch: a haiku-primary call failed over to gemini; then the lab TIEBREAK (haiku) runs
transportState.bad.clear(); mode = { "anthropic/claude-haiku-4.5": "500" };
const j = await chat({ messages: [] }, { primary: "anthropic/claude-haiku-4.5", fallbacks: ["google/gemini-3.8-flash"], attempts: 2, waitMs: 5000 });
ok(!!j && transportState.switched === "google/gemini-3.8-flash", "haiku failure → sticky switch to gemini for 60 s");
mode = { "google/gemini-3.8-flash": "ok" };
calls.length = 0;
const hb = await modelLab("x", "anthropic/claude-haiku-4.5", need, VOCAB, 3000);
ok(calls.every((c) => c.startsWith("anthropic/")), `pinned tiebreak goes to haiku only, never the sticky gemini (calls: ${calls.join(",")})`);
ok(hb !== null && hb.values.Potassium === 5.9, "the tiebreak is a real haiku read");
calls.length = 0; mode = { "google/gemini-3.8-flash": "no-model-echo" };
const hb2 = await modelLab("x", "anthropic/claude-haiku-4.5", need, VOCAB, 3000);
ok(calls.every((c) => c.startsWith("anthropic/")), `no model echo: still only haiku was asked (calls: ${calls.join(",")})`);
console.log(`${fail ? "✗" : "✓"} gemini-fail: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
