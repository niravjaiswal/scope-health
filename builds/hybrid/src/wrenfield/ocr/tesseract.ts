/**
 * Tesseract OCR reader (CLI, installed in the agent image as `tesseract-ocr` + `tesseract-ocr-eng`).
 * Input: a PNG buffer (full document or a crop). Output: words with boxes + confidences (TSV), the
 * words regrouped into visual lines by vertical position, and plain text. Numeric fields use the
 * digit whitelist mode. Fully local and deterministic: no network, no model.
 */
import { spawn } from "node:child_process";

export interface OcrWord { text: string; left: number; top: number; width: number; height: number; conf: number; block: number; par: number; line: number }
export interface OcrLine { words: OcrWord[]; text: string; top: number; bottom: number }
export interface OcrResult { words: OcrWord[]; lines: OcrLine[]; text: string; ms: number; ok: boolean; error?: string }

export interface OcrOpts {
  /** page segmentation mode: 6 = one uniform block (tables), 4 = column of lines, 7 = single line, 11 = sparse. */
  psm?: number;
  /** restrict characters, e.g. "0123456789" for digit fields. */
  whitelist?: string;
  /** source DPI hint (rendered screenshots at 2x ≈ 192). */
  dpi?: number;
  timeoutMs?: number;
  /** extra -c key=value configs */
  config?: Record<string, string>;
}

export const TESSERACT = () => process.env.TESSERACT_PATH ?? "tesseract";

/** Parse tesseract TSV output (level 5 rows are words). */
export function parseTsv(tsv: string): OcrWord[] {
  const out: OcrWord[] = [];
  for (const ln of tsv.split("\n").slice(1)) {
    const c = ln.split("\t");
    if (c.length < 12 || c[0] !== "5") continue;
    const text = c.slice(11).join("\t").trim();
    if (!text) continue;
    out.push({ block: +c[2], par: +c[3], line: +c[4], left: +c[6], top: +c[7], width: +c[8], height: +c[9], conf: +c[10], text });
  }
  return out;
}

/** Group words into visual lines, robust to tesseract splitting table columns into separate blocks
 *  AND to scan skew: words are taken left→right and appended to the line whose RIGHTMOST word
 *  overlaps them vertically (≥ 40% of the smaller height), so a slightly tilted row stays one line. */
export function groupLines(words: OcrWord[]): OcrLine[] {
  if (!words.length) return [];
  const lines: OcrWord[][] = [];
  const overlap = (a: OcrWord, b: OcrWord) => Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  for (const w of [...words].sort((a, b) => a.left - b.left)) {
    let best: OcrWord[] | null = null, bestOv = 0;
    for (const l of lines) {
      const last = l[l.length - 1];
      if (last.left + last.width > w.left + 2) continue; // must be to the right of the line's end
      const ov = overlap(last, w) / Math.max(1, Math.min(last.height, w.height));
      if (ov >= 0.4 && ov > bestOv) { best = l; bestOv = ov; }
    }
    if (best) best.push(w); else lines.push([w]);
  }
  const out = lines.map((ws) => ({ words: ws, text: ws.map((w) => w.text).join(" "), top: Math.min(...ws.map((w) => w.top)), bottom: Math.max(...ws.map((w) => w.top + w.height)) }));
  out.sort((a, b) => (a.words[0].top + a.words[0].height / 2) - (b.words[0].top + b.words[0].height / 2));
  return out;
}

export async function ocr(png: Buffer, opts: OcrOpts = {}): Promise<OcrResult> {
  const t0 = Date.now();
  const args = ["stdin", "stdout", "-l", "eng", "--psm", String(opts.psm ?? 6), "--dpi", String(opts.dpi ?? 150)];
  const cfg: Record<string, string> = { ...(opts.config ?? {}) };
  if (opts.whitelist) cfg.tessedit_char_whitelist = opts.whitelist;
  cfg.preserve_interword_spaces = cfg.preserve_interword_spaces ?? "1";
  for (const [k, v] of Object.entries(cfg)) args.push("-c", `${k}=${v}`);
  args.push("tsv");
  return new Promise<OcrResult>((resolve) => {
    let out = "", err = "", done = false;
    const finish = (r: Omit<OcrResult, "ms">) => { if (done) return; done = true; resolve({ ...r, ms: Date.now() - t0 }); };
    let child;
    try { child = spawn(TESSERACT(), args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, OMP_THREAD_LIMIT: "1" } }); }
    catch (e) { return finish({ words: [], lines: [], text: "", ok: false, error: String(e) }); }
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} finish({ words: [], lines: [], text: "", ok: false, error: "timeout" }); }, opts.timeoutMs ?? 30000);
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
    child.on("error", (e: Error) => { clearTimeout(timer); finish({ words: [], lines: [], text: "", ok: false, error: e.message }); });
    child.on("close", (code: number) => {
      clearTimeout(timer);
      if (code !== 0) return finish({ words: [], lines: [], text: "", ok: false, error: `exit ${code}: ${err.slice(0, 200)}` });
      const words = parseTsv(out); const lines = groupLines(words);
      finish({ words, lines, text: lines.map((l) => l.text).join("\n"), ok: true });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(png);
  });
}

/** OCR a numeric field crop (phone, member-ID digits) as one line with the digit whitelist. */
export async function ocrDigits(png: Buffer, extra = ""): Promise<{ value: string | null; conf: number; ms: number; raw: string }> {
  const r = await ocr(png, { psm: 7, whitelist: "0123456789" + extra, dpi: 192 });
  const raw = r.words.map((w) => w.text).join(" ");
  const conf = r.words.length ? Math.min(...r.words.map((w) => w.conf)) : 0;
  return { value: r.ok && raw ? raw : null, conf, ms: r.ms, raw };
}

/** OCR a short alphanumeric field crop (Member ID) as one line. */
export async function ocrLine(png: Buffer, whitelist?: string): Promise<{ value: string | null; conf: number; ms: number }> {
  const r = await ocr(png, { psm: 7, whitelist, dpi: 192 });
  const raw = r.words.map((w) => w.text).join(" ");
  return { value: r.ok && raw ? raw : null, conf: r.words.length ? Math.min(...r.words.map((w) => w.conf)) : 0, ms: r.ms };
}
