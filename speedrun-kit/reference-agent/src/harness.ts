import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * Environment for OpenCode that turns off every feature that reaches the internet: update checks,
 * the models.dev catalog, LSP downloads, default plugins, and session sharing.
 */
export const offlineEnv = {
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
  OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
  OPENCODE_DISABLE_SHARE: "1",
  OPENCODE_DISABLE_CLAUDE_CODE: "1",
  OPENCODE_DISABLE_TERMINAL_TITLE: "1",
} as const;

/** Milliseconds between SIGTERM and SIGKILL when the harness is stopped. */
const killGraceMs = 1000;

const eventSchema = z.object({
  type: z.string(),
  sessionID: z.string().optional(),
  part: z
    .object({
      type: z.string().optional(),
      text: z.string().optional(),
      tool: z.string().optional(),
      cost: z.number().optional(),
      tokens: z
        .object({
          input: z.number().optional(),
          output: z.number().optional(),
          cache: z.object({ read: z.number().optional() }).partial().optional(),
        })
        .partial()
        .optional(),
    })
    .passthrough()
    .optional(),
  error: z.unknown().optional(),
});

export interface HarnessRun {
  /** Text parts the model produced, in order. */
  text: string;
  timedOut: boolean;
  exitCode: number | null;
  steps: number;
  toolCalls: string[];
  /** Input tokens including cache reads. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Sum of the cost OpenCode reports per step. Zero when the model has no price configured. */
  costUsd: number;
  /** OpenCode session id, from the events. Null until an event carried one. */
  sessionId: string | null;
  errors: unknown[];
}

export interface HarnessOptions {
  bin: string;
  prompt: string;
  /** Working directory for OpenCode. */
  dir: string;
  /** Directory for the event and stderr logs of this run. */
  logDir: string;
  configPath: string;
  /** Absolute time (ms since epoch) at which the harness is stopped. */
  deadline: number;
  env: NodeJS.ProcessEnv;
  /** Session to continue instead of starting a new one. */
  sessionId?: string;
}

/**
 * Runs `opencode run` once and collects its JSON events. The process is started in its own
 * process group so that stopping it at the deadline also stops the MCP server and the browser.
 */
export function runHarness(options: HarnessOptions): Promise<HarnessRun> {
  const result: HarnessRun = {
    text: "",
    timedOut: false,
    exitCode: null,
    steps: 0,
    toolCalls: [],
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    sessionId: null,
    errors: [],
  };
  const eventLog = createWriteStream(join(options.logDir, "events.jsonl"));
  const stderrLog = createWriteStream(join(options.logDir, "stderr.log"));

  const args = ["run", "--format", "json", "--auto", "--dir", options.dir];
  if (options.sessionId !== undefined) args.push("--session", options.sessionId);
  args.push(options.prompt);
  const child = spawn(options.bin, args, {
    cwd: options.dir,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    // OpenCode takes its working directory from PWD when it is set.
    env: { ...options.env, ...offlineEnv, OPENCODE_CONFIG: options.configPath, PWD: options.dir },
  });

  let buffered = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    eventLog.write(chunk);
    buffered += chunk;
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      handleLine(buffered.slice(0, newline), result);
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf("\n");
    }
  });
  child.stderr.pipe(stderrLog);

  const killGroup = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // The group has already exited.
    }
  };

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      handleLine(buffered, result);
      eventLog.end();
      stderrLog.end();
      resolve(result);
    };
    const deadlineTimer = setTimeout(
      () => {
        result.timedOut = true;
        killGroup("SIGTERM");
        setTimeout(() => {
          killGroup("SIGKILL");
          finish();
        }, killGraceMs);
      },
      Math.max(0, options.deadline - Date.now()),
    );
    child.on("error", (error) => {
      result.errors.push(String(error));
      finish();
    });
    child.on("exit", (code) => {
      result.exitCode = code;
      // Stop the MCP server and browser that OpenCode started, if they are still running.
      killGroup("SIGKILL");
      finish();
    });
  });
}

function handleLine(line: string, result: HarnessRun): void {
  if (line.trim() === "") return;
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return;
  }
  const event = eventSchema.safeParse(json);
  if (!event.success) return;
  const { type, sessionID, part, error } = event.data;
  if (result.sessionId === null && sessionID !== undefined) result.sessionId = sessionID;
  if (type === "text" && part?.text !== undefined) {
    result.text += `${part.text}\n`;
  } else if (type === "tool_use" && part?.tool !== undefined) {
    result.toolCalls.push(part.tool);
  } else if (type === "step_finish") {
    result.steps += 1;
    const cacheRead = part?.tokens?.cache?.read ?? 0;
    result.inputTokens += (part?.tokens?.input ?? 0) + cacheRead;
    result.cacheReadTokens += cacheRead;
    result.outputTokens += part?.tokens?.output ?? 0;
    result.costUsd += part?.cost ?? 0;
  } else if (type === "error") {
    result.errors.push(error);
  }
}
