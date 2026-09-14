"""Regression tests for dxf_processor (run with python -m unittest)."""
import unittest
import sys
import re
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import dxf_processor
import hashlib
import json
import tempfile
from dxf_processor import DxfRejected, _is_preserved_drawing_code, inventory, main, parse_pairs, patch, preview


def _complete_test_records(body: str) -> str:
    """Add minimum structural fields to focused synthetic entity fixtures."""
    lines = body.splitlines(keepends=True)
    starts = [i for i in range(0, len(lines), 2) if lines[i].strip() == "0"]
    starts.append(len(lines))
    output: list[str] = []
    for index in range(len(starts) - 1):
        chunk = lines[starts[index]:starts[index + 1]]
        output.extend(chunk)
        codes = {lines[i].strip() for i in range(starts[index], starts[index + 1], 2)}
        if ("5" in codes or "105" in codes) and chunk[1].strip() not in {"IMAGE"}:
            if "330" not in codes:
                output.extend(["330\r\n", "0\r\n"])
            if "100" not in codes:
                output.extend(["100\r\n", "AcDbEntity\r\n"])
    return "".join(output)


def tiny(body: str, complete: bool = True) -> bytes:
    if complete:
        body = _complete_test_records(body)
    return ("  0\r\nSECTION\r\n  2\r\nHEADER\r\n  9\r\n$ACADVER\r\n  1\r\nAC1032\r\n"
            "  0\r\nENDSEC\r\n  0\r\nSECTION\r\n  2\r\nENTITIES\r\n" + body +
            "  0\r\nENDSEC\r\n  0\r\nEOF\r\n").encode()


def with_blocks(block_body: str, entities_body: str = "") -> bytes:
    return (
        "  0\r\nSECTION\r\n  2\r\nHEADER\r\n  9\r\n$ACADVER\r\n  1\r\nAC1032\r\n"
        "  0\r\nENDSEC\r\n  0\r\nSECTION\r\n  2\r\nBLOCKS\r\n"
        + block_body +
        "  0\r\nENDSEC\r\n  0\r\nSECTION\r\n  2\r\nENTITIES\r\n"
        + entities_body +
        "  0\r\nENDSEC\r\n  0\r\nEOF\r\n"
    ).encode()


def with_section(name: str, body: str) -> bytes:
    return (
        "  0\r\nSECTION\r\n  2\r\nHEADER\r\n  9\r\n$ACADVER\r\n  1\r\nAC1032\r\n"
        "  0\r\nENDSEC\r\n  0\r\nSECTION\r\n  2\r\n" + name + "\r\n" + body +
        "  0\r\nENDSEC\r\n  0\r\nSECTION\r\n  2\r\nENTITIES\r\n"
        "  0\r\nENDSEC\r\n  0\r\nEOF\r\n"
    ).encode()


class DxfProcessorTests(unittest.TestCase):
    def test_utf8_bom_is_accepted_without_changing_source_bytes(self):
        raw = b"\xef\xbb\xbf" + tiny(
            "  0\r\nMTEXT\r\n  5\r\nA\r\n 40\r\n2\r\n 41\r\n80\r\n  1\r\nПривет\r\n"
        )
        info = inventory(raw)
        self.assertEqual(info["cyrillicTargetCount"], 1)
        changed, report = patch(raw, {"A": "Hello"})
        self.assertTrue(changed.startswith(b"\xef\xbb\xbf"))
        self.assertTrue(report["nonApprovedSegmentsIdentical"])

    def test_utf8_crlf_and_surgical_patch(self):
        raw = tiny("  0\r\nMTEXT\r\n  5\r\nA\r\n 10\r\n1\r\n 20\r\n2\r\n 40\r\n2\r\n  1\r\nПривет\r\n")
        info = inventory(raw)
        self.assertEqual(info["lineEnding"], "CRLF")
        self.assertEqual(info["cyrillicTargetCount"], 1)
        changed, report = patch(raw, {"A": "Hello"})
        self.assertIn(b"Hello\r\n", changed)
        self.assertEqual(len(report["approvedChanges"]), 1)
        self.assertEqual(parse_pairs(changed)[0].value, b"SECTION")

    def test_utf8_continuation_bytes_are_not_mistaken_for_line_endings(self):
        raw = tiny(
            "  0\r\nMTEXT\r\n  5\r\nA\r\n 10\r\n1\r\n 20\r\n2\r\n"
            " 40\r\n2\r\n 41\r\n80\r\n  1\r\nВыход\r\n"
        )
        self.assertIn(b"\x85", "Выход".encode("utf-8"))
        info = inventory(raw)
        self.assertEqual(info["mtext"][0]["plainText"], "Выход")
        changed, report = patch(raw, {"A": "Exit"})
        self.assertIn(b"Exit\r\n", changed)
        self.assertEqual(len(report["approvedChanges"]), 1)

    def test_fragmented_mtext_and_multileader_are_surgically_patchable(self):
        for kind, code, fragments, replacement in (
            ("MTEXT", (3, 1), ("При", "вет"), "こんにちは"),
            ("MTEXT", (3, 3, 3, 1), ("О", "дин", "два", "три"), "Hi"),
            ("MULTILEADER", (304, 304), ("Вы", "носка"), "Note"),
            ("MULTILEADER", (304, 304, 304, 304), ("Д", "лин", "ный", "текст"), "Short"),
        ):
            with self.subTest(kind=kind, fragment_count=len(fragments)):
                fields = "".join(
                    f"{group:3d}\r\n{fragment}\r\n"
                    for group, fragment in zip(code, fragments)
                )
                raw = b"\xef\xbb\xbf" + tiny(
                    f"  0\r\n{kind}\r\n  5\r\nA\r\n 40\r\n2\r\n 41\r\n80\r\n" + fields
                )
                before = inventory(raw)
                document = (
                    {"targetLanguage": "ja", "translations": {"A": replacement}}
                    if replacement == "こんにちは" else {"A": replacement}
                )
                changed, report = patch(raw, document)
                after = inventory(changed)
                row = next(item for item in after["textEntries"] if item["handle"] == "A")
                self.assertEqual(row["plainText"], replacement)
                self.assertEqual(
                    [span["code"] for span in row["textRecordOffsets"]], list(code)
                )
                self.assertEqual(len(row["textRecordOffsets"]), len(fragments))
                self.assertEqual(len(report["approvedChanges"]), 1)
                self.assertEqual(len(report["changedValueRanges"]), len(fragments))
                self.assertTrue(report["nonApprovedSegmentsIdentical"])
                self.assertTrue(changed.startswith(b"\xef\xbb\xbf"))
                self.assertEqual(after["lineEnding"], "CRLF")
                self.assertEqual(
                    after["placementManifestSha256"],
                    before["placementManifestSha256"],
                )

    def test_japanese_utf8_patch_preserves_every_nonapproved_byte(self):
        raw = tiny(
            "  0\r\nMTEXT\r\n  5\r\nA\r\n 10\r\n1\r\n 20\r\n2\r\n"
            " 40\r\n2\r\n 41\r\n80\r\n  7\r\nSTANDARD\r\n  1\r\nПривет\r\n"
            "  0\r\nLINE\r\n  5\r\nB\r\n 10\r\n9.125\r\n 20\r\n7.25\r\n"
        )
        changed, report = patch(raw, {
            "targetLanguage": "ja",
            "translations": [{"handle": "A", "translation": "こんにちは"}],
        })
        self.assertIn("こんにちは".encode("utf-8") + b"\r\n", changed)
        self.assertEqual(report["targetLanguage"], "ja")
        self.assertTrue(report["nonApprovedSegmentsIdentical"])
        self.assertTrue(report["metadataIdentical"])
        self.assertTrue(report["unchangedEntityPropertiesVerified"])
        source_entry = inventory(raw)["mtext"][0]
        output_entry = inventory(changed)["mtext"][0]
        for field in ("handle", "x", "y", "height", "width", "style", "owner"):
            self.assertEqual(source_entry[field], output_entry[field])
        self.assertIn(b"9.125\r\n 20\r\n7.25\r\n", changed)

    def test_japanese_patch_rejects_english_only_replacement(self):
        raw = tiny("  0\r\nMTEXT\r\n  5\r\nA\r\n 40\r\n2\r\n 41\r\n80\r\n  1\r\nПривет\r\n")
        with self.assertRaisesRegex(DxfRejected, "does not contain Japanese script"):
            patch(raw, {
                "targetLanguage": "ja",
                "translations": [{"handle": "A", "translation": "Hello"}],
            })

    def test_rejected_patch_publishes_no_output_or_report(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source_path = root / "source.dxf"
            translations_path = root / "translations.json"
            output_path = root / "translated.dxf"
            report_path = root / "patch-report.json"
            source_path.write_bytes(tiny(
                "  0\r\nMTEXT\r\n  5\r\nA\r\n 40\r\n2\r\n"
                " 41\r\n80\r\n  1\r\nПривет\r\n"
            ))
            translations_path.write_text(json.dumps({
                "targetLanguage": "en",
                "translations": [{
                    "targetId": "MTEXT:UNKNOWN",
                    "translation": "Hello",
                }],
            }), encoding="utf-8")
            result = main([
                "dxf_processor.py",
                "patch",
                str(source_path),
                str(translations_path),
                str(output_path),
                str(report_path),
            ])
            self.assertEqual(result, 2)
            self.assertFalse(output_path.exists())
            self.assertFalse(report_path.exists())
            self.assertFalse(Path(str(output_path) + ".staged").exists())
            self.assertFalse(Path(str(report_path) + ".staged").exists())

    def test_english_patch_rejects_japanese_replacement(self):
        raw = tiny("  0\r\nMTEXT\r\n  5\r\nA\r\n 40\r\n2\r\n 41\r\n80\r\n  1\r\nПривет\r\n")
        with self.assertRaisesRegex(DxfRejected, "is not English"):
            patch(raw, {
                "targetLanguage": "en",
                "translations": [{"handle": "A", "translation": "部屋"}],
            })

    def test_rejects_bad_and_risky_input(self):
        with self.assertRaises(DxfRejected): inventory(b"0\nSECTION\n")
        for binary_header in (
            b"",
            b"  0\r\nSEC\x00TION\r\n",
            b"AutoCAD Binary DXF\r\n\x1a\x00",
        ):
            with self.subTest(binary_header=binary_header):
                with self.assertRaisesRegex(
                    DxfRejected, "binary DXF is not supported"
                ):
                    parse_pairs(binary_header)
        raw = tiny(
            "  0\r\nIMAGE\r\n  5\r\nA\r\n330\r\n0\r\n"
            "100\r\nAcDbEntity\r\n  1\r\nopaque payload\r\n",
            complete=False,
        )
        self.assertEqual(inventory(raw)["entityTypeCounts"]["IMAGE"], 1)
        output, report = patch(raw, {})
        self.assertEqual(output, raw)
        self.assertTrue(report["nonApprovedSegmentsIdentical"])

    def test_native_block_mtext_and_duplicate_insert_placements(self):
        block_start = "  0\r\nBLOCK\r\n  5\r\n10\r\n330\r\n0\r\n100\r\nAcDbEntity\r\n  2\r\nTEST\r\n"
        block_end = "  0\r\nENDBLK\r\n  5\r\n11\r\n330\r\n0\r\n100\r\nAcDbEntity\r\n"
        block_mtext = ("  0\r\nMTEXT\r\n  5\r\n12\r\n330\r\n10\r\n100\r\nAcDbEntity\r\n"
                       " 10\r\n1\r\n 20\r\n2\r\n 40\r\n2\r\n 41\r\n80\r\n  1\r\nПривет\r\n")
        inserts = (
            "  0\r\nINSERT\r\n  5\r\n20\r\n330\r\n0\r\n100\r\nAcDbEntity\r\n  2\r\nTEST\r\n 10\r\n10\r\n 20\r\n20\r\n"
            "  0\r\nINSERT\r\n  5\r\n21\r\n330\r\n0\r\n100\r\nAcDbEntity\r\n  2\r\nTEST\r\n 10\r\n30\r\n 20\r\n40\r\n"
        )
        raw = with_blocks(block_start + block_mtext + block_end, inserts)
        info = inventory(raw)
        self.assertEqual(info["mtextCount"], 1)
        self.assertEqual(info["mtext"][0]["definitionBlock"], "TEST")
        self.assertEqual(info["mtext"][0]["placementCount"], 2)
        self.assertEqual(info["placementCount"], 2)
        self.assertEqual([(p["x"], p["y"]) for p in info["mtext"][0]["placements"]],
                         [(11.0, 22.0), (31.0, 42.0)])
        changed, report = patch(raw, {"12": "Hello"})
        self.assertEqual(changed.count(b"Hello"), 1)
        self.assertEqual(len(report["approvedChanges"]), 1)
        self.assertTrue(report["nonApprovedSegmentsIdentical"])
        self.assertEqual(report["placementCount"], 2)
        self.assertEqual(report["placementManifestSha256"], info["placementManifestSha256"])
        self.assertEqual(inventory(changed)["placementManifestSha256"],
                         info["placementManifestSha256"])
        rendered = preview(changed)
        self.assertEqual(rendered.count('data-handle="12"'), 2)
        self.assertIn('data-placement-index="0"', rendered)
        self.assertIn('data-placement-index="1"', rendered)

    def test_typed_visible_text_inventory_and_patch_policy(self):
        raw = tiny(
            "  0\r\nTEXT\r\n  5\r\nA\r\n  1\r\nПривет\r\n"
            "  0\r\nDIMENSION\r\n  5\r\nB\r\n  1\r\nРазмер\r\n"
            "  0\r\nMULTILEADER\r\n  5\r\nC\r\n304\r\nВыноска\r\n"
            "  0\r\nATTRIB\r\n  5\r\nD\r\n  1\r\nАтрибут\r\n"
            "  0\r\nATTDEF\r\n  5\r\nE\r\n  1\r\nLabel\r\n"
        )
        info = inventory(raw)
        rows = {row["targetId"]: row for row in info["textEntries"]}
        self.assertEqual(set(rows), {
            "TEXT:A", "DIMENSION:B", "MULTILEADER:C", "ATTRIB:D", "ATTDEF:E",
        })
        self.assertFalse(rows["ATTRIB:D"]["patchableInDxf"])
        self.assertEqual(info["unresolvedVisibleText"][0]["targetId"], "ATTRIB:D")
        output, report = patch(raw, {
            "translations": [
                {"targetId": "TEXT:A", "translation": "Hello"},
                {"targetId": "DIMENSION:B", "translation": "Size"},
                {"targetId": "MULTILEADER:C", "translation": "Note"},
                {"targetId": "ATTRIB:D", "translation": "Attribute"},
            ],
        })
        self.assertEqual(len(report["approvedChanges"]), 3)
        self.assertEqual(report["unresolved"][0]["targetId"], "ATTRIB:D")
        self.assertIn(b"Hello\r\n", output)

    def test_insert_integrity_nested_and_cycles(self):
        block = lambda name, handle, body: (
            f"  0\r\nBLOCK\r\n  5\r\n{handle}\r\n330\r\n0\r\n100\r\nAcDbEntity\r\n  2\r\n{name}\r\n"
            + body +
            f"  0\r\nENDBLK\r\n  5\r\n{int(handle, 16)+1:X}\r\n330\r\n0\r\n100\r\nAcDbEntity\r\n"
        )
        nested = block("INNER", "10",
            "  0\r\nMTEXT\r\n  5\r\n12\r\n330\r\n10\r\n100\r\nAcDbEntity\r\n  1\r\nПривет\r\n")
        nested += block("OUTER", "20",
            "  0\r\nINSERT\r\n  5\r\n22\r\n330\r\n20\r\n100\r\nAcDbEntity\r\n  2\r\nINNER\r\n")
        info = inventory(with_blocks(nested,
            "  0\r\nINSERT\r\n  5\r\n30\r\n330\r\n0\r\n100\r\nAcDbEntity\r\n  2\r\nOUTER\r\n"))
        self.assertEqual(info["mtext"][0]["placementCount"], 1)
        unknown = "  0\r\nINSERT\r\n  5\r\nA\r\n330\r\n0\r\n100\r\nAcDbEntity\r\n  2\r\nMISSING\r\n"
        with self.assertRaisesRegex(DxfRejected, "unknown BLOCK"):
            inventory(with_blocks("", unknown))
        cyclic = block("LOOP", "40",
            "  0\r\nINSERT\r\n  5\r\n42\r\n330\r\n40\r\n100\r\nAcDbEntity\r\n  2\r\nLOOP\r\n")
        with self.assertRaisesRegex(DxfRejected, "cyclic INSERT"):
            inventory(with_blocks(cyclic))

    def test_insert_graph_depth_and_nonfinite_transforms_are_rejected_cleanly(self):
        blocks = []
        for index in range(66):
            block_handle = 0x100 + index * 3
            child = (
                f"  0\r\nINSERT\r\n  5\r\n{block_handle + 1:X}\r\n"
                f"330\r\n{block_handle:X}\r\n100\r\nAcDbEntity\r\n"
                f"  2\r\nB{index + 1}\r\n"
                if index < 65 else
                f"  0\r\nMTEXT\r\n  5\r\n{block_handle + 1:X}\r\n"
                f"330\r\n{block_handle:X}\r\n100\r\nAcDbEntity\r\n  1\r\nПривет\r\n"
            )
            blocks.append(
                f"  0\r\nBLOCK\r\n  5\r\n{block_handle:X}\r\n330\r\n0\r\n"
                f"100\r\nAcDbEntity\r\n  2\r\nB{index}\r\n"
                + child +
                f"  0\r\nENDBLK\r\n  5\r\n{block_handle + 2:X}\r\n"
                f"330\r\n{block_handle:X}\r\n100\r\nAcDbEntity\r\n"
            )
        root_insert = (
            "  0\r\nINSERT\r\n  5\r\n10\r\n330\r\n0\r\n100\r\nAcDbEntity\r\n"
            "  2\r\nB0\r\n"
        )
        with self.assertRaisesRegex(DxfRejected, "maximum nesting depth"):
            inventory(with_blocks("".join(blocks), root_insert))

        simple_block = (
            "  0\r\nBLOCK\r\n  5\r\n20\r\n330\r\n0\r\n100\r\nAcDbEntity\r\n  2\r\nTEST\r\n"
            "  0\r\nENDBLK\r\n  5\r\n21\r\n330\r\n20\r\n100\r\nAcDbEntity\r\n"
        )
        nonfinite_insert = (
            "  0\r\nINSERT\r\n  5\r\n22\r\n330\r\n0\r\n100\r\nAcDbEntity\r\n"
            "  2\r\nTEST\r\n 10\r\nNaN\r\n"
        )
        with self.assertRaisesRegex(DxfRejected, "invalid numeric group 10"):
            inventory(with_blocks(simple_block, nonfinite_insert))

    def test_dimension_cannot_hide_unreviewed_block_mtext(self):
        block = (
            "  0\r\nBLOCK\r\n  5\r\n10\r\n330\r\n0\r\n100\r\nAcDbEntity\r\n  2\r\n*D1\r\n"
            "  0\r\nMTEXT\r\n  5\r\n11\r\n330\r\n10\r\n100\r\nAcDbEntity\r\n"
            "  1\r\nПривет\r\n"
            "  0\r\nENDBLK\r\n  5\r\n12\r\n330\r\n10\r\n100\r\nAcDbEntity\r\n"
        )
        dimension = (
            "  0\r\nDIMENSION\r\n  5\r\n20\r\n330\r\n0\r\n100\r\nAcDbEntity\r\n"
            "  2\r\n*D1\r\n  1\r\n<>\r\n"
        )
        info = inventory(with_blocks(block, dimension))
        self.assertEqual(info["mtextCount"], 1)

    def test_standard_view_and_ucs_tables_are_accepted(self):
        for table_name in ("VIEW", "UCS"):
            with self.subTest(table_name=table_name):
                table = (
                    "  0\r\nTABLE\r\n  5\r\nA\r\n330\r\n0\r\n100\r\nAcDbSymbolTable\r\n"
                    f"  2\r\n{table_name}\r\n 70\r\n10\r\n"
                    f"  0\r\n{table_name}\r\n  5\r\nB\r\n330\r\nA\r\n"
                    f"100\r\nAcDbSymbolTableRecord\r\n  2\r\nTEST\r\n"
                    "  0\r\nENDTAB\r\n"
                )
                info = inventory(with_section("TABLES", table))
                self.assertEqual(info["validationProfile"]["status"], "passed")

    def test_block_geometry_is_accepted_and_never_modified(self):
        block_body = (
            "  0\r\nBLOCK\r\n  5\r\n10\r\n330\r\n0\r\n100\r\nAcDbEntity\r\n  2\r\nTEST\r\n"
            "  0\r\nLINE\r\n  5\r\n12\r\n330\r\n10\r\n100\r\nAcDbEntity\r\n"
            " 10\r\n1.25\r\n 20\r\n2.5\r\n 11\r\n9.75\r\n 21\r\n8.5\r\n"
            "  0\r\nCIRCLE\r\n  5\r\n13\r\n330\r\n10\r\n100\r\nAcDbEntity\r\n"
            " 10\r\n4.5\r\n 20\r\n5.5\r\n 40\r\n3.25\r\n"
            "  0\r\nENDBLK\r\n  5\r\n11\r\n330\r\n0\r\n100\r\nAcDbEntity\r\n"
        )
        direct_mtext = (
            "  0\r\nMTEXT\r\n  5\r\n20\r\n330\r\n0\r\n100\r\nAcDbEntity\r\n"
            " 40\r\n2\r\n 41\r\n80\r\n  1\r\nПривет\r\n"
        )
        raw = with_blocks(block_body, direct_mtext)
        info = inventory(raw)
        self.assertEqual(info["mtextCount"], 1)
        self.assertEqual(info["entityTypeCounts"], {"MTEXT": 1})

        changed, report = patch(raw, {"20": "Hello"})
        self.assertIn(block_body.encode(), changed)
        self.assertTrue(report["nonApprovedSegmentsIdentical"])
        self.assertTrue(report["metadataIdentical"])
        self.assertTrue(report["unchangedEntityPropertiesVerified"])

    def test_empty_block_scaffolding_is_accepted(self):
        info = inventory(with_blocks(
            "  0\r\nBLOCK\r\n  5\r\n10\r\n330\r\n0\r\n100\r\nAcDbEntity\r\n  2\r\nTEST\r\n"
            "  0\r\nENDBLK\r\n  5\r\n11\r\n330\r\n0\r\n100\r\nAcDbEntity\r\n"
        ))
        self.assertTrue(info["validationProfile"]["allSectionsScanned"])
        self.assertEqual(info["validationProfile"]["status"], "passed")
        self.assertTrue(info["validationProfile"]["supportedRecordStructuralSchemaValidated"])

    def test_strict_section_schema_and_handle_invariants(self):
        opaque = with_section("OBJECTS", "  0\r\nVENDOR_OBJECT\r\n  5\r\nA\r\n")
        self.assertEqual(inventory(opaque)["opaqueRecords"]["status"], "preserved")
        with self.assertRaisesRegex(DxfRejected, "unsupported or misplaced"):
            inventory(tiny("  0\r\nDICTIONARY\r\n  5\r\nA\r\n330\r\n0\r\n100\r\nAcDbDictionary\r\n", complete=False))
        bad_header = (
            "  0\r\nSECTION\r\n  2\r\nHEADER\r\n  9\r\n$ACADVER\r\n  1\r\nAC1032\r\n"
            "  0\r\nVENDOR_HEADER_RECORD\r\n  0\r\nENDSEC\r\n  0\r\nEOF\r\n"
        ).encode()
        with self.assertRaisesRegex(DxfRejected, "unsupported top-level HEADER"):
            inventory(bad_header)
        missing = ("  0\r\nMTEXT\r\n330\r\n0\r\n100\r\nAcDbEntity\r\n"
                   "  1\r\ntext\r\n")
        with self.assertRaisesRegex(DxfRejected, "missing or invalid hex handle"):
            inventory(tiny(missing, complete=False))
        duplicate = (
            "  0\r\nMTEXT\r\n  5\r\nA\r\n330\r\n0\r\n100\r\nAcDbEntity\r\n  1\r\none\r\n"
            "  0\r\nMTEXT\r\n  5\r\nA\r\n330\r\n0\r\n100\r\nAcDbEntity\r\n  1\r\ntwo\r\n"
        )
        with self.assertRaisesRegex(DxfRejected, "duplicate handle"):
            inventory(tiny(duplicate, complete=False))
        bad_scope = ("  0\r\nMTEXT\r\n  5\r\nA\r\n330\r\n0\r\n100\r\nAcDbEntity\r\n"
                     "102\r\n{ACAD_REACTORS\r\n  1\r\ntext\r\n")
        with self.assertRaisesRegex(DxfRejected, "unbalanced 102"):
            inventory(tiny(bad_scope, complete=False))

    def test_unbalanced_table_scope_is_rejected(self):
        table = ("  0\r\nTABLE\r\n  5\r\nA\r\n330\r\n0\r\n100\r\nAcDbSymbolTable\r\n"
                 "  2\r\nLAYER\r\n 70\r\n0\r\n")
        with self.assertRaisesRegex(DxfRejected, "TABLE missing ENDTAB"):
            inventory(with_section("TABLES", table))

    def test_table_declared_capacity_may_exceed_current_entry_count(self):
        table = (
            "  0\r\nTABLE\r\n  5\r\nA\r\n330\r\n0\r\n100\r\nAcDbSymbolTable\r\n"
            "  2\r\nLAYER\r\n 70\r\n100\r\n"
            "  0\r\nLAYER\r\n  5\r\nB\r\n330\r\nA\r\n100\r\nAcDbSymbolTableRecord\r\n"
            "  2\r\n0\r\n"
            "  0\r\nENDTAB\r\n"
        )
        info = inventory(with_section("TABLES", table))
        self.assertEqual(info["mtext"], [])

    def test_table_targets_deduplicate_exact_values_and_exclude_fields(self):
        raw = tiny(
            "  0\r\nACAD_TABLE\r\n  5\r\nA\r\n"
            "  1\r\nКомната\r\n"
            "  1\r\nДругое\r\n"
            "  1\r\nКомната\r\n"
            "  1\r\n%<\\AcVar Foo>% Комната\r\n"
            "  1\r\nКомната\r\n"
        )
        info = inventory(raw)
        self.assertEqual(info["tableTargetCount"], 2)
        rows = {row["sourceText"]: row for row in info["tableTargets"]}
        repeated = rows["Комната"]
        self.assertEqual(repeated["sourceOrdinal"], 0)
        self.assertEqual(repeated["sourceOccurrenceCount"], 3)
        self.assertTrue(repeated["isCyrillicTarget"])
        self.assertIn(repeated["sourceTextSha256"], repeated["targetId"])
        unresolved = [
            row for row in info["unresolvedVisibleText"]
            if row["entityType"] == "ACAD_TABLE"
        ]
        self.assertEqual(len(unresolved), 1)
        self.assertEqual(
            unresolved[0]["reason"], "field_expression_payload_requires_autocad"
        )

    def test_escape_and_unsafe_unchanged(self):
        raw = tiny("  0\r\nMTEXT\r\n  5\r\nA\r\n 10\r\n1\r\n 20\r\n2\r\n 40\r\n2\r\n 41\r\n8\r\n  1\r\nx\r\n")
        out, report = patch(raw, {"A": r"{a}\b"})
        self.assertIn(b"\\{a\\}\\\\b", out)
        out, report = patch(raw, {"A": "this is much too long"})
        self.assertEqual(out, raw); self.assertTrue(report["unresolved"])

    def test_simple_and_paragraph_formatting_round_trip(self):
        formatted = tiny("  0\r\nMTEXT\r\n  5\r\nA\r\n 10\r\n1\r\n 20\r\n2\r\n 40\r\n2\r\n 41\r\n40\r\n  1\r\n{\\fArial;Old}\r\n")
        output, report = patch(formatted, {"A": r"New {text}\path"})
        self.assertIn(b"{\\fArial;New \\{text\\}\\\\path}", output)
        self.assertFalse(report["unresolved"])
        paragraphs = formatted.replace(b"Old", b"Old\\PSecond")
        output, report = patch(paragraphs, {"A": "New words"})
        self.assertIn(b"\\P", output)
        self.assertFalse(report["unresolved"])

    def test_mtext_replacement_line_breaks_are_encoded_as_paragraphs(self):
        raw = tiny(
            "  0\r\nMTEXT\r\n  5\r\nA\r\n 10\r\n1\r\n 20\r\n2\r\n"
            " 40\r\n2\r\n 41\r\n80\r\n  1\r\n{\\fArial;Old}\r\n"
        )
        output, report = patch(raw, {"A": "First line\nSecond line\r\nThird line"})
        self.assertFalse(report["unresolved"])
        self.assertIn(b"{\\fArial;First line\\PSecond line\\PThird line}", output)
        self.assertEqual(
            inventory(output)["mtext"][0]["plainText"],
            "First line\nSecond line\nThird line",
        )
        self.assertTrue(report["nonApprovedSegmentsIdentical"])

    def test_mtext_control_program_is_preserved_and_malformed_is_rejected(self):
        raw = tiny(
            "  0\r\nMTEXT\r\n  5\r\nA\r\n 10\r\n1\r\n 20\r\n2\r\n"
            " 40\r\n2\r\n 41\r\n80\r\n"
            "  1\r\n{\\fArial;Один {\\C7;два} \\Lтри\\l}\\P"
            "{\\pxql;четыре}\r\n"
        )
        before = inventory(raw)["mtext"][0]
        output, report = patch(raw, {"A": r"Safe {new}\path words"})
        after = inventory(output)["mtext"][0]
        self.assertFalse(report["unresolved"])
        for control in (
            r"\fArial;", r"\C7;", r"\L", r"\l", r"\P", r"\pxql;",
        ):
            self.assertEqual(output.count(control.encode()), raw.count(control.encode()))
        structural = lambda value: re.findall(r"(?<!\\)[{}]", value)
        self.assertEqual(structural(before["rawText"]), structural(after["rawText"]))
        self.assertGreater(output.count(b"\\{"), raw.count(b"\\{"))
        self.assertGreater(output.count(b"\\}"), raw.count(b"\\}"))
        self.assertIn(b"\\\\path", output)

        for malformed_text in (r"{\fArial;Old", r"\Zbad;Old", "Old}"):
            malformed = tiny(
                "  0\r\nMTEXT\r\n  5\r\nA\r\n 40\r\n2\r\n 41\r\n80\r\n"
                f"  1\r\n{malformed_text}\r\n"
            )
            unchanged, malformed_report = patch(malformed, {"A": "New"})
            self.assertEqual(unchanged, malformed)
            self.assertEqual(
                malformed_report["unresolved"][0]["reason"],
                "formatting_mtext_unsafe",
            )

    def test_preview_renders_typed_text_and_multileader_targets(self):
        raw = tiny(
            "  0\r\nTEXT\r\n  5\r\nA\r\n 10\r\n1\r\n 20\r\n2\r\n"
            "  1\r\nПривет\r\n"
            "  0\r\nMULTILEADER\r\n  5\r\nB\r\n 10\r\n3\r\n 20\r\n4\r\n"
            "304\r\nВыноска\r\n"
        )
        rendered = preview(raw, {
            "translations": [
                {"targetId": "TEXT:A", "translation": "Hello"},
                {"targetId": "MULTILEADER:B", "translation": "Note"},
            ],
        })
        self.assertIn('data-target-id="TEXT:A"', rendered)
        self.assertIn('data-target-id="MULTILEADER:B"', rendered)
        self.assertIn('data-overlay-for="TEXT:A"', rendered)
        self.assertIn('data-overlay-for="MULTILEADER:B"', rendered)

    def test_preview_reuses_its_single_validated_parse(self):
        raw = tiny(
            "  0\r\nTEXT\r\n  5\r\nA\r\n 10\r\n1\r\n 20\r\n2\r\n"
            "  1\r\nПривет\r\n"
        )
        real_parse_pairs = dxf_processor.parse_pairs
        with mock.patch.object(
            dxf_processor, "parse_pairs", wraps=real_parse_pairs
        ) as counted_parse:
            rendered = preview(raw)
        self.assertEqual(counted_parse.call_count, 1)
        self.assertIn('data-target-id="TEXT:A"', rendered)

    def test_real_form_multileader_context_excludes_leader_line_markers(self):
        raw = tiny(
            "  0\r\nMULTILEADER\r\n  5\r\nA\r\n 10\r\n999\r\n 20\r\n998\r\n"
            "300\r\nCONTEXT_DATA{\r\n 12\r\n12.5\r\n 22\r\n22.5\r\n"
            "304\r\nВыноска\r\n302\r\nLEADER{\r\n"
            "304\r\nLEADER_LINE{\r\n 10\r\n1\r\n 20\r\n2\r\n305\r\n}\r\n"
        )
        row = inventory(raw)["textEntries"][0]
        self.assertEqual(row["plainText"], "Выноска")
        self.assertEqual(len(row["textRecordOffsets"]), 1)
        self.assertEqual((row["x"], row["y"]), (12.5, 22.5))
        output, report = patch(raw, {"MULTILEADER:A": "Note"})
        self.assertFalse(report["unresolved"])
        self.assertEqual(output.count(b"LEADER_LINE{"), 1)
        self.assertIn(b"304\r\nNote\r\n302\r\nLEADER{", output)

    def test_dimension_cache_binding_and_paper_space_root_placements(self):
        blocks = (
            "  0\r\nBLOCK\r\n  5\r\n10\r\n330\r\n0\r\n100\r\nAcDbEntity\r\n"
            "  2\r\n*D1\r\n"
            "  0\r\nTEXT\r\n  5\r\n11\r\n330\r\n10\r\n100\r\nAcDbEntity\r\n"
            " 10\r\n100\r\n 20\r\n200\r\n  1\r\nРазмер\r\n"
            "  0\r\nENDBLK\r\n  5\r\n12\r\n330\r\n0\r\n100\r\nAcDbEntity\r\n"
            "  0\r\nBLOCK\r\n  5\r\n20\r\n330\r\n0\r\n100\r\nAcDbEntity\r\n"
            "  2\r\n*PAPER_SPACE\r\n"
            "  0\r\nTEXT\r\n  5\r\n21\r\n330\r\n20\r\n100\r\nAcDbEntity\r\n"
            " 10\r\n7\r\n 20\r\n8\r\n  1\r\nЛист\r\n"
            "  0\r\nENDBLK\r\n  5\r\n22\r\n330\r\n0\r\n100\r\nAcDbEntity\r\n"
        )
        dimension = (
            "  0\r\nDIMENSION\r\n  5\r\nD\r\n330\r\n0\r\n100\r\nAcDbEntity\r\n"
            "  2\r\n*D1\r\n 11\r\n50\r\n 21\r\n60\r\n  1\r\nРазмер\r\n"
        )
        raw = with_blocks(blocks, dimension)
        info = inventory(raw)
        self.assertEqual(info["dimensionCacheBindings"], [{
            "dimensionTargetId": "DIMENSION:D", "cacheTargetId": "TEXT:11",
        }])
        cache = next(row for row in info["textEntries"] if row["targetId"] == "TEXT:11")
        self.assertEqual((cache["placements"][0]["x"], cache["placements"][0]["y"]),
                         (100.0, 200.0))
        self.assertEqual(cache["placements"][0]["insertPath"], ["DIMENSION:D"])
        paper = next(row for row in info["textEntries"] if row["targetId"] == "TEXT:21")
        self.assertEqual(paper["placements"][0]["insertPath"],
                         ["LAYOUT:*PAPER_SPACE"])
        output, report = patch(raw, {"DIMENSION:D": "Size"})
        self.assertEqual(len(report["approvedChanges"]), 2)
        self.assertEqual(output.count(b"Size"), 2)

    def test_known_fitting_baseline_beats_misleading_inferred_cell(self):
        # The two vertical LWPOLYLINE segments infer a one-unit cell around the
        # source despite the source itself already being wider than that edge.
        body = (
            "  0\r\nMTEXT\r\n  5\r\nA\r\n 10\r\n0.5\r\n 20\r\n0.5\r\n 40\r\n2\r\n  1\r\nabcdef\r\n"
            "  0\r\nLWPOLYLINE\r\n  5\r\nB\r\n 10\r\n0\r\n 20\r\n0\r\n 10\r\n0\r\n 20\r\n1\r\n"
            "  0\r\nLWPOLYLINE\r\n  5\r\nC\r\n 10\r\n1\r\n 20\r\n0\r\n 10\r\n1\r\n 20\r\n1\r\n"
        )
        raw = tiny(body)
        output, report = patch(raw, {"A": "abcde"})
        self.assertIn(b"abcde", output)
        self.assertFalse(report["unresolved"])
        output, report = patch(raw, {"A": "this replacement is much longer"})
        self.assertEqual(output, raw)
        self.assertEqual(report["unresolved"][0]["reason"], "text_fit_unsafe")

    def test_patch_whole_file_parse_count_is_independent_of_unboxed_targets(self):
        body = "".join(
            f"  0\r\nMTEXT\r\n  5\r\n{0xA + index:X}\r\n"
            f" 10\r\n{index + .5}\r\n 20\r\n0.5\r\n 40\r\n1\r\n"
            f"  1\r\nИсходный {index}\r\n"
            for index in range(24)
        )
        # Shared cell edges exercise the inference path for every target.
        body += "".join(
            f"  0\r\nLWPOLYLINE\r\n  5\r\n{0x100 + index:X}\r\n"
            f" 10\r\n{index}\r\n 20\r\n0\r\n 10\r\n{index}\r\n 20\r\n1\r\n"
            for index in range(25)
        )
        raw = tiny(body)
        translations = {
            f"{0xA + index:X}": f"Text {index}"
            for index in range(24)
        }
        real_parse_pairs = dxf_processor.parse_pairs
        with mock.patch.object(
            dxf_processor, "parse_pairs", wraps=real_parse_pairs
        ) as counted_parse:
            output, report = patch(raw, translations)
        # One complete parse validates source and one validates output. Cell
        # inference must reuse validated geometry regardless of target count.
        self.assertEqual(counted_parse.call_count, 2)
        self.assertEqual(len(report["approvedChanges"]), 24)
        self.assertTrue(report["nonApprovedSegmentsIdentical"])
        self.assertTrue(report["metadataIdentical"])
        self.assertTrue(report["lineEndingPreserved"])
        self.assertEqual(
            inventory(raw)["placementManifestSha256"],
            inventory(output)["placementManifestSha256"],
        )
        for index in range(25):
            edge = (
                f" 10\r\n{index}\r\n 20\r\n0\r\n"
                f" 10\r\n{index}\r\n 20\r\n1\r\n"
            ).encode()
            self.assertIn(edge, output)

    def test_cyrillic_units_are_not_preserved_codes(self):
        raw = tiny(
            "  0\r\nMTEXT\r\n  5\r\nA\r\n  1\r\nм²\r\n"
            "  0\r\nMTEXT\r\n  5\r\nB\r\n  1\r\nГОСТ5264-80-Н1\r\n"
            "  0\r\nMTEXT\r\n  5\r\nC\r\n  1\r\nПр-1\r\n"
        )
        rows = {item["handle"]: item for item in inventory(raw)["mtext"]}
        self.assertFalse(rows["A"]["preservedDrawingCodeCandidate"])
        self.assertTrue(rows["B"]["preservedDrawingCodeCandidate"])
        self.assertTrue(rows["C"]["preservedDrawingCodeCandidate"])

    def test_audited_project_and_component_identifiers(self):
        for value in ("198/ДУ-2021. АР", "П.в.-3", "П.в.-4"):
            self.assertTrue(_is_preserved_drawing_code(value), value)
        for value in (
            "не менее 3-Вр-1",  # prose containing, but not equal to, a code
            "поз. П.в.-3",      # nearby prose must remain translatable
            "198/ДУ-2021",      # incomplete project identifier
            "м2", "м²",
        ):
            self.assertFalse(_is_preserved_drawing_code(value), value)

    def test_isolated_uppercase_cyrillic_grid_markers(self):
        for value in ("А", "Б", "В", "Г", "П", " Ё "):
            self.assertTrue(_is_preserved_drawing_code(value), value)
        for value in ("а", "б", "аб", "АР", "ось А", "А секция", "м", "м2", "м²"):
            self.assertFalse(_is_preserved_drawing_code(value), value)

    def test_real_sample_inventory(self):
        sample = Path(__file__).resolve().parents[4] / "attached_assets" / "0_АР_-_Extract_1787885274655.dxf"
        if sample.exists():
            info = inventory(sample.read_bytes())
            self.assertEqual(info["mtextCount"], 290)
            self.assertEqual(info["cyrillicTargetCount"], 116)
            self.assertEqual(sum(item["preservedDrawingCodeCandidate"] for item in info["mtext"]), 180)
            markers = {
                item["handle"]: item["plainText"] for item in info["mtext"]
                if len(item["plainText"]) == 1 and re.fullmatch(r"[А-ЯЁ]", item["plainText"])
            }
            self.assertEqual(markers, {
                "10B29": "Г", "10B2E": "В", "10B3D": "А",
                "10B3E": "Б", "10BD3": "П",
            })
            joined = [
                group for group in info["splitFragmentGroups"]
                if any(info_item["plainText"].rstrip().endswith("поме-")
                       for info_item in info["mtext"] if info_item["handle"] in group["handles"])
                and any(info_item["plainText"].lstrip().startswith("щения")
                        for info_item in info["mtext"] if info_item["handle"] in group["handles"])
            ]
            self.assertTrue(joined, "known поме-/щения fragments must retain both handles")
            self.assertIn(["10C15", "10C16", "10C17"], [group["handles"] for group in info["splitFragmentGroups"]])
            self.assertFalse(any("10B58" in group["handles"] or "10B9C" in group["handles"]
                                 for group in info["splitFragmentGroups"]))

    def test_real_sample_patch_is_fully_accounted(self):
        sample = Path(__file__).resolve().parents[4] / "attached_assets" / "0_АР_-_Extract_1787885274655.dxf"
        if not sample.exists():
            self.skipTest("real Task #251 fixture is unavailable")
        source = sample.read_bytes()
        output, report = patch(source, {
            "10B23": "Room schedule", "10B24": "Number",
            "10B25": "room-", "10B57": "s", "10B58": "301 Stairwell",
        })
        self.assertEqual(report["accountedMtextCount"], 290)
        self.assertEqual(report["unchangedMtextCount"] + len(report["approvedChanges"]), 290)
        self.assertTrue(report["nonTextRecordsIdentical"])
        self.assertTrue(report["metadataIdentical"])
        self.assertTrue(report["reparsedCleanly"])
        self.assertTrue(report["lineEndingPreserved"])
        self.assertEqual(inventory(output)["mtextCount"], 290)
        self.assertFalse(report["unresolved"])
        self.assertEqual(len(report["approvedChanges"]), 5)

    def test_architecture_exact_file_safe_hybrid_inventory(self):
        sample = Path(__file__).resolve().parents[4] / "attached_assets" / "0_Architecture_1788835080215.dxf"
        if not sample.exists():
            self.skipTest("exact architecture fixture is unavailable")
        info = inventory(sample.read_bytes())
        self.assertEqual(info["sha256"], "73a1711a5e35750cfc30e78bfc31c767da26edc6663a1bfea23e38f095a299ac")
        self.assertEqual(info["visibleTextCount"], 9143)
        self.assertEqual(info["cyrillicTargetCount"], 2749)
        self.assertEqual(info["tableTargetCount"], 1233)
        self.assertEqual(
            sum(row["sourceOccurrenceCount"] for row in info["tableTargets"]),
            1524,
        )
        self.assertEqual(
            sum(len(row["sourceValueSpans"]) > 1 for row in info["tableTargets"]),
            65,
        )
        self.assertEqual(info["opaqueRecords"]["status"], "preserved")
        self.assertTrue(all(not row["patchableInDxf"] for row in info["tableTargets"]))
        table_cache_rows = [row for row in info["textEntries"] if row["deferredTableCache"]]
        self.assertTrue(table_cache_rows)
        self.assertTrue(all(not row["patchableInDxf"] for row in table_cache_rows))

    def test_architecture_direct_text_500_559_patch_boundary(self):
        sample = Path(__file__).resolve().parents[4] / "attached_assets" / "0_Architecture_1788835080215.dxf"
        if not sample.exists():
            self.skipTest("exact architecture fixture is unavailable")
        source = sample.read_bytes()
        info = inventory(source)
        direct_targets = [
            row for row in info["textEntries"]
            if row["isCyrillicTarget"]
            and row["patchableInDxf"]
            and not row["preservedDrawingCodeCandidate"]
        ]
        boundary = direct_targets[500:560]
        self.assertEqual(len(boundary), 60)
        output, report = patch(source, {
            "targetLanguage": "en",
            "translations": [
                {"targetId": row["targetId"], "translation": "A"}
                for row in boundary
            ],
        })
        self.assertEqual(report["sourceSha256"], info["sha256"])
        self.assertEqual(report["outputSha256"], hashlib.sha256(output).hexdigest())
        self.assertNotEqual(report["sourceSha256"], report["outputSha256"])
        self.assertEqual(len(report["approvedChanges"]), 60)
        self.assertFalse(report["unresolved"])
        self.assertTrue(report["nonApprovedSegmentsIdentical"])
        self.assertTrue(report["reparsedCleanly"])


if __name__ == "__main__":
    unittest.main()
