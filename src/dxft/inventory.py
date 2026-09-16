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
    kind: str            # TEXT | MTEXT | ATTRIB | DIMENSION | MLEADER
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


def walls(doc: Drawing, limit: int = 400_000) -> dict[str, list[list[float]]]:
    """Vertical line segments per space: [x, y_low, y_high]. Table borders and
    title-block cells are made of these; they bound how far text can grow.
    Lines inside block references count too (some converters wrap every
    line in its own block), placed where the reference puts them."""
    out: dict[str, list[list[float]]] = {}
    spaces = [("model", doc.modelspace())] + [(f"paper:{lo.name}", lo) for lo in doc.layouts if lo.name != "Model"]

    def add(ws: list[list[float]], e) -> None:
        t = e.dxftype()
        if t == "LINE":
            a, b = e.dxf.start, e.dxf.end
            if abs(a.x - b.x) <= 0.01 * max(abs(a.y - b.y), 1e-9):
                ws.append([float(a.x), float(min(a.y, b.y)), float(max(a.y, b.y))])
        elif t == "LWPOLYLINE":
            pts = list(e.get_points("xy"))
            if e.closed and pts:
                pts.append(pts[0])
            for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
                if abs(x0 - x1) <= 0.01 * max(abs(y0 - y1), 1e-9):
                    ws.append([float(x0), float(min(y0, y1)), float(max(y0, y1))])

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
                    height=float(e.dxf.char_height), rotation=float(e.dxf.rotation),
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
