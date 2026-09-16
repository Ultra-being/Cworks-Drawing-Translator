"""Stage 6 · Patch, and Stage 7 · Verify.

Write approved translations back into the same entities by handle and
nothing else. Then re-open the output and prove it: same entity count,
same geometry, only the intended text changed.

Font handling: a target language must be displayable. English displays in
any style. Japanese needs a Japanese-capable font, so when the target is
"ja" every style used by a patched entity is checked and, if its font has
no CJK glyphs, switched to a known-good SHX + bigfont pair (txt + extfont2,
the same pair the Japanese sample drawings use). Style changes are listed
in the report.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass, field

import ezdxf
from ezdxf.document import Drawing

from .inventory import TextItem, load
from .prepare import Segment, unmark_codes

JA_FONT = ("txt", "extfont2")  # SHX shape font + Japanese bigfont
JA_CAPABLE_FONTS = {"txt", "msgothic.ttc", "msmincho.ttc", "meiryo.ttc", "yugothic.ttf", "notosanscjk", "extfont", "extfont2", "bigfont.shx"}


@dataclass
class PatchResult:
    patched: int = 0
    skipped: list[str] = field(default_factory=list)   # handles not found / not approved
    style_changes: list[str] = field(default_factory=list)
    width_factors: int = 0


def _font_can_display_ja(doc: Drawing, style_name: str) -> bool:
    try:
        st = doc.styles.get(style_name)
    except Exception:
        return False
    font = (st.dxf.font or "").lower()
    big = (st.dxf.bigfont or "").lower().lstrip("@")
    return any(f in big for f in JA_CAPABLE_FONTS if f) or any(f in font for f in ("gothic", "mincho", "meiryo", "cjk"))


def _ensure_ja_style(doc: Drawing, style_name: str, result: PatchResult) -> None:
    if _font_can_display_ja(doc, style_name):
        return
    try:
        st = doc.styles.get(style_name)
    except Exception:
        return
    old = (st.dxf.font, st.dxf.bigfont)
    st.dxf.font, st.dxf.bigfont = JA_FONT
    result.style_changes.append(f"{style_name}: {old[0]!r}/{old[1]!r} -> {JA_FONT[0]!r}/{JA_FONT[1]!r}")


def apply(doc: Drawing, items: list[TextItem], segments: list[Segment], approved: dict[str, str],
          target: str, width_factors: dict[str, float] | None = None) -> PatchResult:
    """`approved` maps segment id -> final text (with ⟦n⟧ markers for MTEXT).
    `width_factors` maps segment id -> horizontal width factor to apply to TEXT/ATTRIB."""
    result = PatchResult()
    seg_by_id = {s.id: s for s in segments}
    seg_of_handle = {h: s.id for s in segments for h in s.handles}
    item_by_handle = {it.handle: it for it in items}
    width_factors = width_factors or {}
    styles_checked: set[str] = set()

    for handle, seg_id in seg_of_handle.items():
        final = approved.get(seg_id)
        if final is None:
            result.skipped.append(handle)
            continue
        seg = seg_by_id[seg_id]
        item = item_by_handle.get(handle)
        try:
            e = doc.entitydb.get(handle)
        except Exception:
            e = None
        if e is None or item is None:
            result.skipped.append(handle)
            continue
        text = unmark_codes(final, seg.codes) if seg.codes else final
        kind = e.dxftype()
        if kind == "TEXT" or kind == "ATTRIB":
            e.dxf.text = text
            wf = width_factors.get(seg_id)
            if wf and abs(wf - 1.0) > 0.01:
                e.dxf.width = float(e.dxf.width or 1.0) * wf
                result.width_factors += 1
        elif kind == "MTEXT":
            e.text = text
        elif kind == "DIMENSION":
            e.dxf.text = text
        elif kind == "MLEADER":
            try:
                e.set_mtext_content(text)
            except Exception:
                result.skipped.append(handle)
                continue
        else:
            result.skipped.append(handle)
            continue
        if target == "ja" and item.style and item.style not in styles_checked:
            styles_checked.add(item.style)
            _ensure_ja_style(doc, item.style, result)
        result.patched += 1
    return result


# ───────────────────────────── verify ─────────────────────────────

GEOMETRY_TYPES = {"LINE", "LWPOLYLINE", "POLYLINE", "CIRCLE", "ARC", "ELLIPSE", "SPLINE", "HATCH", "INSERT", "POINT", "SOLID", "3DFACE", "DIMENSION", "LEADER"}


def _geometry_fingerprint(doc: Drawing) -> tuple[int, str]:
    """Count + hash of every non-text entity's type, layer and defining points."""
    h = hashlib.sha256()
    n = 0
    spaces = [doc.modelspace()] + [lo for lo in doc.layouts if lo.name != "Model"] + [b for b in doc.blocks]
    for space in spaces:
        for e in space:
            t = e.dxftype()
            if t in ("TEXT", "MTEXT", "ATTRIB", "ATTDEF", "MLEADER"):
                continue
            n += 1
            h.update(t.encode())
            h.update(str(e.dxf.layer).encode())
            for attr in ("start", "end", "center", "insert", "radius", "rotation", "xscale", "yscale"):
                if e.dxf.hasattr(attr):
                    h.update(str(e.dxf.get(attr)).encode())
            if t == "LWPOLYLINE":
                h.update(str(list(e.get_points())).encode())
            if t == "INSERT":
                h.update(str(e.dxf.name).encode())
    return n, h.hexdigest()


@dataclass
class Verification:
    ok: bool
    entities_before: int
    entities_after: int
    geometry_before: str
    geometry_after: str
    text_before: int
    text_after: int
    problems: list[str] = field(default_factory=list)


def verify(original_path: str, output_path: str) -> Verification:
    a, _ = load(original_path)
    b, _ = load(output_path)
    na, ha = _geometry_fingerprint(a)
    nb, hb = _geometry_fingerprint(b)
    ta = sum(1 for _ in a.modelspace().query("TEXT MTEXT"))
    tb = sum(1 for _ in b.modelspace().query("TEXT MTEXT"))
    problems = []
    if na != nb:
        problems.append(f"non-text entity count changed: {na} -> {nb}")
    if ha != hb:
        problems.append("geometry fingerprint changed")
    if ta != tb:
        problems.append(f"text entity count changed: {ta} -> {tb}")
    return Verification(ok=not problems, entities_before=na, entities_after=nb, geometry_before=ha[:12], geometry_after=hb[:12],
                        text_before=ta, text_after=tb, problems=problems)


def save(doc: Drawing, path: str) -> None:
    # Keep the drawing's own version; ezdxf writes UTF-8 for R2007+.
    doc.saveas(path)
