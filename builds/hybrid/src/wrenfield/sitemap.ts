/**
 * SiteMap: the clinic app as a state machine, discovered as a side effect of normal crawling.
 *
 *   state      = URL template (ids replaced by {id}, query values dropped) + a fingerprint of
 *                what the page showed (headings, table headers, field labels, inputs, links)
 *   transition = (from state, action, to state, ok, ms) — recorded on every navigation
 *   frontier   = outgoing links seen on a visited state whose target state was never visited
 *
 * Uses now: `drift()` flags a replay that lands on a state whose shape changed since it was
 * cached (never trust a cached extractor on a page that no longer looks the same), and
 * `linkFrom()` resolves "the link on this page whose text matches X" so a route can be found
 * from the map instead of assumed. `pathTo()` is BFS over recorded transitions.
 *
 * Persisted to WORK_DIR/sitemap.json and summarised to stdout so it survives via `arena logs`.
 */
import { readFileSync, writeFileSync } from "node:fs";

export type Fingerprint = { title: string; h1: string; headers: string[]; labels: string[]; inputs: string[]; links: Array<{ text: string; href: string; nav?: boolean }> };
export type Transition = { from: string; action: string; to: string; ok: boolean; ms: number };
type StateRec = { template: string; visits: number; firstUrl: string; sig: string; fp: Fingerprint; markerMisses: number };

export function templateOf(url: string): string {
  const path = url.replace(/^https?:\/\/[^/]+/, "").split("#")[0];
  const [p, q] = path.split("?");
  const segs = p.split("/").map((s) => (/\d/.test(s) || /^[A-Za-z0-9_-]{16,}$/.test(s) ? "{id}" : s));
  const keys = q ? "?" + q.split("&").map((kv) => kv.split("=")[0]).sort().join("&") : "";
  return segs.join("/") + keys;
}

/** Shape signature: what an extractor depends on. Links/title excluded (they vary per record). */
export function signatureOf(fp: Fingerprint): string {
  return [fp.headers, fp.labels, fp.inputs].map((a) => [...new Set(a)].sort().join("|")).join("||");
}

export class SiteMap {
  states = new Map<string, StateRec>();
  transitions: Transition[] = [];
  drifts: Array<{ template: string; was: string; now: string }> = [];
  current = "";
  constructor(private file?: string) {
    if (file) try { const j = JSON.parse(readFileSync(file, "utf8")); for (const s of j.states) this.states.set(s.template, s); this.transitions = j.transitions ?? []; } catch {}
  }

  /** Record arriving at `url` with `fp`, via `action` from the current state. Returns the state's template. */
  observe(url: string, fp: Fingerprint, action: string, ok: boolean, ms: number): string {
    const template = templateOf(url);
    const sig = signatureOf(fp);
    const rec = this.states.get(template);
    if (rec) {
      // Drift = the table columns extractors key on changed while a table was present BOTH times.
      // Labels/inputs/empty tables vary with data (pagination past 25 rows, empty days, late
      // renders) and are not drift; the full signature is still stored for inspection.
      // Only when neither header set contains the other: an optional table (e.g. a series' "Changed
      // dates") adds or removes a whole group, a rename replaces members.
      const hdr = (f: Fingerprint) => [...new Set(f.headers)].sort().join("|");
      const sub = (a: Fingerprint, b: Fingerprint) => a.headers.every((h) => b.headers.includes(h));
      if (rec.fp.headers.length && fp.headers.length && !sub(rec.fp, fp) && !sub(fp, rec.fp)) this.drifts.push({ template, was: hdr(rec.fp), now: hdr(fp) });
      if (sig !== rec.sig && (fp.headers.length || fp.labels.length)) rec.sig = sig;
      // Latest good visit wins: links must belong to the instance we are on now (navByLink follows
      // them), and tabs first seen on a later visit must not be lost. An empty page keeps the old one.
      if (ok && (fp.links.length || fp.headers.length || fp.labels.length)) rec.fp = fp;
      rec.visits++; if (!ok) rec.markerMisses++;
    } else this.states.set(template, { template, visits: 1, firstUrl: url, sig, fp, markerMisses: ok ? 0 : 1 });
    if (this.current && !this.transitions.some((t) => t.from === this.current && t.action === action && t.to === template)) {
      this.transitions.push({ from: this.current, action, to: template, ok, ms });
    }
    this.current = template;
    return template;
  }

  /** Did the state just observed change shape since it was first cached? */
  drift(template: string) { return this.drifts.find((d) => d.template === template); }

  /** An outgoing link from a state (default: current) whose text or href matches `re`. */
  linkFrom(re: RegExp, template = this.current, under = false): string | undefined {
    const fp = this.states.get(template)?.fp;
    // `under`: only links that stay inside this state (a chart's own tabs), never the site's
    // sidebar ("Documents" in the sidebar is every patient's documents, not this one's).
    return fp?.links.find((l) => (re.test(l.text) || re.test(l.href)) && (!under || templateOf(l.href).startsWith(template + "/")))?.href;
  }

  /** Shortest recorded action sequence from `from` to `to` (BFS over successful transitions). */
  pathTo(to: string, from = this.current): string[] | null {
    const prev = new Map<string, Transition>(); const seen = new Set([from]); const q = [from];
    while (q.length) {
      const s = q.shift()!; if (s === to) break;
      for (const t of this.transitions) if (t.ok && t.from === s && !seen.has(t.to)) { seen.add(t.to); prev.set(t.to, t); q.push(t.to); }
    }
    if (!seen.has(to)) return null;
    const out: string[] = []; for (let s = to; s !== from; ) { const t = prev.get(s)!; out.unshift(t.action); s = t.from; }
    return out;
  }

  /** Link targets seen on visited states that map to a state never visited. */
  frontier(): string[] {
    const out = new Set<string>();
    for (const s of this.states.values()) for (const l of s.fp.links) { const t = templateOf(l.href); if (!this.states.has(t)) out.add(t); }
    return [...out];
  }

  /** Sub-pages of a templated parent (e.g. a patient chart's tabs): every link seen on a state under
   *  `parent` whose href is `parent + one segment`, as (suffix, label). Lets a caller route a question
   *  to the tabs this clinic actually has instead of a hardcoded list. */
  subpages(parent: string): Array<{ suffix: string; label: string }> {
    const out = new Map<string, string>();
    for (const s of this.states.values()) {
      if (s.template !== parent && !s.template.startsWith(parent + "/")) continue;
      for (const l of s.fp.links) {
        const t = templateOf(l.href);
        const m = t.startsWith(parent + "/") ? t.slice(parent.length).match(/^(\/[a-z-]+)$/i) : null;
        if (m && l.text && l.text.length < 24 && !out.has(m[1])) out.set(m[1], l.text);
      }
    }
    return [...out].map(([suffix, label]) => ({ suffix, label }));
  }

  summary() {
    return { states: this.states.size, transitions: this.transitions.length, drifts: this.drifts, frontier: this.frontier().slice(0, 40),
      markerMisses: [...this.states.values()].filter((s) => s.markerMisses).map((s) => ({ template: s.template, misses: s.markerMisses, headers: s.fp.headers, labels: s.fp.labels.slice(0, 12) })) };
  }

  save() { if (this.file) try { writeFileSync(this.file, JSON.stringify({ states: [...this.states.values()], transitions: this.transitions })); } catch {} }
}

// ── self-check ──
if (process.argv[1]?.endsWith("/sitemap.ts")) {
  const assert = (c: unknown, m: string) => { if (!c) { console.error("✗ " + m); process.exit(1); } };
  assert(templateOf("https://x.test/patients/HG12345/appointments?page=2&q=a") === "/patients/{id}/appointments?page&q", "template ids+query");
  assert(templateOf("/schedule/providers/42") === "/schedule/providers/{id}", "template numeric id");
  const fp = (links: Array<[string, string]>, headers: string[] = []): Fingerprint => ({ title: "", h1: "", headers, labels: [], inputs: [], links: links.map(([text, href]) => ({ text, href })) });
  const m = new SiteMap();
  m.observe("/patients", fp([["Jane Doe", "/patients/HG1"]], ["Name", "MRN"]), "goto", true, 10);
  m.observe("/patients/HG1", fp([["Appointments", "/patients/HG1/appointments"], ["Documents", "/patients/HG1/documents"]]), "click", true, 12);
  m.observe("/patients/HG1/appointments", fp([], ["Date", "Provider"]), "goto", true, 9);
  assert(m.states.size === 3 && m.transitions.length === 2, "states/transitions recorded");
  assert(m.linkFrom(/documents/i, "/patients/{id}") === "/patients/HG1/documents", "linkFrom by text");
  assert(JSON.stringify(m.pathTo("/patients/{id}/appointments", "/patients")) === '["click","goto"]', "pathTo BFS");
  assert(m.pathTo("/nowhere") === null, "pathTo unknown");
  assert(m.frontier().includes("/patients/{id}/documents"), "frontier has unvisited link");
  m.observe("/patients/HG2", fp([]), "click", true, 1);
  assert(m.transitions.length === 3, "new transition (appointments → chart) recorded once");
  m.observe("/patients/HG2/appointments", fp([], ["Date", "Provider"]), "goto", true, 1);
  m.observe("/patients/HG2", fp([]), "click", true, 1);
  assert(m.transitions.length === 3, "repeat of known transitions is deduped by template");
  m.observe("/patients/HG2/appointments", fp([["Insurance", "/patients/HG2/insurance"], ["Jane Doe", "/patients/HG2"], ["Visit", "/patients/HG2/appointments/77"]], ["Date", "Provider"]), "goto", true, 9);
  assert(JSON.stringify(m.subpages("/patients/{id}").map((t) => t.suffix)) === '["/appointments","/documents","/insurance"]', "subpages: one-segment children from any chart state");
  m.observe("/patients/HG2/appointments", fp([], ["Date", "Clinician"]), "goto", true, 9);
  assert(m.drift("/patients/{id}/appointments")?.now.includes("Clinician"), "drift detected on changed headers");
  m.observe("/patients/HG2/appointments", { ...fp([], ["Date", "Clinician"]), labels: ["Rows per page"], inputs: ["size"] }, "goto", true, 9);
  assert(m.drifts.length === 1, "labels/inputs changing with data is not a drift");
  m.observe("/patients/HG2/appointments", fp([], ["Date", "Clinician", "Change", "Recorded"]), "goto", true, 9);
  assert(m.drifts.length === 1, "an optional extra table is not a drift");
  m.observe("/patients/HG3/appointments", fp([]), "goto", false, 9);
  assert(m.states.get("/patients/{id}/appointments")!.markerMisses === 1 && m.drifts.length === 1, "empty page is a marker miss, not a drift");
  const g = new SiteMap();
  g.observe("/patients/HG9", fp([["Documents", "/documents"], ["Documents", "/patients/HG9/files"]]), "goto", true, 1);
  assert(g.linkFrom(/document/i, "/patients/{id}") === "/documents" && g.linkFrom(/document/i, "/patients/{id}", true) === "/patients/HG9/files", "under: a chart tab, never the sidebar's global list");
  console.log("✓ sitemap self-check");
}
