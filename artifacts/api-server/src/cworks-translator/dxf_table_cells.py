"""Read table strings without rewriting table entities or their cached objects."""
from collections.abc import Iterable, Iterator
from typing import Any


def table_cell_source_spans(records: Iterable[Any]) -> Iterator[list[Any]]:
    """Yield each legacy cell's ordered prefix chunks and final group-1 span.

    AC1032 tables retain a legacy text representation alongside 302/303 cell
    values and binary caches. Long legacy strings use adjacent group-2 chunks
    before group 1 (some writers use group 3). The block reference's group 2 is
    followed by coordinates, so it is deliberately discarded, not a prefix.
    These spans are discovery evidence only; AutoCAD owns all table mutations.
    """
    pending: list[Any] = []
    for record in records:
        if record.code in (2, 3):
            pending.append(record)
        elif record.code == 1:
            yield [*pending, record]
            pending = []
        else:
            pending = []