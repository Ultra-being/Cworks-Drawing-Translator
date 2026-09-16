"""Stage 2 · Prepare.

Turn inventory items into translation segments:

* decide what is translatable (source-language text) and what is protected
  (numbers, codes, dimensions, field codes, empty strings);
* replace MTEXT formatting codes with numbered markers ⟦n⟧ so they survive
  translation and can be restored;
* de-duplicate: identical source strings become one segment, so a label
  that appears 300 times is translated once and stays consistent.

Output: segments (unique source strings with markers) plus a map from every
entity handle to its segment id.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, asdict, field

from .inventory import TextItem, detect_lang

# MTEXT inline codes: \P (newline), \~ (nbsp), \\ , \{ \} , {...} groups,
# and \X...; commands (font \f, height \H, colour \C, width \W, alignment
# \A, tracking \T, oblique \Q, stacking \S, underline \L, overline \O ...).
MTEXT_CODE = re.compile(
    r"("
    r"\\[fF][^;]*;"            # font change, ends with ;
    r"|\\[HWCTQApX][^;]*;"     # height, width, colour, tracking, oblique, alignment, paragraph, ... end with ;
    r"|\\S[^;]*;"              # stacked fraction
    r"|\\[LlOoKk]"             # underline / overline / strike toggles: exactly two characters
    r"|\\P|\\~|\\\\|\\\{|\\\}"  # newline, nbsp, escaped backslash and braces
    r"|\{|\}"                  # group braces
    r")"
)
MARK = "⟦{}⟧"  # ⟦n⟧
MARK_RE = re.compile(r"⟦(\d+)⟧")

# Strings that must never be translated: pure numbers/units/codes, DXF field
# codes, %% special codes on their own.
PROTECTED = re.compile(
    r"^\s*([-+±%.,:/\d\s×xX*#°'\"()\[\]φΦ@=<>~_]|%%[cCdDpPuUoO]|mm|cm|m|kg|kN|MPa|Hz|V|A|W|kW|kVA|Ø|DN|PN|№)+\s*$"
)


@dataclass
class Segment:
    id: str
    source: str            # text with ⟦n⟧ markers in place of format codes
    plain: str             # text without markers (for the reviewer)
    lang: str
    codes: list[str]       # the format codes, in marker order
    handles: list[str] = field(default_factory=list)
    kinds: list[str] = field(default_factory=list)
    context: str = ""      # layer names etc., a hint for the translator
    max_height: float = 0.0
    vertical: bool = False

    def to_dict(self) -> dict:
        return asdict(self)


def mark_codes(raw: str) -> tuple[str, list[str]]:
    """Replace MTEXT format codes with ⟦n⟧ markers. Returns (marked, codes)."""
    codes: list[str] = []

    def repl(m: re.Match) -> str:
        codes.append(m.group(0))
        return MARK.format(len(codes))

    return MTEXT_CODE.sub(repl, raw), codes


def unmark_codes(marked: str, codes: list[str]) -> str:
    """Put the format codes back. Markers the model dropped are appended at
    the start in order so formatting is never silently lost."""
    seen: set[int] = set()

    def repl(m: re.Match) -> str:
        n = int(m.group(1))
        if 1 <= n <= len(codes) and n not in seen:
            seen.add(n)
            return codes[n - 1]
        return ""

    out = MARK_RE.sub(repl, marked)
    missing = [codes[i] for i in range(len(codes)) if (i + 1) not in seen]
    if missing:
        # Keep braces balanced: put dropped opening groups first, closers last.
        openers = [c for c in missing if c != "}"]
        closers = [c for c in missing if c == "}"]
        out = "".join(openers) + out + "".join(closers)
    return out


def is_translatable(item: TextItem, source_langs: set[str]) -> bool:
    if not item.plain.strip():
        return False
    if item.kind == "DIMENSION":
        return item.lang in source_langs  # numeric overrides are 'none'
    if PROTECTED.match(item.plain):
        return False
    return item.lang in source_langs


def prepare(items: list[TextItem], source_langs: set[str]) -> tuple[list[Segment], dict[str, str], list[str]]:
    """Returns (segments, handle->segment id, skipped handles)."""
    by_source: dict[str, Segment] = {}
    handle_map: dict[str, str] = {}
    skipped: list[str] = []
    for it in items:
        if not is_translatable(it, source_langs):
            skipped.append(it.handle)
            continue
        if it.kind in ("MTEXT", "MLEADER"):
            marked, codes = mark_codes(it.raw)
        else:
            marked, codes = it.raw, []
        key = marked
        seg = by_source.get(key)
        if seg is None:
            seg = Segment(
                id=f"s{len(by_source) + 1:05d}", source=marked, plain=it.plain, lang=it.lang, codes=codes,
                context=it.layer, max_height=it.height, vertical=it.vertical,
            )
            by_source[key] = seg
        seg.handles.append(it.handle)
        seg.kinds.append(it.kind)
        seg.max_height = max(seg.max_height, it.height)
        seg.vertical = seg.vertical or it.vertical
        if it.layer and it.layer not in seg.context:
            seg.context = f"{seg.context}, {it.layer}" if seg.context else it.layer
        handle_map[it.handle] = seg.id
    return list(by_source.values()), handle_map, skipped
