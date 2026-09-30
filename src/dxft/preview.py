"""Previews: render a DXF (or a window of it) to PNG with ezdxf's matplotlib
backend, so a reviewer can see the sheet without AutoCAD.

The overview window is the extent of the drawing's text (outliers dropped,
so one stray entity far away does not shrink a sheet to a dot). A window
can also be given explicitly: the reviewer drags a rectangle on the overview
and gets that region at full resolution.
"""
from __future__ import annotations

import json
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")


def text_extent(inventory_path: Path, pad: float = 0.04) -> tuple[float, float, float, float] | None:
    """(x0, y0, x1, y1) covering the 2nd..98th percentile of text positions in model space."""
    data = json.loads(inventory_path.read_text(encoding="utf-8"))
    xs = sorted(it["x"] for it in data["items"] if it["where"] == "model" and it["kind"] in ("TEXT", "MTEXT", "ATTRIB"))
    ys = sorted(it["y"] for it in data["items"] if it["where"] == "model" and it["kind"] in ("TEXT", "MTEXT", "ATTRIB"))
    if len(xs) < 2:
        return None
    lo, hi = int(len(xs) * 0.02), max(int(len(xs) * 0.98) - 1, 0)
    x0, x1, y0, y1 = xs[lo], xs[hi], ys[lo], ys[hi]
    w, h = max(x1 - x0, 1.0), max(y1 - y0, 1.0)
    return x0 - w * pad, y0 - h * pad, x1 + w * pad * 2, y1 + h * pad * 2


# The most a sheet's window may grow beyond the text on it, as a share of
# that text's own size. Enough to take in a border, a grid and dimension
# strings; not enough to swallow the empty space between far-apart sheets.
MARGIN = 0.3

_CJK_READY = False


def ensure_cjk_fallback() -> None:
    """Make sure ezdxf's fallback font can draw Japanese/Chinese: on Linux the
    default is DejaVu (no CJK), so write the CJK font bundled with PyMuPDF to
    the cache folder, register it, and use it as the fallback."""
    global _CJK_READY
    if _CJK_READY:
        return
    _CJK_READY = True
    try:
        import os
        import pymupdf
        from ezdxf.fonts import fonts
        fm = fonts.font_manager
        current = fm.fallback_font_name()
        if "unicode" in current.lower() or "cjk" in current.lower() or "droid" in current.lower():
            return
        folder = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "dxft-fonts"
        folder.mkdir(parents=True, exist_ok=True)
        target = folder / "DroidSansFallback.ttf"
        if not target.exists():
            target.write_bytes(pymupdf.Font("japan").buffer)
        fm.scan_folder(folder)
        fm._fallback_font_name = target.name
    except Exception:
        pass


CJK_FONT_FILE = "DroidSansFallback.ttf"


def cjk_font_status() -> dict:
    """What the renderer would use — for /api/debug/fonts."""
    ensure_cjk_fallback()
    from ezdxf.fonts import fonts
    fm = fonts.font_manager
    info = {"fallback": None, "has_cjk_file": None, "resolves_arial": None, "resolves_txt": None, "cache_size": None}
    try:
        info["fallback"] = fm.fallback_font_name()
        info["has_cjk_file"] = fm.has_font(CJK_FONT_FILE)
        info["resolves_arial"] = str(fm.get_font_face("arial.ttf"))
        info["resolves_txt"] = str(fm.get_font_face("txt"))
        info["cache_size"] = len(getattr(fm._font_cache, "_cache", {}))
    except Exception as ex:
        info["error"] = repr(ex)
    return info


def _point_cjk_styles_at_cjk_font(doc) -> list[str]:
    """Preview only: every text style used by a string with CJK characters is
    set to the bundled CJK font, so the picture shows the characters whatever
    the platform's fallback is. The document on disk is never touched."""
    import re
    from ezdxf.fonts import fonts
    fm = fonts.font_manager
    if not fm.has_font(CJK_FONT_FILE):
        return []
    cjk = re.compile(r"[぀-ヿ一-鿿ｦ-ﾟ]")
    styles: set[str] = set()
    spaces = [doc.modelspace()] + [lo for lo in doc.layouts if lo.name != "Model"] + list(doc.blocks)
    for space in spaces:
        for e in space:
            t = e.dxftype()
            try:
                if t == "TEXT" and cjk.search(e.dxf.text):
                    styles.add(e.dxf.style)
                elif t == "MTEXT" and cjk.search(e.plain_text()):
                    styles.add(e.dxf.style)
                elif t == "INSERT":
                    for a in e.attribs:
                        if cjk.search(a.dxf.text):
                            styles.add(a.dxf.style)
            except Exception:
                continue
    changed = []
    for name in styles:
        try:
            st = doc.styles.get(name)
            st.dxf.font = CJK_FONT_FILE
            st.dxf.bigfont = ""
            changed.append(name)
        except Exception:
            continue
    return changed


def _stop_phantom_wrapping(doc) -> int:
    """Preview only: an MTEXT with reference width 0 never wraps — AutoCAD draws
    it on one line however long it is. The drawing add-on disagrees: give it a
    width code (\\W) and a space and it wraps anyway, inventing lines that are
    not in the drawing. Since the attachment point is often bottom-left, those
    invented lines climb upward into the heading above and the preview shows an
    overlap that does not exist in the file.

    Setting an explicit, generous width on the rendering copy stops it. The
    document on disk is never touched.
    """
    fixed = 0
    spaces = [doc.modelspace()] + [lo for lo in doc.layouts if lo.name != "Model"] + list(doc.blocks)
    for space in spaces:
        for e in space:
            try:
                if e.dxftype() != "MTEXT" or e.dxf.width:
                    continue
                chars = max(len(e.plain_text()), 1)
                e.dxf.width = chars * float(e.dxf.char_height or 1.0) * 2.0
                fixed += 1
            except Exception:
                continue
    return fixed


def render(dxf_path: Path, png_path: Path, window: tuple[float, float, float, float] | None = None,
           width_px: int = 4000) -> tuple[float, float, float, float]:
    """Render model space (or `window` of it) to PNG. Returns the window drawn."""
    ensure_cjk_fallback()
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from ezdxf import recover
    from ezdxf.addons.drawing import RenderContext, Frontend
    from ezdxf.addons.drawing.matplotlib import MatplotlibBackend
    from ezdxf.addons.drawing.config import Configuration, ColorPolicy, BackgroundPolicy

    doc, _ = recover.readfile(str(dxf_path))
    _point_cjk_styles_at_cjk_font(doc)
    _stop_phantom_wrapping(doc)
    msp = doc.modelspace()
    cfg = Configuration(color_policy=ColorPolicy.BLACK, background_policy=BackgroundPolicy.WHITE)
    dpi = 200
    fig = plt.figure(figsize=(width_px / dpi, width_px / dpi), dpi=dpi)
    ax = fig.add_axes([0, 0, 1, 1]); ax.set_axis_off()
    Frontend(RenderContext(doc), MatplotlibBackend(ax), config=cfg).draw_layout(msp, finalize=window is None)
    if window is None:
        x0, x1 = ax.get_xlim(); y0, y1 = ax.get_ylim()
        window = (x0, y0, x1, y1)
    x0, y0, x1, y1 = window
    ar = max(y1 - y0, 1e-9) / max(x1 - x0, 1e-9)
    fig.set_size_inches(width_px / dpi, max(width_px * ar / dpi, 1))
    ax.set_xlim(x0, x1); ax.set_ylim(y0, y1); ax.set_aspect("equal", adjustable="datalim")
    ax.set_xlim(x0, x1); ax.set_ylim(y0, y1)
    png_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(str(png_path), dpi=dpi, facecolor="white")
    plt.close(fig)
    return window


def sheets(inventory_path: Path, pad: float = 0.03) -> list[tuple[float, float, float, float]]:
    """Split a model space that holds many sheets into one window per sheet.
    Text positions are clustered (single linkage); a gap wider than a few
    dozen text heights separates sheets. One cluster = the whole drawing."""
    data = json.loads(inventory_path.read_text(encoding="utf-8"))
    # If the drawing states where its sheets are, believe it. Everything below
    # is inference from where text happens to fall, which is only ever a guess.
    drawn = data.get("frames") or []
    if drawn:
        sheets.from_frames = True
        # a frame is {"box": [...], "name": "A-01"}; older jobs stored the box alone
        boxes = [(d["box"], d.get("name")) if isinstance(d, dict) else (d, None) for d in drawn]
        pad = min(max(b[2] - b[0], b[3] - b[1]) for b, _ in boxes) * 0.02
        out = [((b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad), n) for b, n in boxes]
        if all(n for _, n in out):
            # The drawing numbers its own sheets. Where a frame sits in the
            # file is only where the drafter had room, so A-02 can be parked
            # above A-01; the number is what the reader means by "first".
            def key(item):
                n = item[1]
                head, _, tail = n.partition("-")
                return (head, int(tail) if tail.isdigit() else 0)
            out.sort(key=key)
        else:
            height = max(b[3] - b[1] for b, _ in out)
            out.sort(key=lambda item: (-round(item[0][3] / max(height * 0.5, 1.0)), item[0][0]))
        sheets.labels = [n for _, n in out]
        return [b for b, _ in out]
    sheets.from_frames = False
    sheets.labels = []
    pts = [(it["x"], it["y"], it["height"]) for it in data["items"]
           if it["where"] == "model" and it["kind"] in ("TEXT", "MTEXT", "ATTRIB") and it["height"] > 0]
    if len(pts) < 2:
        return []
    hs = sorted(p[2] for p in pts)
    med = hs[len(hs) // 2]
    xs = sorted(p[0] for p in pts); ys = sorted(p[1] for p in pts)
    lo, hi = int(len(xs) * 0.02), max(int(len(xs) * 0.98) - 1, 0)
    extent = max(xs[hi] - xs[lo], ys[hi] - ys[lo], 1.0)
    gap = max(25 * med, 0.015 * extent)
    # grid-bucket single linkage
    cell = gap
    buckets: dict[tuple[int, int], list[int]] = {}
    for i, (x, y, _) in enumerate(pts):
        buckets.setdefault((int(x // cell), int(y // cell)), []).append(i)
    parent = list(range(len(pts)))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]; a = parent[a]
        return a

    for (cx, cy), members in buckets.items():
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                other = buckets.get((cx + dx, cy + dy))
                if not other:
                    continue
                for i in members:
                    for j in other:
                        if abs(pts[i][0] - pts[j][0]) <= gap and abs(pts[i][1] - pts[j][1]) <= gap:
                            parent[find(i)] = find(j)
    groups: dict[int, list[int]] = {}
    for i in range(len(pts)):
        groups.setdefault(find(i), []).append(i)
    boxes = []
    for members in groups.values():
        if len(members) < 5:
            continue
        boxes.append([min(pts[i][0] for i in members), min(pts[i][1] for i in members),
                      max(pts[i][0] for i in members), max(pts[i][1] for i in members)])
    # One sheet, not two. A single sheet's text can fall into separate clusters
    # -- a column of notes with clear space all round it is far from everything
    # else in both directions -- but the sheets of a set are laid out side by
    # side and never overlap. Boxes that do overlap are one sheet, and showing
    # the inner one as its own "sheet" only crops the drawing.
    merged = True
    while merged:
        merged = False
        for i in range(len(boxes)):
            for j in range(i + 1, len(boxes)):
                a, b = boxes[i], boxes[j]
                if a[0] <= b[2] and b[0] <= a[2] and a[1] <= b[3] and b[1] <= a[3]:
                    boxes[i] = [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])]
                    boxes.pop(j)
                    merged = True
                    break
            if merged:
                break

    # These boxes hold only the text. A sheet is mostly drawing -- a plan, its
    # grid and dimensions -- reaching well past the words on it, so a box padded
    # by a margin shows the notes and cuts the plan off. What a sheet actually
    # owns is the ground between it and the sheet next to it, so each box grows
    # until it meets its neighbour half way. Sheets laid out in a grid then tile
    # the drawing: nothing falls between two windows, and nothing is clipped.
    def gap_to_neighbour(i: int, axis: int, forward: bool) -> float | None:
        a = boxes[i]
        other = 1 - axis
        best = None
        for j, b in enumerate(boxes):
            if j == i:
                continue
            if b[other] > a[other + 2] or b[other + 2] < a[other]:
                continue           # not alongside; a different row or column
            d = (b[axis] - a[axis + 2]) if forward else (a[axis] - b[axis + 2])
            if d >= 0 and (best is None or d < best):
                best = d
        return best

    grown = []
    for i, (x0, y0, x1, y1) in enumerate(boxes):
        w, h = max(x1 - x0, 20 * med), max(y1 - y0, 20 * med)
        edges: list[float | None] = []
        # Meeting the neighbour half way is right when sheets sit close
        # together, and absurd when they do not: sheets are often parked three
        # widths apart, and half of that emptiness added to each side leaves
        # the drawing a stamp in the corner of a blank page. Take the smaller
        # of the two -- half the gap, or a margin around the sheet itself.
        for axis, forward in ((0, False), (0, True), (1, False), (1, True)):
            g = gap_to_neighbour(i, axis, forward)
            room = MARGIN * (w if axis == 0 else h)
            edges.append(None if g is None else min(g / 2, room))
        # An outer edge has no neighbour to meet, so it takes the same room as
        # the widest edge that does -- a sheet on the end of a row is not
        # smaller than its neighbours, it just has nothing beyond it.
        known = [e for e in edges if e is not None]
        fallback = max(known) if known else max(w, h) * 0.12 + 30 * med
        l, r, d, u = [fallback if e is None else e for e in edges]
        grown.append((x0 - l, y0 - d, x1 + r, y1 + u))

    out = []
    for bx0, by0, bx1, by1 in grown:
        # keep a sheet-like proportion so a wide drawing under short labels
        # is not squashed into a letterbox
        if (by1 - by0) < (bx1 - bx0) / 1.6:
            extra = (bx1 - bx0) / 1.6 - (by1 - by0)
            by0 -= extra * 0.6; by1 += extra * 0.4
        out.append((bx0, by0, bx1, by1))
    # reading order: top row first, left to right
    out.sort(key=lambda b: (-round(b[3] / (extent * 0.15)), b[0]))
    return out
