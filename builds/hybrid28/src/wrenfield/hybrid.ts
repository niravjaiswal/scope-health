/**
 * Two agents, one queue (TWO-AGENTS.md). Reads the queue's first item (GET /item only reads), tells the set apart the way profile.ts
 * does, and runs per HYBRID_ROUTES = {"set1"|"set2"|"set3"|"practice"|"default": "ours"|"tool"|"split"}:
 *  - ours / tool: that agent alone runs the shift against the real queue;
 *  - split: both agents run, each against its own local queue (a Lane); split-alt (practice checks) alternates tasks between
 *    them. The dispatcher here reads the real queue: a message goes
 *    to both agents (each acknowledges), a task goes to ours when one of our families claims it (families.ts) or the lookup path
 *    parses it, else to the tool-loop agent's; a task ours skips goes on to the tool-loop agent's (HYBRID_FALLBACK=off stops that). Each answer is closed on
 *    the real queue as the agent sent it. An agent that does not close its item in time (HYBRID_TASK_S / HYBRID_MSG_S) or has
 *    exited is skipped past.
 *   npx tsx src/wrenfield/hybrid.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { detectSet } from "./profile.js";
import { familyMatch } from "./families.js";
import { lookupSpec } from "./lookup.js";

type Who = "ours" | "tool";
export type Close = { id: string; answer?: unknown; skip?: boolean; acknowledge?: boolean };

export function route(routes: Record<string, string>, set: string | null): Who | "split" {
  const r = routes[set ?? "default"] ?? routes.default;
  return r === "ours" ? "ours" : (r === "split" || r === "split-alt") ? "split" : "tool";
}
/** Split mode: which agent a task goes to first. */
export const pick = (text: string): Who => (familyMatch(text) || !("why" in lookupSpec(text)) ? "ours" : "tool");

/** One agent's view of the queue: the dispatcher offers it a state; its GET / close requests are answered from here. */
export class Lane {
  private cur: any = null; private done: ((c: Close | null) => void) | null = null; private park: ((s: any) => void) | null = null;
  private ended: any = null; private lastId = "";
  alive = true;
  constructor(readonly name: Who) {}
  /** Offer `s` (an open state); resolves with the agent's close of that item, or null when `ms` passes / the agent is gone. */
  give(s: any, ms: number): Promise<Close | null> {
    if (!this.alive) return Promise.resolve(null);
    this.cur = s;
    const p = new Promise<Close | null>((res) => { this.done = res; });
    const t = setTimeout(() => this.drop(), ms);
    if (this.park) { const r = this.park; this.park = null; r(s); }
    return p.finally(() => clearTimeout(t));
  }
  /** Stop waiting on the current item (time out / agent gone): a late close of it is answered as not_current. */
  drop(): void { const d = this.done; this.done = null; this.cur = null; d?.(null); }
  die(): void { this.alive = false; this.drop(); }
  end(s: any): void { this.ended = s; this.drop(); if (this.park) { const r = this.park; this.park = null; r(s); } }
  private wait(): Promise<any> {
    if (this.ended) return Promise.resolve(this.ended);
    if (this.cur) return Promise.resolve(this.cur);
    return new Promise((res) => { this.park = res; }); // a retried request replaces a dead one
  }
  /** HTTP GET /item */
  get(): Promise<any> { return this.wait(); }
  /** HTTP POST /item/close → [status, body] */
  async close(c: Close): Promise<[number, any]> {
    if (this.ended) return [409, { error: { code: "ended", message: "the shift has ended" }, state: this.ended }];
    const it = this.cur?.item;
    if (it && c?.id === it.id) {
      const msg = it.kind === "message";
      if (msg ? c.acknowledge !== true : c.acknowledge === true || (c.skip !== true && c.answer === undefined))
        return [422, { error: { code: "wrong_action", message: `item ${it.id} is a ${it.kind}` } }];
      const d = this.done; this.done = null; this.cur = null; this.lastId = c.id; d?.(c);
      return [200, await this.wait()];
    }
    if (c?.id === this.lastId && !this.cur) return [200, await this.wait()]; // a retry of the close we already took
    if (this.cur) return [409, { error: { code: "not_current", message: `item ${c?.id} is not the open item` }, state: this.cur }];
    return [200, await this.wait()];
  }
}

export function serve(lane: Lane): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req, res) => {
    const send = (code: number, body: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    try {
      if (req.method === "GET" && req.url === "/item") return send(200, await lane.get());
      if (req.method === "POST" && req.url === "/item/close") {
        let raw = ""; for await (const ch of req) raw += ch;
        let c: Close; try { c = JSON.parse(raw); } catch { return send(400, { error: { code: "bad_request", message: "not JSON" } }); }
        const [code, body] = await lane.close(c); return send(code, body);
      }
      send(404, { error: { code: "not_found", message: "no such route" } });
    } catch (e) { send(500, { error: { code: "internal", message: String(e).slice(0, 200) } }); }
  });
  server.keepAliveTimeout = 0; server.requestTimeout = 0; server.headersTimeout = 0;
  return new Promise((res) => server.listen(0, "127.0.0.1", () => res({ server, url: `http://127.0.0.1:${(server.address() as any).port}` })));
}

/** The real queue, with the agents' own retry rule (a 409 carries the state). */
export function realQueue(base: string, fetcher: typeof fetch = fetch) {
  const call = async (method: "GET" | "POST", path: string, body?: unknown): Promise<any> => {
    let last = "";
    for (let i = 0; i < 5; i++) {
      try {
        const r = await fetcher(base.replace(/\/$/, "") + path, { method, signal: AbortSignal.timeout(15000),
          ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
        const j: any = await r.json();
        if (r.status === 200) return j;
        if (j?.state !== undefined) return j.state;
        last = `${r.status} ${JSON.stringify(j).slice(0, 160)}`;
        if (r.status < 500) break;
      } catch (e) { last = String(e); }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`${method} ${path}: ${last}`);
  };
  return { get: () => call("GET", "/item"), close: (c: Close) => call("POST", "/item/close", c) };
}

/** Extra env for ours in split mode (JSON object of strings in HYBRID_OURS_SPLIT_ENV); bad JSON = none. */
export function splitEnv(raw = process.env.HYBRID_OURS_SPLIT_ENV): Record<string, string> {
  try { const o = JSON.parse(raw ?? "{}"); return o && typeof o === "object" && !Array.isArray(o) ? Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v === "string")) as Record<string, string> : {}; } catch { return {}; }
}

const log = (o: Record<string, unknown>) => { try { process.stdout.write(JSON.stringify({ event: "hybrid", ...o }) + "\n"); } catch {} };

/** An answer the real queue takes (shift.md): a non-empty string, a finite number, or a non-empty list of those. Anything else
 *  (true / false / null / an object) would be refused with 400 bad_request, so it is closed as a skip instead. */
export const validAnswer = (a: unknown): boolean =>
  typeof a === "string" ? a.trim() !== "" : typeof a === "number" ? Number.isFinite(a)
    : Array.isArray(a) && a.length > 0 && a.every((x) => (typeof x === "string" && x.trim() !== "") || (typeof x === "number" && Number.isFinite(x)));

/** Feed the real queue's items to the lanes until the shift ends. One item's failure never ends the shift: a refused answer is
 *  retried as a skip, a failed close re-reads the state; an agent that times out `breakAfter` times in a row gets no more items;
 *  a message an agent missed is delivered to it before its next task. */
export async function dispatch(q: { get(): Promise<any>; close(c: Close): Promise<any> }, lanes: Record<Who, Lane>,
  opts: { pick?: (text: string) => Who; taskMs?: number; msgMs?: number; fallback?: boolean; quiet?: boolean; breakAfter?: number } = {}): Promise<any> {
  const choose = opts.pick ?? pick, taskMs = opts.taskMs ?? 90_000, msgMs = opts.msgMs ?? 60_000, fallback = opts.fallback ?? true, breakAfter = opts.breakAfter ?? 3;
  const n = { ours: 0, tool: 0, fallback: 0, answered: 0, skipped: 0, timeouts: 0, invalid: 0, closeErrors: 0, broken: [] as Who[] };
  const misses: Record<Who, number> = { ours: 0, tool: 0 }, backlog: Record<Who, any[]> = { ours: [], tool: [] };
  const other = (w: Who): Who => (w === "ours" ? "tool" : "ours");
  /** give with the breaker: a reply resets the count; `breakAfter` time-outs in a row and the lane gets nothing more */
  const offer = async (w: Who, st: any, ms: number): Promise<Close | null> => {
    if (!lanes[w].alive) return null;
    const r = await lanes[w].give(st, ms);
    if (r) misses[w] = 0;
    else if (lanes[w].alive && ++misses[w] >= breakAfter) { lanes[w].die(); n.broken.push(w); log({ breaker: w, misses: misses[w] }); }
    return r;
  };
  /** deliver the memos `w` missed, oldest first, waiting up to `ms` for each; false when one is still not taken (kept for next time) */
  const flush = async (w: Who, ms: number): Promise<boolean> => {
    while (backlog[w].length && lanes[w].alive) { if (!(await offer(w, backlog[w][0], ms))) return false; backlog[w].shift(); }
    return lanes[w].alive;
  };
  const closeSafe = async (c: Close): Promise<any> => {
    try { return await q.close(c); } catch (e) {
      n.closeErrors++; if (!opts.quiet) log({ closeError: String(e).slice(0, 200), id: c.id });
      if (c.answer !== undefined) { try { return await q.close({ id: c.id, skip: true }); } catch {} }
      for (let i = 0; i < 3; i++) { try { return await q.get(); } catch { await new Promise((r) => setTimeout(r, 1000)); } }
      throw e;
    }
  };
  let s: any = await q.get(), stuck = 0;
  try {
    while (s?.status === "open") {
      const it = s.item; let c: Close | null = null;
      if (it.kind === "message") {
        await Promise.all((["ours", "tool"] as Who[]).map(async (w) => {
          if (!lanes[w].alive) return;
          if (!(await flush(w, msgMs)) || !(await offer(w, s, msgMs))) { if (lanes[w].alive) backlog[w].push(s); }
        }));
        c = { id: it.id, acknowledge: true };
      } else {
        let who = choose(it.text); if (!lanes[who].alive) who = other(who);
        n[who]++;
        c = (await flush(who, taskMs)) ? await offer(who, s, taskMs) : null; if (!c) n.timeouts++;
        if (fallback && who === "ours" && (!c || c.skip) && lanes.tool.alive) {
          const s2 = await q.get().catch(() => null); // the same item, with the current seconds_left
          if (s2?.status === "open" && s2.item?.id === it.id && (s2.seconds_left ?? 0) > 20) { n.fallback++; c = ((await flush("tool", taskMs)) ? await offer("tool", s2, taskMs) : null) ?? c; }
        }
        if (c && !c.skip && c.answer !== undefined && !validAnswer(c.answer)) { n.invalid++; c = null; }
        c = c && !c.skip && c.answer !== undefined ? { id: it.id, answer: c.answer } : { id: it.id, skip: true };
        if (c.skip) n.skipped++; else n.answered++;
        if (!opts.quiet) log({ n: it.id, to: who, answered: !c.skip });
      }
      s = await closeSafe(c);
      if (s?.status === "open" && s.item?.id === it.id) { if (++stuck > 2) throw new Error(`item ${it.id} stays open after ${stuck} closes`); } else stuck = 0;
    }
  } finally {
    const fin = s?.status === "open" ? { status: "ended", reason: "error" } : s;
    for (const w of ["ours", "tool"] as Who[]) lanes[w].end(fin);
    if (!opts.quiet) log({ done: true, ...n, state: fin });
  }
  return s;
}

if (process.argv[1]?.endsWith("hybrid.ts")) {
  (async () => {
    console.log(JSON.stringify({ event: "version", commit: process.env.AGENT_GIT_SHA ?? "unknown", branch: process.env.AGENT_GIT_BRANCH ?? "unknown",
      dirty: process.env.AGENT_GIT_DIRTY ?? "unknown", subject: process.env.AGENT_GIT_SUBJECT ?? "", builtAt: process.env.AGENT_BUILT_AT ?? "unknown" }));
    let routes: Record<string, string> = {};
    try { routes = JSON.parse(process.env.HYBRID_ROUTES ?? "{}"); } catch {}
    const QUEUE = (process.env.QUEUE_URL ?? "").replace(/\/$/, "");
    let first: any;
    for (let i = 0; i < 5 && !first && QUEUE; i++) {
      try { const s: any = await (await fetch(QUEUE + "/item")).json(); if (s?.status !== "open") break; first = s.item; }
      catch { await new Promise((r) => setTimeout(r, 500)); }
    }
    const { set, why } = detectSet(Number(process.env.SHIFT_SECONDS), first);
    const mode = route(routes, set), alt = (routes[set ?? "default"] ?? routes.default) === "split-alt";
    console.log(JSON.stringify({ event: "hybrid", set, why, agent: alt ? "split-alt" : mode }));
    // the tool-loop agent's diagnostics answer garbage / stop early on purpose on Set 3 (score side channels): never on in this image.
    const base = { ...process.env }; for (const k of Object.keys(base)) if (k.startsWith("DIAG_")) delete base[k];
    const start = (who: Who, queueUrl: string, extra: Record<string, string> = {}): ChildProcess => {
      const [cmd, args, cwd] = who === "tool" ? ["/app/toolagent/venv/bin/python", ["-u", "-m", "sr.main"], "/app/toolagent"] : ["npx", ["tsx", "src/wrenfield/shiftMain.ts"], "/app"];
      return spawn(cmd as string, args as string[], { cwd: cwd as string, stdio: "inherit", env: { ...base, QUEUE_URL: queueUrl, ...extra } });
    };
    if (mode !== "split") {
      const p = start(mode, process.env.QUEUE_URL ?? "");
      for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => p.kill(sig));
      p.on("exit", (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
      return;
    }
    const lanes = { ours: new Lane("ours"), tool: new Lane("tool") };
    const [so, sn] = await Promise.all([serve(lanes.ours), serve(lanes.tool)]);
    const kids = [
      // ours in split mode: its deterministic readers + lookup only (HYBRID_OURS_SPLIT_ENV turns its slow model tiers off), so a task it
      // cannot answer fast goes straight on to the tool-loop agent instead of costing the time twice
      start("ours", so.url, { AGENT_QUEUE_TIMEOUT_MS: "3600000", ...splitEnv() }),
      start("tool", sn.url, { QUEUE_TIMEOUT_S: "3600" }),
    ];
    kids.forEach((k, i) => {
      const w: Who = i ? "tool" : "ours";
      k.on("exit", (code, sig) => { lanes[w].die(); log({ exited: w, code, sig }); });
      k.on("error", (e) => { lanes[w].die(); log({ spawnError: w, error: String(e).slice(0, 200) }); }); // a failed spawn: that agent is gone, the other gets its items
    });
    for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => kids.forEach((k) => k.kill(sig)));
    let end: any = null;
    try {
      let k = 0; // split-alt: every other task to each agent (a practice run then exercises both)
      end = await dispatch(realQueue(QUEUE), lanes, { ...(alt ? { pick: () => (k++ % 2 ? "tool" : "ours") as Who } : {}), taskMs: Number(process.env.HYBRID_TASK_S ?? 90) * 1000, msgMs: Number(process.env.HYBRID_MSG_S ?? 60) * 1000,
        fallback: process.env.HYBRID_FALLBACK !== "off" });
    } catch (e) { log({ error: String(e).slice(0, 300) }); }
    // let both agents see the end and finish their own logs, then exit
    await Promise.race([Promise.all(kids.map((k) => new Promise((r) => (k.exitCode !== null || k.signalCode !== null ? r(null) : k.on("exit", r))))), new Promise((r) => setTimeout(r, 15000))]);
    kids.forEach((k) => { if (k.exitCode === null && k.signalCode === null) k.kill("SIGTERM"); });
    so.server.close(); sn.server.close();
    process.exit(end ? 0 : 1);
  })();
}
