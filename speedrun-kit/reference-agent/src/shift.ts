import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type CloseRequest,
  type QueueItem,
  type QueueState,
  queueErrorSchema,
  queueStateSchema,
  type TaskAnswer,
  taskAnswerSchema,
} from "@arena/contracts";
import { answerFileName, extractAnswerTag, readAnswerFile } from "./answer";
import type { AgentConfig } from "./config";
import { runHarness } from "./harness";
import { exportTranscript, opencodeEnv, sessionStats, writeRecord } from "./session";
import { buildTaskPrompt } from "./shiftPrompt";

/**
 * Shift mode: the agent asks the queue API for one item at a time. It acknowledges a message
 * and keeps its text. For a task it runs one OpenCode session that gets the task and every
 * message received so far, and closes the task with the session's answer, or skips it.
 */

/** Characters of the model's last reply kept in a record. */
const finalTextChars = 2000;

/** Tries of one request to the queue API, and the pause between them. */
const queueAttempts = 5;
const queueRetryMs = 1000;

/** The queue API of a shift, as the agent uses it. */
export interface QueueClient {
  current(): Promise<QueueState>;
  /** Closes the open item. Returns the state after it. */
  close(request: CloseRequest): Promise<QueueState>;
}

export function createQueueClient(queueUrl: string): QueueClient {
  const call = async (
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<QueueState> => {
    let last = "no attempt was made";
    for (let attempt = 1; attempt <= queueAttempts; attempt++) {
      try {
        const response = await fetch(`${queueUrl}${path}`, {
          method,
          ...(body === undefined
            ? {}
            : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        });
        const json: unknown = await response.json();
        if (response.status === 200) return queueStateSchema.parse(json);
        // A refusal that names the current state: the item was closed already, or the shift
        // has ended. The agent goes on from that state.
        const refusal = queueErrorSchema.safeParse(json);
        if (refusal.success && refusal.data.state !== undefined) return refusal.data.state;
        last = `status ${response.status}: ${JSON.stringify(json).slice(0, 300)}`;
        // The request itself was refused. Sending it again changes nothing.
        if (response.status < 500) break;
      } catch (error) {
        last = String(error);
      }
      await sleep(queueRetryMs);
    }
    throw new Error(`${method} ${path} failed: ${last}`);
  };
  return {
    current: () => call("GET", "/item"),
    close: (request) => call("POST", "/item/close", request),
  };
}

/**
 * Turns the model's raw answer text into the answer of a task. Null when the text is empty or
 * says null. Text that is a JSON string, number, or list of them is that value. Any other text
 * is the answer as it is.
 */
export function parseTaskAnswer(raw: string | null): TaskAnswer | null {
  if (raw === null) return null;
  const fenced = /^```[a-z]*\s*([\s\S]*?)\s*```$/i.exec(raw.trim());
  const text = (fenced?.[1] ?? raw).trim();
  if (text === "" || text.toLowerCase() === "null") return null;
  let value: unknown = text;
  try {
    value = JSON.parse(text);
  } catch {
    // Not JSON: the text itself is the answer.
  }
  if (value === null) return null;
  const parsed = taskAnswerSchema.safeParse(value);
  return parsed.success ? parsed.data : text;
}

export interface TaskOutcome {
  answer: TaskAnswer | null;
  /** Where the answer came from. `timeout` means the session was stopped with no answer file. */
  source: "reply" | "file" | "timeout" | "none" | "no_time";
  [field: string]: unknown;
}

/**
 * The transcript export started last. The next task waits for it, because an OpenCode process
 * that starts while an export holds OpenCode's database fails with "database is locked".
 */
let pendingExport: Promise<void> = Promise.resolve();

let taskCounter = 0;

/**
 * Works one task in a new OpenCode session. The session is stopped after `taskSeconds`, or
 * `deadlineMarginSeconds` before the shift ends, whichever comes first. The answer comes from
 * the final reply, or from the answer file, or is null, which skips the task.
 */
export async function workTask(
  config: AgentConfig,
  configPath: string,
  item: QueueItem,
  messages: readonly string[],
  secondsLeft: number,
): Promise<TaskOutcome> {
  await pendingExport;
  taskCounter += 1;
  const startedAt = Date.now();
  const safeId = item.id.replace(/[^A-Za-z0-9_-]/g, "_");
  const logDir = join(config.workDir, "logs", `task-${taskCounter}-${safeId}`);
  await mkdir(logDir, { recursive: true });
  const seconds = Math.min(config.taskSeconds, secondsLeft - config.deadlineMarginSeconds);
  if (seconds < config.taskMinimumSeconds) {
    const record = {
      kind: "task",
      id: item.id,
      index: taskCounter,
      answer: null,
      source: "no_time",
    };
    await writeRecord(config, logDir, record);
    return { ...record, answer: null, source: "no_time" };
  }
  // Every task runs in the same, emptied directory, which keeps OpenCode's system prompt equal.
  const dir = join(config.workDir, "question");
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  const prompt = buildTaskPrompt({
    site: {
      siteUrl: config.siteUrl,
      username: config.siteUsername,
      password: config.sitePassword,
    },
    messages,
    task: item.text,
    notes: config.notes,
    answerFile: join(dir, answerFileName),
    secondsAvailable: seconds,
  });
  await writeFile(join(logDir, "prompt.md"), prompt, "utf8");
  const run = await runHarness({
    bin: config.opencodeBin,
    prompt,
    dir,
    logDir,
    configPath,
    deadline: startedAt + seconds * 1000,
    env: opencodeEnv(config),
  });

  let answer: TaskAnswer | null = null;
  let source: TaskOutcome["source"] = run.timedOut ? "timeout" : "none";
  const replied = extractAnswerTag(run.text);
  if (replied !== null) {
    answer = parseTaskAnswer(replied);
    source = "reply";
  } else {
    const fromFile = await readAnswerFile(dir);
    if (fromFile !== null) {
      answer = parseTaskAnswer(fromFile);
      source = "file";
    }
  }
  const stats = sessionStats([run]);
  const record = {
    kind: "task",
    id: item.id,
    index: taskCounter,
    task: item.text,
    messages: messages.length,
    answer,
    source,
    timedOut: run.timedOut,
    exitCode: run.exitCode,
    seconds: (Date.now() - startedAt) / 1000,
    ...stats,
    logDir,
    finalText: run.text.trim().slice(-finalTextChars),
  };
  await writeRecord(config, logDir, record);
  const sessionId = stats.sessionIds[0];
  if (sessionId !== undefined) {
    pendingExport = exportTranscript(config, configPath, sessionId, logDir);
  }
  const { finalText: _finalText, ...summary } = record;
  return { ...summary, answer, source };
}

/**
 * Works the shift until the queue API says it has ended. Returns the number of items closed
 * and the texts of the messages received.
 */
export async function runShift(
  config: AgentConfig,
  configPath: string,
  queue: QueueClient,
): Promise<{ closed: number; messages: string[]; reason: string }> {
  const messages: string[] = [];
  let closed = 0;
  let state = await queue.current();
  while (state.status === "open") {
    const { item } = state;
    if (item.kind === "message") {
      // Every message is kept: one that gives a workflow is what later tasks are done by.
      messages.push(item.text);
      console.log(JSON.stringify({ event: "message", id: item.id, characters: item.text.length }));
      state = await queue.close({ id: item.id, acknowledge: true });
    } else {
      const outcome = await workTask(config, configPath, item, messages, state.seconds_left);
      console.log(JSON.stringify({ event: "task", ...outcome }));
      state = await queue.close(
        outcome.answer === null
          ? { id: item.id, skip: true }
          : { id: item.id, answer: outcome.answer },
      );
    }
    closed += 1;
  }
  return { closed, messages, reason: state.reason };
}
