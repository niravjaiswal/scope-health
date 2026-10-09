"""Wrenfield identifier-font decoder.

Wrenfield serves some values (phones, member IDs, MRNs, ...) in a per-page-load *scrambled* font: the DOM holds
cipher characters and the font's cmap maps each cipher char to the glyph outline of the real char.
(Observed in 4.2.0: digits 2-9 and A-Z permuted, lowercase/punctuation identity; the font file name and the
CSS family name are random per load.)

We recover the plaintext by matching each glyph's outline to a reference table of outlines of known fonts
(the site's own unscrambled "Wrenfield Mono" = JetBrains-Mono-derived, plus Atkinson Hyperlegible Next/Mono).
Matching is exact on rounded outline coordinates (cmap swap leaves outlines byte-identical), with a tolerant
fallback (same point count, nearest by coordinate distance) in case a version perturbs outlines.

Requires: fonttools + brotli (pip install fonttools brotli).
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import sys
from typing import Dict, Optional, Tuple

from fontTools.pens.recordingPen import RecordingPen
from fontTools.ttLib import TTFont

REF_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "wf_font_ref.json")
# characters we care about (printable ASCII + Latin-1 letters)
_CARE = {chr(c) for c in range(0x20, 0x7F)} | {chr(c) for c in range(0xC0, 0x180)}


def _outline(glyphset, gname) -> Tuple[str, list]:
    pen = RecordingPen()
    try:
        glyphset[gname].draw(pen)
    except Exception:
        return "", []
    parts, pts = [], []
    for op, args in pen.value:
        coords = []
        for a in args:
            if isinstance(a, tuple) and len(a) == 2:
                x, y = round(a[0]), round(a[1])
                coords.append(f"{x},{y}")
                pts.append((x, y))
        parts.append(op[0] + ";".join(coords))
    return "|".join(parts), pts


def _sig(s: str) -> str:
    return hashlib.md5(s.encode()).hexdigest()[:16]


def font_outlines(data: bytes):
    """-> dict char -> (sig, points)"""
    f = TTFont(io.BytesIO(data), lazy=True)
    cmap = f.getBestCmap() or {}
    gs = f.getGlyphSet()
    out = {}
    for cp, gname in cmap.items():
        ch = chr(cp)
        if ch not in _CARE:
            continue
        s, pts = _outline(gs, gname)
        out[ch] = (_sig(s), pts)
    return out


class FontDecoder:
    """Holds the reference outline table and decodes fonts into cipher->plain maps (cached by URL)."""

    def __init__(self, ref_path: str = REF_PATH):
        self.sig2char: Dict[str, str] = {}
        self.ambiguous: set = set()
        self.ref_points: Dict[int, list] = {}  # npoints -> [(points, char)] for fuzzy matching
        self.cache: Dict[str, Optional[Dict[str, str]]] = {}  # url -> map (None = identity)
        self.warnings = []
        if os.path.exists(ref_path):
            try:
                d = json.load(open(ref_path))
                for sig, ch in d.get("sig2char", {}).items():
                    self.sig2char[sig] = ch
                self.ambiguous = set(d.get("ambiguous", []))
            except Exception as e:  # pragma: no cover
                print(f"[wf_font] could not read reference table: {e}", file=sys.stderr)

    # ---- reference building -------------------------------------------------
    def add_reference(self, data: bytes, keep_points: bool = True):
        """Add an identity (unscrambled) font to the reference table."""
        for ch, (sig, pts) in font_outlines(data).items():
            if not pts:  # empty glyph (space) - ambiguous by nature
                continue
            if sig in self.sig2char and self.sig2char[sig] != ch:
                # same outline, different char (e.g. duplicates) -> ambiguous unless same visual
                self.ambiguous.add(sig)
            else:
                self.sig2char.setdefault(sig, ch)
            if keep_points:
                self.ref_points.setdefault(len(pts), []).append((pts, ch))

    def save_reference(self, path: str = REF_PATH):
        json.dump({"sig2char": self.sig2char, "ambiguous": sorted(self.ambiguous)}, open(path, "w"))

    # ---- decoding -----------------------------------------------------------
    def _fuzzy(self, pts) -> Optional[str]:
        cands = self.ref_points.get(len(pts))
        if not cands:
            return None
        best, bestd = None, None
        for rpts, ch in cands:
            d = sum(abs(a[0] - b[0]) + abs(a[1] - b[1]) for a, b in zip(pts, rpts))
            if bestd is None or d < bestd:
                best, bestd = ch, d
        # accept if average deviation small (<= 8 font units per point)
        if best is not None and bestd <= 8 * max(1, len(pts)):
            return best
        return None

    def decode_map(self, data: bytes, url: str = "") -> Optional[Dict[str, str]]:
        """Return {cipher_char: plain_char} for chars that differ, or None if the font is identity."""
        if url and url in self.cache:
            return self.cache[url]
        try:
            outl = font_outlines(data)
        except Exception as e:
            self.warnings.append(f"font parse failed {url}: {e}")
            if url:
                self.cache[url] = None
            return None
        m, unknown = {}, 0
        for ch, (sig, pts) in outl.items():
            if not pts:
                continue
            plain = None
            if sig in self.sig2char and sig not in self.ambiguous:
                plain = self.sig2char[sig]
            else:
                plain = self._fuzzy(pts)
            if plain is None:
                if ch.isalnum() and ord(ch) < 128:
                    unknown += 1
                continue
            if plain != ch:
                m[ch] = plain
        if unknown >= 3:
            self.warnings.append(f"font {url[-40:]}: {unknown} alnum glyphs not in reference table")
        res = m or None
        if url:
            self.cache[url] = res
        return res


def build_reference(font_files, out=REF_PATH):
    fd = FontDecoder(ref_path="/nonexistent")
    for fn in font_files:
        fd.add_reference(open(fn, "rb").read(), keep_points=False)
    fd.save_reference(out)
    return fd


if __name__ == "__main__":
    # python wf_font.py ref <identity fonts...>     -> writes wf_font_ref.json
    # python wf_font.py map <font>                 -> prints decode map
    if sys.argv[1] == "ref":
        fd = build_reference(sys.argv[2:])
        print("reference sigs:", len(fd.sig2char), "ambiguous:", len(fd.ambiguous))
    else:
        fd = FontDecoder()
        print(fd.decode_map(open(sys.argv[2], "rb").read(), sys.argv[2]))
        print(fd.warnings)
