"""Stage 4 · Fit.

Estimate how wide each translated string will render compared with the
original and flag the ones that grew. The estimate is a character-width
model, not a font metric: CJK and full-width characters count as 1.0 em,
Latin/Cyrillic as ~0.55 em on average. It is good enough to rank risk and
to suggest a width factor; the reviewer sees the flagged ones.
"""
from __future__ import annotations

import unicodedata
from dataclasses import dataclass

from .prepare import MARK_RE, Segment
from .translate import Translation


def em_width(s: str) -> float:
    w = 0.0
    for ch in MARK_RE.sub("", s):
        if ch in ("\n",):
            continue
        ea = unicodedata.east_asian_width(ch)
        if ea in ("W", "F"):
            w += 1.0
        elif ch == " ":
            w += 0.3
        elif ch.isupper():
            w += 0.65
        else:
            w += 0.52
    return w


@dataclass
class Fit:
    id: str
    source_em: float
    target_em: float
    ratio: float
    flag: str  # "" | "long" | "very_long"
    suggested_width_factor: float


def assess(segments: list[Segment], translations: list[Translation]) -> list[Fit]:
    by_id = {t.id: t for t in translations}
    out: list[Fit] = []
    for s in segments:
        t = by_id.get(s.id)
        if not t:
            continue
        se, te = em_width(s.source), em_width(t.target)
        ratio = te / se if se > 0 else 1.0
        flag = "very_long" if ratio > 1.6 else "long" if ratio > 1.25 else ""
        # Suggest shrinking horizontally, never below 0.7 (readability floor).
        wf = round(max(0.7, min(1.0, 1.0 / ratio)), 2) if ratio > 1.05 else 1.0
        out.append(Fit(s.id, round(se, 1), round(te, 1), round(ratio, 2), flag, wf))
    return out
