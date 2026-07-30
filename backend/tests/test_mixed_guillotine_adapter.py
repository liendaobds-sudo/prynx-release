"""Contract tests cho adapter plan mixed-guillotine sang renderer N-Up cũ."""

from __future__ import annotations

import copy

import pytest

from app.workers.mixed_guillotine_adapter import (
    full_span_cut_coordinates,
    materialize_plan_for_renderer,
)


def _plan(*, run_count: int = 1) -> dict:
    placements = []
    for index, (x, y, width, height, rotation) in enumerate(
        (
            (10.0, 20.0, 30.0, 40.0, 0),
            (60.0, 30.0, 40.0, 30.0, 90),
            (120.0, 50.0, 30.0, 40.0, 180),
            (180.0, 70.0, 40.0, 30.0, 270),
        )
    ):
        placements.append(
            {
                "placementId": f"T001-P{index + 1:04d}",
                "productId": index,
                "zoneId": f"Z{index + 1:03d}",
                "frontPageIdx": index * 2,
                "backPageIdx": index * 2 + 1,
                "sourcePageIdx": index * 2,
                "x": x,
                "y": y,
                "width": width,
                "height": height,
                "rotation": rotation,
                "gridSlot": index,
            }
        )
    return {
        "sheetWidth": 400.0,
        "sheetHeight": 300.0,
        "usableRect": {"x": 20.0, "y": 30.0, "width": 350.0, "height": 240.0},
        "duplex": True,
        "flipEdge": "long",
        "planHash": "adapter-contract",
        "templates": [
            {
                "templateId": "T001",
                "runCount": run_count,
                "placements": placements,
                "cutTree": {
                    "kind": "waste",
                    "rect": {"x": 20.0, "y": 30.0, "width": 350.0, "height": 240.0},
                    "zoneId": "ZWASTE",
                    "productId": None,
                },
                "cutLines": [],
                "placedByProduct": [],
            }
        ],
    }


def _flags(placement: dict) -> tuple[bool, bool]:
    return (
        placement["cell"]["isRotated"],
        placement["cell"]["isRotated180"],
    )


def test_adapter_maps_all_four_rotations_and_top_left_y_without_mutating_plan():
    plan = _plan()
    original = copy.deepcopy(plan)

    placements, metadata = materialize_plan_for_renderer(plan)

    assert plan == original
    assert set(placements) == {0, 1}
    assert [_flags(item) for item in placements[0]] == [
        (False, False),
        (True, False),
        (False, True),
        (True, True),
    ]
    # Mặt sau long-edge có rotation' = -rotation mod 360.
    assert [_flags(item) for item in placements[1]] == [
        (False, False),
        (True, True),
        (False, True),
        (True, False),
    ]
    assert all(not item["_duplex_transform_applied"] for item in placements[0])
    assert all(item["_duplex_transform_applied"] for item in placements[1])
    assert [item["src_page_idx"] for item in placements[1]] == [1, 3, 5, 7]
    assert metadata[0]["side"] == "front"
    assert metadata[1]["side"] == "back"

    for face in placements.values():
        for item in face:
            assert item["abs_y"] == pytest.approx(
                plan["sheetHeight"] - item["original_cell_y"] - item["height"]
            )


def test_adapter_can_keep_unique_templates_or_expand_run_count():
    plan = _plan(run_count=3)

    unique, unique_metadata = materialize_plan_for_renderer(
        plan, expand_run_count=False
    )
    expanded, expanded_metadata = materialize_plan_for_renderer(
        plan, expand_run_count=True
    )

    assert len(unique) == len(unique_metadata) == 2
    assert len(expanded) == len(expanded_metadata) == 6
    assert [expanded_metadata[index]["runOrdinal"] for index in (0, 2, 4)] == [
        0,
        1,
        2,
    ]


def test_full_span_cut_projection_uses_usable_rect_not_physical_sheet_edges():
    face_metadata = {
        "cutLines": [
            {"axis": "x", "coordinate": 100.0, "start": 30.0, "end": 270.0},
            {"axis": "y", "coordinate": 120.0, "start": 20.0, "end": 370.0},
            {"axis": "x", "coordinate": 150.0, "start": 60.0, "end": 180.0},
        ]
    }

    cuts = full_span_cut_coordinates(
        face_metadata,
        sheet_width=400.0,
        sheet_height=300.0,
        usable_rect={"x": 20.0, "y": 30.0, "width": 350.0, "height": 240.0},
    )

    assert cuts == {"v": {100.0}, "h": {120.0}}
