"""Kiểm oracle chất lượng smart nesting ngoài đường solve production."""

from __future__ import annotations

from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[2]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

from smart_nesting_quality import (  # noqa: E402
    QualityThresholds,
    evaluate_layout,
    l_shape,
    notch_shape,
    quality_corpus,
    rectangle,
    t_shape,
    triangle,
    transform_polygon,
    u_shape,
)


def test_corpus_covers_safe_stack_interlock_and_unsafe_gap():
    reports = {case["name"]: evaluate_layout(case) for case in quality_corpus()}

    assert reports["rectangle_stack"]["valid"] is True
    assert reports["rectangle_stack"]["interlock_pairs"] == 0
    assert reports["rectangle_stack"]["placement_count"] == 4

    interlock = reports["notch_tongue_interlock"]
    assert interlock["valid"] is True, interlock
    assert interlock["bbox_overlap_pairs"] == 1
    assert interlock["interlock_pairs"] == 1
    assert interlock["min_edge_distance_mm"] >= 0.25 - 1e-6

    unsafe = reports["unsafe_gap"]
    assert unsafe["valid"] is False
    assert "PAIR_CLEARANCE" in unsafe["errors"]


def test_oracle_checks_obstacle_containment_and_count_without_solver():
    case = {
        "sheet": {"width": 80, "height": 80, "margin": 1},
        "parts": [{"part_id": "l", "polygon": l_shape(), "quantity": 2}],
        "placements": [
            {"instance_id": "l#1", "part_id": "l", "x": 2, "y": 2},
            {"instance_id": "l#2", "part_id": "l", "x": 35, "y": 35},
        ],
        "obstacles": [{"x": 60, "y": 60, "width": 10, "height": 10}],
    }
    report = evaluate_layout(case)
    assert report["valid"] is True
    assert report["holes_ignored"] is False

    blocked = {**case, "obstacles": [{"x": 2, "y": 2, "width": 10, "height": 10}]}
    blocked_report = evaluate_layout(blocked)
    assert blocked_report["valid"] is False
    assert "OBSTACLE_COLLISION" in blocked_report["errors"]

    too_many = {**case, "placements": case["placements"] + [{"part_id": "l", "x": 10, "y": 50}]}
    too_many_report = evaluate_layout(too_many)
    assert too_many_report["valid"] is False
    assert "PLACEMENT_COUNT_EXCEEDS_QUANTITY" in too_many_report["errors"]


def test_shape_corpus_includes_concave_and_triangle_contours():
    parts = [l_shape(), t_shape(), u_shape(), notch_shape(), triangle(), rectangle(8, 5)]
    for index, shape in enumerate(parts):
        case = {
            "sheet": {"width": 100, "height": 100},
            "parts": [{"part_id": str(index), "polygon": shape}],
            "placements": [{"part_id": str(index), "x": 10, "y": 10}],
        }
        report = evaluate_layout(case)
        assert report["valid"] is True, (index, report)


def test_pose_reference_uses_r_times_p_minus_reference_plus_translation():
    # Pivot (2, 1), quay 90°: (3, 1) thành vector (0, 1), rồi tịnh tiến (10, 20).
    transformed = transform_polygon([[3, 1]], 90, 10, 20, reference=(2, 1))
    assert abs(transformed[0][0] - 10) < 1e-9
    assert abs(transformed[0][1] - 21) < 1e-9


def test_gap_threshold_is_explicit_and_does_not_measure_oracle_time():
    case = quality_corpus()[2]
    relaxed = evaluate_layout(case, QualityThresholds(required_gap_mm=0.0))
    strict = evaluate_layout(case, QualityThresholds(required_gap_mm=0.6))
    assert relaxed["valid"] is False  # hai contour vẫn chồng lên nhau
    assert strict["valid"] is False


def test_production_nested_pose_and_reference_are_used():
    case = {
        "sheet": {"width": 40, "height": 40},
        "parts": [{"partId": "p", "cutContour": {"outer": rectangle(2, 1), "holes": []}, "referencePointMm": [1, 0.5]}],
        "placements": [
            {
                "partId": "p",
                "pose": {"rotationDeg": 90, "translateXmm": 20, "translateYmm": 20},
            }
        ],
        # Nếu oracle bỏ qua pose thì placement rơi vào obstacle này và bị báo sai.
        "obstacles": [{"x": 0, "y": 0, "width": 3, "height": 3}],
    }
    report = evaluate_layout(case)
    assert report["valid"] is True, report


def test_axis_spacing_metric_is_translation_invariant_and_touching_is_ok_at_zero_gap():
    case = {
        "sheet": {"width": 100, "height": 40},
        "parts": [{"part_id": "r", "polygon": rectangle(10, 10), "quantity": 2}],
        "placements": [{"part_id": "r", "x": 10, "y": 10}, {"part_id": "r", "x": 20, "y": 10}],
    }
    shifted = {**case, "placements": [{"part_id": "r", "x": 110, "y": 210}, {"part_id": "r", "x": 120, "y": 210}], "sheet": {"width": 300, "height": 300}}
    first = evaluate_layout(case, QualityThresholds(required_gap_mm=0.0))
    second = evaluate_layout(shifted, QualityThresholds(required_gap_mm=0.0))
    assert first["valid"] is True  # shared edge, gap=0, không phải overlap dương
    assert second["valid"] is True
    assert first["axis_spacing_residual_mm"] == second["axis_spacing_residual_mm"]
    assert "periodic_residual_mm" not in first


def test_anisotropic_production_clearance_is_fail_closed():
    case = {
        "sheet": {"width": 40, "height": 40},
        "parts": [{"part_id": "r", "polygon": rectangle(10, 10)}],
        "placements": [{"part_id": "r", "x": 1, "y": 1}],
        "clearance": {"partToPart": {"xMm": 0.1, "yMm": 0.3}, "partToObstacle": {"xMm": 0.2, "yMm": 0.4}},
    }
    report = evaluate_layout(case)
    assert report["clearance_supported"] is False
    assert report["valid"] is False
    assert "ANISOTROPIC_CLEARANCE_UNSUPPORTED" in report["errors"]


def test_unknown_part_negative_sheet_index_and_per_part_quantity_fail_closed():
    case = {
        "sheet": {"width": 100, "height": 100},
        "parts": [
            {"part_id": "a", "polygon": rectangle(5, 5), "quantity": 2},
            {"part_id": "b", "polygon": rectangle(5, 5), "quantity": 1},
        ],
        "placements": [
            {"part_id": "a", "x": 1, "y": 1, "sheetIndex": -1},
            {"part_id": "missing", "x": 20, "y": 20},
            {"part_id": "a", "x": 20, "y": 1},
        ],
    }
    report = evaluate_layout(case)
    assert report["valid"] is False
    assert "INVALID_SHEET_INDEX:a#1" in report["errors"]
    assert "UNKNOWN_PART:missing" in report["errors"]
    assert "PLACEMENT_COUNT_MISSING" in report["errors"]
