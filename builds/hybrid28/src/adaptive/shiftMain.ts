/**
 * Adaptive agent entrypoint — same queue contract as the wrenfield agent, different brain.
 *
 *   launch + login + "all locations" → loop GET /item:
 *     message → compile to a durable rule/fact (reused from wrenfield) → feed later tasks as context.
 *     task    → solve() : learned-plan replay, else agentic ReAct + plan induction. Grounded → answer,
 *               else skip. Honors the shift deadline; a crash on one item never un-closes it.
 *
 * Run it with:  AGENT_ENTRY=adaptive  (the Dockerfile CMD dispatches), or directly via tsx.
 */
import { Crawler } from "../wrenfield/crawl.js";
import { Knowledge } from "./memory.js";
import { solve } from "./solver.js";
import { ShiftState } from "./state.js";
import type { ToolCtx } from "./tools.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Item = { id: string; kind: "task" | "message"; text: string };
type Close = { id: string; acknowledge?: true } | { id: string; answer: string } | { id: string; skip: true };

async function main() {
  const QUEUE = process.env.QUEUE_URL; if (!QUEUE) { console.error("QUEUE_URL not set — nothing to do"); process.exit(0); }
  const SITE = process.env.SITE_URL || "";
  const crawler = new Crawler(SITE);
  try { await crawler.launch(); } catch (e) { console.error("[adaptive] launch failed:", String(e)); }
  await crawler.login(process.env.SITE_USERNAME, process.env.SITE_PASSWORD).catch(() => {});
  await crawler.setAllLocations().catch(() => {});
  try { await (crawler as any).fetchToday?.(); } catch {}
  console.log(JSON.stringify({ event: "adaptive", step: "ready", site: SITE, today: (crawler as any).today }));

  const kb = new Knowledge();
  const ctx: ToolCtx = { crawler, note: () => {} };
  const shift = new ShiftState();
  const margin = Number(process.env.REFERENCE_DEADLINE_MARGIN_SECONDS ?? 5);

  const call = async (method: "GET" | "POST", path: string, body?: Close): Promise<any> => {
    let last = "no attempt";
    for (let i = 0; i < 5; i++) {
      try {
        const r = await fetch(`${QUEUE}${path}`, { method, signal: AbortSignal.timeout(15000), ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
        const json: any = await r.json();
        if (r.status === 200) return json;
        if (json?.state !== undefined) return json.state;
        last = `status ${r.status}`; if (r.status < 500) break;
      } catch (e) { last = String(e); }
      await sleep(1000);
    }
    throw new Error(`${method} ${path}: ${last}`);
  };

  let state: any = await call("GET", "/item");
  let closed = 0, correctish = 0, skipped = 0;
  while (state?.status === "open") {
    const item: Item = state.item;
    const secondsLeft = typeof state.seconds_left === "number" ? state.seconds_left : Infinity;
    if (secondsLeft <= margin) break;
    const t0 = Date.now();
    let action: Close;
    try {
      if (item.kind === "message") {
        await shift.ingestMessage(item.text); // statements update the state machine → change later answers
        action = { id: item.id, acknowledge: true };
      } else {
        const perTask = Number(process.env.ADAPTIVE_TASK_MS ?? 25000);
        const deadlineMs = Date.now() + Math.min(perTask, Math.max(0, (secondsLeft - margin) * 1000));
        const r = await solve(item.text, ctx, kb, shift, deadlineMs);
        if ("answer" in r) { action = { id: item.id, answer: r.answer }; shift.recordQA(item.text, r.answer, r.intent); correctish++; }
        else { action = { id: item.id, skip: true }; shift.recordQA(item.text, undefined, r.intent); skipped++; }
        process.stdout.write(JSON.stringify({ event: "item", n: closed + 1, kind: "task", ms: Date.now() - t0, text: item.text.slice(0, 120), result: "answer" in r ? { answer: r.answer, via: r.via, intent: r.intent } : { skip: true, reason: r.reason, intent: r.intent } }) + "\n");
      }
    } catch (e) {
      action = item.kind === "message" ? { id: item.id, acknowledge: true } : { id: item.id, skip: true };
      process.stdout.write(JSON.stringify({ event: "item", n: closed + 1, kind: item.kind, error: String(e).slice(0, 160) }) + "\n");
    }
    let resp: any; try { resp = await call("POST", "/item/close", action); } catch { break; } // queue unreachable → stop
    closed++;
    if (resp === "ended" || resp?.status === "ended") break;
    state = (resp && typeof resp === "object" && resp.status) ? resp : await call("GET", "/item"); // close returns the next state; reconcile otherwise
  }
  console.log(JSON.stringify({ event: "adaptive", step: "done", closed, answered: correctish, skipped, state: shift.summary(), learned: kb.summary() }));
  try { await crawler.close(); } catch {}
  await sleep(100); process.exit(0);
}

main().catch((e) => { console.error("[adaptive] fatal:", String(e)); process.exit(1); });
