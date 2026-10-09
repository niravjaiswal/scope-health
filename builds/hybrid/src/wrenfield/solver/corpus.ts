/**
 * Message corpus for the compiler bench: Set 1's six workflow messages, the practice new/established
 * message, the bench/loop catalog workflows, and meaning-preserving rewordings of each (heading style,
 * "today" phrasing, tables written as bullet lists, title line).
 */
import { readFileSync } from "node:fs";

export type CorpusMsg = { id: string; base: string; variant: string; text: string; expectExample: boolean };
const FIX = new URL("../../../fixtures/", import.meta.url).pathname;
const BENCH = new URL("../../../bench/loop/catalog.mjs", import.meta.url).pathname;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const written = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return `${MONTHS[m - 1]} ${d}, ${y}`; };

/** Markdown tables → "- Header: cell; Header: cell" bullets (policyText.tablesIn reads both). */
export function tablesAsBullets(raw: string): string {
  const lines = raw.split("\n"); const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\|/.test(lines[i]) && /^\s*\|[\s|:-]+\|?\s*$/.test(lines[i + 1] ?? "")) {
      const cells = (l: string) => l.trim().replace(/^\|/, "").replace(/\|\s*$/, "").split("|").map((x) => x.trim());
      const h = cells(lines[i]); let j = i + 2;
      for (; j < lines.length && /^\s*\|/.test(lines[j]); j++) { const c = cells(lines[j]); out.push("- " + h.map((x, k) => `${x}: ${c[k] ?? ""}`).join("; ")); }
      i = j - 1; continue;
    }
    out.push(lines[i]);
  }
  return out.join("\n");
}
export const VARIANTS: Record<string, (t: string) => string> = {
  orig: (t) => t,
  // heading style + today phrasing + title line
  restyle: (t) => t.replace(/^##+\s+(.+)$/gm, "**$1**").replace(/Today is (\d{4}-\d{2}-\d{2})/g, (_m, d) => `The current date is ${written(d)}`).replace(/^From (?:the )?([^:\n]+):\s*(.+)$/m, "Message from $1 — re: $2"),
  bullets: (t) => tablesAsBullets(t),
};

function base(): Array<{ id: string; text: string }> {
  const out: Array<{ id: string; text: string }> = [];
  for (const l of readFileSync(FIX + "set1-items.jsonl", "utf8").split("\n").filter(Boolean)) { const i = JSON.parse(l); if (i.kind === "message" && i.text.length > 300) out.push({ id: `set1-${i.n}`, text: i.text }); }
  const pr = JSON.parse(readFileSync(FIX + "practice-queue.json", "utf8")).items.find((i: any) => i.kind === "message" && /established/i.test(i.text));
  if (pr) out.push({ id: "practice-new-established", text: pr.text });
  // bench/loop catalog: the MSG object literal, read as text (template literals with \` escapes only).
  try {
    const src = readFileSync(BENCH, "utf8"); const body = src.slice(src.indexOf("const MSG = {"), src.indexOf("\n};", src.indexOf("const MSG = {")));
    for (const m of body.matchAll(/\n  (\w+): `((?:[^`\\]|\\.)*)`/g)) out.push({ id: `loop-${m[1]}`, text: m[2].replace(/\\`/g, "`").replace(/\\\$/g, "$") });
  } catch { /* catalog absent: corpus without it */ }
  return out;
}

export function corpus(variants: string[] = Object.keys(VARIANTS)): CorpusMsg[] {
  const out: CorpusMsg[] = [];
  for (const b of base()) for (const v of variants) {
    const text = VARIANTS[v](b.text); if (v !== "orig" && text === b.text) continue;
    out.push({ id: v === "orig" ? b.id : `${b.id}~${v}`, base: b.id, variant: v, text, expectExample: !/^loop-(invoiceCount|docCount|dashToday)$/.test(b.id) });
  }
  return out;
}
