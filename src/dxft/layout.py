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


def fits_like_a_line(it: TextItem) -> bool:
    """True when the string occupies one line that grows to the right.

    MTEXT usually wraps inside its own box, so it grows downward and needs no
    width measuring. But drafters routinely place MTEXT with no box at all
    (width 0), and then it behaves exactly like a TEXT entity: one line, no
    wrapping, straight into whatever is beside it.

    A box holding a single line is drawn as one line too. Its box width is
    only a promise to wrap somewhere far to the right, and a drafter who
    copied one MTEXT across a row of narrow cells leaves that promise set to
    the width of the whole row. The source language is short enough not to
    reach it; a longer translation wraps at the box and crosses the cell wall
    on the way. So the single-line ones are measured as well, and the box is
    held to the room actually there (see prepare._box_clamp).
    """
    if it.kind in ("TEXT", "ATTRIB", "PDF"):
        return True
    if it.kind != "MTEXT":
        return False
    return not it.box_width or "\n" not in (it.plain or "")


def _flat(it: TextItem) -> bool:
    r = it.rotation % 360.0
    return (r < 1.0 or r > 359.0) and not it.vertical and fits_like_a_line(it) and it.height > 0


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
            # How far to look for whatever limits this string. It must not be
            # scaled to the source: a four-character Japanese label whose body
            # column sits sixty character-heights to the right would never see
            # it, conclude the space was open, and grow the English through it.
            reach = max(src_w * 6, 60 * h)
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


MTEXT_RICH = re.compile(r"\\(?![Ww])[A-Za-z~]")   # any MTEXT code other than the width factor \W
INDENT = 2.5     # how far right of a paragraph's first line a continuation may start, in text heights
FULL_LINE = 0.5  # how much of its column a line must fill to count as having run out of room


def _line_candidate(it: TextItem) -> bool:
    r"""A line that may be folded into a paragraph: flat, left-aligned, one
    line long. Unboxed MTEXT counts — it is drawn on a single line exactly
    like TEXT — unless it carries formatting beyond the width factor \W,
    which re-wrapping the paragraph would have to throw away."""
    if not _flat(it) or it.halign != 0:
        return False
    if it.kind == "MTEXT":
        return not it.box_width and not MTEXT_RICH.search(it.raw)
    return it.kind in ("TEXT", "PDF")


def room_below(items: list[TextItem], floors: dict[str, list[list[float]]]) -> dict[str, float]:
    """Clear space under each line of text, in drawing units: down to whatever
    it would run into -- the next line of text in its own column, or the rule
    beneath it. A table cell is usually taller than the one line in it, and
    that spare height is where a translation too wide for the cell can go.
    """
    out: dict[str, float] = {}
    by_space: dict[str, list[TextItem]] = {}
    for it in items:
        by_space.setdefault(it.where, []).append(it)
    for where, group in by_space.items():
        rules = sorted(floors.get(where, []), key=lambda r: r[0])
        for it in group:
            if not _flat(it) or it.height <= 0:
                continue
            x0, x1 = it.x, it.x + rendered_width(it)
            if x1 <= x0:
                continue
            best = 1e18
            for other in group:
                if other.handle == it.handle or other.y >= it.y - 1e-9:
                    continue
                if other.x >= x1 or other.x + rendered_width(other) <= x0:
                    continue
                best = min(best, it.y - (other.y + other.height))
            for ry, rx0, rx1 in rules:
                if ry >= it.y - 1e-9:
                    continue
                if rx1 <= x0 or rx0 >= x1:
                    continue
                best = min(best, it.y - ry)
            if best < 1e17:
                out[it.handle] = max(best, 0.0)
    return out


def spare_lines(it: TextItem, clear: float, most: int = 2) -> int:
    """How many further lines of this text would fit in that clear space.
    A line needs its own height and the space between lines, and a little
    left over so it does not sit against the rule below it."""
    if it.height <= 0 or clear <= 0:
        return 0
    pitch = it.height * 1.45
    return max(0, min(most, int((clear - it.height * 0.35) // pitch)))


def paragraphs(items: list[TextItem], candidates: set[str]) -> list[Paragraph]:
    """Group stacked single-line entities that read as one paragraph.

    Lines join when they are in the same space/layer/style at much the same
    height, spaced like consecutive lines, starting at the first line's left
    edge or hanging-indented from it, filling their column so the break was
    forced rather than chosen, and reading as unfinished (no terminator; the
    next line is not a bullet). A Japanese group is only accepted when its
    last line does terminate — a title block of unrelated lines never ends
    with 。 and stays as separate lines.
    """
    cand = [it for it in items if it.handle in candidates and _line_candidate(it)]
    keyed: dict[tuple, list[TextItem]] = {}
    for it in cand:
        keyed.setdefault((it.where, it.layer, it.style), []).append(it)

    out: list[Paragraph] = []
    for key, group in keyed.items():
        # One typical height for the block, to judge line spacing and indents
        # by. Lines only join a paragraph whose height they nearly share, so a
        # heading among the notes is never folded into one.
        heights = sorted(t.height for t in group)
        h = heights[len(heights) // 2]
        group.sort(key=lambda t: (t.x, -t.y))
        # columns: a wrapped line that the drafter indented is still the same
        # column of text; the next column of the sheet is much further right.
        col: list[TextItem] = []
        cols: list[list[TextItem]] = []
        for it in group:
            if col and it.x - col[0].x > INDENT * h:
                cols.append(col); col = []
            col.append(it)
        if col:
            cols.append(col)
        for col in cols:
            col.sort(key=lambda t: -t.y)
            # A line only has a continuation if it ran out of room. The lines
            # of a title block are short because the drafter ended them there,
            # so a line that stops well before the column's edge ends its
            # paragraph whatever the words do.
            left = min(t.x for t in col)
            width = max(t.x + rendered_width(t) for t in col) - left
            run: list[TextItem] = [col[0]]
            for it in col[1:]:
                prev = run[-1]
                dy = prev.y - it.y
                indent = it.x - run[0].x
                same_size = abs(it.height - run[0].height) <= 0.1 * run[0].height
                full = width <= 0 or (prev.x + rendered_width(prev) - left) >= FULL_LINE * width
                if (0.8 * h <= dy <= 2.6 * h and -0.5 * h <= indent <= INDENT * h
                        and same_size and full and _continues(prev.plain, it.plain, it.lang)):
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


def _caps_list(cap, n: int) -> list[float]:
    return list(cap) if isinstance(cap, list) else [cap] * n


def wrap_best(text: str, per_line, per_line_max, max_lines: int, cjk: bool, spare: int = 0) -> tuple[list[str], float, bool]:
    """Wrap inside the column the writer laid out; reach into the free space
    beside it only to save words that would otherwise fall off the end.

    Narrowing to stay in the column is not a reason to leave it — that is what
    the column is for, and text too tight to read is dealt with by asking for
    shorter wording. Only losing words is worse than growing. When the column
    really cannot hold the sentence, take just as much of the space beside it
    as the sentence needs, spread over the lines the paragraph already has, so
    no line of it is left empty.
    """
    lines, wf, over = wrap_to(text, per_line, max_lines, cjk)
    if (not over and wf >= 0.999) or spare <= 0:
        pass
    else:
        # The line will not go in as it stands, and there is clear space under
        # it. Taking another line there reads better than squeezing the letters
        # or cutting words off, and is how the drafter set the cell next door.
        wider = wrap_to(text, per_line, max_lines + spare, cjk)
        if (wider[2], -wider[1]) < (over, -wf):
            lines, wf, over = wider
    if not over or not per_line_max or per_line_max == per_line:
        return lines, wf, over
    need = em_width(text) / max(max_lines, 1) * 1.05
    widened = [min(m, max(c, need)) for c, m
               in zip(_caps_list(per_line, max_lines), _caps_list(per_line_max, max_lines))]
    alt_lines, alt_wf, alt_over = wrap_to(text, widened, max_lines, cjk)
    if (alt_over, -alt_wf) < (over, -wf):
        return alt_lines, alt_wf, alt_over
    return lines, wf, over


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
