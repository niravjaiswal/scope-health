/**
 * Content-based parsers for the family readers. PURE over a page's DECODED text, located by SECTION
 * HEADING / column labels — never by URL — so they carry across Wrenfield versions (claims under a
 * top-level /claims on one version, under /patients/{id}/claims on another). Each is unit-tested
 * offline against real captured DOM text: `npx tsx src/wrenfield/readers.ts`.
 *
 * The live readers (index-builder) navigate by discovered label and hand the decoded text here.
 */

const MON: Record<string, number> = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
/** "Jul 1, 2026" / "Nov 17, 2025, 9:04 AM" → ISO date, or undefined. */
export function monthDateISO(s: string): string | undefined {
  const m = (s || "").match(/\b([A-Z][a-z]{2})\s+(\d{1,2}),\s+(\d{4})/);
  if (!m || !MON[m[1]]) return undefined;
  return `${m[3]}-${String(MON[m[1]]).padStart(2, "0")}-${String(+m[2]).padStart(2, "0")}`;
}
// The filing-deadline and good-faith parsers live in familyReaders.ts (label-based, tested against
// the captured markup and layout variants in familyReaders.test.ts).

// Baseline DOM-text parsers (baseline implementation  / ). NOT on the live path: the live
// good-faith and tetanus readers are familyReaders.readGoodFaith / immunizations.ts (label-based, all pages).
// Kept, with their self-checks, as reference parsers (see CONSOLIDATION.md).
/** Parse the clinic-calendar closure rows for a location. A date counts (is closed) when its row is
 *  Active AND applies to "All locations" or to this location. Rows: "Thu, Jan 1, 2026\tNew Year's
 *  Day\tAll locations\tActive". Located by the Date/Closure/Applies to/Status header. */
export function parseClosures(calendarText: string, location: string): string[] {
  const loc = (location || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const out = new Set<string>();
  for (const ln of (calendarText || "").split("\n")) {
    const iso = monthDateISO(ln); if (!iso) continue;
    const cells = ln.split("\t").map((c) => c.trim());
    if (cells.length < 3) continue;
    const status = cells[cells.length - 1];
    const appliesTo = cells[cells.length - 2];
    if (!/^active$/i.test(status)) continue;                       // Withdrawn doesn't count
    const at = appliesTo.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (at.includes("alllocation") || (loc && at.includes(loc))) out.add(iso);
  }
  return [...out];
}

// tetanus vaccines (chart + outside-record names) from the governing message.
const TETANUS = /\b(DTaP|Tdap|Td|Daptacel|Infanrix|Pediarix|Pentacel|Vaxelis|Kinrix|Boostrix|Adacel|Tenivac)\b/i;
export const isTetanusText = (s: string) => TETANUS.test(s || "");
/** Tetanus dose dates from the Immunizations table text (tab-joined rows), strictly before the visit,
 *  excluding "Entered in error". One per date (dedup). */
export function parseTetanusDoses(immunText: string, visitISO: string): string[] {
  const out = new Set<string>();
  for (const ln of (immunText || "").split("\n")) {
    if (/entered in error/i.test(ln)) continue;
    if (!TETANUS.test(ln)) continue;
    const iso = monthDateISO(ln); if (!iso || iso >= visitISO) continue;
    out.add(iso);
  }
  return [...out];
}
/** Classify the wound from a triage note's text per the message: "other" when a trigger is stated
 *  affirmatively; "clean" when there are none or they're negated; "ambiguous" when unsure → skip. */
const WOUND_TRIGGERS = ["contaminat", "dirt", "soil", "feces", "saliva", "bite", "puncture", "avulsion", "missile", "bullet", "pellet", "shrapnel", "crush", "burn", "frostbite"];
export function classifyWound(triageText: string): "clean" | "other" | "ambiguous" {
  const sentences = (triageText || "").split(/[.;\n]/);
  let affirmative = false, negatedOnly = false;
  for (const s of sentences) {
    const low = s.toLowerCase();
    for (const trig of WOUND_TRIGGERS) {
      const i = low.indexOf(trig); if (i < 0) continue;
      const before = low.slice(Math.max(0, i - 40), i);
      const negated = /\b(no|not|without|denies|denied|negative for|ruled out|rule out|none)\b/.test(before);
      if (negated) negatedOnly = true; else affirmative = true;
    }
  }
  if (affirmative) return "other";
  return "clean"; // no triggers, or only negated → clean-and-minor (negatedOnly or none)
}

// ── self-check (against real captured DOM text) ──
if (process.argv[1]?.endsWith("readers.ts")) {
  const assert = (c: unknown, m: string) => { if (!c) { console.error("✗ " + m); process.exit(1); } console.log("✓ " + m); };
  assert(monthDateISO("Nov 17, 2025, 9:04 AM CST") === "2025-11-17", "monthDate with time tail");

  // clinic calendar (verbatim rows from the recon): Northgate closed Jan 8 + All-locations Jan 1;
  // Withdrawn and other-location rows excluded.
  const cal = [
    "Date\tClosure\tApplies to\tStatus",
    "Thu, Jan 1, 2026\tNew Year's Day\tAll locations\tActive",
    "Thu, Jan 1, 2026\tElectrical work\tFront Range\tWithdrawn",
    "Fri, Jan 2, 2026\tStaff retreat\tRiverbend\tActive",
    "Thu, Jan 8, 2026\tPower outage\tNorthgate\tActive",
    "Wed, May 6, 2026\tBuilding maintenance\tNorthgate\tActive",
  ].join("\n");
  const cl = parseClosures(cal, "Northgate");
  assert(cl.includes("2026-01-01") && cl.includes("2026-01-08") && cl.includes("2026-05-06"), "Northgate closures: All-locations + its own Active rows");
  assert(!cl.includes("2026-01-02"), "other location's closure (Riverbend) excluded");
  assert(parseClosures(cal, "Northgate").length === 3, "Withdrawn Front Range row excluded (3 total)");

  // tetanus doses from the captured García immunization table (DTaP counts; Influenza doesn't)
  const immun = ["Vaccine\tDate given\tLot\tSite\tGiven by\tRecorded as", "Influenza (Fluzone)\tDec 6, 2025\tX87Y94K\tleft deltoid\tJonathan Lawrence\tGiven at Front Range", "DTaP (Daptacel)\tJun 7, 1952\tNone\tNone\tNot recorded\tGiven elsewhere, from the patient's records"].join("\n");
  const doses = parseTetanusDoses(immun, "2026-01-01");
  assert(doses.length === 1 && doses[0] === "1952-06-07", "tetanus dose = DTaP 1952 (Influenza excluded)");
  assert(parseTetanusDoses(immun + "\nTd (Tenivac)\tMar 1, 2030\tL1\t..\t..\tGiven at Front Range", "2026-01-01").length === 1, "dose on/after the visit excluded");
  // wound classification per the message's examples
  assert(classifyWound("Triage: laceration contaminated with feces from a fall.") === "other", "contaminated with feces → other");
  assert(classifyWound("Triage: 3 cm cut from broken glass. No dirt, soil, or saliva in the wound.") === "clean", "negated triggers → clean");
  assert(classifyWound("Triage: superficial scrape. Not a puncture and not a bite.") === "clean", "negated puncture/bite → clean");
  assert(classifyWound("Triage: deep puncture wound to the sole of the foot.") === "other", "puncture → other");


  console.log("ALL PASS");
}
