/**
 * One view over every family's governing-message parser: which policy FIELDS a message gave and which
 * it did not. Used by the solvers (a missing field declines only the answers that need it) and by the
 * variants tooling (reworded messages: which fields still parse, and never to a different value).
 *
 *   parsePolicy(family, raw, later) → { family, fields, missing, why }
 *   logPolicyParse(p)               → one {"event":"policy_parse", ...} line per (family, message) per shift
 */
import { parseFilingFields, parseGoodFaithFields, isDecline } from "./familyReaders.js";
import { parseClaimFields, CLAIM_FIELDS } from "./claimNextStep.js";
import { parseRecallFields } from "./recallReader.js";
import { parseTetanusFields, TETANUS_FIELDS } from "./immunizations.js";
import { parseLabRule, labCoveredPanels } from "./labTriage.js";
import { parseNEMessage } from "./neParse.js";

export type PolicyParse = { family: string; fields: Record<string, unknown>; missing: string[]; why: string };

export const POLICY_FIELDS: Record<string, string[]> = {
  "lab-report-triage": ["covered", "panels"],
  "tetanus-wound": [...TETANUS_FIELDS],
  "vaccine-lot-recall": ["unknownToken", "countRules"],
  "claim-next-step": [...CLAIM_FIELDS],
  "filing-deadline": ["todayISO", "closedISO", "weekendsClosed", "roll", "anchors", "tokens"],
  "good-faith-estimate": ["tokens", "window", "closuresDef", "bands"],
  "new-vs-established": ["windowYears", "excluded", "statuses", "matchProvider", "matchSpecialty"],
};

/** Covered panels as the compiler reads them (run.ts → labTriage.labCoveredPanels). */
export const labCovered = labCoveredPanels;

const all = (family: string, fields: Record<string, unknown>, why = ""): PolicyParse => ({ family, fields, missing: (POLICY_FIELDS[family] ?? []).filter((k) => fields[k] === undefined), why });
const none = (family: string, why: string): PolicyParse => all(family, {}, why);
/** A family's field parse as a PolicyParse; a list field (tokens) with an entry missing counts as missing. */
export function policyOf(family: string, fields: object, why: string[]): PolicyParse {
  const f: Record<string, unknown> = { ...(fields as Record<string, unknown>) };
  const p = all(family, f, why.join("; "));
  if (why.some((w) => /token/i.test(w)) && !p.missing.includes("tokens")) p.missing.push("tokens");
  return p;
}

export function parsePolicy(family: string, raw: string, later: string[] = []): PolicyParse {
  switch (family) {
    case "lab-report-triage": {
      const covered = labCovered(raw); const r = parseLabRule(raw);
      const panels = r.panels.size ? Object.fromEntries([...r.panels].map(([k, v]) => [k, v.tests])) : undefined;
      return all(family, { covered: covered ?? undefined, panels }, covered ? "" : "lab: covered-panel list not found");
    }
    case "tetanus-wound": { const r = parseTetanusFields(raw); return policyOf(family, r.fields, r.why); }
    case "vaccine-lot-recall": { const r = parseRecallFields(raw); return policyOf(family, r.fields, r.why); }
    case "claim-next-step": { const { fields: { appealNotes, blocks, ...f }, why } = parseClaimFields(raw, later); return policyOf(family, f, why); }
    case "filing-deadline": { const r = parseFilingFields(raw); return policyOf(family, r.fields, r.why); }
    case "good-faith-estimate": { const r = parseGoodFaithFields(raw); return policyOf(family, r.fields, r.why); }
    case "new-vs-established": { const r = parseNEMessage(raw); return r.params ? all(family, { ...r.params }) : none(family, r.why); }
  }
  return none(family, "no parser for " + family);
}

/** `obj` seen through a proxy that records every read of a key in `missing` (a field the message did
 *  not give). A decision whose code path read none of them does not depend on them. */
export function tracked<T extends object>(obj: T, missing: string[]): { p: T; touched: () => string[] } {
  const seen = new Set<string>(); const miss = new Set(missing);
  const p = new Proxy(obj, { get(t, k, r) { if (typeof k === "string" && miss.has(k)) seen.add(k); return Reflect.get(t, k, r); }, has(t, k) { if (typeof k === "string" && miss.has(k)) seen.add(k); return Reflect.has(t, k); } });
  return { p, touched: () => [...seen] };
}

/** Which family's governing workflow a message is (long messages only: notes and amendments are not). */
export function messageFamily(raw: string): string | null {
  if (raw.length < 1000) return null; // amendments and notes are not the governing workflow
  if (/\blab reports?\b/i.test(raw) && /NOT_COVERED/.test(raw)) return "lab-report-triage";
  if (/\btetanus\b/i.test(raw) && /VACCINE_AND_TIG/.test(raw)) return "tetanus-wound";
  if (/\brecall/i.test(raw) && /\blot\b/i.test(raw) && raw.length > 1000) return "vaccine-lot-recall";
  if (/AWAIT_PAYER/.test(raw)) return "claim-next-step";
  if (/NO_FILING_TERMS/.test(raw)) return "filing-deadline";
  if (/NOT_REQUIRED:INSURED/.test(raw)) return "good-faith-estimate";
  if (/\bnew\b[\s\S]{0,40}\bestablished\b/i.test(raw) && raw.length > 1000) return "new-vs-established";
  return null;
}
/** Comparable form of a field value (Sets/Maps → sorted arrays). */
export function canon(v: unknown): string {
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) v = [...v].sort(); // name lists are closed sets: order-free
  return JSON.stringify(v, (_k, x) => (x instanceof Set ? [...x].sort() : x instanceof Map ? [...x.entries()].sort() : x === Infinity ? "Infinity" : x));
}

const logged = new Set<string>();
export function logPolicyParse(p: PolicyParse, raw: string): void {
  const key = p.family + "|" + raw.length + "|" + raw.slice(0, 80);
  if (logged.has(key)) return; logged.add(key);
  try { process.stdout.write(JSON.stringify({ event: "policy_parse", family: p.family, found: Object.keys(p.fields).filter((k) => p.fields[k] !== undefined), missing: p.missing, why: p.why || undefined, head: raw.slice(0, 60) }) + "\n"); } catch {}
}
