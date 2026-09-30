"""Stage 1 · Inventory.

Open a DXF, find every text-bearing entity, and record it with enough
context to translate it well and put it back exactly where it came from.
Nothing is modified. Output: a list of TextItem records (JSON-serialisable).

Entity handles are the stable identity: patch.py finds entities by handle.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, asdict, field
from typing import Iterable

import ezdxf
from ezdxf import recover
from ezdxf.document import Drawing

CYR = re.compile(r"[Ѐ-ӿ]")
JA = re.compile(r"[぀-ヿ一-鿿ｦ-ﾟ]")
LAT = re.compile(r"[A-Za-z]")

# DXF field codes that the model must never see or alter.
DIM_PLACEHOLDER = "<>"


def detect_lang(s: str) -> str:
    """Coarse language tag used for routing and counting."""
    if CYR.search(s):
        return "ru"
    if JA.search(s):
        return "ja"
    if LAT.search(s):
        return "en"
    return "none"  # numbers, symbols, empty


@dataclass
class TextItem:
    handle: str
    kind: str            # TEXT | MTEXT | ATTRIB | DIMENSION | MLEADER | TABLE_CELL
    where: str           # model | paper:<layout> | block:<name>
    layer: str
    style: str
    raw: str             # exactly as stored (MTEXT keeps its format codes)
    plain: str           # what a human reads
    lang: str
    height: float = 0.0
    width_factor: float = 1.0
    rotation: float = 0.0
    x: float = 0.0
    y: float = 0.0
    vertical: bool = False
    block_owner: str = ""  # for ATTRIB: the INSERT handle
    tag: str = ""          # for ATTRIB: the attribute tag
    box_width: float = 0.0 # MTEXT wrap width, 0 = unlimited
    halign: int = 0        # TEXT/ATTRIB: 0 left, 1 centre, 2 right, 3 aligned, 4 middle, 5 fit
    ax: float = 0.0        # TEXT/ATTRIB: alignment point x (== x when left aligned)

    def to_dict(self) -> dict:
        return asdict(self)


def _is_vertical(doc: Drawing, style_name: str) -> bool:
    try:
        st = doc.styles.get(style_name)
    except Exception:
        return False
    big = (st.dxf.bigfont or "")
    font = (st.dxf.font or "")
    # AutoCAD marks vertical styles with a leading "@" on the (big)font, and
    # the style flag bit 4 (0x04) means "vertical text".
    return big.startswith("@") or font.startswith("@") or bool(getattr(st.dxf, "flags", 0) & 4)


def _align_x(e) -> float:
    """X of the alignment point for centred/right text, else the insert x."""
    try:
        if int(e.dxf.halign) in (1, 2, 4) and e.dxf.hasattr("align_point"):
            return float(e.dxf.align_point.x)
    except Exception:
        pass
    return float(e.dxf.insert.x)


FRAME_WORDS = ("図枠", "図面枠", "frame", "border", "рамк", "титул")


SHEET_NO = re.compile(r"^\s*([A-Z]{1,3})\s*[-‐−ー–]\s*(\d{1,3})\s*$")


def _sheet_number(doc: Drawing, box: list[float]) -> str | None:
    """The sheet's own number, off its title block. A drawing says which sheet
    each of its frames is; where the frame happens to sit in the file says
    nothing -- a drafter parks them wherever there is room."""
    w = max(box[2] - box[0], 1.0)
    h = max(box[3] - box[1], 1.0)
    best = None
    for e in doc.modelspace():
        if e.dxftype() not in ("TEXT", "MTEXT"):
            continue
        try:
            txt = e.dxf.text if e.dxftype() == "TEXT" else e.plain_text()
            x, y = e.dxf.insert[0], e.dxf.insert[1]
        except Exception:
            continue
        if not (box[0] <= x <= box[2] and box[1] <= y <= box[3]):
            continue
        m = SHEET_NO.match(txt or "")
        if not m:
            continue
        # the number sits in the title block: bottom right of the sheet
        score = (x - box[0]) / w - (y - box[1]) / h
        if best is None or score > best[0]:
            best = (score, f"{m.group(1)}-{m.group(2)}")
    return best[1] if best else None


def sheet_frames(doc: Drawing, min_size: float = 5_000.0) -> list[dict]:
    r"""The sheets, as the drafter drew them.

    A drawing set almost always carries its own sheet borders, on a layer that
    says as much in its name -- 図枠 (drawing frame), рамка, "border". Those
    rectangles are what a sheet actually is, and reading them beats guessing
    from where the text happens to fall: text clusters split a sheet wherever
    its notes leave a gap, and join sheets that sit close together.

    Frame lines are grouped by proximity and each group's extent is one sheet.
    A border drawn as two nested rectangles, an outer edge and an inner margin,
    gives one group and so one sheet, which is what is wanted.
    """
    placed = _frame_inserts(doc, min_size)
    if placed:
        return [{"box": b, "name": _sheet_number(doc, b)} for b in placed]
    layers = [l.dxf.name for l in doc.layers
              if any(w.lower() in l.dxf.name.lower() for w in FRAME_WORDS)]
    if not layers:
        return []
    wanted = set(layers)
    pts: list[tuple[float, float]] = []
    joined: list[tuple[int, int]] = []      # ends of one line are one thing
    for e in doc.modelspace():
        if e.dxf.layer not in wanted:
            continue
        try:
            if e.dxftype() == "LINE":
                a, b = e.dxf.start, e.dxf.end
                got = [(a[0], a[1]), (b[0], b[1])]
            elif e.dxftype() == "LWPOLYLINE":
                got = [(q[0], q[1]) for q in e.get_points("xy")]
            else:
                continue
        except Exception:
            continue
        first = len(pts)
        pts += got
        joined += [(first, first + k) for k in range(1, len(got))]
    if len(pts) < 4:
        return []

    # Two frame lines belong to the same sheet when they are nearer to each
    # other than sheets are to one another. A sheet is thousands of units
    # across; the gap between its own lines is a margin, a few hundred.
    span = max(max(p[0] for p in pts) - min(p[0] for p in pts),
               max(p[1] for p in pts) - min(p[1] for p in pts), 1.0)
    gap = max(min_size * 0.5, span * 0.01)
    parent = list(range(len(pts)))

    def find(a: int) -> int:
        while parent[a] != a:
            parent[a] = parent[parent[a]]; a = parent[a]
        return a

    # A border is a rectangle: its corners are a whole sheet apart and are
    # only related through the lines that run between them. Join each line's
    # own ends before looking at what is near what, or every corner becomes a
    # cluster of one and no sheet is ever found.
    for a, b in joined:
        parent[find(a)] = find(b)

    buckets: dict[tuple[int, int], list[int]] = {}
    for i, (x, y) in enumerate(pts):
        buckets.setdefault((int(x // gap), int(y // gap)), []).append(i)
    for (cx, cy), members in buckets.items():
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for j in buckets.get((cx + dx, cy + dy), ()):
                    for i in members:
                        if abs(pts[i][0] - pts[j][0]) <= gap and abs(pts[i][1] - pts[j][1]) <= gap:
                            parent[find(i)] = find(j)
    groups: dict[int, list[int]] = {}
    for i in range(len(pts)):
        groups.setdefault(find(i), []).append(i)
    out = []
    for members in groups.values():
        xs = [pts[i][0] for i in members]; ys = [pts[i][1] for i in members]
        w, h = max(xs) - min(xs), max(ys) - min(ys)
        if w >= min_size and h >= min_size:
            out.append([min(xs), min(ys), max(xs), max(ys)])
    return [{"box": b, "name": _sheet_number(doc, b)} for b in out]


def _frame_inserts(doc: Drawing, min_size: float) -> list[list[float]]:
    """Sheets whose border is a block, placed once per sheet. A set of four
    drawings on one file is four inserts of the same title block, which says
    where each sheet is more exactly than anything else in the file."""
    from ezdxf import bbox
    out = []
    for e in doc.modelspace():
        if e.dxftype() != "INSERT":
            continue
        name = e.dxf.name or ""
        if not any(w.lower() in name.lower() for w in FRAME_WORDS):
            continue
        try:
            box = bbox.extents([e])
        except Exception:
            continue
        if box is None or not box.has_data:
            continue
        w, h = box.size.x, box.size.y
        if w >= min_size and h >= min_size:
            out.append([box.extmin.x, box.extmin.y, box.extmax.x, box.extmax.y])
    return out


def walls(doc: Drawing, limit: int = 400_000) -> dict[str, list[list[float]]]:
    """Vertical line segments per space: [x, y_low, y_high]. Table borders and
    title-block cells are made of these; they bound how far text can grow."""
    return _rules(doc, True, limit)


def floors(doc: Drawing, limit: int = 400_000) -> dict[str, list[list[float]]]:
    """Horizontal line segments per space: [y, x_low, x_high]. The same table
    borders seen the other way: these are what a cell's text would run into
    if it took another line."""
    return _rules(doc, False, limit)


def _rules(doc: Drawing, vertical: bool, limit: int) -> dict[str, list[list[float]]]:
    """Straight line segments along one axis, per space. Lines inside block
    references count too (some converters wrap every line in its own block),
    placed where the reference puts them."""
    out: dict[str, list[list[float]]] = {}
    # Block definitions are spaces too, and text inside one is inventoried at
    # that block's own coordinates. A title block holds its cell rules and its
    # words together, so the rules must be gathered there as well -- read only
    # from model space, a caption in a title block has no cell walls at all and
    # nothing stops it running into the box beside it.
    spaces = [("model", doc.modelspace())] + [(f"paper:{lo.name}", lo) for lo in doc.layouts if lo.name != "Model"]
    spaces += [(f"block:{b.name}", b) for b in doc.blocks
               if not b.name.startswith(("*Model_Space", "*Paper_Space"))]

    def straight(ws: list[list[float]], x0: float, y0: float, x1: float, y1: float) -> None:
        along = (y0, y1) if vertical else (x0, x1)      # the way the line runs
        across = (x0, x1) if vertical else (y0, y1)     # the way it must not
        if abs(across[0] - across[1]) <= 0.01 * max(abs(along[0] - along[1]), 1e-9):
            ws.append([float(across[0]), float(min(along)), float(max(along))])

    def add(ws: list[list[float]], e) -> None:
        t = e.dxftype()
        if t == "LINE":
            a, b = e.dxf.start, e.dxf.end
            straight(ws, a.x, a.y, b.x, b.y)
        elif t == "LWPOLYLINE":
            pts = list(e.get_points("xy"))
            if e.closed and pts:
                pts.append(pts[0])
            for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
                straight(ws, x0, y0, x1, y1)

    for where, space in spaces:
        ws: list[list[float]] = []
        for e in space:
            if len(ws) >= limit:
                break
            try:
                if e.dxftype() == "INSERT":
                    for v in e.virtual_entities():
                        if v.dxftype() in ("LINE", "LWPOLYLINE"):
                            add(ws, v)
                        elif v.dxftype() == "INSERT":  # one level of nesting is plenty
                            for vv in v.virtual_entities():
                                if vv.dxftype() in ("LINE", "LWPOLYLINE"):
                                    add(ws, vv)
                else:
                    add(ws, e)
            except Exception:
                continue
        ws.sort()
        out[where] = ws
    return out


def _plain_mtext(value: str) -> str:
    try:
        from ezdxf.tools.text import plain_mtext
        return plain_mtext(value)
    except Exception:
        return value


CHUNK = 250


def _cell_blocks(table):
    """Yield (subclass tags, start, end) for every CELL_VALUE ... ACVALUE_END
    block of an ACAD_TABLE."""
    try:
        subclasses = table.xtags.subclasses
    except AttributeError:
        return
    for sc in subclasses:
        if not sc or sc[0] != (100, "AcDbTable"):
            continue
        i = 0
        while i < len(sc):
            if sc[i].code == 301 and sc[i].value == "CELL_VALUE":
                j = i + 1
                while j < len(sc) and not (sc[j].code == 304 and sc[j].value == "ACVALUE_END"):
                    j += 1
                yield sc, i, j
                i = j
            i += 1


def _cell_text(sc, i, j) -> str:
    """Text of one cell block: the code-2 chunks followed by the code-1 tail
    (AutoCAD splits strings over 250 characters); a short cell is code 1 only."""
    return "".join(str(sc[k].value) for k in range(i, j) if sc[k].code == 2) + \
           "".join(str(sc[k].value) for k in range(i, j) if sc[k].code == 1)


def table_cells(table) -> list[tuple[int, str]]:
    """(cell index, text) for every text cell of an ACAD_TABLE, in tag order.
    The index counts CELL_VALUE blocks, so it is stable for patching."""
    out: list[tuple[int, str]] = []
    for idx, (sc, i, j) in enumerate(_cell_blocks(table)):
        text = _cell_text(sc, i, j)
        if text:
            out.append((idx, text))
    return out


def set_table_cell(table, idx: int, new: str) -> str | None:
    """Write a cell's text back in AutoCAD's own layout: code-2 chunks + code-1
    tail, mirrored as code-303 chunks + code-302 tail. Returns the old text,
    or None if the cell was not found."""
    from ezdxf.lldxf.types import DXFTag
    for n, (sc, i, j) in enumerate(_cell_blocks(table)):
        if n != idx:
            continue
        old = _cell_text(sc, i, j)
        chunks = [new[k:k + CHUNK] for k in range(0, len(new), CHUNK)] or [""]
        head, tail = chunks[:-1], chunks[-1]
        first_a = next((k for k in range(i, j) if sc[k].code in (1, 2)), None)
        first_b = next((k for k in range(i, j) if sc[k].code in (302, 303)), None)
        if first_a is None:
            return None
        keep = [tag for k, tag in enumerate(sc[i:j], start=i) if tag.code not in (1, 2, 302, 303)]
        # rebuild the block: everything else in order, text tags at their original positions
        rebuilt = []
        inserted_a = inserted_b = False
        for k in range(i, j):
            tag = sc[k]
            if tag.code in (1, 2):
                if not inserted_a:
                    rebuilt += [DXFTag(2, c) for c in head] + [DXFTag(1, tail)]
                    inserted_a = True
                continue
            if tag.code in (302, 303):
                if not inserted_b:
                    rebuilt += [DXFTag(303, c) for c in head] + [DXFTag(302, tail)]
                    inserted_b = True
                continue
            rebuilt.append(tag)
        if first_b is None and not inserted_b:   # short cells sometimes carry only 1 + 302; keep the mirror
            pass
        sc[i:j] = rebuilt
        return old
    return None


W_CODE = re.compile(r"\\W([\d.]+);")


def mtext_width_factor(raw: str) -> float:
    r"""The width factor an MTEXT is really drawn at. A TEXT entity carries one
    in a DXF attribute; an MTEXT carries it inline as \W, and a drafter who set
    a line to \W1.134 has made it 13% wider than the measuring assumes. Codes
    inside braces are scoped to their group, so the line's own factor is the
    first one that is not in a group."""
    depth = 0
    i = 0
    while i < len(raw):
        c = raw[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth = max(depth - 1, 0)
        elif c == "\\" and depth == 0:
            m = W_CODE.match(raw, i)
            if m:
                try:
                    return float(m.group(1)) or 1.0
                except ValueError:
                    return 1.0
            i += 1   # some other code; step over its backslash
        i += 1
    return 1.0


def linked_files(doc: Drawing) -> list[str]:
    """Files this drawing points at but does not contain: placed images, PDF
    and DWF underlays, external references.

    A drawing that shows a scanned map is often holding only the path to it.
    Sent on its own the picture is gone, and the reader is left with the file
    name drawn across the sheet in letters an inch high -- which looks like
    text that failed to translate, and is not text at all.
    """
    out: list[str] = []
    for o in doc.objects:
        if o.dxftype() not in ("IMAGEDEF", "PDFDEFINITION", "DWFDEFINITION", "DGNDEFINITION"):
            continue
        try:
            name = str(o.dxf.filename or "").strip()
        except Exception:
            continue
        if name:
            out.append(name)
    for b in doc.blocks:
        try:
            path = str(b.block.dxf.xref_path or "").strip()
        except Exception:
            continue
        # A reference that was bound keeps the path it came from but carries
        # its drawing with it. Only an empty one is actually missing.
        if path and not any(True for _ in b):
            out.append(path)
    return sorted(set(out))


def _walk(doc: Drawing, space: Iterable, where: str, out: list[TextItem]) -> None:
    for e in space:
        t = e.dxftype()
        try:
            if t == "TEXT":
                out.append(TextItem(
                    handle=e.dxf.handle, kind=t, where=where, layer=e.dxf.layer, style=e.dxf.style,
                    raw=e.dxf.text, plain=e.dxf.text, lang=detect_lang(e.dxf.text),
                    height=float(e.dxf.height), width_factor=float(e.dxf.width), rotation=float(e.dxf.rotation),
                    x=float(e.dxf.insert.x), y=float(e.dxf.insert.y), vertical=_is_vertical(doc, e.dxf.style),
                    halign=int(e.dxf.halign), ax=_align_x(e),
                ))
            elif t == "MTEXT":
                out.append(TextItem(
                    handle=e.dxf.handle, kind=t, where=where, layer=e.dxf.layer, style=e.dxf.style,
                    raw=e.text, plain=e.plain_text(), lang=detect_lang(e.plain_text()),
                    height=float(e.dxf.char_height), width_factor=mtext_width_factor(e.text),
                    rotation=float(e.dxf.rotation),
                    x=float(e.dxf.insert.x), y=float(e.dxf.insert.y), box_width=float(e.dxf.width or 0.0),
                ))
            elif t == "INSERT":
                for a in e.attribs:
                    out.append(TextItem(
                        handle=a.dxf.handle, kind="ATTRIB", where=where, layer=a.dxf.layer, style=a.dxf.style,
                        raw=a.dxf.text, plain=a.dxf.text, lang=detect_lang(a.dxf.text),
                        height=float(a.dxf.height), width_factor=float(a.dxf.width), rotation=float(a.dxf.rotation),
                        x=float(a.dxf.insert.x), y=float(a.dxf.insert.y), block_owner=e.dxf.handle, tag=a.dxf.tag,
                        halign=int(a.dxf.halign), ax=_align_x(a),
                    ))
            elif t == "DIMENSION":
                txt = e.dxf.text or ""
                if txt and txt != DIM_PLACEHOLDER:
                    out.append(TextItem(
                        handle=e.dxf.handle, kind=t, where=where, layer=e.dxf.layer, style=e.dxf.dimstyle,
                        raw=txt, plain=txt.replace(DIM_PLACEHOLDER, " "), lang=detect_lang(txt),
                    ))
            elif t == "ACAD_TABLE":
                # Cell text lives in the table's own tags (code 302, mirrored in
                # code 1) as MTEXT-formatted strings; the handle is table:cell index.
                for idx, value in table_cells(e):
                    if not value:
                        continue
                    plain = _plain_mtext(value)
                    out.append(TextItem(
                        handle=f"{e.dxf.handle}:{idx}", kind="TABLE_CELL", where=where, layer=e.dxf.layer, style="",
                        raw=value, plain=plain, lang=detect_lang(plain), block_owner=e.dxf.get("geometry", ""),
                    ))
            elif t == "MLEADER":
                try:
                    content = e.get_mtext_content()
                except Exception:
                    content = ""
                if content:
                    out.append(TextItem(
                        handle=e.dxf.handle, kind=t, where=where, layer=e.dxf.layer, style="",
                        raw=content, plain=ezdxf.tools.text.plain_mtext(content) if hasattr(ezdxf.tools, "text") else content,
                        lang=detect_lang(content),
                    ))
        except Exception as ex:  # never let one odd entity stop the inventory
            out.append(TextItem(handle=getattr(e.dxf, "handle", "?"), kind=t, where=where, layer="", style="",
                                raw="", plain=f"[unreadable: {ex}]", lang="none"))


def load(path: str) -> tuple[Drawing, int]:
    """Open a DXF tolerantly. Returns the document and the audit error count."""
    doc, auditor = recover.readfile(path)
    return doc, len(auditor.errors)


def inventory(doc: Drawing) -> list[TextItem]:
    out: list[TextItem] = []
    _walk(doc, doc.modelspace(), "model", out)
    for layout in doc.layouts:
        if layout.name != "Model":
            _walk(doc, layout, f"paper:{layout.name}", out)
    for block in doc.blocks:
        if block.name.startswith("*"):  # anonymous / layout blocks
            continue
        _walk(doc, block, f"block:{block.name}", out)
    return out


def summary(items: list[TextItem]) -> dict:
    by_lang: dict[str, int] = {}
    by_kind: dict[str, int] = {}
    for it in items:
        by_lang[it.lang] = by_lang.get(it.lang, 0) + 1
        by_kind[it.kind] = by_kind.get(it.kind, 0) + 1
    return {
        "strings": len(items),
        "unique": len({it.plain for it in items}),
        "by_lang": by_lang,
        "by_kind": by_kind,
        "vertical": sum(1 for it in items if it.vertical),
    }
