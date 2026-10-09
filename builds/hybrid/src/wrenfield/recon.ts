/**
 * General site explorer (AGENT_RECON=1 only). Visits EVERY reachable page TYPE by following links —
 * no hardcoded route names — deduping by URL template (digit-bearing segments → {id}), so it covers
 * each kind of page once (one /claims/{id}, one /patients/{id}/<tab>, a payer contract, an appointment
 * detail, a document viewer, …) on ANY Wrenfield version, not just the one I can see. Dumps each
 * page's decoded text + HTML to STDOUT for the Set-1 logs. Read-only, bounded.
 *
 * The same breadth is what the agent needs at runtime on the blind sets: discover where things live,
 * don't assume a fixed map.
 */
import type { Crawler } from "./crawl.js";

const CAP_PAGES = Number(process.env.RECON_MAX_PAGES ?? 60);
const CAP_HTML = Number(process.env.RECON_HTML_CAP ?? 14000);
const CAP_TEXT = Number(process.env.RECON_TEXT_CAP ?? 4000);
const tmpl = (p: string) => p.split("?")[0].replace(/[^/]*\d[^/]*/g, "{id}"); // id-bearing segment → {id}

export async function reconDump(crawler: Crawler): Promise<void> {
  const c = crawler as any;
  const out = (s: string) => console.log(s);
  const cur = () => c.evalApp(`return location.pathname+location.search`).catch(() => "");
  const appText = () => c.appText().catch(() => "");
  const html = async () => String(await c.evalApp(`return (doc&&doc.body?doc.body.outerHTML:(document.body?document.body.outerHTML:""))||""`).catch(() => "")).slice(0, CAP_HTML);
  const text = async () => String(await c.decodedText().catch(() => "")).slice(0, CAP_TEXT);
  // Every in-app link on the page (nav tabs, sub-nav, table rows, breadcrumbs), minus honeypots.
  const linksHere = (): Promise<string[]> => c.evalApp(`return [...new Set([...doc.querySelectorAll('a[href^="/"]')].filter(a=>a.getAttribute('aria-hidden')!=='true'&&a.getAttribute('tabindex')!=='-1'&&!a.closest('[aria-hidden="true"]')).map(a=>a.getAttribute('href')))]`).catch(() => [] as string[]);

  const visited = new Set<string>();        // templates already dumped
  const queued = new Set<string>();         // templates already enqueued
  const queue: Array<{ path: string; why: string }> = [];
  const enqueue = (href: string, why: string) => {
    if (!href || !href.startsWith("/")) return;
    const t = tmpl(href);
    if (visited.has(t) || queued.has(t)) return;
    queued.add(t); queue.push({ path: href, why });
  };

  out(`\n########## RECON START ${process.env.SITE_URL || ""} ##########`);
  enqueue("/", "root");
  // Seed a few pages that may not be linked from the dashboard nav (e.g. the clinic calendar used by
  // good-faith closures, or a settings area). Harmless if absent — the nav just marker-misses and moves on.
  for (const p of ["/settings", "/calendar", "/schedule/calendar", "/settings/calendar", "/clinic", "/locations", "/schedule"]) enqueue(p, "seed guess");
  // [immunizations] sections the Set 1 sitemap listed but no recon ever dumped: the vaccine
  // lots / inventory page (recall + UNKNOWN_LOT need its layout), the inbox, encounters, claims, staff.
  for (const p of ["/vaccines", "/inbox", "/encounters", "/claims", "/staff"]) enqueue(p, "seed (sitemap frontier)");

  while (queue.length && visited.size < CAP_PAGES) {
    const { path, why } = queue.shift()!;
    const t = tmpl(path);
    if (visited.has(t)) continue;
    visited.add(t);

    out(`\n@@@@ ${t} :: nav ${path} (${why}) @@@@`);
    let ok = false; try { ok = await c.navTo(path, /./, 9000); } catch (e) { out(`!! nav threw ${String(e).slice(0, 80)}`); }
    out(`# ok=${ok} url=${await cur()}`);
    out(`---- TEXT (decoded) ----\n${await text()}`);
    out(`---- HTML ----\n${await html()}`);
    if (!ok) continue;

    const here = await linksHere();
    // Enqueue every NEW page type linked from here: section tabs, sub-nav, and ONE detail exemplar per
    // distinct template (so /claims → one /claims/{id}, /payers → one /payers/{id}, etc.).
    for (const h of here) enqueue(h, `linked from ${t}`);

    // A search-only page (patients/claims lookup) exposes no record links until a query runs — do one
    // generically so charts and their tabs get discovered too. Detected by a name/last-name search input.
    if (!here.some((h) => /^\/patients\/[^/]+$/.test(tmpl(h).replace(/\{id\}/g, "x")))) {
      const hasPt = await c.evalApp(`return !!doc.querySelector('input#lastName,input[name=lastName],input[name=patient],input[name=dob]')`).catch(() => false);
      if (hasPt) {
        for (const sn of ["Smith", "Garcia", "Johnson", "Brown", "Lee"]) {
          const rows = await c.searchPatients(sn).catch(() => []);
          if (rows && rows.length) { for (const r of rows.slice(0, 2)) enqueue(String(r.href), "patient search result"); break; }
        }
      }
    }
  }

  out(`\n# EXPLORED ${visited.size} page types: ${JSON.stringify([...visited])}`);

  // POPULATED-SEEKING pass: the BFS saw each page type with one (often empty) patient. Tetanus needs a
  // real triage Note + Immunization doses; claim-next-step needs a real Claims + Remittances panel.
  // Iterate patients and dump the FIRST populated instance of each — the row structure the readers need.
  const need: Record<string, { tab: string; empty: RegExp; want?: RegExp }> = {
    "claims+remittances": { tab: "/claims", empty: /No claims for this patient|No remittances/i },
    notes: { tab: "/notes", empty: /No notes/i },
    immunizations: { tab: "/immunizations", empty: /No immunizations/i },
    "insurance (authorizations / not-yet-filed)": { tab: "/insurance", empty: /No authorizations on file.*No claims waiting/is },
    // tetanus: a real triage note, a dose-given-here note, an Entered-in-error entry, an outside record row
    "notes with a Triage: note": { tab: "/notes", empty: /No notes/i, want: /\nTriage:/ },
    "notes with a vaccine given here": { tab: "/notes", empty: /No notes/i, want: /given today[^\n]*\blot\b/i },
    "immunizations with Entered in error": { tab: "/immunizations", empty: /No immunizations/i, want: /Entered in error/i },
    "documents with an Immunization record": { tab: "/files", empty: /No documents/i, want: /Immunization record/ },
  };
  try {
    const seenPt = new Set<string>();
    outer: for (const sn of ["Garcia", "Smith", "Johnson", "Williams", "Brown", "Jones", "Miller", "Davis", "Martinez", "Rodriguez", "Hernandez", "Lopez", "Gonzalez", "Wilson", "Anderson", "Taylor", "Thomas", "Moore", "Jackson", "White"]) {
      if (!Object.keys(need).length) break;
      const rows = await c.searchPatients(sn).catch(() => []);
      for (const r of (rows || []).slice(0, 8)) {
        const chart = String(r.href).split("?")[0]; if (seenPt.has(chart)) continue; seenPt.add(chart);
        for (const [label, { tab, empty }] of Object.entries(need)) {
          if (!need[label]) continue;
          if (!(await c.navTo(`${chart}${tab}`, /./, 7000).catch(() => false))) continue;
          const body = await appText();
          if (body && body.length > 40 && !empty.test(body) && (!need[label].want || need[label].want!.test(body))) {
            out(`\n==== POPULATED ${label} :: ${chart}${tab} (${r.name}) ====`);
            out(`---- TEXT (decoded) ----\n${await text()}`);
            out(`---- HTML ----\n${await html()}`);
            // For claims, also open a real CLAIM DETAIL + REMITTANCE DETAIL (the adjudication lines the
            // claim-next-step reader needs — these aren't on the list tab).
            if (/claims/.test(label)) {
              const here = await linksHere();
              const claim = here.find((h) => /^\/claims\/[^/?]+$/.test(h) && !/\/claims\/(payers|remittances)/.test(h));
              const remit = here.find((h) => /\/claims\/remittances\/[^/?]+$/.test(h));
              for (const [u, note] of [[claim, "CLAIM DETAIL (remittances panel: lines + adjustments CO-45, remark codes; authorizations; account notes)"], [remit, "REMITTANCE DETAIL (lines + adjustments)"]] as const) {
                if (!u) continue;
                out(`\n==== ${note} :: nav ${u} ====`);
                const okd = await c.navTo(u, /./, 8000).catch(() => false);
                out(`# ok=${okd}`); out(`---- TEXT (decoded) ----\n${await text()}`); out(`---- HTML ----\n${await html()}`);
              }
              await c.navTo(`${chart}${tab}`, /./, 7000).catch(() => {}); // back to the claims tab for any remaining needs
            }
            delete need[label];
          }
        }
        if (!Object.keys(need).length) break outer;
      }
    }
    if (Object.keys(need).length) out(`# populated NOT found for: ${JSON.stringify(Object.keys(need))}`);
  } catch (e) { out(`!! populated-seek: ${String(e).slice(0, 100)}`); }

  // ── VACCINE-LOT-RECALL capture: the recall count needs a POPULATED lot page ("Chart entries with
  //    this lot": the dosed patients from active entries) AND the note search (note-only doses +
  //    notification notes, by lot). Every lot the BFS saw was empty; walk lots until one has entries,
  //    and exercise /vaccines/notes so the search UI + a result row's structure are captured. ──
  try {
    if (await c.navTo("/vaccines", /./, 8000).catch(() => false)) {
      const lotLinks: string[] = await c.evalApp(`return [...new Set([...doc.querySelectorAll('a[href*="/vaccines/lots/"]')].map(a=>a.getAttribute('href').split('?')[0]))]`).catch(() => [] as string[]);
      out(`\n==== VACCINE: ${lotLinks.length} lot links on /vaccines page 1 ====`);
      let dumped = 0;
      for (const u of lotLinks.slice(0, 30)) {
        if (!(await c.navTo(u, /./, 7000).catch(() => false))) continue;
        const body = await appText();
        if (/No chart entry names this lot/i.test(body)) continue; // empty lot — keep looking for a populated one
        out(`\n==== POPULATED VACCINE LOT :: ${u} ====`);
        out(`---- TEXT (decoded) ----\n${await text()}`); out(`---- HTML ----\n${await html()}`);
        if (++dumped >= 2) break;
      }
      if (!dumped) out(`# no populated lot in first ${Math.min(30, lotLinks.length)} lots (all 'No chart entry names this lot')`);
      // The note search: structure of the query form, then run a one-character query to capture a result row.
      if (await c.navTo("/vaccines/notes", /./, 7000).catch(() => false)) {
        out(`\n==== VACCINE NOTE SEARCH (form) :: /vaccines/notes ====`);
        out(`---- TEXT (decoded) ----\n${await text()}`); out(`---- HTML ----\n${await html()}`);
        const ran = await c.evalApp(`return (function(){const i=doc.querySelector('input[type=search],input[name*=lot i],input[name*=q i],input[type=text]'); if(!i)return false; const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; set.call(i,'A'); i.dispatchEvent(new Event('input',{bubbles:true})); i.dispatchEvent(new Event('change',{bubbles:true})); const b=[...doc.querySelectorAll('button')].find(x=>/search|find|apply/i.test(x.textContent||'')); if(b)b.click(); return true;})()`).catch(() => false);
        if (ran) { await new Promise((r) => setTimeout(r, 900)); out(`\n==== VACCINE NOTE SEARCH (results for query 'A') ====`); out(`---- TEXT (decoded) ----\n${await text()}`); out(`---- HTML ----\n${await html()}`); }
      }
    }
  } catch (e) { out(`!! vaccine-capture: ${String(e).slice(0, 100)}`); }

  if (queue.length) out(`# NOT REACHED (hit cap ${CAP_PAGES}): ${JSON.stringify(queue.slice(0, 20).map((q) => tmpl(q.path)))}`);
  out(`\n########## RECON END ##########`);
}
