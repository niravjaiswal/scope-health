/**
 * Deterministic solvers for task FAMILIES (families.ts) that have their own reader, bypassing the
 * keyword tier. Each returns the exact answer string or null (→ skip). Pure over the page records
 * the index reads live, so they are checked here without a browser (`npx tsx src/wrenfield/solvers.ts`).
 */
import type { ClinicIndex, MessageStore, ProviderDay, InvoicePage } from "./inference.js";
import type { FamilyMatch } from "./families.js";
import { why, hasWhy } from "./why.js";
import { isFilingPolicy, parseFilingFields, filingNeeds, filingAmendmentBlocks, isGoodFaithPolicy, parseGoodFaithFields, goodFaithNeeds, goodFaithAmendmentBlocks, isDecline } from "./familyReaders.js";
import { logPolicyParse, policyOf, tracked } from "./policyParse.js";
import { timeIn } from "./pageSnapshot.js";

/** The latest message that `is` the governing rule, and the raw text of every message after it. */
function governing(store: MessageStore, is: (raw: string) => boolean): { raw: string; later: string[] } | null {
  const all = store.all(); let i = -1;
  for (let k = 0; k < all.length; k++) if (is(all[k].raw)) i = k;
  return i < 0 ? null : { raw: all[i].raw, later: all.slice(i + 1).map((m) => m.raw) };
}
import { decideClaim, isClaimPolicy, parseClaimFields, ANSWER_RE, type ClaimPolicy } from "./claimNextStep.js";
import { decideFiling } from "./filingDeadline.js";
import { decideTetanus } from "./tetanusWound.js";
import { decideGoodFaith } from "./goodFaith.js";
import { pacer } from "./pacer.js";
import { parseAggQuery, solveAggregate, AGGREGATE_FAMILIES } from "./aggregate.js";
import { taskBudgetMs } from "./apptList.js";

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
const parts = (s: string) => norm(s).split(" ").filter(Boolean);
const money = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

export async function solveFamily(m: FamilyMatch, index: ClinicIndex, store: MessageStore): Promise<string | null> {
  const s = m.slots;
  if (AGGREGATE_FAMILIES.includes(m.family)) return aggregate(m, index);
  if (m.family === "list-count") return listCount(m, index, store);
  switch (m.family) {
    case "lab-report-triage": {
      const rule = store.ruleFor("lab.triage"); if (!rule || !s.panel) { why(rule ? "lab: no panel in the question" : "lab: no governing message compiled"); return null; }
      if (/,/.test(s.panel)) { why(`lab: panel slot "${s.panel}" holds more than a panel name (name written "Last, First"?)`); return null; }
      // Coverage + amendment cutoff are decided by the compiled rule (NOT_COVERED or decline-to-compute).
      const cover = rule.evaluate({ index, params: { panel: s.panel, received: s.received ?? "" }, facts: [] });
      if (cover === "NOT_COVERED") return "NOT_COVERED";
      // Covered panel → read the report (tesseract + vision model agreement) and apply the table in code.
      if (!index.labContext) { why("lab: no report reader on this clinic"); return null; }
      { const { pacer } = await import("./pacer.js"); const pw = pacer.labWhy(); if (pw) { why(pw); return null; } } // behind pace: reach the cheaper tasks
      const raw = store.rawFor?.("lab.triage"); if (!raw) { why("lab: no rule text to parse the limits table"); return null; }
      const { parseLabRule, triageLab } = await import("./labTriage.js");
      const table = parseLabRule(raw);
      const ctx = await index.labContext(s.name ?? "", s.dob, s.panel, s.received ?? "", table).catch((e) => { why("lab: reader threw " + String(e).slice(0, 60)); return null; });
      if (!ctx) return null;
      const v = triageLab(table, ctx.report, ctx.patient, ctx.prev);
      if (v == null) why("lab: engine declined (unreadable value or unresolved previous report)");
      return v;
    }
    case "invoice-balance": if (!s.invoice) { why("invoice: no invoice number in the question"); return null; } return invoiceBalance(index, s.invoice, s.name, s.dos);
    case "provider-day-scheduled-count": return dayCount(index, s.provider, s.date, "scheduled");
    case "provider-day-completed-count": return dayCount(index, s.provider, s.date, "completed");
    case "provider-open-slots": return openSlots(index, s.provider, s.location, s.date);
    case "claim-next-step": {
      if (!s.name || !s.dos) { why("claim: no patient or date of service"); return null; }
      // Rule first: today, reasons, tables and later amendments come from the queue's messages.
      const gov = governing(store, isClaimPolicy);
      if (!gov) { why("claim: no claim next-step message received"); return null; }
      // Field by field: the reader and the engine see the parsed fields through a tracker; an answer whose
      // branch read a field the message did not state clearly declines (the others still answer).
      const pc = parseClaimFields(gov.raw, gov.later);
      const pp = policyOf("claim-next-step", pc.fields, pc.why); logPolicyParse(pp, gov.raw);
      if (!pc.fields.tokens?.length) { why("claim policy: " + pc.why.join("; ")); return null; }
      if (pc.fields.todayISO && s.dos > pc.fields.todayISO) { why(`claim: service date ${s.dos} is after today ${pc.fields.todayISO}`); return null; }
      if (!index.claimContext) { why("claim: no claim reader on this clinic"); return null; }
      const tr = tracked(pc.fields as ClaimPolicy, pp.missing);
      const ctx = await index.claimContext(s.name, s.dob, s.dos, tr.p).catch((e) => { why("claim: reader threw " + String(e).slice(0, 60)); return null; });
      if (!ctx) { if (!hasWhy()) why("claim: could not read the claim detail / payer contract"); return null; }
      let v: ReturnType<typeof decideClaim>;
      try { v = decideClaim(ctx, tr.p); } catch (e) { v = { decline: "claim: engine threw " + String(e).slice(0, 60) }; }
      if (tr.touched().length) { why(`claim policy: the answer needs ${tr.touched().join(", ")}, which the message does not give clearly (${pc.why.join("; ").slice(0, 120)})`); return null; }
      if ("decline" in v) { why(v.decline); return null; }
      if (!ANSWER_RE.test(v.answer)) { why(`claim: answer ${v.answer} outside the message's answer set`); return null; }
      const tok = v.answer.includes(":") ? v.answer.slice(0, v.answer.indexOf(":") + 1) : v.answer;
      if (!pc.fields.tokens.includes(tok)) { why(`claim policy: answer token ${tok} not in the message`); return null; }
      return v.answer;
    }
    case "filing-deadline": {
      if (!s.name || !s.dos) { why("filing: no patient or date of service"); return null; }
      // Rule first: today, the office holidays and the answer set come from the governing message.
      const gov = governing(store, isFilingPolicy);
      if (!gov) { why("filing: no filing-deadline message received"); return null; }
      // Field by field: a field the message doesn't state clearly declines only the answers that need it.
      const pf = parseFilingFields(gov.raw); logPolicyParse(policyOf("filing-deadline", pf.fields, pf.why), gov.raw);
      const pol = pf.fields;
      if (!(pol.tokens.includes("NO_FILING_TERMS") || pol.tokens.includes("AWAITING_PRIMARY")) && filingNeeds("2000-01-01", pol, "Original")) { why("filing policy: " + pf.why.join("; ")); return null; }
      if (pol.todayISO && s.dos > pol.todayISO) { why(`filing: service date ${s.dos} is after today ${pol.todayISO}`); return null; }
      if (!index.filingContext) { why("filing: no filing reader on this clinic"); return null; }
      const ctx = await index.filingContext(s.name, s.dob, s.dos).catch((e) => { why("filing: reader threw " + String(e).slice(0, 60)); return null; });
      if (!ctx) { if (!hasWhy()) why("filing: could not read the not-yet-filed claim / payer terms"); return null; }
      const amend = filingAmendmentBlocks(gov.later, ctx.payer ?? ""); if (amend) { why("filing: " + amend); return null; }
      // Missing today / closures are filled with values that can only give answers declined below.
      const v = decideFiling({ ...ctx, todayISO: pol.todayISO ?? "9999-12-31", officeClosedISO: pol.closedISO ?? [] });
      if (v == null) { why("filing: engine declined (limit missing for this claim type)"); return null; }
      const need = filingNeeds(v, pol, ctx.type); if (need) { why("filing policy: " + need); return null; }
      if (!/^(\d{4}-\d{2}-\d{2}|EXPIRED:\d+|NO_FILING_TERMS|AWAITING_PRIMARY)$/.test(v)) { why(`filing: answer ${v} outside the message's answer set`); return null; }
      return v;
    }
    case "tetanus-wound": {
      if (!s.name || !s.visit) { why("tetanus: no patient or visit date"); return null; }
      if (!index.tetanusContext) { why("tetanus: no tetanus reader on this clinic"); return null; }
      // The vaccine list, decision table and wound list come from the governing message (latest wins).
      // Field by field: the reader and the engine see the rule through a tracker; an answer whose path read
      // a field the message did not state clearly declines (e.g. NO_WOUND_VISIT needs only its token).
      const { tetanusFieldsFrom, isSkip } = await import("./immunizations.js");
      const tf = tetanusFieldsFrom(store.all().map((m) => m.raw));
      if (isSkip(tf)) { why("tetanus: " + tf.skip); return null; }
      const pp = policyOf("tetanus-wound", tf.fields, tf.why); logPolicyParse(pp, tf.raw);
      if (!tf.fields.tokens) { why("tetanus message: " + tf.why.join("; ")); return null; }
      const tr = tracked(tf.fields as import("./immunizations.js").TetanusRule, pp.missing);
      const ctx = await index.tetanusContext(s.name, s.dob, s.visit, tr.p).catch((e) => { why("tetanus: reader threw " + String(e).slice(0, 60)); return null; });
      if (!ctx) { if (!hasWhy()) why("tetanus: could not read the triage note / immunization history"); if (tr.touched().length) why(`tetanus message: the answer needs ${tr.touched().join(", ")} (${tf.why.join("; ").slice(0, 100)})`); return null; }
      let v: string | null; try { v = decideTetanus(ctx, tr.p); } catch (e) { v = null; why("tetanus: engine threw " + String(e).slice(0, 60)); }
      if (tr.touched().length) { why(`tetanus message: the answer needs ${tr.touched().join(", ")}, which the message does not give clearly (${tf.why.join("; ").slice(0, 100)})`); return null; }
      if (v == null) why("tetanus: engine declined"); return v;
    }
    case "vaccine-lot-recall": {
      if (!s.lot) { why("recall: no lot number in the question"); return null; }
      if (!index.recallLeft) { why("recall: no vaccine-lot reader on this clinic"); return null; }
      // The answer set and the rule come from the governing message; a later message about recalls blocks.
      const { isRecallPolicy, parseRecallFields, recallAmendmentBlocks } = await import("./recallReader.js");
      const gov = governing(store, isRecallPolicy);
      if (!gov) { why("recall: no governing recall message in the queue"); return null; }
      // Field by field: UNKNOWN_LOT needs only its token, a count needs the counting rules.
      const pr = parseRecallFields(gov.raw); logPolicyParse(policyOf("vaccine-lot-recall", pr.fields, pr.why), gov.raw);
      if (!pr.fields.unknownToken && !pr.fields.countRules) { why("recall: " + pr.why.join("; ")); return null; }
      const amend = recallAmendmentBlocks(gov.later); if (amend) { why("recall: " + amend); return null; }
      const NO_TOKEN = "\u0000NO_UNKNOWN_LOT_TOKEN";
      const v = await index.recallLeft(s.lot, { unknownToken: pr.fields.unknownToken ?? NO_TOKEN }).catch((e) => { why("recall: reader threw " + String(e).slice(0, 60)); return null; });
      if (v == null) return null;
      if (v === NO_TOKEN) { why("recall: no location stocks the lot, and the message gives no answer for that"); return null; }
      if (v !== pr.fields.unknownToken && !/^\d+$/.test(v)) { why("recall: answer outside the message's answer set: " + v); return null; }
      if (/^\d+$/.test(v) && !pr.fields.countRules) { why("recall: a count needs the counting rules: " + pr.why.join("; ")); return null; }
      return v;
    }
    case "good-faith-estimate": {
      const time = timeIn(s.time ?? "");
      if (!s.name || !s.date || !time) { why("good-faith: no patient, date, or time"); return null; }
      const gov = governing(store, isGoodFaithPolicy);
      if (!gov) { why("good-faith: no good-faith-estimate message received"); return null; }
      const pg = parseGoodFaithFields(gov.raw); logPolicyParse(policyOf("good-faith-estimate", pg.fields, pg.why), gov.raw);
      const pol = pg.fields;
      if (!pol.tokens.includes("NOT_REQUIRED:INSURED") && goodFaithNeeds("2000-01-01", pol)) { why("good-faith policy: " + pg.why.join("; ")); return null; }
      const amend = goodFaithAmendmentBlocks(gov.later); if (amend) { why(amend); return null; }
      if (!index.goodFaithContext) { why("good-faith: no reader on this clinic"); return null; }
      const ctx = await index.goodFaithContext(s.name, s.dob, s.date, time).catch((e) => { why("good-faith: reader threw " + String(e).slice(0, 60)); return null; });
      if (!ctx) { if (!hasWhy()) why("good-faith: could not read insurance status / booking date / closures"); return null; }
      // Insured → NOT_REQUIRED:INSURED needs only its token; anything else needs the window, closures and bands.
      const v = !ctx.owedEstimate ? "NOT_REQUIRED:INSURED" : pol.bands ? decideGoodFaith({ ...ctx, bands: pol.bands }) : "NEEDS_BANDS";
      if (v == null) { why("good-faith: engine declined"); return null; }
      const need = goodFaithNeeds(v === "NEEDS_BANDS" ? "2000-01-01" : v, pol); if (need) { why("good-faith policy: " + need); return null; }
      if (!/^(\d{4}-\d{2}-\d{2}|NOT_REQUIRED:INSURED|NOT_REQUIRED:SHORT_NOTICE)$/.test(v)) { why(`good-faith: answer ${v} outside the message's answer set`); return null; }
      return v;
    }
  }
  return null;
}

/** Still owed = billed − payments received; a void invoice owes nothing. Declines when the page is
 *  not the invoice asked about, when the ledger holds anything but charges and payments, or when the
 *  arithmetic disagrees with the page's own "Amount owed". */
export async function invoiceBalance(index: ClinicIndex, invoice: string, name?: string, dosISO?: string): Promise<string | null> {
  const pg = await index.invoicePage?.(invoice).catch((e) => { why("invoice: reader threw " + String(e).slice(0, 80)); return null; });
  if (!pg) { why(`invoice ${invoice}: detail page not reached (Find invoice form or Ledger marker)`); return null; }
  if (pg.invoice !== invoice) { why(`invoice: page shows ${pg.invoice}, asked ${invoice}`); return null; }
  if (name && !parts(name).every((p) => parts(pg.patient).includes(p))) { why(`invoice: patient on page "${pg.patient}" is not ${name}`); return null; }
  if (dosISO && pg.dosISO && pg.dosISO !== dosISO) { why(`invoice: service date ${pg.dosISO} is not ${dosISO}`); return null; }
  if (pg.void) return "0.00";
  if (pg.total === undefined) { why("invoice: no Total on the page"); return null; }
  if (pg.other.length) { why("invoice: ledger has lines other than charges and payments: " + pg.other.join("; ").slice(0, 80)); return null; }
  const owed = pg.total - pg.payments.reduce((a, b) => a + b, 0);
  if (owed < 0) { why("invoice: payments exceed the total"); return null; }
  if (pg.owed !== undefined && Math.abs(pg.owed - owed) > 0.005) { why(`invoice: page says owed ${pg.owed}, arithmetic says ${money(owed)}`); return null; }
  return money(owed);
}

/** Aggregate families (counts over the appointment list, distinct patients, top-k providers): one engine. */
export async function aggregate(m: FamilyMatch, index: ClinicIndex): Promise<string | null> {
  if (!m.text) { why("aggregate: no task text"); return null; }
  const p = parseAggQuery(m.text);
  if (!p.q) { why("aggregate: " + p.why); return null; }
  if (p.family !== m.family) { why(`aggregate: parsed as ${p.family}, gated as ${m.family}`); return null; }
  const src = index.aggregate;
  if (!src) { why("aggregate: no appointment-list reader on this clinic"); return null; }
  // Up to 15 s always (Set 1's answered aggregates take a few s); longer re-reads (Show-more lists past a cut) only
  // with the pacer's slack, so they can't push answering items past the end of the shift.
  // AGENT_PACER=v2: no unconditional 15 s; the budget is what this family's own numbers and the spare time justify (pacer.familyBudgetS), and a
  // read that meets a "site busy" list makes the family wait (list reads, pacer.noteBusy).
  pacer.markList(m.family);
  const budget = pacer.v2 ? pacer.familyBudgetS(m.family) * 1000 : Math.min(taskBudgetMs(), Math.max(15000, Math.min(pacer.extraSlackS(), 1e6) * 1000));
  if (budget < 3000) { why(`aggregate: pacer — ${Math.round(budget / 1000)} s of task budget left`); return null; }
  // The aggregate engine alone may count on a finished Show-more list's "about N" footer (apptList.endFormProof). A read estimated
  // at more than the always-allowed 15 s runs only when the pacer has that much slack (extraOk), so the extra time can't push later
  // items past the end of the shift.
  src.begin?.(budget, { endEstimate: true, gate: (estS) => pacer.v2 ? estS <= budget / 1000 : estS <= 15 || pacer.extraOk(estS) });
  const t0 = Date.now();
  // Top-k providers over a big range = ~80 per-provider lists + the close ones read to the end (100+ requests): run 265 spent 36 s on it, drew a
  // 503 and answered nothing. AGG_TOPK=on re-enables it; off, the whole range is read once, which AGG_MAX_REQ declines from its first page.
  const out = await solveAggregate(p.q, src, { topBig: process.env.AGG_TOPK === "on" });
  try { process.stdout.write(JSON.stringify({ event: "aggregate", family: p.family, query: p.q, ms: Date.now() - t0, budgetMs: budget, ..."answer" in out ? { answer: out.answer, detail: out.detail } : { why: out.why }, stats: (src as any).lastStats ?? null }) + "\n"); } catch {}
  if ("why" in out) { why(out.why); return null; }
  return out.answer;
}

/** Clinic-wide list counts (listQuery.ts + listRead.ts): the question parsed into list + filters, the governing count
 *  message's rules (or defaults), one proven-complete filtered read. AGENT_LIST_COUNT=shadow logs the would-be answer only. */
export async function listCount(m: FamilyMatch, index: ClinicIndex, store: MessageStore): Promise<string | null> {
  const { parseListQuery, listPolicy, solveListQuery, listMode } = await import("./listQuery.js");
  const p = parseListQuery(m.text ?? "");
  if (!p.q) { why(p.why); return null; }
  const pol = listPolicy(store.all().map((x) => x.raw), p.q.list, !!p.q.status);
  const log = (o: Record<string, unknown>) => { try { process.stdout.write(JSON.stringify({ event: "list_count", mode: listMode(), query: p.q, ...o }) + "\n"); } catch {} };
  if ("why" in pol) { log({ why: pol.why }); why(pol.why); return null; }
  const src = index.lists;
  if (!src) { why("list: no list reader on this clinic"); return null; }
  pacer.markList(m.family);
  const budget = pacer.v2 ? pacer.familyBudgetS(m.family) * 1000 : Math.min(taskBudgetMs(), Math.max(15000, Math.min(pacer.extraSlackS(), 1e6) * 1000));
  if (budget < 3000) { why(`list: pacer — ${Math.round(budget / 1000)} s of task budget left`); return null; }
  src.begin?.(budget);
  const t0 = Date.now();
  const out = await solveListQuery(p.q, pol, src);
  log({ ms: Date.now() - t0, policy: pol, ..."answer" in out ? { answer: out.answer, detail: out.detail } : { why: out.why } });
  if ("why" in out) { why(out.why); return null; }
  if (listMode() === "shadow") { why(`list: shadow mode (would answer ${out.answer})`); return null; }
  return out.answer;
}

const excluded = (r: { flags: string[] }) => r.flags.some((f) => /test record|deleted/i.test(f));

/** Rows of a provider's day across every location, minus test/deleted patients; null if unread. */
async function dayRows(index: ClinicIndex, provider?: string, dateISO?: string): Promise<ProviderDay | null> {
  if (!provider || !dateISO) { why("provider-day: provider or date missing from the question"); return null; }
  const day = await index.providerDay?.(provider, dateISO).catch((e) => { why("provider-day: reader threw " + String(e).slice(0, 80)); return null; });
  if (!day) { why(`provider-day: no page for ${provider} on ${dateISO} (not on the roster, or the page did not render for that date)`); return null; }
  if (day.dateISO !== dateISO) { why(`provider-day: page rendered ${day.dateISO}, asked ${dateISO}`); return null; }
  return day;
}

export async function dayCount(index: ClinicIndex, provider: string | undefined, dateISO: string | undefined, status: string): Promise<string | null> {
  const day = await dayRows(index, provider, dateISO); if (!day) return null;
  const rows = day.sections.flatMap((s) => s.rows).filter((r) => !r.open && !excluded(r));
  return String(rows.filter((r) => norm(r.status) === status).length);
}

export async function openSlots(index: ClinicIndex, provider?: string, location?: string, dateISO?: string): Promise<string | null> {
  const day = await dayRows(index, provider, dateISO); if (!day) return null;
  if (!location) { why("open-slots: no location in the question"); return null; }
  const sec = day.sections.find((s) => norm(s.location).startsWith(norm(location)));
  if (!sec || !/working/i.test(sec.working)) { why(`open-slots: ${provider} has no working section at ${location} on ${dateISO} (sections: ${day.sections.map((s) => s.location).join(", ") || "none"})`); return null; }
  return String(sec.rows.filter((r) => r.open).length);
}

// ── self-check ──
if (process.argv[1]?.endsWith("/solvers.ts")) {
  const assert = (c: unknown, m: string) => { if (!c) { console.error("✗ " + m); process.exit(1); } };
  const page = (p: Partial<InvoicePage>): InvoicePage => ({ invoice: "94979156", patient: "Lindqvist, Desmond MRN HG1446090", dosISO: "2026-06-12", total: 1257.61, payments: [459.40, 234.92], other: [], status: "Partly paid", owed: 563.29, void: false, ...p });
  const idx = (pg: InvoicePage | null, day?: ProviderDay | null): ClinicIndex => ({ findPatient: () => null, appointments: [], providers: new Map(), byDate: () => [], invoicePage: async () => pg, providerDay: async () => day ?? null });
  (async () => {
    assert((await invoiceBalance(idx(page({})), "94979156", "Desmond Lindqvist", "2026-06-12")) === "563.29", "partly paid: total minus payments");
    assert((await invoiceBalance(idx(page({ total: 186, payments: [186], owed: 0 })), "94979156")) === "0.00", "paid in full → 0.00");
    assert((await invoiceBalance(idx(page({ void: true, other: ["Invoice voided"], owed: 0 })), "94979156")) === "0.00", "void with a payment → 0.00");
    assert((await invoiceBalance(idx(page({ other: ["Adjustment"] })), "94979156")) === null, "unknown ledger line → skip");
    assert((await invoiceBalance(idx(page({ owed: 500 })), "94979156")) === null, "page disagrees with arithmetic → skip");
    assert((await invoiceBalance(idx(page({})), "94979156", "Jane Doe")) === null, "wrong patient → skip");
    assert((await invoiceBalance(idx(page({})), "00000001")) === null, "wrong invoice → skip");
    const day: ProviderDay = { provider: "Diana Anderson", dateISO: "2026-05-16", sections: [{ location: "Northgate", working: "Working 9:00 AM to 1:00 PM", rows: [
      { time: "9:40 AM to 10:10 AM", patient: "Cook, Ingrid", flags: [], type: "Diabetes management", status: "Completed", open: false },
      { time: "11:20 AM to 11:40 AM", patient: "Patient, Zztest", flags: ["Test record"], type: "Office visit", status: "Completed", open: false },
      { time: "11:40 AM to 12:40 PM", patient: "Johnson, Amanda", flags: ["Deleted"], type: "Office visit", status: "Completed", open: false },
      { time: "12:00 PM to 12:20 PM", patient: "", flags: [], type: "", status: "", open: true },
      { time: "12:40 PM to 1:00 PM", patient: "Rodriguez, Hiroshi", flags: [], type: "Office visit", status: "Scheduled", open: false } ] }] };
    assert((await dayCount(idx(null, day), "Diana Anderson", "2026-05-16", "completed")) === "1", "completed count excludes test and deleted records");
    assert((await dayCount(idx(null, day), "Diana Anderson", "2026-05-16", "scheduled")) === "1", "scheduled count");
    assert((await dayCount(idx(null, day), "Diana Anderson", "2026-05-17", "scheduled")) === null, "page for another date → skip");
    assert((await openSlots(idx(null, day), "Diana Anderson", "Northgate", "2026-05-16")) === "1", "open slots in the named location");
    assert((await openSlots(idx(null, day), "Diana Anderson", "Highline", "2026-05-16")) === null, "not working at that location → skip");
    console.log("✓ solvers self-check");
  })();
}
