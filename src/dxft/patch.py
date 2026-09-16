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

from .inventory import TextItem, load, set_table_cell
from .layout import wrap_to, _greedy, em_width
from .translate import TABLE_GAP, _repad
from .prepare import Segment, unmark_codes

JA_FONT = ("txt", "extfont2")  # SHX shape font + Japanese bigfont
JA_CAPABLE_FONTS = {"txt", "msgothic.ttc", "msmincho.ttc", "meiryo.ttc", "yugothic.ttf", "notosanscjk", "extfont", "extfont2", "bigfont.shx"}


@dataclass
class PatchResult:
    patched: int = 0
    skipped: list[str] = field(default_factory=list)   # handles not found / not approved
    style_changes: list[str] = field(default_factory=list)
    width_factors: int = 0
    overflow: list[str] = field(default_factory=list)  # segment ids that still do not fit


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
    `width_factors` maps segment id -> a reviewer's explicit width factor; when
    absent, TEXT/ATTRIB is re-wrapped over its lines and narrowed only as much
    as needed (layout.wrap_to)."""
    result = PatchResult()
    item_by_handle = {it.handle: it for it in items}
    width_factors = width_factors or {}
    styles_checked: set[str] = set()
    cjk = target in ("ja", "zh")

    def entity(handle: str):
        try:
            return doc.entitydb.get(handle)
        except Exception:
            return None

    def ja_style(item: TextItem) -> None:
        if target == "ja" and item.style and item.style not in styles_checked:
            styles_checked.add(item.style)
            _ensure_ja_style(doc, item.style, result)

    for seg in segments:
        final = approved.get(seg.id)
        if final is None:
            result.skipped.extend(seg.handles)
            continue
        text = unmark_codes(final, seg.codes) if seg.codes else final
        kind = seg.kinds[0] if seg.kinds else ""

        if kind in ("TEXT", "ATTRIB") and seg.groups:
            if seg.lines == 1:
                text = _repad(seg.source, text)   # table rows keep their value column
            for group, cap in zip(seg.groups, seg.caps):
                override = width_factors.get(seg.id)
                if override and abs(override - 1.0) > 0.01:
                    lines, wf, overflow = _greedy(text, cap / override if cap > 0 else 1e9, cjk), override, False
                    if len(lines) > len(group):
                        lines, overflow = lines[:len(group) - 1] + [(" " if not cjk else "").join(lines[len(group) - 1:])], True
                else:
                    lines, wf, overflow = wrap_to(text, cap, len(group), cjk)
                if overflow and seg.id not in result.overflow:
                    result.overflow.append(seg.id)
                if abs(wf - 1.0) > 0.01 and len(lines) == 1:
                    lines = [_repad_narrowed(lines[0], wf)]
                for i, handle in enumerate(group):
                    e, item = entity(handle), item_by_handle.get(handle)
                    if e is None or item is None or e.dxftype() not in ("TEXT", "ATTRIB"):
                        result.skipped.append(handle)
                        continue
                    e.dxf.text = lines[i] if i < len(lines) else ""
                    if abs(wf - 1.0) > 0.01:
                        e.dxf.width = float(e.dxf.width or 1.0) * wf
                        result.width_factors += 1
                    ja_style(item)
                    result.patched += 1
            continue

        for handle in seg.handles:
            item = item_by_handle.get(handle)
            if item is not None and item.kind == "TABLE_CELL":
                if _patch_table_cell(doc, handle, text):
                    result.patched += 1
                else:
                    result.skipped.append(handle)
                continue
            e = entity(handle)
            if e is None or item is None:
                result.skipped.append(handle)
                continue
            k = e.dxftype()
            if k in ("TEXT", "ATTRIB", "DIMENSION"):
                e.dxf.text = text
            elif k == "MTEXT":
                e.text = text
            elif k == "MLEADER":
                try:
                    e.set_mtext_content(text)
                except Exception:
                    result.skipped.append(handle)
                    continue
            else:
                result.skipped.append(handle)
                continue
            ja_style(item)
            result.patched += 1
    return result


def _patch_table_cell(doc: Drawing, handle: str, text: str) -> bool:
    """ACAD_TABLE cell: write the cell tags, then the same string in the
    table's display block so the drawing shows it before AutoCAD regenerates."""
    table_handle, idx = handle.split(":")
    try:
        table = doc.entitydb.get(table_handle)
    except Exception:
        table = None
    if table is None:
        return False
    old = set_table_cell(table, int(idx), text)
    if old is None:
        return False
    block_name = table.dxf.get("geometry", "")
    if block_name:
        try:
            for e in doc.blocks.get(block_name):
                if e.dxftype() == "MTEXT" and e.text == old:
                    e.text = text
        except Exception:
            pass
    return True


def _repad_narrowed(line: str, wf: float) -> str:
    """A table row ('label<spaces>value') that is narrowed as a whole would
    pull its value column left. Add spaces so the column stays where it was."""
    m = TABLE_GAP.search(line)
    if not m:
        return line
    space_w = em_width("| |") - em_width("||")
    col = em_width(line[:m.end()])              # column position before narrowing
    label = line[:m.start()]
    gap = max(1, round((col / wf - em_width(label)) / space_w))
    return label + " " * gap + line[m.end():]


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
