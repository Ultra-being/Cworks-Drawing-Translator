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
    out = []
    for members in groups.values():
        if len(members) < 5:
            continue
        x0 = min(pts[i][0] for i in members); x1 = max(pts[i][0] for i in members)
        y0 = min(pts[i][1] for i in members); y1 = max(pts[i][1] for i in members)
        w, h = max(x1 - x0, 20 * med), max(y1 - y0, 20 * med)
        # text sits inside the drawing, not around it: pad well, and keep a
        # sheet-like proportion so tall drawings under short labels are kept
        px, py = w * 0.12 + 30 * med, h * 0.12 + 30 * med
        bx0, by0, bx1, by1 = x0 - px, y0 - py, x1 + px, y1 + py
        if (by1 - by0) < (bx1 - bx0) / 1.6:
            extra = (bx1 - bx0) / 1.6 - (by1 - by0)
            by0 -= extra * 0.6; by1 += extra * 0.4
        out.append((bx0, by0, bx1, by1))
    # reading order: top row first, left to right
    out.sort(key=lambda b: (-round(b[3] / (extent * 0.15)), b[0]))
    return out
