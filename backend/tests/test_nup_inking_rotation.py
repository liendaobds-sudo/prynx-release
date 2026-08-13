"""Hồi quy xoay đối đầu xen kẽ cho bình cắt xén và tem chữ nhật."""

import pytest

from app.workers import nup_layout_solver


@pytest.mark.parametrize(
    ("mode", "expected"),
    [
        ("row", [False, False, True, True]),
        ("column", [False, True, False, True]),
    ],
)
def test_inking_keeps_grid_strategy_and_only_adds_180_rotation(
    monkeypatch, mode, expected
):
    calls = []
    native_result = {
        "totalItems": 4,
        "overallWidth": 40.0,
        "overallHeight": 20.0,
        "strategyUsed": "optimal_auto",
        "cells": [
            {"c": 0, "r": 0, "x": 0.0, "y": 0.0, "width": 20.0, "height": 10.0, "isRotated": False},
            {"c": 1, "r": 0, "x": 20.0, "y": 0.0, "width": 20.0, "height": 10.0, "isRotated": False},
            {"c": 0, "r": 1, "x": 0.0, "y": 10.0, "width": 20.0, "height": 10.0, "isRotated": False},
            {"c": 1, "r": 1, "x": 20.0, "y": 10.0, "width": 20.0, "height": 10.0, "isRotated": False},
        ],
    }

    def fake_solve(*args):
        calls.append(args)
        return native_result

    monkeypatch.setattr(nup_layout_solver, "_USE_RUST", True)
    monkeypatch.setattr(nup_layout_solver, "_rust_solve_optimal", fake_solve)

    result = nup_layout_solver.solve_optimal_layout(
        100.0, 100.0, 20.0, 10.0, 0.0, 0.0,
        "optimal_auto", None, mode,
    )

    assert calls[0][6] == "optimal_auto"
    assert [cell["isRotated180"] for cell in result["cells"]] == expected
    assert result["strategyUsed"] == "optimal_auto"
    # Hậu xử lý không làm bẩn dict solver trả về; cache/call khác vẫn an toàn.
    assert all("isRotated180" not in cell for cell in native_result["cells"])

    preview_sheet = nup_layout_solver.build_guillotine_preview_sheet(
        result["cells"], [0, 1, 2, 3], usable_w=100.0, usable_h=100.0
    )
    assert [cell["isRotated180"] for cell in preview_sheet["cells"]] == expected


@pytest.mark.parametrize(
    ("mode", "main_coordinate_key", "rotated_coordinate_key"),
    [("row", "y", "x"), ("column", "x", "y")],
)
def test_inking_restarts_content_bands_for_each_l_shape_block(
    mode, main_coordinate_key, rotated_coordinate_key
):
    def cell(block_id, band, *, rotated=False):
        coordinate = [0.0, 10.0, 20.0][band]
        coordinate_key = rotated_coordinate_key if rotated else main_coordinate_key
        return {
            "c": 0,
            "r": 0,
            "x": coordinate if coordinate_key == "x" else block_id * 100.0,
            "y": coordinate if coordinate_key == "y" else block_id * 100.0,
            "blockId": block_id,
            "isRotated": rotated,
        }

    layout = {
        "strategyUsed": "optimal_auto",
        "cells": [
            # Trộn thứ tự hai cụm để khóa hành vi theo blockId và hướng
            # nội dung, không vô tình dựa vào thứ tự danh sách.
            cell(0, 0), cell(1, 0, rotated=True),
            cell(0, 1), cell(1, 1, rotated=True),
            cell(0, 2), cell(1, 2, rotated=True),
        ],
    }

    result = nup_layout_solver.apply_alternate_rotation(layout, mode)

    assert [cell["isRotated180"] for cell in result["cells"]] == [
        False, False, True, True, False, False,
    ]
    assert [cell["isRotated"] for cell in result["cells"]] == [
        False, True, False, True, False, True,
    ]
    assert result["strategyUsed"] == "optimal_auto"


@pytest.mark.parametrize(
    ("mode", "expected"),
    [
        ("row", [False, False, True, True]),
        ("column", [False, True, False, True]),
    ],
)
def test_sticker_items_use_the_same_alternate_rotation_contract(mode, expected):
    layout = {
        "strategyUsed": "grid",
        "items": [
            {"x": 0.0, "y": 0.0, "blockId": 0, "isRotated": False},
            {"x": 10.0, "y": 0.0, "blockId": 0, "isRotated": False},
            {"x": 0.0, "y": 10.0, "blockId": 0, "isRotated": False},
            {"x": 10.0, "y": 10.0, "blockId": 0, "isRotated": False},
        ],
    }

    result = nup_layout_solver.apply_alternate_rotation(layout, mode)

    assert [item["isRotated180"] for item in result["items"]] == expected
    assert all("isRotated180" not in item for item in layout["items"])


def test_sticker_l_shape_blocks_restart_independently():
    layout = {
        "items": [
            {"x": 0.0, "y": 0.0, "blockId": 0, "isRotated": False},
            {"x": 0.0, "y": 10.0, "blockId": 0, "isRotated": False},
            # Cụm phải chỉ có x=30: phải bắt đầu ở hướng gốc, không nối chu kỳ
            # với cụm đáy cũng đang xoay nền 90°.
            {"x": 30.0, "y": 0.0, "blockId": 1, "isRotated": True},
            {"x": 0.0, "y": 30.0, "blockId": 2, "isRotated": True},
            {"x": 10.0, "y": 30.0, "blockId": 2, "isRotated": True},
        ],
    }

    result = nup_layout_solver.apply_alternate_rotation(layout, "row")

    assert [item["isRotated180"] for item in result["items"]] == [
        False, True, False, False, True,
    ]


def test_production_sticker_l_shape_assigns_main_right_bottom_blocks():
    from app.workers.sticker_imposer_pkg.orchestrator import (
        solve_optimal_sticker_layout,
    )

    result = solve_optimal_sticker_layout(
        500.0, 700.0, 180.0, 120.0, 0.0, 0.0,
        "optimal_auto", shape_type="RECTANGLE",
    )

    assert result["strategyUsed"] == "l_shape"
    by_block = {
        block_id: [item for item in result["items"] if item.get("blockId") == block_id]
        for block_id in (0, 1, 2)
    }
    assert [len(by_block[block_id]) for block_id in (0, 1, 2)] == [8, 2, 4]

    rotated = nup_layout_solver.apply_alternate_rotation(result, "row")
    flags = {
        block_id: [
            item["isRotated180"]
            for item in rotated["items"]
            if item.get("blockId") == block_id
        ]
        for block_id in (0, 1, 2)
    }
    assert flags[0] == [False, False, True, True, False, False, True, True]
    assert flags[1] == [False, False]
    assert flags[2] == [False, True, False, True]


def test_cluster_tile_centering_preserves_sticker_inking_flags():
    from app.workers.cluster_tile_engine import run_cluster_tile

    placements, _cuts = run_cluster_tile(
        page_infos=[(0, 1, 20.0, 10.0)],
        full_layouts={
            0: {
                "items": [
                    {
                        "x": 0.0, "y": 0.0,
                        "width": 20.0, "height": 10.0,
                        "isRotated": False, "isRotated180": True,
                    },
                ],
            },
        },
        sheet_w=100.0,
        sheet_h=100.0,
        cluster_w=60.0,
        cluster_h=40.0,
        gap_x=0.0,
        gap_y=0.0,
        cluster_nesting=True,
        is_die_cut=True,
    )

    assert placements
    assert all(p["cell"]["isRotated180"] is True for p in placements)


@pytest.mark.parametrize(
    ("mode", "expected_main", "expected_fill"),
    [
        (
            "row",
            [False, True, False, True, False, True, False, True],
            [False, True, False, False, True, False, False, True, False],
        ),
        (
            "column",
            [False, False, False, False, False, False, False, False],
            [False, False, False, True, True, True, False, False, False],
        ),
    ],
)
def test_real_l_shape_17_items_applies_inking_on_each_blocks_local_axis(
    monkeypatch, mode, expected_main, expected_fill
):
    monkeypatch.setattr(nup_layout_solver, "_USE_RUST", False)
    monkeypatch.setattr(nup_layout_solver, "_FORCE_PY", True)

    result = nup_layout_solver.solve_optimal_layout(
        305.0, 445.0, 147.1, 51.3, 0.0, 0.0,
        "optimal_auto", 0.0, mode,
    )

    assert result["totalItems"] == 17
    by_block = {
        block_id: [
            cell["isRotated180"]
            for cell in result["cells"]
            if cell.get("blockId", 0) == block_id
        ]
        for block_id in (0, 1)
    }
    assert by_block[0] == expected_main
    # Cụm phụ có isRotated=True nên hàng/cột nội dung phải hoán đổi
    # trục vật lý, không dùng chung một trục cho toàn tờ.
    assert by_block[1] == expected_fill


@pytest.mark.skipif(
    not nup_layout_solver._RUST_AVAILABLE,
    reason="Cần extension Rust để kiểm parity solver production.",
)
@pytest.mark.parametrize("mode", ["row", "column"])
def test_real_l_shape_17_items_keeps_rust_python_inking_parity(monkeypatch, mode):
    def solve_with(use_rust):
        monkeypatch.setattr(nup_layout_solver, "_USE_RUST", use_rust)
        monkeypatch.setattr(nup_layout_solver, "_FORCE_PY", not use_rust)
        return nup_layout_solver.solve_optimal_layout(
            305.0, 445.0, 147.1, 51.3, 0.0, 0.0,
            "optimal_auto", 0.0, mode,
        )

    rust_result = solve_with(True)
    python_result = solve_with(False)

    assert rust_result["totalItems"] == python_result["totalItems"] == 17
    assert [
        (cell.get("blockId", 0), bool(cell.get("isRotated")), cell["isRotated180"])
        for cell in rust_result["cells"]
    ] == [
        (cell.get("blockId", 0), bool(cell.get("isRotated")), cell["isRotated180"])
        for cell in python_result["cells"]
    ]


def test_manual_grid_supports_independent_alternate_rotation(monkeypatch):
    monkeypatch.setattr(nup_layout_solver, "_USE_RUST", False)
    monkeypatch.setattr(nup_layout_solver, "_FORCE_PY", True)

    result = nup_layout_solver.solve_manual(
        20.0, 10.0, 0.0, 0.0, 2, 2, "column"
    )

    assert [cell["isRotated180"] for cell in result["cells"]] == [False, True, False, True]


def test_invalid_alternate_rotation_is_rejected_in_strict_mode():
    with pytest.raises(ValueError, match="none, row hoặc column"):
        nup_layout_solver.normalize_alternate_rotation("diagonal", strict=True)


@pytest.mark.parametrize(
    ("kwargs", "expected"),
    [
        ({"is_die_cut": True, "shape_type": "RECTANGLE"}, True),
        ({"is_die_cut": True, "shape_type": "rectangle"}, True),
        ({"is_die_cut": True, "cut_type": "one_dao", "shape_type": "CIRCLE_ELLIPSE"}, True),
        ({"is_die_cut": True, "shapes_by_page": {"0": "RECTANGLE", "1": "RECTANGLE"}}, True),
        ({"is_die_cut": True, "shapes_by_page": {"0": "RECTANGLE", "1": "CUSTOM"}}, False),
        ({"is_die_cut": True, "shape_type": "CIRCLE_ELLIPSE"}, False),
        ({"is_die_cut": True, "shape_type": "RECTANGLE", "is_cnc": True}, False),
        ({"is_die_cut": True, "shape_type": "RECTANGLE", "page_sheet_mode": True}, False),
        ({"is_die_cut": False, "shape_type": "RECTANGLE"}, False),
    ],
)
def test_rectangle_inking_boundary_policy(kwargs, expected):
    assert nup_layout_solver.rectangle_inking_is_allowed(**kwargs) is expected


def test_preview_contract_accepts_independent_alternate_rotation():
    from pydantic import ValidationError
    from app.api.routes.imposition import (
        PreviewLayoutBatchRequest,
        PreviewLayoutRequest,
    )

    request = PreviewLayoutRequest(
        usable_w=100.0,
        usable_h=100.0,
        item_w=20.0,
        item_h=10.0,
        gap_x=0.0,
        gap_y=0.0,
        strategy="optimal_auto",
        alternate_rotation="row",
    )
    batch = PreviewLayoutBatchRequest(
        usable_w=100.0,
        usable_h=100.0,
        gap_x=0.0,
        gap_y=0.0,
        pages=[],
        alternate_rotation="column",
    )

    assert request.strategy == "optimal_auto"
    assert request.alternate_rotation == "row"
    assert batch.alternate_rotation == "column"
    with pytest.raises(ValidationError):
        PreviewLayoutRequest(
            usable_w=100.0,
            usable_h=100.0,
            item_w=20.0,
            item_h=10.0,
            gap_x=0.0,
            gap_y=0.0,
            strategy="optimal_auto",
            alternate_rotation="diagonal",
        )


def test_manual_preview_fallback_solves_before_bounds_check():
    """Không có file nguồn vẫn preview được lưới thủ công + Inking."""
    from app.api.routes.imposition import PreviewLayoutRequest, preview_layout
    from tests.license_helpers import PRO_LICENSE

    request = PreviewLayoutRequest(
        usable_w=100.0,
        usable_h=100.0,
        item_w=20.0,
        item_h=10.0,
        gap_x=0.0,
        gap_y=0.0,
        strategy="manual",
        alternate_rotation="row",
        cols=2,
        rows=2,
        task_mode="nup",
        is_die_cut=False,
    )

    result = preview_layout(request, PRO_LICENSE)

    assert result["totalItems"] == 4
    assert [cell["isRotated180"] for cell in result["cells"]] == [
        False, False, True, True,
    ]


@pytest.mark.parametrize(
    ("shape_type", "expected"),
    [
        ("RECTANGLE", [False, False, True, True]),
        ("CIRCLE_ELLIPSE", [False, False, False, False]),
        ("CUSTOM", [False, False, False, False]),
    ],
)
def test_diecut_preview_fallback_only_applies_inking_to_rectangle(shape_type, expected):
    from app.api.routes.imposition import PreviewLayoutRequest, preview_layout
    from tests.license_helpers import PRO_LICENSE

    request = PreviewLayoutRequest(
        usable_w=40.0,
        usable_h=20.0,
        item_w=20.0,
        item_h=10.0,
        gap_x=0.0,
        gap_y=0.0,
        strategy="optimal_auto",
        alternate_rotation="row",
        shape_type=shape_type,
        task_mode="sticker_imposer",
        is_die_cut=True,
    )

    result = preview_layout(request, PRO_LICENSE)

    assert [bool(cell.get("isRotated180", False)) for cell in result["cells"]] == expected
