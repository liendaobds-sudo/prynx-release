"""Hồi quy N-Up xếp lần lượt phải bảo toàn toàn bộ trang nguồn."""

from __future__ import annotations

import os
import tempfile

import pytest

pytest.importorskip("pikepdf")

from app.api.routes import imposition as imposition_route
from app.workers import nup_engine
from app.workers import pdf_wrapper as pdf_lib
from app.workers.nup_layout_solver import build_sequential_product_sequence


def _make_a5_pdf(path: str, page_count: int) -> None:
    document = pdf_lib.open()
    for _ in range(page_count):
        document.new_page(width=148 * 2.83465, height=210 * 2.83465)
    document.save(path)
    document.close()


def test_sequential_sequence_keeps_31_pages_for_four_up() -> None:
    sequence = build_sequential_product_sequence(
        page_count=31,
        capacity=4,
        target_quantity=0,
        target_quantities_by_page={},
        duplex=False,
    )

    assert sequence == list(range(31))
    assert [sequence[index:index + 4] for index in range(0, len(sequence), 4)] == [
        [0, 1, 2, 3],
        [4, 5, 6, 7],
        [8, 9, 10, 11],
        [12, 13, 14, 15],
        [16, 17, 18, 19],
        [20, 21, 22, 23],
        [24, 25, 26, 27],
        [28, 29, 30],
    ]


def test_sequential_single_page_still_autofills_one_sheet() -> None:
    assert build_sequential_product_sequence(1, 4, 0, {}, False) == [0, 0, 0, 0]


def test_preview_reports_eight_sheets_for_31_a5_pages(monkeypatch) -> None:
    monkeypatch.setattr(imposition_route, "enforce_feature", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(imposition_route, "_validate_file_path", lambda path: path)

    with tempfile.TemporaryDirectory() as temp_dir:
        source_path = os.path.join(temp_dir, "31-pages.pdf")
        _make_a5_pdf(source_path, 31)
        mm_to_points = 2.83465
        request = imposition_route.PreviewLayoutRequest(
            usable_w=330 * mm_to_points,
            usable_h=480 * mm_to_points,
            item_w=148 * mm_to_points,
            item_h=210 * mm_to_points,
            gap_x=0,
            gap_y=0,
            strategy="manual",
            sheet_w=330 * mm_to_points,
            sheet_h=480 * mm_to_points,
            path=source_path,
            total_pages=31,
            layout_type="sequential",
            task_mode="nup",
            duplex_flow="normal",
            target_quantity=0,
            target_quantities_by_page={},
            cols=2,
            rows=2,
        )

        result = imposition_route.preview_layout(request, license_info={})

    assert result["sheetsNeeded"] == 8
    assert [cell["pageIdx"] for cell in result["cells"]] == [0, 1, 2, 3]
    assert [
        [cell["pageIdx"] for cell in sheet["cells"]]
        for sheet in result["sheets"]
    ] == [
        [0, 1, 2, 3],
        [4, 5, 6, 7],
        [8, 9, 10, 11],
        [12, 13, 14, 15],
        [16, 17, 18, 19],
        [20, 21, 22, 23],
        [24, 25, 26, 27],
        [28, 29, 30],
    ]


def test_cut_stacks_preview_exposes_every_distinct_sheet(monkeypatch) -> None:
    monkeypatch.setattr(imposition_route, "enforce_feature", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(imposition_route, "_validate_file_path", lambda path: path)

    with tempfile.TemporaryDirectory() as temp_dir:
        source_path = os.path.join(temp_dir, "10-pages.pdf")
        _make_a5_pdf(source_path, 10)
        mm_to_points = 2.83465
        request = imposition_route.PreviewLayoutRequest(
            usable_w=330 * mm_to_points,
            usable_h=480 * mm_to_points,
            item_w=148 * mm_to_points,
            item_h=210 * mm_to_points,
            gap_x=0,
            gap_y=0,
            strategy="manual",
            sheet_w=330 * mm_to_points,
            sheet_h=480 * mm_to_points,
            path=source_path,
            total_pages=10,
            layout_type="cut_stacks",
            task_mode="nup",
            target_quantity=0,
            target_quantities_by_page={},
            cols=2,
            rows=2,
        )

        result = imposition_route.preview_layout(request, license_info={})

    assert result["sheetsNeeded"] == 3
    assert [
        [cell["pageIdx"] for cell in sheet["cells"]]
        for sheet in result["sheets"]
    ] == [[0, 3, 6, 9], [1, 4, 7], [2, 5, 8]]


def test_sequential_duplex_preview_exposes_each_front_sheet(monkeypatch) -> None:
    monkeypatch.setattr(imposition_route, "enforce_feature", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(imposition_route, "_validate_file_path", lambda path: path)

    with tempfile.TemporaryDirectory() as temp_dir:
        source_path = os.path.join(temp_dir, "12-pages.pdf")
        _make_a5_pdf(source_path, 12)
        mm_to_points = 2.83465
        request = imposition_route.PreviewLayoutRequest(
            usable_w=330 * mm_to_points,
            usable_h=480 * mm_to_points,
            item_w=148 * mm_to_points,
            item_h=210 * mm_to_points,
            gap_x=0,
            gap_y=0,
            strategy="manual",
            sheet_w=330 * mm_to_points,
            sheet_h=480 * mm_to_points,
            path=source_path,
            total_pages=12,
            layout_type="sequential",
            task_mode="nup",
            duplex_flow="double",
            target_quantity=0,
            target_quantities_by_page={},
            cols=2,
            rows=2,
        )

        result = imposition_route.preview_layout(request, license_info={})

    assert result["sheetsNeeded"] == 2
    assert [
        [cell["pageIdx"] for cell in sheet["cells"]]
        for sheet in result["sheets"]
    ] == [[0, 2, 4, 6], [8, 10]]


def test_nup_engine_outputs_eight_sheets_for_31_a5_pages(monkeypatch) -> None:
    captured = {}

    def _capture_finalize(context, chunk_processor):
        captured["context"] = context
        return "captured"

    monkeypatch.setattr(nup_engine, "finalize_nup_output", _capture_finalize)

    with tempfile.TemporaryDirectory() as temp_dir:
        source_path = os.path.join(temp_dir, "31-pages.pdf")
        output_path = os.path.join(temp_dir, "output.pdf")
        _make_a5_pdf(source_path, 31)

        result = nup_engine.run_nup_engine(
            source_path,
            output_path,
            {
                "layoutType": "sequential",
                "duplexFlow": "normal",
                "sheetWidth": 330,
                "sheetHeight": 480,
                "gridStrategy": "manual",
                "cols": 2,
                "rows": 2,
                "gapX": 0,
                "gapY": 0,
                "marginTop": 0,
                "marginBottom": 0,
                "marginLeft": 0,
                "marginRight": 0,
                "targetQuantity": 0,
                "targetQuantitiesByPage": {},
                "isDieCutMode": False,
                "groupingStrategy": "none",
                "markType": "none",
                "pontType": "none",
            },
            job_id="test-sequential-31-pages",
        )

    context = captured["context"]
    sheets = [
        [placement["src_page_idx"] for placement in context.precalculated_placements[index]]
        for index in sorted(context.precalculated_placements)
    ]
    assert result == "captured"
    assert context.capacity == 4
    assert context.total_sheets == 8
    assert sheets == [
        [0, 1, 2, 3],
        [4, 5, 6, 7],
        [8, 9, 10, 11],
        [12, 13, 14, 15],
        [16, 17, 18, 19],
        [20, 21, 22, 23],
        [24, 25, 26, 27],
        [28, 29, 30],
    ]
