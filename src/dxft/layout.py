"""Stage 2a · Layout: how much room does each string have, and which
stacked TEXT lines are really one paragraph.

Drafters write notes as a stack of single-line TEXT entities, one per line,
and a translation must be done on the paragraph, not the line. And every
string lives in a fixed space: a table cell, a column next to another
column, a label between two grid lines. Both facts come from geometry, and
both are computed here, once, before anything is sent to the model.

Available width for a TEXT/ATTRIB entity = distance from its start to the
nearest thing on its right on the same row: another text entity, or a
vertical line (table border, cell wall). Centred and right-aligned text
are measured from their alignment point in both directions.
"""
from __future__ import annotations

import re
import unicodedata
from bisect import bisect_left
from dataclasses import dataclass
from pathlib import Path

from .inventory import TextItem

# Line-ending and line-starting cues for paragraph detection.
JA_TERMINATOR = re.compile(r"[。．.!！?？:：;；」』）)]\s*$")
RU_TERMINATOR = re.compile(r"[.!?:;]\s*$")
BULLET_START = re.compile(r"^\s*([・･\-–—■□●○※◆▪*•●◇]|\(?\d+[)）.．:]|[①-⑳]|[（(]\d+[)）]|[a-zA-Z][.)）])")
HEADING_START = re.compile(r"^\s*[■□●○◆◇▪]")     # a heading line is never continued
TABLE_ROW = re.compile(r"\S\s{3,}\S|\S\u3000{2,}\S")  # label   value: a table row, never part of a paragraph


class Measurer:
    """Exact advance widths from a TrueType file, in units of the font's cap
    height (a DXF text height is a cap height). What the drawing will show
    when the same font is used."""

    def __init__(self, source, name: str = ""):
        import io
        from fontTools.ttLib import TTFont
        tt = TTFont(io.BytesIO(source) if isinstance(source, (bytes, bytearray)) else str(source))
        self.name = name or str(source)
        upem = tt["head"].unitsPerEm
        cap = getattr(tt["OS/2"], "sCapHeight", 0) or int(upem * 0.716)
        self.cap = cap
        cmap = tt.getBestCmap() or {}
        hmtx = tt["hmtx"].metrics
        self.w = {}
        for u, g in cmap.items():
            adv = hmtx.get(g, (0, 0))[0]
            self.w[u] = adv / cap
        self.default = self.w.get(ord("n"), 0.75)
        self.space = self.w.get(32, 0.35)

    def width(self, s: str) -> float:
        return sum(self.w.get(ord(c), self.default) for c in s)


_MEASURER: Measurer | None = None
_BUNDLED = Path(__file__).resolve().parent / "fonts" / "LiberationSans-Regular.ttf"


def set_measure_font(source=None, name: str = "") -> None:
    """Choose the font widths are computed with. Default: Liberation Sans,
    metric-compatible with Arial, the font English output is set to."""
    global _MEASURER
    _MEASURER = Measurer(source or _BUNDLED, name or ("LiberationSans" if source is None else name))


def _measurer() -> Measurer:
    global _MEASURER
    if _MEASURER is None:
        set_measure_font()
    return _MEASURER


def _is_wide(ch: str) -> bool:
    return unicodedata.east_asian_width(ch) in ("W", "F")


def em_width(s: str) -> float:
    """Rendered width in ems (multiples of text height). CJK and full-width
    characters count 1.0 em, as AutoCAD draws them with a bigfont; every
    other character is measured with the chosen font's real metrics."""
    m = _measurer()
    w = 0.0
    for ch in s:
        if ch == "\n":
            continue
        w += 1.0 if _is_wide(ch) else m.w.get(ord(ch), m.default)
    return w


def rendered_width(it: TextItem) -> float:
    return em_width(it.plain) * it.height * (it.width_factor or 1.0)


def _same_row(a: TextItem, b: TextItem) -> bool:
    return abs(a.y - b.y) < 0.7 * max(a.height, b.height, 1e-9)


def _flat(it: TextItem) -> bool:
    r = it.rotation % 360.0
    return (r < 1.0 or r > 359.0) and not it.vertical and it.kind in ("TEXT", "ATTRIB", "PDF") and it.height > 0


def available_widths(items: list[TextItem], walls: dict[str, list[list[float]]]) -> dict[str, float]:
    """handle -> width in drawing units that the text may occupy, for every
    flat TEXT/ATTRIB item whose right-hand neighbour or cell wall is found.
    Missing handle = nothing found nearby = unconstrained (caller decides)."""
    out: dict[str, float] = {}
    by_where: dict[str, list[TextItem]] = {}
    for it in items:
        if it.height > 0 and it.kind in ("TEXT", "ATTRIB", "MTEXT", "PDF"):
            by_where.setdefault(it.where, []).append(it)

    for where, group in by_where.items():
        group.sort(key=lambda t: t.y)
        ys = [t.y for t in group]
        ws = walls.get(where, [])
        wx = [w[0] for w in ws]

        for it in group:
            if not _flat(it):
                continue
            h = it.height
            src_w = max(rendered_width(it), h)
            reach = src_w * 4 + 2 * h
            left_edge = it.x
            if it.halign in (1, 4):
                left_edge = it.ax - src_w / 2
            elif it.halign == 2:
                left_edge = it.ax - src_w
            right_edge = left_edge + src_w

            # Nearest text on the same row to the right (and to the left, for centred/right text).
            gap_r = gap_l = None
            lo = bisect_left(ys, it.y - 3 * h)
            for j in range(lo, len(group)):
                o = group[j]
                if o.y > it.y + 3 * h:
                    break
                if o is it or not _same_row(it, o) or (o.rotation % 360.0) > 1.0 and (o.rotation % 360.0) < 359.0:
                    continue
                o_w = max(rendered_width(o), o.height)
                o_left = o.x
                if o.halign in (1, 4):
                    o_left = o.ax - o_w / 2
                elif o.halign == 2:
                    o_left = o.ax - o_w
                o_right = o_left + o_w
                if o_left >= left_edge + 0.5 * h and o_left - left_edge <= reach:
                    d = o_left - left_edge
                    gap_r = d if gap_r is None else min(gap_r, d)
                if o_right <= right_edge - 0.5 * h and right_edge - o_right <= reach:
                    d = right_edge - o_right
                    gap_l = d if gap_l is None else min(gap_l, d)

            # Nearest vertical wall crossing this row. Only meaningful when the
            # text sits inside a cell: on a plan, labels cross lines all the time,
            # and then lines say nothing about the room the label has.
            base, top = it.y - 0.2 * h, it.y + 1.2 * h
            crosses = False
            k = bisect_left(wx, left_edge + 0.3 * h)
            while k < len(ws) and ws[k][0] < right_edge - 0.3 * h:
                if ws[k][1] <= top and ws[k][2] >= base:
                    crosses = True
                    break
                k += 1
            k = bisect_left(wx, right_edge - 0.3 * h) if not crosses else len(ws)
            while k < len(ws) and ws[k][0] - left_edge <= reach:
                x, y0, y1 = ws[k]
                if y0 <= top and y1 >= base:
                    d = x - left_edge
                    gap_r = d if gap_r is None else min(gap_r, d)
                    break
                k += 1
            k = bisect_left(wx, left_edge + 0.3 * h) - 1 if not crosses else -1
            while k >= 0 and right_edge - ws[k][0] <= reach:
                x, y0, y1 = ws[k]
                if y0 <= top and y1 >= base:
                    d = right_edge - x
                    gap_l = d if gap_l is None else min(gap_l, d)
                    break
                k -= 1

            margin = 0.3 * h
            if it.halign in (1, 4):
                if gap_r is None and gap_l is None:
                    continue
                # centred: growth is symmetric; the tighter side limits it.
                half = min(g for g in (gap_r, gap_l) if g is not None)
                avail = src_w + 2 * (half - margin) if (gap_r is not None and gap_l is not None) else src_w + 2 * (half - margin)
            elif it.halign == 2:
                if gap_l is None:
                    continue
                avail = src_w + (gap_l - margin)
            else:
                if gap_r is None:
                    continue
                avail = gap_r - margin
            out[it.handle] = max(avail, src_w)  # the original fits by definition
    return out


@dataclass
class Paragraph:
    handles: list[str]      # top to bottom
    items: list[TextItem]


def _continues(prev: str, cur: str, lang: str) -> bool:
    if BULLET_START.match(cur) or HEADING_START.match(prev):
        return False
    if TABLE_ROW.search(prev) or TABLE_ROW.search(cur):
        return False
    if lang == "ja":
        return not JA_TERMINATOR.search(prev)
    # Russian / Latin: a wrapped line usually starts lowercase, or the previous line ends mid-clause.
    if RU_TERMINATOR.search(prev):
        return False
    c = cur.lstrip()[:1]
    return c.islower() or prev.rstrip().endswith((",", "-", "‑", "–"))


def _ends_paragraph(line: str, lang: str) -> bool:
    return bool((JA_TERMINATOR if lang == "ja" else RU_TERMINATOR).search(line))


def paragraphs(items: list[TextItem], candidates: set[str]) -> list[Paragraph]:
    """Group stacked single-line TEXT entities that read as one paragraph.

    Lines join when they are in the same space/layer/style/height, left-aligned
    at the same x, spaced like consecutive lines, and the text says the previous
    line did not finish (no terminator; next line is not a bullet). A Japanese
    group is only accepted when its last line does terminate — a title block
    of unrelated lines never ends with 。 and stays as separate lines.
    """
    cand = [it for it in items if it.handle in candidates and _flat(it) and it.kind in ("TEXT", "PDF") and it.halign == 0]
    keyed: dict[tuple, list[TextItem]] = {}
    for it in cand:
        keyed.setdefault((it.where, it.layer, it.style, round(it.height, 3)), []).append(it)

    out: list[Paragraph] = []
    for key, group in keyed.items():
        h = key[3]
        group.sort(key=lambda t: (round(t.x / (0.5 * h)), -t.y))
        # columns: consecutive items whose x agrees within 0.5 h
        col: list[TextItem] = []
        cols: list[list[TextItem]] = []
        for it in group:
            if col and abs(it.x - col[0].x) > 0.5 * h:
                cols.append(col); col = []
            col.append(it)
        if col:
            cols.append(col)
        for col in cols:
            col.sort(key=lambda t: -t.y)
            run: list[TextItem] = [col[0]]
            for it in col[1:]:
                prev = run[-1]
                dy = prev.y - it.y
                if 0.8 * h <= dy <= 2.6 * h and _continues(prev.plain, it.plain, it.lang):
                    run.append(it)
                else:
                    out.extend(_close(run)); run = [it]
            out.extend(_close(run))
    return out


def _close(run: list[TextItem]) -> list[Paragraph]:
    if len(run) == 1:
        return [Paragraph([run[0].handle], run)]
    lang = run[0].lang
    if lang == "ja" and not _ends_paragraph(run[-1].plain, lang):
        return [Paragraph([t.handle], [t]) for t in run]
    return [Paragraph([t.handle for t in run], run)]


def join_lines(lines: list[str], lang: str) -> str:
    if lang in ("ja", "zh"):
        return "".join(l.strip() for l in lines)
    return " ".join(l.strip() for l in lines)


# ───────────────────────── wrapping the translation back ─────────────────────────

WF_FLOOR = 0.6   # narrowest width factor still readable on a plot


def _greedy(text: str, cap_em: float | list[float], cjk: bool) -> list[str]:
    """Greedy wrap. `cap_em` is one width for every line, or a list of widths,
    one per line (an indented first line is narrower); past the end of the
    list the last width repeats."""
    caps = cap_em if isinstance(cap_em, list) else [cap_em]
    if not caps:
        caps = [1e9]
    cap_of = lambda i: caps[min(i, len(caps) - 1)]
    lines: list[str] = []
    for para in text.split("\n"):
        if cjk:
            cur = ""
            for ch in para:
                if cur and em_width(cur + ch) > cap_of(len(lines)):
                    lines.append(cur); cur = ch
                else:
                    cur += ch
            lines.append(cur)
        else:
            cur = ""
            for w in para.split(" "):
                cand = w if not cur else cur + " " + w
                if cur and em_width(cand) > cap_of(len(lines)):
                    lines.append(cur); cur = w
                else:
                    cur = cand
            lines.append(cur)
    return [l for l in lines if l != ""] or [""]


def wrap_to(text: str, cap_em: float | list[float], max_lines: int, cjk: bool) -> tuple[list[str], float, bool]:
    """Fit text into max_lines of cap_em ems (one width, or one per line).
    Tries width factors 1.0 → WF_FLOOR. Returns (lines, width_factor,
    overflow). On overflow the surplus is folded into the last line so
    nothing is lost; the reviewer is told."""
    caps = cap_em if isinstance(cap_em, list) else [cap_em]
    if not caps or max(caps) <= 0:
        return _greedy(text, 1e9, cjk)[:max_lines], 1.0, False
    wf = 1.0
    while True:
        lines = _greedy(text, [c / wf for c in caps], cjk)
        if len(lines) <= max_lines:
            return lines, round(wf, 2), False
        if wf - 0.05 < WF_FLOOR - 1e-9:
            break
        wf = round(wf - 0.05, 2)
    lines = _greedy(text, [c / wf for c in caps], cjk)
    head, tail = lines[:max_lines - 1], lines[max_lines - 1:]
    joiner = "" if cjk else " "
    return head + [joiner.join(tail)], wf, True
