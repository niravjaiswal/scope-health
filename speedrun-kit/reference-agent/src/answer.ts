import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** File in the working directory of a session where the model keeps its current best answer. */
export const answerFileName = "answer.json";

/** The content of the answer file in a directory, or null when there is none. */
export async function readAnswerFile(dir: string): Promise<string | null> {
  try {
    return await readFile(join(dir, answerFileName), "utf8");
  } catch {
    return null;
  }
}

/** Returns the content of the last `<answer>...</answer>` tag in the text, or null. */
export function extractAnswerTag(text: string): string | null {
  const matches = [...text.matchAll(/<answer>([\s\S]*?)<\/answer>/g)];
  const last = matches.at(-1);
  return last?.[1] === undefined ? null : last[1].trim();
}
