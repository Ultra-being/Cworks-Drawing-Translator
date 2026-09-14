import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).parent))
from dxf_table_cells import table_cell_source_spans


class TableCellSourceTests(unittest.TestCase):
    def test_long_cells_reconstruct_all_prefixes_and_ignore_block_name(self):
        def pair(code, value):
            return SimpleNamespace(code=code, value=value.encode("utf-8"))
        records = [
            pair(100, "AcDbBlockReference"), pair(2, "*T1"), pair(10, "0"),
            pair(100, "AcDbTable"), pair(90, "1"),
            pair(2, "Длинное "), pair(2, "название "), pair(1, "ячейки"),
            pair(90, "1"), pair(1, "Вторая"),
            pair(302, "Вторая"), pair(303, "not-a-legacy-prefix"),
        ]
        cells = list(table_cell_source_spans(records))
        self.assertEqual(
            [b"".join(p.value for p in cell).decode() for cell in cells],
            ["Длинное название ячейки", "Вторая"],
        )
        self.assertEqual([[p.code for p in cell] for cell in cells], [[2, 2, 1], [1]])

    def test_nonadjacent_and_trailing_chunks_are_not_invented_cells(self):
        records = [
            SimpleNamespace(code=2), SimpleNamespace(code=10),
            SimpleNamespace(code=1), SimpleNamespace(code=2),
        ]
        self.assertEqual(list(table_cell_source_spans(records)), [[records[2]]])


if __name__ == "__main__":
    unittest.main()