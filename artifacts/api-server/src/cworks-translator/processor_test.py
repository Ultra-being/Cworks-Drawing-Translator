#!/usr/bin/env python3
"""Focused tests for the real CAD processor (server/cad-translator/processor.py).

These tests generate sample PDFs with PyMuPDF (vector drawings + positioned
text), then invoke the actual processor as a subprocess exactly the way the Node
worker does. They verify:
  - render produces a one-page PDF fragment + JPEG thumbnail + JSON metadata
  - text replacement happens on isolated pages
  - vector drawing content survives (is not rasterized away)
  - merge preserves page count AND caller-supplied order without rasterizing
  - page-bounds / order / geometry / invalid-input validation
  - extract still works (backward compatibility)

Run:  python3 -m unittest server/cad-translator/processor_test.py -v
   or: python3 server/cad-translator/processor_test.py
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import fitz

HERE = Path(__file__).resolve().parent
PROCESSOR = HERE / "processor.py"
PYTHON = sys.executable


def run_processor(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(
        [PYTHON, str(PROCESSOR), *args],
        capture_output=True,
        text=True,
    )


def last_json_line(stdout: str) -> dict:
    line = [ln for ln in stdout.splitlines() if ln.strip()][-1]
    return json.loads(line)


def make_sample_pdf(path: str, pages: int = 1, *, label: str = "Puerta") -> None:
    """Create a multi-page PDF with a vector rectangle/line and one text label.

    The text label sits away from any linework so the overlay logic can safely
    replace it, letting us assert real text replacement.
    """
    doc = fitz.open()
    for i in range(pages):
        page = doc.new_page(width=400, height=300)
        # Vector linework kept clear of the label region: a border rectangle in
        # the lower area plus a horizontal detail line near the bottom.
        page.draw_rect(fitz.Rect(40, 140, 360, 270), color=(0, 0, 0), width=1.5)
        page.draw_line(fitz.Point(40, 200), fitz.Point(360, 200), color=(0, 0, 0), width=1.0)
        # A replaceable text label in open space (top-left, clear of linework).
        page.insert_text(fitz.Point(60, 60), f"{label}{i + 1}", fontsize=12, fontname="helv")
    doc.save(path)
    doc.close()


def make_raster_title_pdf(path: str) -> list[float]:
    source = fitz.open()
    page = source.new_page(width=400, height=300)
    page.insert_text(
        fitz.Point(120, 42),
        "LONG_SOURCE_TITLE",
        fontsize=14,
        fontname="helv",
    )
    bbox = list(page.search_for("LONG_SOURCE_TITLE")[0])
    pix = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
    source.close()
    doc = fitz.open()
    raster_page = doc.new_page(width=400, height=300)
    raster_page.insert_image(raster_page.rect, stream=pix.tobytes("png"))
    doc.save(path)
    doc.close()
    return bbox


def make_hybrid_raster_strip_pdf(path: str, strip_text: str = "Примечания по монтажу кровли") -> None:
    strip_doc = fitz.open()
    strip_page = strip_doc.new_page(width=760, height=90)
    strip_page.insert_text(
        fitz.Point(20, 52),
        strip_text,
        fontsize=26,
        fontname="dejavu",
        fontfile="/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    )
    strip_pix = strip_page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
    strip_doc.close()

    doc = fitz.open()
    page = doc.new_page(width=800, height=600)
    page.insert_text(fitz.Point(40, 80), "Selectable CAD label", fontsize=11, fontname="helv")
    page.insert_text(fitz.Point(40, 110), "Vector note reference", fontsize=11, fontname="helv")
    page.insert_image(
        fitz.Rect(20, 300, 780, 390),
        stream=strip_pix.tobytes("png"),
    )
    doc.save(path)
    doc.close()


def make_hybrid_raster_region_pdf(
    path: str,
    image_rect: fitz.Rect,
    *,
    width: float,
    height: float,
    lines: list[str],
) -> None:
    image_doc = fitz.open()
    image_page = image_doc.new_page(width=width, height=height)
    y = 34
    for line in lines:
        image_page.insert_text(
            fitz.Point(12, y),
            line,
            fontsize=20,
            fontname="dejavu",
            fontfile="/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        )
        y += 32
    image_pix = image_page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
    image_doc.close()
    doc = fitz.open()
    page = doc.new_page(width=800, height=600)
    page.insert_text(fitz.Point(40, 80), "Selectable CAD label", fontsize=11)
    page.insert_text(fitz.Point(40, 110), "Vector note reference", fontsize=11)
    page.insert_image(image_rect, stream=image_pix.tobytes("png"))
    doc.save(path)
    doc.close()


def count_drawings(pdf_path: str, page_index: int = 0) -> int:
    doc = fitz.open(pdf_path)
    n = len(doc[page_index].get_drawings())
    doc.close()
    return n


def page_text(pdf_path: str, page_index: int = 0) -> str:
    doc = fitz.open(pdf_path)
    text = doc[page_index].get_text()
    doc.close()
    return text


class ProcessorRenderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _translations(self, path: str, page_number: int, block_id: str,
                      bbox: list[float], translation: str) -> None:
        Path(path).write_text(json.dumps({
            "translations": [{
                "id": block_id,
                "pageNumber": page_number,
                "bbox": bbox,
                "fontSize": 12,
                "direction": [1, 0],
                "color": 0,
                "translation": translation,
            }],
            "obstacles": [],
        }), encoding="utf-8")

    def _source_bbox(self, pdf: str, page_index: int, needle: str) -> list[float]:
        doc = fitz.open(pdf)
        page = doc[page_index]
        raw = page.get_text("dict", flags=fitz.TEXTFLAGS_TEXT)
        bbox = None
        for block in raw.get("blocks", []):
            for line in block.get("lines", []):
                spans = line.get("spans", [])
                text = "".join(str(s.get("text", "")) for s in spans)
                if needle in text:
                    bbox = list(line["bbox"])
        doc.close()
        assert bbox is not None, f"could not find {needle!r}"
        return bbox

    def test_render_embeds_japanese_font_and_fits_deterministically(self) -> None:
        src = str(self.dir / "japanese-source.pdf")
        translations = str(self.dir / "japanese.json")
        fragment = str(self.dir / "japanese-output.pdf")
        thumbnail = str(self.dir / "japanese.jpg")
        metadata = str(self.dir / "japanese-meta.json")
        make_sample_pdf(src, label="Source")
        bbox = self._source_bbox(src, 0, "Source1")
        Path(translations).write_text(json.dumps({
            "targetLanguage": "ja",
            "translations": [{
                "id": "p1-l0", "pageNumber": 1, "bbox": bbox,
                "fontSize": 12, "direction": [1, 0], "color": 0,
                "source": "Source1", "translation": "機械室",
            }],
            "obstacles": [],
        }, ensure_ascii=False), encoding="utf-8")
        proc = run_processor([
            "render", src, translations, "1", fragment, thumbnail, metadata,
        ])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        rendered = fitz.open(fragment)
        self.assertIn("機械室", rendered[0].get_text())
        fonts = rendered[0].get_fonts(full=True)
        self.assertTrue(any("Noto Sans" in " ".join(map(str, font)) and "JP" in " ".join(map(str, font))
                            for font in fonts))
        rendered.close()
        meta = json.loads(Path(metadata).read_text())
        self.assertEqual(meta["translatedBlockCount"], 1)
        self.assertEqual(meta["warnings"], [])

    def test_extract_still_works(self) -> None:
        src = str(self.dir / "in.pdf")
        out = str(self.dir / "blocks.json")
        make_sample_pdf(src, pages=2)
        proc = run_processor(["extract", src, out])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = last_json_line(proc.stdout)
        self.assertEqual(result["pageCount"], 2)
        self.assertGreaterEqual(result["blockCount"], 2)
        parsed = json.loads(Path(out).read_text())
        self.assertEqual(len(parsed["pages"]), 2)

    def test_extract_splits_space_padded_table_cells_and_trims_geometry(self) -> None:
        src = str(self.dir / "padded-cells.pdf")
        out = str(self.dir / "padded-cells.json")
        doc = fitz.open()
        page = doc.new_page(width=500, height=160)
        page.insert_text(
            fitz.Point(20, 50),
            "                        Тип              Материал и способ                                  Цвет",
            fontsize=10,
            fontname="dejavu",
            fontfile="/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        )
        doc.save(src)
        doc.close()

        proc = run_processor(["extract", src, out])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        blocks = json.loads(Path(out).read_text())["pages"][0]["blocks"]
        self.assertEqual([block["text"] for block in blocks], [
            "Тип",
            "Материал и способ",
            "Цвет",
        ])
        self.assertEqual([block["id"] for block in blocks], [
            "p1-l0",
            "p1-l0-s1",
            "p1-l0-s2",
        ])
        self.assertGreater(blocks[0]["bbox"][0], 50)
        self.assertLess(blocks[0]["bbox"][2], blocks[1]["bbox"][0])
        self.assertLess(blocks[1]["bbox"][2], blocks[2]["bbox"][0])

    def test_extract_marks_broken_glyph_runs_for_visual_recovery(self) -> None:
        src = str(self.dir / "broken-font.pdf")
        out = str(self.dir / "blocks.json")
        make_sample_pdf(src, label="????")
        proc = run_processor(["extract", src, out])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        parsed = json.loads(Path(out).read_text())
        suspect = next(
            block for block in parsed["pages"][0]["blocks"]
            if "????" in block["text"]
        )
        self.assertTrue(suspect["suspicious"])

    def test_extract_identifies_bounded_raster_title_region(self) -> None:
        src = str(self.dir / "raster-title.pdf")
        out = str(self.dir / "raster-title-blocks.json")
        make_raster_title_pdf(src)
        proc = run_processor(["extract", src, out])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        page = json.loads(Path(out).read_text())["pages"][0]
        self.assertEqual(page["blocks"], [])
        self.assertEqual(len(page["visualRecoveryRegions"]), 1)
        region = page["visualRecoveryRegions"][0]
        self.assertEqual(region["id"], "p1-raster-title")
        area = (
            (region["bbox"][2] - region["bbox"][0])
            * (region["bbox"][3] - region["bbox"][1])
        )
        self.assertLessEqual(area, 400 * 300 * 0.25)

    def test_raster_only_non_language_fixture_gets_only_bounded_title_recovery(self) -> None:
        src = str(self.dir / "raster-only-symbols.pdf")
        base = fitz.open()
        page = base.new_page(width=400, height=300)
        page.draw_rect(fitz.Rect(10, 10, 390, 290), color=(0, 0, 0))
        page.draw_line(fitz.Point(20, 30), fitz.Point(380, 270), color=(0, 0, 0))
        page.insert_text(fitz.Point(160, 42), "A-101", fontsize=14, fontname="helv")
        pix = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
        base.close()
        doc = fitz.open()
        raster_page = doc.new_page(width=400, height=300)
        raster_page.insert_image(raster_page.rect, stream=pix.tobytes("png"))
        doc.save(src)
        doc.close()

        extracted = str(self.dir / "raster-only-symbols.json")
        proc = run_processor(["extract", src, extracted])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        page_data = json.loads(Path(extracted).read_text())["pages"][0]
        self.assertEqual(page_data["blocks"], [])
        self.assertEqual(len(page_data["visualRecoveryRegions"]), 1)
        region = page_data["visualRecoveryRegions"][0]
        self.assertEqual(region["kind"], "raster-title")
        self.assertLessEqual(
            (region["bbox"][2] - region["bbox"][0])
            * (region["bbox"][3] - region["bbox"][1]),
            400 * 300 * 0.25,
        )

        crop = str(self.dir / "raster-only-symbols-crop.jpg")
        crop_proc = run_processor([
            "crop", src, "1", *[str(value) for value in region["bbox"]], crop,
        ])
        self.assertEqual(crop_proc.returncode, 0, crop_proc.stderr)
        crop_meta = last_json_line(crop_proc.stdout)
        self.assertLessEqual(crop_meta["width"], 4096)
        self.assertLessEqual(crop_meta["height"], 4096)
        self.assertLessEqual(crop_meta["width"] * crop_meta["height"], 3_000_000)

        whole_page = run_processor([
            "crop", src, "1", "0", "0", "400", "300",
            str(self.dir / "whole-page.jpg"),
        ])
        self.assertEqual(whole_page.returncode, 2)
        self.assertEqual(
            json.loads(whole_page.stderr.strip().splitlines()[-1])["code"],
            "recovery_crop_too_large",
        )

    def test_large_raster_title_region_stays_within_crop_limits(self) -> None:
        src = str(self.dir / "large-raster-title.pdf")
        base = fitz.open()
        page = base.new_page(width=2400, height=1700)
        page.insert_text(fitz.Point(1100, 80), "TITLE", fontsize=20, fontname="helv")
        pix = page.get_pixmap(matrix=fitz.Matrix(0.5, 0.5), alpha=False)
        base.close()
        doc = fitz.open()
        page = doc.new_page(width=2400, height=1700)
        page.insert_image(page.rect, stream=pix.tobytes("jpg"))
        doc.save(src)
        doc.close()
        extracted = str(self.dir / "large-raster-title.json")
        proc = run_processor(["extract", src, extracted])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        region = json.loads(Path(extracted).read_text())["pages"][0]["visualRecoveryRegions"][0]
        self.assertLessEqual(region["bbox"][2] - region["bbox"][0] + 8, 900)
        self.assertLessEqual(region["bbox"][3] - region["bbox"][1] + 8, 180)
        crop = str(self.dir / "large-raster-title.jpg")
        proc = run_processor([
            "crop", src, "1", *[str(value) for value in region["bbox"]], crop,
        ])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = last_json_line(proc.stdout)
        self.assertLessEqual(result["width"], 4096)
        self.assertLessEqual(result["height"], 4096)
        self.assertLessEqual(result["width"] * result["height"], 3_000_000)

    def test_extract_audits_bounded_raster_strip_outside_title_zone(self) -> None:
        src = str(self.dir / "hybrid-strip.pdf")
        out = str(self.dir / "hybrid-strip.json")
        make_hybrid_raster_strip_pdf(src)
        proc = run_processor(["extract", src, out])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        page = json.loads(Path(out).read_text())["pages"][0]
        strips = [
            region for region in page["visualRecoveryRegions"]
            if region.get("kind") == "raster-strip"
        ]
        self.assertGreaterEqual(len(strips), 1)
        for region in strips:
            self.assertGreaterEqual(region["bbox"][1], 120)
            self.assertLessEqual(region["bbox"][2] - region["bbox"][0] + 8, 900)
            self.assertLessEqual(
                (region["bbox"][2] - region["bbox"][0] + 8)
                * (region["bbox"][3] - region["bbox"][1] + 8)
                * (300 / 72) ** 2,
                3_000_000,
            )

    def test_extract_audits_rectangular_raster_legend(self) -> None:
        src = str(self.dir / "hybrid-legend.pdf")
        out = str(self.dir / "hybrid-legend.json")
        make_hybrid_raster_region_pdf(
            src,
            fitz.Rect(510, 250, 780, 430),
            width=270,
            height=180,
            lines=["Условные обозначения", "Стена существующая"],
        )
        proc = run_processor(["extract", src, out])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        regions = json.loads(Path(out).read_text())["pages"][0]["visualRecoveryRegions"]
        supplemental = [
            region for region in regions
            if region.get("kind") == "raster-region"
        ]
        self.assertGreaterEqual(len(supplemental), 1)
        self.assertTrue(all(region["bbox"][0] >= 500 for region in supplemental))

    def test_extract_audits_narrow_vertical_margin_note_region(self) -> None:
        src = str(self.dir / "hybrid-side-note.pdf")
        out = str(self.dir / "hybrid-side-note.json")
        make_hybrid_raster_region_pdf(
            src,
            fitz.Rect(10, 200, 170, 500),
            width=160,
            height=300,
            lines=["Примечания", "Монтаж выполнить", "по проекту"],
        )
        proc = run_processor(["extract", src, out])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        regions = json.loads(Path(out).read_text())["pages"][0]["visualRecoveryRegions"]
        supplemental = [
            region for region in regions
            if region.get("kind") == "raster-region"
        ]
        self.assertGreaterEqual(len(supplemental), 1)
        self.assertTrue(all(region["bbox"][2] <= 180 for region in supplemental))

    def test_dense_or_page_sized_raster_does_not_enable_general_ocr(self) -> None:
        src = str(self.dir / "dense-page.pdf")
        base = fitz.open()
        raster = base.new_page(width=800, height=600)
        for index in range(120):
            y = 10 + (index % 100) * 5
            raster.draw_line(fitz.Point(0, y), fitz.Point(800, y), width=0.4)
        pix = raster.get_pixmap(alpha=False)
        base.close()
        doc = fitz.open()
        page = doc.new_page(width=800, height=600)
        page.insert_image(page.rect, stream=pix.tobytes("png"))
        page.insert_text(fitz.Point(40, 560), "Selectable CAD label", fontsize=10)
        doc.save(src)
        doc.close()
        out = str(self.dir / "dense-page.json")
        proc = run_processor(["extract", src, out])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        regions = json.loads(Path(out).read_text())["pages"][0]["visualRecoveryRegions"]
        self.assertEqual(
            [region for region in regions if region.get("kind") == "raster-strip"],
            [],
        )

    def test_tiled_scan_with_token_text_layer_does_not_enable_general_ocr(self) -> None:
        src = str(self.dir / "tiled-scan.pdf")
        tile_source = fitz.open()
        tile_page = tile_source.new_page(width=800, height=90)
        tile_page.insert_text(
            fitz.Point(20, 52),
            "Примечания по монтажу кровли",
            fontsize=24,
            fontname="dejavu",
            fontfile="/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        )
        tile = tile_page.get_pixmap(alpha=False).tobytes("png")
        tile_source.close()
        doc = fitz.open()
        page = doc.new_page(width=800, height=600)
        for index, y0 in enumerate(range(120, 570, 90)):
            page.insert_image(fitz.Rect(0, y0, 800, min(600, y0 + 90)), stream=tile)
        page.insert_text(fitz.Point(20, 590), "x", fontsize=8)
        doc.save(src)
        doc.close()
        out = str(self.dir / "tiled-scan.json")
        proc = run_processor(["extract", src, out])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        regions = json.loads(Path(out).read_text())["pages"][0]["visualRecoveryRegions"]
        self.assertEqual(
            [region for region in regions if region.get("kind") == "raster-strip"],
            [],
        )

    def test_tiled_strip_audit_area_stays_bounded_with_selectable_text(self) -> None:
        import processor

        doc = fitz.open()
        page = doc.new_page(width=800, height=600)
        image_rects = [
            fitz.Rect(0, y0, 800, y0 + 80)
            for y0 in range(120, 520, 80)
        ]
        page_blocks = [{
            "id": "p1-l0",
            "text": "Selectable CAD label",
            "bbox": [20, 20, 150, 32],
            "suspicious": False,
        }, {
            "id": "p1-l1",
            "text": "Vector note reference",
            "bbox": [20, 42, 150, 54],
            "suspicious": False,
        }]
        audited: list[fitz.Rect] = []

        def record_audit(_page, strip, _selectable_boxes, _source_language="auto"):
            audited.append(strip)
            return []

        with patch.object(processor, "audit_raster_strip", side_effect=record_audit):
            regions, audits_used = processor.raster_strip_regions(
                page,
                1,
                image_rects,
                page_blocks,
                80,
            )
        self.assertEqual(regions, [])
        self.assertEqual(audits_used, len(audited))
        self.assertLessEqual(
            sum(rect.get_area() for rect in audited),
            page.rect.get_area() * processor.MAX_RASTER_STRIP_AUDIT_FRACTION,
        )
        self.assertLess(len(audited), len(image_rects))
        doc.close()

    def test_strip_audit_excludes_standards_and_model_identifiers(self) -> None:
        from processor import is_likely_source_language_note

        self.assertTrue(is_likely_source_language_note("Примечания по монтажу кровли"))
        self.assertFalse(is_likely_source_language_note("ГОСТ 21.101-2020"))
        self.assertFalse(is_likely_source_language_note("П-10"))
        self.assertFalse(is_likely_source_language_note("25 мм"))

    def test_crop_renders_only_bounded_recovery_region(self) -> None:
        src = str(self.dir / "crop-source.pdf")
        out = str(self.dir / "crop.jpg")
        make_sample_pdf(src, label="????")
        bbox = self._source_bbox(src, 0, "????1")
        proc = run_processor([
            "crop", src, "1", *[str(value) for value in bbox], out,
        ])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = last_json_line(proc.stdout)
        self.assertGreater(result["width"], 0)
        self.assertGreater(result["height"], 0)
        self.assertTrue(Path(out).read_bytes().startswith(b"\xff\xd8\xff"))

    def test_thumbnail_renders_one_original_page_for_review(self) -> None:
        src = str(self.dir / "source-thumbnail.pdf")
        out = str(self.dir / "source-page-1.jpg")
        make_sample_pdf(src)
        proc = run_processor(["thumbnail", src, "1", out])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(last_json_line(proc.stdout)["pageNumber"], 1)
        self.assertGreater(Path(out).stat().st_size, 100)
        self.assertTrue(Path(out).read_bytes().startswith(b"\xff\xd8\xff"))

    def test_crop_rejects_page_sized_private_image(self) -> None:
        src = str(self.dir / "oversized-crop-source.pdf")
        out = str(self.dir / "oversized-crop.jpg")
        make_sample_pdf(src, label="????")
        proc = run_processor([
            "crop", src, "1", "0", "0", "400", "300", out,
        ])
        self.assertEqual(proc.returncode, 2, proc.stdout)
        error = json.loads(proc.stderr.strip().splitlines()[-1])
        self.assertEqual(error["code"], "recovery_crop_too_large")
        self.assertFalse(Path(out).exists())

    def test_render_single_page_replaces_text_and_keeps_vectors(self) -> None:
        src = str(self.dir / "in.pdf")
        make_sample_pdf(src, pages=3, label="Ventana")
        bbox = self._source_bbox(src, 1, "Ventana2")
        translations = str(self.dir / "t.json")
        self._translations(translations, 2, "p2-l0", bbox, "Window")

        out_pdf = str(self.dir / "frag-2.pdf")
        thumb = str(self.dir / "thumb-2.jpg")
        out_json = str(self.dir / "meta-2.json")
        proc = run_processor(["render", src, translations, "2", out_pdf, thumb, out_json])
        self.assertEqual(proc.returncode, 0, proc.stderr)

        meta = last_json_line(proc.stdout)
        self.assertEqual(meta["pageNumber"], 2)
        self.assertEqual(meta["translatedBlockCount"], 1)
        self.assertEqual(meta["sourceBlockCount"], 1)
        self.assertEqual(meta["preview"], {
            "pixelWidth": 612,
            "pixelHeight": 459,
            "pageWidthPoints": 400.0,
            "pageHeightPoints": 300.0,
        })

        # metadata JSON file also written
        self.assertEqual(json.loads(Path(out_json).read_text())["pageNumber"], 2)

        # fragment is exactly one page
        frag = fitz.open(out_pdf)
        self.assertEqual(frag.page_count, 1)
        frag.close()

        # thumbnail produced and is a JPEG
        self.assertTrue(os.path.isfile(thumb))
        with open(thumb, "rb") as fh:
            self.assertEqual(fh.read(3), b"\xff\xd8\xff")

        # text replacement: English present, source Spanish gone from that page
        text = page_text(out_pdf, 0)
        self.assertIn("Window", text)
        self.assertNotIn("Ventana2", text)

        # vector content preserved (not rasterized): drawings still present,
        # and no raster image was introduced.
        self.assertGreater(count_drawings(out_pdf, 0), 0)
        frag = fitz.open(out_pdf)
        self.assertEqual(len(frag[0].get_images()), 0)
        frag.close()

    def test_render_replaces_text_touching_table_line_without_removing_vectors(self) -> None:
        src = str(self.dir / "table.pdf")
        doc = fitz.open()
        page = doc.new_page(width=400, height=300)
        page.draw_rect(fitz.Rect(40, 40, 360, 120), color=(0, 0, 0), width=1)
        page.draw_line(fitz.Point(40, 65), fitz.Point(360, 65), color=(0, 0, 0), width=1)
        page.insert_text(fitz.Point(60, 67), "TABLA", fontsize=12, fontname="helv")
        doc.save(src)
        doc.close()
        bbox = self._source_bbox(src, 0, "TABLA")
        translations = str(self.dir / "table-translations.json")
        self._translations(translations, 1, "p1-l0", bbox, "Schedule")
        out_pdf = str(self.dir / "table-output.pdf")
        proc = run_processor([
            "render", src, translations, "1", out_pdf,
            str(self.dir / "table.jpg"), str(self.dir / "table.json"),
        ])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("Schedule", page_text(out_pdf))
        self.assertNotIn("TABLA", page_text(out_pdf))
        self.assertGreaterEqual(count_drawings(out_pdf), 2)

    def test_render_fits_tightly_stacked_table_label_without_covering_neighbor(self) -> None:
        src = str(self.dir / "tight-table.pdf")
        doc = fitz.open()
        page = doc.new_page(width=200, height=100)
        page.insert_text(fitz.Point(20, 25), "SOURCE", fontsize=5, fontname="helv")
        page.insert_text(fitz.Point(20, 33), "NEIGHBOR", fontsize=5, fontname="helv")
        doc.save(src)
        doc.close()
        source_bbox = self._source_bbox(src, 0, "SOURCE")
        neighbor_bbox = self._source_bbox(src, 0, "NEIGHBOR")
        translations = str(self.dir / "tight-table-translations.json")
        Path(translations).write_text(json.dumps({
            "translations": [{
                "id": "p1-l0",
                "pageNumber": 1,
                "bbox": source_bbox,
                "fontSize": 5,
                "direction": [1, 0],
                "color": 0,
                "source": "SOURCE",
                "translation": "GENERAL",
                "uncertain": False,
            }],
            "obstacles": [
                {"id": "p1-l0", "pageNumber": 1, "bbox": source_bbox},
                {"id": "p1-l1", "pageNumber": 1, "bbox": neighbor_bbox},
            ],
        }), encoding="utf-8")
        out_pdf = str(self.dir / "tight-table-output.pdf")
        proc = run_processor([
            "render", src, translations, "1", out_pdf,
            str(self.dir / "tight-table.jpg"), str(self.dir / "tight-table.json"),
        ])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        text = page_text(out_pdf)
        self.assertIn("GENERAL", text)
        self.assertNotIn("SOURCE", text)
        self.assertIn("NEIGHBOR", text)

    def test_render_allows_tiny_overlap_between_lines_in_same_paragraph(self) -> None:
        src = str(self.dir / "dense-paragraph.pdf")
        doc = fitz.open()
        page = doc.new_page(width=300, height=160)
        sources = ["PRIMERA LINEA", "SEGUNDA LINEA", "TERCERA LINEA"]
        for index, source in enumerate(sources):
            page.insert_text(fitz.Point(24, 35 + index * 12), source, fontsize=10)
        doc.save(src)
        doc.close()

        boxes = [self._source_bbox(src, 0, source) for source in sources]
        # Reproduce extraction-rounding overlap while retaining realistic line
        # widths. Each consecutive pair shares 0.24 points vertically.
        boxes[0][3] = boxes[1][1] + 0.24
        boxes[1][3] = boxes[2][1] + 0.24
        translations = str(self.dir / "dense-paragraph-translations.json")
        items = [{
            "id": f"p1-l{index}",
            "paragraphId": "p1-b0",
            "layoutGroupCompact": False,
            "layoutGroupTranslation": "THIS STRAY GROUP PHRASE MUST BE IGNORED",
            "pageNumber": 1,
            "bbox": bbox,
            "fontSize": 10,
            "direction": [1, 0],
            "color": 0,
            "source": source,
            "translation": f"ENGLISH {index + 1}",
            "uncertain": False,
        } for index, (source, bbox) in enumerate(zip(sources, boxes))]
        Path(translations).write_text(json.dumps({
            "translations": items,
            "obstacles": [{
                "id": item["id"],
                "paragraphId": item["paragraphId"],
                "pageNumber": 1,
                "bbox": item["bbox"],
            } for item in items],
        }), encoding="utf-8")

        out_pdf = str(self.dir / "dense-paragraph-output.pdf")
        out_json = str(self.dir / "dense-paragraph-output.json")
        proc = run_processor([
            "render", src, translations, "1", out_pdf,
            str(self.dir / "dense-paragraph.jpg"), out_json,
        ])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        meta = json.loads(Path(out_json).read_text())
        self.assertEqual(meta["translatedBlockCount"], 3)
        text = page_text(out_pdf)
        for source in sources:
            self.assertNotIn(source, text)
        for index in range(3):
            self.assertIn(f"ENGLISH {index + 1}", text)

    def test_render_allows_existing_metric_overlap_when_both_lines_are_replaced(self) -> None:
        src = str(self.dir / "translated-neighbors.pdf")
        doc = fitz.open()
        page = doc.new_page(width=300, height=120)
        page.insert_text(fitz.Point(24, 35), "FIRST SOURCE", fontsize=10)
        page.insert_text(fitz.Point(36, 47), "SECOND SOURCE", fontsize=10)
        doc.save(src)
        doc.close()
        first_bbox = self._source_bbox(src, 0, "FIRST SOURCE")
        second_bbox = self._source_bbox(src, 0, "SECOND SOURCE")
        first_bbox[3] = second_bbox[1] + 0.24
        items = [{
            "id": f"p1-l{index}",
            "paragraphId": f"p1-b{index}",
            "placementGroupId": f"p1-pg{index}",
            "pageNumber": 1,
            "bbox": bbox,
            "fontSize": 10,
            "direction": [1, 0],
            "color": 0,
            "source": source,
            "translation": translation,
            "uncertain": False,
        } for index, (source, translation, bbox) in enumerate([
            ("FIRST SOURCE", "First", first_bbox),
            ("SECOND SOURCE", "Second", second_bbox),
        ])]
        translations = str(self.dir / "translated-neighbors.json")
        Path(translations).write_text(json.dumps({
            "translations": items,
            "obstacles": [{
                "id": item["id"],
                "paragraphId": item["paragraphId"],
                "placementGroupId": item["placementGroupId"],
                "pageNumber": 1,
                "bbox": item["bbox"],
            } for item in items],
        }), encoding="utf-8")
        out_pdf = str(self.dir / "translated-neighbors-output.pdf")
        out_json = str(self.dir / "translated-neighbors-output.json")
        proc = run_processor([
            "render", src, translations, "1", out_pdf,
            str(self.dir / "translated-neighbors.jpg"), out_json,
        ])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(Path(out_json).read_text())["translatedBlockCount"], 2)
        text = page_text(out_pdf)
        self.assertNotIn("FIRST SOURCE", text)
        self.assertNotIn("SECOND SOURCE", text)
        self.assertIn("First", text)
        self.assertIn("Second", text)

    def test_layout_groups_join_split_header_blocks_without_joining_next_column(self) -> None:
        sys.path.insert(0, str(HERE))
        try:
            import processor
        finally:
            sys.path.pop(0)
        blocks = [{
            "id": "p1-l0",
            "paragraphId": "p1-b0",
            "text": "Номер",
            "bbox": [20, 20, 52, 33],
            "fontSize": 10,
            "direction": [1, 0],
            "color": 0,
        }, {
            "id": "p1-l1",
            "paragraphId": "p1-b0",
            "text": "поме-",
            "bbox": [20.4, 31, 51.5, 44],
            "fontSize": 10,
            "direction": [1, 0],
            "color": 0,
        }, {
            "id": "p1-l2",
            "paragraphId": "p1-b1",
            "text": "щения",
            "bbox": [19.8, 42, 52.2, 55],
            "fontSize": 10,
            "direction": [1, 0],
            "color": 0,
        }, {
            "id": "p1-l3",
            "paragraphId": "p1-b2",
            "text": "Площадь",
            "bbox": [80, 29, 125, 42],
            "fontSize": 10,
            "direction": [1, 0],
            "color": 0,
        }]
        processor.assign_layout_groups(blocks, 1)
        self.assertEqual(blocks[0]["placementGroupId"], blocks[1]["placementGroupId"])
        self.assertEqual(blocks[1]["placementGroupId"], blocks[2]["placementGroupId"])
        self.assertNotEqual(blocks[2]["placementGroupId"], blocks[3]["placementGroupId"])
        self.assertIsNone(blocks[0]["compactGroupId"])
        self.assertEqual(blocks[1]["compactGroupId"], blocks[2]["compactGroupId"])
        self.assertEqual(blocks[1]["layoutGroupId"], blocks[2]["layoutGroupId"])
        self.assertNotEqual(blocks[0]["layoutGroupId"], blocks[1]["layoutGroupId"])
        self.assertNotEqual(blocks[2]["layoutGroupId"], blocks[3]["layoutGroupId"])
        self.assertFalse(blocks[0]["layoutGroupCompact"])
        self.assertTrue(blocks[1]["layoutGroupCompact"])
        self.assertTrue(blocks[2]["layoutGroupCompact"])

    def test_compact_group_excludes_unrelated_heading_in_same_pdf_block(self) -> None:
        sys.path.insert(0, str(HERE))
        try:
            import processor
        finally:
            sys.path.pop(0)
        blocks = [{
            "id": f"p1-l{index}",
            "paragraphId": "p1-b0",
            "text": text,
            "bbox": [20, 20 + index * 11, 80, 31 + index * 11],
            "fontSize": 10,
            "direction": [1, 0],
            "color": 0,
        } for index, text in enumerate(["TITLE", "pome-", "shcheniya"])]
        processor.assign_layout_groups(blocks, 1)
        self.assertNotEqual(blocks[0]["layoutGroupId"], blocks[1]["layoutGroupId"])
        self.assertEqual(blocks[1]["layoutGroupId"], blocks[2]["layoutGroupId"])
        self.assertFalse(blocks[0]["layoutGroupCompact"])
        self.assertTrue(blocks[1]["layoutGroupCompact"])
        self.assertTrue(blocks[2]["layoutGroupCompact"])

    def test_layout_groups_do_not_merge_ordinary_rows_in_one_column(self) -> None:
        sys.path.insert(0, str(HERE))
        try:
            import processor
        finally:
            sys.path.pop(0)
        blocks = [{
            "id": f"p1-l{index}",
            "paragraphId": f"p1-b{index}",
            "text": text,
            "bbox": [20, 20 + index * 11, 80, 31 + index * 11],
            "fontSize": 10,
            "direction": [1, 0],
            "color": 0,
        } for index, text in enumerate(["Garage", "Storage room", "Corridor"])]
        processor.assign_layout_groups(blocks, 1)
        self.assertEqual(len({block["layoutGroupId"] for block in blocks}), 3)

    def test_layout_groups_join_indented_unit_after_punctuated_header(self) -> None:
        sys.path.insert(0, str(HERE))
        try:
            import processor
        finally:
            sys.path.pop(0)
        blocks = [{
            "id": "p1-l0",
            "paragraphId": "p1-b0",
            "text": "Площадь,",
            "bbox": [20, 20, 68, 33],
            "fontSize": 10,
            "direction": [1, 0],
            "color": 0,
        }, {
            "id": "p1-l1",
            "paragraphId": "p1-b1",
            "text": "м2",
            "bbox": [36, 31, 50, 44],
            "fontSize": 10,
            "direction": [1, 0],
            "color": 0,
        }]
        processor.assign_layout_groups(blocks, 1)
        self.assertEqual(blocks[0]["placementGroupId"], blocks[1]["placementGroupId"])
        self.assertIsNone(blocks[0]["compactGroupId"])
        self.assertIsNone(blocks[1]["compactGroupId"])
        self.assertFalse(blocks[0]["layoutGroupCompact"])
        self.assertFalse(blocks[1]["layoutGroupCompact"])

    def test_preflight_rejects_unreadable_fit_and_page_clipping(self) -> None:
        sys.path.insert(0, str(HERE))
        try:
            import processor
        finally:
            sys.path.pop(0)
        doc = fitz.open()
        page = doc.new_page(width=100, height=100)
        long_item = {
            "id": "p1-l0",
            "bbox": [10, 10, 34, 18],
            "fontSize": 10,
            "direction": [1, 0],
            "translation": "A translation that only fits at an unreadable size",
            "uncertain": False,
            "color": 0,
        }
        placement, category = processor.preflight_text(page, long_item, [])
        self.assertIsNone(placement)
        self.assertEqual(category, "text_too_long")

        clipped_item = {
            **long_item,
            "id": "p1-l1",
            "bbox": [-4, 30, 20, 40],
            "fontSize": 8,
            "translation": "Edge",
        }
        placement, _category = processor.preflight_text(page, clipped_item, [])
        self.assertIsNone(placement)
        doc.close()

    def test_vertical_margin_text_expands_away_from_adjacent_linework(self) -> None:
        sys.path.insert(0, str(HERE))
        try:
            import processor
        finally:
            sys.path.pop(0)
        doc = fitz.open()
        page = doc.new_page(width=100, height=100)
        item = {
            "id": "p1-l0",
            "bbox": [20, 30, 28, 74],
            "fontSize": 8,
            "direction": [0, -1],
            "translation": "Orig. inv. No.",
            "uncertain": False,
            "color": 0,
        }
        linework = processor.LineworkIndex([fitz.Rect(28.6, 25, 31, 80)])
        placement, category = processor.preflight_text(page, item, [], linework)
        self.assertEqual(category, "placed")
        self.assertIsNotNone(placement)
        self.assertLess(placement[0].x0, item["bbox"][0])
        self.assertLessEqual(placement[0].x1, item["bbox"][2] + 1.0)
        doc.close()

    def test_linework_boxes_include_quad_paths_and_stroke_width(self) -> None:
        sys.path.insert(0, str(HERE))
        try:
            import processor
        finally:
            sys.path.pop(0)
        doc = fitz.open()
        page = doc.new_page(width=100, height=100)
        shape = page.new_shape()
        shape.draw_quad(fitz.Quad(
            fitz.Point(20, 20),
            fitz.Point(60, 20),
            fitz.Point(20, 40),
            fitz.Point(60, 40),
        ))
        shape.finish(width=6)
        shape.commit()
        boxes = processor.linework_boxes(page)
        self.assertTrue(boxes)
        union = fitz.Rect(
            min(box.x0 for box in boxes),
            min(box.y0 for box in boxes),
            max(box.x1 for box in boxes),
            max(box.y1 for box in boxes),
        )
        self.assertLessEqual(union.x0, 16.75)
        self.assertGreaterEqual(union.x1, 63.25)
        doc.close()

    def test_layout_group_neighbor_search_is_bounded_in_dense_cells(self) -> None:
        sys.path.insert(0, str(HERE))
        try:
            import processor
        finally:
            sys.path.pop(0)
        blocks = [{
            "id": f"p1-l{index}",
            "paragraphId": f"p1-b{index}",
            "text": "ROW",
            "bbox": [20, 20, 40, 30],
            "fontSize": 8,
            "direction": [1, 0],
            "color": 0,
        } for index in range(2_000)]
        with patch.object(
            processor,
            "_layout_blocks_are_adjacent",
            wraps=processor._layout_blocks_are_adjacent,
        ) as adjacency:
            processor.assign_layout_groups(blocks, 1)
        self.assertLessEqual(adjacency.call_count, 2_000 * 16)

    def test_render_places_one_coherent_translation_for_split_layout_group(self) -> None:
        src = str(self.dir / "split-header.pdf")
        doc = fitz.open()
        page = doc.new_page(width=240, height=140)
        sources = ["ROOM", "NUM-", "BER"]
        for index, source in enumerate(sources):
            page.insert_text(fitz.Point(24, 35 + index * 12), source, fontsize=10)
        page.insert_text(fitz.Point(110, 47), "AREA", fontsize=10)
        doc.save(src)
        doc.close()
        boxes = [self._source_bbox(src, 0, source) for source in sources]
        area_bbox = self._source_bbox(src, 0, "AREA")
        translations = str(self.dir / "split-header-translations.json")
        items = [{
            "id": f"p1-l{index}",
            "paragraphId": f"p1-b{min(index, 1)}",
            "layoutGroupId": "p1-g0",
            "layoutGroupCompact": True,
            "layoutGroupTranslation": "Room No.",
            "pageNumber": 1,
            "bbox": bbox,
            "fontSize": 10,
            "direction": [1, 0],
            "color": 0,
            "source": source,
            "translation": ["Room", "Number", "Fragment"][index],
            "uncertain": False,
        } for index, (source, bbox) in enumerate(zip(sources, boxes))]
        Path(translations).write_text(json.dumps({
            "translations": items,
            "obstacles": [
                *[{
                    "id": item["id"],
                    "paragraphId": item["paragraphId"],
                    "layoutGroupId": item["layoutGroupId"],
                    "pageNumber": 1,
                    "bbox": item["bbox"],
                } for item in items],
                {
                    "id": "p1-l3",
                    "paragraphId": "p1-b2",
                    "layoutGroupId": "p1-g1",
                    "pageNumber": 1,
                    "bbox": area_bbox,
                },
            ],
        }), encoding="utf-8")
        out_pdf = str(self.dir / "split-header-output.pdf")
        out_json = str(self.dir / "split-header-output.json")
        proc = run_processor([
            "render", src, translations, "1", out_pdf,
            str(self.dir / "split-header.jpg"), out_json,
        ])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        meta = json.loads(Path(out_json).read_text())
        self.assertEqual(meta["translatedBlockCount"], 3)
        self.assertEqual(meta["warnings"], [])
        text = page_text(out_pdf)
        for source in sources:
            self.assertNotIn(source, text)
        normalized = " ".join(text.split())
        self.assertEqual(normalized.count("Room No."), 1)
        self.assertIn("AREA", text)

    def test_render_plans_room_header_with_nested_compact_group_atomically(self) -> None:
        src = str(self.dir / "nested-room-header.pdf")
        doc = fitz.open()
        page = doc.new_page(width=240, height=140)
        sources = ["ROOM", "NUM-", "BER"]
        for index, source in enumerate(sources):
            page.insert_text(fitz.Point(24, 35 + index * 11), source, fontsize=10)
        page.insert_text(fitz.Point(110, 46), "AREA", fontsize=10)
        doc.save(src)
        doc.close()
        boxes = [self._source_bbox(src, 0, source) for source in sources]
        area_bbox = self._source_bbox(src, 0, "AREA")
        translations = str(self.dir / "nested-room-header-translations.json")
        items = [{
            "id": f"p1-l{index}",
            "paragraphId": f"p1-b{min(index, 1)}",
            "placementGroupId": "p1-pg0",
            "compactGroupId": "p1-cg0" if index > 0 else None,
            "compactGroupCompact": index > 0,
            "compactGroupTranslation": "Number" if index > 0 else None,
            "layoutGroupId": "p1-cg0" if index > 0 else "p1-g0",
            "layoutGroupCompact": index > 0,
            "layoutGroupTranslation": "Number" if index > 0 else None,
            "pageNumber": 1,
            "bbox": bbox,
            "fontSize": 10,
            "direction": [1, 0],
            "color": 0,
            "source": source,
            "translation": ["Room", "Num", "ber"][index],
            "uncertain": False,
        } for index, (source, bbox) in enumerate(zip(sources, boxes))]
        obstacles = [{
            "id": item["id"],
            "paragraphId": item["paragraphId"],
            "placementGroupId": item["placementGroupId"],
            "compactGroupId": item["compactGroupId"],
            "pageNumber": 1,
            "bbox": item["bbox"],
        } for item in items]
        obstacles.append({
            "id": "p1-l3",
            "paragraphId": "p1-b2",
            "placementGroupId": "p1-pg1",
            "pageNumber": 1,
            "bbox": area_bbox,
        })
        Path(translations).write_text(json.dumps({
            "translations": items,
            "obstacles": obstacles,
        }), encoding="utf-8")
        out_pdf = str(self.dir / "nested-room-header-output.pdf")
        out_json = str(self.dir / "nested-room-header-output.json")
        proc = run_processor([
            "render", src, translations, "1", out_pdf,
            str(self.dir / "nested-room-header.jpg"), out_json,
        ])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        meta = json.loads(Path(out_json).read_text())
        self.assertEqual(meta["translatedBlockCount"], 3)
        self.assertEqual(meta["warnings"], [])
        text = page_text(out_pdf)
        self.assertNotIn("ROOM", text)
        self.assertNotIn("NUM-", text)
        self.assertNotIn("BER", text)
        self.assertIn("Room", text)
        self.assertIn("Number", "".join(text.split()))
        self.assertIn("AREA", text)

    def test_render_layout_group_failure_keeps_every_source_fragment(self) -> None:
        src = str(self.dir / "atomic-group.pdf")
        doc = fitz.open()
        page = doc.new_page(width=180, height=100)
        sources = ["FIRST", "SECOND"]
        for index, source in enumerate(sources):
            page.insert_text(fitz.Point(20, 30 + index * 12), source, fontsize=9)
        doc.save(src)
        doc.close()
        source_boxes = [self._source_bbox(src, 0, source) for source in sources]
        tiny_boxes = [
            [box[0], box[1], box[0] + 1, box[1] + 1]
            for box in source_boxes
        ]
        translations = str(self.dir / "atomic-group-translations.json")
        items = [{
            "id": f"p1-l{index}",
            "paragraphId": f"p1-b{index}",
            "layoutGroupId": "p1-g0",
            "layoutGroupTranslation": "A replacement phrase that cannot fit inside this tiny bounded region",
            "pageNumber": 1,
            "bbox": bbox,
            "fontSize": 9,
            "direction": [1, 0],
            "color": 0,
            "source": source,
            "translation": "English",
            "uncertain": index == 1,
        } for index, (source, bbox) in enumerate(zip(sources, tiny_boxes))]
        Path(translations).write_text(json.dumps({
            "translations": items,
            "obstacles": [{
                "id": item["id"],
                "paragraphId": item["paragraphId"],
                "layoutGroupId": item["layoutGroupId"],
                "pageNumber": 1,
                "bbox": item["bbox"],
            } for item in items],
        }), encoding="utf-8")
        out_pdf = str(self.dir / "atomic-group-output.pdf")
        out_json = str(self.dir / "atomic-group-output.json")
        proc = run_processor([
            "render", src, translations, "1", out_pdf,
            str(self.dir / "atomic-group.jpg"), out_json,
        ])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        meta = json.loads(Path(out_json).read_text())
        self.assertEqual(meta["translatedBlockCount"], 0)
        self.assertEqual(len(meta["warnings"]), 2)
        text = page_text(out_pdf)
        for source in sources:
            self.assertIn(source, text)
        self.assertNotIn("replacement phrase", text)

    def test_render_blocks_tiny_overlap_with_unrelated_label(self) -> None:
        src = str(self.dir / "unrelated-overlap.pdf")
        doc = fitz.open()
        page = doc.new_page(width=300, height=120)
        page.insert_text(fitz.Point(24, 35), "SOURCE LABEL", fontsize=10)
        page.insert_text(fitz.Point(24, 47), "OTHER LABEL", fontsize=10)
        doc.save(src)
        doc.close()
        source_bbox = self._source_bbox(src, 0, "SOURCE LABEL")
        other_bbox = self._source_bbox(src, 0, "OTHER LABEL")
        source_bbox[3] = other_bbox[1] + 0.24
        translations = str(self.dir / "unrelated-overlap-translations.json")
        Path(translations).write_text(json.dumps({
            "translations": [{
                "id": "p1-l0",
                "paragraphId": "p1-b0",
                "pageNumber": 1,
                "bbox": source_bbox,
                "fontSize": 10,
                "direction": [1, 0],
                "color": 0,
                "source": "SOURCE LABEL",
                "translation": "ENGLISH LABEL",
                "uncertain": False,
            }],
            "obstacles": [
                {"id": "p1-l0", "paragraphId": "p1-b0", "pageNumber": 1, "bbox": source_bbox},
                {"id": "p1-l1", "paragraphId": "p1-b1", "pageNumber": 1, "bbox": other_bbox},
            ],
        }), encoding="utf-8")
        out_pdf = str(self.dir / "unrelated-overlap-output.pdf")
        out_json = str(self.dir / "unrelated-overlap-output.json")
        proc = run_processor([
            "render", src, translations, "1", out_pdf,
            str(self.dir / "unrelated-overlap.jpg"), out_json,
        ])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(Path(out_json).read_text())["translatedBlockCount"], 0)
        text = page_text(out_pdf)
        self.assertIn("SOURCE LABEL", text)
        self.assertIn("OTHER LABEL", text)
        self.assertNotIn("ENGLISH LABEL", text)

    def test_render_preserves_vertical_text_orientation(self) -> None:
        src = str(self.dir / "rotated.pdf")
        doc = fitz.open()
        page = doc.new_page(width=400, height=300)
        page.draw_rect(fitz.Rect(40, 40, 360, 260), color=(0, 0, 0), width=1)
        page.insert_text(
            fitz.Point(80, 220),
            "VERTICAL_SOURCE",
            fontsize=11,
            fontname="helv",
            rotate=90,
        )
        doc.save(src)
        doc.close()
        extracted = str(self.dir / "rotated-blocks.json")
        proc = run_processor(["extract", src, extracted])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        block = json.loads(Path(extracted).read_text())["pages"][0]["blocks"][0]
        translations = str(self.dir / "rotated-translations.json")
        Path(translations).write_text(json.dumps({
            "translations": [{
                "id": block["id"],
                "pageNumber": 1,
                "bbox": block["bbox"],
                "fontSize": block["fontSize"],
                "direction": block["direction"],
                "color": 0,
                "source": block["text"],
                "translation": "VERTICAL",
                "uncertain": False,
            }],
            "obstacles": [],
        }), encoding="utf-8")
        out_pdf = str(self.dir / "rotated-output.pdf")
        proc = run_processor([
            "render", src, translations, "1", out_pdf,
            str(self.dir / "rotated.jpg"), str(self.dir / "rotated.json"),
        ])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("VERTICAL", page_text(out_pdf))
        out = fitz.open(out_pdf)
        english_line = next(
            line
            for text_block in out[0].get_text("dict")["blocks"]
            if text_block.get("type") == 0
            for line in text_block.get("lines", [])
            if "VERTICAL" in "".join(span["text"] for span in line["spans"])
        )
        out.close()
        self.assertLess(abs(float(english_line["dir"][0])), 0.1)
        self.assertGreater(abs(float(english_line["dir"][1])), 0.9)

    def test_render_keeps_noncardinal_text_visible(self) -> None:
        src = str(self.dir / "noncardinal.pdf")
        make_sample_pdf(src, label="SOURCE")
        bbox = self._source_bbox(src, 0, "SOURCE1")
        translations = str(self.dir / "noncardinal-translations.json")
        Path(translations).write_text(json.dumps({
            "translations": [{
                "id": "p1-l0",
                "pageNumber": 1,
                "bbox": bbox,
                "fontSize": 10,
                "direction": [0.70710678, -0.70710678],
                "color": 0,
                "source": "SOURCE1",
                "translation": "TRANSLATED",
                "uncertain": False,
            }],
            "obstacles": [],
        }), encoding="utf-8")
        out_pdf = str(self.dir / "noncardinal-output.pdf")
        out_json = str(self.dir / "noncardinal-output.json")
        proc = run_processor([
            "render", src, translations, "1", out_pdf,
            str(self.dir / "noncardinal.jpg"), out_json,
        ])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        text = page_text(out_pdf)
        self.assertIn("SOURCE1", text)
        self.assertNotIn("TRANSLATED", text)
        meta = json.loads(Path(out_json).read_text())
        self.assertEqual(meta["translatedBlockCount"], 0)
        self.assertEqual(len(meta["warnings"]), 1)
        self.assertEqual(meta["warnings"][0]["blockId"], "p1-l0")
        self.assertEqual(meta["warnings"][0]["sourceText"], "SOURCE1")
        self.assertEqual(meta["warnings"][0]["rejectionCategory"], "unsupported_direction")
        self.assertEqual(meta["warnings"][0]["bbox"], bbox)

    def test_render_covers_raster_source_only_after_replacement_fits(self) -> None:
        src = str(self.dir / "raster-source.pdf")
        bbox = make_raster_title_pdf(src)
        translations = str(self.dir / "raster-translations.json")
        Path(translations).write_text(json.dumps({
            "translations": [{
                "id": "p1-raster-title-l0",
                "pageNumber": 1,
                "bbox": bbox,
                "fontSize": 14,
                "direction": [1, 0],
                "color": 0,
                "source": "LONG_SOURCE_TITLE",
                "translation": "Roof Plan",
                "uncertain": False,
                "rasterBacked": True,
            }],
            "obstacles": [],
        }), encoding="utf-8")
        out_pdf = str(self.dir / "raster-output.pdf")
        out_json = str(self.dir / "raster-output.json")
        proc = run_processor([
            "render", src, translations, "1", out_pdf,
            str(self.dir / "raster-output.jpg"), out_json,
        ])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("Roof Plan", page_text(out_pdf))
        meta = json.loads(Path(out_json).read_text())
        self.assertEqual(meta["translatedBlockCount"], 1)
        output = fitz.open(out_pdf)
        self.assertGreaterEqual(len(output[0].get_images(full=True)), 1)
        output.close()

    def test_render_keeps_raster_pixels_when_replacement_does_not_fit(self) -> None:
        src = str(self.dir / "raster-no-fit-source.pdf")
        bbox = make_raster_title_pdf(src)
        tiny_bbox = [bbox[0], bbox[1], bbox[0] + 2, bbox[1] + 2]
        translations = str(self.dir / "raster-no-fit-translations.json")
        Path(translations).write_text(json.dumps({
            "translations": [{
                "id": "p1-raster-strip-0-l0",
                "pageNumber": 1,
                "bbox": tiny_bbox,
                "fontSize": 14,
                "direction": [1, 0],
                "color": 0,
                "source": "LONG_SOURCE_TITLE",
                "translation": "A replacement that cannot possibly fit",
                "uncertain": False,
                "rasterBacked": True,
            }],
            "obstacles": [],
        }), encoding="utf-8")
        out_pdf = str(self.dir / "raster-no-fit-output.pdf")
        out_json = str(self.dir / "raster-no-fit-output.json")
        proc = run_processor([
            "render", src, translations, "1", out_pdf,
            str(self.dir / "raster-no-fit-output.jpg"), out_json,
        ])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        meta = json.loads(Path(out_json).read_text())
        self.assertEqual(meta["translatedBlockCount"], 0)
        self.assertEqual(len(meta["warnings"]), 1)
        self.assertEqual(meta["warnings"][0]["rejectionCategory"], "text_too_long")
        source = fitz.open(src)
        output = fitz.open(out_pdf)
        self.assertEqual(source[0].get_pixmap(alpha=False).samples, output[0].get_pixmap(alpha=False).samples)
        source.close()
        output.close()

    def test_render_rejects_out_of_range_page(self) -> None:
        src = str(self.dir / "in.pdf")
        make_sample_pdf(src, pages=2)
        translations = str(self.dir / "t.json")
        self._translations(translations, 1, "p1-l0", [60, 50, 120, 65], "Door")

        proc = run_processor([
            "render", src, translations, "9",
            str(self.dir / "o.pdf"), str(self.dir / "o.jpg"), str(self.dir / "o.json"),
        ])
        self.assertEqual(proc.returncode, 2, proc.stdout)
        err = json.loads(proc.stderr.strip().splitlines()[-1])
        self.assertEqual(err["kind"], "document_rejected")
        self.assertEqual(err["code"], "page_out_of_range")

    def test_render_zero_page_rejected(self) -> None:
        src = str(self.dir / "in.pdf")
        make_sample_pdf(src, pages=1)
        translations = str(self.dir / "t.json")
        self._translations(translations, 1, "p1-l0", [60, 50, 120, 65], "Door")
        proc = run_processor([
            "render", src, translations, "0",
            str(self.dir / "o.pdf"), str(self.dir / "o.jpg"), str(self.dir / "o.json"),
        ])
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(json.loads(proc.stderr.strip().splitlines()[-1])["code"], "page_out_of_range")

    def test_render_preserves_geometry(self) -> None:
        """The one-page fragment keeps the original page dimensions."""
        src = str(self.dir / "in.pdf")
        make_sample_pdf(src, pages=2)
        translations = str(self.dir / "t.json")
        bbox = self._source_bbox(src, 0, "Puerta1")
        self._translations(translations, 1, "p1-l0", bbox, "Door")
        out_pdf = str(self.dir / "frag.pdf")
        proc = run_processor([
            "render", src, translations, "1", out_pdf,
            str(self.dir / "o.jpg"), str(self.dir / "o.json"),
        ])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        frag = fitz.open(out_pdf)
        rect = frag[0].rect
        frag.close()
        self.assertAlmostEqual(rect.width, 400, delta=0.5)
        self.assertAlmostEqual(rect.height, 300, delta=0.5)


class ProcessorMergeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _one_page(self, path: str, marker: str) -> None:
        doc = fitz.open()
        page = doc.new_page(width=300, height=200)
        page.draw_rect(fitz.Rect(10, 10, 290, 190), color=(0, 0, 0), width=1.0)
        page.insert_text(fitz.Point(40, 40), marker, fontsize=14, fontname="helv")
        doc.save(path)
        doc.close()

    def test_merge_preserves_order_and_count_without_rasterizing(self) -> None:
        f1 = str(self.dir / "a.pdf")
        f2 = str(self.dir / "b.pdf")
        f3 = str(self.dir / "c.pdf")
        self._one_page(f1, "ALPHA")
        self._one_page(f2, "BRAVO")
        self._one_page(f3, "CHARLIE")
        out = str(self.dir / "merged.pdf")

        # Deliberately non-alphabetical, caller-controlled order.
        proc = run_processor(["merge", out, f3, f1, f2])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = last_json_line(proc.stdout)
        self.assertEqual(result["pageCount"], 3)
        self.assertEqual(result["fragmentCount"], 3)

        doc = fitz.open(out)
        self.assertEqual(doc.page_count, 3)
        # Explicit order preserved: CHARLIE, ALPHA, BRAVO.
        self.assertIn("CHARLIE", doc[0].get_text())
        self.assertIn("ALPHA", doc[1].get_text())
        self.assertIn("BRAVO", doc[2].get_text())
        # Vector content preserved on every merged page; no rasterization.
        for i in range(3):
            self.assertGreater(len(doc[i].get_drawings()), 0)
            self.assertEqual(len(doc[i].get_images()), 0)
        doc.close()

    def test_merge_rejects_missing_fragment(self) -> None:
        f1 = str(self.dir / "a.pdf")
        self._one_page(f1, "ONLY")
        out = str(self.dir / "merged.pdf")
        proc = run_processor(["merge", out, f1, str(self.dir / "missing.pdf")])
        self.assertEqual(proc.returncode, 2, proc.stdout)
        self.assertEqual(json.loads(proc.stderr.strip().splitlines()[-1])["code"], "fragment_missing")
        self.assertFalse(os.path.exists(out))

    def test_merge_rejects_multi_page_fragment(self) -> None:
        multi = str(self.dir / "multi.pdf")
        doc = fitz.open()
        doc.new_page(width=200, height=200)
        doc.new_page(width=200, height=200)
        doc.save(multi)
        doc.close()
        out = str(self.dir / "merged.pdf")
        proc = run_processor(["merge", out, multi])
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(
            json.loads(proc.stderr.strip().splitlines()[-1])["code"],
            "fragment_not_single_page",
        )

    def test_merge_rejects_invalid_pdf(self) -> None:
        bad = str(self.dir / "bad.pdf")
        Path(bad).write_bytes(b"not a pdf at all")
        out = str(self.dir / "merged.pdf")
        proc = run_processor(["merge", out, bad])
        self.assertEqual(proc.returncode, 2)
        code = json.loads(proc.stderr.strip().splitlines()[-1])["code"]
        self.assertIn(code, {"fragment_invalid", "invalid_pdf"})

    def test_merge_requires_at_least_one_fragment(self) -> None:
        # No fragments -> argument error before reaching merge().
        proc = run_processor(["merge", str(self.dir / "merged.pdf")])
        self.assertNotEqual(proc.returncode, 0)


class ProcessorArgumentTests(unittest.TestCase):
    def test_unknown_command(self) -> None:
        proc = run_processor(["bogus"])
        self.assertNotEqual(proc.returncode, 0)

    def test_render_wrong_arg_count(self) -> None:
        proc = run_processor(["render", "a.pdf", "b.json"])
        self.assertNotEqual(proc.returncode, 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
