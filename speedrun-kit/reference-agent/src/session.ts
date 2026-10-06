import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentConfig } from "./config";
import { type HarnessRun, offlineEnv } from "./harness";

/** Keeps OpenCode's data, state, and cache under the writable work directory. */
export function stateDirs(workDir: string): Record<string, string> {
  const base = join(workDir, "opencode-home");
  return {
    XDG_DATA_HOME: join(base, "data"),
    XDG_STATE_HOME: join(base, "state"),
    XDG_CACHE_HOME: join(base, "cache"),
  };
}

/** Environment for every OpenCode process the agent starts. */
export function opencodeEnv(config: AgentConfig): NodeJS.ProcessEnv {
  return { ...process.env, ...stateDirs(config.workDir) };
}

/** Milliseconds after which an export of a session transcript is given up. */
const exportTimeoutMs = 30_000;

/**
 * Writes the full transcript of an OpenCode session (`opencode export`) to `session.json` in the
 * log directory. Failures are written to `session-export.log` and never thrown.
 */
export function exportTranscript(
  config: AgentConfig,
  configPath: string,
  sessionId: string,
  logDir: string,
): Promise<void> {
  const out = createWriteStream(join(logDir, "session.json"));
  const err = createWriteStream(join(logDir, "session-export.log"));
  const child = spawn(config.opencodeBin, ["export", sessionId], {
    cwd: logDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...opencodeEnv(config), ...offlineEnv, OPENCODE_CONFIG: configPath },
  });
  child.stdout.pipe(out);
  child.stderr.pipe(err);
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), exportTimeoutMs);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    child.on("error", (error) => {
      err.write(`${String(error)}\n`);
      done();
    });
    child.on("close", done);
  });
}

/** Counts summed over the OpenCode runs of one warm-up or one case. */
export interface SessionStats {
  /** Model turns: one per completed model step. */
  turns: number;
  toolCalls: number;
  /** Calls of the Playwright MCP tools, whose names start with `browser_`. */
  browserCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Null when OpenCode reported no cost, which is the case when the model has no price set. */
  costUsd: number | null;
  sessionIds: string[];
  errors: number;
}

export function sessionStats(runs: readonly HarnessRun[]): SessionStats {
  let cost = 0;
  const stats: SessionStats = {
    turns: 0,
    toolCalls: 0,
    browserCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    costUsd: null,
    sessionIds: [],
    errors: 0,
  };
  for (const run of runs) {
    stats.turns += run.steps;
    stats.toolCalls += run.toolCalls.length;
    stats.browserCalls += run.toolCalls.filter((tool) => tool.startsWith("browser_")).length;
    stats.inputTokens += run.inputTokens;
    stats.outputTokens += run.outputTokens;
    stats.cacheReadTokens += run.cacheReadTokens;
    stats.errors += run.errors.length;
    cost += run.costUsd;
    if (run.sessionId !== null && !stats.sessionIds.includes(run.sessionId)) {
      stats.sessionIds.push(run.sessionId);
    }
  }
  if (cost > 0) stats.costUsd = cost;
  return stats;
}

/**
 * Writes the record of a warm-up or a case to `record.json` in its log directory and appends it
 * as one line to `records.jsonl` in the work directory.
 */
export async function writeRecord(
  config: AgentConfig,
  logDir: string,
  record: Record<string, unknown>,
): Promise<void> {
  await writeFile(join(logDir, "record.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await appendFile(join(config.workDir, "records.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
}
