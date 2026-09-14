#!/usr/bin/env python3
"""Position-aware PDF extraction, overlay, per-page render, and merge helpers.

The Node worker owns translation and durable state. This helper only performs
deterministic PDF/image operations with PyMuPDF so source vector pages remain
intact and no document content leaves the job workspace except through the
explicit JSON files supplied by the worker.

Commands:
  extract  IN_PDF OUT_JSON [SOURCE_LANGUAGE]
      Extract positioned text blocks from every page.
  overlay  IN_PDF TRANSLATIONS_JSON OUT_PDF THUMB_DIR
      Legacy whole-document overlay + thumbnails (kept for compatibility).
  render   IN_PDF TRANSLATIONS_JSON PAGE_NUMBER OUT_PDF THUMB_JPG OUT_JSON
      Render exactly one requested page to a one-page PDF fragment plus a JPEG
      thumbnail, writing per-page metadata JSON. Restart-safe: rendering one
      page never depends on any other page's fragment.
  crop     IN_PDF PAGE_NUMBER X0 Y0 X1 Y1 OUT_JPG
      Render one bounded, high-resolution private crop for visual recovery of
      a line whose embedded font mapping cannot be read reliably.
  thumbnail IN_PDF PAGE_NUMBER OUT_JPG
       Render one original source page for private side-by-side human review.
  merge    OUT_PDF FRAGMENT_1 FRAGMENT_2 ...
      Combine an explicit ordered list of one-page PDF fragments into one PDF
      using PyMuPDF insert_pdf (vector-preserving, no rasterization).
"""
from __future__ import annotations

import json
import math
import os
import resource
import re
import subprocess
import sys
import tempfile
import traceback
from collections import defaultdict, deque
from pathlib import Path

import fitz


MAX_PAGES = 150
MAX_BLOCKS = 12000
MAX_PAGE_PIXELS = 24_000_000
THUMB_DPI = 110
RECOVERY_DPI = 300
MAX_RECOVERY_CROP_PIXELS = 3_000_000
MAX_RECOVERY_CROP_EDGE = 4_096
MAX_RECOVERY_CROP_BYTES = 4 * 1024 * 1024
STRIP_AUDIT_DPI = 110
MAX_STRIP_AUDITS_PER_PAGE = 6
MAX_STRIP_AUDITS_PER_JOB = 80
MAX_RASTER_STRIP_REGIONS_PER_PAGE = 8
MAX_RASTER_STRIP_AUDIT_FRACTION = 0.25
MAX_RASTER_STRIP_DISCLOSURE_FRACTION = 0.125
JAPANESE_FONT = str(Path(__file__).resolve().parents[1] / "assets" / "fonts" / "NotoSansJP-Regular.ttf")


def target_font(target_language: str) -> tuple[str, str | None]:
    if target_language == "ja":
        if not Path(JAPANESE_FONT).is_file():
            raise DocumentRejected("japanese_font_missing", "Bundled Japanese font is unavailable")
        return "cworksjp", JAPANESE_FONT
    return "helv", None


class DocumentRejected(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def constrain_process(mode: str) -> None:
    """Bound hostile/degenerate PDF work inside the dedicated child process."""
    try:
        # Keep the overlay/render CPU ceiling slightly above the Node wall-clock
        # limit so Node records a classified timeout first, while still bounding
        # the child if the wrapper fails to terminate it. Merge is cheap.
        if mode == "extract":
            cpu_limit = (1080, 1140)
        elif mode == "merge":
            cpu_limit = (600, 660)
        else:
            cpu_limit = (3900, 3960)
        resource.setrlimit(resource.RLIMIT_CPU, cpu_limit)
        resource.setrlimit(resource.RLIMIT_AS, (1536 * 1024 * 1024, 1536 * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_FSIZE, (512 * 1024 * 1024, 512 * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
    except (ValueError, OSError):
        pass


def atomic_write_bytes(path: str, data: bytes) -> None:
    """Write bytes to a local path atomically via a temp file + rename."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(target.parent), prefix=".tmp-", suffix=target.suffix)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            try:
                os.unlink(tmp)
            except OSError:
                pass


def atomic_write_text(path: str, text: str) -> None:
    atomic_write_bytes(path, text.encode("utf-8"))


def validate_doc(doc: fitz.Document) -> None:
    if doc.needs_pass:
        raise DocumentRejected("password_protected", "Password-protected PDFs are not supported")
    if doc.page_count > MAX_PAGES:
        raise DocumentRejected("too_many_pages", f"PDF has {doc.page_count} pages; maximum is {MAX_PAGES}")
    if doc.xref_length() > 250_000:
        raise DocumentRejected(
            "too_many_objects",
            "PDF contains too many internal objects; split or optimise it before translation",
        )
    for page in doc:
        pixels = (page.rect.width * THUMB_DPI / 72) * (page.rect.height * THUMB_DPI / 72)
        if pixels > MAX_PAGE_PIXELS:
            raise DocumentRejected(
                "page_too_large",
                f"Page {page.number + 1} is too large to render safely",
            )


def is_suspicious_text(text: str) -> bool:
    stripped = text.strip()
    if not stripped:
        return False
    placeholder_glyphs = {"?", "\ufffd", "\u00b7", "\u2022", "\u25a1", "\u25a0", "\u25ca"}
    unknown = sum(1 for char in stripped if char in placeholder_glyphs)
    private_or_control = sum(
        1 for char in stripped
        if 0xE000 <= ord(char) <= 0xF8FF or 0x80 <= ord(char) <= 0x9F
    )
    # A single literal question mark or bullet is normal punctuation. Repeated
    # placeholders, private-use glyphs, or a mostly-unknown run indicate a
    # broken embedded Unicode font map.
    return (
        private_or_control > 0
        or (
            unknown >= 2
            and (
                unknown / max(len(stripped), 1) >= 0.35
                or any(glyph * 2 in stripped for glyph in placeholder_glyphs)
            )
        )
    )


def raster_title_zone(page: fitz.Page) -> fitz.Rect:
    zone_width = min(page.rect.width * 0.70, 892.0)
    zone_height = min(page.rect.height * 0.20, 172.0)
    return fitz.Rect(
        (page.rect.width - zone_width) / 2,
        0,
        (page.rect.width + zone_width) / 2,
        zone_height,
    )


def embedded_image_rects(page: fitz.Page) -> list[fitz.Rect]:
    rects: list[fitz.Rect] = []
    seen: set[tuple[float, float, float, float]] = set()
    for image in page.get_images(full=True):
        try:
            placements = page.get_image_rects(image[0])
        except Exception:
            continue
        for placement in placements:
            rect = placement & page.rect
            key = tuple(round(value, 2) for value in rect)
            if rect.is_empty or key in seen:
                continue
            seen.add(key)
            rects.append(rect)
    return rects


def raster_title_regions(
    page: fitz.Page,
    page_number: int,
    image_rects: list[fitz.Rect],
) -> list[dict]:
    """Return one bounded title-zone crop for hybrid raster/vector CAD pages.

    Some CAD exporters store large headings in horizontal raster strips while
    leaving the rest of the PDF selectable and vector-based. This is not a
    general scanned-document OCR path: it is a single, top-center zone covering
    14% of the page and is emitted only when embedded raster content intersects
    enough of that zone.
    """
    # crop_for_recovery adds four points of context on each side. Keep the
    # requested box eight points inside the public limit so the provider-bound
    # image, not merely the extracted candidate, is at most 900 x 180 points.
    zone = raster_title_zone(page)
    if zone.get_area() <= 0 or zone.get_area() > page.rect.get_area() * 0.25:
        return []
    raster_overlap = 0.0
    for image_rect in image_rects:
        raster_overlap += (zone & image_rect).get_area()
    if raster_overlap < zone.get_area() * 0.20:
        return []
    return [{
        "id": f"p{page_number}-raster-title",
        "bbox": [zone.x0, zone.y0, zone.x1, zone.y1],
        "kind": "raster-title",
    }]


def is_likely_source_language_note(text: str) -> bool:
    """Conservatively identify human-language prose in local strip-audit OCR."""
    value = re.sub(r"\s+", " ", text).strip()
    letters = [char for char in value if char.isalpha()]
    if len(letters) < 2:
        return False
    if re.match(
        r"^(?:ГОСТ|СП|СНиП|ТУ|ISO|EN|BS|DIN|ASTM|JIS|GB|NF|AS/NZS)"
        r"(?:\s|[-–—./]|\d)",
        value,
        re.IGNORECASE,
    ):
        return False
    if re.fullmatch(
        r"[\d\s.,x×+±\-–—/]+\s*"
        r"(?:mm|cm|m|m²|m2|pcs?|kg|%|мм|см|м|м²|м2|шт|кг)\.?",
        value,
        re.IGNORECASE,
    ):
        return False
    if " " not in value and re.fullmatch(r"[\w\-–—./]+", value, re.UNICODE) and re.search(r"\d", value):
        return False
    if re.fullmatch(r"[^\W\d_]{1,4}[-–—./]?\d[\w\-–—./]*", value, re.UNICODE):
        return False
    return True


def tesseract_languages(source_language: str) -> str:
    configured = {
        "ru": "rus+eng",
        "ja": "jpn+jpn_vert+eng",
        "zh": "chi_sim+chi_sim_vert+chi_tra+chi_tra_vert+eng",
        "ko": "kor+kor_vert+eng",
        "de": "deu+eng",
        "fr": "fra+eng",
        "es": "spa+eng",
        "ar": "ara+eng",
        "he": "heb+eng",
    }
    if source_language in configured:
        return configured[source_language]
    # Auto mode is normally refined by the OSD script pass below. Cyrillic plus
    # English is a pragmatic fallback when a very short strip lacks enough
    # characters for script detection.
    return "rus+eng"


def tesseract_languages_for_image(source_language: str, image: bytes) -> str:
    if source_language != "auto" and source_language != "other":
        return tesseract_languages(source_language)
    try:
        detected = subprocess.run(
            ["tesseract", "stdin", "stdout", "-l", "osd", "--psm", "0"],
            input=image,
            capture_output=True,
            timeout=5,
            check=False,
        )
        report = (
            detected.stdout.decode("utf-8", errors="replace")
            + "\n"
            + detected.stderr.decode("utf-8", errors="replace")
        )
        match = re.search(r"Script:\s*([A-Za-z_]+)", report, re.IGNORECASE)
        script = match.group(1).lower() if match else ""
        script_languages = {
            "cyrillic": "rus+ukr+eng",
            "han": "chi_sim+chi_tra+eng",
            "japanese": "jpn+jpn_vert+eng",
            "hangul": "kor+kor_vert+eng",
            "korean": "kor+kor_vert+eng",
            "arabic": "ara+fas+eng",
            "hebrew": "heb+eng",
            "devanagari": "hin+eng",
            "latin": "eng+deu+fra+spa",
        }
        if script in script_languages:
            return script_languages[script]
    except (OSError, subprocess.SubprocessError):
        pass
    return tesseract_languages("auto")


def overlap_fraction(candidate: fitz.Rect, other: fitz.Rect) -> float:
    return (candidate & other).get_area() / max(candidate.get_area(), 1.0)


def meaningfully_overlaps(candidate: fitz.Rect, other: fitz.Rect) -> bool:
    return (
        overlap_fraction(candidate, other) >= 0.20
        or overlap_fraction(other, candidate) >= 0.20
    )


def bounded_recovery_rect(rect: fitz.Rect, page: fitz.Page) -> bool:
    expanded = (rect + (-4, -4, 4, 4)) & page.rect
    if expanded.is_empty or expanded.get_area() > page.rect.get_area() * 0.25:
        return False
    scale = RECOVERY_DPI / 72
    width = int(expanded.width * scale + 0.5)
    height = int(expanded.height * scale + 0.5)
    return (
        width <= MAX_RECOVERY_CROP_EDGE
        and height <= MAX_RECOVERY_CROP_EDGE
        and width * height <= MAX_RECOVERY_CROP_PIXELS
    )


def audit_raster_strip(
    page: fitz.Page,
    strip: fitz.Rect,
    selectable_boxes: list[fitz.Rect],
    source_language: str = "auto",
) -> list[fitz.Rect]:
    """Use local OCR only as a bounded rendered-region audit, never as source wording."""
    scale = STRIP_AUDIT_DPI / 72
    pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), clip=strip, alpha=False)
    encoded = pix.tobytes(output="png")
    try:
        result = subprocess.run(
            [
                "tesseract", "stdin", "stdout", "-l",
                tesseract_languages_for_image(source_language, encoded),
                "--psm", "11", "tsv",
            ],
            input=encoded,
            capture_output=True,
            timeout=12,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    if result.returncode != 0:
        return []

    grouped: dict[tuple[str, str, str, str], list[dict]] = defaultdict(list)
    lines = result.stdout.decode("utf-8", errors="replace").splitlines()
    if not lines:
        return []
    header = lines[0].split("\t")
    for raw_line in lines[1:]:
        values = raw_line.split("\t")
        if len(values) != len(header):
            continue
        row = dict(zip(header, values))
        text = row.get("text", "").strip()
        try:
            confidence = float(row.get("conf", "-1"))
            left = int(row.get("left", "0"))
            top = int(row.get("top", "0"))
            width = int(row.get("width", "0"))
            height = int(row.get("height", "0"))
        except ValueError:
            continue
        if not text or confidence < 35 or width <= 0 or height <= 0:
            continue
        key = (
            row.get("page_num", "0"),
            row.get("block_num", "0"),
            row.get("par_num", "0"),
            row.get("line_num", "0"),
        )
        grouped[key].append({
            "text": text,
            "left": left,
            "top": top,
            "right": left + width,
            "bottom": top + height,
        })

    regions: list[fitz.Rect] = []
    for words in grouped.values():
        audit_text = " ".join(str(word["text"]) for word in words)
        if not is_likely_source_language_note(audit_text):
            continue
        x0 = min(int(word["left"]) for word in words)
        y0 = min(int(word["top"]) for word in words)
        x1 = max(int(word["right"]) for word in words)
        y1 = max(int(word["bottom"]) for word in words)
        candidate = fitz.Rect(
            strip.x0 + (x0 / max(pix.width, 1)) * strip.width,
            strip.y0 + (y0 / max(pix.height, 1)) * strip.height,
            strip.x0 + (x1 / max(pix.width, 1)) * strip.width,
            strip.y0 + (y1 / max(pix.height, 1)) * strip.height,
        )
        candidate = (candidate + (-2, -2, 2, 2)) & strip & page.rect
        if (
            candidate.is_empty
            or not bounded_recovery_rect(candidate, page)
            or any(meaningfully_overlaps(candidate, box) for box in selectable_boxes)
        ):
            continue
        if any(overlap_fraction(candidate, prior) >= 0.75 for prior in regions):
            continue
        regions.append(candidate)
    return regions


def raster_strip_regions(
    page: fitz.Page,
    page_number: int,
    image_rects: list[fitz.Rect],
    page_blocks: list[dict],
    audit_budget: int,
    source_language: str = "auto",
) -> tuple[list[dict], int]:
    """Audit bounded non-title image regions on otherwise selectable CAD pages."""
    if not page_blocks or audit_budget <= 0:
        return [], 0
    selectable_chars = sum(
        len(re.sub(r"\s+", "", str(block.get("text", ""))))
        for block in page_blocks
        if not block.get("suspicious")
    )
    # A token text layer on an otherwise scanned/tiled page must not turn this
    # exception into general OCR. Real hybrid CAD pages retain either multiple
    # selectable labels or vector linework in addition to the raster strips.
    if selectable_chars < 12 or (len(page_blocks) < 2 and not page.get_drawings()):
        return [], 0
    title_zone = raster_title_zone(page)
    selectable_boxes = [fitz.Rect(block["bbox"]) for block in page_blocks]
    candidates = [
        rect for rect in image_rects
        if overlap_fraction(rect, title_zone) < 0.20
        and rect.width >= 12
        and rect.height >= 12
        and rect.get_area() >= page.rect.get_area() * 0.001
        and rect.get_area() <= page.rect.get_area() * 0.25
    ]
    # Small legend and margin-note regions get audited before broad exporter
    # strips, preserving the aggregate local-OCR area cap for the most targeted
    # candidates.
    candidates.sort(key=lambda rect: (rect.get_area(), rect.y0, rect.x0))
    regions: list[dict] = []
    audits_used = 0
    audited_area = 0.0
    audit_area_limit = page.rect.get_area() * MAX_RASTER_STRIP_AUDIT_FRACTION
    disclosed_area = 0.0
    disclosure_limit = page.rect.get_area() * MAX_RASTER_STRIP_DISCLOSURE_FRACTION
    for strip in candidates[:min(MAX_STRIP_AUDITS_PER_PAGE, audit_budget)]:
        if audited_area + strip.get_area() > audit_area_limit:
            continue
        audited_area += strip.get_area()
        audits_used += 1
        for candidate in audit_raster_strip(page, strip, selectable_boxes, source_language):
            expanded_area = ((candidate + (-4, -4, 4, 4)) & page.rect).get_area()
            if disclosed_area + expanded_area > disclosure_limit:
                continue
            disclosed_area += expanded_area
            kind = (
                "raster-strip"
                if strip.width >= page.rect.width * 0.25
                and strip.width / max(strip.height, 1.0) >= 3.0
                else "raster-region"
            )
            regions.append({
                "id": f"p{page_number}-{kind}-{len(regions)}",
                "bbox": [candidate.x0, candidate.y0, candidate.x1, candidate.y1],
                "kind": kind,
            })
            if len(regions) >= MAX_RASTER_STRIP_REGIONS_PER_PAGE:
                return regions, audits_used
    return regions, audits_used


def _line_text_segments(line: dict) -> list[dict]:
    """Split one PDF line into geometry-backed text runs.

    Some CAD exporters encode independent table cells as one span separated by
    long whitespace runs, or as offset spans with no textual separator. Using
    the union of that whole line creates a page-wide replacement rectangle.
    Raw character boxes let us retain ordinary single spaces while separating
    visually independent cells and trimming invisible leading padding.
    """
    entries: list[tuple[str, dict, dict, int]] = []
    for span_index, span in enumerate(line.get("spans", [])):
        for char in span.get("chars", []):
            value = str(char.get("c", ""))
            if value:
                entries.append((value, char, span, span_index))
    if not entries:
        spans = [s for s in line.get("spans", []) if str(s.get("text", "")).strip()]
        if not spans:
            return []
        return [{
            "text": "".join(str(s.get("text", "")) for s in spans).strip(),
            "bbox": [
                min(float(s["bbox"][0]) for s in spans),
                min(float(s["bbox"][1]) for s in spans),
                max(float(s["bbox"][2]) for s in spans),
                max(float(s["bbox"][3]) for s in spans),
            ],
            "fontSize": max(float(s.get("size", 8)) for s in spans),
            "color": int(spans[0].get("color", 0)),
        }]

    segments: list[dict] = []
    current: list[tuple[str, dict, dict, int]] = []
    pending_spaces: list[tuple[str, dict, dict, int]] = []
    previous_nonspace: tuple[str, dict, dict, int] | None = None

    def flush() -> None:
        nonlocal current
        visible = [entry for entry in current if not entry[0].isspace()]
        if not visible:
            current = []
            return
        text = re.sub(r"\s+", " ", "".join(entry[0] for entry in current)).strip()
        if not text:
            current = []
            return
        rects = [fitz.Rect(entry[1]["bbox"]) for entry in visible]
        segments.append({
            "text": text,
            "bbox": [
                min(rect.x0 for rect in rects),
                min(rect.y0 for rect in rects),
                max(rect.x1 for rect in rects),
                max(rect.y1 for rect in rects),
            ],
            "fontSize": max(float(entry[2].get("size", 8)) for entry in visible),
            "color": int(visible[0][2].get("color", 0)),
        })
        current = []

    for entry in entries:
        value, char, span, span_index = entry
        if value.isspace():
            if current:
                pending_spaces.append(entry)
            continue

        split_here = len(pending_spaces) >= 2
        if previous_nonspace is not None and len(pending_spaces) < 2:
            previous_rect = fitz.Rect(previous_nonspace[1]["bbox"])
            current_rect = fitz.Rect(char["bbox"])
            font_size = max(
                float(previous_nonspace[2].get("size", 8)),
                float(span.get("size", 8)),
                1.0,
            )
            axis_gap = current_rect.x0 - previous_rect.x1
            center_delta = abs(
                (current_rect.y0 + current_rect.y1) / 2
                - (previous_rect.y0 + previous_rect.y1) / 2
            )
            split_here = (
                previous_nonspace[3] != span_index
                and (
                    axis_gap > max(3.0, font_size * 0.45)
                    or center_delta > max(2.0, font_size * 0.30)
                )
            )
        if split_here:
            flush()
        elif current and pending_spaces:
            current.append(pending_spaces[0])
        pending_spaces = []
        current.append(entry)
        previous_nonspace = entry
    flush()
    return segments


def extract(input_pdf: str, output_json: str, source_language: str = "auto") -> None:
    doc = fitz.open(input_pdf)
    validate_doc(doc)
    pages: list[dict] = []
    total_blocks = 0
    remaining_strip_audits = MAX_STRIP_AUDITS_PER_JOB
    for page_index, page in enumerate(doc):
        page_blocks: list[dict] = []
        raw = page.get_text("rawdict", flags=fitz.TEXTFLAGS_TEXT)
        line_index = 0
        for block_index, block in enumerate(raw.get("blocks", [])):
            if block.get("type") != 0:
                continue
            paragraph_id = f"p{page_index + 1}-b{block_index}"
            for line in block.get("lines", []):
                segments = _line_text_segments(line)
                for segment_index, segment in enumerate(segments):
                    text = segment["text"]
                    block_id = f"p{page_index + 1}-l{line_index}"
                    if segment_index:
                        block_id += f"-s{segment_index}"
                    page_blocks.append({
                        "id": block_id,
                        "paragraphId": paragraph_id,
                        "text": text,
                        "bbox": segment["bbox"],
                        "fontSize": round(float(segment["fontSize"]), 2),
                        "direction": line.get("dir", [1, 0]),
                        "color": int(segment["color"]),
                        "suspicious": is_suspicious_text(text),
                    })
                    total_blocks += 1
                    if total_blocks > MAX_BLOCKS:
                        raise DocumentRejected(
                            "too_many_text_lines",
                            f"PDF contains more than {MAX_BLOCKS} text lines; split it into smaller sets",
                        )
                if segments:
                    line_index += 1
        assign_layout_groups(page_blocks, page_index + 1)
        image_rects = embedded_image_rects(page)
        strip_regions, audits_used = raster_strip_regions(
            page,
            page_index + 1,
            image_rects,
            page_blocks,
            remaining_strip_audits,
            source_language,
        )
        remaining_strip_audits -= audits_used
        pages.append({
            "pageNumber": page_index + 1,
            "width": float(page.rect.width),
            "height": float(page.rect.height),
            "blocks": page_blocks,
            "visualRecoveryRegions": (
                raster_title_regions(page, page_index + 1, image_rects)
                + strip_regions
            ),
        })
    atomic_write_text(output_json, json.dumps({"pageCount": doc.page_count, "pages": pages}, ensure_ascii=False))
    doc.close()
    print(json.dumps({"pageCount": len(pages), "blockCount": total_blocks}))


def _rect_grid_keys(rect: fitz.Rect, cell: float = 48.0):
    x0, y0 = int(rect.x0 // cell), int(rect.y0 // cell)
    x1, y1 = int(rect.x1 // cell), int(rect.y1 // cell)
    for i in range(x0, x1 + 1):
        for j in range(y0, y1 + 1):
            yield (i, j)


def _layout_blocks_are_adjacent(first: dict, second: dict) -> bool:
    first_rotation = cardinal_rotation(first.get("direction", [1, 0]))
    second_rotation = cardinal_rotation(second.get("direction", [1, 0]))
    if first_rotation is None or first_rotation != second_rotation:
        return False
    # Cross-block grouping is deliberately limited to ordinary horizontal text.
    # Vertical and arbitrary-angle labels retain independent placement semantics.
    if first_rotation not in (0, 180):
        return False
    if bool(first.get("rasterBacked")) != bool(second.get("rasterBacked")):
        return False
    if int(first.get("color", 0)) != int(second.get("color", 0)):
        return False
    first_size = max(float(first.get("fontSize", 8)), 1.0)
    second_size = max(float(second.get("fontSize", 8)), 1.0)
    if max(first_size, second_size) / min(first_size, second_size) > 1.35:
        return False
    first_rect = fitz.Rect(first["bbox"])
    second_rect = fitz.Rect(second["bbox"])
    upper, lower = (
        (first_rect, second_rect)
        if first_rect.y0 <= second_rect.y0
        else (second_rect, first_rect)
    )
    center_delta = abs(
        (first_rect.y0 + first_rect.y1) / 2
        - (second_rect.y0 + second_rect.y1) / 2
    )
    if center_delta < min(first_rect.height, second_rect.height) * 0.35:
        return False
    font_size = max(first_size, second_size)
    vertical_gap = lower.y0 - upper.y1
    if vertical_gap < -font_size * 0.40 or vertical_gap > max(4.0, font_size * 0.80):
        return False
    horizontal_overlap = max(
        0.0,
        min(first_rect.x1, second_rect.x1) - max(first_rect.x0, second_rect.x0),
    )
    aligned = (
        abs(first_rect.x0 - second_rect.x0) <= max(2.5, font_size * 0.40)
        or horizontal_overlap >= min(first_rect.width, second_rect.width) * 0.75
    )
    if not aligned:
        return False
    same_paragraph = (
        first.get("paragraphId") is not None
        and first.get("paragraphId") == second.get("paragraphId")
    )
    if same_paragraph:
        return True
    upper_item = first if first_rect.y0 <= second_rect.y0 else second
    upper_text = str(upper_item.get("text", "")).rstrip()
    # Across separate PDF blocks, require explicit continuation evidence. This
    # captures hyphenated schedule headers and punctuation-led note continuations
    # without merging ordinary adjacent table rows in the same column.
    return upper_text.endswith(("-", ":", ";", ","))


def assign_layout_groups(blocks: list[dict], page_number: int) -> None:
    """Attach conservative visual-group ids without quadratic page scans."""
    if not blocks:
        return
    parents = list(range(len(blocks)))
    members: dict[int, set[int]] = {index: {index} for index in range(len(blocks))}

    def find(index: int) -> int:
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    def union(left: int, right: int) -> None:
        left_root, right_root = find(left), find(right)
        if left_root == right_root:
            return
        combined = members[left_root] | members[right_root]
        if len(combined) > 12:
            return
        rects = [fitz.Rect(blocks[index]["bbox"]) for index in combined]
        font_size = max(float(blocks[index].get("fontSize", 8)) for index in combined)
        if max(rect.y1 for rect in rects) - min(rect.y0 for rect in rects) > max(48.0, font_size * 14):
            return
        parents[right_root] = left_root
        members[left_root] = combined
        members.pop(right_root, None)

    # A bounded sweep keeps grouping O(n), even when thousands of malformed
    # blocks occupy the same tiny title-cell region.
    buckets: dict[tuple[int, int, int, int, int], deque[int]] = defaultdict(
        lambda: deque(maxlen=16),
    )
    ordered_indices = sorted(
        range(len(blocks)),
        key=lambda index: (
            float(blocks[index]["bbox"][1]),
            float(blocks[index]["bbox"][0]),
        ),
    )
    for index in ordered_indices:
        block = blocks[index]
        font_size = max(float(block.get("fontSize", 8)), 1.0)
        rect = fitz.Rect(block["bbox"])
        rotation = cardinal_rotation(block.get("direction", [1, 0]))
        color = int(block.get("color", 0))
        raster = int(bool(block.get("rasterBacked")))
        font_band = int(font_size // 2)
        x_band = int(rect.x0 // 12)
        nearby: set[int] = set()
        for nearby_font_band in range(max(0, font_band - 3), font_band + 4):
            for nearby_x_band in range(x_band - 2, x_band + 3):
                key = (rotation if rotation is not None else -1, color, raster, nearby_font_band, nearby_x_band)
                nearby.update(buckets.get(key, ()))
        for other_index in nearby:
            if _layout_blocks_are_adjacent(block, blocks[other_index]):
                union(index, other_index)
        key = (rotation if rotation is not None else -1, color, raster, font_band, x_band)
        buckets[key].append(index)

    roots: dict[int, list[int]] = defaultdict(list)
    for index in range(len(blocks)):
        roots[find(index)].append(index)
    placement_groups = sorted(
        roots.values(),
        key=lambda members: min(
            (float(blocks[index]["bbox"][1]), float(blocks[index]["bbox"][0]))
            for index in members
        ),
    )
    final_groups: list[tuple[list[int], bool]] = []
    for placement_index, placement_members in enumerate(placement_groups):
        placement_group_id = f"p{page_number}-pg{placement_index}"
        for index in placement_members:
            blocks[index]["placementGroupId"] = placement_group_id
        ordered_members = sorted(
            placement_members,
            key=lambda index: (
                float(blocks[index]["bbox"][1]),
                float(blocks[index]["bbox"][0]),
            ),
        )
        compact_parent = {index: index for index in ordered_members}

        def compact_find(index: int) -> int:
            while compact_parent[index] != index:
                compact_parent[index] = compact_parent[compact_parent[index]]
                index = compact_parent[index]
            return index

        def compact_union(left: int, right: int) -> None:
            left_root, right_root = compact_find(left), compact_find(right)
            if left_root != right_root:
                compact_parent[right_root] = left_root

        for upper_index, lower_index in zip(ordered_members, ordered_members[1:]):
            upper_text = str(blocks[upper_index].get("text", "")).rstrip()
            if (
                upper_text.endswith("-")
                and _layout_blocks_are_adjacent(blocks[upper_index], blocks[lower_index])
            ):
                compact_union(upper_index, lower_index)

        compact_components: dict[int, list[int]] = defaultdict(list)
        for index in ordered_members:
            compact_components[compact_find(index)].append(index)
        compact_groups = [
            members for members in compact_components.values()
            if len(members) > 1
        ]
        compact_members = {
            index for members in compact_groups for index in members
        }
        final_groups.extend((members, True) for members in compact_groups)
        remaining = [
            index for index in ordered_members
            if index not in compact_members
        ]
        if remaining:
            final_groups.append((remaining, False))

    final_groups.sort(key=lambda group: min(
        (float(blocks[index]["bbox"][1]), float(blocks[index]["bbox"][0]))
        for index in group[0]
    ))
    for group_index, (members, compact) in enumerate(final_groups):
        group_id = f"p{page_number}-g{group_index}"
        for index in members:
            blocks[index]["layoutGroupId"] = group_id
            blocks[index]["layoutGroupCompact"] = compact
            blocks[index]["compactGroupId"] = group_id if compact else None
            blocks[index]["compactGroupCompact"] = compact


def overlaps_other(candidate: fitz.Rect, item: dict, obstacles: list[dict]) -> bool:
    own_id = str(item["id"])
    paragraph_id = item.get("paragraphId")
    placement_group_id = (
        item.get("placementGroupId")
        or item.get("layoutGroupId")
    )
    for other in obstacles:
        if str(other.get("id")) == own_id:
            continue
        intersection = candidate & fitz.Rect(other["bbox"])
        if intersection.is_empty or intersection.get_area() <= 1:
            continue
        # PDF font metrics can make consecutive lines in one text block overlap
        # by a fraction of a point. Permit only that thin shared edge; a deeper
        # intersection still blocks placement even within the same paragraph.
        same_paragraph = (
            paragraph_id is not None
            and paragraph_id == other.get("paragraphId")
        )
        same_placement_group = (
            placement_group_id is not None
            and placement_group_id == (
                other.get("placementGroupId")
                or other.get("layoutGroupId")
            )
        )
        planned_neighbor = str(other.get("id", "")).startswith("planned-")
        source_rect = fitz.Rect(item["bbox"])
        other_rect = fitz.Rect(other["bbox"])
        source_intersection = source_rect & other_rect
        replacement_metric_overlap = (
            bool(other.get("replacementTarget"))
            and not source_intersection.is_empty
            and intersection.x0 >= source_intersection.x0 - 0.01
            and intersection.y0 >= source_intersection.y0 - 0.01
            and intersection.x1 <= source_intersection.x1 + 0.01
            and intersection.y1 <= source_intersection.y1 + 0.01
            and min(intersection.width, intersection.height)
            <= max(0.75, min(candidate.height, other_rect.height) * 0.20)
        )
        overlap_tolerance = (
            max(
                0.75,
                min(candidate.height, fitz.Rect(other["bbox"]).height) * 0.32,
            )
            if planned_neighbor and same_placement_group
            else 0.75
        )
        negligible_paragraph_overlap = (
            (same_paragraph or same_placement_group)
            and min(intersection.width, intersection.height) <= overlap_tolerance
        )
        if not negligible_paragraph_overlap and not replacement_metric_overlap:
            return True
    return False


def linework_boxes(page: fitz.Page) -> list[fitz.Rect]:
    boxes: list[fitz.Rect] = []
    for drawing in page.get_drawings():
        clearance = max(0.75, float(drawing.get("width") or 0) / 2 + 0.25)
        for part in drawing.get("items", []):
            kind = part[0]
            if kind == "l":
                r = fitz.Rect(part[1], part[2])
                boxes.append(fitz.Rect(r.x0 - clearance, r.y0 - clearance, r.x1 + clearance, r.y1 + clearance))
            elif kind == "re":
                r = fitz.Rect(part[1])
                boxes.extend([
                    fitz.Rect(r.x0 - clearance, r.y0 - clearance, r.x1 + clearance, r.y0 + clearance),
                    fitz.Rect(r.x0 - clearance, r.y1 - clearance, r.x1 + clearance, r.y1 + clearance),
                    fitz.Rect(r.x0 - clearance, r.y0, r.x0 + clearance, r.y1),
                    fitz.Rect(r.x1 - clearance, r.y0, r.x1 + clearance, r.y1),
                ])
            elif kind == "c":
                points = [p for p in part[1:] if isinstance(p, fitz.Point)]
                if points:
                    boxes.append(fitz.Rect(
                        min(p.x for p in points) - clearance,
                        min(p.y for p in points) - clearance,
                        max(p.x for p in points) + clearance,
                        max(p.y for p in points) + clearance,
                    ))
            elif kind == "qu":
                quad = part[1]
                for start, end in (
                    (quad.ul, quad.ur),
                    (quad.ur, quad.lr),
                    (quad.lr, quad.ll),
                    (quad.ll, quad.ul),
                ):
                    r = fitz.Rect(start, end)
                    boxes.append(fitz.Rect(
                        r.x0 - clearance,
                        r.y0 - clearance,
                        r.x1 + clearance,
                        r.y1 + clearance,
                    ))
    return boxes


class LineworkIndex:
    """Spatial grid over linework boxes.

    Dense CAD sheets can carry hundreds of thousands of segments; scanning the
    full list for every candidate rectangle made single pages take longer than
    the render timeout. Bucketing boxes into a coarse grid keeps each lookup
    limited to nearby segments.
    """

    def __init__(self, boxes: list[fitz.Rect], cell: float = 48.0) -> None:
        self.boxes = boxes
        self.cell = cell
        self.grid: dict[tuple[int, int], list[int]] = {}
        for idx, box in enumerate(boxes):
            for key in self._keys(box):
                self.grid.setdefault(key, []).append(idx)

    def _keys(self, rect: fitz.Rect):
        cell = self.cell
        x0, y0 = int(rect.x0 // cell), int(rect.y0 // cell)
        x1, y1 = int(rect.x1 // cell), int(rect.y1 // cell)
        for i in range(x0, x1 + 1):
            for j in range(y0, y1 + 1):
                yield (i, j)

    def intersects(self, candidate: fitz.Rect) -> bool:
        seen: set[int] = set()
        for key in self._keys(candidate):
            for idx in self.grid.get(key, ()):
                if idx in seen:
                    continue
                seen.add(idx)
                if not (candidate & self.boxes[idx]).is_empty:
                    return True
        return False

    def intersects_new_area(self, candidate: fitz.Rect, source_rect: fitz.Rect) -> bool:
        """Reject expansion across linework that the original source did not touch."""
        seen: set[int] = set()
        for key in self._keys(candidate):
            for idx in self.grid.get(key, ()):
                if idx in seen:
                    continue
                seen.add(idx)
                box = self.boxes[idx]
                if (candidate & box).is_empty:
                    continue
                if (source_rect & box).is_empty:
                    return True
        return False


def intersects_linework(candidate: fitz.Rect, boxes: "list[fitz.Rect] | LineworkIndex") -> bool:
    if isinstance(boxes, LineworkIndex):
        return boxes.intersects(candidate)
    return any(not (candidate & box).is_empty for box in boxes)


def cardinal_rotation(direction: list[float]) -> int | None:
    dx = float(direction[0]) if len(direction) > 0 else 1.0
    dy = float(direction[1]) if len(direction) > 1 else 0.0
    magnitude = math.hypot(dx, dy)
    if magnitude <= 1e-9:
        return None
    unit = (dx / magnitude, dy / magnitude)
    candidates = {
        0: (1.0, 0.0),
        90: (0.0, -1.0),
        180: (-1.0, 0.0),
        270: (0.0, 1.0),
    }
    rotate, similarity = max(
        ((angle, unit[0] * vector[0] + unit[1] * vector[1])
         for angle, vector in candidates.items()),
        key=lambda item: item[1],
    )
    # PyMuPDF's textbox API supports cardinal rotation only. Never round an
    # arbitrary-angle CAD label to another orientation: leave its source text
    # visible and report it as unresolved instead.
    if similarity < math.cos(math.radians(2)):
        return None
    return rotate


def preflight_text(
    page: fitz.Page,
    item: dict,
    obstacles: list[dict],
    linework: LineworkIndex | None = None,
    target_language: str = "en",
) -> tuple[tuple[fitz.Rect, float, int] | None, str]:
    direction = item.get("direction", [1, 0])
    if item.get("uncertain"):
        return None, "uncertain_translation"
    if not str(item.get("translation", "")).strip():
        return None, "missing_translation"
    rotate = cardinal_rotation(direction)
    if rotate is None:
        return None, "unsupported_direction"
    rect = fitz.Rect(item["bbox"])
    text = str(item.get("translation", "")).strip()
    original_size = float(item.get("fontSize", 8))
    width = max(rect.width, 24)
    height = max(rect.height, 24)
    if rotate in (90, 270):
        narrow_pad_x = max(0.9, original_size * 0.12)
        side_pad_x = max(1.5, original_size * 0.20)
        pad_x = max(2, original_size * 0.45)
        wide_pad_x = max(3, original_size * 0.6)
        medium_length = max(height * 1.25, height + 8)
        long_length = max(height * 1.5, height + 16)
        if rotate == 90:
            medium_y0, medium_y1 = max(2, rect.y1 - medium_length), rect.y1
            long_y0, long_y1 = max(2, rect.y1 - long_length), rect.y1
        else:
            medium_y0, medium_y1 = rect.y0, min(page.rect.height - 2, rect.y0 + medium_length)
            long_y0, long_y1 = rect.y0, min(page.rect.height - 2, rect.y0 + long_length)
        candidates = [
            fitz.Rect(rect.x0 - 0.25, rect.y0 - 0.25, rect.x1 + 0.25, rect.y1 + 0.25),
            # Many title-block margin cells have spare width but are tightly
            # bounded by horizontal row rules. Use that width before extending
            # the text run into a neighboring row.
            fitz.Rect(rect.x0 - narrow_pad_x, rect.y0 - 0.25, rect.x1 + narrow_pad_x, rect.y1 + 0.25),
            fitz.Rect(rect.x0 - side_pad_x, rect.y0 - 0.25, rect.x1 + 0.4, rect.y1 + 0.25),
            fitz.Rect(rect.x0 - 0.4, rect.y0 - 0.25, rect.x1 + side_pad_x, rect.y1 + 0.25),
            # Try both sides of a vertical source box. Margin labels often sit
            # immediately beside a title-block rule, so expanding only toward
            # the drawing interior creates a false linework collision.
            fitz.Rect(max(2, rect.x0 - pad_x), medium_y0, rect.x1 + 0.5, medium_y1),
            fitz.Rect(rect.x0 - 0.5, medium_y0, min(page.rect.width - 2, rect.x1 + pad_x), medium_y1),
            fitz.Rect(max(2, rect.x0 - wide_pad_x), long_y0, rect.x1 + 0.5, long_y1),
            fitz.Rect(rect.x0 - 0.5, long_y0, min(page.rect.width - 2, rect.x1 + wide_pad_x), long_y1),
        ]
    elif rotate == 180:
        candidates = [
            fitz.Rect(rect),
            fitz.Rect(rect.x0 - 0.25, rect.y0 - 0.25, rect.x1 + 0.25, rect.y1 + 0.25),
            fitz.Rect(max(2, rect.x1 - max(width * 1.25, width + 8)), rect.y0 - 0.5, rect.x1, rect.y1 + max(2, original_size * 0.45)),
            fitz.Rect(max(2, rect.x1 - max(width * 1.5, width + 16)), rect.y0 - 0.5, rect.x1, rect.y1 + max(2, original_size * 0.6)),
        ]
    else:
        candidates = [
            fitz.Rect(rect),
            fitz.Rect(rect.x0 - 0.25, rect.y0 - 0.25, rect.x1 + 0.25, rect.y1 + 0.25),
            fitz.Rect(rect.x0, rect.y0 - 0.5, min(page.rect.width - 2, rect.x0 + max(width * 1.25, width + 8)), rect.y1 + max(2, original_size * 0.45)),
            fitz.Rect(rect.x0, rect.y0 - 0.5, min(page.rect.width - 2, rect.x0 + max(width * 1.5, width + 16)), rect.y1 + max(2, original_size * 0.6)),
        ]
    unobstructed_candidate_found = False
    min_font_size = max(3.0, min(5.0, original_size * 0.65))
    font_name, font_file = target_font(target_language)
    for candidate in candidates:
        contained = candidate & page.rect
        if (
            contained.is_empty
            or abs(contained.x0 - candidate.x0) > 0.01
            or abs(contained.y0 - candidate.y0) > 0.01
            or abs(contained.x1 - candidate.x1) > 0.01
            or abs(contained.y1 - candidate.y1) > 0.01
        ):
            continue
        if overlaps_other(candidate, item, obstacles):
            continue
        if linework is not None and linework.intersects_new_area(candidate, rect):
            continue
        unobstructed_candidate_found = True
        font_size = min(max(original_size, 5), 18)
        while True:
            shape = page.new_shape()
            result = shape.insert_textbox(
                candidate,
                text,
                fontname=font_name,
                fontfile=font_file,
                fontsize=font_size,
                color=fitz.sRGB_to_pdf(int(item.get("color", 0))),
                align=fitz.TEXT_ALIGN_LEFT,
                rotate=rotate,
            )
            # PyMuPDF's post-redaction textbox metrics consume slightly more
            # vertical space than the untouched page. Reserve 25% of the font
            # size so a disposable preflight remains valid after source text
            # is removed and the replacement is committed.
            if result >= font_size * 0.25:
                return (candidate, font_size, rotate), "placed"
            if font_size <= min_font_size + 0.01:
                break
            font_size = max(min_font_size, font_size - 0.75)
    return None, "text_too_long" if unobstructed_candidate_found else "overlap"


def _union_rect(items: list[dict]) -> fitz.Rect:
    rects = [fitz.Rect(item["bbox"]) for item in items]
    return fitz.Rect(
        min(rect.x0 for rect in rects),
        min(rect.y0 for rect in rects),
        max(rect.x1 for rect in rects),
        max(rect.y1 for rect in rects),
    )


def _layout_groups(items: list[dict]) -> list[list[dict]]:
    groups: dict[str, list[dict]] = {}
    order: list[str] = []
    for item in items:
        key = str(
            item.get("placementGroupId")
            or item.get("layoutGroupId")
            or item.get("paragraphId")
            or item.get("id")
        )
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(item)
    return [
        sorted(groups[key], key=lambda item: (
            float(item["bbox"][1]),
            float(item["bbox"][0]),
        ))
        for key in order
    ]


def _shared_group_translation(items: list[dict]) -> str | None:
    if not any(bool(item.get("compactGroupId") or item.get("layoutGroupCompact")) for item in items):
        return None
    values = {
        re.sub(
            r"\s+",
            " ",
            str(
                item.get("compactGroupTranslation")
                or item.get("layoutGroupTranslation")
                or ""
            ).strip(),
        )
        for item in items
        if str(
            item.get("compactGroupTranslation")
            or item.get("layoutGroupTranslation")
            or ""
        ).strip()
    }
    return next(iter(values)) if len(values) == 1 else None


def _compact_group_id(item: dict) -> str | None:
    if item.get("compactGroupId"):
        return str(item["compactGroupId"])
    if item.get("layoutGroupCompact") and item.get("layoutGroupId"):
        return str(item["layoutGroupId"])
    return None


def _render_units(items: list[dict]) -> list[list[dict]]:
    units: list[list[dict]] = []
    compact_units: dict[str, list[dict]] = {}
    for item in items:
        compact_group_id = _compact_group_id(item)
        if compact_group_id:
            if compact_group_id not in compact_units:
                compact_units[compact_group_id] = []
                units.append(compact_units[compact_group_id])
            compact_units[compact_group_id].append(item)
        else:
            units.append([item])
    return units


def _warning(item: dict, category: str) -> dict:
    return {
        "blockId": str(item["id"]),
        "sourceText": str(item.get("source", "")),
        "bbox": [float(value) for value in item["bbox"]],
        "rejectionCategory": category,
    }


def fit_text(page: fitz.Page, rect: fitz.Rect, text: str, font_size: float, color: int, rotate: int, target_language: str = "en") -> None:
    shape = page.new_shape()
    font_name, font_file = target_font(target_language)
    result = shape.insert_textbox(
        rect,
        text,
        fontname=font_name,
        fontfile=font_file,
        fontsize=font_size,
        color=fitz.sRGB_to_pdf(color),
        align=fitz.TEXT_ALIGN_LEFT,
        rotate=rotate,
    )
    if result < 0:
        raise ValueError("preflighted replacement no longer fits its target rectangle")
    shape.commit(overlay=True)


def apply_page_overlay(
    page: fitz.Page,
    items: list[dict],
    obstacles: list[dict],
    target_language: str = "en",
) -> tuple[int, list[dict]]:
    """Overlay translated text onto a single page in place.

    Returns (placement_count, structured unresolved lines). Vector linework and raster images
    are deliberately retained; only replaced source text is redacted, and only
    after a replacement has proved it can fit.
    """
    placements: list[tuple[list[dict], dict, fitz.Rect, float, int]] = []
    warnings: list[dict] = []
    linework = LineworkIndex(linework_boxes(page))
    all_obstacles = obstacles or items
    replacement_ids = {str(item["id"]) for item in items}
    for group in _layout_groups(items):
        member_ids = {str(item["id"]) for item in group}
        placement_group_ids = {
            str(
                item.get("placementGroupId")
                or item.get("layoutGroupId")
                or item.get("paragraphId")
                or item.get("id")
            )
            for item in group
        }
        external_obstacles = [
            {
                **obstacle,
                "replacementTarget": str(obstacle.get("id")) in replacement_ids,
            } for obstacle in all_obstacles
            if (
                str(obstacle.get("id")) not in member_ids
                and str(
                    obstacle.get("placementGroupId")
                    or obstacle.get("layoutGroupId")
                    or obstacle.get("paragraphId")
                    or obstacle.get("id")
                ) not in placement_group_ids
            )
        ]
        group_plans: list[tuple[list[dict], dict, fitz.Rect, float, int]] = []
        planned_obstacles: list[dict] = []
        failure_category: str | None = None
        for unit in _render_units(group):
            leader = unit[0]
            compact_translation = _shared_group_translation(unit) if len(unit) > 1 else None
            if len(unit) > 1 and not compact_translation:
                failure_category = "missing_translation"
                break
            item = {
                **leader,
                **({
                    "id": f"{leader['id']}-compact-group",
                    "bbox": list(_union_rect(unit)),
                    "fontSize": max(float(member.get("fontSize", 8)) for member in unit),
                    "source": " ".join(str(member.get("source", "")).strip() for member in unit),
                    "translation": compact_translation,
                    "uncertain": any(bool(member.get("uncertain")) for member in unit),
                } if compact_translation else {}),
            }
            placement, rejection_category = preflight_text(
                page,
                item,
                external_obstacles + planned_obstacles,
                linework,
                target_language,
            )
            if placement is None:
                failure_category = rejection_category
                break
            group_plans.append((unit, item, placement[0], placement[1], placement[2]))
            planned_obstacles.append({
                "id": f"planned-{item['id']}",
                "paragraphId": item.get("paragraphId"),
                "layoutGroupId": item.get("layoutGroupId"),
                "placementGroupId": item.get("placementGroupId"),
                "bbox": list(placement[0]),
            })
        if failure_category is not None:
            warnings.extend(_warning(item, failure_category) for item in group)
            continue
        placements.extend(group_plans)
    # Redact text only. Vector linework and raster images are deliberately
    # retained, preserving the original construction drawing page.
    for source_items, _render_item, _target_rect, _font_size, _rotate in placements:
        for item in source_items:
            rect = fitz.Rect(item["bbox"])
            if item.get("rasterBacked"):
                # Vision and OCR boxes describe glyph bounds. A small deterministic
                # reserve removes antialiasing fringes without broadly painting over
                # adjacent CAD geometry or table rules.
                reserve = max(0.75, min(2.0, rect.height * 0.08))
                rect = (rect + (-reserve, -reserve, reserve, reserve)) & page.rect
            # Transparent backing prevents the redaction annotation itself from
            # visually masking retained CAD linework.
            page.add_redact_annot(
                rect,
                # Raster-backed recovered labels cannot be removed with text-only
                # redaction. Their tightly bounded source pixels are covered only
                # after the English replacement has successfully preflighted.
                fill=(1, 1, 1) if item.get("rasterBacked") else None,
                cross_out=False,
            )
    if placements:
        page.apply_redactions(
            images=fitz.PDF_REDACT_IMAGE_NONE,
            graphics=fitz.PDF_REDACT_LINE_ART_NONE,
            text=fitz.PDF_REDACT_TEXT_REMOVE,
        )
    for _source_items, item, target_rect, font_size, rotate in placements:
        text = str(item.get("translation", "")).strip()
        if not text:
            continue
        fit_text(page, target_rect, text, font_size, int(item.get("color", 0)), rotate, target_language)
    return sum(len(source_items) for source_items, *_rest in placements), warnings


def group_by_page(payload: dict) -> tuple[dict[int, list[dict]], dict[int, list[dict]]]:
    by_page: dict[int, list[dict]] = {}
    for item in payload.get("translations", []):
        by_page.setdefault(int(item["pageNumber"]), []).append(item)
    obstacles_by_page: dict[int, list[dict]] = {}
    for item in payload.get("obstacles", []):
        obstacles_by_page.setdefault(int(item["pageNumber"]), []).append(item)
    return by_page, obstacles_by_page


def render_thumbnail(page: fitz.Page, thumb_path: str) -> dict:
    # 110 dpi: enough for a useful review grid without huge private assets.
    pix = page.get_pixmap(matrix=fitz.Matrix(THUMB_DPI / 72, THUMB_DPI / 72), alpha=False)
    Path(thumb_path).parent.mkdir(parents=True, exist_ok=True)
    atomic_write_bytes(thumb_path, pix.tobytes(output="jpg", jpg_quality=78))
    return {
        "pixelWidth": pix.width,
        "pixelHeight": pix.height,
        "pageWidthPoints": float(page.rect.width),
        "pageHeightPoints": float(page.rect.height),
    }


def render_source_thumbnail(input_pdf: str, page_number: int, output_jpg: str) -> None:
    doc = fitz.open(input_pdf)
    validate_doc(doc)
    if page_number < 1 or page_number > doc.page_count:
        doc.close()
        raise DocumentRejected(
            "page_out_of_range",
            f"Requested page {page_number} is outside the document (1..{doc.page_count})",
        )
    preview = render_thumbnail(doc[page_number - 1], output_jpg)
    doc.close()
    print(json.dumps({"pageNumber": page_number, "preview": preview}))


def overlay(input_pdf: str, translations_json: str, output_pdf: str, thumb_dir: str) -> None:
    payload = json.loads(Path(translations_json).read_text(encoding="utf-8"))
    by_page, obstacles_by_page = group_by_page(payload)

    doc = fitz.open(input_pdf)
    validate_doc(doc)
    warnings: dict[int, list[str]] = {}
    placement_counts: dict[int, int] = {}
    for page_number, items in by_page.items():
        if page_number < 1 or page_number > doc.page_count:
            continue
        page = doc[page_number - 1]
        count, page_warnings = apply_page_overlay(
            page, items, obstacles_by_page.get(page_number, items),
            payload.get("targetLanguage", "en"),
        )
        placement_counts[page_number] = count
        if page_warnings:
            warnings[page_number] = page_warnings

    Path(output_pdf).parent.mkdir(parents=True, exist_ok=True)
    doc.save(output_pdf, garbage=4, deflate=True)
    doc.close()

    out = fitz.open(output_pdf)
    Path(thumb_dir).mkdir(parents=True, exist_ok=True)
    page_meta: list[dict] = []
    for idx, page in enumerate(out):
        thumb = os.path.join(thumb_dir, f"page-{idx + 1}.jpg")
        preview = render_thumbnail(page, thumb)
        page_items = by_page.get(idx + 1, [])
        page_meta.append({
            "pageNumber": idx + 1,
            "sourceBlockCount": len(page_items),
            "translatedBlockCount": placement_counts.get(idx + 1, 0),
            "warnings": warnings.get(idx + 1, []),
            "preview": preview,
        })
    out.close()
    print(json.dumps({"pages": page_meta, "warningCount": sum(len(v) for v in warnings.values())}))


def render_page(
    input_pdf: str,
    translations_json: str,
    page_number: int,
    output_pdf: str,
    thumb_jpg: str,
    output_json: str,
) -> None:
    """Render exactly one requested page to a one-page PDF fragment + thumbnail.

    Writes the metadata JSON both to the requested path (durable, atomic) and to
    stdout. Restart-safe: this never reads or depends on any other page's
    fragment, so the worker can re-render any page independently.
    """
    payload = json.loads(Path(translations_json).read_text(encoding="utf-8"))
    by_page, obstacles_by_page = group_by_page(payload)

    doc = fitz.open(input_pdf)
    validate_doc(doc)
    page_count = doc.page_count
    if page_number < 1 or page_number > page_count:
        doc.close()
        raise DocumentRejected(
            "page_out_of_range",
            f"Requested page {page_number} is outside the document (1..{page_count})",
        )

    # Isolate the single requested page into its own one-page document so the
    # saved fragment contains exactly one page and only that page's resources.
    fragment = fitz.open()
    fragment.insert_pdf(doc, from_page=page_number - 1, to_page=page_number - 1)
    doc.close()

    page = fragment[0]
    items = by_page.get(page_number, [])
    count, page_warnings = apply_page_overlay(
        page, items, obstacles_by_page.get(page_number, items),
        payload.get("targetLanguage", "en"),
    )

    fragment_bytes = fragment.tobytes(garbage=4, deflate=True)
    atomic_write_bytes(output_pdf, fragment_bytes)

    preview = render_thumbnail(fragment[0], thumb_jpg)
    fragment.close()

    meta = {
        "pageNumber": page_number,
        "sourceBlockCount": len(items),
        "translatedBlockCount": count,
        "warnings": page_warnings,
        "preview": preview,
    }
    atomic_write_text(output_json, json.dumps(meta, ensure_ascii=False))
    print(json.dumps(meta))


def crop_for_recovery(
    input_pdf: str,
    page_number: int,
    coords: list[float],
    output_jpg: str,
) -> None:
    """Write a high-resolution local crop for one suspect text line."""
    doc = fitz.open(input_pdf)
    validate_doc(doc)
    if page_number < 1 or page_number > doc.page_count:
        doc.close()
        raise DocumentRejected(
            "page_out_of_range",
            f"Requested page {page_number} is outside the document (1..{doc.page_count})",
        )
    page = doc[page_number - 1]
    rect = fitz.Rect(coords)
    if rect.is_empty or rect.width <= 0 or rect.height <= 0:
        doc.close()
        raise DocumentRejected("invalid_crop", "Recovery crop coordinates are invalid")
    # Include a little visual context (including table borders) without sending
    # an entire confidential drawing page to the vision model.
    rect = (rect + (-4, -4, 4, 4)) & page.rect
    if rect.is_empty:
        doc.close()
        raise DocumentRejected("invalid_crop", "Recovery crop is outside the page")
    scale = RECOVERY_DPI / 72
    expected_width = int(rect.width * scale + 0.5)
    expected_height = int(rect.height * scale + 0.5)
    expected_pixels = expected_width * expected_height
    if (
        expected_width > MAX_RECOVERY_CROP_EDGE
        or expected_height > MAX_RECOVERY_CROP_EDGE
        or expected_pixels > MAX_RECOVERY_CROP_PIXELS
        or rect.get_area() > page.rect.get_area() * 0.25
    ):
        doc.close()
        raise DocumentRejected(
            "recovery_crop_too_large",
            "The suspect text area is too large for private visual recovery",
        )
    pix = page.get_pixmap(
        matrix=fitz.Matrix(scale, scale),
        clip=rect,
        alpha=False,
    )
    encoded = pix.tobytes(output="jpg", jpg_quality=90)
    if len(encoded) > MAX_RECOVERY_CROP_BYTES:
        doc.close()
        raise DocumentRejected(
            "recovery_crop_too_large",
            "The suspect text crop is too large for private visual recovery",
        )
    Path(output_jpg).parent.mkdir(parents=True, exist_ok=True)
    atomic_write_bytes(output_jpg, encoded)
    width, height = pix.width, pix.height
    doc.close()
    print(json.dumps({"pageNumber": page_number, "width": width, "height": height}))


def merge(output_pdf: str, fragments: list[str]) -> None:
    """Combine an ordered list of one-page PDF fragments into one PDF.

    Uses PyMuPDF insert_pdf so vector content is preserved (never rasterized).
    Validates that every fragment exists, is a single-page PDF, and preserves
    the caller-supplied order.
    """
    if not fragments:
        raise DocumentRejected("no_fragments", "merge requires at least one PDF fragment")

    merged = fitz.open()
    for index, fragment_path in enumerate(fragments):
        if not os.path.isfile(fragment_path):
            merged.close()
            raise DocumentRejected(
                "fragment_missing",
                f"Fragment #{index + 1} is missing from the workspace",
            )
        try:
            src = fitz.open(fragment_path)
        except Exception:
            merged.close()
            raise DocumentRejected(
                "fragment_invalid",
                f"Fragment #{index + 1} is not a readable PDF",
            )
        if src.page_count != 1:
            page_count = src.page_count
            src.close()
            merged.close()
            raise DocumentRejected(
                "fragment_not_single_page",
                f"Fragment #{index + 1} has {page_count} pages; expected exactly one",
            )
        merged.insert_pdf(src)
        src.close()

    if merged.page_count != len(fragments):
        merged.close()
        raise DocumentRejected(
            "merge_page_mismatch",
            f"Merged document has {merged.page_count} pages; expected {len(fragments)}",
        )

    merged_bytes = merged.tobytes(garbage=4, deflate=True)
    page_count = merged.page_count
    merged.close()
    atomic_write_bytes(output_pdf, merged_bytes)
    print(json.dumps({"pageCount": page_count, "fragmentCount": len(fragments)}))


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("usage: processor.py extract|overlay|render|crop|thumbnail|merge ...")
    mode = sys.argv[1]
    constrain_process(mode)
    try:
        if mode == "extract" and len(sys.argv) in {4, 5}:
            extract(sys.argv[2], sys.argv[3], sys.argv[4] if len(sys.argv) == 5 else "auto")
        elif mode == "overlay" and len(sys.argv) == 6:
            overlay(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5])
        elif mode == "render" and len(sys.argv) == 8:
            try:
                requested_page = int(sys.argv[4])
            except ValueError:
                raise SystemExit("render page number must be an integer")
            render_page(
                sys.argv[2],
                sys.argv[3],
                requested_page,
                sys.argv[5],
                sys.argv[6],
                sys.argv[7],
            )
        elif mode == "crop" and len(sys.argv) == 9:
            try:
                requested_page = int(sys.argv[3])
                coords = [float(value) for value in sys.argv[4:8]]
            except ValueError:
                raise SystemExit("crop page and coordinates must be numeric")
            crop_for_recovery(sys.argv[2], requested_page, coords, sys.argv[8])
        elif mode == "thumbnail" and len(sys.argv) == 5:
            try:
                requested_page = int(sys.argv[3])
            except ValueError:
                raise SystemExit("thumbnail page number must be an integer")
            render_source_thumbnail(sys.argv[2], requested_page, sys.argv[4])
        elif mode == "merge" and len(sys.argv) >= 4:
            merge(sys.argv[2], sys.argv[3:])
        else:
            raise SystemExit("invalid command or arguments")
    except DocumentRejected as exc:
        print(json.dumps({
            "kind": "document_rejected",
            "code": exc.code,
            "message": str(exc),
        }), file=sys.stderr)
        raise SystemExit(2)
    except Exception as exc:
        if exc.__class__.__name__ in {"EmptyFileError", "FileDataError"}:
            print(json.dumps({
                "kind": "document_rejected",
                "code": "invalid_pdf",
                "message": "The PDF is damaged or is not a supported PDF file.",
            }), file=sys.stderr)
            raise SystemExit(2)
        traceback.print_exc()
        raise SystemExit(1)


if __name__ == "__main__":
    main()
