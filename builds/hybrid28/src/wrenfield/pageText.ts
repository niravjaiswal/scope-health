/** Page text for the LLM workflow executor (offline benches): an innerText-like walk of a DOM document. */
/** innerText-like serialisation: block elements on their own lines, table rows as " | "-joined cells. */
export function pageText(doc: Document): string {
  const out: string[] = []; let line = "";
  const flush = () => { if (line.trim()) out.push(line.replace(/\s+/g, " ").trim()); line = ""; };
  const BLOCK = /^(DIV|P|SECTION|HEADER|H1|H2|H3|H4|LI|UL|OL|DL|DT|DD|ARTICLE|TABLE|THEAD|TBODY|FORM|NAV|MAIN|FOOTER)$/;
  const walk = (n: Node) => {
    if (n.nodeType === 3) { line += n.nodeValue; return; }
    if (n.nodeType !== 1) return;
    const el = n as Element; if (/^(SCRIPT|STYLE)$/.test(el.tagName)) return;
    if (el.tagName === "IMG") { line += ` [image: ${el.getAttribute("alt") ?? ""}] `; return; }
    if (el.tagName === "TR") { flush(); out.push([...el.children].map((c) => (c.textContent ?? "").replace(/\s+/g, " ").trim()).join(" | ")); return; }
    if (el.tagName === "DT") { flush(); line += (el.textContent ?? "").trim() + ": "; return; }
    if (BLOCK.test(el.tagName)) flush();
    if (el.getAttribute("aria-label") && /^(SECTION|DIV)$/.test(el.tagName) && el.getAttribute("role") !== "presentation") { flush(); out.push(`[${el.getAttribute("aria-label")}]`); }
    for (const c of el.childNodes) walk(c);
    if (BLOCK.test(el.tagName) && el.tagName !== "DT") flush();
  };
  walk(doc.body); flush();
  return out.join("\n");
}
