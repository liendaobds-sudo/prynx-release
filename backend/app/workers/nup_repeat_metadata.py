"""Metadata thứ tự tờ lặp cho N-Up renderer."""

from __future__ import annotations

from typing import Any


def build_repeat_sheet_metadata(
    sheet_mapping: Any,
) -> dict[int, tuple[int, int]]:
    """Trả ``sheet -> (trang nguồn, thứ tự lặp)`` trong O(S)."""
    if not sheet_mapping:
        return {}

    metadata: dict[int, tuple[int, int]] = {}
    seen_by_source: dict[int, int] = {}
    if isinstance(sheet_mapping, dict):
        def value_at(index: int):
            return sheet_mapping.get(index, sheet_mapping.get(str(index)))

        indices = []
        for index in sheet_mapping:
            try:
                indices.append(int(index))
            except (TypeError, ValueError):
                continue
        indices = sorted(set(indices))
    else:
        value_at = sheet_mapping.__getitem__
        indices = range(len(sheet_mapping))

    for sheet_index in indices:
        try:
            source_index = int(value_at(sheet_index))
        except (KeyError, TypeError, ValueError):
            continue
        ordinal = seen_by_source.get(source_index, 0)
        metadata[sheet_index] = (source_index, ordinal)
        seen_by_source[source_index] = ordinal + 1
    return metadata


def build_chunk_worker_metadata(
    repeat_metadata: dict[int, tuple[int, int]],
    start_sheet: int,
    end_sheet: int,
    *,
    alternate_rotation: str,
    diagnostic_trace_id: str = "",
    diagnostic_job_id: str = "",
) -> dict[str, Any]:
    """Đóng gói metadata worker mà không làm trôi đuôi tuple N-Up legacy."""
    return {
        "_nup_worker_metadata": True,
        "repeat": {
            sheet: repeat_metadata[sheet]
            for sheet in range(start_sheet, end_sheet)
            if sheet in repeat_metadata
        } or None,
        "options": {
            "alternate_rotation": alternate_rotation,
        },
        "diagnostic": {
            "_diagnostic_trace_id": diagnostic_trace_id,
            "_diagnostic_job_id": diagnostic_job_id,
        } if diagnostic_trace_id else {},
    }


__all__ = ["build_repeat_sheet_metadata", "build_chunk_worker_metadata"]
