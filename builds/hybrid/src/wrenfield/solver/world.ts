/**
 * Plug point between the Plan executor (solver-compiler: plan.ts / exec.ts, `World`) and the live site:
 * `fillWorld` turns a plan's `needs` into `World.entities` records through the toolkit — patient resolution,
 * proven-complete lists, values normalised (ISO dates, exact decimal money strings). Each need either fills
 * completely or the whole fill declines with the toolkit's `why`; partial worlds are never returned.
 *
 * The executor's vocabulary (VOCAB in plan.ts) names fields abstractly; FIELD_MAP below says which site
 * label (siteModel canonical field) carries each one and how to normalise it. A vocabulary field with no
 * site source here (nested claim lines, lab results…) declines: those come from the family readers.
 */
import type { Toolkit, Row, Result } from "./toolkit.js";
import { parseDate, cents, money } from "./dates.js";
import { ENTITIES, type Entity } from "./siteModel.js";

/** Structural copies of the executor's types (plan.ts on solver-compiler) — no import, so the branches merge freely. */
export type Need = { entity: string; scope: "patient" | "clinic"; filters?: string | Record<string, string>; fields?: string[] };
export type Rec = Record<string, unknown>;
export type World = { inputs: Record<string, unknown>; entities: Record<string, Rec[]>; resolved?: { patient?: string }; today?: string };
export type Provenance = { entity: string; scope: string; rows: number; how: string; strength: "page" | "model"; source: string };

type Conv = "text" | "date" | "money" | "int" | "id" | "time";
/** vocabulary field → [siteModel canonical field, conversion] per entity. */
export const FIELD_MAP: Record<string, Record<string, [string, Conv]>> = {
  appointment: { date: ["date", "date"], start: ["Start", "time"], status: ["status", "text"], location: ["location", "text"], provider: ["provider", "text"], service: ["visitType", "text"], patientName: ["Patient", "text"] },
  document: { type: ["type", "text"], title: ["title", "text"], received: ["received", "date"], date: ["received", "date"] },
  invoice: { number: ["invoice", "id"], issued: ["issued", "date"], serviceDate: ["serviceDate", "date"], location: ["location", "text"], status: ["status", "text"], total: ["total", "money"] },
  claim: { number: ["claim", "id"], dos: ["serviceDate", "date"], payer: ["payer", "text"], status: ["status", "text"], total: ["totalCharge", "money"], provider: ["renderingProvider", "text"] },
  remittance: { number: ["trace", "id"], paymentDate: ["paymentDate", "date"], kind: ["type", "text"], total: ["totalPaid", "money"], entry: ["entry", "text"] },
  immunization: { vaccine: ["vaccine", "text"], date: ["dateGiven", "date"], lot: ["lot", "id"], givenBy: ["givenBy", "text"], recordedAs: ["recordedAs", "text"] },
  authorization: { number: ["number", "id"], payer: ["payer", "text"], service: ["service", "text"], validFrom: ["validFrom", "date"], validTo: ["validThrough", "date"], status: ["status", "text"] },
  coverage: { payer: ["payerPlan", "text"], from: ["effective", "date"], to: ["end", "date"], status: ["status", "text"], memberId: ["memberId", "id"] },
  activity: { date: ["time", "date"], detail: ["what", "text"], kind: ["action", "text"] },
  closure: { date: ["date", "date"], name: ["closure", "text"], scope: ["appliesTo", "text"], status: ["status", "text"] },
  provider: { name: ["provider", "text"], status: ["status", "text"], locations: ["locations", "text"] },
  problem: { code: ["code", "text"], condition: ["condition", "text"], onset: ["onset", "date"] },
  order: { number: ["number", "id"], ordered: ["ordered", "date"], service: ["service", "text"] },
};

function conv(v: string, c: Conv): unknown {
  const t = (v ?? "").trim(); if (!t || /^(none|—|-)$/i.test(t)) return null;
  if (c === "date") { const d = parseDate(t); if (!d) throw new Error(`"${t}" is not a date`); return d; }
  if (c === "money") { const x = cents(t); if (x === null) throw new Error(`"${t}" is not money`); return money(x); }
  if (c === "int") { if (!/^-?[\d,]+$/.test(t)) throw new Error(`"${t}" is not an integer`); return Number(t.replace(/,/g, "")); }
  if (c === "time") return t;
  return t;
}
/** One listed row → a vocabulary record (fields asked; `id` = the row's detail link; `patientId` from a patient link). */
export function recordOf(entity: string, row: Row, fields: string[]): Rec | { why: string } {
  const map = FIELD_MAP[entity] ?? {}; const rec: Rec = {};
  const detail = row.links.find((l) => !/^\/patients\/[^/]+$/.test(l.href)); if (detail) rec.id = detail.href;
  const pl = row.links.find((l) => /^\/patients\/[^/]+$/.test(l.href)); if (pl) rec.patientId = pl.href.split("/")[2];
  const labels = Object.keys(row.cells);
  for (const f of fields) {
    if (f === "id" || f === "patientId") continue;
    const m = map[f]; if (!m) return { why: `${entity}.${f}: no site source in the toolkit's field map` };
    const spec = ENTITIES[entity as Entity]; const re = spec?.fields[m[0]];
    const hits = labels.filter((l) => l === m[0] || (re && re.test(l)));
    if (hits.length !== 1) return { why: `${entity}.${f}: ${hits.length} columns (${labels.join(" | ")})` };
    try { rec[f] = conv(row.cells[hits[0]], m[1]); } catch (e) { return { why: `${entity}.${f}: ${(e as Error).message}` }; }
  }
  return rec;
}

/** Fill the World for a plan's needs. `inputs.patient` (name, dob?) is resolved once and becomes the patient
 *  record; patient-scope needs read that chart. Structured filters ({from, to, type…}) go to the list's labelled
 *  controls; a prose filter is ignored here (the executor's `where` does the filtering over a complete read). */
export async function fillWorld(tk: Toolkit, needs: Need[], inputs: Record<string, unknown>, opts: { budgetMs?: number } = {}): Promise<{ world: World; provenance: Provenance[] } | { why: string }> {
  const world: World = { inputs: { ...inputs }, entities: {} }; const provenance: Provenance[] = [];
  let patientHref: string | undefined;
  const pIn = inputs.patient as { name?: string; dob?: string } | string | undefined;
  if (needs.some((n) => n.scope === "patient")) {
    const name = typeof pIn === "string" ? pIn : pIn?.name; const dob = typeof pIn === "string" ? undefined : pIn?.dob;
    if (!name) return { why: "a patient-scope need but no patient input" };
    const p = await tk.getPatient(name, dob);
    if (!p.ok) return { why: p.why };
    patientHref = p.value.href; const id = p.value.href.split("/")[2];
    world.resolved = { patient: id };
    world.inputs.patient = { id, name: p.value.name, dob: p.value.dob ? parseDate(p.value.dob) ?? p.value.dob : undefined, flags: p.value.flags ?? [] };
    world.entities.patient = [world.inputs.patient as Rec];
    provenance.push({ entity: "patient", scope: "patient", rows: 1, how: p.proof.how, strength: p.proof.strength, source: p.proof.source });
  }
  for (const need of needs) {
    if (need.entity === "patient") continue;
    const filters = typeof need.filters === "object" && need.filters ? need.filters : {};
    const r: Result<{ rows: Row[] }> = await tk.listEntities(need.entity as Entity, need.scope, filters, { patientHref, budgetMs: opts.budgetMs });
    if (!r.ok) return { why: r.why };
    const recs: Rec[] = [];
    for (const row of r.value.rows) {
      const rec = recordOf(need.entity, row, need.fields ?? Object.keys(FIELD_MAP[need.entity] ?? {}));
      if ("why" in rec) return { why: String(rec.why) };
      if (need.scope === "patient" && world.resolved?.patient && rec.patientId === undefined) rec.patientId = world.resolved.patient;
      recs.push(rec);
    }
    world.entities[need.entity] = [...(world.entities[need.entity] ?? []), ...recs];
    provenance.push({ entity: need.entity, scope: need.scope, rows: recs.length, how: r.proof.how, strength: r.proof.strength, source: r.proof.source });
  }
  return { world, provenance };
}
