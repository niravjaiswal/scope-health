/**
 * Reader for the claim-next-step family: patient chart → Claims tab → the one claim with the asked date
 * of service → its /claims/{id} page (details, service lines, submissions, remittances with their
 * lines, authorizations, account notes) → the payer's contract page (appeals / claims accepted
 * within) → the payers' plans (only when an account note decides the answer). The pure parsers are
 * exported and tested on the captured Set 1 markup (claimReader.test.ts); the engine is claimNextStep.ts.
 *
 * Rules:
 *  - sections by aria-label/heading, columns by header LABEL (synonyms, any order, extra columns
 *    ignored), never class names or column index;
 *  - digits drawn in a custom font are decoded per font FAMILY (Crawler.familyDigitMaps: identity,
 *    or an exact map against the clinic's identity font). A digit in a font we cannot place declines;
 *  - a remittance shown without keyed lines (a scanned paper remittance: an image or "Paper, not
 *    keyed") is flagged `scanned`; when it is the current remittance the engine declines, and its page
 *    structure is logged once (event "claim_scan_probe") so the next run can build an image reader;
 *  - anything unexpected → `{ decline: why }`.
 */
import type { Crawler } from "./crawl.js";
import type { DigitMap } from "./fontDecode.js";
import { applyDigitMap } from "./fontDecode.js";
import { SNAPSHOT_JS, type Snapshot, col, norm, datesIn, oneDate, pagerOf } from "./pageSnapshot.js";
import { isComplete } from "./listFooter.js";
import { onDrop } from "./readCache.js";
import { chartTab, waitFor, allPages, isDecline, type Decline } from "./familyReaders.js";
import { parseCents, normName, workedReason, currentRemittance, declineBeforeLines, type ClaimContext, type ClaimPolicy, type Remittance, type RemitLine, type Adjustment, type BilledLine, type Submission, type Authorization, type AccountNote, type PlanRef } from "./claimNextStep.js";

const D = (why: string): Decline => ({ decline: "claim: " + why });

// ════════════════════════════ in-page extraction ════════════════════════════

/** A text run and the custom font family it is drawn in (null: the page's own / a standard font). */
export type Seg = [string, string | null];
export type PCell = { segs: Seg[]; href: string | null; atext?: string; aria: string; times: string[]; imgs: number };
export type PTable = { caption: string; headers: string[]; rows: PCell[][]; group: number };
export type PGroup = { label: string; head: PCell; tables: number[]; imgs: number; links: Array<{ text: string; href: string; aria: string }>; text: string; outline: string };
export type PArticle = { head: string; times: string[]; body: string };
export type PSection = { label: string; heading: string; text: string; dl: Array<[string, PCell]>; tables: PTable[]; groups: PGroup[]; articles: PArticle[]; links: Array<{ text: string; href: string; aria: string }> };
export type PPage = { h1: string; sub: string; text: string; sections: PSection[]; families: string[] };

/** In-page script body (`doc` is the app document). Plain JS so it runs in the browser (evalApp) and
 *  in jsdom (tests). Hidden elements are skipped like innerText would. */
export const CLAIM_JS = String.raw`
  var view = doc.defaultView || window;
  var STD = /^(Atkinson|ui-|system-ui|-apple-system|monospace|sans-serif|serif|Arial|Helvetica|Inter|Roboto|Segoe|Times|Georgia|Courier)/i;
  var famOf = function (el) { try { return (view.getComputedStyle(el).fontFamily || '').split(',')[0].replace(/["']/g, '').trim(); } catch (e) { return ''; } };
  var baseFam = doc.body ? famOf(doc.body) : '';
  var hidden = function (el) { if (el.hasAttribute && el.hasAttribute('hidden')) return true; try { var cs = view.getComputedStyle(el); return cs.display === 'none' || cs.visibility === 'hidden'; } catch (e) { return false; } };
  var BLOCK = /^(DIV|P|SECTION|ARTICLE|HEADER|FOOTER|NAV|ASIDE|MAIN|H[1-6]|UL|OL|LI|DL|DT|DD|TABLE|THEAD|TBODY|TFOOT|TR|CAPTION|FORM|FIELDSET|BR|FIGURE|FIGCAPTION)$/;
  var fams = {};
  var segsOf = function (root, skip) {
    var out = [];
    var rec = function (n) {
      if (n.nodeType === 3) { var t = n.nodeValue; if (!t) return; var p = n.parentElement; var f = p ? famOf(p) : ''; var custom = (/[0-9]/.test(t) && f && f !== baseFam && !STD.test(f)) ? f : null; if (custom) fams[custom] = 1; out.push([t, custom]); return; }
      if (n.nodeType !== 1) return;
      var tag = n.tagName; if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEMPLATE' || tag === 'svg' || tag === 'SVG') return;
      if (skip && skip(n)) return;
      if (hidden(n)) return;
      if (tag === 'IMG' || n.getAttribute('role') === 'img' || tag === 'CANVAS' || tag === 'OBJECT' || tag === 'EMBED' || tag === 'IFRAME') { out.push(['', null]); return; }
      var blk = BLOCK.test(tag);
      if (blk) out.push(['\n', null]);
      for (var c = n.firstChild; c; c = c.nextSibling) rec(c);
      if (tag === 'TD' || tag === 'TH') out.push(['\t', null]);
      if (blk) out.push(['\n', null]);
    };
    rec(root);
    return out;
  };
  var plain = function (el) { return segsOf(el).map(function (s) { return s[0]; }).join('').replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim(); };
  var imgsIn = function (el) { return [].slice.call(el.querySelectorAll('img,[role=img],canvas,object,embed,iframe')).filter(function (x) { return !hidden(x); }).length; };
  var linksIn = function (el) { return [].slice.call(el.querySelectorAll('a[href]')).map(function (a) { return { text: plain(a), href: a.getAttribute('href'), aria: a.getAttribute('aria-label') || '' }; }); };
  var cellOf = function (td, skip) {
    var a = td.querySelector('a[href]');
    return { segs: segsOf(td, skip), href: a ? a.getAttribute('href') : null, atext: a ? plain(a) : '', aria: (a && a.getAttribute('aria-label')) || td.getAttribute('aria-label') || '', times: [].slice.call(td.querySelectorAll('time[datetime]')).map(function (t) { return t.getAttribute('datetime'); }), imgs: imgsIn(td) };
  };
  var tableOf = function (t, gi) {
    var heads = [].slice.call(t.querySelectorAll('thead th'));
    if (!heads.length) { var fr = t.querySelector('tr'); if (fr && fr.querySelector('th')) heads = [].slice.call(fr.querySelectorAll('th')); }
    var rows = [].slice.call(t.querySelectorAll('tbody tr')).filter(function (tr) { return tr.querySelector('td') && !hidden(tr); })
      .map(function (tr) { return [].slice.call(tr.children).filter(function (c) { return (c.tagName === 'TD' || c.tagName === 'TH') && !(c.tagName === 'TH' && c.getAttribute('scope') === 'col'); }).map(function (c) { return cellOf(c); }); });
    var cap = t.querySelector('caption');
    return { caption: cap ? plain(cap) : '', headers: heads.map(plain), rows: rows, group: gi };
  };
  var outline = function (el, depth) {
    if (depth > 6) return '';
    var parts = [];
    for (var c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) { var t = (c.nodeValue || '').trim(); if (t) parts.push(JSON.stringify(t.slice(0, 40))); continue; }
      if (c.nodeType !== 1 || c.tagName === 'SCRIPT' || c.tagName === 'STYLE') continue;
      var attrs = ['role', 'aria-label', 'alt', 'href', 'src', 'title', 'datetime', 'type'].map(function (k) { var v = c.getAttribute(k); return v ? k + '=' + JSON.stringify(v.slice(0, 60)) : ''; }).filter(Boolean).join(' ');
      if (c.tagName === 'TABLE') { parts.push('<table caption=' + JSON.stringify(plain(c.querySelector('caption') || doc.createElement('i'))) + ' rows=' + c.querySelectorAll('tbody tr').length + '>'); continue; }
      parts.push('<' + c.tagName.toLowerCase() + (attrs ? ' ' + attrs : '') + '>' + outline(c, depth + 1) + '</' + c.tagName.toLowerCase() + '>');
    }
    return parts.join('');
  };
  var secEls = [].slice.call(doc.querySelectorAll('section,[role=region]'));
  if (!secEls.length) secEls = [].slice.call(doc.querySelectorAll('h2')).map(function (h) { return h.parentElement; });
  var sections = secEls.map(function (s) {
    var h = s.querySelector('h2,h3,h4');
    var groupEls = [].slice.call(s.querySelectorAll('[role=group]'));
    var tEls = [].slice.call(s.querySelectorAll('table'));
    if (!groupEls.length && tEls.length > 1) {
      // no explicit groups: each table with the block above it (its nearest wrapper holding only that table)
      groupEls = tEls.map(function (t) { var e = t; while (e.parentElement && e.parentElement !== s && e.parentElement.querySelectorAll('table').length === 1) e = e.parentElement; return e; });
    }
    var tables = tEls.map(function (t) { var gi = -1; groupEls.forEach(function (g, i) { if (g.contains(t)) gi = i; }); return tableOf(t, gi); });
    var groups = groupEls.map(function (g, i) {
      var head = cellOf(g, function (n) { return n.tagName === 'TABLE'; });
      var label = g.getAttribute('aria-label') || '';
      if (!label && g.tagName === 'TABLE') label = '';
      var ti = []; tables.forEach(function (t, k) { if (t.group === i) ti.push(k); });
      return { label: label, head: head, tables: ti, imgs: imgsIn(g), links: linksIn(g), text: plain(g), outline: outline(g, 0).slice(0, 4000) };
    });
    var dl = [];
    [].slice.call(s.querySelectorAll('dt')).forEach(function (dt) { var dd = dt.nextElementSibling; if (dd && dd.tagName === 'DD') dl.push([plain(dt), cellOf(dd)]); });
    var arts = [].slice.call(s.querySelectorAll('article,li')).filter(function (a) { return !hidden(a) && !a.querySelector('article'); }).map(function (a) {
      var hd = a.querySelector('header');
      var body = segsOf(a, function (n) { return n.tagName === 'HEADER'; }).map(function (x) { return x[0]; }).join('').replace(/\s+/g, ' ').trim();
      return { head: hd ? plain(hd) : '', times: [].slice.call(a.querySelectorAll('time[datetime]')).map(function (t) { return t.getAttribute('datetime'); }), body: body };
    });
    return { label: s.getAttribute('aria-label') || '', heading: h ? plain(h) : '', text: plain(s), dl: dl, tables: tables, groups: groups, articles: arts, links: linksIn(s) };
  });
  var h1 = doc.querySelector('h1');
  var sub = h1 && h1.closest('header') ? plain(h1.closest('header')) : '';
  return { h1: h1 ? plain(h1) : '', sub: sub, text: plain(doc.body), sections: sections, families: Object.keys(fams) };
`;

/** Run CLAIM_JS against a document (jsdom in tests). */
export function claimPageOf(doc: any): PPage {
  // eslint-disable-next-line no-new-func
  return new Function("doc", "window", CLAIM_JS)(doc, doc.defaultView) as PPage;
}

// ════════════════════════════ digit interpretation ════════════════════════════

/** How each custom font family's digits are read. */
export type FamMaps = Record<string, DigitMap | "identity" | null>;
const segText = (segs: Seg[], fm: FamMaps): string | null => {
  let out = "";
  for (const [t, f] of segs) {
    if (!f) { out += t; continue; }
    const m = fm[f];
    if (m === "identity") out += t;
    else if (m) out += applyDigitMap(t, m);
    else return null;                           // a digit in a font we cannot place
  }
  return out;
};
const tidy = (s: string) => s.replace(/[ \t ]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
/** A cell's text under the font maps; null when a digit is drawn in an unknown font. */
export const textOf = (c: PCell | undefined, fm: FamMaps): string | null => { if (!c) return ""; const t = segText(c.segs, fm); return t == null ? null : tidy(t); };
/** Raw text (no decoding): for identity comparisons inside one page (trace numbers). */
export const rawOf = (c: PCell | undefined) => (c ? tidy(c.segs.map((s) => s[0]).join("")) : "");

// ════════════════════════════ pure parsers ════════════════════════════

const secBy = (p: PPage, re: RegExp) => p.sections.filter((s) => re.test(norm(s.label)) || re.test(norm(s.heading)));
/** The one section with this label; several with different content → ambiguous. */
function oneSec(p: PPage, re: RegExp): PSection | null | "many" {
  const ss = secBy(p, re).filter((s, i, a) => a.findIndex((x) => x.text === s.text) === i);
  if (!ss.length) return null;
  // nested sections: keep the innermost
  const inner = ss.filter((s) => !ss.some((o) => o !== s && s.text.includes(o.text) && o.text.length < s.text.length));
  return inner.length === 1 ? inner[0] : "many";
}
const dlGet = (secs: PSection[], re: RegExp): PCell[] => secs.flatMap((s) => s.dl.filter(([k]) => re.test(norm(k))).map(([, v]) => v));

export type ClaimFacts = {
  claimNo: string; patientHref: string | null; payer: string; payerHref: string | null; plan: string | null; serviceDateISO: string;
  billedLines: BilledLine[]; submissions: Submission[]; remittances: Remittance[]; authorizations: Authorization[]; notes: AccountNote[];
  merged: boolean; scanned: Array<{ trace: string; outline: string; href: string | null }>;
};

const ADJ = /^(CO|PR|OA|PI|CR)\s*[-–]\s*(\d{1,3})\s*[:\s]\s*(\(?-?\$?\s*-?[\d,]+(?:\.\d{1,2})?\)?)$/i;
/** "CO-45 $80.48\nPR-1 $12.44" → adjustments; null when any piece is not an adjustment. */
export function parseAdjustments(t: string): Adjustment[] | null {
  const parts = t.split(/\n|;|,(?=\s*[A-Z]{2}\s*-)/).map((x) => x.trim()).filter((x) => x && !/^(none|—|-|n\/?a)$/i.test(x));
  const out: Adjustment[] = [];
  for (const p of parts) { const m = p.match(ADJ); if (!m) return null; const c = parseCents(m[3]); if (c == null) return null; out.push({ group: m[1].toUpperCase(), reason: +m[2], cents: c }); }
  return out;
}
export function parseCodes(t: string, re: RegExp): string[] | null {
  const parts = t.split(/[\s,;]+/).map((x) => x.trim()).filter((x) => x && !/^(none|—|-|n\/?a)$/i.test(x));
  return parts.every((x) => re.test(x)) ? parts.map((x) => x.toUpperCase()) : null;
}
const PROC = /^[0-9A-Z]{5}$/i, MOD = /^[0-9A-Z]{2}$/i, REMARK = /^[A-Z]{1,2}\d{1,4}$/i;

/** Lines table → this claim's remittance lines. */
function parseRemitLines(t: PTable, fm: FamMaps, claimNo: string, dosISO: string): RemitLine[] | string {
  const H = t.headers;
  const iProc = col(H, [/^procedure|^code$|^cpt|^hcpcs|service code|proc/]);
  const iMod = col(H, [/modifier/]);
  const iAdj = col(H, [/adjust/]);
  const iRem = col(H, [/remark/]);
  const iBill = col(H, [/^billed|^charge|^submitted|billed amount/]);
  const iPaid = col(H, [/^paid|paid amount|^payment$/]);
  const iLine = col(H, [/^line$|^line #|^line no|^#$|^ln$/]);
  const iClaim = col(H, [/^claim$|^claim #|^claim no|^claim number/]);
  const iDos = col(H, [/service date|date of service|^dos$/]);
  if ([iProc, iAdj, iBill, iPaid].some((i) => i < 0) || iRem === -2 || iMod === -2 || iLine === -2 || iClaim === -2 || iDos === -2) return `remittance lines columns not recognised (${H.join(" | ")})`;
  const out: RemitLine[] = [];
  for (const r of t.rows) {
    const txt = (i: number) => (i < 0 ? "" : textOf(r[i], fm));
    // another claim on the same remittance: compare RAW digits (same page, same font as the h1)
    if (iClaim >= 0) { if (!claimNo) return "claim number not on the page"; if (rawOf(r[iClaim]).replace(/\D/g, "") !== claimNo) continue; }
    if (iDos >= 0) { const d = txt(iDos); if (d == null || oneDate(d) !== dosISO) return `remittance line service date "${d}" is not ${dosISO}`; }
    const proc = txt(iProc), mods = txt(iMod), adj = txt(iAdj), rem = txt(iRem), bill = txt(iBill), paid = txt(iPaid), ln = txt(iLine);
    if ([proc, mods, adj, rem, bill, paid, ln].some((x) => x == null)) return "a remittance line value is drawn in an unknown font";
    if (!PROC.test(proc!)) return `procedure "${proc}" not a code`;
    const ms = parseCodes(mods!, MOD); if (!ms) return `modifier "${mods}" not understood`;
    const as = parseAdjustments(adj!); if (!as) return `adjustments "${adj}" not understood`;
    const rs = parseCodes(rem!, REMARK); if (!rs) return `remark codes "${rem}" not understood`;
    const b = parseCents(bill!), pd = parseCents(paid!);
    if (b == null || pd == null) return `billed/paid "${bill}"/"${paid}" not amounts`;
    out.push({ line: ln && /^\d+$/.test(ln) ? +ln : null, procedure: proc!.toUpperCase(), modifiers: ms, adjustments: as, remarks: rs, billedCents: b, paidCents: pd });
  }
  return out;
}

/** The claim detail page → facts. */
export function parseClaimPage(p: PPage, fm: FamMaps, dosISO: string): ClaimFacts | Decline {
  if (!/^claim\b/i.test(p.h1.trim())) return D(`page is not a claim (h1 "${p.h1}")`);
  const claimNo = p.h1.replace(/\D/g, "");          // raw digits: compared only with raw digits on this page
  const det = oneSec(p, /^(claim )?details$|^summary$|^claim information$/);
  if (!det || det === "many") return D(det ? "several Details sections" : "no Details section on the claim page");
  const one = (re: RegExp) => { const v = dlGet([det], re); return v.length === 1 ? v[0] : v.length ? "many" : null; };
  const fDos = one(/^service date$|^date of service$|^dos$/), fPayer = one(/^payer$|^insurer$|^billed to$/), fPlan = one(/^plan$|^insurance plan$/), fPat = one(/^patient$/);
  if (!fDos || fDos === "many" || !fPayer || fPayer === "many") return D("claim Details lack one service date / payer");
  const dosTxt = textOf(fDos, fm); if (dosTxt == null || oneDate(dosTxt) !== dosISO) return D(`claim service date "${dosTxt}" is not ${dosISO}`);
  const payer = rawOf(fPayer).split(/\n/)[0].trim();
  if (!payer) return D("claim payer empty");
  const plan = fPlan && fPlan !== "many" ? rawOf(fPlan) || null : null;
  const contractLink = p.sections.flatMap((s) => s.links).find((l) => /contract/i.test(l.aria) && norm(l.aria).includes(norm(payer)));
  const payerHref = contractLink?.href ?? fPayer.href ?? null;
  const patientHref = fPat && fPat !== "many" ? fPat.href : null;

  // service lines as billed
  const slSec = oneSec(p, /^service lines?$|^lines$|^procedures$|^charges$/);
  if (!slSec || slSec === "many") return D(slSec ? "several service-lines sections" : "no Service lines section");
  if (slSec.tables.length !== 1) return D(`service lines section has ${slSec.tables.length} tables`);
  const st = slSec.tables[0];
  const sProc = col(st.headers, [/^procedure|^code$|^cpt|^hcpcs|proc/], [/description/]), sMod = col(st.headers, [/modifier/]), sLine = col(st.headers, [/^line$|^line #|^#$|^ln$/]);
  const sDesc = col(st.headers, [/description|^service$/]);
  if (sProc < 0 || sMod === -2 || sLine === -2) return D(`service lines columns not recognised (${st.headers.join(" | ")})`);
  const billedLines: BilledLine[] = [];
  const descs: Array<[string, string]> = [];   // [normalised description, code]: maps an authorization's Service to a code
  for (const r of st.rows) {
    const pr = textOf(r[sProc], fm), md = sMod >= 0 ? textOf(r[sMod], fm) : "", ln = sLine >= 0 ? textOf(r[sLine], fm) : "";
    if (sDesc >= 0 && pr) { const ds = rawOf(r[sDesc]); if (ds) descs.push([norm(ds), pr.toUpperCase()]); }
    if (pr == null || md == null || ln == null) return D("a service line is drawn in an unknown font");
    if (!PROC.test(pr)) return D(`service line procedure "${pr}" not a code`);
    const ms = parseCodes(md, MOD); if (!ms) return D(`service line modifier "${md}" not understood`);
    billedLines.push({ line: /^\d+$/.test(ln) ? +ln : null, procedure: pr.toUpperCase(), modifiers: ms });
  }
  if (!billedLines.length) return D("claim has no service lines");

  // submissions
  const subSec = oneSec(p, /^submissions?$|^claim submissions$|^submission history$/);
  const submissions: Submission[] = [];
  if (subSec === "many") return D("several submissions sections");
  if (subSec) {
    if (subSec.tables.length > 1) return D("several submissions tables");
    if (subSec.tables.length) {
      const t = subSec.tables[0];
      const iRes = col(t.headers, [/^result$|^status$|^outcome$|^response$/]), iRd = col(t.headers, [/result date|^resulted|response date|date of result|^result on/]);
      if (iRes < 0 || iRd < 0) return D(`submissions columns not recognised (${t.headers.join(" | ")})`);
      for (const r of t.rows) {
        const res = textOf(r[iRes], fm), rd = textOf(r[iRd], fm);
        if (res == null || rd == null) return D("a submission is drawn in an unknown font");
        const d = oneDate(rd);
        if (!d && rd.trim() && !/^(—|-|pending|n\/?a|none)$/i.test(rd.trim())) return D(`submission result date "${rd}" unreadable`);
        submissions.push({ result: res, resultDateISO: d });
      }
    }
  }

  // remittances
  const rSec = oneSec(p, /^remittances?$|^payments?$|^remittance advice$|^eobs?$/);
  if (!rSec || rSec === "many") return D(rSec ? "several remittances sections" : "no Remittances section on the claim page");
  const remittances: Remittance[] = [];
  const scanned: ClaimFacts["scanned"] = [];
  if (!rSec.groups.length && !rSec.tables.length) {
    if (!/\bno (remittances?|payments?|eobs?)\b|\bnot (yet )?received\b|\bnone (yet|received)\b/i.test(rSec.text.replace(/^\S+\s*/, ""))) return D(`remittances section shows neither remittances nor an empty-state ("${rSec.text.slice(0, 60)}")`);
  }
  if (rSec.tables.some((t) => t.group < 0) && rSec.groups.length) return D("a remittance lines table outside any remittance block");
  const groups = rSec.groups.length ? rSec.groups : rSec.tables.length === 1 ? null : [];
  if (groups === null) return D("one remittance table without its header block");
  for (const g of groups) {
    const head = textOf(g.head, fm);
    if (head == null) return D("remittance header drawn in an unknown font");
    const headRaw = rawOf(g.head);
    const firstLine = head.split("\n").find((l) => datesIn(l).length) ?? head;
    const ds = [...new Set(datesIn(firstLine))];
    if (ds.length !== 1) return D(`remittance header "${firstLine.slice(0, 80)}" has no single date`);
    const traceRaw = (g.label.match(/^remittance\s+(\S+)$/i) ?? [])[1] ?? (headRaw.match(/^\s*([A-Z]{2,5}\s?\d{4,})/) ?? [])[1] ?? null;
    if (!traceRaw) return D(`remittance header "${firstLine.slice(0, 60)}" names no trace number`);
    const isRev = /\breversal\b|\breversed?\b|\btake ?back\b|\brecoup/i.test(firstLine), isPay = /\bpayment\b|\bpaid\b|\bdenial\b|\bremittance\b/i.test(firstLine.replace(/reversal of payment/i, ""));
    if (isRev === isPay && !(isRev && /reversal of/i.test(firstLine))) return D(`remittance type not recognised in "${firstLine.slice(0, 80)}"`);
    const revOf = (headRaw.match(/revers(?:al|es|ing)\s+(?:of\s+)?(?:payment\s+)?([A-Z]{2,5}\s?\d+)/i) ?? [])[1] ?? null;
    const ts = g.tables.map((i) => rSec.tables[i]).filter((t) => col(t.headers, [/adjust/]) >= 0);
    const scanCue = /\bscann?(ed)?\b|\bpaper\b|\bnot keyed\b|\bimage\b|\bview (the )?(scan|image|eob)\b/i.test(g.text) || g.imgs > 0;
    if (!ts.length) {
      if (isRev) { remittances.push({ trace: traceRaw, paymentDateISO: ds[0], kind: "reversal", reverses: revOf, scanned: scanCue, lines: null }); continue; }
      if (!scanCue) return D(`remittance ${traceRaw} shows no lines and no scanned/paper marker`);
      remittances.push({ trace: traceRaw, paymentDateISO: ds[0], kind: "payment", reverses: null, scanned: true, lines: null });
      scanned.push({ trace: traceRaw, outline: g.outline, href: g.links[0]?.href ?? null });
      continue;
    }
    if (ts.length > 1) return D(`remittance ${traceRaw} has several lines tables`);
    if (scanCue && /\bnot keyed\b|\bscann?ed\b/i.test(g.text)) return D(`remittance ${traceRaw} shows a lines table and a scanned/not-keyed marker`);
    const lines = parseRemitLines(ts[0], fm, claimNo, dosISO);
    if (typeof lines === "string") return D(`remittance ${traceRaw}: ${lines}`);
    remittances.push({ trace: traceRaw, paymentDateISO: ds[0], kind: isRev ? "reversal" : "payment", reverses: isRev ? revOf : null, scanned: false, lines });
  }

  // authorizations
  const aSec = oneSec(p, /^(prior )?authori[sz]ations?$|^auths?$|^referrals and authori[sz]ations$/);
  if (!aSec || aSec === "many") return D(aSec ? "several authorizations sections" : "no Authorizations section on the claim page");
  const authorizations: Authorization[] = [];
  if (aSec.tables.length > 1) return D("several authorizations tables");
  if (!aSec.tables.length) {
    if (!/\bno (prior )?authori[sz]ations?\b|\bnone on file\b/i.test(aSec.text)) return D(`authorizations section without a table or empty-state ("${aSec.text.slice(0, 60)}")`);
  } else {
    const t = aSec.tables[0];
    const iPayer = col(t.headers, [/payer|insurer|plan/]), iProc0 = col(t.headers, [/procedure|^code$|cpt|hcpcs|service code/], [/description/]);
    // The real Set 1 authorizations table names a Service, not a code (Number | Payer | Service | Valid from |
    // Valid through | Visits approved | Status). A Service maps to a code only when it equals exactly one billed
    // line's description (Baseline  approach); otherwise the authorization is kept as "unmapped".
    const iSvc = iProc0 < 0 ? col(t.headers, [/^service$|^service description$|^procedure description$/]) : -1;
    const iProc = iProc0 >= 0 ? iProc0 : iSvc;
    const iStat = col(t.headers, [/^status$|^auth(orization)? status$/]);
    const iFrom = col(t.headers, [/valid from|^from$|^start|effective|begins?/]), iTo = col(t.headers, [/valid (to|through|until)|^to$|^through$|^end|expires?|until/]);
    const iRange = col(t.headers, [/^valid$|valid dates|dates? valid|^dates$|validity|period/]);
    if (iPayer < 0 || iProc < 0 || !((iFrom >= 0 && iTo >= 0) || iRange >= 0)) return D(`authorizations columns not recognised (${t.headers.join(" | ")})`);
    for (const r of t.rows) {
      const py = rawOf(r[iPayer]), pr = textOf(r[iProc], fm);
      const fromT = iFrom >= 0 ? textOf(r[iFrom], fm) : null, toT = iTo >= 0 ? textOf(r[iTo], fm) : null, rangeT = iRange >= 0 ? textOf(r[iRange], fm) : null;
      if (pr == null || (iFrom >= 0 && (fromT == null || toT == null)) || (iRange >= 0 && rangeT == null)) return D("an authorization is drawn in an unknown font");
      let proc = (pr.match(/\b([0-9A-Z]{5})\b/) ?? [])[1];
      let unmapped = false;
      if (!proc || (pr.match(/\b[0-9A-Z]{5}\b/g) ?? []).length !== 1) {
        if (iProc0 >= 0) return D(`authorization procedure "${pr}" is not one code`);
        const hits = [...new Set(descs.filter(([d]) => d === norm(pr)).map(([, code]) => code))];
        if (hits.length === 1) proc = hits[0]; else { proc = ""; unmapped = true; }
      }
      let from: string | null, to: string | null;
      if (iFrom >= 0 && iTo >= 0) { from = oneDate(fromT!); to = oneDate(toT!); }
      else { const ds = datesIn(rangeT!); from = ds.length === 2 ? ds[0] : null; to = ds.length === 2 ? ds[1] : null; }
      if (!from || !to || from > to) return D(`authorization dates unreadable ("${fromT ?? rangeT}" / "${toT ?? ""}")`);
      if (!py) return D("authorization without a payer");
      const status = iStat >= 0 ? rawOf(r[iStat]) : undefined;
      authorizations.push({ payer: py.split(/\s+[·•|]\s+/)[0].trim(), procedure: proc.toUpperCase(), fromISO: from, toISO: to, ...(status !== undefined ? { status } : {}), ...(unmapped ? { unmapped, service: pr } : {}) });
    }
  }

  // account notes
  const nSec = oneSec(p, /^account notes?$|^claim notes?$|^billing notes?$|^notes?$/);
  const notes: AccountNote[] = [];
  if (nSec === "many") return D("several account-notes sections");
  if (nSec) {
    for (const a of nSec.articles) {
      const iso = a.times.length === 1 && /^\d{4}-\d{2}-\d{2}T/.test(a.times[0]) ? new Date(a.times[0]).toISOString() : "";
      notes.push({ atISO: iso, text: a.body });
    }
    if (!nSec.articles.length && !/\bno (account )?notes\b/i.test(nSec.text) && nSec.text.replace(/^[^\n]*\n?/, "").trim()) return D("account notes section not understood");
  } else return D("no Account notes section on the claim page");

  const merged = /\bmerged\b|\bduplicate record\b/i.test(p.text);
  return { claimNo, patientHref, payer, payerHref, plan, serviceDateISO: dosISO, billedLines, submissions, remittances, authorizations, notes, merged, scanned };
}

/** "120 days" / "120 days from the remittance date" → 120; another unit or anchor → null. */
export function parseDaysValue(v: string, kind: "appeal" | "filing"): number | null {
  const t = norm(v);
  const m = t.match(/^(\d+)\s*(calendar\s+)?days?\b\s*(.*)$/);
  if (!m) return null;
  const rest = m[3].trim();
  if (rest) {
    if (/business|working/.test(rest)) return null;
    const ok = kind === "appeal" ? /^(from|after|of) (the )?(remittance|payment|remit|era|eob)( date)?$|^(from|after|of) (the )?date of (the )?(remittance|payment)$/ : /^(from|after|of) (the )?(date of service|service date|dos)$/;
    if (!ok.test(rest)) return null;
  }
  return +m[1];
}
/** The payer contract page → appeal + claims-accepted windows (null each when absent). */
export function parseContract(p: PPage, payer: string, fm: FamMaps): { appealDays: number | null; filingDays: number | null } | Decline {
  if (!norm(p.text).includes(norm(payer))) return D(`contract page does not name ${payer}`);
  const found: Record<"appeal" | "filing", Set<number>> = { appeal: new Set(), filing: new Set() };
  const bad: string[] = [];
  const LAB: Record<"appeal" | "filing", RegExp> = { appeal: /\bappeals?\b.*\b(within|window|limit|deadline|accepted|filing)\b|^appeals?$|^appeal (window|limit|deadline|period)$/, filing: /^claims? accepted within$|^claims? (filing )?(window|limit|deadline)$|^timely filing( limit)?$|^accepts? claims within$|^claims? within$/ };
  const take = (label: string, cell: PCell | undefined) => {
    for (const k of ["appeal", "filing"] as const) {
      if (!LAB[k].test(norm(label))) continue;
      const v = textOf(cell, fm); if (v == null) { bad.push(`${label} drawn in an unknown font`); continue; }
      const d = parseDaysValue(v, k); if (d == null) { bad.push(`${label}: "${v}" not understood`); continue; }
      found[k].add(d);
    }
  };
  for (const s of p.sections) {
    for (const [k, v] of s.dl) take(k, v);
    for (const t of s.tables) {
      for (let i = 0; i < t.headers.length; i++) for (const r of t.rows) take(t.headers[i], r[i]);
      if (t.headers.length <= 2) for (const r of t.rows) if (r.length === 2) take(rawOf(r[0]), r[1]);  // label | value rows
    }
  }
  if (bad.length) return D(`${payer} contract: ${bad[0]}`);
  for (const k of ["appeal", "filing"] as const) if (found[k].size > 1) return D(`${payer} contract shows several ${k} windows (${[...found[k]].join(", ")})`);
  return { appealDays: [...found.appeal][0] ?? null, filingDays: [...found.filing][0] ?? null };
}

/** The chart's Claims table → the one claim with this date of service. */
export function findClaim(rows: Array<{ dos: string | null; href: string | null; text: string }>, dosISO: string): string | Decline {
  const hits = rows.filter((r) => r.dos === dosISO);
  if (hits.length !== 1) return D(hits.length ? `${hits.length} claims with service date ${dosISO}` : `no claim with service date ${dosISO} on the chart (${rows.length} claims)`);
  if (!hits[0].href) return D("the claim row has no link");
  return hits[0].href;
}
const CLAIM_TABLE = (s: Snapshot) => s.sections.flatMap((x) => x.tables).filter((t) => col(t.headers, [/^claim$|^claim #|^claim no|^claim number/]) >= 0 && col(t.headers, [/service date|date of service|^dos$/]) >= 0);
export function claimRows(s: Snapshot): Array<{ dos: string | null; href: string | null; text: string }> | Decline {
  const ts = CLAIM_TABLE(s).filter((t, i, a) => a.findIndex((x) => JSON.stringify(x) === JSON.stringify(t)) === i);
  if (ts.length !== 1) return D(ts.length ? "several claims tables on the chart" : "no claims table on the chart");
  const t = ts[0];
  const iC = col(t.headers, [/^claim$|^claim #|^claim no|^claim number/]), iD = col(t.headers, [/service date|date of service|^dos$/]);
  return t.rows.map((r) => {
    const c = r[iD]; const dos = !c ? null : c.obf ? (c.times.filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)).length === 1 ? c.times[0] : null) : oneDate(c.text);
    return { dos, href: r[iC]?.href ?? r.map((x) => x.href).find(Boolean) ?? null, text: r.map((x) => x.text).join(" | ") };
  });
}

/** Payers list + one payer page → plans (for reading other-insurance notes). */
export function payerLinks(s: Snapshot): Array<{ payer: string; href: string }> {
  return s.sections.flatMap((x) => x.tables).flatMap((t) => { const i = col(t.headers, [/^payer$|^payer name$|^name$/]); return i < 0 ? [] : t.rows.map((r) => r[i]).filter((x) => x?.href).map((x) => ({ payer: x.text.trim(), href: x.href! })); })
    .filter((x, i, a) => a.findIndex((y) => y.href === x.href) === i);
}
export function payerPlans(s: Snapshot, payer: string): string[] | Decline {
  if (!norm(s.h1).includes(norm(payer))) return D(`payer page is not ${payer}`);
  const ts = s.sections.flatMap((x) => x.tables).filter((t) => col(t.headers, [/^plan$|^plan name$/]) >= 0).filter((t, i, a) => a.findIndex((x) => JSON.stringify(x) === JSON.stringify(t)) === i);
  if (ts.length > 1) return D(`${payer} page has several plans tables`);
  if (!ts.length) return /\bno plans\b/i.test(s.text) ? [] : D(`${payer} page has no plans table`);
  const i = col(ts[0].headers, [/^plan$|^plan name$/]);
  return ts[0].rows.map((r) => (r[i]?.text ?? "").trim()).filter(Boolean);
}

// ════════════════════════════ live navigation ════════════════════════════

const snapS = (c: Crawler) => c.evalApp<Snapshot>(SNAPSHOT_JS);
async function claimPage(c: Crawler, ready: (p: PPage) => boolean, ms = 8000): Promise<PPage | null> {
  const t0 = Date.now(); let p: PPage | null = null;
  while (Date.now() - t0 < ms) { p = await c.evalApp<PPage>(CLAIM_JS).catch(() => null); if (p && ready(p)) return p; await new Promise((r) => setTimeout(r, 120)); }
  return null;
}
/** How to read each custom font family on the current page; declines when a family can't be placed. */
export async function famMapsFor(c: Crawler, p: PPage): Promise<FamMaps | Decline> {
  if (!p.families.length) return {};
  const fm = await c.familyDigitMaps(p.families).catch(() => ({} as FamMaps));
  const missing = p.families.filter((f) => !fm[f]);
  if (missing.length) {
    const st = await c.digitState().catch(() => null);
    if (st && st.fonts > 0 && st.scrambled === 0) for (const f of missing) fm[f] = "identity";        // only identity fonts on this page
    else if (st && st.map && st.scrambled === 1 && missing.length === 1 && !Object.values(fm).some((v) => v && v !== "identity")) fm[missing[0]] = st.map;
    else return D(`digits drawn in font(s) ${missing.join(", ")} could not be decoded`);
  }
  return fm;
}

let scanLogged = false;
/** What a scanned-remittance read is expected to cost the shift (s): page + image open ~2 s, tesseract ∥ primary ∥ tiebreak ~5 s (was ~11 s with the sequential tiebreak: 12 reads of run 278 took 6.5-17 s). The pacer admits it only on that much slack. */
const SCAN_EST_S = () => { const n = Number(process.env.CLAIM_SCAN_EST_S); return Number.isFinite(n) && n > 0 ? n : process.env.REMIT_TB_PARALLEL === "0" ? 13 : 8; };
const contractCache = new Map<string, { appealDays: number | null; filingDays: number | null }>();
let plansCache: PlanRef[] | null = null;
export function resetClaimCaches() { contractCache.clear(); plansCache = null; scanLogged = false; }
// AGENT_CACHE=on: a message that says a payer's terms changed ("This is in Wrenfield now: …") ends what this shift read of them
onDrop("payers", () => { contractCache.clear(); plansCache = null; });

export type ClaimRead = { ctx: ClaimContext };
/** Chart → claim → contract (→ plans) for one asked claim. `patHref` from the shared patient resolver. */
const NO_TERMS: { appealDays: number | null; filingDays: number | null } = { appealDays: null, filingDays: null };
/** The payer's contract terms (Appeals / Claims accepted within), cached per payer for the session —
 *  a page that can't be read is cached too, as NO terms. Not a decline: the engine uses the terms only
 *  for an appeal or a reason-29 claim and declines there itself ("contract shows no appeal window");
 *  every other next step (AWAIT_PAYER, NO_ACTION, BILL_PATIENT, RESUBMIT, CALL_PAYER, BILL_OTHER,
 *  CONTACT_PATIENT, a 97/197 write-off) never reads them. The Set 1 contract page was never captured,
 *  so one unexpected layout must not turn all 38 claim tasks into skips, nor cost every task the 6 s
 *  page wait again. */
export async function contractTerms(c: Pick<Crawler, "navTo" | "evalApp" | "familyDigitMaps" | "digitState">, payer: string, payerHref: string | null | undefined,
  log: (rec: Record<string, unknown>) => void = () => {}, waitMs = 6000): Promise<{ appealDays: number | null; filingDays: number | null }> {
  const key = normName(payer);
  const hit = contractCache.get(key); if (hit) return hit;
  const read = async (): Promise<{ appealDays: number | null; filingDays: number | null } | Decline> => {
    if (!payerHref) return D(`no link to ${payer}'s contract`);
    await c.navTo(payerHref, /./, 8000).catch(() => false);
    const cp = await claimPage(c as Crawler, (p) => norm(p.text).includes(norm(payer)) && /\bappeal|\bwithin\b|\bdays\b/i.test(p.text), waitMs);
    if (!cp) return D(`${payer} contract page did not load`);
    const cfm = await famMapsFor(c as Crawler, cp); if (isDecline(cfm)) return cfm;
    return parseContract(cp, payer, cfm);
  };
  const k = await read().catch((e) => D(`${payer} contract: ${String(e).slice(0, 60)}`));
  const terms = isDecline(k) ? NO_TERMS : k;
  contractCache.set(key, terms);
  log({ step: "claim_contract", payer, ...terms, ...(isDecline(k) ? { decline: k.decline } : {}) });
  return terms;
}

export async function readClaim(c: Crawler, patHref: string, dosISO: string, policy: ClaimPolicy, log: (rec: Record<string, unknown>) => void = () => {}): Promise<ClaimContext | Decline> {
  const ready = (s: Snapshot) => CLAIM_TABLE(s).length > 0 || /\bno claims\b/i.test(s.text);
  const tab = await chartTab(c, patHref, /^claims$|^claims and remittances$|^billing claims$/, "claims", ready);
  if (isDecline(tab)) return D(tab.decline);
  if (!CLAIM_TABLE(tab).length) return D("the chart has no claims");
  const rows = await allPages(c, /claim/i, (s) => claimRows(s), tab);
  if (isDecline(rows)) return D("claims list: " + rows.decline);
  const href = findClaim(rows, dosISO); if (isDecline(href)) return href;
  const chartMerged = /\bmerged\b|\bduplicate record\b/i.test(tab.text);

  await c.navTo(href, /./, 8000).catch(() => false);
  const page = await claimPage(c, (p) => /^claim\b/i.test(p.h1) && secBy(p, /remittance|payment/).length > 0 && secBy(p, /details|summary/).length > 0 && secBy(p, /notes?/).length > 0);
  if (!page) return D("claim page did not load");
  const fm = await famMapsFor(c, page); if (isDecline(fm)) return fm;
  const facts = parseClaimPage(page, fm, dosISO); if (isDecline(facts)) return facts;
  const merged = chartMerged || facts.merged || (!!facts.patientHref && facts.patientHref.replace(/\/$/, "") !== patHref.replace(/\/$/, ""));

  // current remittance scanned → open its remittance page, press "View the scanned document of remittance
  // <trace>", read the one-page image (remitRead.ts: tesseract ∥ model, tiebreak, every field agreed, then
  // the document's arithmetic and the keyed pages must agree) → its lines count like keyed lines (message).
  const cr = currentRemittance(facts.remittances);
  if (!("decline" in cr) && cr.cur?.scanned) {
    const cur = cr.cur;
    const s0 = facts.scanned.find((x) => x.trace === cur.trace);
    if (process.env.CLAIM_SCAN_READ === "0") return D(`current remittance ${cur.trace} is a scanned paper remittance (lines not keyed); scan reader off`);
    if (!s0?.href) return D(`current remittance ${cur.trace} is scanned and its remittance page is not linked`);
    // A read whose answer cannot change the outcome is not paid for (a payer-level block, a remittance paid before the service
    // date, a rule without CO-45 decline whatever the image shows). The pacer is asked BEFORE the page and the image are opened,
    // not after: the 8 reads run 265 refused each spent ~3 s opening an image that was then never read.
    const early = declineBeforeLines(facts.payer, cur, dosISO, policy); if (early && "decline" in early) return D(early.decline.replace(/^claim: /, ""));
    // The pacer is asked BEFORE the page and the image are opened (the 8 reads run 265 refused each spent ~3 s opening an image first),
    // and told what the read took (v2 prices scans from the shift's own samples).
    const { pacer } = await import("./pacer.js"); const est = SCAN_EST_S();
    const adm = pacer.admit("scan", est); if (!adm) return D(`current remittance ${cur.trace} is scanned; pacer: no slack for a scan read (~${est} s)`);
    const tScan = Date.now();
    try {
    await c.navTo(s0.href, /./, 8000).catch(() => false);
    const rp = await claimPage(c, (p) => /^remittance\b/i.test(p.h1) && /view (the )?scanned document/i.test(p.text), 6000);
    if (!rp) return D(`remittance page of ${cur.trace} did not load`);
    if (rp.h1.replace(/^remittance\s+/i, "").trim() !== cur.trace) return D(`remittance page is "${rp.h1}", not ${cur.trace}`);
    const rfm = await famMapsFor(c, rp); if (isDecline(rfm)) return rfm;
    const rdet = oneSec(rp, /^details$|^summary$/);
    const rdl = (re: RegExp) => { if (!rdet || rdet === "many") return undefined; const v = dlGet([rdet], re); return v.length === 1 ? textOf(v[0], rfm) : undefined; };
    const keyedTotal = rdl(/^total paid$/), keyedDate = rdl(/^payment date$/);
    if (keyedDate != null && oneDate(keyedDate) !== cur.paymentDateISO) return D(`remittance page payment date "${keyedDate}" is not ${cur.paymentDateISO}`);
    const esc = cur.trace.replace(/[^A-Za-z0-9]/g, "");
    if (typeof (c as Crawler).probeOpen !== "function") return D(`current remittance ${cur.trace} is scanned; this crawler cannot open documents`);
    const shot = await c.probeOpen(new RegExp(`view (the )?scanned document of remittance ${esc}`), 3_000_000).catch(() => null) as any;
    const b64: string | undefined = shot?.imgB64;
    const imgs: Array<{ alt?: string }> = Array.isArray(shot?.imgs) ? shot.imgs : [];
    const pages = imgs.map((i) => String(i.alt ?? "").match(/page (\d+) of (\d+)/i)).filter(Boolean) as RegExpMatchArray[];
    if (!b64) return D(`scanned document of ${cur.trace} did not open`);
    if (pages.length !== 1 || pages[0][2] !== "1" || !/\b1 page\b/i.test(String(shot?.text ?? ""))) return D(`scanned document of ${cur.trace} is not one page`);
    const { readRemit } = await import("./remitRead.js");
    const kt = keyedTotal != null ? parseCents(keyedTotal) : null;
    if (keyedTotal != null && kt == null) return D(`remittance total paid "${keyedTotal}" unreadable`);
    const { lines, trace } = await readRemit(b64, { trace: cur.trace, paymentDateISO: cur.paymentDateISO, dosISO, claimNo: null, billedLines: facts.billedLines, totalCents: kt });
    if (!scanLogged) { scanLogged = true; log({ step: "claim_scan_read", trace: cur.trace, ...trace, ...(typeof lines === "string" ? { decline: lines } : { lines: lines.length }) }); }
    else log({ step: "claim_scan_read", trace: cur.trace, ms: trace.ms, unknown: trace.unknown, ...(typeof lines === "string" ? { decline: lines } : {}) });
    if (typeof lines === "string") return D(lines);
    cur.lines = lines; cur.scanned = false;   // read and checked: counts the same as keyed lines
    } finally { adm.done((Date.now() - tScan) / 1000); }
  }

  // contract terms (per payer, cached for the session; an unreadable contract gives no terms)
  const contract = await contractTerms(c, facts.payer, facts.payerHref, log);

  // payers' plans: only when an account note decides the answer (reason 22 worked)
  let knownPlans: PlanRef[] | null = null;
  const reason = !("decline" in cr) && cr.cur?.lines ? workedReason(cr.cur.lines, policy) : null;
  if (reason === 22 && facts.notes.length) {
    if (!plansCache) {
      await c.navTo("/payers", /./, 8000).catch(() => false);
      const list = await waitFor(c, (s) => payerLinks(s).length > 0, 8000);
      if (!list) return D("payers list did not load");
      const pg = pagerOf(list, /payer|entr|result/i);
      if (pg) { const v = isComplete(payerLinks(list).length, pg.footer); if (!v.complete) return D(`payers list not completely read: ${v.why}`); }
      const out: PlanRef[] = [];
      for (const pl of payerLinks(list)) {
        await c.navTo(pl.href, /./, 8000).catch(() => false);
        const ps = await waitFor(c, (s) => norm(s.h1).includes(norm(pl.payer)) && (s.sections.some((x) => x.tables.some((t) => col(t.headers, [/^plan$|^plan name$/]) >= 0)) || /\bno plans\b/i.test(s.text)), 6000);
        if (!ps) return D(`${pl.payer} payer page did not load`);
        const plans = payerPlans(ps, pl.payer); if (isDecline(plans)) return plans;
        for (const x of plans) out.push({ payer: pl.payer, plan: x });
      }
      plansCache = out;
    }
    knownPlans = plansCache;
  }

  return {
    serviceDateISO: dosISO, payer: facts.payer, plan: facts.plan, contract,
    remittances: facts.remittances, billedLines: facts.billedLines, submissions: facts.submissions,
    authorizations: facts.authorizations, notes: facts.notes, knownPlans, mergedRecord: merged,
  };
}
