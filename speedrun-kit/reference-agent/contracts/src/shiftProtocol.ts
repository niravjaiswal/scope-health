import { z } from "zod";
import { answerSchema } from "./agentProtocol";

/**
 * Shift mode, as a competitor meets it: the queue API the agent calls during a shift, and the
 * record of a shift the competitor receives afterwards. Nothing in this file is about how a
 * queue is made or what the organizers record.
 *
 * A shift is one queue of items and a fixed length of time, counted from the start of the
 * agent's container. The agent takes one item at a time and gets the next one only after it
 * closed the current one. An item is a task or a message. Both are plain text.
 *
 *   task     asks for one answer. The agent closes it with an answer or skips it. A correct
 *            answer scores +1, a wrong answer -1, a skipped task 0. A closed task stays closed.
 *   message  tells the agent something. The agent closes it by acknowledging it. It scores
 *            nothing. Later tasks may depend on what it says.
 *
 * The agent container gets the base URL of the queue API in the environment variable
 * `QUEUE_URL` and the length of the shift in `SHIFT_SECONDS` (`agentEnv` in `agentProtocol.ts`). The
 * agent serves nothing itself in a shift. It asks for its first item when it wants to.
 *
 *   GET  <QUEUE_URL>/item         -> 200 QueueState
 *   POST <QUEUE_URL>/item/close   body CloseRequest -> 200 QueueState, the state after the close
 *
 * `GET /item` returns the open item, and returns the same item until it is closed. Every
 * request is answered at once: an agent may hold an item for as long as it likes without a
 * connection staying open. Closing a task does not say whether the answer was right.
 *
 * Errors are `QueueError` with one of these statuses:
 *
 *   400  bad_request   the body is not a close request
 *   404  not_found     no such route
 *   409  not_current   the id is not that of the open item: the item is closed already, or
 *                      was never given out. `state` holds the current state
 *   409  ended         the shift has ended. `state` says so
 *   413  too_large     the body is larger than the judge reads
 *   422  wrong_action  an answer or a skip for a message, or an acknowledgement for a task.
 *                      The item stays open
 *   503  unavailable   the judge could not handle the request. The run ends as a failure on
 *                      the organizers' side
 */

export const queueItemKinds = ["task", "message"] as const;
export const queueItemKindSchema = z.enum(queueItemKinds);
export type QueueItemKind = z.infer<typeof queueItemKindSchema>;

/** One item as the agent receives it. */
export const queueItemSchema = z.object({
  /** Names the item in the close request. It says nothing about the item. */
  id: z.string().min(1),
  kind: queueItemKindSchema,
  text: z.string(),
});
export type QueueItem = z.infer<typeof queueItemSchema>;

/**
 * Why a shift has ended: its time is over, or every item of the queue was closed. A shift
 * ends when the first of the two happens.
 */
export const queueEndReasons = ["time", "queue_finished"] as const;

export const queueStateSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("open"),
    item: queueItemSchema,
    /** Seconds until the shift ends. */
    seconds_left: z.number(),
  }),
  z.object({ status: z.literal("ended"), reason: z.enum(queueEndReasons) }),
]);
export type QueueState = z.infer<typeof queueStateSchema>;

/** An answer to a task: a string, a number, or a list of them. */
export const taskAnswerSchema = z.union([
  z.string(),
  z.number(),
  z.array(z.union([z.string(), z.number()])),
]);
export type TaskAnswer = z.infer<typeof taskAnswerSchema>;

/**
 * How an item is closed. `id` is the id of the open item. Exactly one of `answer`, `skip`, and
 * `acknowledge` is given: an answer or a skip closes a task, an acknowledgement closes a
 * message.
 */
export const closeRequestSchema = z.union([
  z.object({ id: z.string().min(1), answer: taskAnswerSchema }).strict(),
  z.object({ id: z.string().min(1), skip: z.literal(true) }).strict(),
  z.object({ id: z.string().min(1), acknowledge: z.literal(true) }).strict(),
]);
export type CloseRequest = z.infer<typeof closeRequestSchema>;

export const queueErrorCodes = [
  "bad_request",
  "not_found",
  "not_current",
  "ended",
  "too_large",
  "wrong_action",
  "unavailable",
] as const;

export const queueErrorSchema = z.object({
  error: z.object({ code: z.enum(queueErrorCodes), message: z.string() }),
  /** The current state, with `not_current` and `ended`. */
  state: queueStateSchema.optional(),
});
export type QueueError = z.infer<typeof queueErrorSchema>;

// ---------------------------------------------------------------------------------------------
// The competitor's record of a shift
// ---------------------------------------------------------------------------------------------

/**
 * How an item ended. A task ends `correct`, `wrong`, `skipped`, or `not_reached`. A message
 * ends `acknowledged` or `not_reached`. `not_reached` is an item the agent did not close before
 * the shift ended, whether or not it was given out.
 */
export const shiftItemOutcomes = [
  "correct",
  "wrong",
  "skipped",
  "acknowledged",
  "not_reached",
] as const;
export const shiftItemOutcomeSchema = z.enum(shiftItemOutcomes);
export type ShiftItemOutcome = z.infer<typeof shiftItemOutcomeSchema>;

/** One item of a shift as the competitor's record holds it. */
export const shiftItemResultSchema = z.object({
  /** Position in the queue, from 0. */
  index: z.number().int(),
  kind: queueItemKindSchema,
  text: z.string(),
  /**
   * What the agent closed the item with, without the id: `{ answer }`, `{ skip: true }`, or
   * `{ acknowledge: true }`. Null for an item that was not closed.
   */
  submitted: z.unknown(),
  outcome: shiftItemOutcomeSchema,
  /**
   * The answer that was expected. Present only on a task, and only in the record of a set
   * whose competitors see expected answers.
   */
  expected: answerSchema.optional(),
  /** Seconds from giving the item out to closing it. Null for an item that was not closed. */
  secondsHeld: z.number().nullable(),
  /** +1 for a correct task, -1 for a wrong one, 0 for any other item. */
  points: z.number(),
});
export type ShiftItemResult = z.infer<typeof shiftItemResultSchema>;

/** Tasks by outcome. */
export const shiftTaskCountsSchema = z.object({
  correct: z.number().int(),
  wrong: z.number().int(),
  skipped: z.number().int(),
  not_reached: z.number().int(),
});
export type ShiftTaskCounts = z.infer<typeof shiftTaskCountsSchema>;

/** The record of a shift that the competitor receives. */
export const shiftResultSchema = z.object({
  mode: z.literal("shift"),
  runId: z.string(),
  startedAtUtc: z.string(),
  finishedAtUtc: z.string(),
  agentImage: z.string(),
  /** Id of the set the shift is of. */
  set: z.string(),
  /** Correct tasks minus wrong tasks. */
  points: z.number(),
  /** Tasks in the queue. */
  taskCount: z.number().int(),
  counts: shiftTaskCountsSchema,
  lengthSeconds: z.number(),
  /**
   * Seconds that were left on the clock when the last item of the queue was closed. Null when
   * the queue was not finished.
   */
  secondsLeftWhenFinished: z.number().nullable(),
  /** One entry per item of the queue. Absent in the record of a set that shows totals only. */
  items: z.array(shiftItemResultSchema).optional(),
  /** Upstream cost of the agent's LLM requests in US dollars. Null when it is not known. */
  llmCostUsd: z.number().nullable(),
  /** The model spend the shift allowed, in US dollars. */
  llmMaxCostUsd: z.number(),
  /** Why the shift ended before its time and before the queue was finished, if it did. */
  aborted: z.string().nullable(),
});
export type ShiftResult = z.infer<typeof shiftResultSchema>;
