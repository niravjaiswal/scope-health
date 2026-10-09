/**
 * Answer-FORM theories (hybrid-build/FORM-THEORIES.md). Each one is a question whose value we can read but whose
 * expected FORM we cannot prove, so today the agent declines. A flag switches the form so one submission can A/B it.
 * Every flag is read at call time (tests flip them) and defaults to off = today's decline, byte for byte.
 *
 *   AGENT_FORM_PROVIDER = off | stated | titled | bare
 *       a provider's NAME as an answer (chart primary provider, an appointment row's provider, a lookup cell).
 *       off     decline (today).
 *       stated  answer only when the question states the form: "by first and last name" / "without the title" -> bare
 *               ("Roy Nelson"); "with their credentials" -> as the product shows it ("Roy Nelson, MD").
 *       titled  stated, and an unstated form is the product's own text ("Copy the value as the product shows it").
 *       bare    stated, and an unstated form is first + last name only.
 *   AGENT_FORM_DATETIME = off | on
 *       an appointment's date answer carries its clock time ("2026-11-01T09:20"). shift.md: a Date answer ignores a
 *       time that follows a space or T, a Date-and-time answer needs it, so the longer form is right for both kinds.
 */
import { stripCred } from "./aggregate.js";

export type ProviderForm = "off" | "stated" | "titled" | "bare";
export const providerMode = (): ProviderForm => {
  const v = (process.env.AGENT_FORM_PROVIDER ?? "off").trim().toLowerCase();
  return v === "stated" || v === "titled" || v === "bare" ? v : "off";
};
export const dateTimeOn = (): boolean => (process.env.AGENT_FORM_DATETIME ?? "off").trim().toLowerCase() === "on";

/** "first and last name" (the benchmark's own phrase for provider rankings) is a bare name; a stated credential is the shown text. */
export const BARE_CUE = /\bfirst(?: name)? and last name\b|\bfirst-and-last name\b|\bname only\b|\b(?:without|no|minus|omit(?:ting)?|drop(?:ping)?|excluding|leave out)\s+(?:the |their |any )?(?:titles?|credentials?|degrees?|suffix(?:es)?)\b/i;
export const TITLED_CUE = /\b(?:with|includ(?:e|es|ing)|plus|and|incl\.?|add|show)\s+(?:the |their |his |her )?(?:titles?|credentials?|degrees?)\b/i;
const LAST_FIRST = /\blast name,? first name\b|\bsurname first\b|\bLast, First\b/;
const EMPTY = /^(?:(?:not|none) on file|none|unknown|n\/a|—|–|-)$/i;

/** The form the question itself states, or null (also null when it states both or "Last, First"). */
export function providerFormCue(q: string): "bare" | "titled" | null {
  if (LAST_FIRST.test(q)) return null;
  const b = BARE_CUE.test(q), t = TITLED_CUE.test(q);
  return b && !t ? "bare" : t && !b ? "titled" : null;
}

/** A provider name as the answer. `shown` = the product's own text ("Roy Nelson, MD"), `bare` = the name already stripped. */
export function providerAnswer(shown: string | undefined, cue: "bare" | "titled" | null | undefined, mode: ProviderForm = providerMode(), bare?: string): { answer: string } | { why: string } {
  if (mode === "off") return { why: "form (with/without title) not provable" };
  const want = cue ?? (mode === "titled" ? "titled" : mode === "bare" ? "bare" : null);
  if (!want) return { why: "form (with/without title) not stated by the question (AGENT_FORM_PROVIDER=stated)" };
  const s = (shown ?? "").trim();
  if (EMPTY.test(s) && !bare) return { why: "provider field empty" };
  if (want === "bare") { const b = stripCred(s || bare || ""); return b ? { answer: b } : { why: "provider field empty" }; }
  return s && !EMPTY.test(s) ? { answer: s } : { why: "the product's own text of the provider was not captured (title form)" };
}

/** "9:20 AM", "2:20 PM MDT", "14:20", "09:20:00" -> "HH:MM" (24 h), else undefined. A non-zero second is kept out: undefined. */
export function hhmm(s: string | undefined): string | undefined {
  const m = String(s ?? "").match(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp])\.?[Mm]\b\.?/) ?? String(s ?? "").match(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?()/);
  if (!m) return undefined;
  let h = +m[1]; const mi = +m[2];
  if (mi > 59 || h > 23 || (m[3] && +m[3] !== 0)) return undefined;
  if (m[4]) { if (h < 1 || h > 12) return undefined; h = (h % 12) + (m[4].toLowerCase() === "p" ? 12 : 0); }
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}
/** The time zone a question names: "M" | "C" | "E" | "P" (Mountain, Central, Eastern, Pacific, or their MST/CDT/... abbreviations), "other" (UTC, Alaska, Hawaii), null (none, or "local"). */
export function namedZone(q: string): string | null {
  const w = q.match(/\b(Mountain|Central|Eastern|Pacific)(?:\s+(?:standard|daylight))?\s+time\b/i) ?? q.match(/\b([MCEP])[SD]T\b/);
  if (w) return w[1][0].toUpperCase();
  return /\b(?:UTC|GMT|Alaska(?:n)? time|Hawaii(?:an)? time)\b/i.test(q) ? "other" : null;
}
/** The site's clock text ("2:20 PM MDT") is in the zone the question names (or the question names none). The site shows the clinic's own zone; we never convert. */
export const zoneOk = (timeText: string | undefined, zone: string | null | undefined): boolean => !zone || (zone !== "other" && (String(timeText ?? "").match(/\b([MCEP])[SD]T\b/)?.[1] ?? "") === zone);
/** ISO date + the clock time of `timeText` ("2026-11-01T09:20"); undefined when the text carries no readable time or sits in another zone than the question names. */
export const dateTime = (dateISO: string, timeText: string | undefined, zone?: string | null): string | undefined => { const t = zoneOk(timeText, zone) ? hhmm(timeText) : undefined; return t ? `${dateISO}T${t}` : undefined; };
