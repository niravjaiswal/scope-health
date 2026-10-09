/**
 * memoGate.test: message classification and the memo gate (MEMO-GATE.md), offline (no model: the model classifier returns
 * nothing, so a message the structure does not decide compiles as noise here; live, the model decides fact / noise as before).
 *   (a) Site C (bench/sites, 28 workflows): its 42 messages classify as the queue says: 28 workflows, 5 amendments each tied to its
 *       memo (effective date kept), 1 revocation tied to its memo, 8 notes not structural;
 *   (b) Set 1 parity: the 16 messages compile to the kinds the Set 1 runs logged (workflows 1 30 76 120 150 198, amendment 62,
 *       facts 132 164 by the model, the rest noise); no Set 1 task loses its family (familyBlocked) and no keyword-tier Set 1 task
 *       is blocked by a Set 1 memo;
 *   (c) practice: the new/established memo compiles to its rule and keeps its family; the note is not structural;
 *   (d) Site C tasks: matched to their own memo; the two 278-run wrong answers (i109, i163) are governed; the c01 tasks leave the
 *       practice family (the c01 memo does not parse as new/established) and are governed by c01; tasks after the revocation are
 *       skipped as revoked; no Site C task is answered by the keyword tier / lookup / generalist through handleItem.
 *   npx tsx src/wrenfield/memoGate.test.ts
 */
import { readFileSync } from "node:fs";
import { classifyMemo, matchMemo, memoInfo, mergeAmendment, type MemoRef } from "./memoGate.js";
import { MessageStore, Classifier, handleItem, type ClinicIndex, type PatientRecord, type QueryPlan } from "./inference.js";
import { compiler, toPlan, params, exec } from "./run.js";
import { familyMatch, KEYWORD_OK, FAMILY_SOLVERS } from "./families.js";

delete process.env.LLM_BASE_URL; delete process.env.LLM_API_KEY; // offline: the model classifier answers nothing
const root = new URL("../../", import.meta.url);
let pass = 0, fail = 0;
const t = (ok: boolean, what: string) => { if (ok) pass++; else { fail++; console.log("✗ " + what); } };
const quiet = async <T>(f: () => Promise<T>): Promise<T> => { const w = process.stdout.write.bind(process.stdout); const l = console.log; (process.stdout as any).write = () => true; console.log = () => {}; try { return await f(); } finally { (process.stdout as any).write = w; console.log = l; } };

// ════════ (a) Site C messages ════════
const qC = JSON.parse(readFileSync(new URL("bench/sites/queues/queue-C.json", root), "utf8"));
const whyC = JSON.parse(readFileSync(new URL("bench/sites/queues/why-C.json", root), "utf8"));
const itemsC: Array<{ k: string; kind: string; text: string; why: any }> = qC.items.map((it: any, i: number) => ({ k: "i" + String(i + 1).padStart(3, "0"), kind: it.kind, text: it.text, why: whyC["i" + String(i + 1).padStart(3, "0")] }));
{
  const memos: Array<{ raw: string; fam: string }> = []; const got: Record<string, number> = {};
  for (const it of itemsC.filter((x) => x.kind === "message")) {
    const c = classifyMemo(it.text, memos); const kind = c?.kind ?? "other"; got[kind] = (got[kind] ?? 0) + 1;
    const want = it.why.message === "workflow" || it.why.message === "amendment" || it.why.message === "revocation" ? it.why.message : "other";
    t(kind === want, `Site C ${it.k}: ${want} classified ${kind}: ${it.text.split("\n")[0].slice(0, 70)}`);
    if (c?.target !== undefined) t(memos[c.target].fam === it.why.family, `Site C ${it.k}: ${kind} of ${it.why.family}, tied to ${memos[c.target].fam}`);
    if (c?.kind === "workflow") memos.push({ raw: it.text, fam: it.why.family });
  }
  t(got.workflow === 28 && got.amendment === 5 && got.revocation === 1, `Site C kinds ${JSON.stringify(got)} (want 28 / 5 / 1 / 8 other)`);
  const c05 = itemsC.find((x) => x.k === "i069")!; const c05m = memos.find((m) => m.fam === "c05-noshow-strikes")!;
  t(classifyMemo(c05.text, [c05m])?.effective === "2026-08-01", "c05 amendment keeps its effective date 2026-08-01");
}

// ════════ the shift's store over a queue (compiler + memo gate), offline ════════
async function storeOver(items: Array<{ kind: string; text: string }>, onTask?: (text: string, s: MessageStore, i: number) => Promise<void> | void) {
  const s = new MessageStore(compiler); let i = 0;
  for (const it of items) { i++; if (it.kind === "message") await quiet(() => s.ingest(it.text)); else if (onTask) await onTask(it.text, s, i); }
  return s;
}

// ════════ (b) Set 1 parity ════════
const set1 = readFileSync(new URL("fixtures/set1-items.jsonl", root), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { kind: string; text: string });
{
  // the Set 1 runs' logged kinds (146 … 278: 7 of 9 runs agree on every message; s3a logged 76 as noise, r4 30/120/150 as noise — model flips)
  const want = ["workflow", "noise", "noise", "workflow", "noise", "amendment", "workflow", "noise", "noise", "workflow", "fact", "workflow", "fact", "noise", "workflow", "noise"];
  let blockedKw = 0, dropped = 0, gatedFamilySolver = 0;
  const s = await storeOver(set1, (text, st) => {
    const f = familyMatch(text); if (!f) return;
    if (st.familyBlocked(f.family, text)) dropped++;
    const g = st.memoGate(text, f.family);
    if (KEYWORD_OK[f.family] && g.action === "governed") blockedKw++;
    if (FAMILY_SOLVERS.has(f.family) && g.action !== "none") gatedFamilySolver++; // (solver families never reach the gate; counted for the record)
  });
  const kinds = s.all().map((m) => m.kind);
  kinds.forEach((k, i) => { const w = want[i] === "fact" ? "noise" : want[i]; t(k === w, `Set 1 message ${i + 1} (${s.all()[i].raw.slice(0, 50)}): ${k}, logged ${want[i]}`); });
  t(s.all().filter((m) => m.memo).length === 6, `Set 1: 6 memos (lab, tetanus, recall, claims, filing, good faith), got ${s.all().filter((m) => m.memo).length}`);
  t(s.memos().every((e) => e.family && e.familyOk), "Set 1: every memo parses as its family: " + s.memos().map((e) => `${e.family}:${e.familyOk}`).join(" "));
  t(dropped === 0, `Set 1: no task loses its family (dropped ${dropped})`);
  t(blockedKw === 0, `Set 1: no keyword-tier task (phone / referral) governed by a Set 1 memo (blocked ${blockedKw})`);
  console.log(`  Set 1: family-solver tasks a memo would gate (never consulted): ${gatedFamilySolver}`);
}

// ════════ (b2) routing parity over the S3-A Set 1 log: its 205 answered tasks keep family and plan, and nothing new gates them ════════
{
  const log = readFileSync(new URL("fixtures/set1/run-s3a-set1.log", root), "utf8").split("\n").map((l) => { const i = l.indexOf('{"event":"item"'); if (i < 0) return null; try { return JSON.parse(l.slice(i)); } catch { return null; } }).filter(Boolean) as any[];
  const answered = log.filter((r) => r.kind === "task" && r.result && "answer" in r.result);
  const byText = new Map(answered.map((r) => [r.text, r]));
  let same = 0, diff = 0;
  await storeOver(set1, (text, st) => {
    const r = byText.get(text); if (!r) return;
    let f = familyMatch(text); if (f && st.familyBlocked(f.family, text)) f = null;
    const g = st.memoGate(text, f?.family ?? null);
    const ok = (f?.family ?? null) === r.family && (toPlan(text)?.type ?? null) === r.plan && g.action === "none";
    if (ok) same++; else { diff++; console.log(`✗ parity n=${r.n}: family ${r.family}→${f?.family ?? null} plan ${r.plan}→${toPlan(text)?.type ?? null} gate ${g.action} :: ${text.slice(0, 90)}`); }
  });
  t(answered.length === 205 && same === 205 && diff === 0, `Set 1 routing parity (S3-A log): ${same} of ${answered.length} answered tasks keep family, plan and an open gate`);
}

// ════════ (c) practice ════════
{
  const pq = JSON.parse(readFileSync(new URL("fixtures/practice-it-queue.json", root), "utf8"));
  const items = (pq.items ?? pq) as Array<{ kind: string; text: string }>;
  let dropped = 0;
  const s = await storeOver(items, (text, st) => { const f = familyMatch(text); if (f && st.familyBlocked(f.family, text)) dropped++; });
  const ne = s.all().find((m) => m.scope.includes("billing.new-or-established"));
  t(!!ne?.rule && !!ne.memo, "practice: the new/established memo compiles to its rule");
  t(s.all().filter((m) => m.memo).length === 2, "practice: 2 memos (lab, new/established)");
  t(dropped === 0, `practice: no task loses its family (dropped ${dropped})`);
  t(classifyMemo("The vending machine by the back entrance takes cards again, but the coin slot is still jammed.", []) === null, "practice note: not structural");
}

// ════════ (d) Site C tasks through the gate and handleItem ════════
{
  const patient = (name: string, dob?: string): PatientRecord => ({ id: "/patients/x", name, dobISO: dob ?? "1980-01-01", demographics: { phone: "(913) 944-1314" }, appointmentsComplete: true,
    appointments: [{ dateISO: "2027-01-08", provider: "Scott Tran", status: "Scheduled", service: "Office visit", location: "Northgate" }], documents: [] });
  const index: ClinicIndex = { providers: new Map([["Scott Tran", { name: "Scott Tran", specialty: "Family Medicine", active: true }]]), hasSpecialties: true, appointments: [], byDate: () => [],
    findPatient: (n, d) => patient(n, d), nameIsPatient: () => true, readDocument: async () => "SOME VALUE", answerGeneralist: async () => "Something on the page" };
  let own = 0, other = 0, none = 0, answered = 0, revokedOk = 0, revokedN = 0, c01drop = 0, c01gov = 0;
  const decisions = new Map<string, string>();
  const s = new MessageStore(compiler); const classifier = new Classifier(toPlan, async () => { throw new Error("off"); }, s);
  const deps = { index, store: s, classifier, params, verify: (_: QueryPlan, raw: unknown) => raw != null, exec, lookup: async () => ({ answer: "LOOKUP VALUE" }) };
  let revokedAt = Infinity;
  for (const it of itemsC) {
    if (it.kind === "message") { await quiet(() => s.ingest(it.text)); if (it.why.message === "revocation") revokedAt = Number(it.k.slice(1)); continue; }
    let fam = familyMatch(it.text);
    if (it.why.family === "c01-new-established" && fam && s.familyBlocked(fam.family, it.text)) { c01drop++; fam = null; }
    const g = s.memoGate(it.text, fam?.family ?? null);
    decisions.set(it.k, g.action);
    const fams = g.memos.map((e) => itemsC.find((x) => x.text === e.raw)?.why.family);
    if (g.action === "governed" || g.action === "touched") { if (fams.includes(it.why.family)) own++; else other++; } else if (g.action === "none") none++;
    if (it.why.family === "c01-new-established" && g.action === "governed" && fams.includes("c01-new-established")) c01gov++;
    if (it.why.family === "c15-audit-fee-change" && Number(it.k.slice(1)) > revokedAt) { revokedN++; if (g.action === "revoked") revokedOk++; }
    const out = await quiet(() => handleItem({ kind: "task", text: it.text }, { ...deps, family: fam }));
    if ("answer" in out && g.action !== "none") { answered++; console.log(`✗ ${it.k} answered under a memo (${g.action}): ${out.answer} :: ${it.text}`); }
  }
  const n = itemsC.filter((x) => x.kind === "task").length;
  console.log(`  Site C tasks ${n}: governed/touched by their own memo ${own}, by another memo ${other}, not gated ${none}`);
  t(own >= 200, `Site C: >= 200 of ${n} tasks gated by their own memo (${own})`);
  t(answered === 0, `Site C: no gated task answered by the keyword tier / lookup / generalist (${answered})`);
  t(decisions.get("i109") === "governed" && decisions.get("i163") === "governed", `i109 / i163 (the 278 run's wrong answers) governed: ${decisions.get("i109")} / ${decisions.get("i163")}`);
  t(c01drop >= 6 && c01gov >= 7, `c01: the practice family dropped (${c01drop}) and the task governed by c01 (${c01gov} of 9)`);
  t(revokedN === 4 && revokedOk === 4, `c15 after the revocation: ${revokedOk} of ${revokedN} revoked`);
}

// ════════ matching, small cases ════════
{
  const m1 = "From the front desk supervisor: is the patient's primary provider still here?\n\n## How to answer\n\n- `ACTIVE:` and the user name.\n- `LEFT:` and the date.\n\n## Examples\n\nIf someone asks: \"Is Richard Collins (DOB 1962-09-18)'s primary provider still with the group?\"\nThe answer is `LEFT:2026-04-30`.";
  const m2 = "From the billing office: payments received from a patient in a year\n\nUse the Payments table.\n\n## How to answer\n\nThe total: `1250.00`.\n\n## Examples\n\nIf someone asks: \"What did Ximena Watson (DOB 1965-09-20) pay us in total in 2025?\"\nThe answer is `10.00`.";
  const refs: MemoRef[] = [{ key: 0, info: memoInfo(m1) }, { key: 1, info: memoInfo(m2) }];
  t(matchMemo("Raymond Patel wants to see their own doctor. Still here?", refs)?.keys[0] === 0 || matchMemo("Is Ann Lee's primary provider still with the group?", refs)?.keys[0] === 0, "primary-provider memo matched");
  t(!matchMemo("What phone number do we have on file for Julie Martínez (born 2010-01-10)?", refs), "an unrelated phone question matches no memo");
  t(!matchMemo("How many visits did the clinic have today?", refs), "a generic visit count matches no memo");
  const info = memoInfo(m1); mergeAmendment(info, "From the front desk supervisor: new rule for departed doctors\n\nStarting 2026-11-01 answer `GONE:` instead of `LEFT:`.");
  t(info.tokens.includes("GONE:"), "an amendment's token joins its memo");
}

console.log(`${fail ? "✗" : "✓"} memoGate.test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
