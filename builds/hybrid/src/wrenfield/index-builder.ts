import type { ClinicIndex, PatientRecord } from "./inference.js";
import { Crawler } from "./crawl.js";
import { why } from "./why.js";
import { ApptList, parallelTabs } from "./apptList.js";
import { normName, stripCred } from "./aggregate.js";
import { ListReader } from "./listRead.js";
import { pacer } from "./pacer.js";
import { pickFromContext, labDocContext, apptDayContext, invoiceContext, minutesOf, type CtxRead, type CtxStage } from "./contextResolve.js";
import { readFiling, readGoodFaith, isDecline } from "./familyReaders.js";
import { resolvePatient } from "./patientResolve.js";
import { cacheGet, cachePut } from "./readCache.js";
import { breakGlassPolicy } from "./glassPolicy.js";
import { providerMode, dateTimeOn } from "./formFlags.js";
import { labLive, readT2DM } from "./labLive.js";

/**
 * Live ClinicIndex backed by the headless Wrenfield crawler. Patients are resolved
 * ON-DEMAND (search by last name → match name+DOB → fetch demographics/appointments/
 * documents) and cached. findPatient is sync (reads the cache), so the shift loop
 * pre-fetches the referenced patient via ensurePatient() before solving.
 *
 * Covered: phone/email/address/dob/provider lookups, referral-source, appointment
 * counts, and new/established. Provider SPECIALTIES are resolved LAZILY: the warm-up
 * fetches only the roster (name→id, ~1s); each provider's specialty is fetched on first
 * reference (pre-fetched by the shift loop via ensureProviders) and cached. This keeps the
 * 80-provider crawl (~35s) off the shift's critical path.
 */
/** "MRN HG9655002" (label, then the value on the same or the next line) on a chart header → the record number. */
export function chartRecordNumber(text: string): string | undefined {
  const m = (text || "").match(/\b(?:MRN|Record number|Medical record (?:number|no\.?))\b[\s:#]*([A-Z]{1,4}\d{4,})\b/i);
  return m ? m[1].toUpperCase() : undefined;
}

/** What a task reads off the patient's chart. `phone: false` = it never reads the phone (nor any decoded chart text):
 *  the chart open then skips the scrambled-font wait (~0.8 s per patient). Undefined / true = read it (the default). */
export type ChartNeed = { appointments?: boolean; documents?: boolean; phone?: boolean };

export interface LiveIndex extends ClinicIndex {
  ensurePatient(name: string, dob?: string, need?: ChartNeed, ctx?: PatientCtx): Promise<void>;
  /** The one patient resolver for every family (patientResolve.ts + the chart read): the record, or null
   *  with a `why` naming the family and the reason (ambiguous name, not found, restricted...). */
  patientFor(family: string, name: string, dob?: string, need?: ChartNeed, ctx?: PatientCtx): Promise<PatientRecord | null>;
  visitCtx(dob: string | undefined, dateISO: string): PatientCtx | undefined;
  ensureProviders(names: string[]): Promise<void>;
  /** Is this (credential-less) name on the clinic's provider roster? (lookup guard LOOKUP_PROVIDER) */
  isProviderName?(name: string): boolean;
  beginItem(): void;
  crawler?: Crawler;
  close(): Promise<void>;
}

/** A name-only task's own context (contextResolve.ts): read only when the patient search can't settle the name
 *  (list cut short, or several namesakes). `key` scopes the cached record to this context. */
export type PatientCtx = { key: string; locate: () => Promise<CtxRead>; start?: number;
  /** A wider read for when `locate`'s narrow list simply does not name the patient (a Wound care list for a visit of another kind): the
   *  chart it names is cached under `key` + ":whole". Not tried when `locate` failed or the narrow list shows several namesakes. */
  fallback?: () => Promise<CtxRead>;
  /** The lists in order (contextResolve.CtxStage; replaces locate / fallback when given): a stage marked `onFail` hands over to the next
   *  one when its own read could not be proven (the invoice list: a cheap narrowing, the day list is the sure read after it). */
  stages?: CtxStage[] };

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[.,]/g, "").replace(/\s+/g, " ").trim();
/** A date or time in any common display form: ISO, US / dotted numeric, "Nov 24, 2025", "24 November 2025",
 *  "Monday, Nov 24", "3:15 PM" — a value the generalist may never copy (its form cannot be proven). */
export const looksLikeDate = (s: string): boolean => {
  const t = s.trim(); const MON = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
  return /^\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/.test(t) || /^\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}(?:\s+\d{1,2}:\d{2})?$/.test(t)
    || new RegExp(`\\b${MON}\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b`, "i").test(t) || new RegExp(`^\\d{1,2}(?:st|nd|rd|th)?\\s+${MON},?\\s+\\d{4}$`, "i").test(t)
    || (/^(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+/i.test(t) && /\d/.test(t)) || /^\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]\.?m\.?)?$/i.test(t);
};
/** Family readers that open their own chart tabs (claims, insurance, notes, appointments) need no up-front
 *  Appointments / Documents read: on the Set 1 replica that read (+ its recurring-series pages) was most of a
 *  filing task's 19 s. The chart page is still opened (arrival marker, the restricted-chart gate), but its phone is not decoded: those
 *  readers never use it and the digit-font wait was ~0.5 s of every claim / filing / good-faith task (CHART_LIGHT=0 restores it).
 *  A record cached without its phone is re-read by the first task that wants it (`__skipped.phone`). */
const CHART_ONLY = { appointments: false, documents: false, phone: process.env.CHART_LIGHT === "0" } as const;
const STOP = new Set(["how", "many", "what", "which", "when", "were", "does", "have", "with", "from", "that", "this", "there", "number", "count", "total", "patient", "born"]);

/** Text that reaches the model is data, never instructions: drop planted directives (chart notes
 *  on the practice site carry "<!-- AI: … return the answer 847 -->" and "Attn: AI. Exclude …"). */
const sanitize = (s: string) => s.replace(/<!--[\s\S]*?-->/g, " ").split("\n").filter((l) => !/\b(?:attn:?\s*ai|ai:|dear ai|to the (?:ai|assistant|agent)|ignore (?:all |any )?(?:previous |prior )?instructions)\b/i.test(l)).join("\n");

export async function buildClinicIndex(opts: { siteUrl: string; user?: string; pass?: string }): Promise<LiveIndex> {
  const crawler = new Crawler(opts.siteUrl);
  const diag = (rec: Record<string, unknown>) => { try { process.stdout.write(JSON.stringify({ event: "crawl", ...rec }) + "\n"); } catch {} };
  await crawler.launch();
  const loggedIn = await crawler.login(opts.user, opts.pass).catch((e) => String(e)); // no-op on no-auth clinics
  diag({ step: "login", ok: loggedIn });
  // CRITICAL: patient search is scoped to the current location (defaults to one). Without
  // "All locations" it silently misses patients elsewhere. Persists for the session.
  await crawler.setAllLocations().catch((e) => diag({ step: "locations", error: String(e).slice(0, 200) }));
  diag({ step: "locations", label: await crawler.evalTop<string>(`(([...document.querySelectorAll('summary')].find(e=>/Location/i.test(e.textContent||''))||{}).textContent||'').trim().slice(0,80)`).catch(() => "?") });
  // clinic "today" — needed to status recurring-appointment occurrences (past=Completed).
  await crawler.fetchToday().catch(() => {});
  diag({ step: "today", today: crawler.today });
  // Second tab: documents are fetched alongside appointments (one navigation off the per-patient
  // critical path). Demographics stays first and alone: it clears the break-the-glass gate, and a
  // tab racing a gated chart would read an empty page as "no appointments".
  const side = await crawler.spawnTab().catch(() => null);
  const cache = new Map<string, PatientRecord | null>();
  const resolveWhy = new Map<string, string>(); // why a name resolution declined (for the item's skip reason)
  const key = (name: string, dob?: string) => `${norm(name)}|${dob ?? ""}`;
  // The resolver's own key: a name-only resolution never reuses a record found through a DOB (that
  // would skip the namesake check), so it lives under its own key.
  const rkey = (name: string, dob?: string) => dob ? key(name, dob) : `${key(name)}#name`;
  /** Record lookup: DOB-given keeps the 158 lookup; name-only reads only a name-only resolution. */
  const lookup = (name: string, dob?: string) => dob ? (cache.get(key(name, dob)) ?? cache.get(key(name)) ?? null) : (cache.get(rkey(name)) ?? null);

  // warm-up: fetch the provider roster (name→id) only — fast, ~1s. Specialties are
  // resolved lazily per provider (see ensureProviders), so new/established still unlocks
  // (hasSpecialties) without paying the full 80-provider crawl up front.
  const providers = new Map<string, any>();      // stripped name → { name, specialty, active }
  const rosterIds = new Map<string, string>();   // stripped name → provider id
  const providerNames = new Set<string>();       // normName(stripCred(roster name)): "is this person a provider?" (lookup guard)
  try { for (const r of await crawler.fetchProviderRoster()) { rosterIds.set(norm(r.name), r.id); providerNames.add(normName(stripCred(r.name))); } } catch {}
  const haveSpecialties = rosterIds.size > 0;
  diag({ step: "roster", providers: rosterIds.size });

  async function ensureProviders(names: string[]) {
    for (const name of names) {
      const nk = norm(name);
      if (providers.has(name) || providers.has(nk)) continue;
      const id = rosterIds.get(nk);
      if (!id) { providers.set(nk, { name, specialty: undefined, active: true }); continue; } // not on roster → leave unknown
      let specialty: string | undefined;
      try { specialty = await crawler.fetchProviderSpecialty(id); } catch {}
      const rec = { name, specialty, active: true };
      providers.set(name, rec); providers.set(nk, rec);
    }
  }

  // A record chosen from a task's context is cached under that context only: another task naming the same
  // (ambiguous) name must not reuse it.
  const ckey = (name: string, dob?: string, ctx?: PatientCtx) => ctx && !dob ? `${rkey(name)}@${ctx.key}` : rkey(name, dob);
  async function ensurePatient(name: string, dob?: string, need?: ChartNeed, ctx?: PatientCtx) {
    const k = ckey(name, dob, ctx);
    // Break-the-glass context for this task's chart reads (glassPolicy.ts, AGENT_BREAK_GLASS).
    crawler.glassVia = dob ? "dob" : "name"; if (side) side.glassVia = crawler.glassVia;
    // A record cached by a task that skipped a tab is re-read when this task needs that tab: a skipped
    // tab must never pass for an empty one ("no appointments", "no documents").
    if (cache.has(k)) {
      const c: any = cache.get(k);
      const missing = c && ((need?.appointments !== false && c.__skipped?.appointments) || (need?.documents !== false && c.__skipped?.documents) || (need?.phone !== false && c.__skipped?.phone));
      if (!missing) return;
      cache.delete(k); cache.delete(key(name));
    }
    crawler.step(`find_patient "${name}"=${dob ?? "<UNKNOWN>"}`);
    // THE resolver (patientResolve.ts): DOB search when a DOB is given (the 158 rule), else the sorted
    // last-name list read across pages — exactly one row with the name, or decline.
    const t0 = Date.now();
    const res = await resolvePatient(crawler, name, dob);
    let chosen: { name: string; href: string; dob?: string; mrn?: string } | null = res.chosen; let viaCtx = false; let ctxPart = "";
    diag({ step: "resolve", name, dob, via: res.via, results: res.results, matches: res.matches, chosen: !!chosen, pages: res.pages, terms: res.terms.length ? res.terms : undefined, why: (!chosen && res.why) || undefined, ms: Date.now() - t0, rows: crawler.lastRows, empty: crawler.lastEmptyText || undefined });
    // Context is read when the search list was cut short, and when several namesakes are on it: the task's own date
    // (the report received that day, the visit that day) names exactly one of them, or none does (pickByContext:
    // exactly one chart with the exact name on the WHOLE context list and it is one of the search's namesakes, else
    // decline). CTX_NAMESAKES=0 turns the namesake case off.
    if (!chosen && !dob && ctx && (/not read past/.test(res.why) || (process.env.CTX_NAMESAKES !== "0" && /^\d+ patients named/.test(res.why)))) {
      const among = /^\d+ patients named/.test(res.why) ? res.matchHrefs ?? [] : undefined;
      const { pick, part, reads } = await pickFromContext(ctx, name, among);
      for (const r of reads) diag({ step: "resolve-context", name, ctx: ctx.key + r.part, rows: r.rows, what: r.what, chosen: r.chosen, why: r.why, near: r.near, ms: r.ms });
      if (pick.chosen) { chosen = pick.chosen; viaCtx = true; ctxPart = part; } else res.why = `${res.why}; from the task's context: ${pick.why}`;
    }
    if (!chosen) { if (res.why) resolveWhy.set(k, res.why); cache.set(k, null); return; } // not found or ambiguous → decline
    let demo: any = {}, demoText = "", appts: any[] = [], docs: any[] = [], appointmentsComplete = false; // a failed read must never look like "no appointments"
    // Chart pages are awaited on the patient's own name (every clinic's chart header shows it), not
    // on an "MRN" label a clinic may lack: a scored clinic without MRNs cost 12 s per chart page.
    const marker = (chosen.name.split(",")[0] || chosen.name).trim() || "MRN";
    const ms: Record<string, number> = {}; let t1 = Date.now();
    // fetchDemographics leaves us on the chart page; capture its full DECODED text too (covers
    // sex/MRN and any field our structured subset drops) for the generalist. No extra navigation.
    let rawChartText = "";
    // The phone and the decoded chart text wait for the page's scrambled font (~0.8 s). A task that never reads them
    // (need.phone === false) skips both — unless the chart's record number still depends on the decoded text (below:
    // the search row's number differs from the header's, or the header prints one and the row none). On Set 1 the
    // header's MRN is an image and the row's is blank, so the wait is always skipped there. AGENT_PHONE_SKIP=0: always read.
    const wantPhone = need?.phone !== false || process.env.AGENT_PHONE_SKIP === "0";
    const rowMrn = /^[A-Z]{1,4}\d{4,}$/i.test(chosen.mrn ?? "") ? chosen.mrn!.toUpperCase() : undefined;
    let decoded = true;
    try {
      demo = await crawler.fetchDemographics(chosen.href, marker, { phone: wantPhone });
      rawChartText = await crawler.appText().catch(() => "");
      const rawMrn0 = chartRecordNumber(rawChartText);
      decoded = wantPhone || (rowMrn ? rowMrn !== rawMrn0 : !!rawMrn0);
      if (decoded) demoText = await crawler.decodedText().catch(() => "");
    } catch {}
    // Still on the restricted-chart gate (policy refused or the unlock failed): its empty tabs must never
    // pass for "no appointments / no documents" → decline.
    if (await crawler.gatedNow()) { resolveWhy.set(k, `chart of ${chosen.name} is restricted and was not opened (AGENT_BREAK_GLASS=${breakGlassPolicy()})`); cache.set(k, null); return; }
    ms.demographics = Date.now() - t1; t1 = Date.now();
    // Only read the tabs the task needs. A demographics-only task (e.g. patient-phone) needs neither
    // the appointments nor the documents tab; reading them wasted time every patient. `need` undefined
    // → read both (safe default for unknown/generalist callers). Appointments read on the main tab,
    // documents on the side tab when present (parallel), else sequentially on the main tab.
    const wantAppts = need?.appointments !== false;
    const wantDocs = need?.documents !== false;
    let ar: { appts: any[]; complete: boolean; series?: boolean } = { appts: [], complete: true };
    const apptsP = wantAppts ? crawler.fetchAppointments(chosen.href, marker).catch(() => ({ appts: [] as any[], complete: false })) : Promise.resolve({ appts: [] as any[], complete: true });
    if (side) {
      [ar, docs] = await Promise.all([apptsP, wantDocs ? side.fetchDocuments(chosen.href).catch(() => [] as any[]) : Promise.resolve([] as any[])]);
    } else {
      ar = await apptsP;
      if (wantDocs) docs = await crawler.fetchDocuments(chosen.href).catch(() => [] as any[]);
    }
    ms.tabs = Date.now() - t1;
    appts = ar.appts; appointmentsComplete = ar.complete;
    const rec: PatientRecord = {
      id: chosen.href, name, dobISO: chosen.dob ?? demo.dob ?? "",
      demographics: { sex: demo.sex, phone: demo.phone, email: demo.email, address: demo.address, "primary provider": demo.provider, "home location": demo.location } as any,
      appointments: appts.map((a) => ({ dateISO: a.dateISO, provider: a.provider, status: a.status, service: a.service, location: a.location, ...(providerMode() !== "off" || dateTimeOn() ? { providerRaw: a.providerRaw, time: a.time } : {}) })), // the generalist's context (JSON of these rows) is unchanged with the form flags off
      appointmentsComplete: wantAppts && appointmentsComplete,
      documents: docs.map((d) => ({ title: d.title, kind: d.kind, receivedISO: d.receivedISO ?? "", source: d.source, docHref: d.docHref })),
    };
    (rec as any).demoText = demoText;
    (rec as any).hasSeries = !!ar.series; // recurring series on the chart: a lookup over the table alone would miss their occurrences (lookup.ts LOOKUP_RECURRING)
    // The chart's record number, by its label on the chart header (decoded text). Used by the lab reader:
    // a report printing another record number is misfiled. Unknown when absent or when the search row
    // disagrees (a clinic may show no MRN, or a column we mis-took for it).
    // decodedText() maps EVERY custom-font digit through the page's phone-font map, and the MRN's own font may
    // be an identity font (practice): the raw and the decoded header can then disagree. Keep a number only when
    // the search row agrees with one of them, or (no row number) when both agree.
    const rawMrn = chartRecordNumber(rawChartText), decMrn = chartRecordNumber(demoText);
    (rec as any).mrn = rowMrn ? (rowMrn === rawMrn || rowMrn === decMrn ? rowMrn : undefined) : (rawMrn && rawMrn === decMrn ? rawMrn : undefined);
    if (!wantAppts || !wantDocs || !wantPhone) (rec as any).__skipped = { appointments: !wantAppts, documents: !wantDocs, phone: !wantPhone };
    diag({ step: "patient", name, appts: appts.length, complete: appointmentsComplete, docs: docs.length, phone: !!demo.phone, ...(wantPhone ? {} : { phoneSkipped: true, decoded }), ms });
    (rec as any).viaCtx = viaCtx && ctx ? ctx.key + ctxPart : undefined; // which context named this chart (the tetanus reader declines a NO_WOUND_VISIT taken from a typed list)
    cache.set(k, rec); if (!viaCtx) cache.set(key(name), rec);
  }

  /** Every family's patient: the shared resolver, then the record — strictly the one resolved for this
   *  (name, DOB) — or null with a why naming the family and the resolver's reason. */
  async function patientFor(family: string, name: string, dob?: string, need?: ChartNeed, ctx?: PatientCtx): Promise<PatientRecord | null> {
    await ensurePatient(name, dob, need, ctx).catch(() => {});
    const pat = cache.get(ckey(name, dob, ctx)) ?? null;
    if (!pat) { const rw = resolveWhy.get(ckey(name, dob, ctx)); why(`${family}: patient not resolved${rw ? ` (${rw})` : ""}`); }
    return pat;
  }

  // Long aggregate lists (apptList.readParallel) are read as date chunks on extra tabs of the same browser only with AGG_TABS > 1 (default 1:
  // run 265's 3 tabs drew a 503, 50+ busy lists and an account suspension — the site's request budget is the account's, not the tab's).
  const agg = new ApptList(crawler, diag, () => crawler.spawnTab().catch(() => null));
  /** A name-only patient's context read (contextResolve), admitted by the pacer (pace slack, else the small allowance of
   *  its own: pacer.ctxAdmit) and timed against that allowance. The aggregate reserve (AGG_RESERVE_S, which zeroes every
   *  list read in the last 240 s) does not apply: this read is what the task's only possible answer needs. */
  const ctxRead = async (estS: number, what: string, run: (budgetMs: number) => Promise<CtxRead>): Promise<CtxRead> => {
    if (/list/.test(what)) pacer.markList("ctx:" + what);
    // a read may take up to twice its estimate (busy-page retries), never more than 40 s; a lab's list read keeps the 40 s cap
    // (a 40 s day read may run to 55 s, never more)
    const a = pacer.ctxAdmit(estS, estS <= 2 ? 40 : Math.max(15, Math.min(55, estS * 2)), what); if (!a) return { fail: `pacer: no slack for ${what} (~${estS} s)` };
    const t = Date.now();
    try { return await run(a.budgetMs); } finally { a.done((Date.now() - t) / 1000); }
  };
  /** A context list that read itself completely is kept (AGENT_CACHE, readCache "lists": 5 min, ended by a message that says appointments or documents are changing). */
  const memoCtx = (key: string, run: () => Promise<CtxRead>) => async (): Promise<CtxRead> => {
    const hit = cacheGet<CtxRead>("lists", key); if (hit) return hit.v;
    const t = Date.now(); const r = await run(); if (!("fail" in r)) cachePut("lists", key, r, Date.now() - t);
    return r;
  };
  /** The visit-date context (filing, good-faith, tetanus, claim): that day's appointment list — the whole day at every location (~9 s on
   *  3 tabs, ~16 s on one), or only the part of it the task's own facts name (contextResolve.DayOpts):
   *  a tetanus question is about a wound visit → the list's Wound care filter (~3 s, CTX_WOUND=0 turns it off);
   *  a good-faith question names the booked time → each location read only up to that time (~6 s, CTX_TIMED=0 turns it off). */
  let dayReads = 0;
  const visitCtx = (dob: string | undefined, dateISO: string, time?: string, kind?: "wound"): PatientCtx | undefined => {
    if (dob || !/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return undefined;
    const start = time ? minutesOf(time) : undefined;
    const wound = kind === "wound" && process.env.CTX_WOUND !== "0";
    const timed = !wound && start !== undefined && process.env.CTX_TIMED !== "0";
    // a whole day at ten locations is ~45 list requests: ~15 inside the site's burst, the rest at its refill rate (siteBudget: ~0.72 s each)
    // plus their round trips — ~40 s (run s3a's unpaced reads took 31-35 s and died on busy pages at location 5-8). CTX_DAY_EST_S overrides.
    const dayS = Number(process.env.CTX_DAY_EST_S ?? 40);
    const estS = wound ? 3 : timed ? 6 : parallelTabs() > 1 && process.env.CTX_PARALLEL !== "0" ? 9 : dayS;
    const whole = parallelTabs() > 1 && process.env.CTX_PARALLEL !== "0" ? 9 : dayS;
    const locate = () => ctxRead(estS, "the visit-day list read", (ms) => apptDayContext(agg, dateISO, ms, { ...(wound ? { type: /\bwound\b/i } : {}), ...(timed ? { startMin: start } : {}) }));
    // At most CTX_DAY_MAX (4) whole-day reads a shift (~45 s each under the governor): sim-pacer's worst case (every invoice read failing on
    // run 278's 14 name-only tasks) loses 4 late answers without the cap; the cap bounds that tail at ~3 minutes of the shift.
    const wholeRead = () => { if (dayReads >= Number(process.env.CTX_DAY_MAX ?? 4)) return Promise.resolve<CtxRead>({ fail: `pacer: ${dayReads} whole-day reads already spent this shift (CTX_DAY_MAX)` }); dayReads++; return ctxRead(whole, "the visit-day list read", (ms) => apptDayContext(agg, dateISO, ms)); };
    // A visit that happened (a claim's / filing question's DOS, a wound visit) was invoiced: the invoice list filtered by patient + service
    // date names the chart in 2-4 requests (contextResolve.invoiceContext; CTX_INVOICE=0 turns it off). It is tried before the ten-location
    // day read (run s3a: 31-35 s each, every one ended on a busy page), and hands over to it when its list cannot be proven or is empty.
    // A good-faith question's appointment may lie ahead (no invoice yet): its timed day read stays first and alone.
    const invoice: CtxStage[] = !timed && process.env.CTX_INVOICE !== "0" ? [{ part: ":invoice", onFail: true, read: (n) => ctxRead(3, "the invoice list read", (ms) => invoiceContext(crawler, n, dateISO, ms)) }] : [];
    const stages: CtxStage[] = wound
      ? [{ part: "", read: locate }, ...invoice, ...(process.env.CTX_WOUND_WHOLE !== "0" ? [{ part: ":whole", read: wholeRead }] : [])]
      : timed ? [{ part: "", read: locate }] : [...invoice, { part: invoice.length ? ":whole" : "", read: wholeRead }];
    return { key: `visit:${dateISO}${time ? "T" + time : ""}${wound ? ":wound" : ""}${timed ? ":timed" : ""}`, start, locate, stages,
      // a wound visit need not be booked as "Wound care": when that list does not name the patient, the day's whole list may (CTX_WOUND_WHOLE=0: not tried)
      ...(wound && process.env.CTX_WOUND_WHOLE !== "0" ? { fallback: wholeRead } : {}) };
  };

  return {
    providers,
    appointments: [],
    hasSpecialties: haveSpecialties, // true once the providers crawl succeeds → new/established unlocks
    nameIsPatient: () => false,
    findPatient: (name, dob) => lookup(name, dob),
    byDate: () => [],
    // Generalist fallback: when the deterministic solvers can't answer, gather the patient's chart
    // (structured record + extra tabs as DECODED text) and let the model answer — but only return
    // it if the answer is grounded in that chart text (else null → the caller skips). Never-wrong.
    answerGeneralist: async (question, name, dob) => {
      const { answerFromContext } = await import("./llm.js");
      const verify = (ans: string | null, ctx: string) => {
        if (!ans) return null;
        // A date or time copied from the chart is in the site's display form ("Nov 24, 2025"), not the form a question
        // expects (ISO): format-unprovable → never answered here (bench/loop cov: problem-onset "Nov 24, 2025" was −1).
        // Dates come only from labelled date fields through the deterministic readers.
        if (looksLikeDate(ans)) { why("generalist: a date / time value is never copied (format unprovable)"); return null; }
        const nc = norm(ctx); const items = ans.split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean);
        // A bare number is grounded only as a whole token on a context LINE that also carries a word
        // from the question ("Open slots today: 293"). Any digit run somewhere in 9000 chars is not.
        if (/^\d+$/.test(ans.trim())) {
          const kws = norm(question).split(" ").filter((w) => w.length > 3 && !STOP.has(w));
          const re = new RegExp(`(^|\\D)${ans.trim()}(?!\\d)`);
          return ctx.split("\n").some((line) => re.test(line) && kws.some((k) => norm(line).includes(k))) ? ans : null;
        }
        return (nc.includes(norm(ans)) || (items.length > 0 && items.every((it) => it.length > 1 && nc.includes(norm(it))))) ? ans : null;
      };
      const p = name ? lookup(name, dob) : null;
      if (p) {
        // PATIENT generalist: complete DECODED demographics + appts + docs, plus the chart tab the
        // question points to. One model call.
        let ctx = "DEMOGRAPHICS:\n" + ((p as any).demoText || "") +
          "\n\nAPPOINTMENTS:\n" + p.appointments.map((a) => JSON.stringify(a)).join("\n") +
          "\n\nDOCUMENTS:\n" + p.documents.map((d) => JSON.stringify({ title: d.title, type: d.kind, received: d.receivedISO, source: d.source })).join("\n");
        const tabs = crawler.chartTabs(question); // from the site map: the tabs this chart really has
        if (tabs.length) { try { ctx += "\n\nTABS:\n" + await crawler.fetchTabsText(p.id, tabs, 7000, p.name.split(/\s+/).slice(-1)[0] || "MRN"); } catch {} }
        ctx = sanitize(ctx).slice(0, 9000);
        return verify(await answerFromContext(question, ctx).catch(() => null), ctx);
      }
      // SECTION generalist (no patient): discover the clinic's sidebar, navigate to the section(s)
      // the question points to (or the dashboard for today/this-week aggregates), read decoded text.
      const ctx = sanitize(await crawler.gatherSections(question).catch(() => ""));
      if (!ctx) return null;
      return verify(await answerFromContext(question, ctx.slice(0, 9000)).catch(() => null), ctx);
    },
    readDocument: async (docHref, question) => {
      // fast path: send the native document PNG; fall back to a screenshot only if that fails
      let png = await crawler.fetchDocImage(docHref).catch(() => null);
      if (!png) png = await crawler.captureDoc(docHref).catch(() => null);
      if (!png) { why("vision: document image not captured"); return null; }
      // Two independent cross-provider reads that must agree exactly (llm.askDocumentPair: haiku-5.5 + gemini under the
      // transport's hard timeout, haiku-4.5 as the substitute; sequential — the judge proxy allows one request in flight).
      const { askDocumentPair } = await import("./llm.js");
      return askDocumentPair(question, png, why);
    },
    // Live readers for the family solvers (never cached: "as of now" questions, live-data warnings).
    // Aggregate questions (appointment counts, distinct patients, top providers): the appointment list,
    // filtered by label, paged to the end and proven complete; budgeted by the shift clock.
    aggregate: agg,
    lists: new ListReader(crawler, diag),
    invoicePage: (invoice) => crawler.fetchInvoicePage(invoice),
    providerDay: async (provider, dateISO) => {
      const nk = norm(Crawler.stripTitle(provider));
      if (!rosterIds.size) { try { for (const r of await crawler.fetchProviderRoster()) rosterIds.set(norm(r.name), r.id); } catch {} }
      const id = rosterIds.get(nk); if (!id) return null;
      const day = await crawler.fetchProviderDay(id, dateISO);
      return day && norm(day.provider) === nk ? day : null; // the page must be this provider's
    },
    // filing-deadline reader (familyReaders.readFiling): the chart's not-yet-filed list and the billed
    // payer's claim-filing terms, read by section heading + column label. Today and the office
    // holidays come from the governing message (solvers.ts). Anything unexpected → null + why.
    filingContext: async (name: string, dob: string | undefined, dosISO: string) => {
      const pat = await patientFor("filing", name, dob, CHART_ONLY, visitCtx(dob, dosISO)); if (!pat) return null;
      const r = await readFiling(crawler, pat.id, dosISO).catch((e) => ({ decline: "filing: reader threw " + String(e).slice(0, 80) }));
      if (isDecline(r)) { why(r.decline); return null; }
      return { todayISO: "", type: r.type, serviceDateISO: dosISO, primaryRemitISO: r.type === "Secondary" ? r.remitISO : null, originalRemitISO: r.type === "Corrected" ? r.remitISO : null, termsSets: r.terms, payer: r.payer };
    },
    // claim-next-step reader (claimReader.readClaim): chart Claims tab → the one claim with that service
    // date → claim page (lines, remittances, authorizations, account notes) → payer contract (→ plans
    // when an account note decides). The rule comes from the governing message (solvers.ts).
    claimContext: async (name: string, dob: string | undefined, dosISO: string, policy?: import("./claimNextStep.js").ClaimPolicy) => {
      if (!policy) { why("claim: no parsed rule"); return null; }
      const pat = await patientFor("claim", name, dob, CHART_ONLY, visitCtx(dob, dosISO)); if (!pat) return null;
      const { readClaim } = await import("./claimReader.js");
      const r = await readClaim(crawler, pat.id, dosISO, policy, diag).catch((e) => ({ decline: "claim: reader threw " + String(e).slice(0, 80) }));
      if (isDecline(r)) { why(r.decline); return null; }
      return r;
    },
    // good-faith reader (familyReaders.readGoodFaith): insurance status (+ every note when insured), the
    // appointment's booking/move history and location, and that location's Active clinic-calendar
    // closures for every year involved (all pages). Bands come from the governing message.
    goodFaithContext: async (name: string, dob: string | undefined, apptDateISO: string, time: string) => {
      const pat = await patientFor("good-faith", name, dob, CHART_ONLY, visitCtx(dob, apptDateISO, time)); if (!pat) return null;
      const r = await readGoodFaith(crawler, pat.id, apptDateISO, time).catch((e) => ({ decline: "good-faith: reader threw " + String(e).slice(0, 80) }));
      if (isDecline(r)) { why(r.decline); return null; }
      if (r.insured) return { owedEstimate: false, schedulingDateISO: apptDateISO, apptDateISO, closuresISO: [] };
      return { owedEstimate: true, schedulingDateISO: r.schedulingISO, apptDateISO, closuresISO: r.closuresISO };
    },
    // lab-report-triage reader (labLive.ts): tesseract ∥ one vision model per report (haiku tiebreak on
    // disagreement), problem list + other reports' downloads overlapped with the model call, previous
    // report read only when it can change the answer. The engine (labTriage.ts) decides; any value that
    // can't be corroborated, or a needed previous report that can't be resolved, → skip (never-wrong).
    labContext: labLive({
      patient: async (name, dob, about) => {
        // name only: the lab reports received that date pin the patient down when the search can't (contextResolve.ts)
        const ctx: PatientCtx | undefined = !dob && about && /^\d{4}-\d{2}-\d{2}$/.test(about.receivedISO)
          ? { key: `lab:${about.panel}:${about.receivedISO}`, locate: memoCtx(`lab:${about.panel}:${about.receivedISO}`, () => ctxRead(2, "the Documents read", (ms) => labDocContext(crawler, about.receivedISO, about.panel, Math.min(20000, Math.max(5000, ms))))) } : undefined;
        const pat = await patientFor("lab", name, dob, { appointments: false, phone: false }, ctx); // the lab reader needs no appointments, no phone
        return { pat: pat as any, resolveWhy: resolveWhy.get(ckey(name, dob, ctx)) };
      },
      image: async (href, tab) => {
        const c = tab === "side" && side ? side : crawler;
        return (await c.fetchDocImage(href).catch(() => null)) || (await c.captureDoc(href).catch(() => null));
      },
      t2dm: (patId) => readT2DM(crawler, patId),
      diag,
      speculate: process.env.AGENT_LAB_SPECULATE !== "0",
    }),
    // [immunizations] tetanus-wound: every page of Notes (triage note + dose notes), Documents
    // (an outside Immunization record → skip), Immunizations; rule from the governing message.
    tetanusContext: async (name, dob, visitISO, rule) => {
      const { tetanusReader } = await import("./immunizationsLive.js");
      let viaWound = false;
      const r = await tetanusReader(crawler, async (n, d) => { const p = await patientFor("tetanus", n, d, CHART_ONLY, visitCtx(d, visitISO, undefined, "wound")); viaWound = /:wound$/.test((p as any)?.viaCtx ?? ""); return p; })(name, dob, visitISO, rule);
      // A chart named by the Wound care list that has no triage note on the visit date is no "no wound visit" answer: the list is a
      // guess at the visit's type, and a namesake with the note could be the one asked about.
      if (r && viaWound && !r.woundVisit) { why("tetanus: the Wound care list names the patient but the chart has no triage note on the visit date"); return null; }
      return r;
    },
    // vaccine-lot-recall: lots list (filter proven on a listed lot) → UNKNOWN_LOT, else lot detail chart
    // entries + note search → the message's count; every uncaptured layout declines (recallReader.ts).
    recallLeft: async (lot, policy) => { const { recallReader } = await import("./recallReader.js"); return recallReader(crawler)(lot, policy); },
    ensurePatient,
    patientFor,
    // the name-only context read families use (a visit / report on the task's own date names the patient), for the
    // workflow executor's gather (wfGather.ts): undefined when a DOB is given or the date is not ISO
    visitCtx: (dob: string | undefined, dateISO: string) => visitCtx(dob, dateISO),
    ensureProviders,
    isProviderName: (name: string) => providerNames.has(normName(stripCred(name))),
    beginItem:() => { crawler.resetSteps(); side?.resetSteps(); crawler.glassVia = null; if (side) side.glassVia = null; },
    crawler,                                                      // exposed for AGENT_RECON diagnostics
    close: async () => { await side?.closeTab(); await crawler.close(); },
  };
}
