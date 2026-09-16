"""PDF drawings: read the text layer, write it back translated.

Vector PDFs plotted from CAD keep every string as real text with a
position, a size and a font. That is enough to do what the DXF path does:
one TextItem per line of text, the same prepare/translate/fit stages, and
a patch that removes each original line (redaction, graphics untouched)
and draws the translation at the same baseline, narrowed to fit.

Two habits of AutoCAD-plotted PDFs are handled here:

* garbled Cyrillic: the plotter writes Windows-1251 bytes and declares a
  wrong Unicode mapping, so "Наименование" extracts as "ɇɚɢɦɟɧɨɜɚɧɢɟ".
  The shift is constant per font (0x17A, 0x109, 0xFA seen so far); it is
  detected per string and undone.
* no space characters: words are placed by coordinate. PyMuPDF's word
  extraction rebuilds them from glyph gaps; lines are joined with spaces.

Coordinates: PDF y grows downwards; the layout module assumes up. Items
store y negated so "the line below" has a smaller y, as in a DXF.
"""
from __future__ import annotations

import warnings
from collections import defaultdict

warnings.filterwarnings("ignore")


from .inventory import TextItem, detect_lang

CAP = 0.72            # cap height as a fraction of the font size (Times/Arial/ISOCPEUR)
OFFSETS = (0x17A, 0x109, 0xFA)


def open_pdf(path: str):
    import pymupdf
    return pymupdf.open(path)


def _offset(text: str) -> int:
    hi = [ord(c) for c in text if ord(c) > 0x7E]
    if not hi:
        return 0
    if sum(1 for o in hi if 0x400 <= o <= 0x4FF) / len(hi) > 0.5:
        return 0
    best = (0, 0)
    for d in OFFSETS:
        good = sum(1 for o in hi if 0xC0 <= o - d <= 0xFF)
        if good > best[0]:
            best = (good, d)
    return best[1] if best[0] >= max(1, len(hi) // 2) else 0


def decode(text: str) -> str:
    """Undo the plotter's Unicode shift on one string."""
    d = _offset(text)
    if not d:
        return text
    out = []
    for c in text:
        o = ord(c)
        if o > 0x7E and 0x80 <= o - d <= 0xFF:
            out.append(bytes([o - d]).decode("cp1251", "replace"))
        else:
            out.append(c)
    return "".join(out)


SANE = set(range(0x20, 0x7F)) | set(range(0x400, 0x460)) | {0xA0, 0xB0, 0xB1, 0xB2, 0xB3, 0xB9, 0xD7, 0xF7, 0xAB, 0xBB,
                                                            0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2026, 0x2116,
                                                            0x2022, 0x2032, 0x2033, 0x2103, 0x2205, 0x00D8, 0x00F8, 0x2205, 0x2300}


def _glyph_maps(doc, page) -> dict[str, list[dict[int, int]]]:
    """font name -> [gid -> unicode] for every embedded TrueType/CFF font on the page."""
    import io
    out: dict[str, list[dict[int, int]]] = {}
    try:
        from fontTools.ttLib import TTFont
    except Exception:
        return out
    for f in page.get_fonts(full=True):
        xref, name = f[0], f[3]
        try:
            _, ext, _, buf = doc.extract_font(xref)
        except Exception:
            continue
        if not buf or ext not in ("ttf", "otf", "cff"):
            continue
        try:
            tt = TTFont(io.BytesIO(buf))
            best = tt.getBestCmap() or {}
            order = tt.getGlyphOrder()
            idx = {g: i for i, g in enumerate(order)}
            g2u = {idx[g]: u for u, g in best.items() if g in idx}
            if g2u:
                out.setdefault(name, []).append(g2u)
        except Exception:
            continue
    return out


def _sane(text: str) -> float:
    if not text:
        return 0.0
    return sum(1 for c in text if ord(c) in SANE) / len(text)


def _span_text(sp: dict, maps: dict[str, list[dict[int, int]]], cache: dict) -> str:
    """Best reading of one text-trace span, in this order: the PDF's own
    Unicode mapping if it is sane; that mapping with the plotter's constant
    shift undone; the embedded font's glyph table as a last resort (its
    glyph order can disagree with the PDF for digits and punctuation)."""
    uni = "".join(chr(c[0]) for c in sp["chars"])
    if _sane(uni) >= 0.97:
        return uni.replace("\xa0", " ").replace("\xad", "–")
    fixed = decode(uni)
    if _sane(fixed) >= 0.97:
        return fixed.replace("\xa0", " ").replace("\xad", "–")
    best, best_score = fixed, _sane(fixed)
    for m in maps.get(sp["font"], []):
        via = "".join(chr(m[g]) if g in m else chr(u) for u, g, *_ in sp["chars"])
        sc = _sane(via)
        if sc > best_score:
            best, best_score = via, sc
    return best.replace("\xa0", " ").replace("\xad", "–")


def inventory(doc) -> tuple[list[TextItem], dict[str, list[list[float]]], dict[str, dict]]:
    """Returns (items, walls per page, line geometry per handle).

    Lines are rebuilt from the text trace (one span per drawing string, with
    glyph ids), decoded per font instance, then grouped by baseline: spans
    on the same row within a word-gap of each other form one line. Handle =
    p<page>:<n>. Geometry keeps what patching needs: page, bbox in PDF
    points, font size, direction, font name.
    """
    items: list[TextItem] = []
    walls: dict[str, list[list[float]]] = {}
    geo: dict[str, dict] = {}
    for pno, page in enumerate(doc):
        where = f"page:{pno + 1}"
        maps = _glyph_maps(doc, page)
        cache: dict = {}
        spans = []
        for sp in page.get_texttrace():
            if sp.get("type", 0) not in (0, 1, 2):   # 3 = invisible/clipped text
                continue
            text = _span_text(sp, maps, cache)
            if not text.strip():
                continue
            x0, y0, x1, y1 = sp["bbox"]
            spans.append({"text": text, "bbox": [x0, y0, x1, y1], "size": sp["size"], "dir": tuple(sp["dir"]),
                          "font": sp["font"], "space": sp.get("spacewidth", 0.25) * sp["size"]})
        # Grouping: PyMuPDF's own line detection (dict mode) decides which
        # spans form a line; each decoded trace span joins the dict line that
        # contains its centre. Spans that match no line stand alone.
        dict_lines = []
        for b in page.get_text("dict")["blocks"]:
            if b["type"] != 0:
                continue
            for l in b["lines"]:
                dict_lines.append({"bbox": l["bbox"], "dir": tuple(l["dir"]), "spans": []})
        for sp in spans:
            cx = (sp["bbox"][0] + sp["bbox"][2]) / 2
            cy = (sp["bbox"][1] + sp["bbox"][3]) / 2
            home = None
            for dl in dict_lines:
                x0, y0, x1, y1 = dl["bbox"]
                if x0 - 1 <= cx <= x1 + 1 and y0 - 1 <= cy <= y1 + 1 and dl["dir"] == sp["dir"]:
                    home = dl
                    break
            if home is None:
                dict_lines.append({"bbox": sp["bbox"], "dir": sp["dir"], "spans": [sp]})
            else:
                home["spans"].append(sp)
        lines = [dl["spans"] for dl in dict_lines if dl["spans"]]
        n = 0
        for ln in lines:
            ln.sort(key=lambda s: s["bbox"][0] if s["dir"][0] > 0.5 else -s["bbox"][3])
            parts = []
            for i, sp in enumerate(ln):
                if i and parts:
                    gap = (sp["bbox"][0] - ln[i - 1]["bbox"][2]) if sp["dir"][0] > 0.5 else 0
                    if gap > 0.25 * sp["size"] and not parts[-1].endswith(" ") and not sp["text"].startswith(" "):
                        parts.append(" ")
                parts.append(sp["text"])
            text = " ".join("".join(parts).split())
            if not text:
                continue
            x0 = min(s["bbox"][0] for s in ln); y0 = min(s["bbox"][1] for s in ln)
            x1 = max(s["bbox"][2] for s in ln); y1 = max(s["bbox"][3] for s in ln)
            size = max(s["size"] for s in ln)
            direction = ln[0]["dir"]
            rotation = 0.0
            if abs(direction[0]) < 0.5:
                rotation = 90.0 if direction[1] < 0 else 270.0
            elif direction[0] < 0:
                rotation = 180.0
            n += 1
            handle = f"p{pno + 1}:{n}"
            items.append(TextItem(
                handle=handle, kind="PDF", where=where, layer=ln[0]["font"], style="",
                raw=text, plain=text, lang=detect_lang(text), height=size * CAP, width_factor=1.0, rotation=rotation,
                x=x0, y=-y1 + (y1 - y0) * 0.22, halign=0, ax=x0,
            ))
            geo[handle] = {"page": pno + 1, "bbox": [x0, y0, x1, y1], "size": size, "dir": list(direction),
                           "font": ln[0]["font"], "n_spans": len(ln)}
        # vertical line art = cell walls / column borders
        ws_: list[list[float]] = []
        try:
            for dr in page.get_drawings():
                for it in dr["items"]:
                    if it[0] == "l":
                        a, b = it[1], it[2]
                        if abs(a.x - b.x) <= 0.01 * max(abs(a.y - b.y), 1e-9) and abs(a.y - b.y) > 2:
                            ws_.append([float(a.x), float(-max(a.y, b.y)), float(-min(a.y, b.y))])
                    elif it[0] == "re":
                        r = it[1]
                        if r.height > 2:
                            ws_.append([float(r.x0), float(-r.y1), float(-r.y0)])
                            ws_.append([float(r.x1), float(-r.y1), float(-r.y0)])
        except Exception:
            pass
        ws_.sort()
        walls[where] = ws_
    return items, walls, geo


# ───────────────────────────── patch ─────────────────────────────

LATIN_FONT = "notos"   # Noto Sans (pymupdf-fonts): Latin + Cyrillic, so kept codes like ОК-9 still print
CJK_FONT = "japan"     # built-in CJK font; also covers Cyrillic


def _font_for(font_name: str, target: str) -> str:
    return CJK_FONT if target in ("ja", "zh") else LATIN_FONT


def apply(doc, geo: dict[str, dict], segments, approved: dict[str, str], target: str,
          width_factors: dict[str, float] | None = None):
    """Redact every patched line's box, then draw the translation at the
    same baseline. Paragraph groups are re-wrapped over their lines (see
    layout.wrap_to). Returns a PatchResult like patch.apply."""
    import pymupdf
    from .layout import wrap_to, _greedy, em_width
    from .patch import PatchResult
    from .prepare import unmark_codes, latinize

    result = PatchResult()
    width_factors = width_factors or {}
    cjk = target in ("ja", "zh")
    plan: dict[int, list[tuple[dict, str, float, str, float]]] = defaultdict(list)   # page -> (geo, text, wf, fontname, allowed width)

    for seg in segments:
        final = approved.get(seg.id)
        if final is None:
            result.skipped.extend(seg.handles)
            continue
        text = unmark_codes(final, seg.codes) if seg.codes else final
        if not cjk:
            text = latinize(text)
        for gi, (group, cap) in enumerate(zip(seg.groups, seg.caps)):
            per_line = seg.line_caps[gi] if gi < len(seg.line_caps) and seg.line_caps[gi] else [cap] * len(group)
            override = width_factors.get(seg.id)
            if override and abs(override - 1.0) > 0.01:
                lines, wf, overflow = _greedy(text, [c / override for c in per_line], cjk), override, False
                if len(lines) > len(group):
                    lines, overflow = lines[:len(group) - 1] + [(" " if not cjk else "").join(lines[len(group) - 1:])], True
            else:
                lines, wf, overflow = wrap_to(text, per_line, len(group), cjk)
            if overflow and seg.id not in result.overflow:
                result.overflow.append(seg.id)
            for i, handle in enumerate(group):
                g = geo.get(handle)
                if g is None:
                    result.skipped.append(handle)
                    continue
                allowed = per_line[min(i, len(per_line) - 1)] * g["size"] * CAP
                plan[g["page"]].append((g, lines[i] if i < len(lines) else "", wf, _font_for(g["font"], target), allowed))
                result.patched += 1
                if abs(wf - 1.0) > 0.01:
                    result.width_factors += 1

    for pno, entries in plan.items():
        page = doc[pno - 1]
        for g, _, _, _, _ in entries:
            page.add_redact_annot(pymupdf.Rect(*g["bbox"]))
        page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE, graphics=pymupdf.PDF_REDACT_LINE_ART_NONE)
        for g, line, wf, fontname, allowed in entries:
            if not line:
                continue
            x0, y0, x1, y1 = g["bbox"]
            size = g["size"]
            rot = 0
            dx, dy = g["dir"]
            if abs(dx) < 0.5:
                rot = 90 if dy < 0 else 270
            elif dx < 0:
                rot = 180
            # baseline: descent is about 22% of the box for these fonts
            if rot == 0:
                origin = pymupdf.Point(x0, y1 - (y1 - y0) * 0.22)
            elif rot == 90:
                origin = pymupdf.Point(x0 + (x1 - x0) * 0.78, y1)
            elif rot == 270:
                origin = pymupdf.Point(x1 - (x1 - x0) * 0.78, y0)
            else:
                origin = pymupdf.Point(x1, y0 + (y1 - y0) * 0.22)
            # narrow to fit the original box as well as the layout's factor
            avail = max(allowed, (x1 - x0) if rot in (0, 180) else (y1 - y0))
            need = pymupdf.get_text_length(line, fontname=fontname, fontsize=size)
            sx = min(avail / need if need > 0 else 1.0, 1.0)
            sx = max(sx, 0.55)
            m = pymupdf.Matrix(sx, 1) if rot in (0, 180) else pymupdf.Matrix(1, sx)
            try:
                page.insert_text(origin, line, fontsize=size, fontname=fontname, rotate=rot, morph=(origin, m))
            except Exception:
                result.skipped.append(f"p{pno}")
    return result


def fingerprint(doc) -> tuple[int, str]:
    """Count + hash of line art per page: proves the drawing did not change."""
    import hashlib
    h = hashlib.sha256()
    n = 0
    for page in doc:
        for dr in page.get_drawings():
            n += 1
            h.update(str(dr.get("rect")).encode())
            h.update(str(len(dr.get("items", []))).encode())
    return n, h.hexdigest()
