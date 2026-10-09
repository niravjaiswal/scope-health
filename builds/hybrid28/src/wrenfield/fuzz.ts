/**
 * Fuzz the inference layer: a random synthetic clinic + hundreds of randomized
 * questions (lookups, counts, the new/established rule, specialty, next-appointment,
 * non-existent entities, garbage). An independent oracle computes the true answer;
 * the pipeline is scored CORRECT / WRONG / SKIP / MODEL. WRONG must be ~0 (a wrong
 * answer is −1; skip/model are safe).
 */
import { format, MessageStore, type ClinicIndex, type PatientRecord, type Appointment, type Provider, type Doc } from "./inference.js";
import { toPlan, params, exec, compiler } from "./run.js";

// ── seeded RNG (reproducible; avoids Math.random for determinism) ──
let seed = Number(process.argv[2] ?? 12345) >>> 0;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)];
const chance = (p: number) => rnd() < p;
const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const randDate = () => iso(2023 + Math.floor(rnd() * 4), 1 + Math.floor(rnd() * 12), 1 + Math.floor(rnd() * 28));

// ── pools ──
const FIRST = ["Jack", "Guadalupe", "Randy", "Julie", "Mary", "David", "Anna", "Omar", "Priya", "Chen", "Sofia", "Luca", "Maria", "Noah", "Zoe", "Ivan"];
const LAST = ["Williams", "Driscoll", "Singh", "Martínez", "Okafor", "Brown", "Morales", "Ward", "Nguyen", "Kowalski", "Fernández", "Okonkwo", "Haddad"];
const SPECIALTIES = ["Internal Medicine", "Family Medicine", "Pediatrics", "Cardiology", "Dermatology", "Orthopedics"];
const STATUSES = ["Completed", "Scheduled", "Cancelled", "Late cancel", "No-show"];
const EXCLUDED_SVC = ["Lab draw", "Immunization", "X-ray", "Ultrasound", "Electrocardiogram", "Allergy injection", "Anticoagulation check"];
const NORMAL_SVC = ["Office visit", "Follow-up visit", "Sick visit", "Physical", "Wound care", "Telehealth visit"];
const PRACTICES = ["Plains Dermatology Associates", "Harbor Cardiology", "Summit Orthopedics", "Northgate Pediatrics", "Riverside Family Care"];
const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();

// ── generate a synthetic clinic ──
const providerNames = Array.from(new Set(Array.from({ length: 8 }, () => `${pick(FIRST)} ${pick(LAST)}`)));
const providers = new Map<string, Provider>(providerNames.map((n) => [n, { name: n, specialty: pick(SPECIALTIES), active: chance(0.85) }]));
const PTITLE = ["MD", "DO", "PA", "NP"];
const provTitle = new Map(providerNames.map((n) => [n, pick(PTITLE)]));

const patients: PatientRecord[] = [];
const usedNames = new Set<string>();
for (let i = 0; i < 40; i++) {
  let name = `${pick(FIRST)} ${pick(LAST)}`; while (usedNames.has(name)) name = `${pick(FIRST)} ${pick(LAST)}`; usedNames.add(name);
  const appts: Appointment[] = Array.from({ length: Math.floor(rnd() * 6) }, () => ({
    dateISO: randDate(), provider: pick(providerNames), status: pick(STATUSES),
    service: chance(0.25) ? pick(EXCLUDED_SVC) : pick(NORMAL_SVC), location: "Northgate",
  }));
  const docs: Doc[] = chance(0.4) ? [{ title: "Referral letter", kind: "referral letter", receivedISO: randDate(), source: pick(PRACTICES) }] : [];
  patients.push({
    id: `p${i}`, name, dobISO: randDate(),
    demographics: { ...(chance(0.8) ? { phone: `(620) ${100 + Math.floor(rnd() * 900)}-${1000 + Math.floor(rnd() * 9000)}` } : {}), ...(chance(0.5) ? { email: `${norm(name).replace(" ", ".")}@wrenmail.example` } : {}), ...(chance(0.7) ? { address: `${1 + Math.floor(rnd() * 999)} Pine Way, Harbor Glen, KS` } : {}) },
    appointments: appts, documents: docs,
  });
}
// adversarial: a patient whose name collides with a provider's name
{
  const collide = pick(providerNames);
  patients.push({ id: "pC", name: collide, dobISO: randDate(), demographics: { phone: "(620) 555-0000" }, appointments: [], documents: [] });
}
const index: ClinicIndex = {
  providers, appointments: patients.flatMap((p) => p.appointments),
  nameIsPatient: (name) => patients.some((p) => norm(p.name) === norm(name)),
  findPatient: (name, dob) => { const c = patients.filter((p) => norm(p.name) === norm(name)); if (dob) return c.find((p) => p.dobISO === dob) ?? null; return c.length === 1 ? c[0] : null; },
  byDate: () => [],
};
const prov = (n: string) => `${n}, ${provTitle.get(n)}`;

// ── independent oracle for new/established (from the spec) ──
const EXCL = new Set(EXCLUDED_SVC.map(norm));
const d2u = (s: string) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); };
function oracleNE(p: PatientRecord, providerName: string, visitISO: string): string {
  const [vy, vm, vd] = visitISO.split("-").map(Number);
  const startU = Date.UTC(vy - 3, vm - 1, vm === 2 && vd === 29 ? 28 : vd) + 86400000;
  const endU = d2u(visitISO) - 86400000;
  const vspec = providers.get(providerName)?.specialty;
  const counting = p.appointments.filter((a) => norm(a.status) === "completed" && (a.provider === providerName || (vspec && providers.get(a.provider)?.specialty === vspec)) && !EXCL.has(norm(a.service)) && d2u(a.dateISO) >= startU && d2u(a.dateISO) <= endU);
  if (!counting.length) return "NEW";
  return `ESTABLISHED:${counting.reduce((a, b) => (d2u(a.dateISO) >= d2u(b.dateISO) ? a : b)).dateISO}`;
}

// ── question templates: each returns {text, expect} (expect=null means should-not-answer) ──
type Gen = () => { text: string; expect: string | null };
const someP = () => pick(patients);
const templates: Gen[] = [
  () => { const p = someP(); const t = pick([`What phone number do we have on file for patient ${p.name} (born ${p.dobISO})?`, `What's the phone number for ${p.name}?`, `Phone number on file for ${p.name}?`]); return { text: t, expect: p.demographics.phone ?? null }; },
  () => { const p = someP(); return { text: `What email address do we have for ${p.name} (born ${p.dobISO})?`, expect: p.demographics.email ?? null }; },
  () => { const p = someP(); return { text: `What is the address on file for patient ${p.name}?`, expect: p.demographics.address ?? null }; },
  () => { const p = someP(); return { text: pick([`Give me the date of birth for patient ${p.name}.`, `What is ${p.name}'s date of birth?`]), expect: p.dobISO }; },
  () => { const p = patients.find((x) => x.documents.length) ?? someP(); const d = p.documents[0]; return { text: pick([`Referral letter received on ${d?.receivedISO} for patient ${p.name}: which practice made the referral?`, `Which practice referred ${p.name}?`]), expect: d?.source ?? null }; },
  () => { const p = someP(); const st = pick(STATUSES); const n = p.appointments.filter((a) => norm(a.status) === norm(st)).length; return { text: `How many ${st.toLowerCase()} appointments does ${p.name} have?`, expect: String(n) }; },
  () => { const p = someP(); const n = p.appointments.filter((a) => norm(a.status) === "no-show").length; return { text: `How many no-shows does ${p.name} have?`, expect: String(n) }; },
  () => { const pr = pick(providerNames); const d = randDate(); const n = index.appointments.filter((a) => a.provider === pr && a.dateISO === d).length; return { text: `How many appointments did ${prov(pr)} have on ${d}?`, expect: String(n) }; },
  () => { const pr = pick(providerNames); return { text: pick([`What specialty is ${prov(pr)} in?`, `What is ${prov(pr)}'s specialty?`]), expect: providers.get(pr)!.specialty }; },
  () => { const p = someP(); const up = p.appointments.filter((a) => /scheduled/i.test(a.status)).sort((a, b) => a.dateISO.localeCompare(b.dateISO))[0]; return { text: `When is ${p.name}'s next appointment?`, expect: up?.dateISO ?? null }; },
  () => { const p = someP(); const pr = pick(providerNames); const d = randDate(); return { text: pick([`Is ${p.name} a new patient or established for the visit with ${prov(pr)} on ${d}?`, `Billing question: ${p.name}, visit with ${prov(pr)} on ${d}. Is that a new or an established patient visit?`]), expect: oracleNE(p, pr, d) }; },
  // rule edge: Feb-29 visit date (window uses Feb-28 three years earlier)
  () => { const p = someP(); const pr = pick(providerNames); const d = `2024-02-29`; return { text: `Is ${p.name} new or established for the visit with ${prov(pr)} on ${d}?`, expect: oracleNE(p, pr, d) }; },
  // non-existent patient → should NOT answer
  () => ({ text: `What phone number do we have for patient ${pick(FIRST)} ${pick(["Zzyzx", "Nonexistent", "Fakeson"])}?`, expect: null }),
  // typo'd name (won't resolve) → should NOT answer
  () => { const p = someP(); return { text: `What is the phone number for ${p.name.replace(/.$/, "x")}?`, expect: null }; },
  // relative date (unresolvable) count → should skip/model, never wrong
  () => { const p = someP(); return { text: `How many appointments does ${p.name} have last month?`, expect: null }; },
  // garbage / out-of-domain → should NOT answer
  () => ({ text: pick(["What is the meaning of life?", "How do I reset my password?", "What's the weather today?", "Tell me a joke about doctors.", "How many moons does Jupiter have?"]), expect: null }),
];

// phrasing noise that must NOT change the answer
const WRAP = [(t: string) => t, (t: string) => `Quick question — ${t}`, (t: string) => `${t} Thanks!`, (t: string) => `Hi, could you check: ${t}`, (t: string) => `${t.replace(/\?$/, "")}, please?`, (t: string) => `FYI, we need this today. ${t}`];
const mutate = (t: string) => (chance(0.5) ? pick(WRAP)(t) : t);

async function main() {
  const store = new MessageStore(compiler);
  await store.ingest("New or established? A patient is established if they had a completed appointment with the same provider or same specialty in the 3 years before the visit…");

  const N = Number(process.argv[3] ?? 600);
  const tally = { CORRECT: 0, WRONG: 0, SKIP: 0, MODEL: 0 };
  let answerable = 0, miss = 0;
  const wrongs: string[] = [];

  for (let i = 0; i < N; i++) {
    const { text: text0, expect } = pick(templates)();
    const text = mutate(text0);
    if (expect !== null) answerable++;
    const plan = toPlan(text);
    let cat: keyof typeof tally;
    let got: string | null = null;
    if (!plan) cat = "MODEL";
    else {
      const raw = exec(plan, index, store, params(text));
      if (raw == null) cat = "SKIP";
      else { got = format[(plan.output.answerType as keyof typeof format)](raw); cat = expect !== null && got === expect ? "CORRECT" : "WRONG"; }
    }
    if (cat === "WRONG" && wrongs.length < 12) wrongs.push(`  Q: ${text}\n     expected=${JSON.stringify(expect)} got=${JSON.stringify(got)}`);
    if ((cat === "SKIP" || cat === "MODEL") && expect !== null) { miss++; if (process.env.FUZZ_MISSES) console.log(`  miss [${cat}${plan ? " " + plan.type : ""}] ${text}`); }
    tally[cat]++;
  }

  console.log(`\n=== fuzz: ${N} questions (seed ${process.argv[2] ?? 12345}) ===`);
  console.log(`  CORRECT : ${tally.CORRECT}`);
  console.log(`  WRONG   : ${tally.WRONG}   ← must be ~0 (−1 each)`);
  console.log(`  SKIP    : ${tally.SKIP}    (safe)`);
  console.log(`  MODEL   : ${tally.MODEL}   (deferred to model tier, safe)`);
  console.log(`  answerable=${answerable}  deterministic-coverage=${((tally.CORRECT / answerable) * 100).toFixed(1)}%  coverage-miss=${miss}`);
  if (wrongs.length) { console.log(`\n  WRONG examples:`); console.log(wrongs.join("\n")); }
}
main().catch((e) => { console.error(e); process.exit(1); });
