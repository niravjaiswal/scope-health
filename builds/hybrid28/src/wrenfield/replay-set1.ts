/**
 * Gating replay: every real Set 1 queue item (fixtures/set1-items.jsonl: 16 messages, 224 tasks)
 * through handleItem with a fake clinic where EVERY named patient resolves (worst case for a
 * mis-routed intent) and no live reader answers. No browser, no model. Exit 1 if any task of a
 * family we don't solve gets an answer, or any answer is a date of birth.
 *   npx tsx src/wrenfield/replay-set1.ts
 */
import { readFileSync } from "node:fs";
import { MessageStore, Classifier, handleItem, type ClinicIndex, type PatientRecord, type QueryPlan } from "./inference.js";
import { toPlan, params, exec, compiler } from "./run.js";
import { familyMatch, FAMILY_SOLVERS, KEYWORD_OK } from "./families.js";

const items = readFileSync(new URL("../../fixtures/set1-items.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { kind: "task" | "message"; text: string });
const patient = (name: string, dob?: string): PatientRecord => ({ id: "/patients/x", name, dobISO: dob ?? "1980-01-01", demographics: { phone: "(913) 944-1314", email: "a@b.c", address: "1 Main St" }, appointmentsComplete: true,
  appointments: [{ dateISO: "2026-01-08", provider: "Amy Fuller", status: "Scheduled", service: "Office visit", location: "Northgate" }],
  documents: [{ title: "Referral letter from Granite Fork Internal Medicine", kind: "referral letter", receivedISO: "2024-12-20", source: "Granite Fork Internal Medicine", docHref: "/documents/d1" }] });
const index: ClinicIndex = {
  providers: new Map([["Amy Fuller", { name: "Amy Fuller", specialty: "Family Medicine", active: true }]]), hasSpecialties: true, appointments: [], byDate: () => [],
  findPatient: (name, dob) => patient(name, dob), nameIsPatient: () => true,
  readDocument: async () => "SOME DOCUMENT VALUE", answerGeneralist: async () => "Something on the page",
  invoicePage: async () => null, providerDay: async () => null,
};
const store = new MessageStore(compiler);
const classifier = new Classifier(toPlan, async () => { throw new Error("disabled"); }, store);
const deps = { index, store, classifier, params, verify: (_: QueryPlan, raw: unknown) => raw != null, exec };

(async () => {
  const byFamily = new Map<string, { answered: number; skipped: number; answers: string[] }>();
  let dobAnswers = 0, bad = 0, n = 0; const whys = new Map<string, number>();
  for (const it of items) {
    n++;
    const out = await handleItem(it, deps);
    if (it.kind === "message") continue;
    const fam = familyMatch(it.text)?.family ?? "(none)";
    const rec = byFamily.get(fam) ?? { answered: 0, skipped: 0, answers: [] }; byFamily.set(fam, rec);
    if ("answer" in out) {
      rec.answered++; rec.answers.push(`n=${n} ${out.answer}`);
      if (/^\d{4}-\d{2}-\d{2}$/.test(out.answer)) dobAnswers++;
      if (fam === "(none)" || (!KEYWORD_OK[fam] && !FAMILY_SOLVERS.has(fam))) bad++;
    } else { rec.skipped++; const w = (out as any).why ?? "?"; whys.set(`${fam} :: ${w.replace(/\d{4}-\d{2}-\d{2}/g, "<date>").replace(/"[^"]*"/g, "<x>")}`, (whys.get(`${fam} :: ${w.replace(/\d{4}-\d{2}-\d{2}/g, "<date>").replace(/"[^"]*"/g, "<x>")}`) ?? 0) + 1); }
  }
  console.log("\nskip reasons:"); for (const [k, v] of [...whys].sort((a, b) => b[1] - a[1])) console.log(`${String(v).padStart(3)}  ${k}`);
  for (const [f, r] of [...byFamily].sort((a, b) => b[1].answered + b[1].skipped - a[1].answered - a[1].skipped)) console.log(`${String(r.answered + r.skipped).padStart(3)} ${f.padEnd(34)} answered=${String(r.answered).padStart(3)} skipped=${String(r.skipped).padStart(3)}  ${r.answers.slice(0, 6).join(" | ")}`);
  const lab = byFamily.get("lab-report-triage");
  const ok = dobAnswers === 0 && bad === 0 && lab?.answered === 6 && lab.answers.every((a) => a.endsWith("NOT_COVERED"));
  console.log(`\n${ok ? "✓" : "✗"} replay: ${dobAnswers} DOB answers, ${bad} answers in unsolved families, lab NOT_COVERED=${lab?.answered ?? 0} (expect 6)`);
  process.exit(ok ? 0 : 1);
})();
