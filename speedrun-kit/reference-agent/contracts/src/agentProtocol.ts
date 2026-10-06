import { z } from "zod";

/**
 * What an agent's container is given when a shift starts, and the type of an answer. The queue
 * API the agent calls during the shift is in `shiftProtocol.ts`.
 */

/** Environment variables the judge sets on the agent container of a shift. */
export const agentEnv = {
  /** Base URL of the clinic's web application. */
  siteUrl: "SITE_URL",
  siteUsername: "SITE_USERNAME",
  sitePassword: "SITE_PASSWORD",
  /** OpenAI-compatible base URL of the model endpoint, ending in /v1. */
  llmBaseUrl: "LLM_BASE_URL",
  /** The key of this run for the model endpoint. It is not an upstream key. */
  llmApiKey: "LLM_API_KEY",
  /** Writable scratch directory. */
  workDir: "WORK_DIR",
  /** Base URL of the queue API (see `shiftProtocol.ts`). */
  queueUrl: "QUEUE_URL",
  /** The length of the shift in seconds, counted from the container's start. */
  shiftSeconds: "SHIFT_SECONDS",
} as const;

const scalarAnswerSchema = z.union([z.string(), z.number()]);

/** An answer as a record holds it: a string, a number, a list of them, or null for none. */
export const answerSchema = z.union([scalarAnswerSchema, z.array(scalarAnswerSchema), z.null()]);
export type Answer = z.infer<typeof answerSchema>;
