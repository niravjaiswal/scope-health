/**
 * Digit de-obfuscation. Wrenfield renders sensitive numeric fields (phone, MRN, …) with a
 * per-session custom font whose glyph OUTLINES are the real digits but assigned to SCRAMBLED
 * codepoints — so `innerText` is garbage and only the on-screen rendering is correct. The font
 * is re-generated per page load (and clinics may use different fonts), so we can't hardcode a
 * map. Instead we read the actual font the browser used (captured via CDP Network), rasterize
 * each digit glyph's outline, and match it to a BUNDLED reference font's digit shapes with a
 * min-cost bijective (Hungarian) assignment. That yields codepoint→digit for this exact font.
 *
 * Never-wrong guards: the assignment must be a valid permutation of 0-9 and the match cost must
 * be low; otherwise we return null and the caller declines rather than emit a wrong value.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as fontkit from "fontkit";

const W = 20, H = 28;

function flatten(path: any): number[][][] {
  const cs: number[][][] = []; let cur: number[][] = [], x = 0, y = 0, sx = 0, sy = 0;
  for (const cmd of path.commands) {
    const a = cmd.args;
    if (cmd.command === "moveTo") { if (cur.length) cs.push(cur); cur = []; x = a[0]; y = a[1]; sx = x; sy = y; cur.push([x, y]); }
    else if (cmd.command === "lineTo") { x = a[0]; y = a[1]; cur.push([x, y]); }
    else if (cmd.command === "quadraticCurveTo") { const [cx, cy, ex, ey] = a; for (let t = 1; t <= 12; t++) { const u = t / 12; cur.push([(1 - u) * (1 - u) * x + 2 * (1 - u) * u * cx + u * u * ex, (1 - u) * (1 - u) * y + 2 * (1 - u) * u * cy + u * u * ey]); } x = ex; y = ey; }
    else if (cmd.command === "bezierCurveTo") { const [a1, b1, a2, b2, ex, ey] = a; for (let t = 1; t <= 12; t++) { const u = t / 12, m = 1 - u; cur.push([m * m * m * x + 3 * m * m * u * a1 + 3 * m * u * u * a2 + u * u * u * ex, m * m * m * y + 3 * m * m * u * b1 + 3 * m * u * u * b2 + u * u * u * ey]); } x = ex; y = ey; }
    else if (cmd.command === "closePath") { if (cur.length) { cur.push([sx, sy]); cs.push(cur); cur = []; } }
  }
  if (cur.length) cs.push(cur);
  return cs;
}

/** Rasterize a glyph outline to a W×H binary grid (even-odd fill), normalized to its bbox. */
function raster(path: any): number[] {
  const cs = flatten(path);
  let mnx = 1e9, mny = 1e9, mxx = -1e9, mxy = -1e9;
  for (const c of cs) for (const [x, y] of c) { mnx = Math.min(mnx, x); mxx = Math.max(mxx, x); mny = Math.min(mny, y); mxy = Math.max(mxy, y); }
  const sw = (mxx - mnx) || 1, sh = (mxy - mny) || 1; const g: number[] = [];
  for (let gy = 0; gy < H; gy++) for (let gx = 0; gx < W; gx++) {
    const px = mnx + (gx + 0.5) / W * sw, py = mxy - (gy + 0.5) / H * sh; let ins = false;
    for (const c of cs) for (let i = 0, j = c.length - 1; i < c.length; j = i++) { const [xi, yi] = c[i], [xj, yj] = c[j]; if (((yi > py) !== (yj > py)) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) ins = !ins; }
    g.push(ins ? 1 : 0);
  }
  return g;
}
const diff = (a: number[], b: number[]) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] !== b[i] ? 1 : 0; return s; };

/** Min-cost bijective assignment (Hungarian, O(n^3)). Returns assign[i]=column for row i. */
function hungarian(cost: number[][]): number[] {
  const n = cost.length, u = new Array(n + 1).fill(0), v = new Array(n + 1).fill(0), p = new Array(n + 1).fill(0), way = new Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i; let j0 = 0; const mv = new Array(n + 1).fill(Infinity), us = new Array(n + 1).fill(false);
    do {
      us[j0] = true; const i0 = p[j0]; let dl = Infinity, j1 = -1;
      for (let j = 1; j <= n; j++) if (!us[j]) { const cur = cost[i0 - 1][j - 1] - u[i0] - v[j]; if (cur < mv[j]) { mv[j] = cur; way[j] = j0; } if (mv[j] < dl) { dl = mv[j]; j1 = j; } }
      for (let j = 0; j <= n; j++) { if (us[j]) { u[p[j]] += dl; v[j] -= dl; } else mv[j] -= dl; } j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const a = new Array(n).fill(0); for (let j = 1; j <= n; j++) a[p[j] - 1] = j - 1; return a;
}

// Reference digit templates from the bundled font (loaded once).
let REF: number[][] | null = null;
function refTemplates(): number[][] {
  if (REF) return REF;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, "refdigits.ttf"), "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"];
  for (const p of candidates) { try { const f: any = (fontkit as any).create(readFileSync(p)); REF = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => raster(f.glyphForCodePoint(48 + d).path)); return REF; } catch { /* next */ } }
  throw new Error("no reference digit font available");
}

export type DigitMap = Record<string, string>;

/** Count enclosed background regions (holes) in a W×H binary glyph raster — a font-invariant
 *  topological feature. '8'→2, '0'/'6'/'9'→1, '1'/'2'/'3'/'5'/'7'→0 ('4' is design-dependent). */
function holes(g: number[]): number {
  const vis = new Uint8Array(W * H), stack: number[] = [];
  for (let x = 0; x < W; x++) { stack.push(x, (H - 1) * W + x); }
  for (let y = 0; y < H; y++) { stack.push(y * W, y * W + W - 1); }
  while (stack.length) { const i = stack.pop()!; if (i < 0 || i >= W * H || vis[i] || g[i]) continue; vis[i] = 1; const x = i % W, y = (i / W) | 0; if (x > 0) stack.push(i - 1); if (x < W - 1) stack.push(i + 1); if (y > 0) stack.push(i - W); if (y < H - 1) stack.push(i + W); }
  let count = 0; const seen = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) if (!g[i] && !vis[i] && !seen[i]) { count++; const st = [i]; while (st.length) { const j = st.pop()!; if (j < 0 || j >= W * H || seen[j] || g[j] || vis[j]) continue; seen[j] = 1; const x = j % W, y = (j / W) | 0; if (x > 0) st.push(j - 1); if (x < W - 1) st.push(j + 1); if (y > 0) st.push(j - W); if (y < H - 1) st.push(j + W); } }
  return count;
}
const glyphRasters = (font: any): number[][] | null => { try { return [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => raster(font.glyphForCodePoint(48 + d).path)); } catch { return null; } };
/**
 * A font file's digit rasters (null: not a usable font). Pure in the file's bytes and the one expensive step (fontkit parse + 10
 * outline rasters, ~50 ms a font, 7-14 fonts a Wrenfield page): remembered by the bytes' SHA-1 (AGENT_FONT_MEMO=off disables it).
 * Practice measurement: every patient chart of a session declares the same 9 font files, so the page's decode cost 500-800 ms
 * once per patient and ~0 after the first. AGENT_FONT_MEMO=verify recomputes each hit and throws on a difference.
 */
const rasterMemo = new Map<string, number[][] | null>();
const memoCostMs = new Map<string, number>();
export const fontMemoStats = { hits: 0, misses: 0, savedMs: 0 };
const memoMode = (): "off" | "on" | "verify" => { const m = (process.env.AGENT_FONT_MEMO ?? "on").toLowerCase(); return m === "off" || m === "verify" ? m : "on"; };
function rastersOf(b: Buffer): number[][] | null {
  const compute = (): number[][] | null => { let f: any; try { f = (fontkit as any).create(b); } catch { return null; } return !f || f.numGlyphs < 20 ? null : glyphRasters(f); };
  const mode = memoMode(); if (mode === "off") return compute();
  const k = createHash("sha1").update(b).digest("hex");
  if (rasterMemo.has(k)) {
    const hit = rasterMemo.get(k)!;
    if (mode === "verify" && JSON.stringify(compute()) !== JSON.stringify(hit)) throw new Error("fontDecode memo: a remembered font differs from a fresh parse");
    fontMemoStats.hits++; fontMemoStats.savedMs += memoCostMs.get(k) ?? 0; return hit;
  }
  const t = Date.now(); const r = compute(); rasterMemo.set(k, r); memoCostMs.set(k, Date.now() - t); fontMemoStats.misses++; return r;
}
/** An identity-mapped font: codepoint d renders digit d. Detected by digit hole-counts. */
const IDENT = new WeakMap<number[][], boolean>();
const isIdentity = (rs: number[][]): boolean => {
  let v = IDENT.get(rs); if (v !== undefined) return v;
  const exp: Record<number, number> = { 0: 1, 1: 0, 2: 0, 3: 0, 5: 0, 6: 1, 7: 0, 8: 2, 9: 1 }; // skip 4
  v = Object.entries(exp).every(([cp, n]) => holes(rs[+cp]) === n); IDENT.set(rs, v); return v;
};
/**
 * Build the codepoint→digit map from ALL fonts the page loaded. The page serves BOTH an identity
 * font (codepoint d = digit d) and the per-session SCRAMBLED render font that actually draws the
 * obfuscated field — with the SAME glyph outlines, just reassigned. We match the scrambled glyphs
 * to the identity glyphs (EXACT, same design → unambiguous), which is reliable where cross-font
 * matching to a generic reference is not. Falls back to the bundled reference only if no identity
 * font is present. Returns null when ambiguous or absent → caller declines (never a wrong answer).
 */
export function buildDigitMap(fontBufs: Buffer[]): DigitMap | null {
  const rasters: number[][][] = [];
  for (const b of fontBufs) { const rs = rastersOf(b); if (rs) rasters.push(rs); }
  if (!rasters.length) return null;
  const identity = rasters.find(isIdentity);
  const scrambled = rasters.filter((rs) => !isIdentity(rs));
  if (!scrambled.length) return null;                             // no obfuscation font on this page
  const ref = identity ?? refTemplates();                         // clinic identity (exact) or bundled fallback
  const exact = !!identity;
  // Observability: the exact identity-font path is the trusted one (decoded digit == rendered
  // digit by construction). Loudly flag the looser cross-font fallback so any run that relies on
  // it is visible in logs — silence means every decode this session used the exact match.
  if (!exact) console.error("[fontDecode] WARNING: no identity font captured — using looser bundled-reference fallback (threshold 0.40)");
  const maps: DigitMap[] = [];
  for (const s of scrambled) {
    const cost = s.map((g) => ref.map((r) => diff(g, r)));
    const greedy = cost.map((row) => row.indexOf(Math.min(...row)));
    if (new Set(greedy).size !== 10) continue;                    // collision → ambiguous → decline this font
    const total = greedy.reduce((acc, d, i) => acc + cost[i][d], 0);
    if (total > 10 * W * H * (exact ? 0.12 : 0.40)) continue;      // weak match (exact ref should be ~0) → decline
    if (!exact) for (let i = 0; i < 10; i++) { const so = [...cost[i]].sort((a, b) => a - b); if (so[1] - so[0] < Math.max(14, so[0] * 0.15)) { greedy.length = 0; break; } }
    if (greedy.length !== 10) continue;
    const m: DigitMap = {}; greedy.forEach((d, cp) => (m[String(cp)] = String(d))); maps.push(m);
  }
  if (!maps.length) return null;
  const k = JSON.stringify(maps[0]); return maps.every((m) => JSON.stringify(m) === k) ? maps[0] : null; // one obfuscation font, or all agree
}

/** Apply a digit map to a string (digits only; punctuation/letters untouched). */
export const applyDigitMap = (s: string, map: DigitMap) => s.replace(/[0-9]/g, (ch) => map[ch] ?? ch);

/** How many of these fonts draw digits at their own codepoints (identity) vs scrambled. A page whose
 *  custom-font digits come only from identity fonts shows its raw text truthfully. */
export function fontKinds(fontBufs: Buffer[]): { identity: number; scrambled: number } {
  let identity = 0, scrambled = 0;
  for (const b of fontBufs) { const rs = rastersOf(b); if (!rs) continue; if (isIdentity(rs)) identity++; else scrambled++; }
  return { identity, scrambled };
}
