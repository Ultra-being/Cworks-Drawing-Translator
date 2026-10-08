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

import gc
import hashlib
import os
import re
from dataclasses import dataclass, field

import ezdxf
from ezdxf.document import Drawing

from .inventory import TextItem, load, set_table_cell, is_space_block as inv_is_space_block
from .layout import wrap_best, _greedy, em_width
from .inventory import W_CODE
from .translate import TABLE_GAP, _repad
from .prepare import MARK_RE, Segment, unmark_codes, latinize

JA_FONT = ("txt", "extfont2")  # SHX shape font + Japanese bigfont
# English output is set to a TrueType font every viewer has, and widths are
# measured with the same metrics (layout.Measurer): what fits here fits there.
EN_FONT = os.environ.get("DXFT_EN_FONT", "arial.ttf")
JA_CAPABLE_FONTS = {"txt", "msgothic.ttc", "msmincho.ttc", "meiryo.ttc", "yugothic.ttf", "notosanscjk", "extfont", "extfont2", "bigfont.shx"}


@dataclass
class PatchResult:
    patched: int = 0
    skipped: list[str] = field(default_factory=list)   # handles not found / not approved
    style_changes: list[str] = field(default_factory=list)
    width_factors: int = 0
    overflow: list[str] = field(default_factory=list)  # segment ids that still do not fit
    added_lines: int = 0      # lines written under a cell that could not hold its text on one
    widened_forms: int = 0    # full-width characters put into ASCII so the Latin font can draw them
    boxed: int = 0            # MTEXT boxes pulled in to the cell they sit in


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


def _ensure_en_style(doc: Drawing, style_name: str, result: PatchResult) -> None:
    if not EN_FONT:
        return
    try:
        st = doc.styles.get(style_name)
    except Exception:
        return
    old = (st.dxf.font, st.dxf.bigfont)
    if (old[0] or "").lower() == EN_FONT.lower():
        return
    st.dxf.font, st.dxf.bigfont = EN_FONT, ""
    result.style_changes.append(f"{style_name}: {old[0]!r}/{old[1]!r} -> {EN_FONT!r}")


def apply(doc: Drawing, items: list[TextItem], segments: list[Segment], approved: dict[str, str],
          target: str, width_factors: dict[str, float] | None = None) -> PatchResult:
    """`approved` maps segment id -> final text (with ⟦n⟧ markers for MTEXT).
    `width_factors` maps segment id -> a reviewer's explicit width factor; when
    absent, TEXT/ATTRIB is re-wrapped over its lines and narrowed only as much
    as needed (layout.wrap_best)."""
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
        if item.style and item.style not in styles_checked:
            styles_checked.add(item.style)
            if target == "ja":
                _ensure_ja_style(doc, item.style, result)
            else:
                _ensure_en_style(doc, item.style, result)

    for seg in segments:
        final = approved.get(seg.id)
        if final is None:
            result.skipped.extend(seg.handles)
            continue
        text = unmark_codes(final, seg.codes) if seg.codes else final
        if not cjk:
            text = latinize(text)
        kind = seg.kinds[0] if seg.kinds else ""

        # Unboxed MTEXT is one line that grows to the right, exactly like TEXT,
        # so it is fitted the same way. It is narrowed with an inline \W code
        # rather than a width attribute, which is how MTEXT carries the same idea.
        line_like = bool(seg.groups) and any(c > 0 for c in seg.caps)
        # Fit on what will be *visible*. MTEXT carries inline formatting codes
        # (\fArial|b0|i0; and the like); measuring those as printable characters
        # would make every formatted string look far too wide to fit.
        measure = MARK_RE.sub("", final) if seg.codes else text
        if kind in ("TEXT", "ATTRIB", "MTEXT") and line_like:
            if seg.lines == 1:
                text = _repad(seg.source, text)   # table rows keep their value column
            for gi, (group, cap) in enumerate(zip(seg.groups, seg.caps)):
                per_line = seg.line_caps[gi] if gi < len(seg.line_caps) and seg.line_caps[gi] else cap
                override = width_factors.get(seg.id)
                if override and abs(override - 1.0) > 0.01:
                    scaled = [c / override for c in per_line] if isinstance(per_line, list) else (per_line / override if per_line > 0 else 1e9)
                    lines, wf, overflow = _greedy(measure, scaled, cjk), override, False
                    if len(lines) > len(group):
                        lines, overflow = lines[:len(group) - 1] + [(" " if not cjk else "").join(lines[len(group) - 1:])], True
                else:
                    per_line_max = (seg.line_caps_max[gi]
                                    if gi < len(seg.line_caps_max) and seg.line_caps_max[gi] else per_line)
                    spare = seg.spare[gi] if gi < len(seg.spare) else 0
                    lines, wf, overflow = wrap_best(measure, per_line, per_line_max, len(group), cjk, spare)
                if overflow and seg.id not in result.overflow:
                    result.overflow.append(seg.id)
                if abs(wf - 1.0) > 0.01 and len(lines) == 1:
                    lines = [_repad_narrowed(lines[0], wf)]
                for i, handle in enumerate(group):
                    e, item = entity(handle), item_by_handle.get(handle)
                    if e is None or item is None or e.dxftype() not in ("TEXT", "ATTRIB", "MTEXT"):
                        result.skipped.append(handle)
                        continue
                    if e.dxftype() == "MTEXT":
                        # Narrowing rides on an inline \W. An MTEXT standing on
                        # its own keeps the code-restored string; one that is a
                        # line of a paragraph takes only its own line.
                        own = text if len(group) == 1 else (lines[i] if i < len(lines) else "")
                        e.text = narrow_mtext(own, wf)
                        if abs(wf - 1.0) > 0.01:
                            result.width_factors += 1
                        # A box set wider than its cell wraps the text through
                        # the wall. Hold it to the room measured beside it, so
                        # anything still too long goes downwards instead.
                        box = seg.boxes[gi] if gi < len(seg.boxes) else 0.0
                        if box and float(e.dxf.width or 0.0) > box:
                            e.dxf.width = box
                            result.boxed += 1
                        ja_style(item)
                        result.patched += 1
                        continue
                    e.dxf.text = lines[i] if i < len(lines) else ""
                    if abs(wf - 1.0) > 0.01:
                        e.dxf.width = float(e.dxf.width or 1.0) * wf
                        result.width_factors += 1
                    ja_style(item)
                    result.patched += 1
                # A cell too narrow for its translation takes the rest on a new
                # line in the space below it, rather than running through the
                # column beside it. Nothing that was already drawn is moved;
                # the report says how many of these were added.
                for k in range(len(group), len(lines)):
                    src = entity(group[-1])
                    item = item_by_handle.get(group[-1])
                    if src is None or item is None or src.dxftype() != "TEXT" or not lines[k].strip():
                        continue
                    try:
                        extra = src.copy()
                        drop = item.height * 1.45 * (k - len(group) + 1)
                        extra.dxf.insert = (src.dxf.insert[0], src.dxf.insert[1] - drop, src.dxf.insert[2] if len(src.dxf.insert) > 2 else 0)
                        if src.dxf.hasattr("align_point"):
                            ap = src.dxf.align_point
                            extra.dxf.align_point = (ap[0], ap[1] - drop, ap[2] if len(ap) > 2 else 0)
                        extra.dxf.text = lines[k]
                        src.get_layout().add_entity(extra)
                        result.added_lines += 1
                    except Exception:
                        continue
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

    if target != "ja" and styles_checked:
        result.widened_forms = _ascii_forms(doc, styles_checked)
    return result


FULLWIDTH = re.compile(r"[！-～　・･]")


def _ascii_forms(doc: Drawing, restyled: set[str]) -> int:
    r"""Put full-width punctuation into its ASCII form wherever a style has
    been pointed at the Latin font.

    A scale reading 1：100 is left alone by the translator -- it is a number,
    not a phrase -- but its style is switched to Arial for the English around
    it, and Arial has no full-width colon. The character the drafter typed
    becomes a hollow box. Only the forms that have an exact ASCII counterpart
    are changed; Japanese words are left as they are.
    """
    import unicodedata
    n = 0
    for space in _all_spaces(doc):
        for e in space:
            if e.dxftype() not in ("TEXT", "MTEXT") or e.dxf.style not in restyled:
                continue
            try:
                before = e.dxf.text if e.dxftype() == "TEXT" else e.text
                if not before or not FULLWIDTH.search(before):
                    continue
                after = "".join(unicodedata.normalize("NFKC", c) if FULLWIDTH.match(c) else c
                                for c in before).replace("・", "·").replace("･", "·")
                if after == before:
                    continue
                if e.dxftype() == "TEXT":
                    e.dxf.text = after
                else:
                    e.text = after
                n += 1
            except Exception:
                continue
    return n


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


def narrow_mtext(raw: str, wf: float) -> str:
    r"""Draw an MTEXT at `wf` times its normal width.

    Putting our own \W in front of the string does not do it: MTEXT reads its
    codes in order, so a factor the drafter set further along simply replaces
    ours and the text is drawn at their width -- wider than normal, in the case
    that sent section labels through the column beside them. Scaling every
    factor already in the string keeps the drafter's relative sizing (a smaller
    leading digit stays smaller) and still lands on the width we need.
    """
    if abs(wf - 1.0) <= 0.01:
        return raw
    if W_CODE.search(raw):
        return W_CODE.sub(lambda m: f"\\W{max(float(m.group(1)), 0.01) * wf:.3f};", raw)
    return f"\\W{wf:.2f};{raw}"


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
    for space in _all_spaces(doc):
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


def _all_spaces(doc: Drawing) -> list:
    """Every place an entity can live, each exactly once. Model space and the
    paper layouts are themselves blocks (*Model_Space, *Paper_Space), so a list
    of layouts plus all blocks counts their contents twice. The spelling of
    those names varies by drawing, so inventory.is_space_block folds the case."""
    out = [doc.modelspace()] + [lo for lo in doc.layouts if lo.name != "Model"]
    for b in doc.blocks:
        if not inv_is_space_block(b.name):
            out.append(b)
    return out


def _count_text(doc: Drawing) -> int:
    """Every piece of text in the drawing, wherever it lives. Counting only
    model space misses text held in a block -- and a drawing whose labels sit
    in blocks would show no change at all where a line had been added, so a
    correct patch came back reading "geometry CHANGED"."""
    return sum(1 for space in _all_spaces(doc) for e in space if e.dxftype() in ("TEXT", "MTEXT"))


def measure_doc(doc: Drawing) -> dict:
    """The three numbers verify compares, taken from a drawing already open.

    Stage 1 has the input open anyway, so taking them there and keeping them
    saves verify re-reading the input later purely to learn what it already
    knew. On a large set that is a whole pass off the slowest stage.
    """
    n, h = _geometry_fingerprint(doc)
    return {"entities": n, "geometry": h, "text": _count_text(doc)}


def verify(original_path: str, output_path: str, added_text: int = 0,
           before: dict | None = None) -> Verification:
    """Prove the drawing did not change, one file at a time.

    `before` is the input's numbers from measure_doc, taken at stage 1. Given
    them, the input is not opened again: the same comparison is made against
    the output alone. Both sides are measured by the same code off a document
    opened by the same loader, so the numbers mean what they always did.

    Both used to be open at once, which on a large drawing is two copies of
    it in memory while the patched one is very often still held by the
    caller -- three copies of a 179 MB set, about 2.4 GB, on a machine with
    2 GB. The work then takes twenty times longer than it should, not
    because anything is wrong but because the machine is out of room: one
    such drawing went from a hundred and forty seconds to forty-four
    minutes and was still going.

    Nothing about the check changes. Each file is read, measured, and let go
    before the next is opened, and the two sets of numbers are compared at
    the end as before.
    """
    def measure(path: str):
        doc, _ = load(path)
        n, h = _geometry_fingerprint(doc)
        t = _count_text(doc)
        del doc
        gc.collect()
        return n, h, t

    if before:
        na, ha, ta = before["entities"], before["geometry"], before["text"]
    else:
        na, ha, ta = measure(original_path)
    nb, hb, tb = measure(output_path)
    problems = []
    if na != nb:
        problems.append(f"non-text entity count changed: {na} -> {nb}")
    if ha != hb:
        problems.append("geometry fingerprint changed")
    if tb - ta != added_text:
        problems.append(f"text entity count changed by {tb - ta}, expected {added_text}")
    return Verification(ok=not problems, entities_before=na, entities_after=nb, geometry_before=ha[:12], geometry_after=hb[:12],
                        text_before=ta, text_after=tb, problems=problems)


def save(doc: Drawing, path: str) -> None:
    # Keep the drawing's own version; ezdxf writes UTF-8 for R2007+.
    doc.saveas(path)
