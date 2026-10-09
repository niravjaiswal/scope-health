/**
 * Routing tests for the robustness fixes found by the variants tooling (src/wrenfield/variants/):
 * meaning-based routing of invoice / provider-day / open-slot questions, near-miss field lookups,
 * two-intent questions, the DOB in a referral question, the generalist's domain gate. Phrasings here
 * are NOT Set 1's (those are pinned by variants/parity.ts) and not the generator's templates.
 *   npx tsx src/wrenfield/test-routing.ts
 */
import { familyMatch } from "./families.js";
import { classifyIntent } from "./parse.js";
import { generalistBlocked } from "./inference.js";

let fails = 0;
const ok = (c: unknown, m: string) => { if (c) console.log("✓ " + m); else { fails++; console.error("✗ " + m); } };
const fam = (t: string) => familyMatch(t);

// ── invoice balance by meaning ──
for (const t of [
  "Can you tell me the unpaid balance for invoice 55512301? It's for Rosa Delgado, seen 2026-02-11.",
  "invoice #55512301 — Delgado, Rosa — DOS 02/11/2026: amount still owed?",
  "Remaining amount due on invoice number 55512301 (Rosa Delgado), please, in dollars.",
  "For the February 11, 2026 visit, what does Rosa Delgado still owe us on invoice 55512301?",
  "Outstanding on invoice 55512301? Patient Rosa Delgado. A voided invoice owes nothing.",
]) { const m = fam(t); ok(m?.family === "invoice-balance" && m.slots.invoice === "55512301" && (!m.slots.dos || m.slots.dos === "2026-02-11"), `invoice paraphrase routes: ${t.slice(0, 60)}`); }
for (const t of [
  "Has invoice 55512301 for Rosa Delgado been paid off?",
  "How much has been paid so far on invoice 55512301?",
  "What was the amount billed on invoice 55512301 before payments?",
  "When was invoice 55512301 issued to Rosa Delgado?",
]) ok(fam(t)?.family !== "invoice-balance" && !["invoice.balance"].includes(classifyIntent(t)?.type ?? ""), `invoice near miss does not route: ${t.slice(0, 60)}`);

// ── a provider's day by meaning ──
const sched = [
  "What's the number of scheduled appointments Kelly Williams, NP has on 2026-12-03 at any location? Exclude test records and deleted records.",
  "On Dec 3, 2026 how many appointments are scheduled for Kelly Williams NP, all locations, leaving out test or deleted patient records?",
  "Kelly Williams, NP — 12/03/2026 — how many scheduled appointments in total across locations? Don't count deleted or test records.",
];
for (const t of sched) { const m = fam(t); ok(m?.family === "provider-day-scheduled-count" && m.slots.provider === "Kelly Williams, NP" && m.slots.date === "2026-12-03", `scheduled-count paraphrase routes: ${t.slice(0, 60)}`); }
const done = "Number of visits Raj Hicks, DO completed on 2026-03-09 across all locations, excluding test and deleted records?";
ok(fam(done)?.family === "provider-day-completed-count" && fam(done)?.slots.provider === "Raj Hicks, DO", "completed-count paraphrase routes");
for (const t of [
  "How many scheduled appointments does Kelly Williams, NP have on 2026-12-03 at Lakeside? Exclude test and deleted records.",
  "How many scheduled telehealth appointments does Kelly Williams, NP have on 2026-12-03? Exclude test and deleted records.",
  "How many scheduled appointments does Kelly Williams, NP have on 2026-12-03, including test records?",
  "How many scheduled appointments does Kelly Williams have on 2026-12-03? Exclude test and deleted records.", // untitled: could be a patient
  "How many appointments were cancelled for Kelly Williams, NP on 2026-12-03? Exclude test and deleted records.",
  "How many scheduled appointments did Kelly Williams, NP have between 2026-12-01 and 2026-12-03? Exclude test and deleted records.",
  "How many scheduled appointments does Kelly Williams, NP have on 2026-12-03 that are follow-ups? Exclude test and deleted records.",
]) ok(!/^provider-day/.test(fam(t)?.family ?? ""), `provider-day near miss does not route: ${t.slice(0, 70)}`);

// ── open slots by meaning ──
const slot = "How many available slots are left for Roy Nelson, MD at Prairie View on 2026-11-30?";
ok(fam(slot)?.family === "provider-open-slots" && fam(slot)?.slots.location === "Prairie View" && fam(slot)?.slots.date === "2026-11-30", "open-slot paraphrase routes with its location");
for (const t of [
  "How many available slots are there at Prairie View on 2026-11-30?",                          // no provider
  "What's the earliest available slot for Roy Nelson, MD at Prairie View on 2026-11-30?",       // asks for a time
  "How many available slots does Roy Nelson, MD have on 2026-11-30?",                           // no location
  "How many 30-minute available slots does Roy Nelson, MD have at Prairie View on 2026-11-30?", // duration
]) ok(fam(t)?.family !== "provider-open-slots", `open-slot near miss does not route: ${t.slice(0, 70)}`);

// ── field lookups: near misses and two intents ──
ok(classifyIntent("What is the phone number for Nina Patel (DOB 1990-04-02)?")?.type === "patient.phone", "phone lookup still routes");
ok(classifyIntent("What's the telephone number on file for Nina Patel, born 1990-04-02?")?.type === "patient.phone", "'telephone number' routes to phone");
for (const t of ["What's the phone number of Nina Patel's primary care doctor?", "Nina Patel's emergency contact phone number, please (DOB 1990-04-02).", "Does Nina Patel (DOB 1990-04-02) have a phone number on file?", "When was Nina Patel's phone number last changed?"])
  ok(classifyIntent(t)?.type !== "patient.phone", `phone near miss does not answer the patient's phone: ${t.slice(0, 60)}`);
ok(classifyIntent("Which practice is Nina Patel (born 1990-04-02) being referred to?")?.type !== "patient.referral-source", "referral destination is not the source");
ok(classifyIntent("Who sent the referral letter received 2025-06-02 for Nina Patel (DOB 1990-04-02)?")?.type === "patient.referral-source", "'who sent the referral letter' → referral source");
ok(classifyIntent("Why was Nina Patel (DOB 1990-04-02) referred, per the letter received 2025-06-02?")?.type === "document.content", "'why was X referred' → document reader");
ok(classifyIntent("What's still owed on invoice 55512301? Also tell me the patient's date of birth.")?.type?.startsWith("skip.") ?? false, "two field intents in one question → skip");
ok(classifyIntent("What is Nina Patel's date of birth?")?.type === "patient.dob", "an explicit DOB question still routes");
ok(classifyIntent("Referral letter received 2025-06-02 for Nina Patel (DOB 1990-04-02): which practice made the referral?")?.type === "patient.referral-source", "a DOB given as an identifier is not asked");

// ── a DOB written next to the name in a catalog phrasing (Set 1 replica run: name "X (DOB d)", DOB lost) ──
for (const [t, fam0, name, dob, k, v] of [
  ["Tetanus for Nina Patel (DOB 1990-04-02) on 2026-03-11: vaccine, vaccine and TIG, or nothing?", "tetanus-wound", "Nina Patel", "1990-04-02", "visit", "2026-03-11"],
  ["Tetanus for Patel, Nina, born 04/02/1990 on 2026-03-11: vaccine, vaccine and TIG, or nothing?", "tetanus-wound", "Patel, Nina", "1990-04-02", "visit", "2026-03-11"],
  ["What should Nina Patel (born April 2, 1990) have gotten for tetanus when they came in with a wound on 2026-03-11?", "tetanus-wound", "Nina Patel", "1990-04-02", "visit", "2026-03-11"],
  ["Nina Patel (DOB 1990-04-02) is on the books for 2026-12-01 at 14:00. Do we owe them a good faith estimate, and by when?", "good-faith-estimate", "Nina Patel", "1990-04-02", "date", "2026-12-01"],
  ["Patel, Nina, DOB 04/02/1990 is on the books for 2026-12-01 at 14:00. Do we owe them a good faith estimate, and by when?", "good-faith-estimate", "Patel, Nina", "1990-04-02", "date", "2026-12-01"],
  ["Nina Patel (d.o.b. 1990-04-02) is on the books for 2026-12-01 at 14:00. Do we owe them a good faith estimate, and by when?", "good-faith-estimate", "Nina Patel", "1990-04-02", "date", "2026-12-01"],
] as const) {
  const m = fam(t);
  ok(m?.family === fam0 && m.slots.name === name && m.slots.dob === dob && m.slots[k] === v, `name + DOB split: ${t.slice(0, 70)} → ${JSON.stringify(m?.slots)}`);
}
// hard negatives: nothing that is not a DOB clause is cut from a name, and two different DOBs leave none
ok(fam("Tetanus for Nina Patel on 2026-03-11: vaccine, vaccine and TIG, or nothing?")?.slots.name === "Nina Patel" && !fam("Tetanus for Nina Patel on 2026-03-11: vaccine, vaccine and TIG, or nothing?")?.slots.dob, "no DOB clause → name untouched, no DOB");
ok(fam("Tetanus for Nina Bornstein on 2026-03-11: vaccine, vaccine and TIG, or nothing?")?.slots.name === "Nina Bornstein", "a surname starting with 'Born' is not a DOB clause");
ok(fam("Tetanus for Nina Patel (DOB unknown) on 2026-03-11: vaccine, vaccine and TIG, or nothing?")?.slots.dob === undefined, "an unparsable DOB is not invented");
{ const m = fam("I want to make sure we got the tetanus part right for Nina Patel, DOB 1991-01-01 (born 1990-04-02), seen 2026-03-11."); ok(!m || !m.slots.dob || m.slots.dob === "1990-04-02" && !/DOB/.test(m.slots.name), `two DOBs never yield a DOB-carrying name: ${JSON.stringify(m?.slots)}`); }

// ── generalist: never in a solved family's domain, never a ranking ──
for (const t of ["Is a good faith estimate owed to Nina Patel for her 2026-12-01 14:00 visit, and by what date?", "Who signed the referral letter received 2025-06-02 for Nina Patel?", "Which provider had the fewest completed visits in May 2026?", "What was billed on invoice 55512301?"])
  ok(generalistBlocked(t) !== "", `generalist blocked: ${t.slice(0, 60)}`);
ok(generalistBlocked("Which provider is Nina Patel's appointment with on 2026-12-01?") === "", "generalist still allowed on a plain appointment lookup");

console.log(fails ? `\n✗ ${fails} routing test(s) failed` : "\nALL PASS");
process.exit(fails ? 1 : 0);
