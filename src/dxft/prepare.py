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

import os

from .inventory import TextItem, detect_lang
from . import layout

# Fraction of the measured room actually used: viewers substitute fonts, so
# text that runs to the edge in one may cross it in another.
SAFETY = float(os.environ.get("DXFT_WIDTH_SAFETY", "0.93"))

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
    groups: list[list[str]] = field(default_factory=list)  # each instance: its handles, top line first
    caps: list[float] = field(default_factory=list)        # per instance: room per line, in ems (0 = unknown)
    line_caps: list[list[float]] = field(default_factory=list)  # per instance: room of each line (indents make them differ)
    lines: int = 1         # lines available per instance (paragraphs > 1)
    budget_chars: int = 0  # length hint for the model, 0 = no constraint known

    def to_dict(self) -> dict:
        return asdict(self)


FONT_CODEPAGE = re.compile(r"(\\[fF][^;|]*(?:\|[^;|]*)*?)\|c\d+")


def simplify_mtext(raw: str) -> str:
    """Drop formatting that says nothing: the codepage flag in font codes
    (c0 for Latin, c204 for Cyrillic; irrelevant in a Unicode DXF), and font
    codes that repeat the font already in force. Cyrillic MTEXT from Russian
    CAD typically switches font code around every Latin character, which
    would put a marker between every second letter."""
    raw = FONT_CODEPAGE.sub(r"\1|c0", raw)
    out: list[str] = []
    font_stack: list[str] = [""]
    pos = 0
    for m in MTEXT_CODE.finditer(raw):
        out.append(raw[pos:m.start()])
        code = m.group(0)
        if code == "{":
            font_stack.append(font_stack[-1]); out.append(code)
        elif code == "}":
            if len(font_stack) > 1:
                font_stack.pop()
            out.append(code)
        elif code[:2] in ("\\f", "\\F"):
            if code != font_stack[-1]:
                font_stack[-1] = code; out.append(code)
        else:
            out.append(code)
        pos = m.end()
    out.append(raw[pos:])
    return "".join(out)


# Russian standards and drawing-set codes written in Latin in English editions.
# Applied at write time, whole words only, so a model that kept them in
# Cyrillic still yields "SP 60.13330.2012". Grid axes and marks are untouched.
TRANSLIT = [(re.compile(rf"(?<![А-Яа-яЁё\w]){k}(?![А-Яа-яЁё])"), v) for k, v in [
    ("ГОСТ Р", "GOST R"), ("ГОСТ", "GOST"), ("СНиП", "SNiP"), ("СанПиН", "SanPiN"), ("СП", "SP"), ("ТУ", "TU"),
    ("ПУЭ", "PUE"), ("ППБ", "PPB"), ("НПБ", "NPB"), ("РД", "RD"), ("АР", "AR"), ("ОВ", "OV"), ("ВК", "VK"), ("ЭОМ", "EOM"),
    ("ЭО", "EO"), ("ЭМ", "EM"), ("ИОС", "IOS"), ("ПОС", "POS"), ("КЖ", "KZh"), ("КМ", "KM"), ("ГП", "GP"), ("ТХ", "TKh"),
    ("СС", "SS"), ("ПЗ", "PZ"), ("ПБ", "PB"), ("ИТП", "ITP"), ("ГКЛ", "GKL"), ("ПВХ", "PVC"),
]]


def latinize(text: str) -> str:
    """For Latin-script output: full-width punctuation and letters become
    their ASCII forms (NFKC), Japanese bullets become "- ". Fonts like Arial
    have no glyph for ・ or ＡＢＣ; AutoCAD would draw boxes."""
    import unicodedata
    out = []
    for line in text.split("\n"):
        line = unicodedata.normalize("NFKC", line).replace("・", "·").replace("･", "·")
        line = re.sub(r"^(\s*)[·•]\s*", r"\1- ", line)
        line = line.replace("〜", "–").replace("～", "–")
        for rx, rep in TRANSLIT:
            line = rx.sub(rep, line)
        out.append(line)
    return "\n".join(out)


def mark_codes(raw: str) -> tuple[str, list[str]]:
    """Replace MTEXT format codes with ⟦n⟧ markers. Returns (marked, codes)."""
    codes: list[str] = []

    def repl(m: re.Match) -> str:
        codes.append(m.group(0))
        return MARK.format(len(codes))

    return MTEXT_CODE.sub(repl, simplify_mtext(raw)), codes


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


# Grid axes and legend keys on Russian drawings: a Cyrillic letter or two,
# optionally numbered (А, Б, Л1, Ст2). References, never words.
CYR_CODE = re.compile(r"^\s*(?:[А-ЯЁ]|[А-ЯЁ]{1,2}\d{1,3})\s*$")   # one letter, or letters+digits; "СП"/"АР" alone are words to transliterate
# Window/door/opening marks that refer to schedules: ОК-9.1, Д-9л, Ш-7, ОК-2*, ПР-1
CYR_MARK = re.compile(r"^\s*[А-ЯЁ]{1,3}-?\d+(?:[.,]\d+)*[а-яё*]?\s*$")


def is_translatable(item: TextItem, source_langs: set[str]) -> bool:
    if not item.plain.strip():
        return False
    if CYR_CODE.match(item.plain) or CYR_MARK.match(item.plain):
        return False
    if item.kind == "DIMENSION":
        return item.lang in source_langs  # numeric overrides are 'none'
    if PROTECTED.match(item.plain):
        return False
    return item.lang in source_langs


def prepare(items: list[TextItem], source_langs: set[str], walls: dict[str, list[list[float]]] | None = None
            ) -> tuple[list[Segment], dict[str, str], list[str]]:
    """Returns (segments, handle->segment id, skipped handles).

    Stacked single-line TEXT entities that read as one paragraph become one
    segment (see layout.paragraphs); the translation is re-wrapped over the
    same lines at patch time. Every segment carries how much room it has.
    """
    by_source: dict[str, Segment] = {}
    handle_map: dict[str, str] = {}
    skipped: list[str] = []
    translatable = {it.handle for it in items if is_translatable(it, source_langs)}
    skipped = [it.handle for it in items if it.handle not in translatable]
    avail = layout.available_widths(items, walls or {})
    item_by_handle = {it.handle: it for it in items}

    # Paragraph groups cover the flat TEXT items; everything else is its own group.
    paras = layout.paragraphs(items, translatable)
    grouped = {h for p in paras for h in p.handles}
    units: list[tuple[list[TextItem], str, list[str]]] = []  # (items, marked source, codes)
    for it in items:
        if it.handle not in translatable or it.handle in grouped:
            continue
        if it.kind in ("MTEXT", "MLEADER", "TABLE_CELL"):
            marked, codes = mark_codes(it.raw)
        else:
            marked, codes = it.raw, []
        units.append(([it], marked, codes))
    for p in paras:
        if len(p.items) == 1:
            units.append((p.items, p.items[0].raw, []))
        else:
            units.append((p.items, layout.join_lines([t.plain for t in p.items], p.items[0].lang), []))
    # keep drawing order stable so ids are reproducible
    order = {it.handle: i for i, it in enumerate(items)}
    units.sort(key=lambda u: order[u[0][0].handle])

    for group, marked, codes in units:
        first = group[0]
        seg = by_source.get(marked)
        if seg is None:
            seg = Segment(
                id=f"s{len(by_source) + 1:05d}", source=marked,
                plain=layout.join_lines([t.plain for t in group], first.lang) if len(group) > 1 else first.plain,
                lang=first.lang, codes=codes, context=first.layer, max_height=first.height, vertical=first.vertical,
            )
            by_source[marked] = seg
        seg.groups.append([t.handle for t in group])
        cap, per_line = _cap_em(group, avail)
        seg.caps.append(cap)
        seg.line_caps.append(per_line)
        seg.lines = max(seg.lines, len(group))
        for t in group:
            seg.handles.append(t.handle)
            seg.kinds.append(t.kind)
            seg.max_height = max(seg.max_height, t.height)
            seg.vertical = seg.vertical or t.vertical
            if t.layer and t.layer not in seg.context:
                seg.context = f"{seg.context}, {t.layer}" if seg.context else t.layer
            handle_map[t.handle] = seg.id

    for seg in by_source.values():
        known = [c for c in seg.caps if c > 0]
        if known:
            # ems -> characters at ~0.6 em each, plus the 10% that narrowing can absorb
            seg.budget_chars = int(min(known) * seg.lines / 0.6 * 1.1)
    return list(by_source.values()), handle_map, skipped


def _cap_em(group: list[TextItem], avail: dict[str, float]) -> tuple[float, list[float]]:
    """Room for one instance, in ems of its own height: (one figure for the
    group, one per line). 0 = unknown. For a paragraph the right edge is
    shared: the longest line's end, or the nearest neighbour found on any
    line; each line's room runs from its own start to that edge."""
    first = group[0]
    if first.kind not in ("TEXT", "ATTRIB", "PDF") or first.height <= 0:
        return 0.0, []
    scale = first.height * (first.width_factor or 1.0)
    line_ems = [layout.em_width(t.plain) for t in group]
    if len(group) == 1:
        if first.handle in avail:
            cap = round(max(avail[first.handle] * SAFETY / scale, line_ems[0]), 2)
        else:
            cap = round(line_ems[0] * (2.4 if first.lang in ("ja", "zh") else 1.4), 2)
        return cap, [cap]
    right = max(t.x + layout.rendered_width(t) for t in group)
    known = [t.x + avail[t.handle] * SAFETY for t in group if t.handle in avail]
    if known:
        right = max(right, min(known))
    else:
        right += (right - min(t.x for t in group)) * 0.2   # nothing found nearby: a little growth
    per_line = [round(max((right - t.x) / scale, e), 2) for t, e in zip(group, line_ems)]
    return round(max(per_line), 2), per_line
