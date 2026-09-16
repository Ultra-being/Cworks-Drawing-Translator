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


def render(dxf_path: Path, png_path: Path, window: tuple[float, float, float, float] | None = None,
           width_px: int = 4000) -> tuple[float, float, float, float]:
    """Render model space (or `window` of it) to PNG. Returns the window drawn."""
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
