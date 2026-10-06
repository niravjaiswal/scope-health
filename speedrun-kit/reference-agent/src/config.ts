import { agentEnv } from "@arena/contracts";
import { z } from "zod";

/** Model used when REFERENCE_MODEL is not set. An OpenRouter model id. */
export const defaultModel = "anthropic/claude-sonnet-5.5";

/** What the agent reads from its environment in every mode. */
export const agentEnvSchema = z.object({
  [agentEnv.siteUrl]: z.string().url(),
  [agentEnv.siteUsername]: z.string(),
  [agentEnv.sitePassword]: z.string(),
  [agentEnv.llmBaseUrl]: z.string().url(),
  [agentEnv.llmApiKey]: z.string().min(1),
  [agentEnv.workDir]: z.string().min(1),
  /** The address of the queue API. When it is set the agent works a shift. */
  [agentEnv.queueUrl]: z.string().url().optional(),
  /** The length of the shift, counted from the start of the container. */
  [agentEnv.shiftSeconds]: z.coerce.number().positive().optional(),
  /** The most seconds the session of one task may take. */
  REFERENCE_TASK_SECONDS: z.coerce.number().positive().default(150),
  /** A task is skipped when fewer seconds than this are left for its session. */
  REFERENCE_TASK_MINIMUM_SECONDS: z.coerce.number().nonnegative().default(20),
  REFERENCE_MODEL: z.string().min(1).default(defaultModel),
  /**
   * Seconds before a deadline at which the harness is stopped, so that the answer is sent in
   * time. In a shift the deadline is the end of the shift.
   */
  REFERENCE_DEADLINE_MARGIN_SECONDS: z.coerce.number().nonnegative().default(4),
  /**
   * Text the operator adds to every prompt, for example what is known about the site. Unset in
   * the image as built.
   */
  REFERENCE_NOTES: z.string().optional(),
  /** Path of the OpenCode executable. Tests point it at a fake harness. */
  REFERENCE_OPENCODE_BIN: z.string().min(1).default("opencode"),
  /** Path of the Playwright MCP command line script. */
  REFERENCE_PLAYWRIGHT_MCP: z
    .string()
    .min(1)
    .default("/app/agents/reference/node_modules/@playwright/mcp/cli.js"),
});

/** The site and the sign-in a prompt gives the model. */
export interface SiteAccess {
  siteUrl: string;
  username: string;
  password: string;
}

export interface ShiftSettings {
  queueUrl: string;
  shiftSeconds: number;
}

export interface AgentConfig {
  siteUrl: string;
  siteUsername: string;
  sitePassword: string;
  llmBaseUrl: string;
  llmApiKey: string;
  workDir: string;
  /** The shift the agent works, or null when `QUEUE_URL` is not set. */
  shift: ShiftSettings | null;
  taskSeconds: number;
  taskMinimumSeconds: number;
  model: string;
  /** Operator's notes for the prompts, or null. */
  notes: string | null;
  deadlineMarginSeconds: number;
  opencodeBin: string;
  playwrightMcp: string;
}

export function loadConfig(env: NodeJS.ProcessEnv): AgentConfig {
  const parsed = agentEnvSchema.parse(env);
  const queueUrl = parsed[agentEnv.queueUrl];
  const shiftSeconds = parsed[agentEnv.shiftSeconds];
  if (queueUrl !== undefined && shiftSeconds === undefined) {
    throw new Error(`${agentEnv.shiftSeconds} is required when ${agentEnv.queueUrl} is set`);
  }
  const shift =
    queueUrl === undefined || shiftSeconds === undefined ? null : { queueUrl, shiftSeconds };
  return {
    siteUrl: parsed[agentEnv.siteUrl],
    siteUsername: parsed[agentEnv.siteUsername],
    sitePassword: parsed[agentEnv.sitePassword],
    llmBaseUrl: parsed[agentEnv.llmBaseUrl],
    llmApiKey: parsed[agentEnv.llmApiKey],
    workDir: parsed[agentEnv.workDir],
    shift,
    taskSeconds: parsed.REFERENCE_TASK_SECONDS,
    taskMinimumSeconds: parsed.REFERENCE_TASK_MINIMUM_SECONDS,
    model: parsed.REFERENCE_MODEL,
    notes: parsed.REFERENCE_NOTES?.trim() ? parsed.REFERENCE_NOTES.trim() : null,
    deadlineMarginSeconds: parsed.REFERENCE_DEADLINE_MARGIN_SECONDS,
    opencodeBin: parsed.REFERENCE_OPENCODE_BIN,
    playwrightMcp: parsed.REFERENCE_PLAYWRIGHT_MCP,
  };
}
