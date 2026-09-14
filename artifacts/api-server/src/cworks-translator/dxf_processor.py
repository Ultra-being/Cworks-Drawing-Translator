#!/usr/bin/env python3
"""Deliberately small, byte preserving processor for textual UTF-8 DXF files.

This module does not try to be a CAD reader.  Its narrow purpose is to expose
and safely edit MTEXT records without reserialising a drawing.
"""
from __future__ import annotations

import hashlib
import html
import io
import json
import math
import re
import unicodedata
import sys
import gc
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from dxf_table_cells import table_cell_source_spans
import os


class DxfRejected(ValueError):
    """Input is not a safe textual DXF for surgical MTEXT edits."""


RISKY = {"ACDBPROXYENTITY", "ACDBPROXYOBJECT", "ACAD_PROXY_ENTITY",
         "ACAD_PROXY_OBJECT", "PROXYENTITY", "PROXYOBJECT",
         "IMAGE", "IMAGEDEF", "OLE2FRAME", "OLEFRAME", "UNDERLAY",
         "PDFUNDERLAY", "DGNUNDERLAY", "DWFUNDERLAY", "XREF"}
ALLOW = {"ARC", "ATTDEF", "ATTRIB", "BLOCK", "CIRCLE", "DIMENSION", "ELLIPSE",
         "ENDSEQ", "ENDBLK", "HATCH", "INSERT", "LEADER", "LINE", "LWPOLYLINE",
         "MLINE", "MLEADER", "MTEXT", "POINT", "POLYLINE", "SEQEND", "SHAPE",
         "SOLID", "SPLINE", "TEXT", "TOLERANCE", "TRACE", "VIEWPORT", "WIPEOUT",
         "3DFACE", "RAY", "XLINE", "VERTEX", "ACAD_TABLE", "MULTILEADER"}
SENTINELS = {"SECTION", "ENDSEC", "EOF", "TABLE", "ENDTAB", "BLOCK", "ENDBLK",
             "CLASS"}
SECTION_RECORDS = {
    "CLASSES": {"CLASS"},
    "TABLES": {"TABLE", "ENDTAB", "VPORT", "LTYPE", "LAYER", "STYLE", "VIEW",
               "UCS", "APPID", "DIMSTYLE", "BLOCK_RECORD"},
    # BLOCK definitions commonly contain ordinary geometry. These records are
    # scanned and structurally validated, but never exposed as editable text.
    "BLOCKS": ALLOW,
    "ENTITIES": ALLOW,
    # OBJECTS is intentionally opaque.  Object classes (including vendor and
    # proxy classes) are preserved byte-for-byte but are never edit targets.
    "OBJECTS": set(),
    "ACDSDATA": {"ACDSSCHEMA", "ACDSRECORD"},
}
CYRILLIC = re.compile(r"[\u0400-\u04ff]")
JAPANESE = re.compile(r"[\u3040-\u30ff\u3400-\u9fff]")
EMBEDDED_TECHNICAL_IDENTIFIER = re.compile(
    r"(?<![A-Za-zА-Яа-яЁё0-9])(?:\d+-[А-Яа-яЁё]+-\d+|\d+-[А-Яа-яЁё])(?![A-Za-zА-Яа-яЁё0-9])"
)
# This expression is used for inventory/display only. Editing uses the
# validating scanner below, so changing display compatibility cannot authorise
# an unknown MTEXT program.
ESCAPE = re.compile(r"\\(?:[Pp~\\{}]|[ACcFfHhLlOoQqTtWw][^;]*;)")
FIELD_EXPRESSION = re.compile(r"%<.*?>%", re.DOTALL)
# These patterns are used in hot validation loops.  Keeping the compiled
# objects here avoids repeatedly looking them up through re's small global
# cache when a drawing contains millions of records.
BARE_CR = re.compile(rb"\r(?!\n)")
HEX_VALUE = re.compile(r"[0-9A-F]+")
METRIC_UNIT = re.compile(r"(?:^|\s)м(?:2|²|3|³)?(?:\s|$)", re.IGNORECASE)
SINGLE_CYRILLIC_MARKER = re.compile(r"[А-ЯЁ]")
PROJECT_IDENTIFIER = re.compile(
    r"\d+(?:[.-]\d+)?/[А-ЯЁ]{1,5}-\d{4}\.\s*[А-ЯЁ]{1,4}"
)
PROJECT_IDENTIFIER_PREFIX = re.compile(r"\d+(?:[.-]\d+)?/[А-ЯЁ]")
COMPONENT_TAG = re.compile(r"(?:[А-ЯЁа-яё]\.){2,4}-\d+")
ORDINARY_DRAWING_CODE = re.compile(
    r"(?:[\d.,:+×x/%°²³-]+|[A-Za-zА-Яа-яЁё]{0,4}[-/]?\d[\w./-]*)"
)
LOWER_CYRILLIC = re.compile(r"[\u0430-\u044f\u0451]")
UNICODE_ESCAPE = re.compile(r"\\U\+[0-9A-Fa-f]{4}")


@dataclass(slots=True)
class Pair:
    code: int
    source: bytes
    value_start: int
    value_end: int
    code_start: int

    @property
    def value(self) -> bytes:
        return self.source[self.value_start:self.value_end]

def _next_line(
    data: bytes,
    start: int,
    expected_crlf: bool | None,
) -> tuple[int, int, bool]:
    """Return one line's body offsets and next offset without copying it."""
    newline = data.find(b"\n", start)
    if newline < 0:
        if data.find(b"\r", start) >= 0:
            raise DxfRejected("bare CR line ending")
        raise DxfRejected("DXF must end every record line")
    crlf = newline > start and data[newline - 1] == 13
    body_end = newline - 1 if crlf else newline
    if expected_crlf is not None and crlf != expected_crlf:
        raise DxfRejected("mixed or incomplete DXF line endings")
    return body_end, newline + 1, crlf
def _validate_text_source(data: bytes) -> None:
    """Reject binary/non-UTF-8 input before retaining parsed pair offsets."""
    if not data or b"\x00" in data[:64]:
        raise DxfRejected("binary DXF is not supported")
    if data.startswith(b"AutoCAD Binary DXF"):
        raise DxfRejected("binary DXF is not supported")
    if re.search(rb"[\x0b\x0c\x1c-\x1e]", data):
        raise DxfRejected("DXF must end every record line")
    # Check bare CRs once up front instead of searching each code and value
    # line independently.  CRLF remains the only accepted CR form.
    if BARE_CR.search(data):
        raise DxfRejected("bare CR line ending")
    try:
        data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise DxfRejected("DXF must be UTF-8") from exc


def _parse_ascii_group_code(code_b: bytes, first: bool) -> int:
    """Parse a DXF group code without decoding or invoking the regex engine."""
    if first and code_b.startswith(b"\xef\xbb\xbf"):
        code_b = code_b[3:]
    code_b = code_b.strip()
    length = len(code_b)
    index = 0
    sign = 1
    if index < length and code_b[index] in (43, 45):  # + / -
        if code_b[index] == 45:
            sign = -1
        index += 1
    digits_start = index
    value = 0
    while index < length:
        digit = code_b[index] - 48
        if digit < 0 or digit > 9 or index - digits_start >= 4:
            raise DxfRejected("invalid group code")
        value = value * 10 + digit
        index += 1
    if index == digits_start:
        raise DxfRejected("invalid group code")
    value *= sign
    if not -32768 <= value <= 32767:
        raise DxfRejected("group code out of range")
    return value


def parse_pairs(data: bytes) -> list[Pair]:
    _validate_text_source(data)
    result: list[Pair] = []
    position = 0
    expected_crlf: bool | None = None
    first = True
    while position < len(data):
        code_start = position
        code_end, position, crlf = _next_line(data, position, expected_crlf)
        if expected_crlf is None:
            expected_crlf = crlf
        if position >= len(data):
            raise DxfRejected("odd number of DXF record lines")
        value_start = position
        value_end, position, _ = _next_line(data, position, expected_crlf)
        code = _parse_ascii_group_code(data[code_start:code_end], first)
        first = False
        result.append(Pair(code, data, value_start, value_end, code_start))
    return result


def _text(pair: Pair) -> str:
    return pair.value.decode("utf-8")


def _number(records: list[Pair], code: int, default: float | None = None) -> float | None:
    for rec in records:
        if rec.code == code:
            try:
                value = float(_text(rec).strip())
                if not math.isfinite(value):
                    raise ValueError
                return value
            except ValueError as exc:
                raise DxfRejected(f"invalid numeric group {code}") from exc
    return default


def _first(records: list[Pair], code: int, default: str | None = None) -> str | None:
    for rec in records:
        if rec.code == code:
            return _text(rec)
    return default


def _plain(raw: str) -> str:
    # DXF controls are deliberately only stripped for discovery; raw is retained.
    return (
        ESCAPE.sub(
            lambda m: (
                "\n" if m.group(0) == "\\P" else
                " " if m.group(0) == "\\~" else ""
            ),
            raw,
        )
        .replace("{", "")
        .replace("}", "")
    )


def _is_preserved_drawing_code(value: str) -> bool:
    """Conservatively recognise whole-value technical identifiers, not prose."""
    if METRIC_UNIT.search(value):
        return False
    stripped = value.strip()
    # Isolated capitals are conventional grid/stage markers.  Full matching is
    # essential: the same letter inside a word or phrase remains prose.
    single_cyrillic_marker = SINGLE_CYRILLIC_MARKER.fullmatch(stripped)
    project_identifier = PROJECT_IDENTIFIER.fullmatch(stripped)
    if PROJECT_IDENTIFIER_PREFIX.match(stripped):
        return bool(project_identifier)
    component_tag = COMPONENT_TAG.fullmatch(stripped)
    ordinary_code = ORDINARY_DRAWING_CODE.fullmatch(stripped)
    return bool(single_cyrillic_marker or project_identifier or component_tag or ordinary_code)


def _validate_structure(pairs: list[Pair]) -> tuple[list[tuple[str, list[Pair]]], list[tuple[str, list[Pair]]]]:
    sections: list[tuple[str, list[Pair]]] = []
    current: list[Pair] | None = None
    name = ""
    for pair in pairs:
        val = _text(pair).strip().upper() if pair.code == 0 else ""
        if pair.code == 0 and val == "SECTION":
            if current is not None:
                raise DxfRejected("nested SECTION")
            current, name = [pair], ""
        elif current is None:
            if pair.code == 0 and val == "EOF":
                continue
            raise DxfRejected("record outside section")
        else:
            current.append(pair)
            if not name:
                if pair.code != 2:
                    raise DxfRejected("SECTION missing name")
                name = _text(pair).strip().upper()
            elif pair.code == 0 and val == "ENDSEC":
                sections.append((name, current))
                current = None
    if current is not None or not pairs or _text(pairs[-1]).strip().upper() != "EOF" or pairs[-1].code != 0:
        raise DxfRejected("missing ENDSEC or EOF")

    def records_of(records: list[Pair], permitted_prefix: tuple[int, ...] = ()) -> list[tuple[str, list[Pair]]]:
        result: list[tuple[str, list[Pair]]] = []
        current_record: list[Pair] | None = None
        current_kind = ""
        prefix_codes: list[int] = []
        for record in records[2:-1]:
            if record.code == 0:
                if current_record is not None:
                    result.append((current_kind, current_record))
                current_kind, current_record = _text(record).strip().upper(), [record]
            elif current_record is None:
                prefix_codes.append(record.code)
            else:
                current_record.append(record)
        if tuple(prefix_codes) != permitted_prefix:
            raise DxfRejected("unexpected section data before record boundary")
        if current_record is not None:
            result.append((current_kind, current_record))
        return result

    section_records: dict[str, list[tuple[str, list[Pair]]]] = {}
    for section, records in sections:
        if section == "HEADER":
            unexpected = [record for record in records[2:-1] if record.code == 0]
            if unexpected:
                raise DxfRejected(f"unsupported top-level HEADER record {_text(unexpected[0]).strip()}")
            section_records[section] = []
        else:
            section_records[section] = records_of(
                records, (70, 71) if section == "ACDSDATA" else ()
            )
    known_handles: set[str] = set()
    references: list[tuple[int, str]] = []
    handle_exempt = {"CLASS", "ENDTAB", "ACDSSCHEMA", "ACDSRECORD"}
    subclass_exempt = handle_exempt | {"ACDBPLACEHOLDER"}
    named_codes = {
        "CLASS": (1, 2, 3), "TABLE": (2,), "VPORT": (2,), "LTYPE": (2,),
        "LAYER": (2,), "STYLE": (2,), "VIEW": (2,), "UCS": (2,),
        "APPID": (2,), "DIMSTYLE": (2,),
        "BLOCK_RECORD": (2,), "BLOCK": (2,), "ACDSSCHEMA": (1, 2),
        "ACDSRECORD": (2,), "MLINESTYLE": (2,), "LAYOUT": (1, 2),
        "MATERIAL": (1,), "MLEADERSTYLE": (3,), "SCALE": (300,),
        "ACDBDETAILVIEWSTYLE": (3,), "ACDBSECTIONVIEWSTYLE": (3,),
        "TABLESTYLE": (3,), "VISUALSTYLE": (1, 2), "DICTIONARYVAR": (1,),
        "CELLSTYLEMAP": (1,),
    }

    # Drawing text records are inventoried below.  Opaque records are accepted,
    # but only explicitly supported visible value groups are ever editable.
    for section, records in sections:
        if section not in {"HEADER"} | set(SECTION_RECORDS):
            raise DxfRejected(f"unsupported section {section}")
        top_records = section_records[section]
        inside_block = False
        table_name: str | None = None
        table_declared = table_entries = 0
        for kind, record_fields in top_records:
            if kind == "MTEXT" and section not in {"ENTITIES", "BLOCKS"}:
                raise DxfRejected(f"MTEXT outside drawing content in {section}")
            if section == "BLOCKS":
                if kind == "BLOCK":
                    if inside_block:
                        raise DxfRejected("nested BLOCK definition")
                    inside_block = True
                elif kind == "ENDBLK":
                    if not inside_block:
                        raise DxfRejected("ENDBLK without BLOCK")
                    inside_block = False
                elif not inside_block:
                    raise DxfRejected(f"{kind} outside BLOCK definition")
            opaque_high_risk = (
                kind in RISKY
                or any(word in kind for word in
                       ("PROXY", "UNDERLAY", "IMAGE", "OLE", "PDF", "XREF"))
            )
            if (section != "HEADER" and section != "OBJECTS"
                    and kind not in SECTION_RECORDS[section]
                    and not opaque_high_risk):
                raise DxfRejected(f"unsupported or misplaced record {kind} in {section}")
            if section == "TABLES":
                if kind == "TABLE":
                    if table_name is not None:
                        raise DxfRejected("nested TABLE")
                    table_name = (_first(record_fields, 2) or "").strip().upper()
                    if table_name not in {"VPORT", "LTYPE", "LAYER", "STYLE", "VIEW",
                                          "UCS", "APPID", "DIMSTYLE", "BLOCK_RECORD"}:
                        raise DxfRejected(f"unsupported TABLE {table_name}")
                    try:
                        table_declared = int((_first(record_fields, 70) or "").strip())
                    except ValueError as exc:
                        raise DxfRejected("invalid TABLE declared count") from exc
                    if table_declared < 0:
                        raise DxfRejected("negative TABLE declared count")
                    table_entries = 0
                elif kind == "ENDTAB":
                    if table_name is None:
                        raise DxfRejected("ENDTAB without TABLE")
                    table_name = None
                else:
                    if table_name is None:
                        raise DxfRejected("table entry outside TABLE")
                    if kind != table_name:
                        raise DxfRejected(f"misplaced {kind} entry in {table_name} TABLE")
                    table_entries += 1

            # Group 102 application-data braces are record-local scopes.
            brace_depth = 0
            for field in ([] if section == "OBJECTS" else record_fields):
                if field.code == 102:
                    value = _text(field).strip()
                    if value.startswith("{"):
                        brace_depth += 1
                    elif value == "}":
                        brace_depth -= 1
                        if brace_depth < 0:
                            raise DxfRejected(f"unbalanced 102 scope in {kind}")
                    else:
                        raise DxfRejected(f"malformed 102 scope in {kind}")
            if brace_depth:
                raise DxfRejected(f"unbalanced 102 scope in {kind}")

            handle_code = 105 if kind == "DIMSTYLE" else 5
            # Unknown OBJECTS are opaque by contract: imposing guessed subclass
            # or naming schemas on them would reject valid custom data.
            opaque_object = section == "OBJECTS"
            if opaque_object:
                opaque_handle = (_first(record_fields, 5) or "").strip().upper()
                if opaque_handle:
                    if not HEX_VALUE.fullmatch(opaque_handle):
                        raise DxfRejected(f"{kind} has invalid object handle")
                    if opaque_handle in known_handles:
                        raise DxfRejected(f"duplicate handle {opaque_handle}")
                    known_handles.add(opaque_handle)
            if kind not in handle_exempt and not opaque_object:
                handle = (_first(record_fields, handle_code) or "").strip().upper()
                if not HEX_VALUE.fullmatch(handle):
                    raise DxfRejected(f"{kind} missing or invalid hex handle")
                if handle in known_handles:
                    raise DxfRejected(f"duplicate handle {handle}")
                known_handles.add(handle)
                owner = (_first(record_fields, 330) or "").strip().upper()
                if not HEX_VALUE.fullmatch(owner):
                    raise DxfRejected(f"{kind} missing or invalid owner")
                if kind not in subclass_exempt and _first(record_fields, 100) is None:
                    raise DxfRejected(f"{kind} missing subclass marker")
            for code in (() if opaque_object else named_codes.get(kind, ())):
                required_value = _first(record_fields, code)
                if required_value is None or (kind in {"CLASS", "TABLE"} and not required_value.strip()):
                    raise DxfRejected(f"{kind} missing required name field {code}")
            for field in ([] if opaque_object else record_fields):
                if 320 <= field.code <= 369 or field.code == 1005:
                    reference = _text(field).strip().upper()
                    if not HEX_VALUE.fullmatch(reference):
                        raise DxfRejected(f"invalid handle reference in group {field.code}")
                    references.append((field.code, reference))
        if section == "BLOCKS" and inside_block:
            raise DxfRejected("BLOCK definition missing ENDBLK")
        if section == "TABLES" and table_name is not None:
            raise DxfRejected("TABLE missing ENDTAB")

    for code, reference in references:
        if reference != "0" and reference not in known_handles:
            raise DxfRejected(f"unresolved handle reference {reference} in group {code}")

    # INSERT names are not handles and therefore need a separate integrity
    # pass.  Names are case-insensitive in DXF.  Rejecting duplicate names and
    # cycles makes traversal deterministic and prevents a small file from
    # creating an unbounded visible placement graph.
    blocks: dict[str, list[tuple[str, list[Pair]]]] = {}
    current_name: str | None = None
    for kind, records in section_records.get("BLOCKS", []):
        if kind == "BLOCK":
            current_name = (_first(records, 2) or "").strip().upper()
            if not current_name:
                raise DxfRejected("BLOCK missing name")
            if current_name in blocks:
                raise DxfRejected(f"duplicate BLOCK name {current_name}")
            blocks[current_name] = []
        elif kind == "ENDBLK":
            current_name = None
        elif current_name is not None:
            blocks[current_name].append((kind, records))
    insert_records = [
        records
        for records_in_scope in [section_records.get("ENTITIES", []), *blocks.values()]
        for kind, records in records_in_scope
        if kind == "INSERT"
    ]
    for records in insert_records:
        name = (_first(records, 2) or "").strip().upper()
        if not name:
            raise DxfRejected("INSERT missing block name")
        if name not in blocks:
            raise DxfRejected(f"INSERT references unknown BLOCK {name}")

    visiting: set[str] = set()
    visited: set[str] = set()
    def visit_block(name: str, depth: int = 0) -> None:
        if depth > 64:
            raise DxfRejected("INSERT graph exceeds maximum nesting depth")
        if name in visiting:
            raise DxfRejected(f"cyclic INSERT graph at BLOCK {name}")
        if name in visited:
            return
        visiting.add(name)
        for kind, records in blocks[name]:
            if kind == "INSERT":
                visit_block((_first(records, 2) or "").strip().upper(), depth + 1)
        visiting.remove(name)
        visited.add(name)
    for name in blocks:
        visit_block(name)

    entities: list[tuple[str, list[Pair]]] = []
    entities.extend(section_records.get("ENTITIES", []))
    seen: set[str] = set()
    for kind, records in entities:
        if (kind not in ALLOW and kind not in RISKY
                and not any(word in kind for word in ("PROXY", "UNDERLAY", "IMAGE", "OLE", "XREF"))):
            raise DxfRejected(f"unsupported custom entity {kind}")
        handle = _first(records, 5)
        if not handle:
            raise DxfRejected(f"entity {kind} has no handle")
        handle = handle.strip().upper()
        if handle in seen:
            raise DxfRejected(f"duplicate entity handle {handle}")
        seen.add(handle)
    return sections, entities


def _drawing_records(sections: list[tuple[str, list[Pair]]]) -> tuple[
    list[tuple[str, list[Pair], str | None]],
    dict[str, list[tuple[str, list[Pair]]]],
    dict[str, tuple[float, float]],
]:
    """Return direct/definition records and the validated block map."""
    direct: list[tuple[str, list[Pair], str | None]] = []
    blocks: dict[str, list[tuple[str, list[Pair]]]] = {}
    block_bases: dict[str, tuple[float, float]] = {}
    current: str | None = None
    for section, records in sections:
        if section not in {"ENTITIES", "BLOCKS"}:
            continue
        record_list: list[tuple[str, list[Pair]]] = []
        active_kind = ""
        active: list[Pair] | None = None
        for field in records[2:-1]:
            if field.code == 0:
                if active is not None:
                    record_list.append((active_kind, active))
                active_kind, active = _text(field).strip().upper(), [field]
            elif active is not None:
                active.append(field)
        if active is not None:
            record_list.append((active_kind, active))
        if section == "ENTITIES":
            direct.extend((kind, fields, None) for kind, fields in record_list)
            continue
        for kind, fields in record_list:
            if kind == "BLOCK":
                current = (_first(fields, 2) or "").strip().upper()
                blocks[current] = []
                block_bases[current] = (
                    _number(fields, 10, 0.0) or 0.0,
                    _number(fields, 20, 0.0) or 0.0,
                )
            elif kind == "ENDBLK":
                current = None
            elif current is not None:
                blocks[current].append((kind, fields))
                direct.append((kind, fields, current))
    return direct, blocks, block_bases


VISIBLE_KINDS = {"MTEXT", "TEXT", "DIMENSION", "MULTILEADER", "MLEADER",
                 "ATTDEF", "ATTRIB"}
PATCHABLE_KINDS = {"MTEXT", "TEXT", "DIMENSION", "MULTILEADER", "MLEADER"}


def _entity_anchor(kind: str, records: list[Pair]) -> tuple[float, float, float]:
    """Return the text anchor, not an unrelated geometry/control point."""
    code = 12 if kind in {"MULTILEADER", "MLEADER"} else 11 if kind == "DIMENSION" else 10
    return (
        _number(records, code, 0.0) or 0.0,
        _number(records, code + 10, 0.0) or 0.0,
        _number(records, code + 20, 0.0) or 0.0,
    )


def _mleader_content_values(records: list[Pair]) -> list[Pair]:
    """Select only MLeader context text, never nested leader-line markers."""
    values: list[Pair] = []
    saw_context = False
    leader_started = False
    has_context_marker = any(
        field.code == 300 and _text(field).strip().upper() == "CONTEXT_DATA{"
        for field in records
    )
    for record in records:
        value = _text(record)
        if record.code == 300 and value.strip().upper() == "CONTEXT_DATA{":
            saw_context = True
            continue
        if record.code == 302 and value.strip().upper() == "LEADER{":
            leader_started = True
            continue
        if record.code == 304:
            # LEADER_LINE{ is structural even in malformed/out-of-order files;
            # preserving it is always safer than presenting it as editable text.
            if value.strip().upper() == "LEADER_LINE{":
                continue
            if not leader_started and (saw_context or not has_context_marker):
                values.append(record)
    return values


def _insert_placements(
    entities: list[tuple[str, list[Pair]]],
    blocks: dict[str, list[tuple[str, list[Pair]]]],
    block_bases: dict[str, tuple[float, float]],
) -> dict[str, list[dict[str, Any]]]:
    """Expand the finite INSERT graph into world-space visible-text placements."""
    answer: dict[str, list[dict[str, Any]]] = {}
    placement_count = 0
    traversal_count = 0

    # Affine matrices are (a,b,c,d,tx,ty), mapping x/y in the usual way.
    identity = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
    def compose(parent: tuple[float, ...], child: tuple[float, ...]) -> tuple[float, ...]:
        a, b, c, d, tx, ty = parent
        e, f, g, h, ux, uy = child
        return (a*e+c*f, b*e+d*f, a*g+c*h, b*g+d*h,
                a*ux+c*uy+tx, b*ux+d*uy+ty)
    def point(matrix: tuple[float, ...], x: float, y: float) -> tuple[float, float]:
        a, b, c, d, tx, ty = matrix
        return a*x+c*y+tx, b*x+d*y+ty
    def transform(records: list[Pair]) -> tuple[float, ...]:
        angle = math.radians(_number(records, 50, 0.0) or 0.0)
        sx, sy = _number(records, 41, 1.0), _number(records, 42, 1.0)
        if sx == 0 or sy == 0:
            raise DxfRejected("INSERT scale must be nonzero")
        assert sx is not None and sy is not None
        cosine, sine = math.cos(angle), math.sin(angle)
        return (cosine*sx, sine*sx, -sine*sy, cosine*sy,
                _number(records, 10, 0.0) or 0.0, _number(records, 20, 0.0) or 0.0)
    def walk(records_in_scope: list[tuple[str, list[Pair]]], matrix: tuple[float, ...],
             path: list[str], depth: int = 0) -> None:
        nonlocal placement_count, traversal_count
        if depth > 64:
            raise DxfRejected("INSERT graph exceeds maximum nesting depth")
        traversal_count += 1
        if traversal_count > 100000:
            raise DxfRejected("INSERT graph has excessive expanded placements")
        for kind, records in records_in_scope:
            if kind in VISIBLE_KINDS:
                handle = (_first(records, 5) or "").strip().upper()
                anchor_x, anchor_y, _ = _entity_anchor(kind, records)
                x, y = point(matrix, anchor_x, anchor_y)
                placement_id = f"{handle}:" + "/".join(path)
                answer.setdefault(handle, []).append({
                    "placementId": placement_id,
                    "x": x,
                    "y": y,
                    "insertPath": path,
                })
                placement_count += 1
                if placement_count > 100000:
                    raise DxfRejected("INSERT graph has excessive visible placements")
            elif kind == "INSERT":
                name = (_first(records, 2) or "").strip().upper()
                # Rectangular arrays are ordinary INSERT semantics.  Bound the
                # expansion to keep hostile-but-valid declarations manageable.
                raw_columns = _number(records, 70, 1.0) or 1.0
                raw_rows = _number(records, 71, 1.0) or 1.0
                columns, rows = int(raw_columns), int(raw_rows)
                if columns != raw_columns or rows != raw_rows:
                    raise DxfRejected("INSERT array dimensions must be integers")
                if columns < 1 or rows < 1 or columns * rows > 100000:
                    raise DxfRejected("INSERT array dimensions are invalid or excessive")
                dx, dy = _number(records, 44, 0.0) or 0.0, _number(records, 45, 0.0) or 0.0
                base_transform = transform(records)
                base_x, base_y = block_bases[name]
                insert_handle = (_first(records, 5) or "").strip().upper()
                for row in range(rows):
                    for column in range(columns):
                        offset = (1.0, 0.0, 0.0, 1.0,
                                  column*dx-base_x, row*dy-base_y)
                        walk(blocks[name], compose(matrix, compose(base_transform, offset)),
                             path + [f"{insert_handle}[{row},{column}]"], depth + 1)
    walk(entities, identity, [])
    # Layout-space block contents are roots in their own right and ordinarily
    # have no INSERT in model-space. Traverse each exactly once.
    for name in sorted(blocks):
        if name.startswith("*PAPER_SPACE"):
            walk(blocks[name], identity, [f"LAYOUT:{name}"])
    # Anonymous dimension blocks are graphical caches. Their coordinates are
    # already WCS coordinates, so applying the DIMENSION transform again moves
    # them incorrectly.
    for kind, records in entities:
        if kind != "DIMENSION":
            continue
        name = (_first(records, 2) or "").strip().upper()
        handle = (_first(records, 5) or "").strip().upper()
        if name in blocks:
            walk(blocks[name], identity, [f"DIMENSION:{handle}"])
    return answer


def inventory(
    data: bytes,
    *,
    _cell_geometry: tuple[list[tuple[float, float, float]], list[tuple[float, float, float]]] | None = None,
    _parsed: tuple[
        list[Pair],
        list[tuple[str, list[Pair]]],
        list[tuple[str, list[Pair]]],
    ] | None = None,
) -> dict[str, Any]:
    if _parsed is None:
        pairs = parse_pairs(data)
        sections, entities = _validate_structure(pairs)
    else:
        # Preview already needs the validated entity records for geometry.
        # Reuse that exact parse rather than validating and retaining a second
        # complete 47 MB drawing object graph.
        pairs, sections, entities = _parsed
    if _cell_geometry is not None:
        _collect_cell_geometry(entities, _cell_geometry)
    version = None
    for i, pair in enumerate(pairs[:-1]):
        if pair.code == 9 and _text(pair).strip() == "$ACADVER":
            version = _text(pairs[i + 1]).strip()
    if version != "AC1032":
        raise DxfRejected("only UTF-8 text-format DXF AC1032 is accepted")
    drawing_records, blocks, block_bases = _drawing_records(sections)
    placements = _insert_placements(entities, blocks, block_bases)
    # AutoCAD owns generated table block graphics as well as the table entity.
    # Patching their MTEXT independently would desynchronize the table caches.
    table_cache_blocks = {
        (_first(records, 2) or "").strip().upper()
        for kind, records, _ in drawing_records if kind == "ACAD_TABLE"
    } - {""}
    pending_cache_blocks = list(table_cache_blocks)
    while pending_cache_blocks:
        for child_kind, child_records in blocks.get(pending_cache_blocks.pop(), []):
            if child_kind != "INSERT":
                continue
            child = (_first(child_records, 2) or "").strip().upper()
            if child and child not in table_cache_blocks:
                table_cache_blocks.add(child)
                pending_cache_blocks.append(child)
    entries = []
    unresolved_visible = []
    for kind, records, block_name in drawing_records:
        if kind not in VISIBLE_KINDS:
            continue
        handle = (_first(records, 5) or "").strip().upper()
        if kind == "MTEXT":
            values = [r for r in records if r.code in {1, 3}]
        elif kind in {"MULTILEADER", "MLEADER"}:
            values = _mleader_content_values(records)
        else:
            values = [r for r in records if r.code == 1]
        if kind == "DIMENSION":
            values = [r for r in values if _text(r).strip() not in {"", "<>"}]
        if kind == "MTEXT" and not any(r.code == 1 for r in values):
            raise DxfRejected(f"MTEXT {handle} has no code 1 text record")
        if not values:
            continue
        raw = "".join(_text(r) for r in values)
        x, y, z = _entity_anchor(kind, records)
        direction = [_number(records, 11), _number(records, 21), _number(records, 31)]
        rotation = _number(records, 50)
        plain_text = _plain(raw)
        entry = {
            "targetId": f"{kind}:{handle}",
            "entityType": kind,
            "handle": handle, "rawText": raw, "plainText": plain_text,
            "definitionBlock": block_name,
            "placements": placements.get(handle, []) if block_name else [{
                "placementId": f"{handle}:direct",
                "x": x, "y": y, "insertPath": [],
            }],
            "placementCount": len(placements.get(handle, [])) if block_name else 1,
            "textRecordOffsets": [{"code": r.code, "start": r.value_start, "end": r.value_end} for r in values],
            "x": x, "y": y, "z": z, "direction": direction, "rotation": rotation,
            "attachment": _number(records, 71), "style": _first(records, 7),
            "layer": _first(records, 8), "color": _number(records, 62),
            "width": _number(records, 41), "height": _number(records, 40),
            "actualHeight": _number(records, 43),
            "owner": _first(records, 330), "space": "paper" if _number(records, 67, 0) else "model",
            "formattingEscapes": ESCAPE.findall(raw),
            "isCyrillicTarget": bool(CYRILLIC.search(plain_text)),
            # Numbers, dimensions, and short alphanumeric drawing identifiers
            # are surfaced for review but never treated as language targets.
            "preservedDrawingCodeCandidate": _is_preserved_drawing_code(plain_text),
            "patchableInDxf": kind in PATCHABLE_KINDS and block_name not in table_cache_blocks,
            "deferredTableCache": block_name in table_cache_blocks,
        }
        entries.append(entry)
        if kind in {"ATTDEF", "ATTRIB"} and CYRILLIC.search(plain_text):
            unresolved_visible.append({
                "targetId": entry["targetId"], "entityType": kind,
                "handle": handle, "reason": "attribute_text_requires_autocad",
            })
    entries.sort(key=lambda e: (e["handle"], e["entityType"]))
    entries_by_target = {entry["targetId"]: entry for entry in entries}
    dimension_cache_bindings = []
    for kind, records, block_name in drawing_records:
        if kind != "DIMENSION" or block_name is not None:
            continue
        dimension_handle = (_first(records, 5) or "").strip().upper()
        dimension = entries_by_target.get(f"DIMENSION:{dimension_handle}")
        cache_block = (_first(records, 2) or "").strip().upper()
        if (dimension is None or cache_block not in blocks
                or not dimension["isCyrillicTarget"]):
            continue
        candidates = []
        for cache_kind, cache_records in blocks[cache_block]:
            cache_handle = (_first(cache_records, 5) or "").strip().upper()
            cache = entries_by_target.get(f"{cache_kind}:{cache_handle}")
            if (cache is not None
                    and cache["rawText"] == dimension["rawText"]
                    and cache["plainText"] == dimension["plainText"]):
                candidates.append(cache)
        if len(candidates) == 1:
            dimension_cache_bindings.append({
                "dimensionTargetId": dimension["targetId"],
                "cacheTargetId": candidates[0]["targetId"],
            })
        elif candidates:
            unresolved_visible.append({
                "targetId": dimension["targetId"],
                "entityType": "DIMENSION", "handle": dimension_handle,
                "isCyrillicTarget": dimension["isCyrillicTarget"],
                "reason": "dimension_cache_text_ambiguous",
            })
        else:
            unresolved_visible.append({
                "targetId": dimension["targetId"],
                "entityType": "DIMENSION", "handle": dimension_handle,
                "isCyrillicTarget": dimension["isCyrillicTarget"],
                "reason": "dimension_cache_text_mismatch",
            })
    dimension_cache_bindings.sort(
        key=lambda binding: (binding["dimensionTargetId"], binding["cacheTargetId"])
    )
    mtext_entries = [entry for entry in entries if entry["entityType"] == "MTEXT"]
    groups = _groups(mtext_entries)
    placement_manifest = [
        {
            "placementId": placement["placementId"],
            "handle": entry["handle"],
            "definitionBlock": entry["definitionBlock"],
            "x": placement["x"],
            "y": placement["y"],
            "insertPath": placement["insertPath"],
        }
        for entry in entries
        for placement in entry["placements"]
    ]
    placement_manifest_sha256 = hashlib.sha256(json.dumps(
        placement_manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")).hexdigest()
    type_counts: dict[str, int] = {}
    for kind, _ in entities:
        type_counts[kind] = type_counts.get(kind, 0) + 1
    definition_type_counts: dict[str, int] = {}
    for kind, _, block_name in drawing_records:
        if block_name:
            definition_type_counts[kind] = definition_type_counts.get(kind, 0) + 1
    table_targets = []
    for kind, records, block_name in drawing_records:
        if kind != "ACAD_TABLE":
            continue
        handle = (_first(records, 5) or "").strip().upper()
        source_values = list(table_cell_source_spans(records))
        table_values: dict[str, dict[str, Any]] = {}
        field_values: dict[str, dict[str, Any]] = {}
        for ordinal, spans in enumerate(source_values):
            record = spans[-1]
            value = "".join(_text(span) for span in spans)
            source_hash = hashlib.sha256(value.encode("utf-8")).hexdigest()
            if FIELD_EXPRESSION.search(value):
                existing_field = field_values.get(value)
                if existing_field is not None:
                    existing_field["sourceOccurrenceCount"] += 1
                    continue
                unresolved = {
                    "targetId": f"ACAD_TABLE:{handle}:1:{source_hash}",
                    "entityType": "ACAD_TABLE", "handle": handle,
                    "tableHandle": handle, "sourceGroupCode": 1,
                    "sourceOrdinal": ordinal, "sourceText": value,
                    "sourceOccurrenceCount": 1,
                    "sourceTextSha256": source_hash,
                    "isCyrillicTarget": bool(CYRILLIC.search(value)),
                    "reason": "field_expression_payload_requires_autocad",
                }
                field_values[value] = unresolved
                unresolved_visible.append(unresolved)
                continue
            if not CYRILLIC.search(value):
                continue
            existing = table_values.get(value)
            if existing is not None:
                existing["sourceOccurrenceCount"] += 1
                continue
            target = {
                "targetId": f"ACAD_TABLE:{handle}:1:{source_hash}",
                "tableHandle": handle, "definitionBlock": block_name,
                "sourceGroupCode": 1, "sourceOrdinal": ordinal,
                "sourceOccurrenceCount": 1,
                "owner": _first(records, 330), "layer": _first(records, 8),
                "sourceText": value,
                "sourceTextSha256": source_hash,
                "sourceByteRange": [spans[0].value_start, record.value_end],
                "sourceValueSpans": [
                    {"code": span.code, "start": span.value_start, "end": span.value_end}
                    for span in spans
                ],
                "matching": {"exactText": value, "exactTextSha256": source_hash},
                "isCyrillicTarget": True,
                "patchableInDxf": False,
            }
            table_values[value] = target
            table_targets.append(target)
    opaque_visibility_findings = []
    opaque_kinds: dict[str, int] = {}
    for section, records in sections:
        for record in records:
            if record.code != 0:
                continue
            kind = _text(record).strip().upper()
            if (kind in RISKY or any(word in kind for word in
                    ("PROXY", "UNDERLAY", "IMAGE", "OLE", "PDF", "XREF"))):
                opaque_kinds[kind] = opaque_kinds.get(kind, 0) + 1
    if opaque_kinds:
        opaque_visibility_findings.append({
            "reason": "opaque_content_requires_cad_visual_review",
            "count": sum(opaque_kinds.values()),
            "recordCounts": dict(sorted(opaque_kinds.items())),
            "renderingSemanticsValidated": False,
        })
    for reason in sorted({row["reason"] for row in unresolved_visible}):
        affected = [row for row in unresolved_visible if row["reason"] == reason]
        opaque_visibility_findings.append({
            "reason": reason,
            "count": len(affected),
            "cyrillicTargetCount": sum(
                bool(row.get("isCyrillicTarget")) for row in affected
            ),
        })
    if table_targets:
        opaque_visibility_findings.append({
            "reason": "acad_table_cyrillic_text_requires_autocad",
            "count": len(table_targets),
            "sourceOccurrenceCount": sum(
                row["sourceOccurrenceCount"] for row in table_targets
            ),
            "cyrillicTargetCount": len(table_targets),
        })
    return {"format": "dxf-visible-text-inventory-v2", "encoding": "utf-8",
            "lineEnding": "CRLF" if b"\r\n" in data else "LF", "acadVersion": version,
            "sections": [name for name, _ in sections], "entityCount": len(entities),
            "entityTypeCounts": dict(sorted(type_counts.items())),
             "blockDefinitionTypeCounts": dict(sorted(definition_type_counts.items())),
            "opaqueRecords": {"status": "preserved", "objectsAndHighRiskEditable": False},
            "highRiskScan": {
                "status": "visibility-warnings" if opaque_visibility_findings else "preserved-opaque",
                "findings": opaque_visibility_findings,
            },
            "highRiskScanResult": (
                "preserved-opaque-with-visibility-warnings"
                if opaque_visibility_findings else "preserved-opaque"
            ),
            "validationProfile": {
                 "name": "strict-ac1032-safe-hybrid-v4", "status": "passed",
                "allSectionsScanned": True, "sectionsScanned": [name for name, _ in sections],
                "pairStructureValidated": True,
                "supportedRecordStructuralSchemaValidated": True,
                "classLevelChecks": [
                    "per-section-record-allowlists", "balanced-table-and-block-scopes",
                    "table-declarations", "unique-hex-handles", "required-fields",
                    "balanced-group-102-scopes", "resolved-handle-references",
                    "block-name-and-insert-graph-integrity",
                ],
                "renderingSemanticsValidated": False, "sourceBytesPreserved": True,
            },
            "visibleTextCount": len(entries),
            "cyrillicTargetCount": sum(x["isCyrillicTarget"] for x in entries),
            "textEntries": entries,
            "mtextCount": len(mtext_entries), "accountedMtextCount": len(mtext_entries),
            "mtext": mtext_entries,
            "unresolvedVisibleText": unresolved_visible,
             "dimensionCacheBindings": dimension_cache_bindings,
            "tableTargetCount": len(table_targets), "tableTargets": table_targets,
            "placementCount": len(placement_manifest),
            "placementManifest": placement_manifest,
            "placementManifestSha256": placement_manifest_sha256,
            "splitFragmentGroups": groups, "sha256": hashlib.sha256(data).hexdigest()}


def _groups(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Find only explicit Cyrillic hyphen continuations, never generic rows."""
    by_handle = {item["handle"]: item for item in items}

    def continuation(first: dict[str, Any]) -> dict[str, Any] | None:
        source = first["plainText"].rstrip()
        if not (source.endswith(("-", "‑", "–")) and CYRILLIC.search(source)):
            return None
        options = []
        for second in items:
            candidate = second["plainText"].lstrip()
            if (first is second
                    or first.get("definitionBlock") != second.get("definitionBlock")
                    or not LOWER_CYRILLIC.match(candidate)):
                continue
            dx = abs((first["x"] or 0) - (second["x"] or 0))
            dy = (first["y"] or 0) - (second["y"] or 0)
            limit = max(20.0, (first["height"] or 2) * 5)
            if 0 < dy <= limit and dx <= max(5.0, (first["height"] or 2) * 3):
                options.append((dy, dx, second["handle"], second))
        return min(options, default=(0, 0, "", None))[3]

    next_item = {item["handle"]: continuation(item) for item in items}
    follows = {value["handle"] for value in next_item.values() if value is not None}
    result = []
    for item in items:
        if item["handle"] in follows or next_item[item["handle"]] is None:
            continue
        chain, seen, current = [item["handle"]], {item["handle"]}, item
        while next_item.get(current["handle"]) is not None:
            current = next_item[current["handle"]]
            if current["handle"] in seen:
                break
            chain.append(current["handle"])
            seen.add(current["handle"])
        if len(chain) > 1:
            result.append({"id": "split-" + "-".join(chain), "handles": chain, "reason": "cyrillic-hyphen-continuation"})
    return sorted(result, key=lambda x: tuple(x["handles"]))


def _translations(doc: Any) -> dict[str, str]:
    rows = doc.get("translations", doc) if isinstance(doc, dict) else doc
    if not isinstance(rows, (list, dict)):
        raise DxfRejected("translations must be an object or list")
    if isinstance(rows, dict):
        rows = [{"handle": k, "translation": v} for k, v in rows.items()]
    answer = {}
    for row in rows:
        if not isinstance(row, dict):
            raise DxfRejected("invalid translation row")
        h = str(row.get("targetId", row.get("handle", ""))).upper()
        text = row.get("translation", row.get("text"))
        if not h or not isinstance(text, str) or not text.strip() or h in answer:
            raise DxfRejected("empty, duplicate, or malformed replacement")
        answer[h] = text
    return answer


def _safe_value(value: str) -> bytes:
    if "\r" in value or "\n" in value or "\x00" in value:
        raise DxfRejected("replacement contains a record boundary")
    # User text must never become an MTEXT formatting program.
    value = value.replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}")
    return value.encode("utf-8")


def _safe_mtext_value(value: str) -> bytes:
    """Encode replacement text, mapping provider line breaks to MTEXT paragraphs."""
    if "\x00" in value:
        raise DxfRejected("replacement contains a record boundary")
    # Newlines are valid visible replacement text, but cannot be written
    # literally inside a DXF value record.  Emit the MTEXT paragraph control
    # instead, while still escaping all user-supplied formatting characters.
    normalized = value.replace("\r\n", "\n").replace("\r", "\n")
    return b"\\P".join(_safe_value(line) for line in normalized.split("\n"))


def _formatted_value(raw: str, replacement: str) -> bytes:
    """Replace visible runs while retaining the complete MTEXT control program.

    Controls and structural braces are copied from ``raw`` verbatim.  Text is
    divided before it is escaped, so a split can never cut a newly-created
    escape sequence.
    """
    tokens: list[tuple[str, str]] = []
    visible: list[str] = []
    depth = 0
    index = 0

    def fail() -> None:
        raise DxfRejected("formatting_mtext_unsafe")

    while index < len(raw):
        char = raw[index]
        if char in "{}":
            if char == "}":
                depth -= 1
                if depth < 0:
                    fail()
            else:
                depth += 1
            tokens.append(("brace", char))
            index += 1
            continue
        if char == "\\":
            if index + 1 >= len(raw):
                fail()
            command = raw[index + 1]
            if command in "P~\\{}LlOoKkX":
                end = index + 2
            elif command == "U":
                candidate = raw[index:index + 7]
                if not UNICODE_ESCAPE.fullmatch(candidate):
                    fail()
                end = index + 7
            elif command == "p":
                # Lowercase p is the paragraph-properties command when it has
                # arguments; tolerate the established two-byte paragraph form.
                semicolon = raw.find(";", index + 2)
                if semicolon >= 0 and raw[index + 2:semicolon]:
                    if any(c in "\\{}" for c in raw[index + 2:semicolon]):
                        fail()
                    end = semicolon + 1
                else:
                    end = index + 2
            elif command in "ACcFfHhQqTtWwSs":
                semicolon = raw.find(";", index + 2)
                if semicolon < 0 or any(c in "\\{}" for c in raw[index + 2:semicolon]):
                    fail()
                end = semicolon + 1
            else:
                fail()
            tokens.append(("control", raw[index:end]))
            index = end
            continue
        end = index + 1
        while end < len(raw) and raw[end] not in "\\{}":
            end += 1
        value = raw[index:end]
        tokens.append(("visible", value))
        visible.append(value)
        index = end
    if depth or not visible:
        fail()

    # Allocate by the amount of source text carried by each run.  A paragraph
    # boundary gets the nearest word boundary where possible, avoiding arbitrary
    # word splits while retaining every original paragraph command.
    total_weight = sum(len(value) for value in visible)
    replacement_length = len(replacement)
    cuts = [0]
    cumulative = 0
    visible_seen = 0
    for token_index, (kind, value) in enumerate(tokens):
        if kind != "visible":
            continue
        visible_seen += 1
        cumulative += len(value)
        if visible_seen == len(visible):
            break
        desired = (
            replacement_length * cumulative // total_weight
            if total_weight else replacement_length * visible_seen // len(visible)
        )
        next_visible = next(
            i for i in range(token_index + 1, len(tokens))
            if tokens[i][0] == "visible"
        )
        paragraph = any(
            token_kind == "control"
            and token_value in {"\\P", "\\p"}
            for token_kind, token_value in tokens[token_index + 1:next_visible]
        )
        if paragraph:
            boundaries = [
                i for i in range(cuts[-1], replacement_length + 1)
                if (i > 0 and replacement[i - 1].isspace())
                or (i < replacement_length and replacement[i].isspace())
            ]
            if boundaries:
                desired = min(boundaries, key=lambda i: (abs(i - desired), i))
        cuts.append(max(cuts[-1], min(desired, replacement_length)))
    cuts.append(replacement_length)
    pieces = [
        replacement[start:end]
        for start, end in zip(cuts, cuts[1:])
    ]
    output: list[bytes] = []
    visible_index = 0
    for kind, value in tokens:
        if kind == "visible":
            output.append(_safe_mtext_value(pieces[visible_index]))
            visible_index += 1
        else:
            output.append(value.encode("utf-8"))
    return b"".join(output)


def _split_utf8_across_spans(value: bytes, spans: list[dict[str, Any]]) -> list[bytes]:
    """Split a complete encoded value proportionally without cutting UTF-8."""
    if not spans:
        raise DxfRejected("text target has no value spans")
    if len(spans) == 1:
        return [value]
    # Decoding also makes this helper fail closed if a future encoder supplies
    # malformed bytes. Boundaries include zero and the complete byte length.
    text = value.decode("utf-8")
    boundaries = [0]
    for character in text:
        boundaries.append(boundaries[-1] + len(character.encode("utf-8")))
    lengths = [record["end"] - record["start"] for record in spans]
    original_total = sum(lengths)
    cuts = [0]
    cumulative = 0
    for index, length in enumerate(lengths[:-1], 1):
        cumulative += length
        desired = (
            len(value) * cumulative // original_total
            if original_total
            else len(value) * index // len(spans)
        )
        cuts.append(max(boundary for boundary in boundaries if boundary <= desired))
    cuts.append(len(value))
    return [value[start:end] for start, end in zip(cuts, cuts[1:])]


def _collect_cell_geometry(
    entities: list[tuple[str, list[Pair]]],
    geometry: tuple[list[tuple[float, float, float]], list[tuple[float, float, float]]],
) -> None:
    """Collect orthogonal segments while the already-validated source is live."""
    vertical, horizontal = geometry
    for kind, records in entities:
        if kind != "LWPOLYLINE":
            continue
        vertices: list[tuple[float, float]] = []
        pending: float | None = None
        for rec in records:
            if rec.code == 10:
                try:
                    pending = float(_text(rec))
                except ValueError:
                    pending = None
            elif rec.code == 20 and pending is not None:
                try:
                    vertices.append((pending, float(_text(rec))))
                except ValueError:
                    pass
                pending = None
        for a, b in zip(vertices, vertices[1:]):
            if abs(a[0] - b[0]) < 1e-6:
                vertical.append((a[0], min(a[1], b[1]), max(a[1], b[1])))
            if abs(a[1] - b[1]) < 1e-6:
                horizontal.append((a[1], min(a[0], b[0]), max(a[0], b[0])))


def _nearby_cell_limits(
    geometry: tuple[list[tuple[float, float, float]], list[tuple[float, float, float]]],
    x: float,
    y: float,
    text_height: float,
) -> tuple[float | None, float | None]:
    """Infer only close orthogonal cell boundaries from collected segments."""
    vertical_segments, horizontal_segments = geometry
    tolerance = max(text_height * 3.0, 2.0)
    vertical = [
        coordinate for coordinate, low, high in vertical_segments
        if low - tolerance <= y <= high + tolerance
    ]
    horizontal = [
        coordinate for coordinate, low, high in horizontal_segments
        if low - tolerance <= x <= high + tolerance
    ]
    left = max((v for v in vertical if v < x), default=None)
    right = min((v for v in vertical if v > x), default=None)
    below = max((v for v in horizontal if v < y), default=None)
    above = min((v for v in horizontal if v > y), default=None)
    return ((right-left) if left is not None and right is not None else None,
            (above-below) if below is not None and above is not None else None)


def patch(source: bytes, translations_document: Any) -> tuple[bytes, dict[str, Any]]:
    cell_geometry: tuple[
        list[tuple[float, float, float]],
        list[tuple[float, float, float]],
    ] = ([], [])
    inv = inventory(source, _cell_geometry=cell_geometry)
    target_language = (
        translations_document.get("targetLanguage", "en")
        if isinstance(translations_document, dict) else "en"
    )
    if target_language not in {"en", "ja"}:
        raise DxfRejected("unsupported target language")
    requested = _translations(translations_document)
    by_target = {item["targetId"].upper(): item for item in inv["textEntries"]}
    # Preserve the original handle-only API where a handle identifies exactly
    # one editable visible text record.
    handle_rows: dict[str, list[dict[str, Any]]] = {}
    for item in inv["textEntries"]:
        handle_rows.setdefault(item["handle"], []).append(item)
    for handle, rows in handle_rows.items():
        if len(rows) == 1:
            by_target[handle] = rows[0]
    # A DIMENSION override and its exact cache copy are one rendered value.
    # Mirror a supplied translation so the authoritative override and visible
    # anonymous-block cache cannot diverge.
    for binding in inv["dimensionCacheBindings"]:
        dimension_id = binding["dimensionTargetId"].upper()
        cache_id = binding["cacheTargetId"].upper()
        dimension_text = requested.get(dimension_id)
        cache_text = requested.get(cache_id)
        if dimension_text is not None and cache_text is not None and dimension_text != cache_text:
            raise DxfRejected("dimension override and cache translations differ")
        if dimension_text is not None:
            requested[cache_id] = dimension_text
        elif cache_text is not None:
            requested[dimension_id] = cache_text
    unknown = set(requested) - set(by_target)
    if unknown:
        raise DxfRejected("replacement references unknown handle " + sorted(unknown)[0])
    replacements: list[tuple[int, int, bytes, str]] = []
    unresolved = []
    for requested_id, text in requested.items():
        item = by_target[requested_id]
        handle = item["handle"]
        if target_language == "ja" and not JAPANESE.search(text):
            raise DxfRejected(f"replacement for {requested_id} does not contain Japanese script")
        if target_language == "en":
            prose = EMBEDDED_TECHNICAL_IDENTIFIER.sub(" ", text)
            if any(
                char.isalpha() and "LATIN" not in unicodedata.name(char, "")
                for char in prose
            ):
                raise DxfRejected(f"replacement for {requested_id} is not English")
        if not item["patchableInDxf"]:
            unresolved.append({"targetId": item["targetId"], "handle": handle,
                               "entityType": item["entityType"],
                               "reason": "attribute_text_requires_autocad"})
            continue
        try:
            encoded = (_formatted_value(item["rawText"], text)
                       if item["entityType"] == "MTEXT" else _safe_value(text))
        except DxfRejected as exc:
            if str(exc) == "formatting_mtext_unsafe":
                unresolved.append({"targetId": item["targetId"], "handle": handle,
                                   "reason": "formatting_mtext_unsafe"})
                continue
            raise
        width, actual_height = item["width"], item["actualHeight"]
        inferred_width = inferred_height = False
        lines = text.count("\n") + 1
        nominal_height = max(item["height"] or 1.0, 1.0)
        if (item["entityType"] == "MTEXT" and (not width or width <= 0)
                and item["definitionBlock"] is None):
            cell_width, cell_height = _nearby_cell_limits(
                cell_geometry, item["x"] or 0, item["y"] or 0, nominal_height
            )
            width, inferred_width = cell_width, cell_width is not None
            if not actual_height:
                actual_height, inferred_height = cell_height, cell_height is not None
        def estimated_units(line: str) -> float:
            # CJK glyphs are approximately full-em; retain the legacy Latin
            # estimate exactly for English jobs.
            return sum(1.0 if JAPANESE.match(char) else .55 for char in line)
        estimate = max((estimated_units(line) for line in text.splitlines()), default=0) * nominal_height
        source_lines = item["plainText"].splitlines() or [item["plainText"]]
        source_estimate = max((len(line) for line in source_lines), default=0) * nominal_height * .55
        within_known_fitting_baseline = (
            estimate <= source_estimate * 1.05 and lines <= len(source_lines)
        )
        width_unsafe = (item["entityType"] == "MTEXT" and width is not None
                        and width > 0 and estimate > width * .92)
        height_unsafe = (item["entityType"] == "MTEXT"
                         and actual_height is not None and actual_height > 0
                         and lines * nominal_height * 1.2 > actual_height)
        # The source drawing is the strongest known fitting baseline, including
        # for explicit boxes whose recorded dimensions are rounded or stale.
        # This exemption applies only to a demonstrably non-growing replacement;
        # genuinely growing translations remain blocked by authoritative boxes.
        if within_known_fitting_baseline:
            width_unsafe = False
            height_unsafe = False
        unsafe = width_unsafe or height_unsafe
        if unsafe:
            unresolved.append({"targetId": item["targetId"], "handle": handle,
                               "reason": "text_fit_unsafe"})
            continue
        records = item["textRecordOffsets"]
        fragments = _split_utf8_across_spans(encoded, records)
        replacements.extend(
            (rec["start"], rec["end"], fragment, item["targetId"])
            for rec, fragment in zip(records, fragments)
        )
    changed = []
    approved_ranges = sorted(replacements)
    output_buffer = io.BytesIO()
    source_cursor = 0
    for start, end, value, target_id in approved_ranges:
        if start < source_cursor or end < start:
            raise DxfRejected("overlapping or invalid approved value ranges")
        before = source[start:end]
        output_buffer.write(memoryview(source)[source_cursor:start])
        output_start = output_buffer.tell()
        output_buffer.write(value)
        changed.append({"targetId": target_id, "handle": by_target[target_id.upper()]["handle"],
                        "entityType": by_target[target_id.upper()]["entityType"],
                        "sourceRange": [start, end], "sourceSha256": hashlib.sha256(before).hexdigest(),
                        "outputRange": [output_start, output_start + len(value)],
                        "replacementSha256": hashlib.sha256(value).hexdigest()})
        source_cursor = end
    output_buffer.write(memoryview(source)[source_cursor:])
    result = output_buffer.getvalue()

    def metadata_digest(items: list[dict[str, Any]]) -> str:
        ignored = {
            "rawText", "plainText", "textRecordOffsets", "formattingEscapes",
            "isCyrillicTarget", "preservedDrawingCodeCandidate", "placements",
        }
        digest = hashlib.sha256()
        for item_row in items:
            digest.update(json.dumps(
                {key: value for key, value in item_row.items() if key not in ignored},
                ensure_ascii=False, sort_keys=True, separators=(",", ":"),
            ).encode("utf-8"))
            digest.update(b"\n")
        return digest.hexdigest()

    source_target_ids = tuple(x["targetId"] for x in inv["textEntries"])
    source_metadata_sha256 = metadata_digest(inv["textEntries"])
    source_placement_sha256 = inv["placementManifestSha256"]
    source_placement_count = inv["placementCount"]
    source_text_count = len(inv["textEntries"])
    source_mtext_count = len(inv["mtext"])
    source_line_ending = inv["lineEnding"]
    source_validation_profile = inv["validationProfile"]
    source_sections = inv["sections"]
    changed_target_types = {
        target_id: by_target[target_id.upper()]["entityType"]
        for target_id in {change["targetId"] for change in changed}
    }
    # The full inventories dominate memory on production drawings. Everything
    # required for the same post-patch checks/report is compacted above before
    # reparsing, so source and output object graphs are never retained together.
    del inv, by_target, handle_rows, cell_geometry
    gc.collect()
    # Reparse is mandatory.  Structural comparison is implicit because only
    # value byte spans were substituted; retain an explicit segment proof.
    output_inv = inventory(result)
    if tuple(x["targetId"] for x in output_inv["textEntries"]) != source_target_ids:
        raise DxfRejected("post-patch entity structure changed")
    if source_metadata_sha256 != metadata_digest(output_inv["textEntries"]):
        raise DxfRejected("post-patch visible text metadata changed")
    if (source_placement_sha256 != output_inv["placementManifestSha256"]
            or source_placement_count != output_inv["placementCount"]):
        raise DxfRejected("post-patch placement manifest changed")
    unchanged_segments = []
    source_cursor = output_cursor = 0
    for start, end, value, target_id in approved_ranges:
        source_part = memoryview(source)[source_cursor:start]
        output_part = memoryview(result)[output_cursor:output_cursor + (start-source_cursor)]
        if source_part != output_part:
            raise DxfRejected("non-approved source bytes changed")
        unchanged_segments.append({"sourceRange": [source_cursor, start], "outputRange": [output_cursor, output_cursor + len(source_part)],
                                   "sha256": hashlib.sha256(source_part).hexdigest()})
        output_start = output_cursor + len(source_part)
        source_cursor, output_cursor = end, output_start + len(value)
    if memoryview(source)[source_cursor:] != memoryview(result)[output_cursor:]:
        raise DxfRejected("non-approved trailing bytes changed")
    unchanged_segments.append({"sourceRange": [source_cursor, len(source)], "outputRange": [output_cursor, len(result)],
                               "sha256": hashlib.sha256(source[source_cursor:]).hexdigest()})
    approved_changes = []
    for target_id in sorted({change["targetId"] for change in changed}):
        target_changes = sorted(
            (change for change in changed if change["targetId"] == target_id),
            key=lambda change: change["sourceRange"],
        )
        approved = {
            "targetId": target_id,
            "handle": target_changes[0]["handle"],
            "entityType": target_changes[0]["entityType"],
            "sourceRanges": [change["sourceRange"] for change in target_changes],
            "outputRanges": [change["outputRange"] for change in target_changes],
            "sourceSha256": hashlib.sha256(b"".join(
                source[change["sourceRange"][0]:change["sourceRange"][1]]
                for change in target_changes
            )).hexdigest(),
            "replacementSha256": hashlib.sha256(b"".join(
                result[change["outputRange"][0]:change["outputRange"][1]]
                for change in target_changes
            )).hexdigest(),
        }
        if len(target_changes) == 1:
            approved["sourceRange"] = target_changes[0]["sourceRange"]
            approved["outputRange"] = target_changes[0]["outputRange"]
        approved_changes.append(approved)
    changed_target_ids = set(changed_target_types)
    report = {"format": "dxf-surgical-patch-v1", "sourceSha256": hashlib.sha256(source).hexdigest(),
              "targetLanguage": target_language,
              "outputSha256": hashlib.sha256(result).hexdigest(), "approvedChanges": approved_changes,
              "changedValueRanges": [{"handle": x["handle"], "sourceRange": x["sourceRange"],
                                      "targetId": x["targetId"], "outputRange": x["outputRange"]}
                                      for x in sorted(changed, key=lambda x: (x["targetId"], x["sourceRange"]))],
              "accountedVisibleTextCount": source_text_count,
              "accountedMtextCount": source_mtext_count,
              "placementCount": source_placement_count,
              "placementManifestSha256": source_placement_sha256,
              "unchangedVisibleTextCount": source_text_count - len(changed_target_ids),
              "unchangedMtextCount": source_mtext_count
              - sum(changed_target_types[target_id] == "MTEXT"
                    for target_id in changed_target_ids),
              "unresolved": unresolved, "unchangedEntityPropertiesVerified": True,
              "metadataIdentical": True, "nonTextRecordsIdentical": True,
              "metadataValidationScope": "supported AC1032 record structural schema; no claim of full AutoCAD rendering semantics",
              "strictNativeInsertProfilePassed": True,
              "validationProfile": source_validation_profile,
              "allSectionsScanned": True, "sectionsScanned": source_sections,
              "supportedRecordStructuralSchemaValidated": True,
              "renderingSemanticsValidated": False,
              "reparsedCleanly": True, "lineEndingPreserved": source_line_ending == output_inv["lineEnding"],
              "nonApprovedSegmentsIdentical": True, "unchangedSegments": unchanged_segments}
    return result, report


def preview(data: bytes, translations_document: Any | None = None) -> str:
    """Render source; optional translations are blue overlays at the same anchors.

    The normal application path may instead preview the already-patched DXF,
    which needs no translation argument.
    """
    pairs = parse_pairs(data)
    sections, entities = _validate_structure(pairs)
    inv = inventory(data, _parsed=(pairs, sections, entities))
    requested_overlays = (
        _translations(translations_document)
        if translations_document is not None else {}
    )
    by_key = {item["targetId"].upper(): item for item in inv["textEntries"]}
    by_handle: dict[str, list[dict[str, Any]]] = {}
    for item in inv["textEntries"]:
        by_handle.setdefault(item["handle"], []).append(item)
    for handle, rows in by_handle.items():
        if len(rows) == 1:
            by_key[handle] = rows[0]
    unknown = set(requested_overlays) - set(by_key)
    if unknown:
        raise DxfRejected("preview references unknown handle " + sorted(unknown)[0])
    overlays = {
        by_key[key]["targetId"]: value
        for key, value in requested_overlays.items()
    }
    points = [
        (placement["x"], placement["y"])
        for item in inv["textEntries"]
        for placement in item.get("placements", [])
    ]
    polylines: list[list[tuple[float, float]]] = []
    for kind, records in entities:
        if kind == "LWPOLYLINE":
            vertices: list[tuple[float, float]] = []
            pending_x: float | None = None
            for record in records:
                if record.code == 10:
                    try:
                        pending_x = float(_text(record).strip())
                    except ValueError as exc:
                        raise DxfRejected("invalid LWPOLYLINE vertex") from exc
                elif record.code == 20 and pending_x is not None:
                    try:
                        vertices.append((pending_x, float(_text(record).strip())))
                    except ValueError as exc:
                        raise DxfRejected("invalid LWPOLYLINE vertex") from exc
                    pending_x = None
            if vertices:
                polylines.append(vertices)
                points += vertices
    if not points: points = [(0, 0), (1, 1)]
    minx, maxx = min(x for x, _ in points), max(x for x, _ in points)
    miny, maxy = min(y for _, y in points), max(y for _, y in points)
    scale = 960 / max(maxx-minx, maxy-miny, 1)
    def xy(x: float, y: float) -> tuple[float, float]: return ((x-minx)*scale+20, (maxy-y)*scale+20)
    body = []
    for vertices in polylines[:10000]:
        coords = " ".join(f"{x:.1f},{y:.1f}" for x, y in (xy(x, y) for x, y in vertices))
        body.append(f'<polyline points="{coords}" fill="none" stroke="#52606d" stroke-width="0.7"/>')
    for item in inv["textEntries"]:
        for placement_index, placement in enumerate(item.get("placements", [])):
            x, y = xy(placement["x"], placement["y"])
            body.append(
                f'<text data-handle="{item["handle"]}" data-target-id="{item["targetId"]}" '
                f'data-placement-index="{placement_index}" '
                f'x="{x:.1f}" y="{y:.1f}" font-size="10">{html.escape(item["plainText"][:240])}</text>'
            )
            if item["targetId"] in overlays:
                body.append(
                    f'<text data-overlay-for="{item["targetId"]}" data-placement-index="{placement_index}" '
                    f'x="{x:.1f}" y="{y+11:.1f}" font-size="10" fill="#075ea8">'
                    f'{html.escape(overlays[item["targetId"]][:240])}</text>'
                )
    return '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000" viewBox="0 0 1000 1000"><rect width="100%" height="100%" fill="white"/>' + "".join(body) + "</svg>"


def main(argv: list[str]) -> int:
    try:
        command = argv[1]
        if command == "inspect" and len(argv) == 4:
            Path(argv[3]).write_text(json.dumps(inventory(Path(argv[2]).read_bytes()), ensure_ascii=False, indent=2), encoding="utf-8")
        elif command == "patch" and len(argv) == 6:
            output, report = patch(Path(argv[2]).read_bytes(), json.loads(Path(argv[3]).read_text(encoding="utf-8")))
            output_path, report_path = Path(argv[4]), Path(argv[5])
            output_staged = output_path.with_name(output_path.name + ".staged")
            report_staged = report_path.with_name(report_path.name + ".staged")
            try:
                output_staged.write_bytes(output)
                report_staged.write_text(
                    json.dumps(report, ensure_ascii=False, indent=2),
                    encoding="utf-8",
                )
                os.replace(report_staged, report_path)
                os.replace(output_staged, output_path)
            except OSError:
                output_path.unlink(missing_ok=True)
                report_path.unlink(missing_ok=True)
                raise
            finally:
                output_staged.unlink(missing_ok=True)
                report_staged.unlink(missing_ok=True)
        elif command == "preview" and len(argv) in (4, 5):
            translations = json.loads(Path(argv[4]).read_text(encoding="utf-8")) if len(argv) == 5 else None
            Path(argv[3]).write_text(preview(Path(argv[2]).read_bytes(), translations), encoding="utf-8")
        else:
            raise DxfRejected("usage: inspect IN OUT_JSON | patch IN TRANSLATIONS_JSON OUT_DXF OUT_REPORT_JSON | preview IN OUT_SVG [TRANSLATIONS_JSON]")
        return 0
    except (OSError, json.JSONDecodeError, DxfRejected) as exc:
        message = str(exc)
        if message.startswith("post-patch "):
            reason = "post_patch_preservation_invariant"
        elif isinstance(exc, json.JSONDecodeError):
            reason = "invalid_translation_document"
        elif isinstance(exc, OSError):
            reason = "processor_io_failure"
        else:
            reason = "document_rejected"
        # Keep the upload validator's legacy marker, but expose only the
        # bounded category rather than source text, handles, or file paths.
        print(f"DXF_REJECTED: {reason}", file=sys.stderr)
        print(json.dumps({
            "kind": "native_dxf_rejected",
            "reason": reason,
        }), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
