import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import CDP from "chrome-remote-interface";
import { buildDigitMap, applyDigitMap, fontKinds, type DigitMap } from "./fontDecode.js";
import { mayBreakGlass, breakGlassPolicy, type ResolvedVia } from "./glassPolicy.js";
import { SiteMap, templateOf, type Fingerprint } from "./sitemap.js";
import * as NR from "./nameResolve.js";
import { listFooter, isComplete } from "./listFooter.js";
import { noteRequest, noteMiss, noteArrived, isSuspendedText } from "./siteWatch.js";
import type { InvoicePage, ProviderDay } from "./inference.js";
import { INVOICE_PAGE_JS, PROVIDER_DAY_JS, DOCUMENT_ROWS_JS, PATIENT_ROWS_JS, parseInvoicePage, parseProviderDay, parseDocumentRows, parsePatientRows } from "./pageScripts.js";
import { paceList, noteLat, noteLoad, noteBusyPage } from "./siteBudget.js";

/**
 * Headless Wrenfield crawler. The real browser handles the channel/render; we drive
 * it by URL and read data out of the nested app iframe (same-origin). Used to populate
 * the ClinicIndex (on-demand patient resolution + bulk schedule/billing).
 */
const EXE = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** One appointment row. `providerRaw` / `time` = the row's own provider text ("Name, NP") and clock text ("9:20 AM MDT"), kept for formFlags.ts. */
type ApptRow = { dateISO: string; service: string; provider: string; location: string; status: string; providerRaw?: string; time?: string };
/** AGENT_PACER=v2: wait out a suspended account and fail fast where a navigation cannot be repeated (flag off: the marker wait runs out as before). */
const V2 = (process.env.AGENT_PACER ?? "").toLowerCase() === "v2";

export type PatientRow = { name: string; href: string; mrn?: string; dob?: string; sex?: string; flags?: string[] };

/** Has the awaited page arrived? The marker must show; when it already showed on the page we left (`stale`) the
 *  text must differ too — unless the document is a new one (`fresh`: the navigation replaced it, so identical
 *  text is the new page's own). */
export function markerArrived(t: string, before: string, hit: (t: string) => boolean, stale: boolean, fresh: boolean): boolean {
  return hit(t) && (!stale || t !== before || fresh);
}
/** Marker-free arrival (GENERALIZATION-AUDIT.md §3): after a real navigation, a page whose wording never shows the
 *  marker has still ARRIVED once its content inventory (`sig`: headings, tables + row counts, dl pairs, list items,
 *  forms, footer statements) has rendered and held still for `holdMs`. It is consulted only `minMs` after the
 *  navigation — well past the slowest Set 1 marker (max 850 ms in runs 162/164) — so a marker that will show is never
 *  pre-empted, and a marker miss costs ~1.8 s instead of the 8–12 s timeout. */
export function settledArrival(sig: string, lastSig: string, heldMs: number, sinceNavMs: number, minMs = Crawler.SETTLE_MIN_MS, holdMs = Crawler.SETTLE_HOLD_MS): boolean {
  return !!sig && sig === lastSig && heldMs >= holdMs && sinceNavMs >= minMs;
}

export class Crawler {
  private client: any; private child!: ChildProcess; port = 0;
  // font de-obfuscation: fonts loaded during the current navigation (url→bytes), and the
  // cached digit map for the current page.
  private fontCache = new Map<string, Buffer>();
  private imgCache = new Map<string, Buffer>();           // native document images (PNG) off the /v/ channel
  private reqUrl = new Map<string, string>();
  private recentFonts: string[] = [];
  private recentDocImgs: string[] = [];
  private pageDigitMap: DigitMap | null | undefined = undefined;
  /** Discovered state machine of the app; grows as a side effect of every navigation. */
  readonly map: SiteMap;
  /** A side tab reads the shared map (link fallbacks) but does not write it: two tabs observing
   *  concurrently would interleave `current` and record transitions that never happened. */
  private passive = false; private targetId = "";
  constructor(private site: string, private profile = join(process.env.WORK_DIR || homedir(), "wrenfield-profile"), map?: SiteMap) {
    this.map = map ?? new SiteMap(join(process.env.WORK_DIR || homedir(), "sitemap.json"));
  }

  async launch() {
    const portFile = join(this.profile, "DevToolsActivePort");
    try { unlinkSync(portFile); } catch {}
    // --no-sandbox / --disable-dev-shm-usage: the judge container runs as a non-root user with
    // no Linux capabilities (no user namespaces → Chrome's sandbox can't start) and only
    // 1024 MiB of /dev/shm (Chromium crashes under it). Both are required there; harmless locally.
    this.child = spawn(EXE, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${this.profile}`, "--no-first-run", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "about:blank"], { stdio: "ignore" });
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !this.port) { if (existsSync(portFile)) { try { this.port = Number(readFileSync(portFile, "utf8").split("\n")[0].trim()); } catch {} } if (!this.port) await sleep(100); }
    if (!this.port) throw new Error("no devtools port");
    this.client = await CDP({ port: this.port });
    await this.wire();
  }

  /** A second tab in the same browser (shares the login cookie), for fetching pages in parallel. */
  async spawnTab(): Promise<Crawler> {
    const t = new Crawler(this.site, this.profile, this.map);
    t.passive = true; t.port = this.port; t.child = this.child;
    ({ targetId: t.targetId } = await this.client.Target.createTarget({ url: "about:blank" }));
    t.client = await CDP({ port: this.port, target: t.targetId });
    await t.wire();
    return t;
  }
  async closeTab() { try { await this.client.Target.closeTarget({ targetId: this.targetId }); } catch {} try { this.client.close(); } catch {} }

  private async wire() {
    await this.client.Page.enable();
    // Capture font files the page loads, so obfuscated numeric fields can be decoded.
    await this.client.Network.enable().catch(() => {});
    this.client.Network.requestWillBeSent((p: any) => { if (/^(Document|XHR|Fetch)$/.test(p?.type || "")) noteRequest(); }); // siteWatch.ts: log-only request count of every tab
    this.client.Network.responseReceived(({ requestId, response }: any) => {
      if (/\.woff2?(\?|$)/i.test(response.url)) { this.reqUrl.set(requestId, response.url); this.recentFonts.push(response.url); }
      else if (/^image\//.test(response.mimeType || "") && /\/v\//.test(response.url)) { this.reqUrl.set(requestId, response.url); this.recentDocImgs.push(response.url); }
    });
    this.client.Network.loadingFinished(async ({ requestId }: any) => {
      const url = this.reqUrl.get(requestId); if (!url) return;
      const cache = this.recentDocImgs.includes(url) ? this.imgCache : this.fontCache;
      if (cache.has(url)) return;
      try { const b = await this.client.Network.getResponseBody({ requestId }); cache.set(url, Buffer.from(b.body, b.base64Encoded ? "base64" : "utf8")); } catch {}
    });
  }

  /** Navigate the top frame; wait until the app iframe shows `marker` text (or timeout). */
  /** When the current page was last loaded. The practice app's session for a page expires a few seconds
   *  after the load (measured 2026-10-08: a click 7 s after the load gets HTTP 401 and the app reloads, at 5 s
   *  it works), so a page older than AGENT_PAGE_FRESH_MS is reloaded before it is reused. */
  private loadedAt = 0;
  static get FRESH_MS() { return Number(process.env.AGENT_PAGE_FRESH_MS ?? 4000); }
  /** `fresh`: always load the page anew (a list whose pager/page size an earlier walk changed). */
  async navTo(path: string, marker: string | RegExp, timeoutMs = 12000, fresh = false) {
    const action = "goto " + path.replace(/[^/?]*\d[^/?]*/g, "{id}");
    // Already on that page, recently loaded, and it shows the marker: stay. Re-navigating reloads the app
    // under the caller's next DOM action and nothing is gained. A page loaded longer ago is reloaded: its
    // session may have expired, and the caller's next click or form submit would only reload it anyway.
    const cur = await this.evalTop<string>("location.pathname+location.search").catch(() => "");
    if (cur === path && !fresh && Date.now() - this.loadedAt < Crawler.FRESH_MS) { const t = await this.appText().catch(() => ""); if (t && (typeof marker === "string" ? t.includes(marker) : marker.test(t))) { await this.record(action, true, 0).catch(() => {}); return true; } }
    this.recentFonts = []; this.recentDocImgs = []; this.pageDigitMap = undefined; // new page → new assets
    // Reloading the page we are on renders the same text: tag the old DOM so the reload is seen as new.
    if (cur === path) await this.evalApp(`if(doc.body) doc.body.appendChild(doc.createTextNode(' [reloading]')); return true;`).catch(() => false);
    const before = await this.appText().catch(() => "");
    await this.markOld();
    await Crawler.navGate();
    await this.client.Page.navigate({ url: this.site.replace(/\/$/, "") + path });
    return this.awaitMarker(marker, timeoutMs, action, before, true, path);
  }

  /** The site's account-suspended page ("Wrenfield / This account is suspended / You cannot use Wrenfield with this account at the moment. Try again later").
   *  Run 265 met it twice (after its aggregates' "site busy" lists) and then spent 13 s on every item that needed the site: the page never shows the
   *  search form, so two marker waits (7 s + 4 s) ran out each time. Only with AGENT_PACER=v2 (without the wait, failing at once would burn the queue
   *  in seconds instead of 13 s an item): a navigation that lands on the page is repeated every few seconds until the site
   *  answers again (at most AGENT_SUSPEND_WAIT_S, never into the last seconds of the shift), then the item goes on, instead of failing the item. */
  static readonly SUSPENDED = /\bThis account is suspended\b/i; // (the wait itself: waitOutSuspension below, on by default via AGENT_SUSPEND_WAIT_S)
  suspensions = 0;
  /** Tag the current documents, so the page a navigation lands on is told apart from the one it left even when
   *  both show the same text (two patients' empty Documents tabs: neither shows the patient's name — the Set 1
   *  replica run waited out 2 × 8 s per patient there). A real navigation replaces both documents. */
  private async markOld() { await this.evalApp(`try{ doc.__wfOld = 1; window.__wfOld = 1; }catch(e){} return 1`).catch(() => {}); }
  private async isFresh(): Promise<boolean> { return (await this.evalApp<boolean>(`return !(doc.__wfOld || window.__wfOld)`).catch(() => false)) === true; }

  /** Wait for `marker` in the app text, then record the state reached in the site map. */
  /** If the marker was already on the page we navigated FROM (a patient's name on the search results,
   *  "Date of birth" on the search form), the text must also change, or the stale DOM passes as the
   *  new page. */
  /** Content inventory of the app document under `main` (or the body): "" until DATA has rendered — a table (even an
   *  empty one with its headers), label/value pairs, a form or a list-size footer. Headings and nav items alone are not
   *  content: a "Not found" / error page or the app shell must never pass as the page a reader asked for (navTo's callers
   *  fall back to a link when a direct URL does not arrive, and a settled 404 would skip that). "" while the app says it
   *  is loading or shows an error. One string, compared across polls by settledArrival. */
  static readonly INVENTORY_JS = `const T=e=>((e&&(e.innerText!=null?e.innerText:e.textContent))||'').replace(/\\s+/g,' ').trim();
    const root=doc.querySelector('main')||doc.body; if(!root) return '';
    const hs=[...root.querySelectorAll('h1,h2,h3,h4')].map(T).filter(Boolean).slice(0,12);
    const tb=[...root.querySelectorAll('table')].map(t=>t.querySelectorAll('tbody tr').length+':'+[...t.querySelectorAll('th')].map(T).join('|').slice(0,80));
    const dl=root.querySelectorAll('dt').length, li=root.querySelectorAll('li').length, fm=root.querySelectorAll('form').length;
    const txt=T(root);
    const ft=(txt.match(/Showing [^.]{0,60}|\\b(?:about )?\\d[\\d,]*\\+? (?:entries|notes|appointments|claims|rows|results|records|documents|patients|invoices|payers)\\b|No more results|No [a-z]+ match/g)||[]).join(';');
    if(!tb.length&&!dl&&!fm&&!ft) return '';
    if(/\\b(?:Loading(?:…|\\.\\.\\.| Wrenfield)|page not found|not found|something went wrong|no such page|an error occurred)\\b/i.test(txt)&&!tb.length&&!dl) return '';
    return JSON.stringify([hs,tb,dl,li,fm,ft]);`;
  static get SETTLE_MIN_MS() { return Number(process.env.AGENT_SETTLE_MIN_MS ?? 1500); }
  static readonly SETTLE_HOLD_MS = 300;

  /** Page-load governor. Set 1 run 265 saw the product suspend the account (15 pages, below) after bursts of parallel-tab page
   *  loads; run 278 (no suspension) never loaded more than 3.0 pages/s over 10 s, 1.7/s over 30 s, 1.47/s over 60 s, 1.27/s over 120 s
   *  (page loads of every tab, from its log; run 265: 7.5 / 3.5 / 2.43 / 1.88). The speed-ups of this build take idle seconds out of
   *  the same page loads, which raises the average rate; this cap keeps EVERY window within 20 % of run 278's own maxima (cost on 278's
   *  timeline: ~7 s of 740) whatever the readers do, tabs included. AGENT_NAV_CAP="10:36,30:61,60:105,120:182" = at most N loads in any
   *  W seconds ("window:loads" pairs); "off" disables it. Counts navTo / navByLink page loads of all tabs of this process. */
  static readonly NAV_CAPS: Array<[number, number]> = (() => {
    const v = process.env.AGENT_NAV_CAP ?? "10:36,30:61,60:105,120:182"; if (!v || v === "off" || v === "0") return [];
    return v.split(",").map((p) => p.split(":").map(Number) as [number, number]).filter(([w, n]) => w > 0 && n > 0);
  })();
  private static navTimes: number[] = []; static navDelayedMs = 0;
  static async navGate(): Promise<void> {
    const caps = Crawler.NAV_CAPS; if (!caps.length) return;
    const maxW = Math.max(...caps.map(([w]) => w)) * 1000; const ts = Crawler.navTimes;
    for (;;) {
      const now = Date.now(); while (ts.length && ts[0] <= now - maxW) ts.shift();
      let wait = 0;
      for (const [w, n] of caps) { if (ts.length >= n) { const edge = ts[ts.length - n] + w * 1000 - now; if (edge > wait) wait = edge; } }
      if (wait <= 0) { ts.push(now); return; }
      Crawler.navDelayedMs += wait;
      if (wait >= 500) { try { process.stderr.write(JSON.stringify({ event: "nav_gate", waitMs: Math.round(wait), totalDelayedMs: Math.round(Crawler.navDelayedMs) }) + "\n"); } catch {} }
      await sleep(wait + 5);
    }
  }

  /** The product's "This account is suspended" page replaces the whole app for a while (Set 1 run 265: two spells, one of
   *  ~60 s and one from ~740 s to the end; every page read of the spell timed out at 4-12 s and the tasks of the spell
   *  were skipped: 219 s of marker timeouts in all). It is a whole-page state, never a chart's text: short, and it says to
   *  try again later. */
  static isSuspended(t: string): boolean { return t.length < 600 && /This account is suspended/i.test(t) && /try again later/i.test(t); }
  /** Credentials of the shift's sign-in (login() keeps them), for signing in again when the session ends mid-shift. */
  static creds: { user: string; pass: string } | null = null;
  static relogins = 0; static reloginFails = 0; private static reloginP: Promise<boolean> | null = null; private static inRelogin = false;
  /** Cheap text cue for a sign-in page (confirmed by onLoginForm): short, and asks to sign in / for a password. */
  static looksLikeLogin(t: string): boolean { return t.length < 1500 && /\bsign(?:ed)? ?in\b|\blog ?in\b|\bpassword\b|\bsession (?:has )?(?:ended|expired)\b/i.test(t); }
  /** The top document is the sign-in form (a password field) or the /login route. */
  private async onLoginForm(): Promise<boolean> {
    return (await this.evalTop<boolean>(`location.pathname==='/login' || !!document.querySelector('input[type=password]')`).catch(() => false)) === true;
  }
  /** Sign in again (one sign-in at a time across tabs: the cookie is shared), then set the location picker back to All locations (a new
   *  session starts on one location). Logs one {"event":"relogin"} line. */
  private async relogin(action: string): Promise<boolean> {
    if (!Crawler.creds || Crawler.inRelogin || Crawler.reloginFails >= 2) return false; // two failed sign-ins in a row: stop trying (each costs ~12 s)
    if (Crawler.reloginP) return Crawler.reloginP;
    const run = (async () => {
      Crawler.inRelogin = true; const t0 = Date.now(); let ok = false, picker = "";
      try {
        ok = await this.login(Crawler.creds!.user, Crawler.creds!.pass).catch(() => false);
        if (ok) { await this.setAllLocations().catch(() => {}); picker = await this.pickerLabel().catch(() => ""); }
      } finally { Crawler.inRelogin = false; }
      Crawler.relogins++; Crawler.reloginFails = ok ? 0 : Crawler.reloginFails + 1;
      this.step(`${action} — session ended: signed in again (${ok ? "ok" : "FAILED"}, picker "${picker.slice(0, 30)}", ${Date.now() - t0}ms)${this.passive ? " [side]" : ""}`);
      try { process.stdout.write(JSON.stringify({ event: "relogin", action, ok, picker: picker.slice(0, 40), ms: Date.now() - t0, n: Crawler.relogins, side: this.passive }) + "\n"); } catch {}
      return ok;
    })();
    Crawler.reloginP = run; try { return await run; } finally { Crawler.reloginP = null; }
  }
  /** A wait for the suspension to lift is worth it: the queue is strictly sequential and a skipped task cannot be
   *  reopened, so skipping on through a spell burns tasks that the lifted account could answer, while waiting costs the
   *  same seconds the timeouts did. AGENT_SUSPEND_WAIT_S=0 turns it off; the budget is the whole shift (clamped to its end). */
  static readonly SUSPEND_BUDGET_MS = Number(process.env.AGENT_SUSPEND_WAIT_S ?? 600) * 1000;
  /** One reload per poll, about the request rate the timeouts made (the lock may count requests: do not hammer it). */
  static readonly SUSPEND_POLL_MS = Number(process.env.AGENT_SUSPEND_POLL_MS ?? 4000);
  static suspendWaitedMs = 0; static suspendEpisodes = 0; static shiftEndsAt = Infinity;
  /** Reload the page every SUSPEND_POLL_MS until it is no longer the suspension page (or the budget / shift is out).
   *  Returns the ms waited (0 = did not wait). */
  private async waitOutSuspension(action: string): Promise<number> {
    const left = Math.min(Crawler.SUSPEND_BUDGET_MS - Crawler.suspendWaitedMs, Crawler.shiftEndsAt - Date.now() - 10_000);
    if (!(left > 0)) return 0;
    Crawler.suspendEpisodes++;
    const s0 = Date.now(); let polls = 0, cleared = false;
    this.step(`${action} — account suspended: waiting for it to lift (reload every ${Crawler.SUSPEND_POLL_MS}-10000 ms)${this.passive ? " [side]" : ""}`);
    while (Date.now() - s0 < left) {
      await sleep(Math.min(10_000, Crawler.SUSPEND_POLL_MS * (1 + Math.floor(polls / 3)))); polls++; // 4 s, then 8 s, then 10 s: a long spell is not hammered
      await this.client.Page.reload({}).catch(() => {});
      let t = ""; for (let i = 0; i < 10 && !t; i++) { await sleep(150); t = (await this.appText().catch(() => "")) ?? ""; }
      if (t && !Crawler.isSuspended(t)) { cleared = true; break; }
    }
    const waited = Date.now() - s0; Crawler.suspendWaitedMs += waited;
    try { process.stderr.write(JSON.stringify({ event: "suspended", action, waitedMs: waited, polls, cleared, side: this.passive, totalWaitedMs: Crawler.suspendWaitedMs }) + "\n"); } catch {}
    return waited;
  }

  private async awaitMarker(marker: string | RegExp, timeoutMs: number, action: string, before = "", navigated = false, _path?: string) {
    const hit = (t: string) => (typeof marker === "string" ? t.includes(marker) : marker.test(t));
    const stale = marker !== "" && before !== "" && hit(before);
    const tStart = Date.now(); let t0 = tStart; let ok = false; let settled = false;
    let lastSig = ""; let sigAt = 0; let lastT = "";
    let relogged = false;
    while (Date.now() - t0 < timeoutMs) {
      const t = (await this.appText().catch(() => "")) ?? ""; // a mid-navigation evaluation comes back empty
      lastT = t;
      // The suspension page: wait for it to lift, then give the page that loads next its own timeout.
      // (before the marker test: claimReader's /./ marker matches the suspension page too)
      if (Crawler.isSuspended(t)) void import("./pacer.js").then((m) => m.pacer.noteSuspended()).catch(() => {}); // pacer v2: heavy extras and list reads hold back
      if (Crawler.SUSPEND_BUDGET_MS > 0 && Crawler.isSuspended(t)) { const w = await this.waitOutSuspension(action); if (w > 0) { t0 += w; continue; } }
      // The session ended (the site sent us to its sign-in form): sign in again, reset the location picker, repeat this read once.
      // (after the suspension test: a suspended account is waited out, never signed in again; before the marker test: /./ matches the form)
      if (!relogged && Crawler.looksLikeLogin(t) && (await this.onLoginForm())) {
        relogged = true; const r0 = Date.now();
        const okLogin = await this.relogin(action);
        if (okLogin && _path) { await this.markOld(); before = await this.appText().catch(() => ""); await Crawler.navGate(); await this.client.Page.navigate({ url: this.site.replace(/\/$/, "") + _path }).catch(() => {}); }
        t0 += Date.now() - r0; if (okLogin) continue;
      }
      const fresh = navigated && stale && hit(t) && t === before ? await this.isFresh() : false;
      if (markerArrived(t, before, hit, stale, fresh)) { ok = true; break; }
      // Marker-free arrival: the page's content inventory has rendered and held still (settledArrival). Only after a
      // real navigation, only once SETTLE_MIN_MS have passed, and never on the page we left (its text must differ, or the
      // document must be a new one). The marker stays the first cue; this is the second.
      if (navigated && Date.now() - t0 >= Crawler.SETTLE_MIN_MS) {
        const sig = await this.evalApp<string>(Crawler.INVENTORY_JS).catch(() => "");
        if (sig !== lastSig) { lastSig = sig; sigAt = Date.now(); }
        else if (settledArrival(sig, lastSig, Date.now() - sigAt, Date.now() - t0) && (t !== before || (await this.isFresh()))) { ok = true; settled = true; break; }
      }
      await sleep(50);
    }
    const ms = Date.now() - tStart;
    this.loadedAt = Date.now();
    { const seen = ok ? lastT : await this.appText().catch(() => ""); if (isSuspendedText(seen)) noteMiss(seen, action); else if (ok) noteArrived(); } // siteWatch.ts (log only)
    // Readable per-action trace (like the navigator's [nav] step log): every navigation is a step,
    // with how long it took and whether it got stuck (marker never arrived).
    this.step(`${action}${ok ? ` (${ms}ms${settled ? `, settled without marker "${String(marker).slice(0, 24)}"` : ""})` : ` — STUCK ${ms}ms (marker "${String(marker).slice(0, 24)}")`}${this.passive ? " [side]" : ""}`);
    if (!ok) { try { process.stderr.write(JSON.stringify({ event: "marker_miss", action, marker: String(marker).slice(0, 40), ms, side: this.passive }) + "\n"); } catch {} }
    if (settled) { try { process.stderr.write(JSON.stringify({ event: "marker_settle", action, marker: String(marker).slice(0, 40), ms, side: this.passive }) + "\n"); } catch {} }
    await this.record(action, ok, ms).catch(() => {});
    return ok;
  }

  /** Per-item step counter for the readable trace. shiftMain resets it at the start of each item via
   *  the index's beginItem(); every navigation/click/type/stall logs one `[nav] step N: …` line. */
  stepN = 0;
  resetSteps() { this.stepN = 0; }
  step(msg: string) { try { process.stderr.write(`[nav] step ${this.stepN++}: ${msg}\n`); } catch {} }
  /** Log a step and run a click expression, reporting whether anything matched. */
  trace(ev: { act: string; what?: string; value?: string; [k: string]: unknown }) {
    const { act, what, value, ...rest } = ev; const extra = Object.entries(rest).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ");
    this.step(`${act}${what ? ` "${what}"` : ""}${value !== undefined ? `=${value}` : ""}${extra ? " " + extra : ""}`);
  }

  /** One evalApp call: what this page shows, in the terms extractors depend on. */
  private fingerprint(): Promise<Fingerprint> {
    return this.evalApp<Fingerprint>(`const T=e=>(e.innerText||e.textContent||'').trim().replace(/\\s+/g,' ');
      return { title: doc.title||'', h1: T(doc.querySelector('h1,h2')||doc.body||doc.documentElement).slice(0,80),
        headers: [...doc.querySelectorAll('th')].map(T).filter(Boolean).slice(0,40),
        labels: [...doc.querySelectorAll('dt,label')].map(T).filter(Boolean).slice(0,60),
        inputs: [...doc.querySelectorAll('input,select,textarea')].map(e=>e.name||e.id||e.type).filter(Boolean).slice(0,40),
        links: [...doc.querySelectorAll('a[href]')].filter(a=>a.getAttribute('aria-hidden')!=='true'&&a.getAttribute('tabindex')!=='-1'&&!a.closest('[aria-hidden="true"]')).map(a=>({text:T(a).slice(0,60), href:a.getAttribute('href'), nav:!!a.closest('nav,aside,[role=navigation]')})).filter(l=>l.href&&l.href.startsWith('/')).slice(0,120) }`);
  }

  private async record(action: string, ok: boolean, ms: number) {
    if (this.passive) return;
    const url = await this.evalTop<string>("location.href").catch(() => "");
    const t = this.map.observe(url, await this.fingerprint(), action, ok, ms);
    const d = this.map.drift(t);
    if (d && d.now !== this.lastDriftLogged) { this.lastDriftLogged = d.now; console.error(JSON.stringify({ event: "state_drift", template: t, was: d.was, now: d.now })); }
  }
  private lastDriftLogged = "";

  /** Navigate via a link the map saw on state `from` (text or href matching `re`). */
  private async navByLink(re: RegExp, from: string, marker: string | RegExp, timeoutMs = 8000, under = false) {
    const href = this.map.linkFrom(re, from, under); if (!href) return false;
    this.map.current = from; // the link is a transition out of `from`, not out of the page that missed
    const before = await this.appText().catch(() => "");
    await this.markOld();
    await Crawler.navGate();
    await this.client.Page.navigate({ url: this.site.replace(/\/$/, "") + href });
    return this.awaitMarker(marker, timeoutMs, "link " + re.source, before, true);
  }

  /** Run an expression inside the deepest same-origin app iframe; returns its value.
   *  Set awaitPromise when the expression body returns a Promise (e.g. an async fetch). */
  async evalApp<T>(expr: string, awaitPromise = false): Promise<T> {
    const wrapped = `(function(){ function appDoc(){ let d=document; for(let i=0;i<5;i++){ const f=d.querySelector('iframe'); if(!f) break; try{ if(f.contentDocument) d=f.contentDocument; else break; }catch(e){ break; } } return d; } const doc=appDoc(); return (function(doc){ ${expr} })(doc); })()`;
    const { result } = await this.client.Runtime.evaluate({ expression: wrapped, returnByValue: true, awaitPromise });
    return result.value as T;
  }
  appText() { return this.evalApp<string>(`return (doc.body?doc.body.innerText:'')||''`); }
  /** Evaluate in the TOP document (login forms are top-level, not iframed). */
  async evalTop<T>(expr: string): Promise<T> { const { result } = await this.client.Runtime.evaluate({ expression: expr, returnByValue: true }); return result.value as T; }

  private identityFonts: Buffer[] = []; private identityFetched = false;
  /** Fetch the clinic's identity fonts (the CSS @font-face assets) once — these carry the real
   *  digit shapes (codepoint d = digit d) and serve as an EXACT reference for decoding the
   *  per-session scrambled render fonts. Stable across the session, so done once. */
  private async ensureIdentityFonts(): Promise<void> {
    if (this.identityFetched) return; this.identityFetched = true;
    const urls = await this.evalApp<string[]>(`const o=[];for(const ss of doc.styleSheets){let rs;try{rs=ss.cssRules}catch(e){continue}if(!rs)continue;for(const rule of rs){if(rule.constructor.name==='CSSFontFaceRule'){const m=rule.style.getPropertyValue('src').match(/url\\(["']?([^"')]+)/);if(m)o.push(m[1]);}}}return [...new Set(o)];`).catch(() => [] as string[]);
    for (const u of urls.slice(0, 12)) {
      const full = u.startsWith("/") ? this.site.replace(/\/$/, "") + u : u;
      const b64 = await this.evalApp<string>(`return (async()=>{try{const r=await fetch(${JSON.stringify(full)});const b=await r.arrayBuffer();const a=new Uint8Array(b);let s='';for(let i=0;i<a.length;i++)s+=String.fromCharCode(a[i]);return btoa(s);}catch(e){return ''}})()`, true).catch(() => "");
      if (b64) this.identityFonts.push(Buffer.from(b64, "base64"));
    }
  }

  /** The current page's digit de-obfuscation map (codepoint→real digit). Matches the per-session
   *  scrambled render font (captured via Network) against the clinic's identity font (exact). null
   *  when no obfuscation font is present, it wasn't captured, or the match is ambiguous → decline. */
  async currentDigitMap(): Promise<DigitMap | null> {
    if (this.pageDigitMap !== undefined) return this.pageDigitMap;
    await this.ensureIdentityFonts().catch(() => {});
    let result: DigitMap | null = null;
    // Cap the wait at ~3.5s so a single field never blows the <4s/task budget. If the scrambled
    // font hasn't been captured by then it almost never arrives; returning null → the caller
    // declines (skip), which is never-wrong. (Breaks early once all fonts are in — line below.)
    for (let i = 0; i < 35; i++) {
      const bufs: Buffer[] = [...this.identityFonts];
      const seen = new Set<string>();
      for (const u of this.recentFonts) { if (seen.has(u)) continue; seen.add(u); const b = this.fontCache.get(u); if (b) bufs.push(b); }
      const m = buildDigitMap(bufs);
      if (m) { result = m; break; }
      if (this.recentFonts.length && this.recentFonts.every((u) => this.fontCache.has(u))) break; // all captured, still nothing
      await sleep(100);
    }
    this.pageDigitMap = result; return result;
  }

  /** The current page's digit fonts: the decoding map (null when none/ambiguous) and how many of the
   *  fonts this page loaded are scrambled vs identity. `scrambled === 0 && fonts > 0` means custom-font
   *  digits on this page are drawn at their own codepoints (the raw text is what the screen shows). */
  async digitState(): Promise<{ map: DigitMap | null; fonts: number; scrambled: number }> {
    const map = await this.currentDigitMap();
    const seen = new Set<string>(); const bufs: Buffer[] = [];
    for (const u of this.recentFonts) { if (seen.has(u)) continue; seen.add(u); const b = this.fontCache.get(u); if (b) bufs.push(b); }
    const k = fontKinds(bufs);
    return { map, fonts: k.identity + k.scrambled, scrambled: k.scrambled };
  }

  /** Per font FAMILY of the current page: "identity" (digits drawn at their own codepoints), the exact
   *  codepoint→digit map of a scrambled family (matched against the clinic's identity font), or null
   *  (family not found in the page's @font-face rules, font not fetchable, or no exact reference). */
  async familyDigitMaps(families: string[]): Promise<Record<string, DigitMap | "identity" | null>> {
    const out: Record<string, DigitMap | "identity" | null> = {};
    if (!families.length) return out;
    await this.ensureIdentityFonts().catch(() => {});
    const rules = await this.evalApp<Array<{ family: string; url: string }>>(`const o=[];for(const ss of doc.styleSheets){let rs;try{rs=ss.cssRules}catch(e){continue}if(!rs)continue;for(const rule of rs){if(rule.constructor.name==='CSSFontFaceRule'){const fam=(rule.style.getPropertyValue('font-family')||'').replace(/["']/g,'').trim();const m=(rule.style.getPropertyValue('src')||'').match(/url\\(["']?([^"')]+)/);if(fam&&m)o.push({family:fam,url:m[1]});}}}return o;`).catch(() => [] as Array<{ family: string; url: string }>);
    const refs = this.identityFonts.filter((b) => fontKinds([b]).identity === 1);
    for (const fam of families) {
      const urls = [...new Set((rules || []).filter((r) => r.family === fam).map((r) => r.url))];
      if (urls.length !== 1) { out[fam] = null; continue; }
      const buf = await this.fontBytes(urls[0]).catch(() => null);
      if (!buf) { out[fam] = null; continue; }
      const k = fontKinds([buf]);
      out[fam] = k.identity === 1 ? "identity" : k.scrambled === 1 && refs.length ? buildDigitMap([...refs, buf]) : null;
    }
    return out;
  }
  /** A font file's bytes: from the network capture, a data: URL, or fetched inside the page. */
  private async fontBytes(url: string): Promise<Buffer | null> {
    if (url.startsWith("data:")) { const m = url.match(/^data:[^,]*?(;base64)?,(.*)$/); return m ? Buffer.from(decodeURIComponent(m[2]), m[1] ? "base64" : "utf8") : null; }
    const full = url.startsWith("/") ? this.site.replace(/\/$/, "") + url : url;
    for (const [k, b] of this.fontCache) if (k === full || k.endsWith(url)) return b;
    const b64 = await this.evalApp<string>(`return (async()=>{try{const r=await fetch(${JSON.stringify(full)});const b=await r.arrayBuffer();const a=new Uint8Array(b);let s='';for(let i=0;i<a.length;i++)s+=String.fromCharCode(a[i]);return btoa(s);}catch(e){return ''}})()`, true).catch(() => "");
    if (!b64) return null;
    const buf = Buffer.from(b64, "base64"); this.fontCache.set(full, buf); return buf;
  }

  /** Read a demographics field's value + whether it's rendered in a custom (obfuscation) font. */
  private async fieldDom(label: string): Promise<{ val: string; custom: boolean } | null> {
    return this.evalApp(`const dt=[...doc.querySelectorAll('dt')].find(x=>new RegExp('^\\\\s*'+${JSON.stringify(label)}+'\\\\s*$').test(x.textContent||'')); const d=dt&&dt.nextElementSibling; if(!d) return null; const leaf=d.querySelector('*')||d; const fam=(getComputedStyle(leaf).fontFamily||'').split(',')[0].replace(/["']/g,'').trim(); const custom=!/^(Atkinson|ui-|system-ui|monospace|sans-serif|serif)/i.test(fam); return {val:(d.textContent||'').trim(), custom};`);
  }

  /** Decode a value that may be in the obfuscation font: custom font → apply the page's digit map
   *  (or return undefined if it can't be decoded — never emit the scrambled codepoints). */
  private async decodeField(f: { val: string; custom: boolean } | null): Promise<string | undefined> {
    if (!f || !f.val) return undefined;
    if (!f.custom) return Crawler.unmask(f.val);
    const map = await this.currentDigitMap();
    return map ? Crawler.unmask(applyDigitMap(f.val, map)) : undefined; // obfuscated + undecodable → decline
  }

  /** Sign in at $SITE_URL/login with the agent's credentials (session is a cookie, persisted in
   *  the Chrome profile). No-op on a no-auth clinic (e.g. the public practice browse host), where
   *  no password field appears. Per the Agent Interface, the sign-in form is served at /login. */
  async login(user?: string, pass?: string): Promise<boolean> {
    const base = this.site.replace(/\/$/, "");
    if (user && pass) Crawler.creds = { user, pass };
    const hasPwd = () => this.evalTop<boolean>(`!!document.querySelector('input[type=password]')`).catch(() => false);
    await this.client.Page.navigate({ url: `${base}/login` });
    // wait for the sign-in form to render; if creds are provided we expect one, so wait longer
    let needs = false;
    const tries = user && pass ? 40 : 10; // ~6s vs ~1.5s
    for (let i = 0; i < tries && !needs; i++) { await sleep(150); needs = await hasPwd(); }
    if (!needs) { // no form at /login → confirm via "/" (no-auth clinic or already signed in)
      await this.client.Page.navigate({ url: `${base}/` }); await sleep(600);
      if (!(await hasPwd())) return true;
      needs = true;
    }
    if (!user || !pass) return false;
    await this.evalTop(`(function(){
      const setV=(el,v)=>{ if(!el) return; const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; d.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); };
      const pwd=document.querySelector('input[type=password]');
      const usr=document.querySelector('input[type=text],input[type=email],input[name*=user i],input[name*=email i],input[autocomplete=username]')||document.querySelector('input:not([type=password]):not([type=hidden])');
      setV(usr, ${JSON.stringify(user)}); setV(pwd, ${JSON.stringify(pass)});
      const btn=document.querySelector('button[type=submit],input[type=submit],button');
      if(btn) btn.click(); else { const f=pwd.closest('form'); if(f){ f.requestSubmit?f.requestSubmit():f.submit(); } }
    })()`);
    const t0 = Date.now(); // success = the password field is gone
    while (Date.now() - t0 < 12000) { if (!(await hasPwd())) return true; await sleep(250); }
    return false;
  }

  /** Fast: the FULL provider roster (stripped name → id) from the detail-page <select>. ~1s, one-time. */
  async fetchProviderRoster(): Promise<Array<{ name: string; id: string }>> {
    // fetchToday just loaded the schedule (the app rewrites it to /schedule?date=…): read it in place.
    // Re-navigating re-renders identical text, and a Set 1 clinic shows no "Provider" word here: 12 s lost.
    const here = await this.evalTop<string>("location.pathname").catch(() => "");
    if (here !== "/schedule") await this.navTo("/schedule", /Provider|Today/, 6000);
    const first = await this.evalApp<string>(`const a=doc.querySelector('a[href^="/schedule/providers/"]'); return a?a.getAttribute('href').split('?')[0]:''`);
    const read = () => this.evalApp<Array<{ name: string; id: string }>>(`const s=doc.querySelector('select[name=provider]')||doc.querySelector('select'); return s?[...s.options].map(o=>({name:o.text.trim(), id:o.value})).filter(o=>o.id&&/[A-Za-z]/.test(o.text)):[]`);
    let roster: Array<{ name: string; id: string }> = [];
    if (first) { await this.navTo(first, "Provider", 6000); await sleep(300); roster = await read(); }
    // A clinic whose schedule page carries no provider link still has the roster in the appointment
    // list's filter form (select name=provider). Scored Set 1 read 0 providers without this.
    if (!roster.length) { await this.navTo("/schedule/appointments", "", 6000); for (let i = 0; i < 20; i++) { if (await this.evalApp<boolean>(`return !!doc.querySelector('select[name=provider]')`)) break; await sleep(100); } roster = await read(); }
    return roster.map((r) => ({ name: Crawler.stripTitle(r.name), id: r.id }));
  }

  /** Read one provider's specialty from their detail page (lazy, on-demand). */
  async fetchProviderSpecialty(id: string): Promise<string | undefined> {
    await this.navTo(`/schedule/providers/${id}`, "Provider", 6000); await sleep(120);
    const t = await this.appText();
    const sp = t.match(/\n\s*([A-ZÀ-Þ][A-Za-zÀ-ÿ ]+?)\s*·\s*(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/);
    return sp ? sp[1].trim() : undefined;
  }

  // ── extraction ──
  /** A date of birth in any common display form → YYYY-MM-DD (MM/DD/YYYY, YYYY-MM-DD, "Mar 21, 1952", "March 21, 1952"). */
  static normDob(s: string): string | undefined {
    let m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    m = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    return Crawler.monthDateFull(s);
  }

  /**
   * Set the top-bar location filter to "All locations" (a <details>/<summary> in the top frame).
   * CRITICAL: the patient search is scoped to the current location and defaults to a single one,
   * so without this it silently misses every patient at another location. The choice persists for
   * the session, so this is called once at warm-up.
   */
  /** The session's location picker label (top frame), "" when no picker is on the page. */
  async pickerLabel(): Promise<string> {
    return (await this.evalTop<string>(`(([...document.querySelectorAll('summary')].find(e=>/Location/i.test(e.textContent||''))||{}).textContent||'').trim()`).catch(() => "")) || "";
  }
  /** Guard before every patient search, provider-day read and appointment-list read: the session's location
   *  picker must say All locations. A picker left on one location makes other locations' rows vanish, which a
   *  reader would take as a complete empty read ("0", "no such patient") — a wrong answer. One repair attempt;
   *  false → the caller declines. No picker on the page (another app version) → true (nothing to check). */
  allLocationsOk = true;
  async ensureAllLocations(): Promise<boolean> {
    let label = await this.pickerLabel();
    if (!label || /all locations/i.test(label)) return true;
    for (let i = 0; i < 2 && !/all locations/i.test(label); i++) { await this.setAllLocations().catch(() => {}); label = await this.pickerLabel(); }
    this.allLocationsOk = !label || /all locations/i.test(label);
    try { process.stdout.write(JSON.stringify({ event: "crawl", step: "locations-guard", label: label.slice(0, 60), ok: this.allLocationsOk }) + "\n"); } catch {}
    return this.allLocationsOk;
  }

  async setAllLocations(): Promise<void> {
    await this.navTo("/patients", "last name", 7000);
    const already = await this.evalTop<boolean>(`!!([...document.querySelectorAll('summary')].find(e=>/Location/i.test(e.textContent||'')&&/All locations/i.test(e.textContent||'')))`).catch(() => false);
    if (already) return;
    await this.evalTop(`(function(){const s=[...document.querySelectorAll('summary')].find(e=>/Location/i.test(e.textContent||''));if(s)s.click();})()`);
    await sleep(300);
    await this.evalTop(`(function(){const it=[...document.querySelectorAll('[role=option],[role=menuitem],li,button,a')].find(e=>/^\\s*All locations\\s*$/i.test(e.textContent||''));if(it)it.click();})()`);
    await sleep(400);
    await this.record("select All locations", true, 400).catch(() => {});
    // verify: a click that didn't take (slow host, menu not open yet) leaves the session on one location
    for (let i = 0; i < 10; i++) { if (/all locations/i.test(await this.pickerLabel())) return; await sleep(200); }
    throw new Error(`location picker still "${(await this.pickerLabel()).slice(0, 40)}" after selecting All locations`);
  }

  /** Cues that a patient results table has rendered (any clinic: MRN column or not). */
  static readonly RESULTS = /MRN|Patients found|Results|Date of birth|No patients/;
  /** Parse the patient rows of the current results table, dropping the "Restricted chart
   *  requests" widget rows (which also link to /patients/ but carry a reason, not an MRN/DOB). */
  /** Raw rows of the last results read, and the page text when none were found (diagnostics only). */
  lastRows: string[] = []; lastEmptyText = "";
  private async readPatientRows(): Promise<PatientRow[]> {
    const rows = await this.evalApp<any[]>(PATIENT_ROWS_JS);
    this.lastRows = rows.slice(0, 5).map((r: any) => String(r.row).slice(0, 200));
    this.lastEmptyText = rows.length ? "" : (await this.appText().catch(() => "")).slice(0, 400);
    return parsePatientRows(rows);
  }

  /** Search by last name (via the URL query the SPA reads). Requires setAllLocations() first.
   *  Note: results paginate 25/page; this reads page 1 — prefer searchByDob when a DOB is known. */
  async searchPatients(lastName: string): Promise<PatientRow[]> {
    if (!(await this.ensureAllLocations())) return [];
    await this.navTo(`/patients?lastName=${encodeURIComponent(lastName)}`, Crawler.RESULTS, 12000, true); // fresh: a walk left page N / 100 rows
    return this.readPatientRows();
  }

  /** Last-name search read across pages until the list is proven read far enough for a name-only
   *  resolution: `complete` when the last row read sorts past the asked name (`isPast`), or the pager
   *  shows the end ("Showing a to b of N" with b ≥ N, "Page x of y" with x ≥ y, a disabled Next).
   *  Pager controls are found by their text / aria-label, never by class or position. */
  async searchPatientsPaged(lastName: string, isPast: (rowName: string) => boolean, maxPages = Number(process.env.AGENT_SEARCH_MAX_PAGES ?? 30)): Promise<{ rows: PatientRow[]; complete: boolean; pages: number }> {
    if (!(await this.ensureAllLocations())) return { rows: [], complete: false, pages: 0 };
    // Proof of completeness: every page continues the one before ("Showing a to b": a = previous b + 1) and the
    // walk ends past the name (the list is sorted) or at an exact total. The practice app drops a page's session
    // a few seconds after it loads; a click after that reloads the app on page 1 with 25 rows. That shows up as a
    // "restart" and the walk starts over on a fresh load (at most twice); any other jump is never trusted.
    const pagerState = async () => this.evalApp<{ footer: string; next: "enabled" | "disabled" | "none"; first: string; empty: boolean; count: number; busy: boolean }>(`
      const txt=(doc.body&&doc.body.innerText)||'';
      const f=(txt.match(/Showing\\s+\\d+\\s*(?:to|-|–)\\s*\\d+\\s+of\\s+(?:about\\s+)?[\\d,]+\\+?[^\\n]*/i)||txt.match(/Page\\s+\\d+\\s+of\\s+\\d+/i)||[''])[0];
      const isNext=(x)=>{const t=((x.getAttribute('aria-label')||'')+' '+(x.textContent||'')).trim().toLowerCase(); return /^(next|next page|go to next page|›|»|→|>)$/.test(t)||/^next\\b/.test(t)||/\\bnext page\\b/.test(t)||/^(load|show) more\\b/.test(t);};
      const c=[...doc.querySelectorAll('button,a,[role=button]')].filter(x=>!x.closest('[aria-hidden="true"]')).filter(isNext);
      const en=c.find(x=>!x.disabled&&x.getAttribute('aria-disabled')!=='true'&&!/disabled/i.test(x.getAttribute('class')||''));
      const a=doc.querySelector('a[href^="/patients/"]');
      const cm=txt.match(/(?:^|\\n)\\s*([\\d,]+)\\s+patients?\\s*(?:\\n|$)/i);
      return {footer:f, next: en?'enabled':(c.length?'disabled':'none'), first: a?a.getAttribute('href'):'', empty:/No more results/i.test(txt), count: cm?Number(cm[1].replace(/,/g,'')):-1, busy:/\\bis busy\\b|fewer rows than usual|open it again/i.test(txt)};`).catch(() => ({ footer: "", next: "none" as const, first: "", empty: false, count: -1, busy: false }));
    // The end of the list is proven by listFooter.isComplete over the page's footer ("Showing a to b of N" / "Page x of y",
    // or the whole list's own "96 patients" count): an exact total the rows read reach, nothing more offered. An "about N"
    // / "N+" footer, an empty "No more results" page past a cap, or a disabled Next with no count prove nothing.
    const footerOf = (s: { footer: string; count: number }) => listFooter(s.footer) ?? (s.count > 0 ? listFooter(`${s.count} patients`) : null);
    const ended = (s: { footer: string; next: "enabled" | "disabled" | "none"; empty?: boolean; count: number }, rowsRead: number) =>
      isComplete(rowsRead, footerOf(s), { next: s.next, empty: s.empty }).complete;
    const clickNext = () => this.evalApp<boolean>(`const isNext=(x)=>{const t=((x.getAttribute('aria-label')||'')+' '+(x.textContent||'')).trim().toLowerCase(); return /^(next|next page|go to next page|›|»|→|>)$/.test(t)||/^next\\b/.test(t)||/\\bnext page\\b/.test(t)||/^(load|show) more\\b/.test(t);}; const b=[...doc.querySelectorAll('button,a,[role=button]')].filter(x=>!x.closest('[aria-hidden="true"]')).filter(isNext).find(x=>!x.disabled&&x.getAttribute('aria-disabled')!=='true'); if(b){b.click();return true;} return false;`).catch(() => false);
    // "Rows per page" raised to its largest option (a view setting, found by its label): 4x fewer clicks, so a
    // long walk fits the session's short life. No such control → the walk goes on at the list's own size.
    const raisePageSize = async (): Promise<boolean> => {
      const r = await this.evalApp<string>(`const T=e=>((e&&e.textContent)||'').replace(/\\s+/g,' ').trim();
        const s=[...doc.querySelectorAll('select')].filter(x=>!x.closest('[aria-hidden="true"]')&&!x.closest('form')).find(x=>{ const l=x.closest('label')||(x.id?doc.querySelector('label[for="'+x.id+'"]'):null); return /per page|rows|page size/i.test(T(l)+' '+(x.getAttribute('aria-label')||'')) && x.options.length>1 && [...x.options].every(o=>/\\d/.test(o.text)); });
        if(!s) return ''; const opts=[...s.options].map(o=>({v:o.value,n:Number((o.text.match(/\\d+/)||['0'])[0])})).sort((a,b)=>b.n-a.n);
        if(!opts.length||opts[0].v===s.value) return ''; s.value=opts[0].v; s.dispatchEvent(new Event('change',{bubbles:true})); return String(opts[0].n);`).catch(() => "");
      if (!r) return false;
      this.trace({ act: "select", what: "Rows per page", value: r });
      // settled: a bigger first page ("Showing 1 to 100 of N"), or the whole list on one page ("96 patients", no pager)
      for (let i = 0; i < 40; i++) { await sleep(100); const st = await pagerState(); const g = NR.pageRange(st.footer); if ((g && g.a === 1 && g.b > 25) || (!g && st.count > 25 && st.next === "none")) return true; }
      return false;
    };
    const past = (rs: PatientRow[]) => rs.length > 0 && isPast(rs[rs.length - 1].name);
    let all: PatientRow[] = []; let pages = 0; let complete = false;
    let busyHit = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) { this.trace({ act: "retry", what: busyHit ? "patient search (the site was busy)" : "patient search (the list restarted)", attempt, waitMs: await paceList() }); await this.navTo("/schedule", "", 4000).catch(() => false); }
      busyHit = false;
      await paceList(); // the site's list-request budget (siteBudget): the search is a list request like a Show-more press
      const tLoad = Date.now();
      let rows = await this.searchPatients(lastName);
      noteLoad(Date.now() - tLoad);
      let st = await pagerState();
      // Run s3a item 186: the "Cole" search answered 55 rows in 3 pages where run 265 saw 117 — the site's degraded "busy … fewer rows
      // than usual" list (the read came right after a 20-request context read). A busy page's rows are never kept: the walk starts
      // again on a fresh load once the governor says the budget is back.
      if (st.busy) { noteBusyPage(); busyHit = true; this.trace({ act: "busy", what: "patient search", page: 1 }); continue; }
      if (!past(rows) && !ended(st, rows.length) && st.next === "enabled" && (await raisePageSize())) { rows = await this.readPatientRows(); st = await pagerState(); }
      const got: PatientRow[] = [...rows]; let n = 1; let restarted = false, unproven = false;
      while (!past(rows) && !ended(st, got.length) && st.next === "enabled" && n < maxPages) {
        const before = st;
        await paceList();
        const tClick = Date.now();
        const clicked = await clickNext();
        this.trace({ act: "click", what: "Next (patient search)", page: n, hit: clicked });
        if (!clicked) break;
        let moved = false;
        for (let i = 0; i < 50; i++) { await sleep(100); const s2 = await pagerState(); if ((s2.first && s2.first !== before.first) || (s2.footer && s2.footer !== before.footer) || s2.empty) { moved = true; break; } }
        if (!moved) break;
        await sleep(80);
        rows = await this.readPatientRows(); st = await pagerState(); n++;
        noteLat(Date.now() - tClick);
        if (st.busy) { noteBusyPage(); busyHit = true; this.trace({ act: "busy", what: "patient search", page: n }); break; }
        const step = NR.pageStep(NR.pageRange(before.footer), NR.pageRange(st.footer));
        if (step === "restart") { restarted = true; break; }
        // a range that doesn't continue the last one (skipped / repeated rows, or an empty capped page): stop unproven
        if (step === "gap" || (step === "unknown" && NR.pageRange(before.footer))) { unproven = true; break; }
        got.push(...rows);
      }
      pages += n;
      if (busyHit) { if (attempt < 2) continue; all = all.concat(got); complete = past(got); break; } // a busy page mid-walk: rows before it are sound, the walk is not complete
      all = all.concat(got);
      // An empty "No more results" page after a capped list has a disabled Next: that is NOT the end of the list.
      complete = past(got) || (!restarted && !unproven && ended(st, got.length));
      if (!restarted) break;
    }
    return { rows: all, complete, pages };
  }

  /** Search by exact date of birth (drives the form's date input). Returns the few patients with
   *  that DOB across all locations — the reliable way to resolve a named patient. */
  /** Run a typed-form read; when it failed and an account-suspension spell was waited out during it, the submitted form
   *  was lost with the reload — run it once more on the lifted account. */
  private async againAfterSuspension<T>(run: () => Promise<T>, failed: (r: T) => boolean): Promise<T> {
    const e0 = Crawler.suspendEpisodes; const r = await run();
    return failed(r) && Crawler.suspendEpisodes !== e0 ? run() : r;
  }
  async searchByDob(dobISO: string): Promise<PatientRow[]> { return this.againAfterSuspension(() => this.searchByDobOnce(dobISO), (r) => r.length === 0); }
  private async searchByDobOnce(dobISO: string): Promise<PatientRow[]> {
    await this.navTo("/patients", "last name", 7000);
    if (!(await this.ensureAllLocations())) return [];
    for (let i = 0; i < 20; i++) { if (await this.evalApp<boolean>(`return !!doc.querySelector('input[name=dob],input[type=date]')`).catch(() => false)) break; await sleep(100); } // the form must exist before it is filled (a slow host renders the hint first)
    const before = await this.appText().catch(() => ""); // the form page; results must change it
    await this.evalApp(`
      const el=doc.querySelector('input[name=dob],input[type=date]');
      if(el){ const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; d.call(el, ${JSON.stringify(dobISO)});
        el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
        const b=[...doc.querySelectorAll('button')].find(x=>/search/i.test(x.textContent||'')); if(b) b.click(); }
      return true;`);
    this.trace({ act: "type", what: "Date of birth", value: dobISO }); this.trace({ act: "submit", what: "patient search" });
    await this.awaitMarker(Crawler.RESULTS, 4000, "search dob", before); // await results
    return this.readPatientRows();
  }

  /** The current page's visible text, with obfuscated numeric values (custom-font) decoded via the
   *  page's digit map — so any field (not just phone) is readable. Generalizes the de-obfuscation. */
  async decodedText(): Promise<string> {
    const text = await this.appText();
    const map = await this.currentDigitMap();
    if (!map) return text;
    const pairs = await this.evalApp<string[][]>(`
      const map=${JSON.stringify(map)};
      const isCustom=(el)=>{const f=(getComputedStyle(el).fontFamily||'').split(',')[0].replace(/["']/g,'').trim();return !/^(Atkinson|ui-|system-ui|monospace|sans-serif|serif)/i.test(f);};
      const out=[]; for (const el of doc.querySelectorAll('*')){ if(el.children.length===0){ const raw=(el.textContent||'').trim(); if(raw&&/[0-9]/.test(raw)&&isCustom(el)) out.push([raw, raw.replace(/[0-9]/g,c=>map[c]??c)]); } }
      return out;`).catch(() => [] as string[][]);
    let t = text; for (const [raw, dec] of pairs) if (raw !== dec) t = t.split(raw).join(dec);
    return t;
  }

  /** Read several chart tabs of a patient as decoded text (for the generalist fallback). Robust to
   *  layout: discovers which of the requested tabs exist and concatenates them, capped in size. */
  async fetchTabsText(href: string, suffixes: string[], cap = 7000, marker: string | RegExp = "MRN"): Promise<string> {
    let out = "";
    for (const s of suffixes) {
      const ok = await this.navTo(href + s, marker, 5000); if (!ok) continue;
      await sleep(120);
      out += `\n== ${s || "/demographics"} ==\n` + (await this.decodedText());
      if (out.length > cap) break;
    }
    return out.slice(0, cap);
  }

  /** Chart tabs the question points to, from the site map: whatever tabs this clinic's chart really
   *  links to (Insurance, Problems, Vitals, …), matched by tab label or a synonym. Falls back to the
   *  known three until a chart has been seen. Visiting a tab records it, so the map's frontier
   *  shrinks as the generalist explores. Appointments/documents are already in the structured record. */
  chartTabs(question: string): string[] {
    const nm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const q = nm(question);
    const syn: Array<[RegExp, string]> = [[/problem|diagnos|condition|chronic|allerg/i, "problems"], [/insuranc|coverage|payer|policy|member|plan|group/i, "insurance"], [/\bnote|summary|assessment\b/i, "notes"], [/activit|audit|who (viewed|opened|accessed)|last (viewed|opened)/i, "activity"]];
    const tabs = this.map.subpages("/patients/{id}").filter((t) => !/^\/(appointments|documents|demographics)$/.test(t.suffix));
    if (!tabs.length) return syn.filter(([re]) => re.test(question)).map(([, l]) => "/" + l);
    return tabs.filter((t) => { const l = nm(t.label); return (l.length > 3 && q.includes(l)) || q.includes(nm(t.suffix)) || syn.some(([re, s]) => re.test(question) && (nm(s) === l || "/" + s === t.suffix)); }).map((t) => t.suffix);
  }

  /** Section generalist: discover the clinic's sidebar nav, pick the section(s) the question points
   *  to (or the dashboard for today/this-week aggregates), and return their decoded text. Adapts to
   *  whatever sidebar a clinic has (Billing, Claims, Payers, Recalls, …), not a fixed set. */
  private navCache?: Array<{ label: string; href: string }>;
  async gatherSections(question: string): Promise<string> {
    // Discover the sidebar ONCE per session (it's stable) — this is the real saving. Each target
    // is still navigated + settled below (don't reuse the discovery page: navTo returns on the
    // stale DOM when we were already on the dashboard, so the page may be mid-reload here).
    if (!this.navCache) {
      // The nav comes from the site map: every page's links are fingerprinted on arrival, so any
      // state already visited this session (not only "/") contributes, and nothing is re-read.
      try {
        if (!this.map.states.has("/")) { await this.navTo("/", "", 7000); for (let i = 0; i < 20; i++) { if ((await this.appText()).length > 200) break; await sleep(100); } await this.record("settle /", true, 0); }
        const seen = new Set<string>(); this.navCache = [];
        for (const st of [this.map.states.get("/"), ...this.map.states.values()]) for (const l of st?.fp.links ?? []) {
          const href = l.href.split("?")[0];
          // Sections live in the site's navigation and read like section names; a patient's name on
          // the dashboard or a chart tab is not a section a question should route to.
          if (!l.nav || /^\d|[,:]/.test(l.text) || /^\/patients\/[^/?]+/.test(href)) continue;
          if (l.text && l.text.length < 24 && !seen.has(href)) { seen.add(href); this.navCache.push({ label: l.text, href }); }
        }
      } catch { this.navCache = []; }
    }
    const nav = this.navCache || [];
    const nm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const q = nm(question); const targets = new Set<string>();
    if (/\btoday\b|this week|this month|open slot|seen today|issued|received|new patient/i.test(question)) targets.add("/"); // dashboard aggregates
    for (const n of nav) if (nm(n.label).length > 3 && q.includes(nm(n.label))) targets.add(n.href); // direct sidebar-label match
    const syn: Array<[RegExp, string]> = [[/invoice|\bbill|charge|statement/i, "billing"], [/\bclaim/i, "claims"], [/payer/i, "payers"], [/slot|schedule|appointment/i, "schedule"], [/recall/i, "recalls"], [/vaccin|immuniz/i, "vaccines"], [/\breport/i, "reports"], [/document|letter|referral/i, "documents"], [/encounter/i, "encounters"], [/inbox|message/i, "inbox"], [/to-?do|task/i, "to-dos"], [/staff|employee/i, "staff"], [/activit/i, "activity"]];
    for (const [re, label] of syn) if (re.test(question)) { const n = nav.find((x) => nm(x.label) === nm(label)); if (n) targets.add(n.href); }
    if (!targets.size) targets.add("/");
    let out = "";
    for (const t of [...targets].slice(0, 2)) {
      try {
        await this.navTo(t, "", 6000);
        for (let i = 0; i < 20; i++) { if ((await this.appText()).length > 200) break; await sleep(100); }
        out += `\n== ${t} ==\n` + (await this.decodedText());
      } catch {}
      if (out.length > 8000) break;
    }
    return out.slice(0, 9000);
  }

  /** Read a label→value field from the detail text (value is on the next line). */
  private static field(text: string, label: string, lines = 1): string | undefined {
    const ls = text.split("\n").map((s) => s.trim());
    const i = ls.indexOf(label);
    if (i < 0) return undefined;
    return ls.slice(i + 1, i + 1 + lines).filter(Boolean).join(", ") || undefined;
  }

  /** A masked/redacted value (bullets, asterisks) is not a real value → treat as unknown. */
  private static unmask(v?: string): string | undefined { return v && /[•·*✱●∙]/.test(v) ? undefined : v; }

  /** A chart is restricted (the "break the glass" gate) if it shows the reason-for-access form. */
  private static isGated(text: string): boolean { return /chart is restricted|Give a reason to open it/i.test(text); }

  /** Break the glass on an access-gated chart: select a care reason in the <select name=reason>
   *  and submit "Request access" to unlock it (user-authorized). Returns true once the gate clears
   *  (real chart loaded), false otherwise → the caller reads nothing and declines (never-wrong). */
  /** How the patient whose chart is being read was resolved (set per task by index-builder's ensurePatient,
   *  reset by beginItem). glassPolicy.mayBreakGlass decides from it whether a gate may be unlocked. */
  glassVia: ResolvedVia = null;
  /** Is the current page the restricted-chart gate? */
  async gatedNow(): Promise<boolean> { return Crawler.isGated(await this.appText().catch(() => "")); }
  async breakGlass(): Promise<boolean> {
    if (!Crawler.isGated(await this.appText())) return true; // not gated
    if (!mayBreakGlass(this.glassVia)) { this.trace({ act: "skip", what: "Request access", note: `break the glass refused by policy ${breakGlassPolicy()} (patient via ${this.glassVia ?? "none"})` }); return false; }
    this.trace({ act: "click", what: "Request access", note: "break the glass" });
    await this.evalApp(`(function(){
      const sel=doc.querySelector('select#reason,select[name=reason]');
      if(sel){ const opt=[...sel.options].find(o=>o.value&&o.value!=='other'&&/care|treatment|provid/i.test(o.text+' '+o.value))||[...sel.options].find(o=>o.value&&o.value!=='other');
        if(opt){ const d=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set; d.call(sel,opt.value); sel.dispatchEvent(new Event('input',{bubbles:true})); sel.dispatchEvent(new Event('change',{bubbles:true})); } }
      const btn=[...doc.querySelectorAll('button')].find(b=>/request access/i.test(b.textContent||''))||doc.querySelector('button[type=submit]'); if(btn) btn.click();
    })()`).catch(() => {});
    const t0 = Date.now(); // unlocking reloads the chart → force a fresh digit map for the new page
    while (Date.now() - t0 < 4000) { await sleep(150); if (!Crawler.isGated(await this.appText())) { this.pageDigitMap = undefined; return true; } }
    return false;
  }

  /** Navigate to a chart tab, transparently breaking the glass if it's access-gated. The gate shows
   *  the chart name/MRN but not the tab content, so we wait on EITHER the real marker OR the gate,
   *  then unlock and re-load the tab. Access "ends after a short time", so a reader that hops tabs
   *  can re-gate even after ensurePatient unlocked the root — hence every chart-tab read goes through
   *  here. Returns false (→ caller declines, never-wrong) if the tab never loads or the unlock fails.
   *  (baseline, . Not used by the live readers, which use familyReaders.chartTab; both unlock only
   *  through breakGlass, so AGENT_BREAK_GLASS governs either.) */
  /** `marker` or the restricted-chart gate, as one arrival cue. */
  static orGate(marker: string | RegExp): RegExp {
    const mSrc = typeof marker === "string" ? marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : marker.source;
    return new RegExp(`(?:${mSrc})|(?:chart is restricted|Give a reason to open it)`, typeof marker === "string" ? "" : marker.flags.replace("g", ""));
  }
  async openChart(path: string, marker: string | RegExp, timeoutMs = 8000): Promise<boolean> {
    if (!(await this.navTo(path, Crawler.orGate(marker), timeoutMs).catch(() => false))) return false;
    if (!Crawler.isGated(await this.appText())) return true;
    if (!(await this.breakGlass().catch(() => false))) return false; // unlock failed → decline
    return this.navTo(path, marker, timeoutMs).catch(() => false);    // reload the actual tab now it's open
  }

  /** `phone: false` skips the phone read (the digit-font wait is most of a chart open; a task that never reads the phone skips it);
  *  `phone` then comes back undefined, never a guess. A boolean 3rd argument is the older form of the same switch. */
  async fetchDemographics(href: string, marker: string | RegExp = "MRN", opts: { phone?: boolean } | boolean = {}) {
    const withPhone = typeof opts === "boolean" ? opts : opts.phone !== false;
    // The restricted-chart gate shows neither the patient's name nor the chart: arrival is the marker OR the
    // gate (Set 1's gate page: "This chart is restricted" + MRN only; waiting on the name alone cost 8 s per
    // restricted chart in the Set 1 replica run). Then unlock (policy permitting) and read.
    await this.navTo(href, Crawler.orGate(marker), 8000);
    if (Crawler.isGated(await this.appText())) await this.breakGlass().catch(() => false);
    const t = await this.appText();
    const f = (l: string, n = 1) => Crawler.unmask(Crawler.field(t, l, n));
    // Phone is rendered in the per-session obfuscation font → read it from the DOM and decode
    // via the font map (returns undefined if it can't be decoded, rather than scrambled digits).
    const phone = withPhone ? await this.decodeField(await this.fieldDom("Phone")).catch(() => undefined) : undefined;
    return { mrn: f("MRN"), dob: Crawler.normDob(f("Date of birth") || ""), sex: f("Sex"), phone, email: f("Email"), address: f("Address", 2), provider: f("Primary provider"), location: f("Home location") };
  }

  private static readonly MON: Record<string, string> = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
  private static monthDate(s: string): string | undefined { const m = s.match(/([A-Z][a-z]{2}) (\d{1,2}), (\d{4})/); return m && Crawler.MON[m[1]] ? `${m[3]}-${Crawler.MON[m[1]]}-${m[2].padStart(2, "0")}` : undefined; }
  static stripTitle(p: string) { return p.replace(/,?\s*(MD|DO|PA-C|PA|NP|RN|CNM|CRNA|PhD|PsyD)\.?$/i, "").trim(); }

  /** The clinic's current date (YYYY-MM-DD), from the schedule's "Today" header. Set at warm-up;
   *  used to give each generated recurring occurrence the status its date has (past=Completed). */
  today = "";
  /** Parse "October 15, 2026" or "Oct 15, 2026" (full or abbreviated month) → YYYY-MM-DD. */
  private static monthDateFull(s: string): string | undefined {
    const m = s.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/);
    if (!m) return undefined;
    const mo = Crawler.MON[m[1].slice(0, 1).toUpperCase() + m[1].slice(1, 3).toLowerCase()];
    return mo ? `${m[3]}-${mo}-${m[2].padStart(2, "0")}` : undefined;
  }
  async fetchToday(): Promise<string> {
    await this.navTo("/schedule", "Today", 7000);
    const t = await this.appText();
    const m = t.match(/Today\s*\n\s*(?:[A-Za-z]+,\s*)?([A-Za-z]+ \d{1,2},? \d{4})/) || t.match(/([A-Za-z]+ \d{1,2},? \d{4})/);
    this.today = (m && Crawler.monthDateFull(m[1])) || "";
    return this.today;
  }

  private static readonly WD: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
  /** Expand a recurring series' cadence + date range into the individual occurrence dates. */
  static recurDates(cadence: string, startISO: string, endISO: string): string[] {
    const out: string[] = []; const DAY = 86400000;
    const su = (iso: string) => { const [y, mo, d] = iso.split("-").map(Number); return Date.UTC(y, mo - 1, d); };
    const iso = (u: number) => new Date(u).toISOString().slice(0, 10);
    const s = su(startISO), e = su(endISO); const c = cadence.toLowerCase();
    const wk = c.match(/(?:(\d+)\s+weeks?|\bweek)\s+on\s+(\w+)/);
    const monthM = c.match(/month\s+on\s+the\s+(\d+)/);
    if (wk) {
      const step = (wk[1] ? Number(wk[1]) : 1) * 7 * DAY; const wd = Crawler.WD[wk[2]];
      if (wd === undefined) return out;
      let u = s; while (new Date(u).getUTCDay() !== wd && u <= e) u += DAY;
      for (; u <= e; u += step) out.push(iso(u));
    } else if (/weekday/.test(c)) {
      for (let u = s; u <= e; u += DAY) { const d = new Date(u).getUTCDay(); if (d >= 1 && d <= 5) out.push(iso(u)); }
    } else if (monthM) {
      const dom = Number(monthM[1]);
      for (let u = s; u <= e; ) {
        const y = new Date(u).getUTCFullYear(), mo = new Date(u).getUTCMonth();
        // A day the month lacks (e.g. the 31st in April) is not emitted; Date.UTC would overflow it into the next month.
        if (dom <= new Date(Date.UTC(y, mo + 1, 0)).getUTCDate()) { const occ = Date.UTC(y, mo, dom); if (occ >= s && occ <= e) out.push(iso(occ)); }
        u = Date.UTC(mo === 11 ? y + 1 : y, (mo + 1) % 12, 1);
      }
    } else if (/every day|daily/.test(c)) {
      for (let u = s; u <= e; u += DAY) out.push(iso(u));
    }
    return out;
  }

  /** Parse the "Recurring appointments" block into dated occurrences. Each entry is a cadence
   *  line, a "<service> with <provider>[ at <location>]" line, and a "<start> to <end>" range. */
  /** Whether a monthly series falls on a day some month in [start, end] lacks: Wrenfield may skip or
   *  clamp that month (unverified), so the series' dates aren't known exactly. */
  static recurAmbiguous(cadence: string, startISO: string, endISO: string): boolean {
    const m = cadence.toLowerCase().match(/month\s+on\s+the\s+(\d+)/); if (!m || Number(m[1]) <= 28) return false;
    const [sy, sm] = startISO.split("-").map(Number), [ey, em] = endISO.split("-").map(Number);
    for (let y = sy, mo = sm; y < ey || (y === ey && mo <= em); mo === 12 ? (y++, mo = 1) : mo++) if (new Date(Date.UTC(y, mo, 0)).getUTCDate() < Number(m[1])) return true;
    return false;
  }
  private recurUnclear = false;
  private expandRecurring(text: string): Array<{ dateISO: string; service: string; provider: string; location: string; status: string }> {
    const out: Array<{ dateISO: string; service: string; provider: string; location: string; status: string }> = [];
    this.recurUnclear = false;
    const re = /Every\s+([^\n]+?)\n([^\n]+?)\s+with\s+([^\n,]+?)(?:,\s*[A-Za-z-]+)?(?:\s+at\s+([^\n]+?))?\n([A-Z][a-z]{2} \d{1,2}, \d{4})\s+to\s+([A-Z][a-z]{2} \d{1,2}, \d{4})/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const start = Crawler.monthDate(m[5]), end = Crawler.monthDate(m[6]);
      if (!start || !end) continue;
      const service = m[2].trim(), provider = Crawler.stripTitle(m[3].trim()), location = (m[4] || "").trim();
      if (Crawler.recurAmbiguous(m[1], start, end) || !Crawler.recurDates(m[1], start, end).length) this.recurUnclear = true;
      for (const d of Crawler.recurDates(m[1], start, end)) {
        out.push({ dateISO: d, service, provider, location, status: this.today && d < this.today ? "Completed" : "Scheduled" });
      }
    }
    return out;
  }

  /** A recurring series' own page: every occurrence with ITS status (exceptions included), plus the
   *  series' type, provider and location. Replaces inferring past = Completed by arithmetic. */
  async fetchSeries(href: string): Promise<ApptRow[] | null> {
    if (!(await this.navTo(href, "All dates", 6000))) return null;
    const pg = await this.evalApp<{ dl: Record<string, string>; rows: string[][] }>(`const dl={}; for(const dt of doc.querySelectorAll('dt')){ const dd=dt.nextElementSibling; if(dd) dl[dt.innerText.trim()]=dd.innerText.trim(); }
      const t=[...doc.querySelectorAll('table')].find(x=>/every date/i.test((x.querySelector('caption')||{}).innerText||''));
      return { dl, rows: t?[...t.querySelectorAll('tbody tr')].map(tr=>[...tr.querySelectorAll('td')].map(td=>td.innerText.trim())):[] }`);
    const service = pg.dl["Type"] || "", provider = Crawler.stripTitle(pg.dl["Provider"] || ""), location = pg.dl["Location"] || "";
    if (!service || !provider) return null;
    const out: ApptRow[] = [];
    for (const [when, status] of pg.rows) { const d = Crawler.monthDate(when || ""); if (d && status) out.push({ dateISO: d, service, provider, location, status: status.trim(), providerRaw: (pg.dl["Provider"] || "").trim(), time: when }); }
    return out;
  }

  /** Appointments plus whether the read is trustworthy as the COMPLETE history. `complete` is false when
   *  the page didn't load, when it shows dates but nothing parsed (a layout we don't understand), when
   *  the table paginates beyond what was read, or when a recurring series can't be read exactly.
   *  Absence-based answers (NEW, counts, "next") must not rely on it then. */
  async fetchAppointments(href: string, marker: string | RegExp = "MRN"): Promise<{ appts: ApptRow[]; complete: boolean; /** the chart shows recurring series (their occurrences are in `appts`, not rows of the table) */ series?: boolean }> {
    const loaded = (await this.navTo(`${href}/appointments`, marker, 8000)) || (await this.navByLink(/appointment/i, templateOf(href), marker, 8000, true));
    let t = await this.appText();
    // The tab's footer (listFooter's grammar, the "appointments" line): "Showing 1 to 25 of 31", "Showing 15 of 148"
    // (a Show-more list), "31 appointments", "No appointments" — an exact total is the only end proof (isComplete).
    const footerOf = (text: string) => listFooter(text, /^appointments?$/i);
    // Paginated tab ("Showing 1 to 25 of 31 appointments"): ask for the largest page size, re-read.
    let shown = footerOf(t);
    if (shown && !shown.cumulative && !shown.end && shown.from === 1 && shown.total > shown.to) {
      const was = shown.to;
      await this.evalApp(`const s=[...doc.querySelectorAll('select')].find(x=>[...x.options].some(o=>/per page/i.test(o.text))); if(s){ const best=[...s.options].reduce((a,o)=>parseInt(o.text)>parseInt(a.text)?o:a); const d=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set; d.call(s,best.value); s.dispatchEvent(new Event('input',{bubbles:true})); s.dispatchEvent(new Event('change',{bubbles:true})); } return true;`).catch(() => {});
      for (let i = 0; i < 20; i++) { await sleep(100); t = await this.appText(); const m = footerOf(t); if (!m || m.to !== was) break; }
      shown = footerOf(t);
    }
    const out: ApptRow[] = [];
    let parsed = 0;
    const parse = (text: string) => {
      const re = /([A-Z][a-z]{2} \d{1,2}, \d{4}),([^\t]*)\t([^\t]+)\t([^\t]+)\t([^\t\n]+)\t?\s*(Completed|Scheduled|Cancelled|No-show|Late cancel)/g;
      let m: RegExpExecArray | null; let n = 0;
      while ((m = re.exec(text))) { const d = Crawler.monthDate(m[1]); if (d) { out.push({ dateISO: d, service: m[3].trim(), provider: Crawler.stripTitle(m[4].trim()), location: m[5].trim(), status: m[6], providerRaw: m[4].trim(), time: m[2].trim() }); n++; } }
      parsed += n;
      return n;
    };
    parse(t);
    // Still more pages than the largest page size: press Next until the footer reaches the total.
    let page = shown, pages = 1;
    while (page && !page.cumulative && !page.end && page.kind === "exact" && page.to < page.total && pages < 12) {
      const before = page.text;
      const clicked = await this.evalApp<boolean>(`const b=[...doc.querySelectorAll('button')].find(x=>/^\\s*Next\\s*$/i.test(x.textContent||'')&&!x.disabled&&x.getAttribute('aria-disabled')!=='true'); if(b){b.click();return true;} return false;`).catch(() => false);
      this.trace({ act: "click", what: "Next", page: pages, hit: clicked });
      if (!clicked) { this.trace({ act: "STUCK", what: "appointments pagination", reason: "no enabled Next button" }); break; }
      let t2 = ""; for (let i = 0; i < 30; i++) { await sleep(100); t2 = await this.appText(); const f = footerOf(t2); if (f && f.text !== before) break; }
      const next = footerOf(t2);
      if (!next || next.text === before) { this.trace({ act: "STUCK", what: "appointments pagination", reason: "page did not advance" }); break; }
      parse(t2); page = next; pages++;
    }
    // Complete only on an exact total the parsed rows reach (a "Showing 15 of 148" Show-more tab or a "148+" bound is
    // never complete); a tab with no footer at all is taken as a single unpaged page, as before.
    const paged = !!page && !isComplete(parsed, page).complete;
    // Recurring series: read each series page for exact per-occurrence statuses; fall back to the
    // cadence arithmetic (past = Completed) only when a series page can't be read. A one-off on the
    // same date+provider is an explicit exception and wins (it carries the real status).
    const have = new Set(out.map((a) => `${a.dateISO}|${a.provider.toLowerCase()}`));
    const series = await this.evalApp<string[]>(`return [...new Set([...doc.querySelectorAll('a[href*="/recurring/"]')].map(a=>a.getAttribute('href').split('?')[0]))]`).catch(() => [] as string[]);
    const arithmetic = this.expandRecurring(t);
    let seriesUnclear = this.recurUnclear;
    const fromPages: typeof out = [];
    for (const s of series.slice(0, 6)) { const occ = await this.fetchSeries(s).catch(() => null); if (occ) fromPages.push(...occ); else seriesUnclear = true; }
    for (const r of (fromPages.length ? fromPages : arithmetic)) if (!have.has(`${r.dateISO}|${r.provider.toLowerCase()}`)) { out.push(r); have.add(`${r.dateISO}|${r.provider.toLowerCase()}`); }
    const unparsedDates = out.length === 0 && /[A-Z][a-z]{2} \d{1,2}, \d{4}/.test(t);
    return { appts: out, complete: loaded && !unparsedDates && !paged && !(fromPages.length ? seriesUnclear : this.recurUnclear), series: series.length > 0 || arithmetic.length > 0 || /\bRecurring appointments\b/.test(t) };
  }

  /** Documents tab is a table: Title · Type · Received · View. Read the DOM rows (robust to the
   *  exact text layout) and capture each View link so the file can be opened later. The referral
   *  source is the "… from <practice>" tail of a referral-letter title. */
  async fetchDocuments(href: string, marker: string | RegExp = "MRN"): Promise<Array<{ title: string; kind: string; source?: string; receivedISO?: string; docHref?: string }>> {
    // The documents tab's address and layout differ by clinic: a Set 1 clinic's chart linked no
    // /documents tab and its documents page showed neither "MRN" nor the patient's name, so every read
    // waited out two 8 s timeouts. Take the tab from the chart's own links when the map has seen them,
    // and accept the documents table's own cues as arrival.
    const tabs = this.map.subpages("/patients/{id}");
    const tab = (tabs.find((t) => /document/i.test(t.label + " " + t.suffix)) ?? tabs.find((t) => /\bfiles?\b/i.test(t.label + " " + t.suffix)))?.suffix ?? "/documents";
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const cue = new RegExp(`${typeof marker === "string" ? esc(marker) : marker.source}|Received|No documents|\\d+\\s+documents?|No files|\\d+\\s+files?`);
    if (!(await this.navTo(`${href}${tab}`, cue, 8000))) await this.navByLink(/document|\bfiles?\b/i, templateOf(href), cue, 8000, true);
    for (let i = 0; i < 25; i++) { if (/Received|No documents|\d+\s+documents?/.test(await this.appText())) break; await sleep(100); }
    const rows = await this.evalApp<any[]>(DOCUMENT_ROWS_JS);
    return parseDocumentRows(rows);
  }

  /** FAST path for a document: navigate to the viewer and return the NATIVE page image (PNG) the
   *  browser downloads over the /v/ channel, captured via CDP Network. Avoids the render-wait and
   *  the large screenshot of captureDoc, and sends a ~15× smaller image to the vision model. */
  async fetchDocImage(docHref: string): Promise<string | null> {
    await this.navTo(docHref, "", 8000); // the captured image is the arrival signal; viewer wording differs by clinic
    for (let i = 0; i < 80; i++) {
      for (let j = this.recentDocImgs.length - 1; j >= 0; j--) { const buf = this.imgCache.get(this.recentDocImgs[j]); if (buf && buf.length > 500) return buf.toString("base64"); }
      await sleep(80);
    }
    return null;
  }

  /** Open a document's viewer and screenshot the rendered report (PDF/image) as base64 PNG.
   *  Fallback for fetchDocImage when the native image can't be captured. */
  async captureDoc(docHref: string): Promise<string | null> {
    await this.client.Emulation.setDeviceMetricsOverride({ width: 1100, height: 1700, deviceScaleFactor: 2, mobile: false }).catch(() => {});
    // Load the viewer, then wait for the image to paint (below). The viewer chrome text differs by
    // clinic, so don't block up to 6 s on a text marker that may never match — the paint loop is the
    // real readiness signal; a lenient, short nav avoids a 6 s stall per document on other clinics.
    await this.navTo(docHref, /./, 3000).catch(() => {});
    // wait for the document image to actually paint
    for (let i = 0; i < 30; i++) {
      const ready = await this.evalApp<boolean>(`const im=[...doc.querySelectorAll('img')].find(x=>/\\/v\\//.test(x.src||'')); return !!(im && im.complete && im.naturalWidth>0)`).catch(() => false);
      if (ready) break; await sleep(150);
    }
    await sleep(300);
    try { const { data } = await this.client.Page.captureScreenshot({ format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: 1100, height: 1700, scale: 1 } }); return data; }
    catch { return null; }
  }

  /** Diagnostics: press the button/link whose aria-label or text matches `label` on the current page and
   *  report what it opened (dialog/page text, images with sizes, URL), plus the first native image that
   *  arrived over the /v/ channel (base64, capped). Used once per run to capture a scanned document. */
  async probeOpen(label: RegExp, capBytes = 250_000): Promise<Record<string, unknown>> {
    const before = this.recentDocImgs.length;
    const src = label.source.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const clicked = await this.evalApp<string | null>(`const re=new RegExp('${src}','i'); const el=[...doc.querySelectorAll('button,a,[role=button]')].find(e=>re.test(e.getAttribute('aria-label')||'')||re.test((e.textContent||'').trim())); if(!el) return null; el.click(); return (el.getAttribute('aria-label')||el.textContent||'').trim().slice(0,120);`).catch(() => null);
    if (!clicked) return { clicked: null };
    let png: Buffer | undefined, imgUrl: string | undefined;
    for (let i = 0; i < 50 && !png; i++) {
      await sleep(100);
      for (let j = this.recentDocImgs.length - 1; j >= before; j--) { const b = this.imgCache.get(this.recentDocImgs[j]); if (b && b.length > 500) { png = b; imgUrl = this.recentDocImgs[j]; break; } }
    }
    const view = await this.evalApp<Record<string, unknown>>(`const dlg=doc.querySelector('[role=dialog],dialog[open]'); const root=dlg||doc.body; return { url: location.pathname, dialog: !!dlg, text: (root.innerText||'').replace(/\\s+/g,' ').slice(0,1500), imgs: [...root.querySelectorAll('img,canvas,object,embed,iframe')].slice(0,6).map(e=>({tag:e.tagName, src:(e.src||e.data||'').slice(0,160), w:e.naturalWidth||e.width||0, h:e.naturalHeight||e.height||0, alt:(e.alt||e.getAttribute('aria-label')||'').slice(0,120)})) };`).catch((e) => ({ err: String(e).slice(0, 80) }));
    return { clicked, ...view, imgUrl: imgUrl ?? null, imgBytes: png?.length ?? 0, ...(png && png.length <= capBytes ? { imgB64: png.toString("base64") } : {}) };
  }

  /** Try a patient sub-tab by URL; returns the tab's text, or null if not addressable. */
  async fetchTab(href: string, tab: string, marker: string): Promise<string | null> {
    const ok = await this.navTo(`${href}/${tab}`, marker, 6000);
    return ok ? await this.appText() : null;
  }

  /** The "Find invoice" form on /billing → the invoice's detail page, read as records. null when the
   *  page isn't reached or doesn't show that invoice. */
  async fetchInvoicePage(invoice: string): Promise<InvoicePage | null> { return this.againAfterSuspension(() => this.fetchInvoicePageOnce(invoice), (r) => r === null); }
  private async fetchInvoicePageOnce(invoice: string): Promise<InvoicePage | null> {
    await this.navTo("/billing", "Find invoice", 7000);
    await this.evalApp(`
      const el=doc.querySelector('input[name=number]')||[...doc.querySelectorAll('input')].find(i=>/invoice/i.test(i.placeholder||''));
      if(el){ const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; d.call(el, ${JSON.stringify(invoice)});
        el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
        const f=el.closest('form'); const b=f?f.querySelector('button[type=submit],button'):null; if(b) b.click(); else if(f){ f.requestSubmit?f.requestSubmit():f.submit(); } }
      return true;`);
    this.trace({ act: "type", what: "Find invoice", value: invoice }); this.trace({ act: "submit", what: "invoice lookup" });
    if (!(await this.awaitMarker("Ledger", 4000, "find invoice"))) return null; // an unknown number never leaves /billing
    const pg = await this.evalApp<{ h1: string; dl: Record<string, string>; rows: string[][]; owed: string; status: string }>(INVOICE_PAGE_JS);
    return parseInvoicePage(pg);
  }

  /** A provider's schedule for one day across every location: /schedule/providers/<id>?date=. The page
   *  is unpaginated, so its rows are the complete day. null unless the page rendered for that date. */
  async fetchProviderDay(providerId: string, dateISO: string): Promise<ProviderDay | null> {
    if (!(await this.navTo(`/schedule/providers/${providerId}?date=${dateISO}`, "Provider", 7000))) return null;
    if (!(await this.ensureAllLocations())) return null;
    for (let i = 0; i < 30; i++) { // settle: the date input shows the requested day and the sections (if any) are in
      const ok = await this.evalApp<boolean>(`const d=doc.querySelector('input[type=date]'); return !!d && d.value===${JSON.stringify(dateISO)} && !!doc.querySelector('h2')`).catch(() => false);
      if (ok) break; await sleep(100);
    }
    const pg = await this.evalApp<{ date: string; provider: string; sections: ProviderDay["sections"] }>(PROVIDER_DAY_JS);
    return parseProviderDay(pg, dateISO);
  }

  async close() {
    this.map.save(); console.log(JSON.stringify({ event: "sitemap", ...this.map.summary() }));
    try { this.client?.close(); } catch {} this.child?.kill("SIGTERM");
  }
}
