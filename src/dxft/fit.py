"""Stage 4 · Fit.

For every translated segment, work out whether it fits the room it has
(see layout.available_widths) and what it takes to make it fit: re-wrap
over the paragraph's lines, then narrow the width factor, never below the
readability floor. What still does not fit is flagged "overflow" for the
reviewer, who can shorten the text.

MTEXT wraps itself inside its box, so it only gets the growth ratio.
"""
from __future__ import annotations

from dataclasses import dataclass

from .layout import em_width, fits_like_a_line, wrap_best, WF_FLOOR
from .prepare import MARK_RE, Segment
from .translate import Translation


@dataclass
class Fit:
    id: str
    source_em: float
    target_em: float
    ratio: float
    flag: str                   # "" | "long" | "tight" | "overflow"
    suggested_width_factor: float
    lines_used: int = 1
    lines_available: int = 1
    cap_em: float = 0.0


def assess(segments: list[Segment], translations: list[Translation], target_lang: str = "en") -> list[Fit]:
    by_id = {t.id: t for t in translations}
    cjk = target_lang in ("ja", "zh")
    out: list[Fit] = []
    for s in segments:
        t = by_id.get(s.id)
        if not t:
            continue
        plain_t = MARK_RE.sub("", t.target)
        se, te = em_width(MARK_RE.sub("", s.source)), em_width(plain_t)
        ratio = te / se if se > 0 else 1.0
        # A segment is fitted when prepare found room for it. Boxed MTEXT wraps
        # itself and gets no caps, so it falls through to the growth check.
        fitted = any(c > 0 for c in s.caps)
        if not fitted:
            flag = "long" if ratio > 1.6 else ""
            out.append(Fit(s.id, round(se, 1), round(te, 1), round(ratio, 2), flag, 1.0))
            continue
        wf_min, used_max, overflow = 1.0, 1, False
        for gi, (group, cap) in enumerate(zip(s.groups, s.caps)):
            per_line = s.line_caps[gi] if gi < len(s.line_caps) and s.line_caps[gi] else cap
            per_line_max = s.line_caps_max[gi] if gi < len(s.line_caps_max) and s.line_caps_max[gi] else per_line
            lines, wf, ov = wrap_best(plain_t, per_line, per_line_max, len(group), cjk)
            wf_min = min(wf_min, wf)
            used_max = max(used_max, len(lines))
            overflow = overflow or ov
        flag = "overflow" if overflow else "tight" if wf_min < 0.85 else "long" if wf_min < 1.0 else ""
        out.append(Fit(s.id, round(se, 1), round(te, 1), round(ratio, 2), flag, wf_min,
                       lines_used=used_max, lines_available=s.lines, cap_em=round(min(s.caps), 1)))
    return out
