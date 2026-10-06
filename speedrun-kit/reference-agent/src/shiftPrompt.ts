import type { SiteAccess } from "./config";

export interface TaskPromptInput {
  site: SiteAccess;
  /** The text of every message received so far in the shift, oldest first. */
  messages: readonly string[];
  /** The task, as the queue gave it. */
  task: string;
  /** Operator's notes, or null. */
  notes: string | null;
  answerFile: string;
  secondsAvailable: number;
}

function renderMessages(messages: readonly string[]): string {
  if (messages.length === 0) return "No message has arrived yet.";
  return messages.map((text, index) => `### Message ${index + 1}\n\n${text.trim()}`).join("\n\n");
}

/**
 * The prompt of the session that works one task of a shift. It holds the site, every message
 * the agent has received, the task, and how to give the answer.
 */
export function buildTaskPrompt(input: TaskPromptInput): string {
  const notes = input.notes === null ? "" : `\n\n## Notes from the operator\n\n${input.notes}`;
  return `You are working a shift at the back office of a clinic. Requests come in one at a time. This session handles one of them. You work in the clinic's web application.

Site: ${input.site.siteUrl}
Username: ${input.site.username}
Password: ${input.site.password}

## Messages received so far in this shift

Some messages say how a kind of work is to be done and how its answer is written. Others are notices that no work depends on. Use what applies to the request below.

${renderMessages(input.messages)}

## The request

${input.task}

## Time and scoring

You have about ${Math.floor(input.secondsAvailable)} seconds. A correct answer scores +1, a wrong answer scores -1, and no answer scores 0. Give an answer only when you have worked it out from data you found in the site. Otherwise answer null.

## How to work

- Use the browser tools to sign in and find the data. Use the shell only for calculations.
- If a message above says how this kind of request is handled, follow it, and write the answer in the form it gives.
- If no message covers the request, answer it from the site: a count as a number, a date as YYYY-MM-DD, anything else as short text.
- Do not change any data in the site.
- When you have the answer and have checked it, write it to the file ${input.answerFile} as a JSON value. Do not write a guess to that file: if you run out of time, its content is submitted, and if it does not exist, the request is skipped.
- Then reply with only the final answer inside answer tags, for example <answer>VALUE</answer> where VALUE is the JSON value, or <answer>null</answer> if you could not determine it.${notes}`;
}
