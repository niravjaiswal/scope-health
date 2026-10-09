/**
 * ORACLE ONLY — not on the live path. Baseline claim-next-step pipeline from baseline implementation
 * (), kept verbatim so it can be run side by side with the live pipeline (claimReader.ts +
 * claimNextStep.ts) in claim-differential.ts:
 *   - the engine ( claimNextStep.ts: float money, rule constants in code);
 *   - readers.ts' assembleClaim + parseAdjustment + originalFilingDays + parseAppealDays + parseFilingTerms;
 *   - the claim-detail DOM walker from index-builder's claimContext (one page digit map for every
 *     custom-font leaf), as a script body runnable in jsdom.
 * See CONSOLIDATION.md ("claim-next-step") for the differential results and why the live path is ours.
 * Self-checks (Baseline, unchanged): npx tsx src/wrenfield/claimOracle.ts
 */
import { monthDateISO } from "./readers.js";

// ════════ Baseline engine ( claimNextStep.ts) ════════
export type Group = "CO" | "PR" | "OA" | "PI" | string;
export interface Adjustment { group: Group; reason: number; amount: number }
export interface RemitLine { procedure: string; adjustments: Adjustment[]; remarks: string[] }
export interface Remittance { id: string; paymentDateISO: string; isReversal: boolean; reversed: boolean; lines: RemitLine[] }
export interface Submission { acceptedResultDateISO: string | null; clearinghouseRejected: boolean }
export interface Authorization { payer: string; procedure: string; validFromISO: string; validToISO: string }
export interface OtherInsuranceNote { dateISO: string; plan: string | null; coversOnDOS: boolean }
export interface BilledLine { procedure: string; modifiers: string[] }
export interface ClaimContext {
  todayISO: string;
  serviceDateISO: string;
  payer: string;
  filingDays: number | null;        // payer contract "claims accepted within" (days from DOS)
  appealDays: number | null;        // payer contract "appeals accepted within" (days from payment date)
  remittances: Remittance[];        // every remittance on THIS claim
  billedLines: BilledLine[];        // the claim as we billed it (for bundling col1 presence + modifier 59)
  authorizations: Authorization[];
  otherInsuranceNotes: OtherInsuranceNote[]; // account notes mentioning other insurance, any order
  submissions?: Submission[];                // claim submissions + their accepted result dates (reason 29)
}

const DENIAL_REASONS = new Set([16, 22, 29, 97, 197]);
const REASON_PRIORITY = [29, 22, 16, 197, 97];
// remark-code → field, in the message's table order (first match wins)
const REMARK_FIELD: Array<[string, string]> = [
  ["N290", "RENDERING_PROVIDER_ID"], ["N286", "REFERRING_PROVIDER_ID"], ["N382", "MEMBER_ID"],
  ["M51", "PROCEDURE_CODE"], ["M76", "DIAGNOSIS"], ["M77", "PLACE_OF_SERVICE"],
];
// NCCI pairs: col1, col2, indicator (1 = appealable with modifier 59; 0 = never separate)
const BUNDLES: Array<{ col1: string; col2: string; indicator: 0 | 1 }> = [
  { col1: "17110", col2: "11102", indicator: 1 }, { col1: "17000", col2: "11102", indicator: 1 },
  { col1: "20610", col2: "20605", indicator: 1 }, { col1: "12001", col2: "10060", indicator: 0 },
  { col1: "17110", col2: "11200", indicator: 0 },
];

const money = (n: number) => (Math.round(n * 100) / 100).toFixed(2);
function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number); const dt = new Date(Date.UTC(y, m - 1, d)); dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
const lineDenied = (l: RemitLine) => l.adjustments.some((a) => a.group === "CO" && DENIAL_REASONS.has(a.reason));
const coAmountForReason = (lines: RemitLine[], reason: number) =>
  lines.flatMap((l) => l.adjustments).filter((a) => a.group === "CO" && a.reason === reason).reduce((s, a) => s + a.amount, 0);

/** The current remittance: of the payments (not reversals) not reversed by a later reversal, the one
 *  with the latest payment date. null when none (→ AWAIT_PAYER). */
export function currentRemittance(rems: Remittance[]): Remittance | null {
  const live = rems.filter((r) => !r.isReversal && !r.reversed);
  if (!live.length) return null;
  return live.slice().sort((a, b) => (a.paymentDateISO < b.paymentDateISO ? 1 : a.paymentDateISO > b.paymentDateISO ? -1 : 0))[0];
}

export function decideClaim(c: ClaimContext): string | null {
  const cur = currentRemittance(c.remittances);
  if (!cur) return "AWAIT_PAYER";
  const lines = cur.lines;
  const denied = lines.filter(lineDenied);

  // Nothing denied → paid. Patient owes the PR 1/2/3 total.
  if (!denied.length) {
    const pr = lines.flatMap((l) => l.adjustments).filter((a) => a.group === "PR" && [1, 2, 3].includes(a.reason)).reduce((s, a) => s + a.amount, 0);
    return pr > 0 ? `BILL_PATIENT:${money(pr)}` : "NO_ACTION";
  }

  // Something denied → work ONE reason, the first present in priority order.
  const present = lines.flatMap((l) => l.adjustments).filter((a) => a.group === "CO" && DENIAL_REASONS.has(a.reason)).map((a) => a.reason);
  const reason = REASON_PRIORITY.find((r) => present.includes(r));
  if (reason === undefined) return null;                 // denied by a CO reason not in our set → can't adjudicate → skip
  const deniedAmount = coAmountForReason(lines, reason);
  const reasonLines = lines.filter((l) => l.adjustments.some((a) => a.group === "CO" && a.reason === reason));

  const appealOrWriteoff = (): string | null => {
    if (c.appealDays == null) return null;               // payer appeal window unknown → skip
    const last = addDays(cur.paymentDateISO, c.appealDays);
    return last >= c.todayISO ? `APPEAL:${last}` : `WRITE_OFF:${money(deniedAmount)}`;
  };

  if (reason === 29) {                                   // filed too late
    if (c.filingDays == null) return null;               // can't compute the last day to file → skip
    const lastToFile = addDays(c.serviceDateISO, c.filingDays);
    const proven = (c.submissions ?? []).some((s) => !s.clearinghouseRejected && s.acceptedResultDateISO && s.acceptedResultDateISO <= lastToFile);
    return proven ? appealOrWriteoff() : `WRITE_OFF:${money(deniedAmount)}`;
  }

  if (reason === 22) {                                   // another plan should pay
    const notes = (c.otherInsuranceNotes ?? []).slice().sort((a, b) => (a.dateISO < b.dateISO ? 1 : a.dateISO > b.dateISO ? -1 : 0));
    const latest = notes[0];
    if (latest && latest.plan && latest.coversOnDOS) return `BILL_OTHER:${latest.plan}`;
    return "CONTACT_PATIENT";
  }

  if (reason === 16) {                                   // missing info
    const remarks = new Set(reasonLines.flatMap((l) => l.remarks));
    const hit = REMARK_FIELD.find(([code]) => remarks.has(code));
    return hit ? `RESUBMIT:${hit[1]}` : "CALL_PAYER";
  }

  if (reason === 197) {                                  // no authorization
    const covered = (l: RemitLine) => (c.authorizations ?? []).some((a) =>
      a.payer === c.payer && a.procedure === l.procedure && a.validFromISO <= c.serviceDateISO && c.serviceDateISO <= a.validToISO);
    return reasonLines.every(covered) ? appealOrWriteoff() : `WRITE_OFF:${money(deniedAmount)}`;
  }

  if (reason === 97) {                                   // bundled
    const grounds = (l: RemitLine) => {
      const row = BUNDLES.find((b) => b.indicator === 1 && b.col2 === l.procedure);
      if (!row) return false;
      const col1Billed = (c.billedLines ?? []).some((b) => b.procedure === row.col1);
      const denied59 = (c.billedLines ?? []).some((b) => b.procedure === l.procedure && b.modifiers.includes("59"));
      return col1Billed && denied59;
    };
    return reasonLines.every(grounds) ? appealOrWriteoff() : `WRITE_OFF:${money(deniedAmount)}`;
  }
  return null;
}


// ════════ Filing-terms parser ════════
/** "6 months from the date of service" → {months:6}; "90 days from…" → {days:90}. */
function limit(s: string): { days?: number; months?: number } {
  const d = (s || "").match(/(\d+)\s*days?/i); if (d) return { days: +d[1] };
  const mo = (s || "").match(/(\d+)\s*months?/i); if (mo) return { months: +mo[1] };
  return {};
}

export interface FilingTermsRow { effectiveISO: string; originalDays?: number; originalMonths?: number; secondaryDays?: number; correctedDays?: number }
/** Parse the payer's "Claim filing" table (Effective / Original / Secondary / Corrected) from the
 *  payer page's decoded text. Located by the column header row, so a different URL/version is fine. */
export function parseFilingTerms(pageText: string): FilingTermsRow[] {
  const lines = (pageText || "").split("\n");
  const out: FilingTermsRow[] = [];
  let inTable = false;
  for (const ln of lines) {
    if (/Effective\s*\t?\s*Original claim/i.test(ln) || /^Effective\t/.test(ln)) { inTable = true; continue; }
    if (!inTable) continue;
    const cells = ln.split("\t").map((c) => c.trim()).filter((_, i, a) => a.length > 1 || true);
    const eff = monthDateISO(cells[0] || "");
    if (!eff) { if (out.length) break; else continue; }     // table ended
    const o = limit(cells[1] || ""), s = limit(cells[2] || ""), c = limit(cells[3] || "");
    out.push({ effectiveISO: eff, originalDays: o.days, originalMonths: o.months, secondaryDays: s.days, correctedDays: c.days });
  }
  return out;
}

// ════════ Baseline claim assembly (readers.ts, ) ════════
// ── claim-next-step assembly ────────────────────────────────────────────────────────────────────
// The claim DETAIL page's structured pieces (DOM-walked + font-decoded by the live reader) assembled
// into the ClaimContext the engine (claimNextStep.ts) decides on. PURE, so it is self-checked below.

export interface ClaimExtract {
  payer: string;
  serviceLines: Array<{ code: string; description: string; modifier: string }>;
  submissions: Array<{ type: string; method: string; result: string; resultDate: string }>;
  remittances: Array<{ id: string; type: string; dateText: string; reversalOf?: string; lines: Array<{ code: string; adjustments: string[]; remarks: string[] }> }>;
  authorizations: Array<{ payer: string; service: string; validFrom: string; validThrough: string }>;
  notes: Array<{ dateISO: string; text: string }>;
}

/** "CO-45 $80.48" / "PR-1 12.44" → {group:"CO", reason:45, amount:80.48}; null if unparseable. */
export function parseAdjustment(s: string): Adjustment | null {
  const m = (s || "").match(/\b([A-Z]{2})-(\d+)\b[^\d-]*\$?\s*([\d,]+\.\d{2})/);
  if (!m) return null;
  return { group: m[1], reason: +m[2], amount: Number(m[3].replace(/,/g, "")) };
}

/** Original-claim filing window in DAYS in effect on the DOS (latest Effective ≤ DOS). null when the
 *  applicable term is expressed in months (the claim engine takes days) or none applies → engine skips 29. */
export function originalFilingDays(terms: FilingTermsRow[], dosISO: string): number | null {
  const eligible = terms.filter((t) => t.effectiveISO <= dosISO).sort((a, b) => (a.effectiveISO < b.effectiveISO ? 1 : -1));
  const row = eligible[0]; if (!row) return null;
  return row.originalDays ?? null; // months → null (can't express as fixed days here)
}

/** Payer contract's appeal window in days ("Appeals accepted within 120 days…"). null when absent. */
export function parseAppealDays(contractText: string): number | null {
  const m = (contractText || "").match(/appeals?\s+accepted\s+within\s+(\d+)\s+days/i)
    || (contractText || "").match(/(\d+)\s+days\b[^.]*\bappeal/i)
    || (contractText || "").match(/appeal[^.]*?\bwithin\s+(\d+)\s+days/i);
  return m ? +m[1] : null;
}

/** Assemble the ClaimContext, or null when an input the needed branch depends on can't be grounded
 *  confidently (reversal we can't resolve, reason-22 free-text note, reason-197 auth we can't map to
 *  a procedure code). Declining → skip (never-wrong), never a guessed WRITE_OFF/BILL_OTHER. */
export function assembleClaim(ex: ClaimExtract, meta: { todayISO: string; serviceDateISO: string; payer: string; filingDays: number | null; appealDays: number | null }): ClaimContext | null {
  const DENIAL = new Set([16, 22, 29, 97, 197]);
  // service description → procedure code (for mapping authorizations' Service name to a line's code)
  const descToCode = new Map<string, string>();
  for (const sl of ex.serviceLines) if (sl.description && sl.code) descToCode.set(sl.description.trim().toLowerCase(), sl.code);

  // Remittances. Type "Reversal" → isReversal; a reversal that names "Reversal of <id>" marks that
  // payment reversed. A reversal we can't tie to a payment on the claim → decline (can't pick current).
  const byId = new Map<string, { isReversal: boolean; reversed: boolean }>();
  const rems: Remittance[] = [];
  for (const r of ex.remittances) {
    const isReversal = /reversal/i.test(r.type) || !!r.reversalOf;
    const paymentDateISO = monthDateISO(r.dateText) || "";
    if (!paymentDateISO) return null; // undated remittance → can't order → skip
    const lines: RemitLine[] = [];
    for (const ln of r.lines) {
      const adjustments = ln.adjustments.map(parseAdjustment).filter((a): a is Adjustment => a !== null);
      if (adjustments.length !== ln.adjustments.filter((s) => /\S/.test(s)).length) return null; // an adjustment we couldn't parse → skip
      lines.push({ procedure: ln.code, adjustments, remarks: ln.remarks.filter((x) => /\S/.test(x)) });
    }
    byId.set(r.id, { isReversal, reversed: false });
    rems.push({ id: r.id, paymentDateISO, isReversal, reversed: false, lines });
  }
  for (const r of ex.remittances) {
    if (!r.reversalOf) continue;
    const target = rems.find((x) => x.id === r.reversalOf);
    if (!target) return null; // reversal of a payment not on this claim's panel → can't resolve → skip
    target.reversed = true;
  }
  // Any reversal present but no "Reversal of" reference anywhere → we can't know what was reversed → skip.
  const hasReversal = rems.some((r) => r.isReversal);
  const anyReference = ex.remittances.some((r) => r.reversalOf);
  if (hasReversal && !anyReference) return null;

  const submissions = ex.submissions.map((s) => ({
    acceptedResultDateISO: /accepted/i.test(s.result) ? (monthDateISO(s.resultDate) ?? null) : null,
    clearinghouseRejected: /reject/i.test(s.result) && /clearinghouse/i.test(s.result + " " + s.method),
  }));

  const billedLines = ex.serviceLines.map((sl) => ({ procedure: sl.code, modifiers: (sl.modifier || "").split(/[,\s]+/).filter(Boolean) }));
  const authorizations = ex.authorizations.map((a) => ({
    payer: a.payer, procedure: descToCode.get((a.service || "").trim().toLowerCase()) ?? "",
    validFromISO: monthDateISO(a.validFrom) ?? "", validToISO: monthDateISO(a.validThrough) ?? "",
  }));

  const ctx: ClaimContext = {
    todayISO: meta.todayISO, serviceDateISO: meta.serviceDateISO, payer: meta.payer,
    filingDays: meta.filingDays, appealDays: meta.appealDays,
    remittances: rems, billedLines, authorizations, otherInsuranceNotes: [], submissions,
  };

  // Branch-specific grounding guards, applied to the CURRENT remittance's denial reason.
  const live = rems.filter((r) => !r.isReversal && !r.reversed).sort((a, b) => (a.paymentDateISO < b.paymentDateISO ? 1 : -1));
  const cur = live[0];
  if (cur) {
    const reasons = cur.lines.flatMap((l) => l.adjustments).filter((a) => a.group === "CO" && DENIAL.has(a.reason)).map((a) => a.reason);
    const worked = [29, 22, 16, 197, 97].find((r) => reasons.includes(r));
    if (worked === 22) return null; // reason 22 needs free-text note adjudication we won't risk → skip
    if (worked === 197) {
      // Every 197-denied line must map to a known code, and any payer authorization valid on the DOS
      // must have mapped to a code — else coverage is uncertain and WRITE_OFF could be wrong → skip.
      const r197 = cur.lines.filter((l) => l.adjustments.some((a) => a.group === "CO" && a.reason === 197));
      if (r197.some((l) => !l.procedure)) return null;
      const payerAuthsOnDOS = authorizations.filter((a) => a.payer === meta.payer && a.validFromISO && a.validToISO && a.validFromISO <= meta.serviceDateISO && meta.serviceDateISO <= a.validToISO);
      if (payerAuthsOnDOS.some((a) => !a.procedure)) return null; // a relevant auth we couldn't map → uncertain
    }
    if ((worked === 29 || worked === 16 || worked === 97) && cur.lines.some((l) => !l.procedure)) return null; // missing codes break these branches
  }
  return ctx;
}

// ════════ Baseline claim-detail DOM walker (index-builder claimContext, ) ════════
/** The in-page script body (run with `doc` = the app document, `getComputedStyle` in scope). `map` = the
 *  ONE page digit map Baseline reader applies to every custom-font leaf (Crawler.currentDigitMap; {} when null). */
export const baselineClaimWalkJS = (map: Record<string, string>): string => `return (function(){
        var MAP=${JSON.stringify(map || {})};
        function isCustom(el){var f=(getComputedStyle(el).fontFamily||'').split(',')[0].replace(/["']/g,'').trim();return !/^(Atkinson|ui-|system-ui|monospace|sans-serif|serif)/i.test(f);}
        function dec(node){ if(!node) return ''; if(node.nodeType===3) return node.textContent||''; if(node.children.length===0){var raw=node.textContent||''; return (isCustom(node)&&/[0-9]/.test(raw))?raw.replace(/[0-9]/g,function(c){return MAP[c]!=null?MAP[c]:c;}):raw;} var s=''; for(var i=0;i<node.childNodes.length;i++){var ch=node.childNodes[i]; s+= ch.nodeType===3?(ch.textContent||''):dec(ch);} return s; }
        function txt(el){return dec(el).replace(/\\s+/g,' ').trim();}
        function section(label){return doc.querySelector('section[aria-label="'+label+'"]');}
        function headIdx(table){var m={};var ths=table.querySelectorAll('thead th');for(var i=0;i<ths.length;i++)m[(ths[i].textContent||'').trim().toLowerCase()]=i;return m;}
        // Details dl + payer contract href
        var payer='', contractHref='';
        var det=section('Details');
        if(det){var dts=det.querySelectorAll('dt');for(var i=0;i<dts.length;i++){if(/^payer$/i.test((dts[i].textContent||'').trim())){var dd=dts[i].nextElementSibling; if(dd){payer=txt(dd); var a=dd.querySelector('a[href]'); if(a)contractHref=a.getAttribute('href').split('?')[0];}}}}
        // Service lines
        var serviceLines=[]; var sl=section('Service lines'); var slt=sl&&sl.querySelector('table');
        if(slt){var h=headIdx(slt);var trs=slt.querySelectorAll('tbody tr');for(var i=0;i<trs.length;i++){var td=trs[i].querySelectorAll('td');serviceLines.push({code:txt(td[h['procedure']]),description:td[h['description']]?txt(td[h['description']]):'',modifier:td[h['modifier']]?txt(td[h['modifier']]):''});}}
        // Submissions
        var submissions=[]; var sub=section('Submissions'); var subt=sub&&sub.querySelector('table');
        if(subt){var h2=headIdx(subt);var trs2=subt.querySelectorAll('tbody tr');for(var i=0;i<trs2.length;i++){var td2=trs2[i].querySelectorAll('td');submissions.push({type:td2[h2['type']]?txt(td2[h2['type']]):'',method:td2[h2['method']]?txt(td2[h2['method']]):'',result:td2[h2['result']]?txt(td2[h2['result']]):'',resultDate:td2[h2['result date']]?txt(td2[h2['result date']]):''});}}
        // Remittances (one group per remittance)
        var remittances=[]; var rem=section('Remittances');
        if(rem){var groups=rem.querySelectorAll('[role="group"]');for(var g=0;g<groups.length;g++){var grp=groups[g];
          var head=txt(grp.firstElementChild||grp);
          var al=(grp.getAttribute('aria-label')||'');
          var id=(al.match(/Remittance\\s+(\\S+)/)||[])[1]||(head.match(/\\b([A-Z]{3}\\d+)\\b/)||[])[1]||'';
          var parts=head.split('·').map(function(x){return x.trim();});
          var dateText='',type='';
          for(var p=0;p<parts.length;p++){if(/\\d{4}/.test(parts[p])&&/[A-Z][a-z]{2}/.test(parts[p]))dateText=parts[p];if(/payment|reversal/i.test(parts[p]))type=parts[p];}
          var reversalOf=(head.match(/Reversal of\\s+(\\S+)/i)||[])[1];
          var lines=[];var rt=grp.querySelector('table');
          if(rt){var hr=headIdx(rt);var rtr=rt.querySelectorAll('tbody tr');for(var i=0;i<rtr.length;i++){var rtd=rtr[i].querySelectorAll('td');
            var adjCell=rtd[hr['adjustments']];var adjustments=adjCell?[].map.call(adjCell.querySelectorAll('div'),function(d){return txt(d);}).filter(function(x){return x;}):[];
            if(adjCell&&!adjustments.length&&txt(adjCell))adjustments=[txt(adjCell)];
            var rkCell=rtd[hr['remark codes']];var remarks=rkCell?[].map.call(rkCell.querySelectorAll('div,span'),function(d){return txt(d);}).filter(function(x){return x;}):[];
            if(rkCell&&!remarks.length&&txt(rkCell))remarks=[txt(rkCell)];
            lines.push({code:txt(rtd[hr['procedure']]),adjustments:adjustments,remarks:remarks});}}
          remittances.push({id:id,type:type,dateText:dateText,reversalOf:reversalOf,lines:lines});}}
        // Authorizations
        var authorizations=[];var au=section('Authorizations');var aut=au&&au.querySelector('table');
        if(aut){var ha=headIdx(aut);var atr=aut.querySelectorAll('tbody tr');for(var i=0;i<atr.length;i++){var atd=atr[i].querySelectorAll('td');authorizations.push({payer:atd[ha['payer']]?txt(atd[ha['payer']]):'',service:atd[ha['service']]?txt(atd[ha['service']]):'',validFrom:atd[ha['valid from']]?txt(atd[ha['valid from']]):'',validThrough:atd[ha['valid through']]?txt(atd[ha['valid through']]):''});}}
        // Account notes
        var notes=[];var nt=section('Account notes');
        if(nt){var arts=nt.querySelectorAll('article');for(var i=0;i<arts.length;i++){var tm=arts[i].querySelector('time');var dISO=tm?(tm.getAttribute('datetime')||'').slice(0,10):'';var p=arts[i].querySelector('p');notes.push({dateISO:dISO,text:p?txt(p):txt(arts[i])});}}
        return {payer:payer,contractHref:contractHref,serviceLines:serviceLines,submissions:submissions,remittances:remittances,authorizations:authorizations,notes:notes};
      })()`;

// ── self-check (Baseline engine checks + readers.ts claim checks, unchanged) ──
if (process.argv[1]?.endsWith("claimOracle.ts")) {
  const assert = (c: unknown, m: string) => { if (!c) { console.error("✗ " + m); process.exit(1); } console.log("✓ " + m); };
  const aeq = (got: string | null, want: string | null, m: string) => { if (got !== want) { console.error(`✗ ${m}: got ${got}, want ${want}`); process.exit(1); } console.log("✓ " + m); };
  const base = (over: Partial<ClaimContext>): ClaimContext => ({ todayISO: "2026-10-14", serviceDateISO: "2026-07-06", payer: "Tallgrass", filingDays: 90, appealDays: 120, remittances: [], billedLines: [], authorizations: [], otherInsuranceNotes: [], submissions: [], ...over });
  const remit = (over: Partial<Remittance>): Remittance => ({ id: "R1", paymentDateISO: "2026-08-17", isReversal: false, reversed: false, lines: [], ...over });
  const L = (procedure: string, adjustments: Adjustment[], remarks: string[] = []): RemitLine => ({ procedure, adjustments, remarks });

  // no remittance
  aeq(decideClaim(base({ remittances: [] })), "AWAIT_PAYER", "no remittance → await");
  // all payments reversed
  aeq(decideClaim(base({ remittances: [remit({ reversed: true }), remit({ id: "R2", isReversal: true })] })), "AWAIT_PAYER", "all reversed → await");
  // paid, PR owed
  aeq(decideClaim(base({ remittances: [remit({ lines: [L("99213", [{ group: "CO", reason: 45, amount: 47.6 }, { group: "PR", reason: 2, amount: 23.19 }])] })] })), "BILL_PATIENT:23.19", "paid, coinsurance → bill patient");
  // paid, nothing owed (CO-45 ignored)
  aeq(decideClaim(base({ remittances: [remit({ lines: [L("99213", [{ group: "CO", reason: 45, amount: 47.6 }])] })] })), "NO_ACTION", "paid, only CO-45 → no action");
  // reason 197 with auth covering → appeal 120 days from 2026-08-17 = 2026-12-15 (the worked example)
  aeq(decideClaim(base({ serviceDateISO: "2026-07-06", payer: "P", authorizations: [{ payer: "P", procedure: "20610", validFromISO: "2026-01-01", validToISO: "2026-12-31" }],
    remittances: [remit({ lines: [L("20610", [{ group: "CO", reason: 197, amount: 190 }])] })] })), "APPEAL:2026-12-15", "197 covered → appeal to payment+120");
  // reason 197 not covered → write off denied amount
  aeq(decideClaim(base({ authorizations: [], remittances: [remit({ lines: [L("20610", [{ group: "CO", reason: 197, amount: 190 }])] })] })), "WRITE_OFF:190.00", "197 uncovered → write off");
  // reason 16 with remark → resubmit the first field in table order
  aeq(decideClaim(base({ remittances: [remit({ lines: [L("99213", [{ group: "CO", reason: 16, amount: 50 }], ["M51", "N382"])] })] })), "RESUBMIT:MEMBER_ID", "16 → first remark in table order (N382 before M51)");
  // reason 16 no known remark → call payer
  aeq(decideClaim(base({ remittances: [remit({ lines: [L("99213", [{ group: "CO", reason: 16, amount: 50 }], ["MA130"])] })] })), "CALL_PAYER", "16 unknown remark → call payer");
  // reason 22 with plan covering → bill other
  aeq(decideClaim(base({ otherInsuranceNotes: [{ dateISO: "2026-07-01", plan: "Bronze", coversOnDOS: false }, { dateISO: "2026-08-01", plan: "Silver 3500", coversOnDOS: true }],
    remittances: [remit({ lines: [L("99213", [{ group: "CO", reason: 22, amount: 80 }])] })] })), "BILL_OTHER:Silver 3500", "22 → latest note's covering plan");
  // reason 22 no covering plan → contact patient
  aeq(decideClaim(base({ otherInsuranceNotes: [], remittances: [remit({ lines: [L("99213", [{ group: "CO", reason: 22, amount: 80 }])] })] })), "CONTACT_PATIENT", "22 → no plan → contact patient");
  // reason 29 timely proof → appeal; no proof → write off
  aeq(decideClaim(base({ serviceDateISO: "2026-06-01", filingDays: 90, submissions: [{ acceptedResultDateISO: "2026-08-01", clearinghouseRejected: false }],
    remittances: [remit({ lines: [L("99213", [{ group: "CO", reason: 29, amount: 120 }])] })] })), "APPEAL:2026-12-15", "29 with timely proof → appeal");
  aeq(decideClaim(base({ serviceDateISO: "2026-06-01", filingDays: 90, submissions: [{ acceptedResultDateISO: "2026-09-30", clearinghouseRejected: false }],
    remittances: [remit({ lines: [L("99213", [{ group: "CO", reason: 29, amount: 120 }])] })] })), "WRITE_OFF:120.00", "29 no timely proof → write off");
  // priority: 29 beats 22 when both present
  aeq(decideClaim(base({ serviceDateISO: "2026-06-01", filingDays: 90, submissions: [],
    remittances: [remit({ lines: [L("1", [{ group: "CO", reason: 22, amount: 80 }]), L("2", [{ group: "CO", reason: 29, amount: 40 }])] })] })), "WRITE_OFF:40.00", "priority 29 over 22; denied amount is reason-29 only");
  // appeal window passed → write off
  aeq(decideClaim(base({ todayISO: "2027-01-01", appealDays: 120, authorizations: [{ payer: "Tallgrass", procedure: "20610", validFromISO: "2026-01-01", validToISO: "2026-12-31" }],
    remittances: [remit({ paymentDateISO: "2026-08-17", lines: [L("20610", [{ group: "CO", reason: 197, amount: 190 }])] })] })), "WRITE_OFF:190.00", "appeal window passed → write off");
  // ── claim-next-step assembly ──
  assert(parseAdjustment("CO-45 $80.48")?.group === "CO" && parseAdjustment("CO-45 $80.48")?.reason === 45 && parseAdjustment("CO-45 $80.48")?.amount === 80.48, "adjustment CO-45 $80.48");
  assert(parseAdjustment("PR-1 12.44")?.amount === 12.44, "adjustment no dollar sign");
  assert(parseAdjustment("Lines keyed") === null, "non-adjustment text → null");
  assert(parseAppealDays("Appeals accepted within 120 days of the remittance date.") === 120, "appeal window 120");
  assert(parseAppealDays("Claim filing only, no appeal clause") === null, "no appeal clause → null");
  const ft = parseFilingTerms(["Effective\tOriginal claim\tSecondary claim\tCorrected claim", "Jul 1, 2022\t150 days from the date of service\t90 days\t365 days"].join("\n"));
  assert(originalFilingDays(ft, "2026-07-14") === 150, "original filing days in effect = 150");
  assert(originalFilingDays(parseFilingTerms(["Effective\tOriginal claim\tSecondary claim\tCorrected claim", "Jul 1, 2026\t6 months from the date of service\t180 days\t90 days"].join("\n")), "2026-07-14") === null, "months-only original → null (engine skips 29)");

  // García's paid claim (verbatim from the recon): CO-45 write-downs + PR-1 patient responsibility → BILL_PATIENT:34.12
  const paidEx: ClaimExtract = {
    payer: "Senior Advantage of the Plains",
    serviceLines: [ { code: "99396", description: "Preventive visit, established patient, age 40 to 64", modifier: "" }, { code: "36415", description: "Collection of venous blood by venipuncture", modifier: "" }, { code: "85025", description: "Complete blood count", modifier: "" } ],
    submissions: [{ type: "Original", method: "Electronic", result: "Accepted by payer", resultDate: "Jul 19, 2026" }],
    remittances: [{ id: "EFT541736844", type: "Payment", dateText: "Aug 20, 2026", lines: [
      { code: "99396", adjustments: ["CO-45 $80.48"], remarks: [] },
      { code: "36415", adjustments: ["CO-45 $5.56", "PR-1 $12.44"], remarks: [] },
      { code: "85025", adjustments: ["CO-45 $10.32", "PR-1 $21.68"], remarks: [] } ] }],
    authorizations: [], notes: [],
  };
  const paidCtx = assembleClaim(paidEx, { todayISO: "2026-10-14", serviceDateISO: "2026-07-14", payer: "Senior Advantage of the Plains", filingDays: 150, appealDays: 120 });
  assert(paidCtx !== null && decideClaim(paidCtx) === "BILL_PATIENT:34.12", "García paid claim → BILL_PATIENT:34.12 (PR-1 12.44+21.68)");

  // 197 with an authorization whose Service maps to the denied line's code → APPEAL (payment+appealDays)
  const authEx: ClaimExtract = { payer: "P", serviceLines: [{ code: "20610", description: "Joint injection", modifier: "" }],
    submissions: [], authorizations: [{ payer: "P", service: "Joint injection", validFrom: "Jan 1, 2026", validThrough: "Dec 31, 2026" }], notes: [],
    remittances: [{ id: "R1", type: "Payment", dateText: "Aug 17, 2026", lines: [{ code: "20610", adjustments: ["CO-197 $190.00"], remarks: [] }] }] };
  const authCtx = assembleClaim(authEx, { todayISO: "2026-10-14", serviceDateISO: "2026-07-06", payer: "P", filingDays: 150, appealDays: 120 });
  assert(authCtx !== null && decideClaim(authCtx) === "APPEAL:2026-12-15", "197 auth-covered → APPEAL:2026-12-15");

  // 197 but the only payer auth on the DOS maps to no code (unknown service) → assembler declines (never-wrong)
  const authBad: ClaimExtract = { ...authEx, authorizations: [{ payer: "P", service: "Something not on the claim", validFrom: "Jan 1, 2026", validThrough: "Dec 31, 2026" }] };
  assert(assembleClaim(authBad, { todayISO: "2026-10-14", serviceDateISO: "2026-07-06", payer: "P", filingDays: 150, appealDays: 120 }) === null, "197 with unmappable payer auth on DOS → decline");

  // reason 22 → decline (free-text note risk)
  const r22: ClaimExtract = { payer: "P", serviceLines: [{ code: "99213", description: "Office visit", modifier: "" }], submissions: [], authorizations: [], notes: [{ dateISO: "2026-08-01", text: "Patient has other coverage." }],
    remittances: [{ id: "R1", type: "Payment", dateText: "Aug 17, 2026", lines: [{ code: "99213", adjustments: ["CO-22 $80.00"], remarks: [] }] }] };
  assert(assembleClaim(r22, { todayISO: "2026-10-14", serviceDateISO: "2026-07-06", payer: "P", filingDays: 150, appealDays: 120 }) === null, "reason 22 → decline");

  // a reversal with no resolvable reference → decline
  const revBad: ClaimExtract = { payer: "P", serviceLines: [], submissions: [], authorizations: [], notes: [],
    remittances: [ { id: "R1", type: "Payment", dateText: "Jul 1, 2026", lines: [] }, { id: "R2", type: "Reversal", dateText: "Jul 10, 2026", lines: [] } ] };
  assert(assembleClaim(revBad, { todayISO: "2026-10-14", serviceDateISO: "2026-06-01", payer: "P", filingDays: 150, appealDays: 120 }) === null, "unreferenced reversal → decline");

  // a reversal that names its payment → resolved: current = the later unreversed payment
  const revOk: ClaimExtract = { payer: "P", serviceLines: [{ code: "99213", description: "Office visit", modifier: "" }], submissions: [], authorizations: [], notes: [],
    remittances: [ { id: "P1", type: "Payment", dateText: "Jul 1, 2026", lines: [{ code: "99213", adjustments: ["PR-2 $50.00"], remarks: [] }] }, { id: "X1", type: "Reversal", dateText: "Jul 10, 2026", reversalOf: "P1", lines: [] }, { id: "P2", type: "Payment", dateText: "Jul 20, 2026", lines: [{ code: "99213", adjustments: ["PR-2 $30.00"], remarks: [] }] } ] };
  const revCtx = assembleClaim(revOk, { todayISO: "2026-10-14", serviceDateISO: "2026-06-01", payer: "P", filingDays: 150, appealDays: 120 });
  assert(revCtx !== null && decideClaim(revCtx) === "BILL_PATIENT:30.00", "resolved reversal → current is P2 → BILL_PATIENT:30.00");

  console.log("ALL PASS");
}
