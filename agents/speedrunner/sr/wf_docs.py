"""wf_docs.py - turn a Wrenfield document (page PNG and/or PDF) into faithful text.

Strategy (see .claude/docs/60-documents.md):
  1. Vector PDF (has fonts):  EXACT decode by glyph outlines.  Each embedded font is a re-scaled, jittered,
     re-ordered subset of Noto Sans / Noto Serif / Pangolin / Mali (@fontsource 5.2.5 latin + latin-ext).
     The ToUnicode map is booby-trapped on some PDFs (near-duplicate glyphs mapped to wrong letters), so we
     ignore it: every glyph outline is normalised to 1000 upem and matched against the reference fonts
     (same contour structure, mean |dxy| < ~3 units; true matches are ~0.3-0.6, the next candidate >4).
     ~10-30 ms per page, no network.  Hidden-text guard: every decoded span must show ink in the page image.
  2. Scanned PDF (only an image) or anything the decoder is unsure about: vision LLM on the page PNG
     (downscaled), verbatim transcription prompt, tables as ' | ' rows.

API:
    llm_call = make_llm_call()   # OpenAI-style chat endpoint from env LLM_BASE_URL / LLM_API_KEY (or your own:
                                 # async (messages, model=..., **body) -> {"text", "cost"?} or str)
    load_reference()             # optional pre-warm at startup (~0.5 s)
    res = await read_document(pdf_bytes=pdf, llm_call=llm_call, hint="lab report")   # PDF alone is enough
    res -> {"text": str, "method": "pdf_glyph" | "vision:<model>" | "pdf_glyph+vision:<model>" | "none" | "error",
            "confidence": 0..1, "kind": vector|scan|mixed, "trapped": bool (ToUnicode lied), "pages", "ms", "cost"?}
    Results are cached by content hash (same document read twice = free).
Helpers: parse_lab_report(text) -> dict, resolve_partial_dates(row_dates, fmt) -> [YYYY-MM-DD].
Needs: pymupdf, fontTools (+brotli not needed for .woff), pillow, httpx.  Fonts dir: WF_DOC_FONTS env or
./doc_fonts next to this file or ../doc_fonts.
"""
from __future__ import annotations

import asyncio
import base64
import collections
import glob
import io
import json
import os
import re
import time
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple

try:
    import pymupdf as fitz  # type: ignore
except Exception:  # pragma: no cover
    import fitz  # type: ignore

from fontTools.ttLib import TTFont
from fontTools.pens.recordingPen import DecomposingRecordingPen

HERE = os.path.dirname(os.path.abspath(__file__))

# ------------------------------------------------------------------------------------------------------
# Reference glyph database
# ------------------------------------------------------------------------------------------------------
_REF: Optional[Dict[tuple, List[Tuple[str, List[float], str]]]] = None
MATCH_MAX = 3.0        # mean |delta| (font units @1000 upem) accepted as a match (true matches ~0.2-0.7)
TIE = 1.0              # candidates within TIE of the best are treated as the same glyph -> lowest codepoint wins


def _fonts_dir() -> str:
    for d in (os.environ.get("WF_DOC_FONTS", ""), os.path.join(HERE, "doc_fonts"), os.path.join(HERE, "..", "doc_fonts"),
              "/app/doc_fonts"):
        if d and os.path.isdir(d) and glob.glob(os.path.join(d, "*.woff*")):
            return d
    raise FileNotFoundError("reference fonts (doc_fonts/*.woff) not found; set WF_DOC_FONTS")


def _norm_outline(gs, gn, upem) -> Tuple[tuple, List[float]]:
    pen = DecomposingRecordingPen(gs)
    gs[gn].draw(pen)
    s = 1000.0 / upem
    struct = tuple((op, len(pts)) for op, pts in pen.value)
    coords = [c * s for _op, pts in pen.value for p in pts for c in p]
    return struct, coords


def load_reference(force: bool = False):
    """Load reference outlines (about 0.5 s, done once; call at startup to pre-warm)."""
    global _REF
    if _REF is not None and not force:
        return _REF
    import pickle
    fdir = _fonts_dir()
    files = sorted(glob.glob(os.path.join(fdir, "*.woff*")))
    pk = os.path.join(fdir, "ref_outlines.pkl")
    try:   # pickled reference (~5x faster start); rebuilt when a font file is newer
        if os.path.exists(pk) and os.path.getmtime(pk) >= max(os.path.getmtime(f) for f in files):
            with open(pk, "rb") as fh:
                _REF = pickle.load(fh)
            return _REF
    except Exception:
        pass
    ref: Dict[tuple, List[Tuple[str, List[float], str]]] = collections.defaultdict(list)
    for fn in files:
        tt = TTFont(fn)
        gs = tt.getGlyphSet()
        upem = tt["head"].unitsPerEm
        tag = os.path.basename(fn).split(".")[0]
        for cp, gn in tt.getBestCmap().items():
            st, co = _norm_outline(gs, gn, upem)
            if st:
                ref[st].append((chr(cp), co, tag))
    _REF = dict(ref)
    try:
        with open(pk, "wb") as fh:
            pickle.dump(_REF, fh, protocol=pickle.HIGHEST_PROTOCOL)
    except Exception:
        pass
    return _REF


def _match_glyph(st, co) -> Tuple[Optional[str], float, float]:
    """-> (char or None, best distance, margin to the next *different-looking* candidate)."""
    ref = load_reference()
    cands = []
    for ch, rc, _tag in ref.get(st, ()):
        d = sum(abs(a - b) for a, b in zip(co, rc)) / max(1, len(co))
        cands.append((d, ch))
    if not cands:
        return None, 1e9, 0.0
    cands.sort()
    best = cands[0][0]
    if best > MATCH_MAX:
        return None, best, 0.0
    same = [ch for d, ch in cands if d <= best + TIE]
    # identical outlines for different code points (g/U+0261, -/soft hyphen, ,/U+201A): prefer the plainest
    ch = min(same, key=lambda c: (0 if ord(c) < 0x250 else 1, ord(c)))
    others = [d for d, c in cands if d > best + TIE]
    margin = (others[0] - best) if others else 99.0
    return ch, best, margin


# ------------------------------------------------------------------------------------------------------
# PDF decoding
# ------------------------------------------------------------------------------------------------------
def _font_maps(doc, page) -> Tuple[Dict[str, Dict[int, Tuple[Optional[str], float, float]]], Dict[str, int]]:
    """base font name -> {gid: (char, dist, margin)}; also counts of duplicate base names."""
    maps: Dict[str, Dict[int, Tuple[Optional[str], float, float]]] = {}
    dup = collections.Counter()
    for f in page.get_fonts(full=True):
        xref, basefont = f[0], f[3]
        base = basefont.split("+", 1)[-1]
        try:
            _name, _ext, _typ, buf = doc.extract_font(xref)
        except Exception:
            buf = b""
        dup[base] += 1
        m: Dict[int, Tuple[Optional[str], float, float]] = {}
        if buf:
            try:
                tt = TTFont(io.BytesIO(buf))
                gs = tt.getGlyphSet()
                upem = tt["head"].unitsPerEm
                for gid, gn in enumerate(tt.getGlyphOrder()):
                    st, co = _norm_outline(gs, gn, upem)
                    if not st:
                        m[gid] = (" ", 0.0, 99.0)       # empty outline = space (or .notdef)
                    else:
                        m[gid] = _match_glyph(st, co)
            except Exception:
                pass
        if base in maps:  # same base name twice: merge, mark conflicts as unknown
            for g, v in m.items():
                if g in maps[base] and maps[base][g][0] != v[0]:
                    maps[base][g] = (None, 1e9, 0.0)
                else:
                    maps[base].setdefault(g, v)
        else:
            maps[base] = m
    return maps, dup


def _ink_ok(img, bbox, scale) -> bool:
    """True if the rendered region of bbox has visible contrast (text actually drawn there)."""
    from PIL import ImageStat
    x0, y0, x1, y1 = [v * scale for v in bbox]
    W, H = img.size
    box = (max(0, int(x0)), max(0, int(y0)), min(W, int(x1 + 1)), min(H, int(y1 + 1)))
    if box[2] - box[0] < 1 or box[3] - box[1] < 1:
        return False
    st = ImageStat.Stat(img.crop(box))
    return st.stddev[0] > 12  # text strokes give strong contrast; blank / covered / same-colour areas ~0


def pdf_decode(pdf_bytes: bytes, png_bytes: Optional[bytes] = None, check_ink: bool = True) -> Dict[str, Any]:
    """Exact text of a vector PDF via glyph-outline matching (png_bytes is accepted but not needed: the site's page PNG
    is the PDF rendered at 200 dpi, pixel-identical to a PyMuPDF render).
    -> {kind: vector|scan|mixed|empty, text, tounicode_text, pages, glyphs, unmatched, ambiguous, hidden_spans,
        trapped, diff_chars, image_cover (max fraction of a page covered by images), ms}"""
    t0 = time.time()
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    out_pages, tu_pages = [], []
    n_glyph = n_unmatched = n_amb = n_hidden = n_diff = 0
    img_cover = 0.0
    for page in doc:
        area = max(1.0, page.rect.width * page.rect.height)
        try:
            for info in page.get_image_info():
                x0, y0, x1, y1 = info["bbox"]
                img_cover = max(img_cover, max(0.0, (x1 - x0) * (y1 - y0)) / area)
        except Exception:
            pass
        trace = page.get_texttrace()
        if not trace:
            out_pages.append("")
            tu_pages.append("")
            continue
        maps, _dup = _font_maps(doc, page)
        img = None
        if check_ink:
            try:
                from PIL import Image
                pix = page.get_pixmap(dpi=100, colorspace=fitz.csGRAY)
                img = Image.frombytes("L", (pix.width, pix.height), pix.samples)
                scale = img.size[0] / page.rect.width
            except Exception:
                img = None
        chars = []  # (y_baseline, x0, x1, size, char, tounicode_char)
        for span in trace:
            if span.get("opacity", 1) == 0 or span.get("type", 0) == 3:   # invisible text render mode
                n_hidden += 1
                continue
            if img is not None and not _ink_ok(img, span["bbox"], scale):
                n_hidden += 1
                continue
            fmap = maps.get(span["font"].split("+", 1)[-1], {})
            size = span["size"]
            for ucs, gid, origin, bbox in span["chars"]:
                tu = chr(ucs) if ucs and 0 < ucs < 0x110000 else "?"
                v = fmap.get(gid)
                if v is None or v[0] is None:
                    ch = "�"
                    n_unmatched += 1
                else:
                    ch = v[0]
                    if v[2] < 2.0:
                        n_amb += 1
                if ch != " ":
                    n_glyph += 1
                if ch != tu and not (ch == " " and tu in " \xa0"):
                    n_diff += 1
                chars.append((origin[1], bbox[0], bbox[2], size, ch, tu))
        out_pages.append(_layout(chars, 4))
        tu_pages.append(_layout(chars, 5))
    if n_glyph and img_cover > 0.15:
        kind = "mixed"
    elif n_glyph:
        kind = "vector"
    elif img_cover > 0:
        kind = "scan"
    else:
        kind = "empty"
    sep = "\n\n--- page break ---\n\n"
    return {"kind": kind, "text": sep.join(out_pages).strip(), "tounicode_text": sep.join(tu_pages).strip(),
            "pages": len(out_pages), "glyphs": n_glyph, "unmatched": n_unmatched, "ambiguous": n_amb,
            "hidden_spans": n_hidden, "trapped": n_diff > 0, "diff_chars": n_diff, "image_cover": round(img_cover, 3),
            "ms": int((time.time() - t0) * 1000)}


def _layout(chars, idx) -> str:
    """Group chars into visual lines; big horizontal gaps become ' | ' (table / label-value columns)."""
    if not chars:
        return ""
    chars = sorted(chars, key=lambda c: (round(c[0], 1), c[1]))
    lines: List[List[tuple]] = []
    for c in chars:
        if lines and abs(lines[-1][0][0] - c[0]) <= max(1.5, 0.35 * c[3]):
            lines[-1].append(c)
        else:
            lines.append([c])
    out = []
    for ln in sorted(lines, key=lambda l: l[0][0]):
        ln.sort(key=lambda c: c[1])
        s = ""
        prev = None
        for c in ln:
            ch = c[idx]
            if prev is not None:
                gap = c[1] - prev[2]
                em = max(c[3], prev[3])
                if gap > 1.2 * em:
                    s = s.rstrip(" ") + " | "
                    if ch == " ":
                        prev = c
                        continue
                elif gap > 0.18 * em and not s.endswith(" ") and ch != " ":
                    s += " "
            if not (ch == " " and (s.endswith(" ") or not s)):
                s += ch
            prev = c
        out.append(s.strip())
    return "\n".join(l for l in out if l)


# ------------------------------------------------------------------------------------------------------
# LLM (vision) client - OpenAI-style chat/completions
# ------------------------------------------------------------------------------------------------------
LLMCall = Callable[..., Awaitable[Dict[str, Any]]]


def make_llm_call(base_url: Optional[str] = None, api_key: Optional[str] = None, timeout: float = 60.0) -> LLMCall:
    """Returns async llm_call(messages, model=..., **body_overrides) -> {"text", "usage", "cost", "model", "ms"}.
    Uses env LLM_BASE_URL / LLM_API_KEY by default.  Non-streaming (documents produce short outputs)."""
    import httpx
    base = (base_url or os.environ.get("LLM_BASE_URL", "https://openrouter.ai/api/v1")).rstrip("/")
    key = api_key or os.environ.get("LLM_API_KEY", "")
    client = httpx.AsyncClient(timeout=timeout, headers={"Authorization": f"Bearer {key}"})

    async def llm_call(messages, model: str = "anthropic/claude-haiku-5.5", **body) -> Dict[str, Any]:
        t0 = time.time()
        req = {"model": model, "messages": messages, "temperature": 0, "usage": {"include": True}}
        req.update(body)
        r = await client.post(base + "/chat/completions", json=req)
        if r.status_code != 200:
            raise RuntimeError(f"LLM HTTP {r.status_code}: {r.text[:300]}")
        j = r.json()
        if "choices" not in j:
            raise RuntimeError(f"LLM bad response: {str(j)[:300]}")
        msg = j["choices"][0]["message"]
        u = j.get("usage") or {}
        return {"text": msg.get("content") or "", "usage": u, "cost": u.get("cost"), "model": j.get("model", model),
                "provider": j.get("provider"), "ms": int((time.time() - t0) * 1000)}

    llm_call.client = client  # type: ignore[attr-defined]
    return llm_call


VISION_PROMPT = (
    "Transcribe this scanned document page exactly as printed. Output plain text only, no commentary.\n"
    "- One output line per printed line, top to bottom, left to right.\n"
    "- Separate label/value columns and table cells with ' | ' (one table row per line, header row first).\n"
    "- Copy every character exactly: names, numbers, decimals, units, codes, dates in the SAME format as printed "
    "(do not convert or complete dates; keep year-less dates like 05/16 or 16 May as they are).\n"
    "- Keep accents. Do not fix spelling. Do not add or drop rows.\n"
    "- Transcribe handwriting too; write [signature] for an unreadable signature.\n"
    "- Scanner noise shows up as small specks: never transcribe a speck as a dot, comma, apostrophe or extra character "
    "inside a number, date, code or word."
)

# Benchmarked Oct 8 2026 (research/bench_out/docs_vision.jsonl, .claude/docs/60-documents.md):
#   claude-haiku-5.5, thinking off, provider sort=latency: 100% exact on 99 docs, median 1.9 s, max 2.7 s, $0.0005/page
#   gemini-3.8-flash, reasoning minimal: 100% exact, median 2.7-3.7 s, rare 25 s stalls, $0.002/page  (hedge)
VISION_MODELS: List[Tuple[str, Dict[str, Any]]] = [
    ("anthropic/claude-haiku-5.5", {"reasoning": {"enabled": False}, "provider": {"sort": "latency"}, "max_tokens": 4000}),
    ("google/gemini-3.8-flash", {"reasoning": {"effort": "minimal"}, "max_tokens": 4000}),
    ("openai/gpt-4.1-mini", {"max_tokens": 4000}),
]
VISION_WIDTH = 1240       # px; JPEG q85.  1000 is as accurate on our set, 800 lost 1 item in 42 docs
HEDGE_AFTER = 4.5         # s without an answer -> fire the next model too, take the first good answer


def downscale_png(png_bytes: bytes, width: int = VISION_WIDTH, fmt: str = "JPEG", quality: int = 85) -> Tuple[bytes, str]:
    from PIL import Image
    im = Image.open(io.BytesIO(png_bytes))
    if im.mode in ("1", "LA", "I", "I;16"):
        im = im.convert("L")
    elif im.mode not in ("RGB", "L"):
        im = im.convert("RGB")
    if width and im.size[0] > width:
        h = int(im.size[1] * width / im.size[0])
        im = im.resize((width, h), Image.LANCZOS)
    buf = io.BytesIO()
    if fmt.upper() == "PNG":
        im.save(buf, "PNG", optimize=True)
        return buf.getvalue(), "image/png"
    im.convert("RGB").save(buf, "JPEG", quality=quality)
    return buf.getvalue(), "image/jpeg"


def pdf_page_pngs(pdf_bytes: bytes, dpi: int = 200, max_pages: int = 10) -> List[bytes]:
    """Render PDF pages (same as the site's page PNGs at dpi=200)."""
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    out = []
    for i, page in enumerate(doc):
        if i >= max_pages:
            break
        out.append(page.get_pixmap(dpi=dpi, colorspace=fitz.csGRAY).tobytes("png"))
    return out


def pdf_page_png(pdf_bytes: bytes, page: int = 0, dpi: int = 200) -> bytes:
    return pdf_page_pngs(pdf_bytes, dpi)[page]


async def _call(llm_call: LLMCall, messages, model: str, extra: Dict[str, Any]) -> Dict[str, Any]:
    r = await llm_call(messages, model=model, **extra)
    if isinstance(r, str):
        r = {"text": r}
    r.setdefault("model", model)
    return r


def encode_image(png_bytes: bytes, width: int = VISION_WIDTH, fmt: str = "JPEG") -> Tuple[str, int]:
    """-> (data URL, encoded size).  ~0.1-0.4 s of CPU for a 1700x2200 page: call via asyncio.to_thread."""
    img, mime = downscale_png(png_bytes, width, fmt)
    return f"data:{mime};base64," + base64.b64encode(img).decode(), len(img)


async def vision_transcribe(png_bytes: Optional[bytes], llm_call: LLMCall, hint: str = "", model: Optional[str] = None,
                            width: int = VISION_WIDTH, fmt: str = "JPEG", extra: Optional[dict] = None,
                            prompt: Optional[str] = None, data_url: Optional[Tuple[str, int]] = None) -> Dict[str, Any]:
    """One vision call.  model/extra default to VISION_MODELS[0].  data_url: pre-encoded (url, size) from encode_image."""
    if model is None:
        model, dflt = VISION_MODELS[0]
        extra = dict(dflt, **(extra or {}))
    if data_url is None:
        data_url = await asyncio.to_thread(encode_image, png_bytes, width, fmt)
    text = (prompt or VISION_PROMPT) + (f"\nThe document is: {hint}." if hint else "")
    messages = [{"role": "user", "content": [
        {"type": "text", "text": text},
        {"type": "image_url", "image_url": {"url": data_url[0]}}]}]
    res = await _call(llm_call, messages, model, extra or {})
    t = (res.get("text") or "").strip()
    t = re.sub(r"^```[a-zA-Z]*\n|\n?```$", "", t).strip()
    res["text"] = t
    res["image_bytes"] = data_url[1]
    return res


def selfcheck(text: str) -> Tuple[bool, str]:
    """Cheap consistency checks on a transcription (a failure triggers a second opinion from the next model)."""
    if not text.strip():
        return False, "empty"
    if "\ufffd" in text:
        return False, "replacement char"
    if re.search(r"Tests reported", text, re.I):
        p = parse_lab_report(text)
        n = p.get("tests_reported")
        if n is not None and p["tests"] and n != len(p["tests"]):
            return False, f"tests_reported {n} != rows {len(p['tests'])}"
    return True, ""


async def vision_robust(png_bytes: bytes, llm_call: LLMCall, hint: str = "", hedge_after: float = HEDGE_AFTER,
                        models: Optional[List[Tuple[str, Dict[str, Any]]]] = None, check: bool = True,
                        deadline: float = 30.0) -> Dict[str, Any]:
    """Primary model; the next model is fired after hedge_after s without an answer, on an error, or when the answer
    fails selfcheck.  Returns the first answer passing selfcheck (else the first non-empty one) within deadline s."""
    models = models or VISION_MODELS
    pending: Dict[asyncio.Task, str] = {}
    idx = 0
    fallback = None
    errors: List[str] = []
    t_end = time.time() + deadline
    data_url = await asyncio.to_thread(encode_image, png_bytes)

    def launch() -> bool:
        nonlocal idx
        if idx >= len(models):
            return False
        m, ex = models[idx]
        idx += 1
        pending[asyncio.create_task(vision_transcribe(None, llm_call, hint, model=m, extra=ex, data_url=data_url))] = m
        return True

    launch()
    try:
        while pending and time.time() < t_end:
            done, _ = await asyncio.wait(set(pending), timeout=min(hedge_after, max(0.05, t_end - time.time())),
                                         return_when=asyncio.FIRST_COMPLETED)
            if not done:              # slow: hedge with the next model (if any) and keep waiting
                launch()
                continue
            for t in done:
                m = pending.pop(t)
                try:
                    r = t.result()
                except Exception as e:
                    errors.append(f"{m}: {str(e)[:120]}")
                    launch()           # error: bring in the next model now
                    continue
                ok, why = selfcheck(r["text"]) if check else (bool(r["text"].strip()), "")
                if ok:
                    r["selfcheck"] = "ok"
                    return r
                r["selfcheck"] = why
                if fallback is None and r["text"].strip():
                    fallback = r
                launch()               # failed self-check: second opinion now
        if fallback:
            return fallback
        raise RuntimeError("vision failed: " + ("; ".join(errors) or "deadline"))
    finally:
        for t in pending:
            t.cancel()


# ------------------------------------------------------------------------------------------------------
# Main entry
# ------------------------------------------------------------------------------------------------------
_CACHE: Dict[str, Dict[str, Any]] = {}
_INFLIGHT: Dict[str, asyncio.Future] = {}


async def read_document(png_bytes: Optional[bytes] = None, pdf_bytes: Optional[bytes] = None,
                        llm_call: Optional[LLMCall] = None, hint: str = "", *, pngs: Optional[List[bytes]] = None,
                        hedge_after: float = HEDGE_AFTER, use_cache: bool = True) -> Dict[str, Any]:
    """Faithful text of a Wrenfield document.
    png_bytes / pngs: page image(s) as shown by the viewer (optional - only used for scans; we can render the PDF).
    pdf_bytes: the downloadable PDF (preferred input: one small fetch decides everything).
    -> {text, method: pdf_glyph | vision:<model> | pdf_glyph+vision:<model> | none | error, confidence, ms, ...}"""
    import hashlib
    t0 = time.time()
    key = hashlib.sha1((pdf_bytes or b"") + b"|" + (png_bytes or (pngs[0] if pngs else b""))).hexdigest()
    if use_cache:
        if key in _CACHE:
            return dict(_CACHE[key], cached=True)
        if key in _INFLIGHT:
            return dict(await asyncio.shield(_INFLIGHT[key]), cached=True)
        fut = asyncio.get_running_loop().create_future()
        _INFLIGHT[key] = fut
    res = {"text": "", "method": "error", "error": "cancelled", "confidence": 0.0, "ms": 0}
    try:
        res = await _read_document(png_bytes, pdf_bytes, llm_call, hint, pngs, hedge_after, t0)
    except Exception as e:  # never raise into the agent
        res = {"text": "", "method": "error", "error": str(e)[:300], "confidence": 0.0, "ms": int((time.time() - t0) * 1000)}
    finally:   # also on cancellation: never leave a waiter on _INFLIGHT[key] hanging
        if use_cache:
            if res.get("method") not in ("error", "none"):
                _CACHE[key] = res
            _INFLIGHT.pop(key, None)
            if not fut.done():
                fut.set_result(res)
    return res


async def _read_document(png_bytes, pdf_bytes, llm_call, hint, pngs, hedge_after, t0) -> Dict[str, Any]:
    info: Dict[str, Any] = {}
    glyph_text = ""
    if pdf_bytes:
        try:
            dec = await asyncio.to_thread(pdf_decode, pdf_bytes)
            info = {k: v for k, v in dec.items() if k not in ("text", "tounicode_text")}
            info["decode_ms"] = info.pop("ms")
            if dec["kind"] == "vector" and dec["unmatched"] == 0:
                return {"text": dec["text"], "method": "pdf_glyph", "confidence": 0.99 if dec["ambiguous"] == 0 else 0.95,
                        "ms": int((time.time() - t0) * 1000), **info}
            if dec["kind"] in ("vector", "mixed"):
                glyph_text = dec["text"]
                if llm_call is None:
                    return {"text": glyph_text, "method": "pdf_glyph", "confidence": 0.7 if dec["unmatched"] else 0.85,
                            "ms": int((time.time() - t0) * 1000), **info}
        except Exception as e:  # corrupt / unusual PDF -> vision
            info = {"pdf_error": str(e)[:200]}
    pages = pngs or ([png_bytes] if png_bytes else None)
    if not pages and pdf_bytes:
        pages = await asyncio.to_thread(pdf_page_pngs, pdf_bytes, 200)
    if not pages or llm_call is None:
        return {"text": glyph_text, "method": "none" if not glyph_text else "pdf_glyph", "confidence": 0.0,
                "ms": int((time.time() - t0) * 1000), **info}
    results = await asyncio.gather(*[vision_robust(pg, llm_call, hint, hedge_after) for pg in pages],
                                   return_exceptions=True)
    texts, models, cost, checks = [], [], 0.0, []
    for i, r in enumerate(results):
        if isinstance(r, Exception):
            texts.append(f"[page {i + 1}: unreadable: {str(r)[:100]}]")
            checks.append("error")
            continue
        texts.append(r["text"])
        models.append(r.get("model", ""))
        cost += r.get("cost") or 0
        checks.append(r.get("selfcheck", ""))
    text = "\n\n--- page break ---\n\n".join(texts)
    if not models:   # every page failed
        return {"text": glyph_text, "method": "pdf_glyph" if glyph_text else "error", "confidence": 0.5 if glyph_text else 0.0,
                "error": texts[0][:300] if texts else "", "ms": int((time.time() - t0) * 1000), **info}
    method = "vision:" + ",".join(sorted(set(models)))
    if glyph_text:   # mixed page: keep the exact text layer too
        text = text + "\n\n--- exact text layer ---\n" + glyph_text
        method = "pdf_glyph+" + method
    conf = 0.92 if all(c == "ok" for c in checks) else 0.6
    return {"text": text, "method": method, "confidence": conf, "cost": round(cost, 6), "selfcheck": checks,
            "ms": int((time.time() - t0) * 1000), **info}


# ------------------------------------------------------------------------------------------------------
# Structured helpers (work on both glyph-decoded and vision text, which share the ' | ' line format)
# ------------------------------------------------------------------------------------------------------
_LAB_FIELDS = ["Patient", "Date of birth", "Sex", "Record number", "Ordering provider", "Collected", "Received",
               "Report number", "Report status"]


def parse_lab_report(text: str) -> Dict[str, Any]:
    """Wrenfield lab report text -> {patient, date_of_birth, sex, record_number, collected, received, report_number,
    panel, tests:[{test, result, units, range, flag}], tests_reported}."""
    res: Dict[str, Any] = {"tests": []}
    lines = [re.sub(r"^\s*(?:[-*\u2022]\s+)", "", l).strip() for l in text.splitlines() if l.strip()]
    lines = [l.strip("| ").strip() for l in lines]
    flat = " | ".join(lines)
    for f in _LAB_FIELDS:
        m = re.search(r"(?:^|\|)\s*" + re.escape(f) + r"\s*:?\s*\|?\s*([^|]+?)\s*(?=\||$)", flat)
        if m:
            res[f.lower().replace(" ", "_")] = m.group(1).strip()
    hdr = None
    for i, l in enumerate(lines):
        cells = [c.strip() for c in l.split("|")]
        low = [c.lower() for c in cells]
        if hdr is None and low and low[0] == "test" and any("result" in c for c in low):
            hdr = i
            if i > 0:
                res["panel"] = lines[i - 1].strip(" |")
            continue
        if hdr is not None:
            if re.match(r"(?i)tests reported", l):
                m = re.search(r"(\d+)", l)
                res["tests_reported"] = int(m.group(1)) if m else None
                break
            if len(cells) >= 3:
                t = {"test": cells[0], "result": cells[1], "units": cells[2] if len(cells) > 2 else "",
                     "range": cells[3] if len(cells) > 3 else "", "flag": cells[4] if len(cells) > 4 else ""}
                res["tests"].append(t)
    return res


_MON = {m: i + 1 for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"])}


def parse_date(s: str, fmt: str, prev: Optional[Tuple[int, int, int]] = None) -> Optional[Tuple[int, int, int]]:
    """Parse one printed date in format fmt ('YYYY-MM-DD','MM/DD/YYYY','DD.MM.YYYY','D Mon YYYY').
    Year-less dates (05/16, 16.05., 16 May) take the first such month/day AFTER prev (same row)."""
    s = s.strip().rstrip(",")
    y = m = d = None
    f = fmt.upper().replace(" ", "")
    try:
        if f.startswith("YYYY-MM-DD") or re.fullmatch(r"\d{4}-\d{1,2}-\d{1,2}", s):
            mm = re.fullmatch(r"(\d{4})-(\d{1,2})-(\d{1,2})", s) or re.fullmatch(r"(\d{1,2})-(\d{1,2})()", s)
            if mm and mm.group(3):
                y, m, d = int(mm.group(1)), int(mm.group(2)), int(mm.group(3))
            elif mm:
                m, d = int(mm.group(1)), int(mm.group(2))
        elif f.startswith("MM/DD"):
            mm = re.fullmatch(r"(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?", s)
            if mm:
                m, d = int(mm.group(1)), int(mm.group(2))
                y = int(mm.group(3)) if mm.group(3) else None
        elif f.startswith("DD.MM"):
            mm = re.fullmatch(r"(\d{1,2})\.(\d{1,2})\.?(\d{2,4})?", s)
            if mm:
                d, m = int(mm.group(1)), int(mm.group(2))
                y = int(mm.group(3)) if mm.group(3) else None
        else:  # day month year
            mm = re.fullmatch(r"(\d{1,2})\s+([A-Za-z]{3,})\.?(?:\s+(\d{2,4}))?", s)
            if mm:
                d, m = int(mm.group(1)), _MON.get(mm.group(2)[:3].lower())
                y = int(mm.group(3)) if mm.group(3) else None
    except Exception:
        return None
    if not m or not d:
        return None
    if y is not None and y < 100:
        y += 2000 if y < 50 else 1900
    if y is None:
        if prev is None:
            return None
        y = prev[0]
        if (m, d) <= (prev[1], prev[2]):
            y += 1
    return (y, m, d)


def resolve_partial_dates(row: List[str], fmt: str) -> List[Optional[str]]:
    """['03/14/2019','05/16','11/02','01/15'] with 'MM/DD/YYYY' -> ['2019-03-14','2019-05-16','2019-11-02','2020-01-15']."""
    out, prev = [], None
    for s in row:
        r = parse_date(s, fmt, prev)
        if r:
            prev = r
            out.append(f"{r[0]:04d}-{r[1]:02d}-{r[2]:02d}")
        else:
            out.append(None)
    return out


if __name__ == "__main__":  # quick CLI: python wf_docs.py file.pdf [file.png]
    import sys
    pdf = open(sys.argv[1], "rb").read()
    png = open(sys.argv[2], "rb").read() if len(sys.argv) > 2 else None
    load_reference()
    r = pdf_decode(pdf, png)
    print(json.dumps({k: v for k, v in r.items() if k not in ("text", "tounicode_text")}))
    print(r["text"])
