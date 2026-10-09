import { createServer } from 'node:http';
import assert from 'node:assert/strict';
const behave = {}; const seen = []; let disconnects = 0;
const srv = createServer(async (req, res) => {
  let b = ''; for await (const c of req) b += c; const { model } = JSON.parse(b); seen.push(model);
  req.on('close', () => { if (!res.writableEnded) disconnects++; });
  const k = behave[model] ?? 'ok';
  const reply = (st, j) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
  if (k === 'hang') return setTimeout(() => reply(200, { choices: [{ message: { content: 'late-' + model } }] }), 1500);
  if (k === '429') return reply(429, { error: { code: 'concurrency_limit' } });
  if (k === '400') return reply(400, { error: { code: 'bad_model' } });
  reply(200, { choices: [{ message: { content: 'ok-' + model } }] });
});
await new Promise(r => srv.listen(0, r));
Object.assign(process.env, { LLM_BASE_URL: `http://127.0.0.1:${srv.address().port}`, LLM_API_KEY: 'k', AGENT_HANG_MS: '300', AGENT_FALLBACK_MODELS: 'B,C' });
const { chat, transportState } = await import(process.argv[2] ?? new URL("./failover.ts", import.meta.url).href);
const body = { messages: [] };
// 1. primary hangs -> B raced after 300 ms wins; A not aborted
behave.A = 'hang'; let t = Date.now(); let j = await chat(body, { primary: 'A' });
assert.equal(j.choices[0].message.content, 'ok-B'); assert.ok(Date.now() - t < 900, 'switched fast');
await new Promise(r => setTimeout(r, 1600)); assert.equal(disconnects, 0, 'hung request never aborted');
// 2. sticky: next call goes to B first
seen.length = 0; behave.A = 'ok'; j = await chat(body, { primary: 'A' }); assert.equal(seen[0], 'B');
// 3. 429 on primary -> retried on next model
transportState.switchedUntil = 0; seen.length = 0; behave.A = '429'; j = await chat(body, { primary: 'A' });
assert.deepEqual(seen, ['A', 'B']); assert.equal(j.choices[0].message.content, 'ok-B');
// 4. 400 marks model bad for the shift
behave.C = '400'; transportState.switchedUntil = 0; behave.A = '429'; behave.B = '429'; seen.length = 0;
j = await chat(body, { primary: 'A' }); assert.equal(j, null); assert.deepEqual(seen, ['A', 'B', 'C']); assert.ok(transportState.bad.has('C'));
// 5. waitMs: stop waiting without aborting
behave.A = 'hang'; behave.B = 'hang'; transportState.bad.clear(); behave.C = 'hang'; transportState.switchedUntil = 0;
t = Date.now(); j = await chat(body, { primary: 'A', waitMs: 200 }); assert.equal(j, null); assert.ok(Date.now() - t < 400);
await new Promise(r => setTimeout(r, 1700)); assert.equal(disconnects, 0);
console.log('failover: 5/5 scenarios pass');
srv.close(); process.exit(0);
