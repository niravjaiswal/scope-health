/**
 * The never-wrong gate. An answer is ACCEPTED only when its value is grounded in content the agent
 * actually read — it appears (normalized) in one of the observations, or every item of a list does.
 * A value the model produced but never saw is treated as a hallucination → reject → skip. This is the
 * single invariant that makes the agentic loop safe: imperfect understanding yields a 0, never a −1.
 */
import type { Observation } from "./types.js";

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
// digits-only form, for numbers/phones/ids where punctuation/spacing varies between question and page
const digits = (s: string) => s.replace(/[^0-9]/g, "");

/** True when `value` is supported by the observed text. Lists (comma/newline separated) must have
 *  every element present. Numbers/dates are matched both normalized and digits-only. */
export function grounded(value: string, observations: Observation[]): boolean {
  const hay = observations.map((o) => o.text).join("\n");
  const nhay = norm(hay), dhay = digits(hay);
  const present = (v: string): boolean => {
    const nv = norm(v); if (!nv) return false;
    if (nhay.includes(nv)) return true;
    const dv = digits(v);
    return dv.length >= 3 && dhay.includes(dv); // a 3+ digit number/date seen verbatim
  };
  if (present(value)) return true;
  // list answer: accept only if EVERY item is independently grounded
  const items = value.split(/\s*[,\n]\s*/).map((x) => x.trim()).filter(Boolean);
  return items.length > 1 && items.every(present);
}

/** Pull {value, evidence} out of the terminal `answer` observation and ground it against ALL
 *  observations (not just the quoted evidence, which the model can fabricate). */
export function acceptAnswer(answerObs: Observation, all: Observation[]): string | null {
  let value = "";
  try { value = JSON.parse(answerObs.text).value ?? ""; } catch { return null; }
  value = String(value).trim();
  if (!value || /^(none|null|n\/a|unknown)$/i.test(value)) return null;
  if (value.length > 240 || value.split("\n").length > 6) return null; // a field value, not a paragraph
  return grounded(value, all) ? value : null;
}
