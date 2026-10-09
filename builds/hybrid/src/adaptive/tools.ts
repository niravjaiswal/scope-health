/**
 * The agent's ACTION SPACE over the live clinic — the same primitives on every Wrenfield version, so
 * the model discovers where things live at runtime instead of relying on hardcoded routes. Each tool
 * returns a compact Observation (the model reads it; the grounding gate searches it). Navigation/read
 * tools are also the steps a learned Plan replays; `answer`/`give_up` terminate the loop.
 *
 * Reuses the wrenfield Crawler: decoded text (font-deobfuscated), patient resolution, vision OCR.
 */
import type { Crawler } from "../wrenfield/crawl.js";
import type { Observation } from "./types.js";
import { askDocument } from "../wrenfield/llm.js";

export interface ToolCtx { crawler: Crawler; note: (s: string) => void }
export interface Tool {
  name: string;
  def: any; // OpenAI-style function tool definition
  run: (ctx: ToolCtx, args: Record<string, any>) => Promise<Observation>;
  terminal?: boolean;
}

const ok = (tool: string, text: string): Observation => ({ tool, text, ok: true });
const fail = (tool: string, text: string): Observation => ({ tool, text, ok: false });
const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) + " …[truncated]" : s);

const linksOf = (c: Crawler) =>
  (c as any).evalApp(`return [...new Set([...doc.querySelectorAll('a[href^="/"]')].filter(a=>a.getAttribute('aria-hidden')!=='true'&&a.getAttribute('tabindex')!=='-1').map(a=>{const h=a.getAttribute('href').split('?')[0];const t=(a.textContent||'').replace(/\\s+/g,' ').trim().slice(0,40);return h+(t?'  "'+t+'"':'');}))].slice(0,45)`).catch(() => [] as string[]);

export const TOOLS: Tool[] = [
  {
    name: "goto",
    def: { type: "function", function: { name: "goto", description: "Navigate to an in-app path (starts with /). Returns the page's visible text and its in-app links.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
    run: async ({ crawler }, a) => {
      const p = String(a.path || ""); if (!p.startsWith("/")) return fail("goto", "path must start with /");
      const okNav = await crawler.navTo(p, /./, 9000).catch(() => false);
      if (!okNav) return fail("goto", `could not load ${p}`);
      const text = await crawler.decodedText().catch(() => "");
      const links = await linksOf(crawler);
      return ok("goto", `URL ${p}\nLINKS: ${links.join(" | ")}\nTEXT:\n${cap(text, 3000)}`);
    },
  },
  {
    name: "read_text",
    def: { type: "function", function: { name: "read_text", description: "Read the current page's full visible (de-obfuscated) text.", parameters: { type: "object", properties: {} } } },
    run: async ({ crawler }) => ok("read_text", cap(await crawler.decodedText().catch(() => ""), 5000)),
  },
  {
    name: "links",
    def: { type: "function", function: { name: "links", description: "List the in-app links (tabs, rows, nav) on the current page.", parameters: { type: "object", properties: {} } } },
    run: async ({ crawler }) => ok("links", (await linksOf(crawler)).join("\n") || "(no links)"),
  },
  {
    name: "search_patient",
    def: { type: "function", function: { name: "search_patient", description: "Resolve a patient to their chart path by name and (if given) date of birth YYYY-MM-DD. Returns /patients/{id} when unambiguous.", parameters: { type: "object", properties: { name: { type: "string" }, dob: { type: "string" } }, required: ["name"] } } },
    run: async ({ crawler }, a) => {
      // Delegate to baseline's battle-tested resolver: DOB path, or sound-alike paginated name search
      // read until past the name (handles common surnames, "Last, First", merged/restricted records).
      const { resolvePatient } = await import("../wrenfield/patientResolve.js");
      const r = await resolvePatient(crawler as any, String(a.name || ""), a.dob ? String(a.dob) : undefined).catch(() => null);
      if (r?.chosen) return ok("search_patient", `resolved ${String(r.chosen.href).split("?")[0]}  (${r.chosen.name})`);
      return fail("search_patient", r?.why || `could not resolve "${a.name}"`);
    },
  },
  {
    name: "read_table",
    def: { type: "function", function: { name: "read_table", description: "Read the tables on the current page. With `match`, return the row whose cells contain that text, keyed by column header. Use to find a row by a date/code/name.", parameters: { type: "object", properties: { match: { type: "string" } } } } },
    run: async ({ crawler }, a) => {
      const match = a.match ? String(a.match).toLowerCase() : "";
      const out = await (crawler as any).evalApp(`return (function(){
        const want=${JSON.stringify(match)};
        const tbls=[...doc.querySelectorAll('table')]; const res=[];
        for(const t of tbls.slice(0,4)){ const hs=[...t.querySelectorAll('thead th,[role=columnheader]')].map(h=>(h.innerText||'').trim()); const trs=[...t.querySelectorAll('tbody tr')];
          const rows=[]; for(const tr of trs){ const tds=[...tr.querySelectorAll('td')].map(td=>(td.innerText||'').replace(/\\s+/g,' ').trim()); if(!tds.length)continue; if(want&&!tds.join(' | ').toLowerCase().includes(want))continue; rows.push(hs.length?hs.map((h,i)=>h+': '+(tds[i]||'')).join(' | '):tds.join(' | ')); if(rows.length>=(want?3:8))break; }
          if(rows.length)res.push('['+hs.join(', ')+']\\n'+rows.join('\\n')); }
        return res.join('\\n---\\n')||'(no matching rows)';
      })()`).catch(() => "(table read failed)");
      return ok("read_table", cap(String(out), 3000));
    },
  },
  {
    name: "read_document",
    def: { type: "function", function: { name: "read_document", description: "OCR a scanned document by its link path and extract the answer to `question` from it (for referral letters, lab reports, etc.).", parameters: { type: "object", properties: { doc_href: { type: "string" }, question: { type: "string" } }, required: ["doc_href", "question"] } } },
    run: async ({ crawler }, a) => {
      const href = String(a.doc_href || "");
      const png = (await crawler.fetchDocImage(href).catch(() => null)) || (await crawler.captureDoc(href).catch(() => null));
      if (!png) return fail("read_document", "could not capture the document image");
      const v = await askDocument(String(a.question || "What does this document say?"), png).catch(() => null);
      return v ? ok("read_document", `document value: ${v}`) : fail("read_document", "no value read from the document");
    },
  },
  {
    name: "answer",
    terminal: true,
    def: { type: "function", function: { name: "answer", description: "Give the final answer. `evidence` MUST be text you saw in an observation that contains the value verbatim — if you cannot quote the source, do NOT answer, keep exploring or give_up.", parameters: { type: "object", properties: { value: { type: "string" }, evidence: { type: "string" } }, required: ["value", "evidence"] } } },
    run: async (_c, a) => ok("answer", JSON.stringify({ value: String(a.value ?? ""), evidence: String(a.evidence ?? "") })),
  },
  {
    name: "give_up",
    terminal: true,
    def: { type: "function", function: { name: "give_up", description: "Give up on this question (it will be skipped — safe, costs nothing). Use when the answer cannot be found or grounded.", parameters: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] } } },
    run: async (_c, a) => ok("give_up", String(a.reason || "no reason")),
  },
];

export const TOOL_DEFS = TOOLS.map((t) => t.def);
export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
